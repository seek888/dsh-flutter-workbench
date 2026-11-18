/**
 * Structured log ring buffer.
 *
 * One append-only sequence per plugin instance; entries are plain JSON so the
 * HTTP API, the AI tools and the panel all read the same objects. Capacity is
 * bounded: the oldest entries are dropped first, and cursors stay monotonic so
 * a client that missed a window still detects the gap (`nextCursor` jumps).
 */
import { nowMs, uid } from './util.js'

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal']
export const LOG_SOURCES = ['flutter', 'stdout', 'stderr', 'daemon', 'vm', 'network', 'toolchain', 'plugin', 'ai']

const LEVEL_RANK = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 }

/** Guess a level from a raw text line when the producer does not supply one. */
export function guessLevel(text) {
  const line = String(text ?? '')
  if (/(^|\s)(FATAL|fatal error)/.test(line)) return 'fatal'
  if (/(^|[\s:])(Error|ERROR|Exception|Unhandled|failed|Failed)([\s:]|$)/.test(line)) return 'error'
  if (/(^|[\s:])(WARNING|Warning|warn)([\s:]|$)/.test(line)) return 'warn'
  if (/^\s*(#|at\s|\d+\.\d+\.\d+)/.test(line)) return 'debug'
  return 'info'
}

/** Keep only keys with real values; used to keep entries compact. */
function compactMeta(meta) {
  if (meta === null || typeof meta !== 'object') return null
  const result = {}
  for (const [key, value] of Object.entries(meta)) {
    if (value !== undefined && value !== null) result[key] = value
  }
  return Object.keys(result).length === 0 ? null : result
}

/**
 * @param {{ capacity?: number }} [options]
 */
export function createLogStore({ capacity = 4000 } = {}) {
  const limit = Number.isFinite(Number(capacity)) ? Math.max(200, Math.min(200000, Number(capacity))) : 4000
  /** @type {any[]} */
  let entries = []
  let seq = 0
  let dropped = 0

  function append(input) {
    const entry = {
      seq: (seq += 1),
      at: Number.isFinite(input?.at) ? Number(input.at) : nowMs(),
      runId: input?.runId ?? null,
      projectId: input?.projectId ?? null,
      source: LOG_SOURCES.includes(input?.source) ? input.source : 'plugin',
      level: LOG_LEVELS.includes(input?.level) ? input.level : guessLevel(input?.text),
      text: String(input?.text ?? ''),
      meta: compactMeta(input?.meta),
    }
    entries.push(entry)
    if (entries.length > limit) {
      const overflow = entries.length - limit
      entries = entries.slice(overflow)
      dropped += overflow
    }
    return entry
  }

  function appendMany(list) {
    const created = []
    for (const item of list ?? []) created.push(append(item))
    return created
  }

  function query(options = {}) {
    const from = Number.isFinite(Number(options.since)) ? Math.max(0, Math.floor(Number(options.since))) : 0
    const count = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.min(20000, Math.floor(Number(options.limit)))) : 500
    const levels = normalizeSet(options.levels ?? options.level, LOG_LEVELS)
    const sources = normalizeSet(options.sources ?? options.source, LOG_SOURCES)
    const minRank = levels === null || options.level === undefined ? -1 : Math.min(...levels.map((level) => LEVEL_RANK[level] ?? 2))
    const pattern = compilePattern(options.pattern)
    const runId = optionalString(options.runId)
    const projectId = optionalString(options.projectId)

    const result = []
    let nextCursor = seq
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]
      if (entry.seq <= from) break
      if (runId !== null && entry.runId !== runId) continue
      if (projectId !== null && entry.projectId !== projectId) continue
      if (minRank >= 0 && (LEVEL_RANK[entry.level] ?? 2) < minRank) continue
      if (sources !== null && sources.includes(entry.source) === false) continue
      if (pattern !== null && pattern.test(entry.text) === false) continue
      result.push(entry)
      if (result.length >= count) break
    }
    result.reverse()
    if (result.length === 0) nextCursor = seq
    return { entries: result, nextCursor, total: entries.length, dropped }
  }

  return {
    capacity: limit,
    append,
    appendMany,
    query,
    cursor: () => seq,
    size: () => entries.length,
    dropped: () => dropped,
    tail(n = 20) {
      const size = Math.max(0, Math.min(2000, Number(n) || 20))
      return entries.slice(Math.max(0, entries.length - size))
    },
    counts() {
      const byLevel = {}
      const bySource = {}
      for (const level of LOG_LEVELS) byLevel[level] = 0
      for (const source of LOG_SOURCES) bySource[source] = 0
      for (const entry of entries) {
        byLevel[entry.level] = (byLevel[entry.level] ?? 0) + 1
        bySource[entry.source] = (bySource[entry.source] ?? 0) + 1
      }
      return { byLevel, bySource, total: entries.length, dropped }
    },
    clear({ runId } = {}) {
      if (runId === undefined || runId === null) {
        entries = []
        return
      }
      entries = entries.filter((entry) => entry.runId !== runId)
    },
    mark(text, meta = null) {
      return append({ source: 'ai', level: 'info', text: String(text ?? ''), meta: { marker: true, id: uid('mark'), ...(meta ?? {}) } })
    },
  }
}

function normalizeSet(value, allowed) {
  if (value === undefined || value === null) return null
  const raw = Array.isArray(value) ? value : String(value).split(',')
  const cleaned = raw.map((item) => String(item).trim()).filter((item) => allowed.includes(item))
  return cleaned.length === 0 ? null : cleaned
}

function optionalString(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
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