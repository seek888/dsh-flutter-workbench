/**
 * Shared helpers for the Flutter workbench Host half.
 * Dependency-free, Node ESM, safe to import from every module.
 */

/** Turn any thrown value into `{ message, code }`. */
export function normalizeError(error, fallback = 'unknown error') {
  if (error === null || error === undefined) return { message: fallback, code: 'unknown' }
  if (typeof error === 'string') return { message: error, code: 'message' }
  const message = typeof error.message === 'string' && error.message !== '' ? error.message : fallback
  const code = typeof error.code === 'string' && error.code !== '' ? error.code : 'error'
  return { message, code }
}

/** Clamp a number into an inclusive range. */
export function clamp(value, lo, hi) {
  const n = Number(value)
  if (!Number.isFinite(n)) return lo
  return Math.min(hi, Math.max(lo, n))
}

/** JSON.parse that never throws. */
export function safeJson(text, fallback = undefined) {
  if (typeof text !== 'string' || text.trim() === '') return fallback
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

let uidCounter = 0
/** Short unique id, monotonic within one process. */
export function uid(prefix = 'id') {
  uidCounter = (uidCounter + 1) % 0xffffff
  const time = Date.now().toString(36)
  const rand = Math.floor(Math.random() * 0xffff).toString(36)
  return `${prefix}_${time}${uidCounter.toString(36)}${rand}`
}

/** Epoch milliseconds. */
export function nowMs() {
  return Date.now()
}

/** High-resolution monotonic milliseconds (for durations only). */
export function monotonic() {
  const [s, ns] = process.hrtime()
  return s * 1e3 + ns / 1e6
}

/** Read a Node request body as UTF-8 text, bounded. */
export function readBody(request, limitBytes = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (fn) => {
      if (settled) return
      settled = true
      fn()
    }
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        finish(() => reject(Object.assign(new Error('request body too large'), { code: 'too-large' })))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => finish(() => resolve(Buffer.concat(chunks).toString('utf8'))))
    request.on('error', (error) => finish(() => reject(error)))
  })
}

/** Write a JSON response with sensible headers. */
export function sendJson(response, status, body, headers = {}) {
  if (response.headersSent) return
  const text = JSON.stringify(body ?? null)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...headers,
  })
  response.end(text)
}

/** Write a plain-text response. */
export function sendText(response, status, body, headers = {}) {
  if (response.headersSent) return
  const text = String(body ?? '')
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...headers,
  })
  response.end(text)
}

/** Stable 32-bit-ish hash of a string, as hex. Used for error fingerprints. */
export function fingerprint(text) {
  const input = String(text ?? '')
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i)
    h1 = (h1 ^ code) >>> 0
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 = (h2 + code) >>> 0
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`
}

const STACK_LINE = /(?:package:[^\s()]+|file:\/\/[^\s()]+|[A-Za-z]:[\\/][^\s()]+|\/[^\s():]+):(\d+)(?::(\d+))?/
const FRAME_LINE = /^#\d+\s+(?:[^(]*\s+\()?(.+?)(?::(\d+)(?::(\d+))?)?\)?$/

/**
 * Parse a Dart/Flutter stack trace into frames.
 * Handles `#0      main (package:app/main.dart:12:5)` and plain `file.dart:12`.
 */
export function parseStack(text) {
  if (typeof text !== 'string' || text === '') return []
  const frames = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    const direct = STACK_LINE.exec(line)
    if (direct !== null) {
      const file = direct[0].slice(0, direct[0].lastIndexOf(':')).replace(/[()]$/, '')
      frames.push({
        file,
        line: Number(direct[1]) || null,
        column: direct[2] !== undefined ? Number(direct[2]) : null,
        symbol: extractSymbol(line),
      })
      continue
    }
    if (line.startsWith('#')) {
      const match = FRAME_LINE.exec(line)
      if (match !== null && match[1] !== undefined) {
        frames.push({
          file: match[1].trim(),
          line: match[2] !== undefined ? Number(match[2]) : null,
          column: match[3] !== undefined ? Number(match[3]) : null,
          symbol: extractSymbol(line),
        })
      }
    }
    if (frames.length >= 64) break
  }
  return frames
}

function extractSymbol(line) {
  const named = /(?:#\d+\s+)(?:[\w$.<>]+\s+)?\(?([\w$.<>/#]+)/.exec(line)
  if (named !== null && named[1] !== undefined && !named[1].includes(':')) return named[1]
  const split = /([\w$.<>]+)\s*\(/.exec(line)
  return split !== null ? split[1] : null
}

/**
 * Line splitter that keeps partial tails per buffer key.
 * Returns whole lines only; the remainder stays buffered.
 */
export function createLineSplitter() {
  const partial = new Map()
  return {
    push(key, chunk) {
      const previous = partial.get(key) ?? ''
      const combined = previous + String(chunk ?? '')
      const lines = combined.split(/\r?\n/)
      partial.set(key, lines.pop() ?? '')
      return lines
    },
    flush(key) {
      const rest = partial.get(key) ?? ''
      partial.delete(key)
      return rest === '' ? [] : [rest]
    },
    clear() {
      partial.clear()
    },
  }
}

/** Tiny synchronous event bus. */
export function createBus() {
  const listeners = new Map()
  return {
    on(type, callback) {
      const key = String(type)
      let set = listeners.get(key)
      if (set === undefined) {
        set = new Set()
        listeners.set(key, set)
      }
      set.add(callback)
      return () => {
        const current = listeners.get(key)
        if (current === undefined) return
        current.delete(callback)
        if (current.size === 0) listeners.delete(key)
      }
    },
    emit(type, payload) {
      const set = listeners.get(String(type))
      if (set === undefined) return
      for (const callback of [...set]) {
        try {
          callback(payload)
        } catch {
          /* a listener must never break the emitter */
        }
      }
    },
    offAll() {
      listeners.clear()
    },
    types() {
      return [...listeners.keys()]
    },
  }
}

/** Promise sleep. */
export function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

/** Human byte size. */
export function formatBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return '?'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`
}

/** Truncate a string with an ellipsis marker. */
export function truncate(text, limit = 2000) {
  const value = String(text ?? '')
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 12))}\n…[truncated]`
}

/** Minimal structured logger without console noise. */
export function createLogger(prefix, sink) {
  const emit = typeof sink === 'function' ? sink : null
  const format = (level, message) => `[${prefix}] ${level}: ${message}`
  return {
    debug(message) {
      if (emit !== null) emit(format('debug', message))
    },
    info(message) {
      if (emit !== null) emit(format('info', message))
    },
    warn(message) {
      if (emit !== null) emit(format('warn', message))
    },
    error(message) {
      if (emit !== null) emit(format('error', message))
    },
  }
}

/** Wrap a promise with a timeout; rejects with `code:'timeout'`. */
export function withTimeout(promise, ms, label = 'operation') {
  const timeout = Number(ms)
  if (!Number.isFinite(timeout) || timeout <= 0) return promise
  let timer
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(`${label} timed out after ${timeout}ms`), { code: 'timeout' }))
    }, timeout)
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

/** Keep only defined keys — handy for building patches. */
export function definedOnly(object) {
  const result = {}
  for (const [key, value] of Object.entries(object ?? {})) {
    if (value !== undefined) result[key] = value
  }
  return result
}