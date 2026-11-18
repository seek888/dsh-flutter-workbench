/**
 * Deduped exception aggregation for the Flutter workbench.
 *
 * Inputs come from three places, all normalized here:
 *  1. Flutter's rendered error blocks (`══╡ EXCEPTION CAUGHT BY … ╞══`, captured
 *     from stdout or from the VM `Flutter.Error` extension event).
 *  2. Plain `Unhandled exception:` blocks on stderr.
 *  3. Already-parsed payloads (the VM service hands over
 *     `{message, exception, stack}`) and analyzer/test failures.
 *
 * Blocks are parsed with `parseStack` from util.js, then deduped by
 * `fingerprint(normalizedMessage + topFrames)` so a widget that throws every
 * rebuild shows up once with `count` instead of flooding the panel.
 *
 * Public surface (docs/CONTRACTS.md §5.5):
 *   createErrorStore({ logs, bus, logger, capacity })
 *   errStore.ingest(entry|{message,stack,kind}) -> ErrorGroup|null
 *   errStore.ingestCapture(text) -> number (blocks ingested)
 *   errStore.query({since,limit,kind,pattern,runId}) -> {groups,nextCursor,total}
 *   errStore.clear(), errStore.counts()
 * The pure helpers `parseExceptionText`, `splitExceptionBlocks`,
 * `repairFrames`, `parseFrames` and `normalizeMessage` are exported too:
 * `vmservice.js` reuses them so the wire payload and the log path produce
 * identical fingerprints.
 */
import { fingerprint, nowMs, parseStack } from './util.js'

export const ERROR_KINDS = ['flutter', 'dart', 'platform', 'test', 'analyze']

const BLOCK_HEADER = /EXCEPTION CAUGHT (?:BY|WHILE)\s+/i
const UNHANDLED = /^\s*(?:Unhandled exception|Another exception was thrown)\b/i
const STACK_HEADER = /When the exception was thrown, this was the stack:?/i
const THROWN_LINE = /^The following\s+.+?\s+was thrown/i
const NOISE_LINE = /^(?:The relevant error-causing widget|This \w|When the exception|════|═+╡|If this is|Consider|See also|Exception caught)/i
const FRAME_LINE = /^\s*(?:#\d+\s|(?:dart|package):\S+:\d+|(?:[A-Za-z]:[\\/]|\/|file:)\S*\.dart:\d+)/

/** Collapse a rendered Flutter line into something readable in one row. */
function cleanLine(line) {
  return String(line ?? '')
    .replace(/[═╞╡│└├┬┴─]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isFrameLine(line) {
  return FRAME_LINE.test(line)
}

function isNoise(line) {
  const text = cleanLine(line)
  return text === '' || isFrameLine(line) || NOISE_LINE.test(text)
}

/** Message normalization applied before hashing (ids/timings are volatile). */
export function normalizeMessage(message) {
  return String(message ?? '')
    .replace(/(?:[\w$]+)?#[0-9a-fA-F]{3,}\b/g, '#id')
    .replace(/0x[0-9a-fA-F]+/g, '0x?')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Last path component, either separator. Keeps fingerprints machine-agnostic. */
function shortFile(file) {
  const text = String(file ?? '')
  const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
  return (cut >= 0 ? text.slice(cut + 1) : text).replace(/[?#].*$/, '')
}

/** Symbol that precedes the location in `#0  Foo.bar (package:a/b.dart:1:2)`. */
function deriveSymbol(line) {
  const match = /^\s*#\d+\s+(.+?)\s*\(/.exec(String(line ?? ''))
  if (match === null) return null
  const symbol = match[1].trim()
  return symbol === '' ? null : symbol
}

/**
 * `parseStack` (util.js) lets the `package:` prefix win against the location,
 * so `package:app/main.dart:12:5` comes back as file `package:app/main.dart:12`
 * with line 5 (the column). Repair that here — util.js is foundation code owned
 * by another module — and derive a real symbol instead of the literal `package`.
 * @param {object[]} frames
 * @param {string} [stackText]
 */
export function repairFrames(frames, stackText = '') {
  const lines = String(stackText ?? '').split(/\r?\n/)
  return (frames ?? []).map((frame) => {
    const repaired = { ...frame }
    const tail = /^(.*?):(\d+)$/.exec(String(repaired.file ?? ''))
    if (tail !== null && /\.dart$/.test(tail[1]) && /^(?:package|dart|file):/.test(tail[1])) {
      const previousLine = repaired.line
      repaired.file = tail[1]
      repaired.line = Number(tail[2])
      if (repaired.column === null || repaired.column === undefined) {
        repaired.column = Number.isFinite(previousLine) ? previousLine : null
      }
    }
    if (repaired.symbol === null || repaired.symbol === undefined || /^[a-z]+$/.test(String(repaired.symbol))) {
      const needle = `${repaired.file}:${repaired.line}`
      const source = lines.find((line) => line.includes(needle))
      repaired.symbol = source === undefined ? null : deriveSymbol(source)
    }
    return repaired
  })
}

/** parseStack + repair; the one entry point every ingest path uses. */
export function parseFrames(stackText) {
  if (typeof stackText !== 'string' || stackText.trim() === '') return []
  return repairFrames(parseStack(stackText), stackText)
}

/** Stable dedupe key: normalized message + the first frames (basename:line). */
export function errorFingerprint({ message, exception, frames }) {
  const top = (frames ?? [])
    .slice(0, 3)
    .map((frame) => `${shortFile(frame.file)}:${frame.line ?? '?'}`)
    .join('>')
  const base = normalizeMessage(message) || normalizeMessage(exception ?? '')
  return fingerprint(`${base}\u0000${top}`)
}

/**
 * Split a capture-flutter-errors style text into per-exception blocks.
 * A block starts at `══╡ EXCEPTION CAUGHT BY …` (or `Unhandled exception`).
 * @param {string} text
 * @returns {string[]}
 */
export function splitExceptionBlocks(text) {
  const source = String(text ?? '')
  if (source.trim() === '') return []
  const lines = source.split(/\r?\n/)
  const starts = []
  let sawCaught = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (BLOCK_HEADER.test(line)) {
      starts.push(index)
      sawCaught = true
    } else if (!sawCaught && UNHANDLED.test(line)) {
      starts.push(index)
    }
  }
  if (starts.length === 0) return [source]
  const blocks = []
  for (let index = 0; index < starts.length; index += 1) {
    const from = starts[index]
    const to = index + 1 < starts.length ? starts[index + 1] : lines.length
    const block = lines.slice(from, to).join('\n').trim()
    if (block !== '') blocks.push(block)
    if (blocks.length >= 50) break
  }
  return blocks
}

/**
 * Parse one exception block (or a one-line error message) into the fields the
 * `ErrorGroup` shape needs. Returns `null` when the text holds no exception.
 * @param {string} text
 * @param {{ kind?: string, handled?: boolean }} [options]
 * @returns {{ kind:string, message:string, exception:string|null, stack:string|null,
 *   frames:object[], handled:boolean, context:string|null, renders:number }|null}
 */
export function parseExceptionText(text, options = {}) {
  const source = String(text ?? '')
  const trimmed = source.trim()
  if (trimmed === '') return null
  const kind = ERROR_KINDS.includes(options.kind) ? options.kind : guessKind(source)
  const lines = source.split(/\r?\n/)
  const headerIndex = lines.findIndex((line) => BLOCK_HEADER.test(line) || UNHANDLED.test(line))
  const header = headerIndex >= 0 ? cleanLine(lines[headerIndex]) : null

  let exception = null
  let message = ''
  let context = null

  if (headerIndex >= 0 && BLOCK_HEADER.test(lines[headerIndex])) {
    // `══╡ EXCEPTION CAUGHT BY WIDGETS LIBRARY ╞══` → context "widgets library"
    const match = /EXCEPTION CAUGHT (?:BY|WHILE)\s+(.+?)\s*[╞═]*$/i.exec(header ?? '')
    context = match !== null ? match[1].replace(/[╞═╡]+$/g, '').trim().toLowerCase().slice(0, 160) : null
  }

  const thrownIndex = lines.findIndex((line) => THROWN_LINE.test(cleanLine(line)))
  if (thrownIndex >= 0) {
    exception = cleanLine(lines[thrownIndex])
    for (let index = thrownIndex + 1; index < lines.length; index += 1) {
      const candidate = cleanLine(lines[index])
      if (isNoise(candidate)) continue
      message = candidate
      break
    }
  }

  if (message === '') {
    const unhandledIndex = lines.findIndex((line) => UNHANDLED.test(line))
    if (unhandledIndex >= 0) {
      const rawHeader = cleanLine(lines[unhandledIndex])
      const inline = rawHeader.replace(/^(?:Unhandled exception|Another exception was thrown)\s*:?\s*/i, '')
      if (inline !== '') {
        message = inline
      } else {
        for (let index = unhandledIndex + 1; index < lines.length; index += 1) {
          const candidate = cleanLine(lines[index])
          if (isNoise(candidate)) continue
          message = candidate
          break
        }
      }
      if (exception === null) exception = rawHeader.slice(0, 300)
    }
  }

  if (message === '') {
    for (const line of lines) {
      const candidate = cleanLine(line)
      if (candidate === '' || candidate === header) continue
      if (BLOCK_HEADER.test(candidate) || UNHANDLED.test(candidate) || STACK_HEADER.test(candidate)) continue
      if (isNoise(candidate)) continue
      message = candidate
      break
    }
  }

  const stackLines = lines.filter((line) => isFrameLine(line))
  const stackText = stackLines.length === 0 ? null : stackLines.join('\n')
  const frames = stackText === null ? [] : parseFrames(stackText)

  // Only text that actually signals a failure becomes a group; ordinary log
  // lines (`flutter: building widgets`) must not create noise entries.
  const hasSignal =
    headerIndex >= 0 ||
    thrownIndex >= 0 ||
    frames.length > 0 ||
    /(?:^|\n)\s*(?:[\w$.]*(?:Exception|Error)\b|Bad state\b|Assertion\b|TEST FAILED|SEVERITY\|)/.test(source)
  if (!hasSignal) return null

  if (message === '') {
    // Signal present but no dedicated message line (e.g. a one-line failure).
    message = cleanLine(lines.map((line) => cleanLine(line)).find((line) => line !== '') ?? trimmed).slice(0, 400)
  }

  return {
    kind,
    message: message === '' ? (exception ?? '(unknown error)') : message.slice(0, 2000),
    exception: exception === null ? null : exception.slice(0, 400),
    stack: stackText === null ? null : stackText.slice(0, 12000),
    frames,
    handled: options.handled === true && !/^unhandled/i.test(header ?? ''),
    context,
    renders: splitExceptionBlocks(source).length,
  }
}

function guessKind(text) {
  const haystack = String(text ?? '')
  if (/\banalyze\b|AnalyzerIssue|SEVERITY\|/i.test(haystack)) return 'analyze'
  if (/\btest(s)?\b|TEST FAILED|✖|expected:|Actual:/i.test(haystack) && !/EXCEPTION CAUGHT/.test(haystack)) return 'test'
  if (/EXCEPTION CAUGHT|package:flutter\//.test(haystack)) return 'flutter'
  if (/dart:/.test(haystack) || /\.dart:\d+/.test(haystack)) return 'dart'
  return 'platform'
}

function normalizeKind(input) {
  if (typeof input !== 'string') return null
  const text = input.trim().toLowerCase()
  if (ERROR_KINDS.includes(text)) return text
  if (text === 'stderr' || text === 'stdout') return 'dart'
  if (text === 'vm') return 'flutter'
  if (text === 'toolchain') return 'analyze'
  return null
}

/**
 * @param {{ logs?:any, bus?:any, logger?:any, capacity?:number }} [options]
 */
export function createErrorStore({ logs = null, bus = null, logger = null, capacity = 500 } = {}) {
  const limit = Number.isFinite(Number(capacity)) ? Math.max(1, Math.min(5000, Math.floor(Number(capacity)))) : 500
  /** @type {Map<string, any>} */
  const groups = new Map()
  /** @type {string[]} insertion order, used for eviction bookkeeping */
  const order = []
  let seq = 0
  const disposers = []

  function evictIfNeeded() {
    while (groups.size > limit && order.length > 0) {
      // Drop the least recently seen group; lastAt ordering keeps hot errors.
      let oldestIndex = 0
      let oldestAt = Number.POSITIVE_INFINITY
      for (let index = 0; index < order.length; index += 1) {
        const candidate = groups.get(order[index])
        if (candidate === undefined) {
          order.splice(index, 1)
          index -= 1
          continue
        }
        if (candidate.lastAt < oldestAt) {
          oldestAt = candidate.lastAt
          oldestIndex = index
        }
      }
      const [victim] = order.splice(oldestIndex, 1)
      if (victim !== undefined) groups.delete(victim)
      else break
    }
  }

  /**
   * Ingest a log entry, a raw `{message,stack,kind}` payload, or a parsed
   * Flutter.Error payload. Returns the (created or updated) group.
   */
  function ingest(input) {
    if (input === null || input === undefined) return null
    if (typeof input === 'string') return ingest({ text: input, kind: 'dart' })
    if (typeof input !== 'object') return null

    const text = String(input.renderedErrorText ?? input.text ?? input.message ?? '')
    if (text.trim() === '') return null

    const at = Number.isFinite(Number(input.at)) ? Number(input.at) : nowMs()
    const explicitKind = normalizeKind(input.kind) ?? normalizeKind(input.source)
    const parsed = parseExceptionText(text, {
      kind: explicitKind ?? 'platform',
      handled: input.handled === true,
    })
    const hasStructured = typeof input.message === 'string' && input.message.trim() !== ''
    if (parsed === null && !hasStructured) return null

    const kind = explicitKind ?? parsed?.kind ?? 'platform'
    const message = String(input.message ?? parsed?.message ?? '(unknown error)')
    const exception = input.exception ?? parsed?.exception ?? null
    const stack = input.stack ?? parsed?.stack ?? null
    const frames =
      Array.isArray(input.frames) && input.frames.length > 0
        ? input.frames
        : stack === null
          ? (parsed?.frames ?? [])
          : parseFrames(stack)
    const fp = errorFingerprint({ message, exception, frames })
    const runId = input.runId ?? null
    const context = input.context ?? parsed?.context ?? null
    const handled = input.handled === true
    const currentSeq = (seq += 1)

    const existing = groups.get(fp)
    if (existing !== undefined) {
      existing.count += 1
      existing.lastAt = at
      existing.lastSeq = currentSeq
      if (at < existing.firstAt) existing.firstAt = at
      if (stack !== null && (existing.stack === null || stack.length > existing.stack.length)) existing.stack = stack
      if (frames.length > existing.frames.length) existing.frames = frames
      if (runId !== null) existing.runId = runId
      existing.handled = existing.handled && handled
      existing.lastText = text.slice(0, 2000)
      return existing
    }

    const group = {
      fp,
      count: 1,
      firstAt: at,
      lastAt: at,
      kind,
      message: message.slice(0, 2000),
      exception: exception === null ? null : String(exception).slice(0, 400),
      stack: stack === null ? null : String(stack).slice(0, 12000),
      frames,
      context,
      handled,
      runId,
      lastSeq: currentSeq,
      lastText: text.slice(0, 2000),
    }
    groups.set(fp, group)
    order.push(fp)
    evictIfNeeded()
    return group
  }

  /** Ingest one capture-flutter-errors style blob (may hold several blocks). */
  function ingestCapture(text) {
    const blocks = splitExceptionBlocks(text)
    let count = 0
    for (const block of blocks) {
      const group = ingest({ text: block, at: nowMs(), kind: 'flutter' })
      if (group !== null) count += 1
    }
    return count
  }

  function query(options = {}) {
    const since = Number.isFinite(Number(options.since)) ? Number(options.since) : 0
    const count = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.min(1000, Number(options.limit))) : 50
    const kind = options.kind === undefined || options.kind === null ? null : normalizeKind(options.kind) ?? String(options.kind)
    const runId = options.runId === undefined || options.runId === null ? null : String(options.runId)
    const pattern = compilePattern(options.pattern)
    const orderBy = options.order === 'asc' ? 'asc' : 'desc'

    const result = []
    for (const group of groups.values()) {
      if (group.lastSeq <= since) continue
      if (kind !== null && group.kind !== kind) continue
      if (runId !== null && group.runId !== runId) continue
      if (pattern !== null && pattern.test(`${group.message}\n${group.exception ?? ''}\n${group.stack ?? ''}`) === false) continue
      result.push(group)
    }
    result.sort((left, right) => (orderBy === 'asc' ? left.lastAt - right.lastAt : right.lastAt - left.lastAt))
    return {
      groups: result.slice(0, count),
      nextCursor: seq,
      total: groups.size,
    }
  }

  function clear() {
    groups.clear()
    order.length = 0
  }

  function counts() {
    const byKind = {}
    for (const kind of ERROR_KINDS) byKind[kind] = 0
    let occurrences = 0
    for (const group of groups.values()) {
      byKind[group.kind] = (byKind[group.kind] ?? 0) + 1
      occurrences += group.count
    }
    return { byKind, total: groups.size, occurrences, capacity: limit, cursor: seq }
  }

  function get(fingerprintValue) {
    return groups.get(String(fingerprintValue)) ?? null
  }

  // --- bus wiring -----------------------------------------------------------
  if (bus !== null && typeof bus?.on === 'function') {
    // Structured Flutter errors from the VM service are authoritative.
    disposers.push(
      bus.on('vm:flutter-error', (payload) => {
        if (payload === null || typeof payload !== 'object') return
        ingest({ ...payload, kind: payload.kind ?? 'flutter' })
      }),
    )
    // Raw error lines from the runner/toolchain; `vm` is skipped because those
    // arrive through `vm:flutter-error` already (no double counting).
    disposers.push(
      bus.on('log', (entry) => {
        if (entry === null || typeof entry !== 'object') return
        if (entry.source === 'vm') return
        const level = String(entry.level ?? '')
        const text = String(entry.text ?? '')
        const looksLikeError = /═+╡\s*EXCEPTION CAUGHT|Unhandled exception|Another exception was thrown/i.test(text)
        if (level !== 'error' && level !== 'fatal' && !looksLikeError) return
        ingest(entry)
      }),
    )
  }

  return {
    capacity: limit,
    ingest,
    ingestCapture,
    query,
    clear,
    counts,
    get,
    /** Cursor of the last ingest; matches `query().nextCursor`. */
    cursor: () => seq,
    size: () => groups.size,
    dispose() {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
      clear()
    },
  }
}

function compilePattern(pattern) {
  if (pattern === undefined || pattern === null) return null
  const text = String(pattern)
  if (text.trim() === '') return null
  try {
    return new RegExp(text, 'i')
  } catch {
    return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  }
}

export default createErrorStore