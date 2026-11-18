/**
 * Dependency-free RFC 6455 WebSocket client.
 *
 * Why hand-rolled: the Host half of this bundle must stay zero-dependency and
 * run on every DSH build (some Node builds ship a global `WebSocket`, most do
 * not, and its surface differs). The only consumer is the Dart VM Service,
 * which speaks plain `ws://` over loopback, so a focused client is enough:
 *
 *  - real HTTP/1.1 Upgrade handshake (`Sec-WebSocket-Key` → `Sec-WebSocket-Accept`)
 *  - optional extra `headers` and `origin` (auth proxies, DevTools-on-Firefox flows)
 *  - client→server frames are always masked (RFC 6455 §5.3)
 *  - 7-bit, 16-bit and 64-bit payload lengths; single big frame and streams of
 *    small frames both work (the parser keeps a byte buffer and resumes)
 *  - fragmented messages (continuation frames) reassembled
 *  - ping/pong auto-answer, explicit `ping()` keepalive
 *  - close handshake with status codes and reasons
 *  - UTF-8 text decode (lenient fallback so one bad byte never kills a run)
 *
 * Public surface (see docs/CONTRACTS.md §5.4):
 *   createWebSocketClient({ url, headers?, origin?, handshakeTimeoutMs?, ... })
 *     -> Promise<ws>
 *   ws.send(text | Buffer), ws.close(code?, reason?), ws.ping(payload?)
 *   ws.onMessage(cb) -> off, ws.onClose(cb) -> off
 *   ws.readyState: 0 connecting | 1 open | 2 closing | 3 closed
 */
import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa }
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024

/** Browser-compatible ready states. */
export const READY_STATE = Object.freeze({ CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })
const STATE_NAME = ['connecting', 'open', 'closing', 'closed']

/** Error with a stable machine-readable `code`. */
function wsError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra)
}

/**
 * Encode one WebSocket frame. Exported so tests (and any server-side helper)
 * can reuse the exact same framing without pulling in a dependency.
 * @param {number} opcode 1 text, 2 binary, 8 close, 9 ping, 10 pong, 0 continuation
 * @param {Buffer|Uint8Array|string} payload
 * @param {{ fin?: boolean, mask?: boolean }} [options]
 * @returns {Buffer}
 */
export function encodeFrame(opcode, payload, options = {}) {
  const fin = options.fin !== false
  const mask = options.mask === true
  const body = Buffer.isBuffer(payload)
    ? payload
    : typeof payload === 'string'
      ? Buffer.from(payload, 'utf8')
      : Buffer.from(payload ?? [])
  const length = body.length
  let header
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeUInt32BE(Math.floor(length / 0x100000000), 2)
    header.writeUInt32BE(length >>> 0, 6)
  }
  header[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f)
  if (!mask) return Buffer.concat([header, body])
  header[1] |= 0x80
  const key = randomBytes(4)
  const masked = Buffer.allocUnsafe(length)
  for (let index = 0; index < length; index += 1) masked[index] = body[index] ^ key[index & 3]
  return Buffer.concat([header, key, masked])
}

/** Decode UTF-8, never throwing on a truncated multi-byte sequence. */
function decodeText(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer)
  }
}

function normalizeHeaders(headers) {
  const result = {}
  if (headers === null || typeof headers !== 'object') return result
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue
    result[String(key).toLowerCase()] = String(value)
  }
  return result
}

/**
 * Open a WebSocket connection.
 * @param {object} options
 * @param {string} options.url ws:// or wss:// URL (path + query preserved)
 * @param {Record<string,string>} [options.headers] extra handshake headers
 * @param {string} [options.origin] `Origin` header value
 * @param {number} [options.handshakeTimeoutMs] default 8000
 * @param {number} [options.keepAliveMs] automatic ping interval (0 = off)
 * @param {number} [options.closeTimeoutMs] how long to wait for the peer's close frame
 * @param {number} [options.maxMessageBytes] hard cap on one message
 * @param {object|null} [options.logger] optional {debug,warn,error,info}
 * @returns {Promise<object>} the connected socket facade
 */
export function createWebSocketClient(options = {}) {
  const {
    url,
    headers = {},
    origin,
    handshakeTimeoutMs = 8000,
    keepAliveMs = 0,
    closeTimeoutMs = 2000,
    maxMessageBytes = MAX_MESSAGE_BYTES,
    logger = null,
  } = options

  let target
  try {
    target = new URL(String(url ?? ''))
  } catch {
    return Promise.reject(wsError('bad-url', `invalid WebSocket URL: ${String(url)}`))
  }
  if (target.protocol !== 'ws:' && target.protocol !== 'wss:') {
    return Promise.reject(wsError('bad-url', `unsupported WebSocket protocol: ${target.protocol}`))
  }
  const secure = target.protocol === 'wss:'
  const port = target.port === '' ? (secure ? 443 : 80) : Number(target.port)
  const requestPath = `${target.pathname === '' ? '/' : target.pathname}${target.search}`

  return new Promise((resolve, reject) => {
    let settled = false
    /** @type {ReturnType<typeof setTimeout>|null} */
    let handshakeTimer = null
    const key = randomBytes(16).toString('base64')
    const expectedAccept = createHash('sha1').update(`${key}${GUID}`).digest('base64')

    const requestHeaders = {
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-key': key,
      'sec-websocket-version': '13',
      ...(origin === undefined || origin === null || origin === '' ? {} : { origin: String(origin) }),
      ...normalizeHeaders(headers),
    }

    const transport = secure ? https : http
    const request = transport.request({
      protocol: secure ? 'https:' : 'http:',
      hostname: target.hostname,
      port,
      path: requestPath,
      method: 'GET',
      headers: requestHeaders,
      agent: false,
    })

    const fail = (error) => {
      if (settled) return
      settled = true
      if (handshakeTimer !== null) clearTimeout(handshakeTimer)
      try {
        request.destroy()
      } catch {
        /* already gone */
      }
      reject(error)
    }

    handshakeTimer = setTimeout(() => {
      fail(wsError('timeout', `WebSocket handshake timed out after ${handshakeTimeoutMs}ms: ${url}`))
    }, Math.max(1, Number(handshakeTimeoutMs) || 8000))
    if (typeof handshakeTimer.unref === 'function') handshakeTimer.unref()

    request.on('error', (error) => {
      fail(wsError('connect', `WebSocket connect failed: ${error?.message ?? error}`, { cause: error }))
    })

    request.on('response', (response) => {
      // A non-101 response means the peer refused the upgrade.
      const status = Number(response.statusCode) || 0
      response.resume()
      fail(wsError('bad-status', `WebSocket upgrade rejected with HTTP ${status}`, { status }))
    })

    request.on('upgrade', (response, socket, head) => {
      if (settled) {
        socket.destroy()
        return
      }
      const status = Number(response.statusCode) || 0
      const accept = String(response.headers['sec-websocket-accept'] ?? '')
      const upgrade = String(response.headers.upgrade ?? '').toLowerCase()
      if (status !== 101 || upgrade !== 'websocket' || accept !== expectedAccept) {
        socket.destroy()
        fail(
          wsError('bad-handshake', `invalid WebSocket upgrade response (status ${status}, accept mismatch: ${accept !== expectedAccept})`, {
            status,
            accept,
            expected: expectedAccept,
          }),
        )
        return
      }
      settled = true
      if (handshakeTimer !== null) clearTimeout(handshakeTimer)
      if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true)
      if (typeof socket.setTimeout === 'function') socket.setTimeout(0)
      resolve(makeConnection({ socket, head, url: String(url), keepAliveMs, closeTimeoutMs, maxMessageBytes, logger }))
    })

    request.end()
  })
}

/** Build the connected facade around a raw upgraded socket. */
function makeConnection({ socket, head, url, keepAliveMs, closeTimeoutMs, maxMessageBytes, logger }) {
  /** @type {any[]} */
  const messageHandlers = new Set()
  /** @type {any[]} */
  const closeHandlers = new Set()

  let readyState = READY_STATE.OPEN
  let buffer = Buffer.alloc(0)
  /** @type {Buffer[]} */
  let fragments = []
  let fragmentOpcode = null
  let fragmentBytes = 0
  let closed = false
  let closeTimer = null
  let keepAliveTimer = null
  let closeInfo = null

  const connection = {
    url,
    /** @type {number} */
    readyState,
    get state() {
      return STATE_NAME[readyState] ?? 'unknown'
    },
    get bufferedBytes() {
      return buffer.length
    },
    socket,
  }

  function emitMessage(data, meta) {
    for (const handler of [...messageHandlers]) {
      try {
        handler(data, meta)
      } catch (error) {
        logger?.warn?.(`ws: message handler threw: ${error?.message ?? error}`)
      }
    }
  }

  function finishClose(info) {
    if (closed) return
    closed = true
    readyState = READY_STATE.CLOSED
    connection.readyState = readyState
    closeInfo = info
    if (closeTimer !== null) {
      clearTimeout(closeTimer)
      closeTimer = null
    }
    if (keepAliveTimer !== null) {
      clearInterval(keepAliveTimer)
      keepAliveTimer = null
    }
    try {
      socket.destroy()
    } catch {
      /* already gone */
    }
    for (const handler of [...closeHandlers]) {
      try {
        handler(info)
      } catch (error) {
        logger?.warn?.(`ws: close handler threw: ${error?.message ?? error}`)
      }
    }
  }

  function writeFrame(opcode, payload, fin = true, allowClosing = false) {
    const writable = readyState === READY_STATE.OPEN || (allowClosing && readyState === READY_STATE.CLOSING)
    if (!writable) return false
    try {
      socket.write(encodeFrame(opcode, payload, { fin, mask: true }))
      return true
    } catch (error) {
      finishClose({ code: 1006, reason: `write failed: ${error?.message ?? error}`, wasClean: false })
      return false
    }
  }

  function send(payload) {
    if (readyState !== READY_STATE.OPEN) {
      throw wsError('not-open', `cannot send: WebSocket is ${connection.state}`)
    }
    const isBinary = Buffer.isBuffer(payload) || ArrayBuffer.isView(payload) || payload instanceof ArrayBuffer
    const body = isBinary
      ? Buffer.isBuffer(payload)
        ? payload
        : payload instanceof ArrayBuffer
          ? Buffer.from(new Uint8Array(payload))
          : Buffer.from(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength))
      : Buffer.from(String(payload), 'utf8')
    writeFrame(isBinary ? OPCODE.BINARY : OPCODE.TEXT, body, true)
    return true
  }

  function ping(payload = Buffer.alloc(0)) {
    return writeFrame(OPCODE.PING, typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload, true)
  }

  function close(code = 1000, reason = '') {
    if (readyState === READY_STATE.CLOSED) return
    if (readyState === READY_STATE.CONNECTING) {
      finishClose({ code, reason, wasClean: false })
      return
    }
    if (readyState === READY_STATE.CLOSING) return
    readyState = READY_STATE.CLOSING
    connection.readyState = readyState
    const text = Buffer.from(String(reason ?? ''), 'utf8')
    const payload = Buffer.alloc(2 + text.length)
    payload.writeUInt16BE(Number.isFinite(Number(code)) ? Number(code) : 1000, 0)
    text.copy(payload, 2)
    // The close frame is the one frame we may still write while CLOSING.
    writeFrame(OPCODE.CLOSE, payload, true, true)
    closeTimer = setTimeout(() => {
      finishClose({ code: Number(code) || 1000, reason: String(reason ?? ''), wasClean: false })
    }, Math.max(10, Number(closeTimeoutMs) || 2000))
    if (typeof closeTimer.unref === 'function') closeTimer.unref()
  }

  function handleCloseFrame(payload) {
    let code = 1005
    let reason = ''
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0)
      reason = payload.subarray(2).toString('utf8')
    }
    // Echo the close frame once when we are the ones still open (RFC 6455 §5.5.1).
    if (readyState === READY_STATE.OPEN) {
      readyState = READY_STATE.CLOSING
      connection.readyState = readyState
      const echo = Buffer.alloc(2)
      echo.writeUInt16BE(code === 1005 ? 1000 : code, 0)
      writeFrame(OPCODE.CLOSE, echo, true, true)
    }
    finishClose({ code, reason, wasClean: code === 1000 || code === 1001 })
  }

  function deliver(opcode, payload, fin) {
    if (opcode === OPCODE.CONTINUATION) {
      if (fragmentOpcode === null) {
        finishClose({ code: 1002, reason: 'continuation frame without a start frame', wasClean: false })
        return
      }
      fragmentBytes += payload.length
      if (fragmentBytes > maxMessageBytes) {
        finishClose({ code: 1009, reason: 'message too big', wasClean: false })
        return
      }
      fragments.push(payload)
      if (!fin) return
      const full = Buffer.concat(fragments)
      const type = fragmentOpcode
      fragments = []
      fragmentOpcode = null
      fragmentBytes = 0
      deliverComplete(type, full)
      return
    }
    if (opcode === OPCODE.TEXT || opcode === OPCODE.BINARY) {
      if (fragmentOpcode !== null) {
        finishClose({ code: 1002, reason: 'new data frame inside a fragmented message', wasClean: false })
        return
      }
      if (!fin) {
        fragmentOpcode = opcode
        fragments = [payload]
        fragmentBytes = payload.length
        return
      }
      deliverComplete(opcode, payload)
      return
    }
    if (opcode === OPCODE.PING) {
      writeFrame(OPCODE.PONG, payload, true)
      return
    }
    if (opcode === OPCODE.PONG) return
    if (opcode === OPCODE.CLOSE) {
      handleCloseFrame(payload)
      return
    }
    finishClose({ code: 1002, reason: `unsupported opcode 0x${opcode.toString(16)}`, wasClean: false })
  }

  function deliverComplete(opcode, payload) {
    if (payload.length > maxMessageBytes) {
      finishClose({ code: 1009, reason: 'message too big', wasClean: false })
      return
    }
    if (opcode === OPCODE.TEXT) emitMessage(decodeText(payload), { binary: false, bytes: payload.length })
    else emitMessage(payload, { binary: true, bytes: payload.length })
  }

  /** Consume as many complete frames as the buffer holds; leave the remainder. */
  function pump() {
    for (;;) {
      if (closed) return
      if (buffer.length < 2) return
      const first = buffer[0]
      const second = buffer[1]
      const fin = (first & 0x80) !== 0
      const rsv = first & 0x70
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      const shortLength = second & 0x7f
      if (rsv !== 0) {
        finishClose({ code: 1002, reason: 'reserved bits set', wasClean: false })
        return
      }
      if (masked) {
        // Server→client frames must not be masked.
        finishClose({ code: 1002, reason: 'masked server frame', wasClean: false })
        return
      }
      let offset = 2
      let length = shortLength
      if (shortLength === 126) {
        if (buffer.length < offset + 2) return
        length = buffer.readUInt16BE(offset)
        offset += 2
      } else if (shortLength === 127) {
        if (buffer.length < offset + 8) return
        const high = buffer.readUInt32BE(offset)
        const low = buffer.readUInt32BE(offset + 4)
        if (high > 0x1fffff) {
          finishClose({ code: 1009, reason: 'frame too big', wasClean: false })
          return
        }
        length = high * 0x100000000 + low
        offset += 8
      }
      if (length > maxMessageBytes) {
        finishClose({ code: 1009, reason: 'frame too big', wasClean: false })
        return
      }
      if (buffer.length < offset + length) return
      const payload = buffer.subarray(offset, offset + length)
      buffer = buffer.subarray(offset + length)
      deliver(opcode, payload, fin)
    }
  }

  socket.on('data', (chunk) => {
    if (closed) return
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
    try {
      pump()
    } catch (error) {
      logger?.error?.(`ws: frame parser failed: ${error?.message ?? error}`)
      finishClose({ code: 1002, reason: 'frame parser failed', wasClean: false })
    }
  })

  socket.on('error', (error) => {
    finishClose({
      code: 1006,
      reason: `socket error: ${error?.message ?? error}`,
      wasClean: false,
      error: { message: String(error?.message ?? error), code: 'socket' },
    })
  })

  socket.on('close', () => {
    finishClose(closeInfo ?? { code: 1006, reason: 'socket closed without a close frame', wasClean: false })
  })

  socket.on('end', () => {
    finishClose(closeInfo ?? { code: 1006, reason: 'socket ended without a close frame', wasClean: false })
  })

  if (Buffer.isBuffer(head) && head.length > 0) {
    buffer = head
    try {
      pump()
    } catch (error) {
      logger?.error?.(`ws: initial frame parser failed: ${error?.message ?? error}`)
      finishClose({ code: 1002, reason: 'frame parser failed', wasClean: false })
    }
  }

  if (Number(keepAliveMs) > 0) {
    keepAliveTimer = setInterval(() => {
      if (readyState === READY_STATE.OPEN) ping()
    }, Number(keepAliveMs))
    if (typeof keepAliveTimer.unref === 'function') keepAliveTimer.unref()
  }

  connection.send = send
  connection.ping = ping
  connection.close = close
  /** Hard teardown without the close handshake (VM service died, tests). */
  connection.terminate = (info = { code: 1006, reason: 'terminated locally', wasClean: false }) => {
    if (closed) return
    readyState = READY_STATE.CLOSING
    connection.readyState = readyState
    finishClose(info)
  }
  connection.onMessage = (handler) => {
    if (typeof handler !== 'function') return () => {}
    messageHandlers.add(handler)
    return () => messageHandlers.delete(handler)
  }
  connection.onClose = (handler) => {
    if (typeof handler !== 'function') return () => {}
    if (closed && closeInfo !== null) {
      // Late subscriber: still learn how it ended.
      try {
        handler(closeInfo)
      } catch {
        /* ignore */
      }
      return () => {}
    }
    closeHandlers.add(handler)
    return () => closeHandlers.delete(handler)
  }

  return connection
}

export default createWebSocketClient