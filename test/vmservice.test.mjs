/**
 * Unit tests for host/vmservice.js.
 *
 * A local WebSocket server speaks just enough of the VM Service protocol
 * (JSON-RPC 2.0 + `streamNotify`) to exercise the client offline: no Flutter,
 * no Dart process, no network. The response shapes are the ones verified on this
 * host against Flutter 3.38.5 / Dart 3.10.4 (see docs/research/flutter-internals.md).
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import http from 'node:http'
import test from 'node:test'
import { createErrorStore } from '../host/errors.js'
import { createLogStore } from '../host/logs.js'
import { createBus, sleep } from '../host/util.js'
import { createVmService } from '../host/vmservice.js'
import { encodeFrame } from '../host/ws.js'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const openServers = []
const openServices = []

// --- fake VM service --------------------------------------------------------

function vmObject(version = '3.10.4 (stable) (Tue Dec 9 00:01:55 2025 -0800) on "windows_x64"') {
  return {
    type: 'VM',
    name: 'vm',
    version,
    pid: 12345,
    startTime: 1795019918536,
    isolates: [
      { type: '@Isolate', id: 'isolates/1', name: 'main', number: '1', isSystemIsolate: false, isolateGroupId: 'isolateGroups/9' },
      { type: '@Isolate', id: 'isolates/2', name: 'vm-service', number: '2', isSystemIsolate: true },
    ],
    systemIsolates: [],
    isolateGroups: [],
  }
}

/** Standard responder; `overrides` per method can return a result, an error or undefined (no reply). */
function createResponder(overrides = {}) {
  const calls = []
  const respond = (params = {}) => {
    const method = params.method
    const args = params.params ?? {}
    calls.push({ method, params: args })
    const override = overrides[method]
    if (override !== undefined) return override(args, params)
    switch (method) {
      case 'getVM':
        return { result: vmObject() }
      case 'getIsolate':
        return {
          result: {
            type: 'Isolate',
            id: args.isolateId ?? 'isolates/1',
            name: 'main',
            number: '1',
            runnable: true,
            pauseEvent: { type: 'Event', kind: 'Resume' },
            extensionRPCs: ['ext.dart.io.getHttpProfile', 'ext.flutter.inspector.screenshot'],
          },
        }
      case 'streamListen':
      case 'streamCancel':
        return { result: { type: 'Success' } }
      case 'ext.dart.io.httpEnableTimelineLogging':
        return { result: { type: 'HttpTimelineLoggingState', enabled: true } }
      case 'ext.flutter.inspector.structuredErrors':
        return { result: { type: '_extensionType', method, enabled: args.enabled ?? 'true' } }
      case 'ext.dart.io.getHttpProfile':
        return { result: { type: 'HttpProfile', timestamp: 1000, requests: [] } }
      case 'getVMTimeline':
        return { result: { type: 'Timeline', traceEvents: [] } }
      default:
        return { error: { code: -32601, message: `Unknown method "${method}".` } }
    }
  }
  return { calls, respond }
}

function startFakeVm(options = {}) {
  const sockets = new Set()
  const connections = []
  const responder = options.responder ?? createResponder()
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
      ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'),
    )
    let buffer = head.length > 0 ? head : Buffer.alloc(0)
    let fragments = []
    let fragmentOpcode = null
    const context = {
      socket,
      requests: [],
      send(value) {
        socket.write(encodeFrame(1, JSON.stringify(value), { mask: false }))
      },
      emit(streamId, event) {
        context.send({ jsonrpc: '2.0', method: 'streamNotify', params: { streamId, event } })
      },
      close() {
        socket.destroy()
      },
    }
    connections.push(context)
    const pump = () => {
      for (;;) {
        if (buffer.length < 2) return
        const first = buffer[0]
        const second = buffer[1]
        const fin = (first & 0x80) !== 0
        const opcode = first & 0x0f
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
        const masked = (second & 0x80) !== 0
        let maskKey = null
        if (masked) {
          maskKey = buffer.subarray(offset, offset + 4)
          offset += 4
        }
        if (buffer.length < offset + length) return
        let payload = buffer.subarray(offset, offset + length)
        if (maskKey !== null) {
          payload = Buffer.from(payload)
          for (let index = 0; index < payload.length; index += 1) payload[index] ^= maskKey[index & 3]
        }
        buffer = buffer.subarray(offset + length)
        if (opcode === 0x0) {
          fragments.push(payload)
          if (!fin) continue
          const full = Buffer.concat(fragments)
          fragments = []
          fragmentOpcode = null
          handleText(full)
        } else if (opcode === 0x1) {
          if (!fin) {
            fragments = [payload]
            fragmentOpcode = opcode
          } else {
            handleText(payload)
          }
        } else if (opcode === 0x8) {
          socket.destroy()
        } else if (opcode === 0x9) {
          socket.write(encodeFrame(10, payload, { mask: false }))
        }
      }
    }
    function handleText(payload) {
      let message
      try {
        message = JSON.parse(payload.toString('utf8'))
      } catch {
        return
      }
      context.requests.push(message)
      const reply = responder.respond(message)
      if (reply === undefined || reply === null) return // deliberately no answer (timeout test)
      if (reply.error !== undefined) {
        context.send({ jsonrpc: '2.0', id: message.id, error: reply.error })
        return
      }
      context.send({ jsonrpc: '2.0', id: message.id, result: reply.result ?? null })
    }
    socket.on('data', (chunk) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      pump()
    })
    socket.on('error', () => {})
    options.onReady?.(context)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      const handle = {
        port,
        uri: `ws://127.0.0.1:${port}/auth-token=/ws`,
        connections,
        responder,
        getRequests(method) {
          return responder.calls.filter((call) => call.method === method)
        },
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy()
            sockets.clear()
            server.closeAllConnections?.()
            server.close(() => done())
          }),
      }
      openServers.push(handle)
      resolve(handle)
    })
  })
}

function makeServices(extra = {}) {
  const bus = createBus()
  const logs = createLogStore({ capacity: 500 })
  const vm = createVmService({
    logs,
    bus,
    reconnectBaseMs: 10,
    reconnectMaxMs: 40,
    reconnectMaxAttempts: 6,
    requestTimeoutMs: 1500,
    isolateWaitMs: 800,
    ...extra,
  })
  openServices.push(vm)
  return { bus, logs, vm }
}

test.after(async () => {
  for (const vm of openServices) await vm.dispose().catch(() => {})
  openServices.length = 0
  for (const server of openServers) await server.close().catch(() => {})
  openServers.length = 0
})

// --- tests ------------------------------------------------------------------

test('connect performs the getVM handshake, resolves the main isolate and reports version/vmId', async () => {
  const server = await startFakeVm()
  const { bus, logs, vm } = makeServices()
  const events = []
  bus.on('vm:connected', (payload) => events.push(payload))

  const result = await vm.connect({ runId: 'run-1', wsUri: server.uri })
  assert.equal(result.ok, true)
  assert.equal(result.vmId, 'vm')
  assert.match(result.version, /3\.10\.4/)
  assert.equal(result.isolateId, 'isolates/1', 'main isolate, not the system isolate')
  assert.equal(vm.isConnected(), true)

  const snapshotValue = vm.snapshot()
  assert.equal(snapshotValue.connected, true)
  assert.equal(snapshotValue.runId, 'run-1')
  assert.equal(snapshotValue.vmId, 'vm')
  assert.equal(snapshotValue.isolates.length, 2)
  assert.equal(snapshotValue.isolateId, 'isolates/1')
  assert.deepEqual(
    [...snapshotValue.streams].sort(),
    ['Extension', 'Logging', 'Timeline', 'VM'],
  )
  assert.equal(events.length, 1)

  // getVM ran first, streams were listened to, HTTP logging + structured errors enabled.
  const methods = server.responder.calls.map((call) => call.method)
  assert.equal(methods[0], 'getVM')
  assert.ok(methods.includes('streamListen'))
  assert.ok(methods.includes('ext.dart.io.httpEnableTimelineLogging'))
  assert.ok(methods.includes('ext.flutter.inspector.structuredErrors'))
  assert.equal(server.getRequests('ext.dart.io.httpEnableTimelineLogging')[0].params.enabled, 'true')
  assert.equal(logs.counts().bySource.vm >= 1, true, 'a vm log entry records the connection')

  await vm.disconnect({ runId: 'run-1' })
  assert.equal(vm.isConnected(), false)
})

test('calls serialize by id: concurrent RPCs keep their own results and ids increase', async () => {
  const server = await startFakeVm({
    responder: createResponder({
      echo: (params) => ({ result: { type: 'Echo', value: params.value } }),
    }),
  })
  const { vm } = makeServices()
  await vm.connect({ runId: 'run-2', wsUri: server.uri })

  const [first, second, third] = await Promise.all([
    vm.call('echo', { value: 'a' }),
    vm.call('echo', { value: 'b' }),
    vm.call('echo', { value: 'c' }),
  ])
  assert.deepEqual([first.value, second.value, third.value], ['a', 'b', 'c'], 'responses must match their own id')
  const ids = server.responder.calls.filter((call) => call.method === 'echo').map((call) => call.params.value)
  assert.deepEqual(ids, ['a', 'b', 'c'], 'writes are serialized in call order')
  await vm.disconnect()
})

test('a call that is never answered rejects with code timeout and never hangs', async () => {
  const server = await startFakeVm({
    responder: createResponder({
      slow: () => undefined, // deliberately no reply
    }),
  })
  const { vm } = makeServices()
  await vm.connect({ runId: 'run-3', wsUri: server.uri })

  const started = Date.now()
  await assert.rejects(
    () => vm.call('slow', {}, { timeoutMs: 120 }),
    (error) => {
      assert.equal(error.code, 'timeout')
      assert.equal(error.method, 'slow')
      assert.match(error.message, /timed out after 120ms/)
      return true
    },
  )
  assert.ok(Date.now() - started < 2000, 'timeout must fire promptly')
  // The connection is still usable afterwards.
  const vmInfo = await vm.call('getVM')
  assert.equal(vmInfo.type, 'VM')
  await vm.disconnect()
})

test('RPC errors carry code and message (unknown method keeps the numeric code)', async () => {
  const server = await startFakeVm()
  const { vm } = makeServices()
  await vm.connect({ runId: 'run-4', wsUri: server.uri })
  await assert.rejects(
    () => vm.call('noSuchMethod'),
    (error) => {
      assert.equal(error.code, 'rpc-error')
      assert.equal(error.rpcCode, -32601)
      assert.match(error.message, /Unknown method/)
      assert.equal(error.method, 'noSuchMethod')
      return true
    },
  )
  await vm.disconnect()
  await assert.rejects(
    () => vm.call('getVM'),
    (error) => {
      assert.equal(error.code, 'not-connected')
      return true
    },
  )
})

test('httpProfile maps the verified ext.dart.io response into NetEntry[] and dedupes by cursor', async () => {
  const profile = (timestamp, requests) => ({ result: { type: 'HttpProfile', timestamp, requests } })
  const ref = (id, startTime, status, extra = {}) => ({
    type: '@HttpProfileRequest',
    id,
    isolateId: 'isolates/1',
    method: 'GET',
    uri: 'http://127.0.0.1:48082/api/items?page=2',
    events: [{ timestamp: startTime + 900, event: 'Request sent' }],
    startTime,
    endTime: startTime + 4000,
    request: {
      headers: { 'user-agent': ['Dart/3.10 (dart:io)'], host: ['127.0.0.1:48082'] },
      contentLength: -1,
      cookies: [],
      persistentConnection: true,
    },
    response: {
      startTime: startTime + 4500,
      endTime: startTime + 67000,
      headers: { 'content-type': ['application/json'], 'x-probe': ['yes'] },
      contentLength: -1,
      cookies: [],
      isRedirect: false,
      reasonPhrase: status === 200 ? 'OK' : 'Unauthorized',
      redirects: [],
      statusCode: status,
      ...extra,
    },
  })

  let phase = 0
  const server = await startFakeVm({
    responder: createResponder({
      'ext.dart.io.getHttpProfile': (params) => {
        phase += 1
        if (params.updatedSince === undefined) {
          return profile(1795020230989730, [ref('3607923408218006926', 1795020226448674, 200)])
        }
        // Cursor call: one old entry (must be filtered) plus one fresh entry.
        return profile(1795020240000000, [
          ref('3607923408218006926', 1795020226448674, 200),
          ref('3607923408218007777', 1795020239000000, 401),
        ])
      },
    }),
  })
  const { vm } = makeServices()
  await vm.connect({ runId: 'run-5', wsUri: server.uri })

  const first = await vm.httpProfile({ runId: 'run-5' })
  assert.equal(first.ok, true)
  assert.equal(first.method, 'ext.dart.io.getHttpProfile')
  assert.equal(first.entries.length, 1)
  const entry = first.entries[0]
  assert.equal(entry.id, '3607923408218006926', 'stable id from the SDK request id')
  assert.equal(entry.method, 'GET')
  assert.equal(entry.uri, 'http://127.0.0.1:48082/api/items?page=2')
  assert.equal(entry.host, '127.0.0.1:48082')
  assert.equal(entry.path, '/api/items?page=2')
  assert.equal(entry.status, 200, 'status comes from response.statusCode')
  assert.equal(entry.startMicros, 1795020226448674)
  assert.equal(entry.endMicros, 1795020226515674)
  assert.equal(entry.durationMs, 67, 'response end − request start, in ms')
  assert.equal(entry.requestBytes, null, 'chunked request reports contentLength -1 → null, not a lie')
  assert.equal(entry.responseHeaders['x-probe'][0], 'yes')
  assert.equal(entry.requestHeaders.host[0], '127.0.0.1:48082')
  assert.equal(entry.complete, true)
  assert.equal(entry.contentPreview, 'application/json')
  assert.equal(entry.runId, 'run-5')
  assert.equal(typeof first.nextSinceId, 'string')

  const second = await vm.httpProfile({ runId: 'run-5', sinceId: first.nextSinceId })
  assert.equal(second.entries.length, 1, 'entries older than the cursor are dropped')
  assert.equal(second.entries[0].id, '3607923408218007777')
  assert.equal(second.entries[0].status, 401)
  assert.equal(server.getRequests('ext.dart.io.getHttpProfile')[1].params.updatedSince, 1795020230989730)
  await vm.disconnect()
})

test('httpProfile falls back to _getHttpProfile once and remembers the method that worked', async () => {
  const server = await startFakeVm({
    responder: createResponder({
      'ext.dart.io.getHttpProfile': () => ({ error: { code: -32601, message: 'Unknown method "ext.dart.io.getHttpProfile".' } }),
      _getHttpProfile: () => ({ result: { type: 'HttpProfile', timestamp: 42, requests: [] } }),
    }),
  })
  const { vm } = makeServices()
  await vm.connect({ runId: 'run-6', wsUri: server.uri })

  const first = await vm.httpProfile({})
  assert.equal(first.ok, true)
  assert.equal(first.method, '_getHttpProfile')
  const second = await vm.httpProfile({})
  assert.equal(second.method, '_getHttpProfile')
  assert.equal(server.getRequests('ext.dart.io.getHttpProfile').length, 1, 'the failing method is not retried first again')
  assert.equal(vm.snapshot().httpMethod, '_getHttpProfile')
  await vm.disconnect()
})

test('httpRequestDetail returns headers + bodies with explicit truncation flags', async () => {
  const bodyBytes = (text) => [...Buffer.from(text, 'utf8')]
  const detail = (requestText, responseText) => ({
    result: {
      type: 'HttpProfileRequest',
      id: '4242',
      isolateId: 'isolates/1',
      method: 'POST',
      uri: 'http://127.0.0.1:48082/api/ping',
      startTime: 1000000,
      endTime: 1100000,
      events: [{ timestamp: 1000100, event: 'Request sent' }],
      request: { headers: { 'content-type': ['application/json'] }, contentLength: 12, cookies: [] },
      response: {
        statusCode: 200,
        startTime: 1200000,
        endTime: 1300000,
        headers: { 'content-type': ['application/json'] },
        contentLength: responseText.length,
        reasonPhrase: 'OK',
        redirects: [],
        cookies: [],
      },
      requestBody: bodyBytes(requestText),
      responseBody: bodyBytes(responseText),
    },
  })

  const server = await startFakeVm({
    responder: createResponder({
      'ext.dart.io.getHttpProfileRequest': (params) =>
        params.id === '4242' ? detail('{"hello":"world"}', '{"ok":true}') : { error: { code: 50, message: `Unable to find request with id: '${params.id}'` } },
    }),
  })
  const { vm } = makeServices()
  await vm.connect({ runId: 'run-7', wsUri: server.uri })

  const full = await vm.httpRequestDetail({ requestId: '4242' })
  assert.equal(full.ok, true)
  assert.equal(full.requestBody, '{"hello":"world"}')
  assert.equal(full.responseBody, '{"ok":true}')
  assert.equal(full.requestBodyBytes, 17)
  assert.equal(full.requestBodyTruncated, false)
  assert.equal(full.responseBodyTruncated, false)
  assert.equal(full.truncated, false)
  assert.equal(full.requestHeaders['content-type'][0], 'application/json')
  assert.equal(full.status, 200)
  assert.equal(full.durationMs, 300)

  const clipped = await vm.httpRequestDetail({ requestId: '4242', maxBodyBytes: 1024 })
  assert.equal(clipped.truncated, false, 'a small body is untouched')

  // Force truncation with a large response body and a 1 KiB cap.
  const bigServer = await startFakeVm({
    responder: createResponder({
      'ext.dart.io.getHttpProfileRequest': () => detail('{"q":1}', 'y'.repeat(5000)),
    }),
  })
  const second = makeServices()
  await second.vm.connect({ runId: 'run-8', wsUri: bigServer.uri })
  const cut = await second.vm.httpRequestDetail({ requestId: '4242', maxBodyBytes: 1024 })
  assert.equal(cut.truncated, true)
  assert.equal(cut.responseBodyTruncated, true)
  assert.equal(cut.requestBodyTruncated, false)
  assert.equal(cut.responseBody.length, 1024)
  assert.equal(cut.responseBodyBytes, 5000, 'the real byte count is reported, not the clamped one')
  await second.vm.disconnect()

  await assert.rejects(
    () => vm.httpRequestDetail({ requestId: 'nope' }),
    (error) => {
      assert.equal(error.code, 'rpc-error')
      assert.match(error.message, /Unable to find request/)
      return true
    },
  )
  await vm.disconnect()
})

test('screenshot returns base64 PNG through the verified inspector path', async () => {
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001',
    'hex',
  ).toString('base64')
  const server = await startFakeVm({
    responder: createResponder({
      'ext.flutter.inspector.getRootWidgetSummaryTree': () => ({
        result: { type: '_extensionType', method: 'ext.flutter.inspector.getRootWidgetSummaryTree', result: { valueId: 'inspector-0', description: '[root]' } },
      }),
      'ext.flutter.inspector.screenshot': (params) =>
        params.id === 'inspector-0'
          ? { result: { type: '_extensionType', method: 'ext.flutter.inspector.screenshot', result: png } }
          : { error: { code: -32602, message: `unknown inspector id ${params.id}` } },
    }),
  })
  const { vm } = makeServices()
  await vm.connect({ runId: 'run-9', wsUri: server.uri })

  const shot = await vm.screenshot({ runId: 'run-9' })
  assert.equal(shot.ok, true)
  assert.equal(shot.mime, 'image/png')
  assert.equal(shot.base64, png)
  assert.equal(shot.method, 'ext.flutter.inspector.screenshot')
  assert.equal(Buffer.from(shot.base64, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.ok(shot.attempted.includes('ext.flutter.inspector.getRootWidgetSummaryTree+ext.flutter.inspector.screenshot'))
  await vm.disconnect()
})

test('screenshot resolves an explicit error when no extension supports it', async () => {
  const server = await startFakeVm({ responder: createResponder() }) // every unknown method → -32601
  const { vm } = makeServices()
  await vm.connect({ runId: 'run-10', wsUri: server.uri })
  await assert.rejects(
    () => vm.screenshot({ runId: 'run-10' }),
    (error) => {
      assert.equal(error.code, 'screenshot-unsupported')
      assert.match(error.message, /no screenshot service extension worked/)
      assert.deepEqual(error.attempted, [
        'ext.flutter.inspector.getRootWidgetSummaryTree+ext.flutter.inspector.screenshot',
        '_flutter.screenshot',
        'ext.flutter.screenshot',
      ])
      assert.equal(error.failures.length, 3)
      return true
    },
  )
  await vm.disconnect()
})

test('Flutter.Error, Flutter.Frame and Logging events reach the bus, logs and frameStats', async () => {
  let context = null
  const server = await startFakeVm({ onReady: (value) => (context = value) })
  const { bus, logs, vm } = makeServices()
  const errors = createErrorStore({ bus, logs })
  const vmEvents = []
  bus.on('vm:event', (payload) => vmEvents.push(payload))

  await vm.connect({ runId: 'run-11', wsUri: server.uri })

  context.emit('Extension', {
    type: 'Event',
    kind: 'Extension',
    extensionKind: 'Flutter.Error',
    isolate: { type: '@Isolate', id: 'isolates/1' },
    timestamp: 1795019919419,
    extensionData: {
      description: 'Exception caught by widgets library',
      type: '_FlutterErrorDetailsNode',
      allowWrap: false,
      valueId: 'inspector-0',
      properties: [
        { description: 'The following StateError was thrown building ProbeApp(dirty, state: _ProbeAppState#96fa1):' },
        { description: 'Bad state: nope' },
      ],
      errorsSinceReload: 0,
      renderedErrorText: [
        '══╡ EXCEPTION CAUGHT BY WIDGETS LIBRARY ╞═══',
        'The following StateError was thrown building ProbeApp(dirty, state: _ProbeAppState#96fa1):',
        'Bad state: nope',
        '',
        'When the exception was thrown, this was the stack:',
        '#0      _ProbeAppState.build (package:probe/main.dart:20:5)',
        '#1      StatefulElement.build (package:flutter/src/widgets/framework.dart:5000:27)',
        '══════════════════════════════════════',
      ].join('\n'),
    },
  })

  const busErrors = []
  bus.on('vm:flutter-error', (payload) => busErrors.push(payload))
  // The store subscribed before the event; re-emit through the vm path for it.
  await sleep(60)
  assert.equal(busErrors.length, 1)
  const payload = busErrors[0]
  assert.equal(payload.kind, 'flutter')
  assert.equal(payload.message, 'Bad state: nope')
  assert.match(payload.exception, /The following StateError was thrown/)
  assert.equal(payload.frames.length, 2)
  assert.equal(payload.frames[0].file, 'package:probe/main.dart')
  assert.equal(payload.frames[0].line, 20)
  assert.equal(payload.frames[0].column, 5)
  assert.equal(payload.errorsSinceReload, 0)
  assert.equal(payload.isolateId, 'isolates/1')
  // The bus already carried the payload into the store (it subscribed first).
  const stored = errors.query({}).groups
  assert.equal(stored.length, 1, 'one deduped group for one Flutter.Error event')
  assert.equal(stored[0].message, 'Bad state: nope')
  assert.equal(stored[0].frames.length, 2)
  assert.equal(errors.ingest(payload).count, 2, 'ingesting the same payload again only bumps the count')
  assert.equal(vmEvents.some((item) => item.streamId === 'Extension'), true)

  const errorLogs = logs.query({ source: 'vm', level: 'error' }).entries
  assert.equal(errorLogs.length >= 1, true, 'Flutter.Error is logged with source vm')
  assert.match(errorLogs[0].text, /Bad state: nope/)

  // Flutter.Frame → frameStats
  const frame = (number, build, raster) =>
    context.emit('Extension', {
      type: 'Event',
      kind: 'Extension',
      extensionKind: 'Flutter.Frame',
      isolate: { type: '@Isolate', id: 'isolates/1' },
      timestamp: 1795019919419 + number,
      extensionData: { number, startTime: 8440852456, elapsed: build + raster + 1000, build, raster, vsyncOverhead: 4826 },
    })
  frame(1, 2674, 77512)
  frame(2, 2000, 3000)
  frame(3, 12000, 8000)
  await sleep(80)

  const stats = await vm.frameStats({ runId: 'run-11' })
  assert.equal(stats.ok, true)
  assert.equal(stats.source, 'extension')
  assert.equal(stats.total, 3)
  assert.deepEqual(stats.frames.map((item) => item.buildMs), [2.67, 2, 12])
  assert.equal(stats.frames[0].rasterMs, 77.51)
  assert.equal(stats.jankCount, 2, 'build+raster over 16.67ms is jank')
  assert.equal(stats.worstMs, 80.19)
  assert.equal(stats.thresholdMs, 16.67)

  // Logging stream → log entry + vm:log-error
  const logErrors = []
  bus.on('vm:log-error', (payload) => logErrors.push(payload))
  context.emit('Logging', {
    type: 'Event',
    kind: 'Logging',
    isolate: { type: '@Isolate', id: 'isolates/1' },
    logRecord: { type: 'LogRecord', message: 'database exploded', time: 1795019919500, sequenceNumber: 7, level: 1000 },
  })
  await sleep(60)
  assert.equal(logErrors.length, 1)
  assert.equal(logErrors[0].level, 'error')
  const loggingEntries = logs.query({ pattern: 'database exploded' }).entries
  assert.equal(loggingEntries.length, 1)
  assert.equal(loggingEntries[0].source, 'vm')
  assert.equal(loggingEntries[0].level, 'error')

  errors.dispose()
  await vm.disconnect()
})

test('reconnects with backoff while the run is alive and stops after disconnect', async () => {
  const server = await startFakeVm()
  const { bus, vm } = makeServices()
  const events = []
  bus.on('vm:disconnected', () => events.push('disconnected'))
  bus.on('vm:connected', (payload) => events.push(payload.reconnecting ? 'reconnected' : 'connected'))

  await vm.connect({ runId: 'run-12', wsUri: server.uri })
  assert.equal(server.connections.length, 1)
  const firstSocket = server.connections[0]
  firstSocket.close() // simulate the app dying / VM service restarting

  await sleep(400)
  assert.equal(events.includes('disconnected'), true)
  assert.equal(events.includes('reconnected'), true)
  assert.ok(server.connections.length >= 2, 'a second connection was opened')
  assert.equal(vm.isConnected(), true)
  const getVmCalls = server.getRequests('getVM').length
  assert.ok(getVmCalls >= 2, 'getVM is re-run on reconnect')

  await vm.disconnect({ runId: 'run-12' })
  const connectionsAfterDisconnect = server.connections.length
  await sleep(250)
  assert.equal(server.connections.length, connectionsAfterDisconnect, 'no reconnect after an explicit disconnect')
  assert.equal(vm.isConnected(), false)
})

test('dumpApp, evaluateExtension and stale-isolate Sentinel retry', async () => {
  let isolateGeneration = 1
  const server = await startFakeVm({
    responder: createResponder({
      'ext.flutter.debugDumpApp': () => ({
        result: { type: '_extensionType', method: 'ext.flutter.debugDumpApp', data: 'WidgetsFlutterBinding - DEBUG MODE\n[root]\n└View(state: _ViewState#87a13)' },
      }),
      'ext.flutter.isWidgetTreeReady': () => ({ result: { type: '_extensionType', result: true } }),
      // First call with the old isolate id returns the Sentinel the VM sends
      // after a hot restart; the refreshed call succeeds.
      'ext.flutter.didSendFirstFrameEvent': (params) => {
        if (String(params.isolateId) === 'isolates/1') {
          return { result: { type: 'Sentinel', kind: 'Collected', valueAsString: '<collected>' } }
        }
        return { result: { type: '_extensionType', result: 'true' } }
      },
      getVM: () => {
        const vm = vmObject()
        vm.isolates[0].id = `isolates/${isolateGeneration}`
        vm.isolates[0].name = 'main'
        return { result: vm }
      },
    }),
  })
  const { vm } = makeServices()
  await vm.connect({ runId: 'run-13', wsUri: server.uri })

  const tree = await vm.dumpApp({ runId: 'run-13' })
  assert.match(tree, /^WidgetsFlutterBinding/)
  assert.match(tree, /\[root\]/)

  const ready = await vm.evaluateExtension({ method: 'ext.flutter.isWidgetTreeReady' })
  assert.equal(ready, true, 'inspector payloads are unwrapped from `result`')

  // Hot restart: the isolate id changes and the old one returns a Sentinel.
  isolateGeneration = 2
  const value = await vm.evaluateExtension({ method: 'ext.flutter.didSendFirstFrameEvent' })
  assert.equal(value, 'true')
  assert.equal(vm.isolateId(), 'isolates/2', 'the client refreshed getVM and used the new isolate')

  await assert.rejects(
    () => vm.evaluateExtension({ method: 'notARealExtension' }),
    (error) => {
      assert.equal(error.code, 'rpc-error')
      assert.equal(error.rpcCode, -32601)
      return true
    },
  )
  await vm.disconnect()
})

test('disconnect rejects pending calls instead of leaving them hanging', async () => {
  const server = await startFakeVm({ responder: createResponder({ slow: () => undefined }) })
  const { vm } = makeServices()
  await vm.connect({ runId: 'run-14', wsUri: server.uri })
  const pending = vm.call('slow', {}, { timeoutMs: 5000 })
  await sleep(50)
  await vm.disconnect()
  await assert.rejects(
    () => pending,
    (error) => {
      assert.equal(error.code, 'disconnected')
      return true
    },
  )
})