/**
 * Unit tests for host/network.js — the HTTP profile request store.
 *
 * The VM service is a plain fake object (no WebSocket, no Flutter): each test
 * controls exactly which profile pages come back, which lets us assert dedupe,
 * the ring bound, the cursor and every query filter deterministically.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createNetworkStore } from '../host/network.js'
import { createLogStore } from '../host/logs.js'
import { createBus, sleep } from '../host/util.js'

function netEntry(id, overrides = {}) {
  return {
    id: String(id),
    runId: 'run-1',
    isolateId: 'isolates/1',
    at: 1795022504977,
    method: 'GET',
    uri: `http://127.0.0.1:8080/api/items/${id}`,
    host: '127.0.0.1:8080',
    path: `/api/items/${id}`,
    status: 200,
    requestBytes: 0,
    responseBytes: null,
    startMicros: 1795022504976550,
    endMicros: 1795022504986048,
    durationMs: 9.5,
    requestHeaders: { 'user-agent': ['Dart/3.10 (dart:io)'], host: ['127.0.0.1:8080'] },
    responseHeaders: { 'content-type': ['application/json'] },
    error: null,
    contentPreview: 'application/json',
    complete: true,
    ...overrides,
  }
}

/** Fake VM service: `pages` is a queue of httpProfile() results. */
function fakeVm(pages = []) {
  const calls = []
  const detailCalls = []
  const state = { pages: [...pages], detail: null, connected: true, throwOnProfile: null }
  return {
    calls,
    detailCalls,
    state,
    isConnected: () => state.connected,
    async httpProfile(params = {}) {
      calls.push(params)
      if (state.throwOnProfile !== null) throw state.throwOnProfile
      const page = state.pages.length > 1 ? state.pages.shift() : state.pages[0]
      if (page === undefined) return { ok: true, entries: [], nextSinceId: '0' }
      if (typeof page === 'function') return page(params)
      return page
    },
    async httpRequestDetail(params = {}) {
      detailCalls.push(params)
      if (state.detail !== null) return state.detail(params)
      return {
        ok: true,
        id: String(params.requestId),
        requestHeaders: { 'content-type': ['application/json'] },
        responseHeaders: { 'content-type': ['application/json'], 'x-probe': ['yes'] },
        requestBody: '{"hello":"world"}',
        responseBody: '{"ok":true}',
        requestBodyEncoding: 'utf8',
        responseBodyEncoding: 'utf8',
        requestBodyBytes: 17,
        responseBodyBytes: 11,
        requestBodyTruncated: false,
        responseBodyTruncated: false,
        truncated: false,
        status: 200,
        complete: true,
        durationMs: 9.5,
      }
    },
  }
}

test('refresh dedupes by request id and advances the cursor', async () => {
  const vm = fakeVm([
    {
      ok: true,
      method: 'ext.dart.io.getHttpProfile',
      entries: [netEntry(1), netEntry(2, { status: 404, uri: 'http://127.0.0.1:8080/api/missing' })],
      nextSinceId: '100',
    },
    // Second pull repeats request 1 (now complete) and adds request 3.
    {
      ok: true,
      method: 'ext.dart.io.getHttpProfile',
      entries: [netEntry(1, { responseBytes: 42, durationMs: 12.5 }), netEntry(3, { status: 500 })],
      nextSinceId: '200',
    },
  ])
  const { logs } = { logs: createLogStore({ capacity: 100 }) }
  const net = createNetworkStore({ vm, logs, capacity: 100 })

  const first = await net.refresh({ runId: 'run-1' })
  assert.equal(first.ok, true)
  assert.equal(first.added, 2)
  assert.equal(net.size(), 2)

  const second = await net.refresh({ runId: 'run-1' })
  assert.equal(second.added, 1, 'the repeated request id is an update, not a new row')
  assert.equal(net.size(), 3)
  assert.equal(vm.calls[1].sinceId, '100', 'the previous profile timestamp is forwarded as the cursor')

  const rows = net.query({}).entries
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map((row) => row.id), ['1', '2', '3'], 'chronological order')
  const updated = rows.find((row) => row.id === '1')
  assert.equal(updated.responseBytes, 42, 'the re-reported row is updated in place')
  assert.equal(updated.durationMs, 12.5)

  // Failures are logged with the network source and the right level.
  const networkLogs = logs.query({ source: 'network' }).entries
  assert.equal(networkLogs.length, 2)
  assert.deepEqual(networkLogs.map((entry) => entry.level), ['warn', 'error'])
  assert.match(networkLogs[0].text, /404/)
  net.dispose()
})

test('keeps a bounded ring, dropping the oldest entries first', async () => {
  const vm = fakeVm([
    {
      ok: true,
      entries: [netEntry(1), netEntry(2), netEntry(3), netEntry(4)],
      nextSinceId: '10',
    },
  ])
  const net = createNetworkStore({ vm, capacity: 100 })
  await net.refresh({})
  assert.equal(net.size(), 4)
  assert.ok(net.capacity >= 100, 'capacity is clamped to a sane minimum')

  // Force a small ring by re-creating with the minimum and more entries.
  const many = Array.from({ length: 160 }, (_, index) => netEntry(index + 1))
  const vm2 = fakeVm([{ ok: true, entries: many, nextSinceId: '20' }])
  const small = createNetworkStore({ vm: vm2, capacity: 100 })
  await small.refresh({})
  assert.equal(small.size(), 100, 'ring never exceeds capacity')
  const kept = small.query({ limit: 200 }).entries
  assert.equal(kept[0].id, '61', 'oldest 60 rows were dropped')
  assert.equal(kept[kept.length - 1].id, '160')
  small.dispose()
  net.dispose()
})

test('query applies status ranges, error, method, pattern, host and cursor filters', async () => {
  const entries = [
    netEntry(1, { status: 200, method: 'GET' }),
    netEntry(2, { status: 301, method: 'GET', uri: 'http://127.0.0.1:8080/redirect' }),
    netEntry(3, { status: 401, method: 'POST', uri: 'http://127.0.0.1:8080/api/login', host: '127.0.0.1:8080' }),
    netEntry(4, { status: 503, method: 'GET', uri: 'http://api.example.com:9000/health', host: 'api.example.com:9000' }),
    netEntry(5, { status: null, error: 'SocketException: Connection refused', uri: 'http://127.0.0.1:9/dead' }),
    netEntry(6, { status: 404, uri: 'http://127.0.0.1:8080/api/items/404' }),
  ]
  const vm = fakeVm([{ ok: true, entries, nextSinceId: '99' }])
  const net = createNetworkStore({ vm })
  await net.refresh({ runId: 'run-1' })

  const all = net.query({})
  assert.equal(all.total, 6)
  assert.equal(all.entries.length, 6)
  assert.equal(all.nextCursor, 6)

  assert.deepEqual(net.query({ status: '2xx' }).entries.map((e) => e.id), ['1'])
  assert.deepEqual(net.query({ status: '3xx' }).entries.map((e) => e.id), ['2'])
  assert.deepEqual(net.query({ status: '4xx' }).entries.map((e) => e.id), ['3', '6'])
  assert.deepEqual(net.query({ status: '5xx' }).entries.map((e) => e.id), ['4'])
  assert.deepEqual(net.query({ status: 'error' }).entries.map((e) => e.id), ['3', '4', '5', '6'])
  assert.deepEqual(net.query({ errorsOnly: true }).entries.map((e) => e.id), ['3', '4', '5', '6'])
  assert.deepEqual(net.query({ status: '404' }).entries.map((e) => e.id), ['6'], 'exact status works too')
  assert.deepEqual(net.query({ method: 'post' }).entries.map((e) => e.id), ['3'])
  assert.deepEqual(net.query({ host: 'api.example' }).entries.map((e) => e.id), ['4'])
  assert.deepEqual(net.query({ pattern: 'login|dead' }).entries.map((e) => e.id), ['3', '5'])
  assert.deepEqual(net.query({ limit: 2 }).entries.map((e) => e.id), ['5', '6'], 'limit returns the newest rows')

  // Cursor: only rows newer than `since`.
  const cursor = all.nextCursor
  const delta = net.query({ since: cursor - 2 })
  assert.deepEqual(delta.entries.map((e) => e.id), ['5', '6'])
  assert.equal(delta.nextCursor, 6)

  // runId filter
  assert.equal(net.query({ runId: 'run-1' }).entries.length, 6)
  assert.equal(net.query({ runId: 'other' }).entries.length, 0)

  const counts = net.counts()
  assert.equal(counts.total, 6)
  assert.equal(counts.byStatusClass['2xx'], 1)
  assert.equal(counts.byStatusClass['5xx'], 1)
  assert.equal(counts.failures, 4)
  net.dispose()
})

test('detail merges headers and bodies and surfaces truncation explicitly', async () => {
  const vm = fakeVm([{ ok: true, entries: [netEntry(7, { requestBytes: 0, responseBytes: null })], nextSinceId: '5' }])
  vm.state.detail = (params) => ({
    ok: true,
    id: params.requestId,
    requestHeaders: { 'content-type': ['application/json'] },
    responseHeaders: { 'content-type': ['application/json'], 'x-probe': ['yes'] },
    requestBody: '{"hello":"world"}',
    responseBody: '{"ok":true}',
    requestBodyEncoding: 'utf8',
    responseBodyEncoding: 'utf8',
    requestBodyBytes: 17,
    responseBodyBytes: 11,
    requestBodyTruncated: false,
    responseBodyTruncated: true,
    truncated: true,
    maxBodyBytes: 8,
    status: 200,
    complete: true,
    durationMs: 9.5,
  })
  const net = createNetworkStore({ vm })
  await net.refresh({ runId: 'run-1' })

  const detail = await net.detail({ id: '7' })
  assert.equal(detail.id, '7')
  assert.equal(detail.requestBody, '{"hello":"world"}')
  assert.equal(detail.responseBody, '{"ok":true}')
  assert.equal(detail.truncated, true, 'aggregate truncation flag')
  assert.equal(detail.responseBodyTruncated, true, 'per-body truncation flag')
  assert.equal(detail.requestBodyTruncated, false)
  assert.equal(detail.requestHeaders['content-type'][0], 'application/json')
  assert.equal(detail.responseHeaders['x-probe'][0], 'yes')
  assert.equal(detail.runId, 'run-1')
  assert.equal(detail.host, '127.0.0.1:8080')
  assert.equal(detail.path, '/api/items/7')
  assert.equal(vm.detailCalls.length, 1)
  assert.equal(vm.detailCalls[0].requestId, '7')
  assert.equal(vm.detailCalls[0].isolateId, 'isolates/1', 'the isolate that produced the request is used')

  // The row learned the real byte counts and completion state.
  const row = net.query({}).entries[0]
  assert.equal(row.requestBytes, 17)
  assert.equal(row.responseBytes, 11)

  await assert.rejects(
    () => net.detail({ id: 'does-not-exist' }),
    (error) => {
      assert.equal(error.code, 'not-found')
      return true
    },
  )
  await assert.rejects(
    () => net.detail({}),
    (error) => {
      assert.equal(error.code, 'bad-request')
      return true
    },
  )
  net.dispose()
})

test('detail failure keeps its code and does not corrupt the row', async () => {
  const vm = fakeVm([{ ok: true, entries: [netEntry(8)], nextSinceId: '6' }])
  vm.state.detail = () => {
    throw Object.assign(new Error("Unable to find request with id: '8'"), { code: 'rpc-error', rpcCode: 50 })
  }
  const net = createNetworkStore({ vm })
  await net.refresh({})
  await assert.rejects(
    () => net.detail({ id: '8' }),
    (error) => {
      assert.equal(error.code, 'rpc-error')
      assert.match(error.message, /Unable to find request/)
      return true
    },
  )
  assert.equal(net.query({}).entries.length, 1)
  net.dispose()
})

test('auto refresh pulls while connected and stops on vm:disconnected / run:state', async () => {
  const bus = createBus()
  let counter = 0
  const vm = fakeVm([
    (params) => {
      counter += 1
      return { ok: true, entries: [netEntry(counter)], nextSinceId: String(counter) }
    },
  ])
  vm.state.pages = [() => ({ ok: true, entries: [netEntry(++counter)], nextSinceId: String(counter) })]
  const net = createNetworkStore({ vm, bus, settings: { get: () => ({ networkAutoRefreshMs: 250 }) } })

  net.startAutoRefresh({ intervalMs: 250 })
  await sleep(700)
  const pulls = vm.calls.length
  assert.ok(pulls >= 3, `expected several automatic pulls, got ${pulls}`)
  assert.ok(net.size() >= 1)

  bus.emit('vm:disconnected', { runId: 'run-1' })
  await sleep(60)
  const afterDisconnect = vm.calls.length
  await sleep(300)
  assert.equal(vm.calls.length, afterDisconnect, 'no pulls after vm:disconnected')

  // run:state stopped also stops the timer.
  net.startAutoRefresh({ intervalMs: 250 })
  await sleep(300)
  bus.emit('run:state', { runId: 'run-1', phase: 'stopped' })
  await sleep(50)
  const afterStop = vm.calls.length
  await sleep(300)
  assert.equal(vm.calls.length, afterStop)
  net.dispose()
})

test('refresh reports failures without throwing and honours the concurrency guard', async () => {
  const vm = fakeVm([])
  vm.state.throwOnProfile = Object.assign(new Error('socket closed'), { code: 'disconnected' })
  const net = createNetworkStore({ vm })
  const result = await net.refresh({})
  assert.equal(result.ok, false)
  assert.equal(result.added, 0)
  assert.equal(result.error.code, 'disconnected')
  assert.equal(net.lastError().code, 'disconnected')

  // Second call while one is in flight is skipped instead of piling up.
  const slowVm = fakeVm([
    () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, entries: [netEntry(1)], nextSinceId: '1' }), 60)),
  ])
  const slow = createNetworkStore({ vm: slowVm })
  const inFlight = slow.refresh({})
  const skipped = await slow.refresh({})
  assert.equal(skipped.skipped, true)
  assert.equal(skipped.error.code, 'in-flight')
  const finished = await inFlight
  assert.equal(finished.ok, true)
  assert.equal(finished.added, 1)

  // A VM that is not there at all is handled, not crashed.
  const empty = createNetworkStore({ vm: null })
  const none = await empty.refresh({})
  assert.equal(none.error.code, 'no-vm')
  empty.dispose()

  net.dispose()
  slow.dispose()
})

test('clear resets rows but keeps the cursor monotonic', async () => {
  const vm = fakeVm([{ ok: true, entries: [netEntry(1), netEntry(2)], nextSinceId: '3' }])
  const net = createNetworkStore({ vm })
  await net.refresh({})
  const cursor = net.query({}).nextCursor
  net.clear()
  assert.equal(net.size(), 0)
  assert.equal(net.query({}).entries.length, 0)
  assert.equal(net.query({}).nextCursor, cursor, 'a client that missed the clear still sees a forward cursor')
  net.dispose()
})

test('an in-flight request is stored but not reported as a failure', async () => {
  const vm = fakeVm([
    {
      ok: true,
      entries: [
        netEntry(1, { complete: false, status: null, endMicros: null, durationMs: null, error: null }),
        netEntry(2, { status: 502 }),
      ],
      nextSinceId: '9',
    },
  ])
  const logs = createLogStore({ capacity: 50 })
  const net = createNetworkStore({ vm, logs })
  await net.refresh({})
  assert.equal(net.size(), 2, 'both rows are stored')
  const networkLogs = logs.query({ source: 'network' }).entries
  assert.equal(networkLogs.length, 1, 'only the completed 502 is logged')
  assert.equal(networkLogs[0].level, 'error')
  assert.match(networkLogs[0].text, /502/)
  net.dispose()
})

test('vm:connected starts the timer and dispose stops everything', async () => {
  const bus = createBus()
  let counter = 0
  const vm = fakeVm([])
  vm.state.pages = [() => ({ ok: true, entries: [netEntry(++counter)], nextSinceId: String(counter) })]
  const net = createNetworkStore({ vm, bus, settings: { get: () => ({ networkAutoRefreshMs: 250 }) } })
  bus.emit('vm:connected', { runId: 'run-1' })
  await sleep(620)
  assert.ok(vm.calls.length >= 2, 'the connection event started the timer')
  net.dispose()
  const afterDispose = vm.calls.length
  await sleep(300)
  assert.equal(vm.calls.length, afterDispose, 'dispose cleared the timer')
})