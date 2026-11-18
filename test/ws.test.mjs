/**
 * Unit tests for host/ws.js — dependency-free RFC 6455 client.
 *
 * The test starts its own WebSocket server (node:http `upgrade` handler + our
 * own frame encoder) so nothing touches the network or Flutter. It verifies the
 * handshake bytes the server actually received, masked client frames, extended
 * payload lengths, fragmented messages, ping/pong, close codes and UTF-8 text.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import http from 'node:http'
import test from 'node:test'
import { createWebSocketClient, encodeFrame, READY_STATE } from '../host/ws.js'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Everything the test opens is force-closed in `test.after`, so a regression
 *  in the close handshake fails an assertion instead of hanging the runner. */
const openServers = []
const openClients = []

async function openClient(options) {
  const client = await createWebSocketClient(options)
  openClients.push(client)
  return client
}

test.after(async () => {
  for (const client of openClients) {
    try {
      client.terminate()
    } catch {
      /* already closed */
    }
  }
  openClients.length = 0
  for (const server of openServers) {
    try {
      await server.close()
    } catch {
      /* already closed */
    }
  }
  openServers.length = 0
})

/** Start a toy ws server; `handler.onReady({socket, send, received, headers})`. */
function startServer(handler) {
  const received = []
  const sockets = new Set()
  const server = http.createServer((request, response) => {
    response.writeHead(426, { 'content-type': 'text/plain' })
    response.end('upgrade required')
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (request, socket, head) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    const key = String(request.headers['sec-websocket-key'] ?? '')
    const accept = createHash('sha1').update(`${key}${GUID}`).digest('base64')
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'),
    )
    const send = (opcode, payload, fin = true) => socket.write(encodeFrame(opcode, payload, { fin, mask: false }))
    const sendText = (text) => send(1, String(text))
    const closeWith = (code, reason = '') => {
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason))
      payload.writeUInt16BE(code, 0)
      payload.write(reason, 2)
      send(8, payload)
    }
    // Minimal server-side frame reader (client frames are always masked).
    let buffer = head.length > 0 ? head : Buffer.alloc(0)
    let fragments = []
    let fragmentOpcode = null
    const pump = () => {
      for (;;) {
        if (buffer.length < 2) return
        const first = buffer[0]
        const second = buffer[1]
        const fin = (first & 0x80) !== 0
        const opcode = first & 0x0f
        const masked = (second & 0x80) !== 0
        let length = second & 0x7f
        let offset = 2
        if (length === 126) {
          if (buffer.length < 4) return
          length = buffer.readUInt16BE(2)
          offset = 4
        } else if (length === 127) {
          if (buffer.length < 10) return
          length = buffer.readUInt32BE(6)
          offset = 10
        }
        const maskKey = masked ? buffer.subarray(offset, offset + 4) : null
        if (masked) offset += 4
        if (buffer.length < offset + length) return
        let payload = buffer.subarray(offset, offset + length)
        if (maskKey !== null) {
          payload = Buffer.from(payload)
          for (let index = 0; index < payload.length; index += 1) payload[index] ^= maskKey[index & 3]
        }
        buffer = buffer.subarray(offset + length)
        if (opcode === 0x0) {
          fragments.push(payload)
          if (fin) {
            const full = Buffer.concat(fragments)
            received.push({ opcode: fragmentOpcode, payload: full, masked })
            fragments = []
            fragmentOpcode = null
          }
        } else if (opcode === 0x1 || opcode === 0x2) {
          if (!fin) {
            fragments = [payload]
            fragmentOpcode = opcode
          } else {
            received.push({ opcode, payload, masked })
          }
        } else if (opcode === 0x8) {
          received.push({ opcode: 8, payload, masked })
          socket.destroy()
        } else if (opcode === 0x9) {
          received.push({ opcode: 9, payload, masked })
          send(10, payload)
        } else if (opcode === 0xa) {
          received.push({ opcode: 10, payload, masked })
        }
      }
    }
    socket.on('data', (chunk) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      pump()
    })
    socket.on('error', () => {})
    handler.onReady?.({
      socket,
      send,
      sendText,
      closeWith,
      received,
      headers: request.headers,
      requestPath: request.url,
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      const handle = {
        port,
        url: (path = '/ws') => `ws://127.0.0.1:${port}${path}`,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy()
            sockets.clear()
            server.closeAllConnections?.()
            server.close(() => done())
          }),
        received,
      }
      openServers.push(handle)
      resolve(handle)
    })
  })
}

/** Collect messages until `predicate` is happy (or the timeout fires). */
function until(predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      const value = predicate()
      if (value) {
        clearInterval(timer)
        resolve(value)
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error('timed out waiting for condition'))
      }
    }, 5)
  })
}

test('handshake sends Upgrade, a valid Sec-WebSocket-Key, extra headers and origin', async () => {
  let seen = null
  const server = await startServer({
    onReady: (context) => {
      seen = context.headers
    },
  })
  const ws = await openClient({
    url: server.url('/token=abc/ws?x=1'),
    headers: { 'x-workbench-probe': 'yes', cookie: 'a=b' },
    origin: 'http://127.0.0.1:9999',
  })
  assert.equal(ws.readyState, READY_STATE.OPEN)
  assert.equal(seen.upgrade, 'websocket')
  assert.equal(seen.connection.toLowerCase(), 'upgrade')
  assert.equal(seen['sec-websocket-version'], '13')
  const key = seen['sec-websocket-key']
  assert.ok(typeof key === 'string' && Buffer.from(key, 'base64').length === 16, 'key must be 16 random bytes, base64')
  assert.equal(seen['x-workbench-probe'], 'yes')
  assert.equal(seen.cookie, 'a=b')
  assert.equal(seen.origin, 'http://127.0.0.1:9999')
  assert.equal(seen.host, `127.0.0.1:${server.port}`)
  ws.close(1000, 'done')
  await until(() => ws.readyState === READY_STATE.CLOSED)
})

test('text round trip: server to client and masked client to server', async () => {
  let context = null
  const server = await startServer({ onReady: (value) => (context = value) })
  const ws = await openClient({ url: server.url() })
  const messages = []
  ws.onMessage((data, meta) => messages.push({ data, meta }))

  context.sendText('hello from the server')
  await until(() => messages.length === 1)
  assert.equal(messages[0].data, 'hello from the server')
  assert.equal(messages[0].meta.binary, false)
  assert.equal(messages[0].meta.bytes, 21)

  ws.send('hello from the client')
  const frame = await until(() => context.received.find((item) => item.opcode === 1))
  assert.equal(frame.payload.toString('utf8'), 'hello from the client')
  assert.equal(frame.masked, true, 'client frames must be masked')
  ws.close()
})

test('single big frame (64-bit length) and a stream of small frames', async () => {
  let context = null
  const server = await startServer({ onReady: (value) => (context = value) })
  const ws = await openClient({ url: server.url() })
  const messages = []
  ws.onMessage((data, meta) => messages.push({ data, meta }))

  const big = 'x'.repeat(300 * 1024) // needs the 64-bit extended length path
  context.sendText(big)
  await until(() => messages.length === 1)
  assert.equal(messages[0].data.length, big.length)
  assert.equal(messages[0].data, big)

  for (let index = 0; index < 60; index += 1) context.sendText(`small-${index}`)
  await until(() => messages.length === 61)
  for (let index = 0; index < 60; index += 1) assert.equal(messages[index + 1].data, `small-${index}`)
  ws.close()
})

test('fragmented text message is reassembled in order', async () => {
  let context = null
  const server = await startServer({ onReady: (value) => (context = value) })
  const ws = await openClient({ url: server.url() })
  const messages = []
  ws.onMessage((data, meta) => messages.push({ data, meta }))

  context.send(1, 'hel', false)
  context.send(0, 'lo ', false)
  context.send(0, 'wor', false)
  context.send(0, 'ld', true)
  await until(() => messages.length === 1)
  assert.equal(messages[0].data, 'hello world')
  assert.equal(messages[0].meta.binary, false)
  ws.close()
})

test('ping is answered with a pong carrying the same payload', async () => {
  let context = null
  const server = await startServer({ onReady: (value) => (context = value) })
  const ws = await openClient({ url: server.url() })
  context.send(9, Buffer.from('keepalive'))
  const pong = await until(() => context.received.find((item) => item.opcode === 10))
  assert.equal(pong.payload.toString('utf8'), 'keepalive')
  assert.equal(pong.masked, true)

  // Client-initiated ping reaches the server, which answers.
  ws.ping('client-ping')
  const ping = await until(() => context.received.find((item) => item.opcode === 9))
  assert.equal(ping.payload.toString('utf8'), 'client-ping')
  ws.close()
})

test('close frame from the server surfaces code + reason and flips readyState', async () => {
  let context = null
  const server = await startServer({ onReady: (value) => (context = value) })
  const ws = await openClient({ url: server.url() })
  const closes = []
  ws.onClose((info) => closes.push(info))
  assert.equal(ws.readyState, READY_STATE.OPEN)
  context.closeWith(1001, 'going away')
  await until(() => closes.length === 1)
  assert.equal(closes[0].code, 1001)
  assert.equal(closes[0].reason, 'going away')
  assert.equal(closes[0].wasClean, true)
  assert.equal(ws.readyState, READY_STATE.CLOSED)
  assert.equal(ws.state, 'closed')
})

test('client close sends a masked close frame with the requested code', async () => {
  let context = null
  const server = await startServer({ onReady: (value) => (context = value) })
  const ws = await openClient({ url: server.url() })
  ws.close(4001, 'test reason')
  const frame = await until(() => context.received.find((item) => item.opcode === 8))
  assert.equal(frame.payload.readUInt16BE(0), 4001)
  assert.equal(frame.payload.subarray(2).toString('utf8'), 'test reason')
  assert.equal(frame.masked, true)
  await until(() => ws.readyState === READY_STATE.CLOSED)
})

test('binary and multi-byte UTF-8 payloads survive the trip', async () => {
  let context = null
  const server = await startServer({ onReady: (value) => (context = value) })
  const ws = await openClient({ url: server.url() })
  const messages = []
  ws.onMessage((data, meta) => messages.push({ data, meta }))

  context.send(1, Buffer.from('中文 ✓ émoji 🚀', 'utf8'))
  context.send(2, Buffer.from([0, 1, 2, 250]))
  await until(() => messages.length === 2)
  assert.equal(messages[0].data, '中文 ✓ émoji 🚀')
  assert.equal(messages[0].meta.binary, false)
  assert.equal(messages[1].meta.binary, true)
  assert.deepEqual([...messages[1].data], [0, 1, 2, 250])

  ws.send(Buffer.from([9, 8, 7]))
  const frame = await until(() => context.received.find((item) => item.opcode === 2))
  assert.deepEqual([...frame.payload], [9, 8, 7])
  ws.close()
})

test('a bad handshake response rejects with code bad-status, and a silent server times out', async () => {
  const rejecting = http.createServer((request, response) => {
    response.writeHead(401, { 'content-type': 'text/plain' })
    response.end('nope')
  })
  const silent = http.createServer(() => {})
  const sockets = new Set()
  for (const server of [rejecting, silent]) server.on('connection', (socket) => sockets.add(socket))
  const ports = await Promise.all(
    [rejecting, silent].map(
      (server) =>
        new Promise((resolve) => {
          server.listen(0, '127.0.0.1', () => resolve(server.address().port))
        }),
    ),
  )

  await assert.rejects(
    () => createWebSocketClient({ url: `ws://127.0.0.1:${ports[0]}/ws` }),
    (error) => {
      assert.equal(error.code, 'bad-status')
      assert.equal(error.status, 401)
      assert.match(error.message, /401/)
      return true
    },
  )
  await assert.rejects(
    () => createWebSocketClient({ url: `ws://127.0.0.1:${ports[1]}/ws`, handshakeTimeoutMs: 150 }),
    (error) => {
      assert.equal(error.code, 'timeout')
      return true
    },
  )
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await new Promise((resolve) => {
    rejecting.closeAllConnections?.()
    rejecting.close(resolve)
  })
  await new Promise((resolve) => {
    silent.closeAllConnections?.()
    silent.close(resolve)
  })
})

test('a URL that is not ws/wss rejects immediately with code bad-url', async () => {
  await assert.rejects(
    () => createWebSocketClient({ url: 'http://127.0.0.1:1/ws' }),
    (error) => error.code === 'bad-url',
  )
})