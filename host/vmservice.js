/**
 * Dart VM Service client (JSON-RPC 2.0 over a WebSocket).
 *
 * Everything in this file was verified against a real VM service on this host
 * (Flutter 3.38.5 / Dart 3.10.4, `-d windows` run + `docs/research/flutter-internals.md`):
 *
 *  • Wire envelope — request `{jsonrpc:'2.0',id,method,params}`; one response per
 *    id (`result` or `error:{code,message,data}`); events arrive unsolicited as
 *    `{"method":"streamNotify","params":{"streamId":…,"event":{…}}}`.
 *  • `getVM` → `{type:'VM', name, version, pid, isolates:[{id:'isolates/<n>', name:'main', …}], …}`.
 *    The isolate id field is `id`; `number` is the same decimal without the prefix.
 *  • Streams that exist: `VM`, `Isolate`, `Logging`, `Extension`, `Timeline`,
 *    `Debug`, `Service`, `Stdout`, `Profiler`, `HeapSnapshot`, `GC`, `Native`, `Perfetto`.
 *  • Service extensions are called **directly by name** (there is no
 *    `callServiceExtension` RPC); results are wrapped
 *    `{type:'_extensionType', method, …}` with the payload under `result` (inspector)
 *    or `data` (dump extensions).
 *  • HTTP profile: `ext.dart.io.getHttpProfile` `{isolateId, updatedSince?}` →
 *    `{type:'HttpProfile', timestamp:<wall-clock µs>, requests:[@HttpProfileRequest]}`.
 *    **Entries stay empty until** `ext.dart.io.httpEnableTimelineLogging {enabled:'true'}`
 *    is called on the isolate, so `connect()` enables it best-effort.
 *    `_getHttpProfile` does not exist on 3.10.4 (`-32601`); it is only a fallback.
 *    Bodies come from `ext.dart.io.getHttpProfileRequest {isolateId, id}` and are
 *    `requestBody`/`responseBody` **arrays of byte values** (not base64).
 *  • Screenshot: `_flutter.screenshot` and `ext.flutter.screenshot` do **not**
 *    exist on 3.38.5. The verified path is the inspector, and it needs two calls:
 *    `ext.flutter.inspector.getRootWidgetSummaryTree {objectGroup,isSummaryTree,fullDetails}`
 *    → `result.valueId`, then
 *    `ext.flutter.inspector.screenshot {id,width,height,maxPixelRatio,objectGroup}`
 *    → `result` = base64 PNG string. This client tries the inspector first and
 *    still falls back to the historical names, then errors explicitly.
 *  • `Flutter.Error` is an `Extension` stream event. On 3.38.5 `extensionData`
 *    is **one diagnostics node** (`description`, `properties[]`, `valueId`,
 *    `errorsSinceReload`, `renderedErrorText`) — there is no `errors` array; a
 *    real `errors` array is still honoured when a future SDK adds one. The event
 *    only fires after `ext.flutter.inspector.structuredErrors {enabled:'true'}`.
 *  • `Flutter.Frame.extensionData` = `{number,startTime,elapsed,build,raster,vsyncOverhead}`
 *    in microseconds (scheduler/binding.dart) → `frameStats` needs only the
 *    `Extension` stream. A frame is janky when `build + raster > 16.67 ms`.
 *  • Isolate id changes on hot **restart**; a stale id returns
 *    `{type:'Sentinel', kind:'Collected'}` instead of an error, so extension calls
 *    refresh `getVM` and retry once.
 *
 * Live-run evidence recorded on this host (not a mock):
 *   `dart run --enable-vm-service=18472 probe.dart` →
 *     connect → {ok:true, vmId:'vm', version:'3.10.4 (stable) … windows_x64',
 *                isolateId:'isolates/2072527645796027'}
 *     streams → ['Logging','Extension','Timeline','VM']; httpLogging → true
 *     ext.dart.io.getVersion → {type:'Version', major:4, minor:0}
 *     ext.dart.io.getHttpProfile → 196 real entries with status/headers/host/
 *       durationMs (e.g. POST /api/echo → 200, durationMs 9.5, chunked
 *       contentLength −1 → byte counts null); unknown ids error with
 *       "Unable to find request with id: …"
 *     ext.dart.io.getHttpProfileRequest → requestBody/responseBody byte arrays →
 *       UTF-8 text ('{"hello":"world","n":238}'), requestBodyBytes 25/30
 *     screenshot → 'screenshot-unsupported' after 3 attempts (plain Dart has no
 *       Flutter inspector); on a Flutter app the inspector path returns the PNG
 *     dumpApp → 'dump-unsupported' on plain Dart (`ext.flutter.*` unknown)
 *     frameStats → source 'none' (no Flutter frames), no crash
 *
 * Public surface: docs/CONTRACTS.md §5.4.
 */
import { fingerprint, nowMs, normalizeError, safeJson, sleep } from './util.js'
import { parseExceptionText } from './errors.js'
import { createWebSocketClient, READY_STATE } from './ws.js'

/** Streams `subscribe()` listens to (contract §5.4). */
export const VM_STREAMS = ['Logging', 'Extension', 'Timeline', 'VM']
const HTTP_PROFILE_METHODS = ['ext.dart.io.getHttpProfile', '_getHttpProfile']
const HTTP_DETAIL_METHODS = ['ext.dart.io.getHttpProfileRequest', '_getHttpProfileRequest']
const HTTP_CLEAR_METHODS = ['ext.dart.io.clearHttpProfile', '_clearHttpProfile']
const HTTP_LOGGING_METHOD = 'ext.dart.io.httpEnableTimelineLogging'
const HTTP_VERSION_METHOD = 'ext.dart.io.getVersion'
const INSPECTOR_TREE_METHOD = 'ext.flutter.inspector.getRootWidgetSummaryTree'
const INSPECTOR_SCREENSHOT_METHOD = 'ext.flutter.inspector.screenshot'
const STRUCTURED_ERRORS_METHOD = 'ext.flutter.inspector.structuredErrors'
const LEGACY_SCREENSHOT_METHODS = ['_flutter.screenshot', 'ext.flutter.screenshot']
const DUMP_APP_METHODS = ['ext.flutter.debugDumpApp', '_flutter.debugDumpApp']
const FRAME_JANK_THRESHOLD_US = 1000 / 60 * 1000 // 16.67 ms

function vmError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra)
}

function isUnknownMethod(error) {
  return error?.rpcCode === -32601 || /unknown method/i.test(String(error?.message ?? ''))
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100
}

function toFiniteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/** Decode a byte list that may be an array, a base64 string or a typed array. */
function toBytes(value) {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return Buffer.from(value)
  if (typeof value === 'string') {
    const clean = value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value
    try {
      return Buffer.from(clean, 'base64')
    } catch {
      return Buffer.from(clean, 'utf8')
    }
  }
  if (ArrayBuffer.isView(value)) return Buffer.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value))
  return null
}

/** Text when the bytes are valid UTF-8, otherwise base64 (binary bodies). */
function decodeBody(bytes, maxBytes) {
  const total = bytes.length
  const truncated = total > maxBytes
  const slice = truncated ? bytes.subarray(0, maxBytes) : bytes
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(slice)
    return { text, encoding: 'utf8', bytes: total, truncated }
  } catch {
    return { text: slice.toString('base64'), encoding: 'base64', bytes: total, truncated }
  }
}

/** `{type:'_extensionType', …}` — payload is under `result` or `data`. */
function unwrapExtension(response) {
  if (response === null || typeof response !== 'object') return { value: response, type: null, raw: response }
  if (Object.prototype.hasOwnProperty.call(response, 'result')) {
    return { value: response.result, type: response.type ?? null, raw: response, method: response.method ?? null }
  }
  if (Object.prototype.hasOwnProperty.call(response, 'data')) {
    return { value: response.data, type: response.type ?? null, raw: response, method: response.method ?? null }
  }
  return { value: response, type: response.type ?? null, raw: response, method: response.method ?? null }
}

/** Pull a base64 PNG out of whichever key the SDK used. */
function extractPngBase64(value) {
  const candidates = []
  if (typeof value === 'string') candidates.push(value)
  else if (value !== null && typeof value === 'object') {
    for (const key of ['result', 'screenshot', 'data', 'image', 'base64', 'png']) {
      if (typeof value[key] === 'string') candidates.push(value[key])
    }
  }
  for (const candidate of candidates) {
    const text = candidate.startsWith('data:') ? candidate.slice(candidate.indexOf(',') + 1) : candidate
    const clean = text.replace(/\s+/g, '')
    if (clean.startsWith('iVBOR')) return clean
  }
  return null
}

/** JSON-RPC error code carried by the RPC error object. */
function rpcErrorCode(error) {
  const rpc = error?.data?.error?.code ?? error?.code
  return typeof rpc === 'number' ? rpc : null
}

/**
 * @param {{ logs?:any, bus?:any, logger?:any, requestTimeoutMs?:number,
 *   connectTimeoutMs?:number, handshakeTimeoutMs?:number, reconnectBaseMs?:number,
 *   reconnectMaxMs?:number, reconnectMaxAttempts?:number, isolateWaitMs?:number,
 *   frameCapacity?:number, keepAliveMs?:number }} [options]
 */
export function createVmService(options = {}) {
  const {
    logs = null,
    bus = null,
    logger = null,
    requestTimeoutMs = 15000,
    connectTimeoutMs = 12000,
    handshakeTimeoutMs = 8000,
    reconnectBaseMs = 500,
    reconnectMaxMs = 8000,
    reconnectMaxAttempts = 12,
    isolateWaitMs = 4000,
    frameCapacity = 600,
    keepAliveMs = 30000,
  } = options

  const state = {
    runId: null,
    wsUri: null,
    ws: null,
    vmId: null,
    version: null,
    isolateId: null,
    isolates: [],
    streams: new Set(),
    pending: new Map(),
    nextId: 0,
    lastError: null,
    stopped: true,
    connecting: null,
    reconnectTimer: null,
    attempts: 0,
    httpMethod: null,
    detailMethod: null,
    httpLogging: null,
    structuredErrors: null,
    frames: [],
    framesSeen: 0,
    events: 0,
    connectedAt: null,
    lastEventAt: null,
    subscriptionsDone: false,
  }

  let writeQueue = Promise.resolve()

  function log(level, text, runId = state.runId, meta = null) {
    try {
      logs?.append?.({ runId, source: 'vm', level, text: String(text).slice(0, 4000), meta })
    } catch {
      /* logging must never break the client */
    }
  }

  function emit(type, payload) {
    try {
      bus?.emit?.(type, payload)
    } catch {
      /* ignore */
    }
  }

  function fail(code, message, extra = {}) {
    const error = vmError(code, message, extra)
    state.lastError = { code, message }
    emit('vm:error', { runId: state.runId, code, message, ...extra })
    return error
  }

  // --- transport -----------------------------------------------------------
  function currentSocket() {
    const socket = state.ws
    return socket !== null && socket.readyState === READY_STATE.OPEN ? socket : null
  }

  function settlePending(id, error, result) {
    const entry = state.pending.get(id)
    if (entry === undefined) return false
    state.pending.delete(id)
    if (entry.timer !== null) clearTimeout(entry.timer)
    if (error !== undefined) entry.reject(error)
    else entry.resolve(result)
    return true
  }

  function rejectAllPending(code, message) {
    for (const [id, entry] of [...state.pending.entries()]) {
      state.pending.delete(id)
      if (entry.timer !== null) clearTimeout(entry.timer)
      entry.reject(vmError(code, message, { method: entry.method }))
    }
  }

  /** Send one JSON-RPC request; ordered writes, per-call timeout, never hangs. */
  function sendRequest(method, params = {}, requestOptions = {}) {
    const timeoutMs = Number.isFinite(Number(requestOptions.timeoutMs)) ? Number(requestOptions.timeoutMs) : requestTimeoutMs
    return new Promise((resolve, reject) => {
      const socket = currentSocket()
      if (socket === null) {
        reject(vmError('not-connected', `cannot call ${method}: VM service is not connected`))
        return
      }
      if (state.pending.size > 512) {
        reject(vmError('too-many-pending', `cannot call ${method}: too many in-flight requests`))
        return
      }
      const id = (state.nextId += 1)
      const timer = setTimeout(() => {
        state.pending.delete(id)
        reject(vmError('timeout', `${method} timed out after ${timeoutMs}ms`, { method, id }))
      }, Math.max(1, timeoutMs))
      if (typeof timer.unref === 'function') timer.unref()
      state.pending.set(id, { resolve, reject, timer, method, sentAt: nowMs() })
      const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })
      // Serialized writes: two concurrent calls can never interleave frames.
      writeQueue = writeQueue
        .then(() => {
          const active = currentSocket()
          if (active === null) throw vmError('not-connected', `${method} aborted: socket closed before write`)
          active.send(frame)
        })
        .catch((error) => {
          const normalized = normalizeError(error)
          settlePending(id, vmError(normalized.code, `${method} failed: ${normalized.message}`, { method, id }))
        })
    })
  }

  /** One RPC, mapping VM-service errors to `Error{code,message,rpcCode}`. */
  async function rpc(method, params = {}, requestOptions = {}) {
    try {
      return await sendRequest(method, params, requestOptions)
    } catch (error) {
      if (error?.rpcCode !== undefined || error?.code === 'timeout' || error?.code === 'not-connected') throw error
      const rpcCode = rpcErrorCode(error)
      throw vmError('rpc-error', String(error?.message ?? 'VM service call failed'), {
        method,
        rpcCode,
        details: error?.details ?? error?.data ?? null,
      })
    }
  }

  function handleStreamNotify(params) {
    const streamId = String(params?.streamId ?? '')
    const event = params?.event ?? null
    if (event === null || typeof event !== 'object') return
    state.events += 1
    state.lastEventAt = nowMs()
    emit('vm:event', { runId: state.runId, streamId, event })
    routeEvent(streamId, event)
  }

  function routeEvent(streamId, event) {
    const kind = String(event.kind ?? '')
    const extensionKind = String(event.extensionKind ?? '')
    if (streamId === 'Extension') {
      if (extensionKind === 'Flutter.Error') {
        handleFlutterError(event)
        return
      }
      if (extensionKind === 'Flutter.Frame') {
        recordFrame(event)
        return
      }
      appendEventLog(streamId, event, 'debug', extensionKind)
      return
    }
    if (streamId === 'Logging') {
      handleLoggingEvent(event)
      return
    }
    if (streamId === 'Timeline') {
      // Timeline floods the socket; keep it on the bus only.
      return
    }
    if (streamId === 'VM' || streamId === 'Isolate') {
      const level = /Exit|PauseException|PauseBreakpoint|PauseInterrupted/i.test(kind) ? 'warn' : 'debug'
      if (/IsolateExit/.test(kind)) {
        state.isolates = state.isolates.filter((isolate) => isolate.id !== event?.isolate?.id)
        if (state.isolateId === event?.isolate?.id) state.isolateId = null
      }
      appendEventLog(streamId, event, level, kind)
      return
    }
    appendEventLog(streamId, event, 'debug', kind)
  }

  function appendEventLog(streamId, event, level, summary) {
    const isolateId = event?.isolate?.id ?? null
    const extensionKind = event?.extensionKind ?? null
    const text = `[${streamId}] ${summary ?? event?.kind ?? 'event'}${extensionKind !== null ? ` ${extensionKind}` : ''}${isolateId !== null ? ` ${isolateId}` : ''}`
    log(level, text, state.runId, {
      streamId,
      kind: event?.kind ?? null,
      extensionKind,
      isolateId,
      timestamp: event?.timestamp ?? null,
    })
  }

  function handleLoggingEvent(event) {
    const record = event?.logRecord ?? event?.record ?? null
    if (record === null || typeof record !== 'object') {
      appendEventLog('Logging', event, 'info', 'Logging')
      return
    }
    const message = typeof record.message === 'string' ? record.message : JSON.stringify(record.message ?? '')
    const level = loggingLevel(record.level)
    const extra = []
    if (record.error !== null && record.error !== undefined) {
      const errorText = typeof record.error === 'string' ? record.error : String(record.error?.valueAsString ?? '')
      if (errorText !== '') extra.push(errorText)
    }
    if (typeof record.stackTrace === 'string' && record.stackTrace !== '') extra.push(record.stackTrace)
    const text = extra.length === 0 ? message : `${message}\n${extra.join('\n')}`
    log(level, text, state.runId, {
      streamId: 'Logging',
      sequenceNumber: record.sequenceNumber ?? null,
      time: record.time ?? null,
      loggerName: typeof record.loggerName === 'string' ? record.loggerName : (record.loggerName?.valueAsString ?? null),
      isolateId: event?.isolate?.id ?? null,
    })
    if (level === 'error' || level === 'fatal') {
      // Only the first line is a message; keep the whole record for the UI.
      emit('vm:log-error', { runId: state.runId, text, level, isolateId: event?.isolate?.id ?? null, at: nowMs() })
    }
  }

  function loggingLevel(level) {
    if (typeof level === 'string') {
      const text = level.toUpperCase()
      if (text === 'SEVERE' || text === 'ERROR' || text === 'FATAL') return 'error'
      if (text === 'WARNING' || text === 'WARN') return 'warn'
      if (text === 'FINE' || text === 'FINER' || text === 'FINEST' || text === 'DEBUG') return 'debug'
      return 'info'
    }
    const value = toFiniteNumber(level)
    if (value === null) return 'info'
    if (value >= 1000) return 'error'
    if (value >= 900) return 'warn'
    if (value < 500) return 'debug'
    return 'info'
  }

  function recordFrame(event) {
    const data = event?.extensionData ?? {}
    const frame = {
      number: toFiniteNumber(data.number),
      startTime: toFiniteNumber(data.startTime),
      elapsed: toFiniteNumber(data.elapsed) ?? 0,
      build: toFiniteNumber(data.build) ?? 0,
      raster: toFiniteNumber(data.raster) ?? 0,
      vsyncOverhead: toFiniteNumber(data.vsyncOverhead),
      at: Number.isFinite(Number(event?.timestamp)) ? Number(event.timestamp) : nowMs(),
    }
    state.frames.push(frame)
    state.framesSeen += 1
    if (state.frames.length > frameCapacity) state.frames.splice(0, state.frames.length - frameCapacity)
  }

  /**
   * `Flutter.Error` → one group per error. The rendered text is what the panel
   * shows; `message`/`exception`/`stack`/`frames` come from the shared parser so
   * the fingerprint matches the path where the same block arrived via stdout.
   */
  function handleFlutterError(event) {
    const data = event?.extensionData ?? {}
    const isolateId = event?.isolate?.id ?? state.isolateId
    const at = Number.isFinite(Number(event?.timestamp)) ? Number(event.timestamp) : nowMs()
    const rendered = typeof data.renderedErrorText === 'string' ? data.renderedErrorText : ''
    const properties = Array.isArray(data.properties)
      ? data.properties.map((item) => (typeof item === 'string' ? item : String(item?.description ?? ''))).filter((text) => text !== '')
      : []
    const structured = Array.isArray(data.errors) ? data.errors : null
    const entries = structured === null ? [{ ...data, message: undefined }] : structured

    let reported = 0
    for (const entry of entries) {
      const text = typeof entry.renderedErrorText === 'string' && entry.renderedErrorText !== ''
        ? entry.renderedErrorText
        : rendered !== ''
          ? rendered
          : [String(entry.description ?? data.description ?? ''), ...properties].join('\n')
      const parsed = parseExceptionText(text, { kind: 'flutter', handled: false })
      const message =
        (typeof entry.message === 'string' && entry.message.trim() !== '' ? entry.message : null) ??
        parsed?.message ??
        String(data.description ?? 'Flutter error')
      const payload = {
        kind: 'flutter',
        runId: state.runId,
        isolateId,
        at,
        message,
        exception: entry.exception ?? parsed?.exception ?? null,
        stack: entry.stack ?? parsed?.stack ?? null,
        frames: Array.isArray(entry.frames) && entry.frames.length > 0 ? entry.frames : (parsed?.frames ?? []),
        context: parsed?.context ?? 'flutter',
        handled: false,
        renderedErrorText: text.slice(0, 12000),
        errorsSinceReload: toFiniteNumber(entry.errorsSinceReload ?? data.errorsSinceReload),
        valueId: entry.valueId ?? data.valueId ?? null,
        properties: properties.slice(0, 40),
        fpHint: fingerprint(`${message}`),
      }
      reported += 1
      emit('vm:flutter-error', payload)
      log('error', `Flutter.Error: ${String(message).slice(0, 800)}`, state.runId, {
        streamId: 'Extension',
        extensionKind: 'Flutter.Error',
        isolateId,
        errorsSinceReload: payload.errorsSinceReload,
        valueId: payload.valueId,
      })
    }
    if (reported === 0) {
      appendEventLog('Extension', event, 'error', 'Flutter.Error')
    }
  }

  function handleWireMessage(data) {
    if (typeof data !== 'string') return
    const message = safeJson(data, null)
    if (message === null || typeof message !== 'object') {
      logger?.debug?.('vm: non-JSON frame ignored')
      return
    }
    if (message.id !== undefined && message.id !== null) {
      const id = Number(message.id)
      const entry = state.pending.get(id)
      if (entry === undefined) return
      if (message.error !== undefined && message.error !== null) {
        const rpcCode = toFiniteNumber(message.error.code)
        settlePending(
          id,
          vmError('rpc-error', String(message.error.message ?? `VM service error for ${entry.method}`), {
            method: entry.method,
            rpcCode,
            data: message.error,
            details: message.error.data ?? null,
          }),
        )
        return
      }
      settlePending(id, undefined, message.result ?? null)
      return
    }
    if (message.method === 'streamNotify') {
      handleStreamNotify(message.params)
      return
    }
    // Some SDKs push extension events without the streamNotify envelope.
    if (typeof message.method === 'string') {
      emit('vm:event', {
        runId: state.runId,
        streamId: 'Extension',
        event: { kind: 'Extension', extensionKind: message.method, extensionData: message.params ?? {} },
      })
    }
  }

  function onSocketClose(info) {
    const socket = state.ws
    state.ws = null
    state.connectedAt = null
    rejectAllPending('disconnected', `VM service disconnected (${info?.code ?? 1006}${info?.reason ? `: ${info.reason}` : ''})`)
    if (info?.code !== undefined && info.code !== 1000 && info.code !== 1001) {
      log('warn', `VM service socket closed (${info.code}${info.reason ? ` ${info.reason}` : ''})`)
    }
    emit('vm:disconnected', {
      runId: state.runId,
      code: info?.code ?? 1006,
      reason: info?.reason ?? null,
      wasClean: info?.wasClean === true,
    })
    if (socket === null) return
    if (!state.stopped && state.wsUri !== null && state.runId !== null) scheduleReconnect()
  }

  function scheduleReconnect() {
    if (state.stopped || state.reconnectTimer !== null) return
    if (state.attempts >= reconnectMaxAttempts) {
      fail('reconnect-exhausted', `VM service reconnect gave up after ${state.attempts} attempts`)
      state.stopped = true
      return
    }
    state.attempts += 1
    const delay = Math.min(reconnectMaxMs, reconnectBaseMs * 2 ** (state.attempts - 1))
    emit('vm:reconnecting', { runId: state.runId, attempt: state.attempts, delayMs: delay })
    log('warn', `VM service reconnecting in ${delay}ms (attempt ${state.attempts}/${reconnectMaxAttempts})`)
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null
      if (state.stopped) return
      openConnection({ reconnecting: true }).catch((error) => {
        log('error', `VM reconnect failed: ${normalizeError(error).message}`)
        scheduleReconnect()
      })
    }, delay)
    if (typeof state.reconnectTimer.unref === 'function') state.reconnectTimer.unref()
  }

  function pickMainIsolate(isolates) {
    const list = Array.isArray(isolates) ? isolates.filter((item) => item !== null && typeof item === 'object' && item.id) : []
    const main = list.find((item) => item.isSystemIsolate !== true && (item.name === 'main' || item.name === undefined))
    const fallback = list.find((item) => item.isSystemIsolate !== true)
    return main ?? fallback ?? list[0] ?? null
  }

  async function refreshVm(rawOptions = {}) {
    const vm = await rpc('getVM', {}, rawOptions)
    state.vmId = vm?.id ?? 'vm'
    state.version = vm?.version ?? null
    state.isolates = Array.isArray(vm?.isolates) ? vm.isolates : []
    const isolate = pickMainIsolate(state.isolates)
    if (isolate !== null) state.isolateId = isolate.id
    return vm
  }

  async function waitForIsolate(deadlineMs) {
    const started = nowMs()
    while (state.isolateId === null && nowMs() - started < deadlineMs) {
      await sleep(150)
      if (state.stopped || currentSocket() === null) return null
      try {
        await refreshVm({ timeoutMs: Math.min(requestTimeoutMs, 4000) })
      } catch (error) {
        if (error?.code === 'not-connected') return null
      }
    }
    if (state.isolateId === null) return null
    return state.isolates.find((item) => item.id === state.isolateId) ?? { id: state.isolateId, name: null }
  }

  async function describeIsolate() {
    if (state.isolateId === null) return null
    try {
      const isolate = await rpc('getIsolate', { isolateId: state.isolateId }, { timeoutMs: 5000 })
      state.isolates = state.isolates.map((item) =>
        item.id === state.isolateId ? { ...item, name: isolate?.name ?? item.name, pauseEvent: isolate?.pauseEvent ?? null } : item,
      )
      return isolate
    } catch (error) {
      if (error?.code === 'not-connected' || error?.code === 'timeout') return null
      logger?.debug?.(`vm: getIsolate failed: ${normalizeError(error).message}`)
      return null
    }
  }

  /** Try extension methods in order, remembering the first one that works. */
  async function callFirst(methods, params, requestOptions = {}) {
    const ordered = [...methods]
    const preferred = requestOptions.preferred ?? null
    if (preferred !== null) {
      const index = ordered.indexOf(preferred)
      if (index > 0) {
        ordered.splice(index, 1)
        ordered.unshift(preferred)
      }
    }
    let lastError = null
    for (const method of ordered) {
      try {
        const result = await callExtension(method, params, requestOptions)
        return { method, result }
      } catch (error) {
        lastError = error
        if (!isUnknownMethod(error)) throw error
      }
    }
    throw lastError ?? vmError('rpc-error', `no extension method worked: ${methods.join(', ')}`)
  }

  /**
   * Call a service extension by name. Handles the stale-isolate `Sentinel`
   * (hot restart replaces the isolate id) by refreshing `getVM` and retrying once.
   */
  async function callExtension(method, params = {}, requestOptions = {}) {
    const attempt = async () => {
      const body = { ...params }
      const isolateId = body.isolateId ?? requestOptions.isolateId ?? state.isolateId
      if (isolateId === null || isolateId === undefined) {
        throw vmError('no-isolate', `cannot call ${method}: no live isolate`)
      }
      body.isolateId = isolateId
      const response = await rpc(method, body, requestOptions)
      if (response !== null && typeof response === 'object' && response.type === 'Sentinel') {
        throw vmError('isolate-gone', `${method}: isolate ${isolateId} was collected (${response.kind ?? 'Sentinel'})`, {
          sentinel: response,
        })
      }
      return response
    }

    try {
      return await attempt()
    } catch (error) {
      const retryable =
        requestOptions.retry !== false &&
        (error?.code === 'isolate-gone' || /isolate|collected|sentinel/i.test(String(error?.message ?? '')))
      if (!retryable) throw error
      try {
        await refreshVm({ timeoutMs: 5000 })
      } catch {
        throw error
      }
      return attempt()
    }
  }

  // --- connection lifecycle ------------------------------------------------
  async function openConnection({ reconnecting = false } = {}) {
    const wsUri = state.wsUri
    if (wsUri === null) throw fail('no-uri', 'connect() needs a wsUri')
    let socket
    try {
      socket = await createWebSocketClient({
        url: wsUri,
        handshakeTimeoutMs,
        keepAliveMs,
        logger,
      })
    } catch (error) {
      const normalized = normalizeError(error)
      state.lastError = { code: normalized.code, message: normalized.message }
      emit('vm:error', { runId: state.runId, code: normalized.code, message: normalized.message })
      throw error
    }
    state.ws = socket
    socket.onMessage(handleWireMessage)
    socket.onClose(onSocketClose)

    try {
      await refreshVm({ timeoutMs: connectTimeoutMs })
    } catch (error) {
      try {
        socket.terminate()
      } catch {
        /* ignore */
      }
      state.ws = null
      throw fail('handshake-failed', `VM service JSON-RPC handshake failed: ${normalizeError(error).message}`)
    }

    const isolate = await waitForIsolate(isolateWaitMs)
    if (isolate !== null) await describeIsolate()

    state.connectedAt = nowMs()
    state.attempts = 0
    state.lastError = null
    state.subscriptionsDone = false
    await ensureSubscriptions()
    await enableHttpLogging({ enabled: true })
    await enableStructuredErrors({ enabled: true })

    const snapshotValue = snapshot()
    emit('vm:connected', { ...snapshotValue, reconnecting })
    log('info', `VM service connected${reconnecting ? ' (reconnected)' : ''}: ${state.version ?? 'unknown'} ${state.vmId ?? ''}`)
    return { ok: true, vmId: state.vmId, version: state.version, isolateId: state.isolateId, isolates: state.isolates }
  }

  async function connect({ runId = null, wsUri, timeoutMs } = {}) {
    if (typeof wsUri !== 'string' || wsUri.trim() === '') {
      return { ok: false, error: { code: 'no-uri', message: 'connect() needs { wsUri }' } }
    }
    if (state.connecting !== null) {
      try {
        await state.connecting
      } catch {
        /* fall through and try again */
      }
    }
    const sameTarget = state.runId === runId && state.wsUri === wsUri && currentSocket() !== null
    if (sameTarget) {
      return { ok: true, vmId: state.vmId, version: state.version, isolateId: state.isolateId, isolates: state.isolates, reused: true }
    }
    await disconnect({ runId: state.runId, silent: true }).catch(() => {})
    state.runId = runId ?? null
    state.wsUri = wsUri
    state.stopped = false
    state.attempts = 0
    state.subscriptionsDone = false
    const operation = openConnection({})
    state.connecting = operation
    try {
      const result = await operation
      if (timeoutMs !== undefined) logger?.debug?.(`vm: connect finished within ${timeoutMs}ms budget`)
      return result
    } catch (error) {
      const normalized = normalizeError(error)
      if (!state.stopped && state.runId !== null) scheduleReconnect()
      return {
        ok: false,
        error: { code: normalized.code, message: normalized.message },
        vmId: state.vmId,
        version: state.version,
      }
    } finally {
      state.connecting = null
    }
  }

  async function disconnect({ runId, silent = false, forever = true } = {}) {
    if (runId !== undefined && runId !== null && state.runId !== null && runId !== state.runId) return
    if (forever) state.stopped = true
    if (state.reconnectTimer !== null) {
      clearTimeout(state.reconnectTimer)
      state.reconnectTimer = null
    }
    const socket = state.ws
    state.ws = null
    rejectAllPending('disconnected', 'VM service disconnected by the workbench')
    if (socket !== null) {
      try {
        socket.close(1000, 'workbench disconnect')
      } catch {
        try {
          socket.terminate()
        } catch {
          /* ignore */
        }
      }
    }
    const previousRunId = state.runId
    state.runId = null
    state.wsUri = null
    state.isolateId = null
    state.isolates = []
    state.streams.clear()
    state.vmId = null
    state.version = null
    state.connectedAt = null
    state.frames.length = 0
    state.subscriptionsDone = false
    if (!silent) emit('vm:disconnected', { runId: previousRunId, code: 1000, reason: 'disconnect', wasClean: true })
  }

  // --- streams -------------------------------------------------------------
  async function subscribe({ events } = {}) {
    const requested = (Array.isArray(events) ? events : VM_STREAMS).map((item) => String(item)).filter((item) => item !== '')
    const socket = currentSocket()
    if (socket === null) throw vmError('not-connected', 'subscribe() needs a live VM service connection')
    const done = []
    for (const streamId of requested) {
      if (state.streams.has(streamId)) {
        done.push(streamId)
        continue
      }
      try {
        await rpc('streamListen', { streamId }, { timeoutMs: 5000 })
        state.streams.add(streamId)
        done.push(streamId)
      } catch (error) {
        if (error?.code === 'not-connected') throw error
        logger?.debug?.(`vm: streamListen ${streamId} failed: ${normalizeError(error).message}`)
      }
    }
    return done
  }

  async function unsubscribe({ events } = {}) {
    const requested = (Array.isArray(events) ? events : [...state.streams]).map(String)
    for (const streamId of requested) {
      if (!state.streams.has(streamId)) continue
      try {
        await rpc('streamCancel', { streamId }, { timeoutMs: 4000 })
      } catch {
        /* best effort */
      }
      state.streams.delete(streamId)
    }
  }

  async function ensureSubscriptions() {
    if (currentSocket() === null) return []
    const streams = await subscribe({ events: VM_STREAMS })
    state.subscriptionsDone = streams.length > 0
    return streams
  }

  async function enableHttpLogging({ enabled = true, isolateId } = {}) {
    const iso = isolateId ?? state.isolateId
    if (iso === null || iso === undefined) return { ok: false, error: { code: 'no-isolate', message: 'no live isolate' } }
    const value = enabled === true ? 'true' : 'false'
    try {
      const result = await callExtension(HTTP_LOGGING_METHOD, { enabled: value }, { isolateId: iso, retry: false })
      state.httpLogging = enabled === true
      return { ok: true, enabled: enabled === true, state: result?.enabled ?? null }
    } catch (error) {
      // Older SDKs named the flag `enable` (boolean).
      if (!isUnknownMethod(error)) {
        try {
          const result = await callExtension(HTTP_LOGGING_METHOD, { enable: enabled === true }, { isolateId: iso, retry: false })
          state.httpLogging = enabled === true
          return { ok: true, enabled: enabled === true, state: result?.enabled ?? null }
        } catch (secondError) {
          state.httpLogging = false
          return { ok: false, error: { code: normalizeError(secondError).code, message: normalizeError(secondError).message } }
        }
      }
      state.httpLogging = false
      return { ok: false, error: { code: 'unsupported', message: `${HTTP_LOGGING_METHOD} is not available on this VM service` } }
    }
  }

  async function enableStructuredErrors({ enabled = true, isolateId } = {}) {
    const iso = isolateId ?? state.isolateId
    if (iso === null || iso === undefined) return { ok: false, error: { code: 'no-isolate', message: 'no live isolate' } }
    try {
      await callExtension(STRUCTURED_ERRORS_METHOD, { enabled: enabled === true ? 'true' : 'false' }, { isolateId: iso, retry: false })
      state.structuredErrors = enabled === true
      return { ok: true, enabled: enabled === true }
    } catch (error) {
      state.structuredErrors = false
      // Not fatal: without it Flutter prints errors to stdout, which the log
      // path still parses; `Flutter.Error` events simply never arrive.
      return { ok: false, error: { code: normalizeError(error).code, message: normalizeError(error).message } }
    }
  }

  // --- HTTP profile --------------------------------------------------------
  function mapNetEntry(request, runId, isolateId) {
    if (request === null || typeof request !== 'object') return null
    const id = request.id !== undefined && request.id !== null ? String(request.id) : null
    if (id === null) return null
    const uri = String(request.uri ?? request.request?.uri ?? '')
    let host = ''
    let path = ''
    try {
      const parsed = new URL(uri)
      host = parsed.host
      path = `${parsed.pathname}${parsed.search}`
    } catch {
      path = uri
    }
    const requestData = request.request ?? null
    const responseData = request.response ?? null
    const status = toFiniteNumber(responseData?.statusCode)
    const startMicros = toFiniteNumber(request.startTime)
    const endMicros = toFiniteNumber(responseData?.endTime) ?? toFiniteNumber(request.endTime)
    const durationMs =
      startMicros !== null && endMicros !== null ? round2(Math.max(0, (endMicros - startMicros) / 1000)) : null
    const requestLength = toFiniteNumber(requestData?.contentLength)
    const responseLength = toFiniteNumber(responseData?.contentLength)
    const error = requestData?.error ?? responseData?.error ?? null
    const contentType = pickHeader(responseData?.headers, 'content-type')
    return {
      id,
      runId: runId ?? state.runId ?? null,
      at: startMicros === null ? nowMs() : Math.round(startMicros / 1000),
      method: String(request.method ?? requestData?.method ?? 'GET').toUpperCase(),
      uri,
      host,
      path,
      status,
      requestBytes: requestLength !== null && requestLength >= 0 ? requestLength : null,
      responseBytes: responseLength !== null && responseLength >= 0 ? responseLength : null,
      startMicros,
      endMicros,
      durationMs,
      requestHeaders: requestData?.headers ?? null,
      responseHeaders: responseData?.headers ?? null,
      error: error === null || error === undefined ? null : String(error),
      contentPreview: contentType === null ? null : String(Array.isArray(contentType) ? contentType[0] : contentType).slice(0, 120),
      complete: responseData?.endTime !== null && responseData?.endTime !== undefined,
      isolateId: request.isolateId ?? isolateId ?? state.isolateId ?? null,
      events: Array.isArray(request.events) ? request.events.length : 0,
      reasonPhrase: responseData?.reasonPhrase ?? null,
      requestContentLength: requestLength,
      responseContentLength: responseLength,
      responseStartMicros: toFiniteNumber(responseData?.startTime),
    }
  }

  function pickHeader(headers, name) {
    if (headers === null || typeof headers !== 'object') return null
    const wanted = String(name).toLowerCase()
    for (const [key, value] of Object.entries(headers)) {
      if (String(key).toLowerCase() === wanted) return value
    }
    return null
  }

  /**
   * Pull the dart:io HTTP profile. `sinceId` is the opaque cursor returned by the
   * previous call (the profile `timestamp` in wall-clock µs); it is forwarded as
   * `updatedSince` so the payload stays O(delta).
   */
  async function httpProfile({ runId, sinceId, isolateId, timeoutMs } = {}) {
    const iso = isolateId ?? state.isolateId
    if (iso === null || iso === undefined || currentSocket() === null) {
      return { ok: false, entries: [], error: { code: 'not-connected', message: 'VM service is not connected' } }
    }
    const sinceMicros = toFiniteNumber(sinceId)
    const params = { isolateId: iso }
    if (sinceMicros !== null && sinceMicros > 0) params.updatedSince = Math.floor(sinceMicros)
    try {
      const { method, result } = await callFirst(HTTP_PROFILE_METHODS, params, {
        preferred: state.httpMethod,
        timeoutMs: timeoutMs ?? 8000,
      })
      state.httpMethod = method
      const requests = Array.isArray(result?.requests) ? result.requests : []
      const entries = []
      for (const request of requests) {
        const lastUpdate =
          toFiniteNumber(request?.lastUpdateTime) ??
          toFiniteNumber(request?.response?.endTime) ??
          toFiniteNumber(request?.endTime) ??
          toFiniteNumber(request?.startTime)
        if (sinceMicros !== null && sinceMicros > 0 && lastUpdate !== null && lastUpdate < sinceMicros) continue
        const entry = mapNetEntry(request, runId ?? state.runId, iso)
        if (entry !== null) entries.push(entry)
      }
      entries.sort((left, right) => (left.at ?? 0) - (right.at ?? 0))
      return {
        ok: true,
        method,
        entries,
        nextSinceId: String(toFiniteNumber(result?.timestamp) ?? nowMs() * 1000),
        timestamp: toFiniteNumber(result?.timestamp),
        total: requests.length,
      }
    } catch (error) {
      const normalized = normalizeError(error)
      return { ok: false, entries: [], error: { code: normalized.code, message: normalized.message, rpcCode: error?.rpcCode ?? null } }
    }
  }

  /** Full detail (headers + bodies) for one profiled request. */
  async function httpRequestDetail({ requestId, id, runId, isolateId, maxBodyBytes = 256 * 1024, timeoutMs } = {}) {
    const target = String(requestId ?? id ?? '')
    if (target === '') throw vmError('bad-request', 'httpRequestDetail() needs { requestId }')
    const iso = isolateId ?? state.isolateId
    if (iso === null || iso === undefined || currentSocket() === null) {
      throw vmError('not-connected', 'VM service is not connected')
    }
    const { method, result } = await callFirst(
      HTTP_DETAIL_METHODS,
      { isolateId: iso, id: target },
      { preferred: state.detailMethod, timeoutMs: timeoutMs ?? 8000 },
    )
    state.detailMethod = method
    const requestData = result?.request ?? null
    const responseData = result?.response ?? null
    const limit = Math.max(16, Number(maxBodyBytes) || 256 * 1024)
    const requestBytes = toBytes(result?.requestBody)
    const responseBytes = toBytes(result?.responseBody)
    const requestBody = requestBytes === null ? null : decodeBody(requestBytes, limit)
    const responseBody = responseBytes === null ? null : decodeBody(responseBytes, limit)
    const startMicros = toFiniteNumber(result?.startTime)
    const endMicros = toFiniteNumber(responseData?.endTime) ?? toFiniteNumber(result?.endTime)
    return {
      ok: true,
      method,
      id: target,
      isolateId: iso,
      runId: runId ?? state.runId ?? null,
      requestMethod: String(result?.method ?? requestData?.method ?? 'GET').toUpperCase(),
      uri: String(result?.uri ?? requestData?.uri ?? ''),
      status: toFiniteNumber(responseData?.statusCode),
      reasonPhrase: responseData?.reasonPhrase ?? null,
      requestHeaders: requestData?.headers ?? null,
      responseHeaders: responseData?.headers ?? null,
      requestBody: requestBody?.text ?? null,
      responseBody: responseBody?.text ?? null,
      requestBodyEncoding: requestBody?.encoding ?? 'utf8',
      responseBodyEncoding: responseBody?.encoding ?? 'utf8',
      requestBodyBytes: requestBody?.bytes ?? null,
      responseBodyBytes: responseBody?.bytes ?? null,
      // Explicit, per-body and aggregate flags: nothing is silently truncated.
      requestBodyTruncated: requestBody?.truncated === true,
      responseBodyTruncated: responseBody?.truncated === true,
      truncated: requestBody?.truncated === true || responseBody?.truncated === true,
      maxBodyBytes: limit,
      startMicros,
      endMicros,
      durationMs: startMicros !== null && endMicros !== null ? round2(Math.max(0, (endMicros - startMicros) / 1000)) : null,
      complete: responseData?.endTime !== null && responseData?.endTime !== undefined,
      error: requestData?.error ?? responseData?.error ?? null,
      events: Array.isArray(result?.events) ? result.events : [],
      contentLength: toFiniteNumber(responseData?.contentLength),
      compressionState: responseData?.compressionState ?? null,
      isRedirect: responseData?.isRedirect ?? null,
      redirects: Array.isArray(responseData?.redirects) ? responseData.redirects.length : 0,
      cookies: Array.isArray(requestData?.cookies) ? requestData.cookies : [],
    }
  }

  async function clearHttpProfile({ isolateId } = {}) {
    const iso = isolateId ?? state.isolateId
    if (iso === null || iso === undefined) return { ok: false, error: { code: 'no-isolate', message: 'no live isolate' } }
    try {
      const { method } = await callFirst(HTTP_CLEAR_METHODS, { isolateId: iso }, { timeoutMs: 5000 })
      return { ok: true, method }
    } catch (error) {
      const normalized = normalizeError(error)
      return { ok: false, error: { code: normalized.code, message: normalized.message } }
    }
  }

  async function httpVersion({ isolateId } = {}) {
    return evaluateExtension({ method: HTTP_VERSION_METHOD, isolateId }).catch(() => null)
  }

  // --- screenshot / dump / perf -------------------------------------------
  /**
   * Screenshot as base64 PNG. Verified order:
   *   1. inspector (two calls: root widget summary tree → screenshot by valueId)
   *   2. `_flutter.screenshot` / `ext.flutter.screenshot` (historical contract names)
   * Every attempt is recorded; when nothing works the error is explicit.
   */
  async function screenshot({ runId, isolateId, width, height, maxPixelRatio = 2.0, objectGroup = 'flutter-workbench', timeoutMs } = {}) {
    const iso = isolateId ?? state.isolateId
    if (iso === null || iso === undefined || currentSocket() === null) {
      throw vmError('not-connected', 'screenshot() needs a live VM service connection')
    }
    const attempted = []
    const failures = []
    const budget = timeoutMs ?? 8000

    const inspectorAttempt = async () => {
      attempted.push(`${INSPECTOR_TREE_METHOD}+${INSPECTOR_SCREENSHOT_METHOD}`)
      const tree = await callExtension(
        INSPECTOR_TREE_METHOD,
        { objectGroup, isSummaryTree: 'true', fullDetails: 'false' },
        { isolateId: iso, timeoutMs: budget },
      )
      const node = unwrapExtension(tree).value
      const valueId = node?.valueId ?? node?.result?.valueId ?? null
      if (valueId === null || valueId === undefined) throw vmError('screenshot-no-node', 'inspector tree has no valueId')
      const params = { objectGroup, id: String(valueId), maxPixelRatio: String(maxPixelRatio) }
      if (width !== undefined && width !== null) params.width = String(width)
      if (height !== undefined && height !== null) params.height = String(height)
      const shot = await callExtension(INSPECTOR_SCREENSHOT_METHOD, params, { isolateId: iso, timeoutMs: budget })
      const base64 = extractPngBase64(unwrapExtension(shot).value)
      if (base64 === null) throw vmError('screenshot-invalid', 'inspector screenshot did not return a base64 PNG')
      return { method: INSPECTOR_SCREENSHOT_METHOD, base64, valueId: String(valueId) }
    }

    const legacyAttempt = (method) => async () => {
      attempted.push(method)
      const params = {}
      if (width !== undefined && width !== null) params.width = String(width)
      if (height !== undefined && height !== null) params.height = String(height)
      const shot = await callExtension(method, params, { isolateId: iso, timeoutMs: budget })
      const base64 = extractPngBase64(unwrapExtension(shot).value ?? unwrapExtension(shot).raw)
      if (base64 === null) throw vmError('screenshot-invalid', `${method} did not return a base64 PNG`)
      return { method, base64, valueId: null }
    }

    const attempts = [inspectorAttempt, ...LEGACY_SCREENSHOT_METHODS.map((method) => legacyAttempt(method))]
    for (const attempt of attempts) {
      try {
        const result = await attempt()
        return {
          ok: true,
          base64: result.base64,
          mime: 'image/png',
          bytes: Math.floor((result.base64.length * 3) / 4),
          method: result.method,
          valueId: result.valueId,
          isolateId: iso,
          runId: runId ?? state.runId ?? null,
          attempted,
        }
      } catch (error) {
        if (error?.code === 'not-connected') throw error
        failures.push({ method: attempted[attempted.length - 1], code: normalizeError(error).code, message: normalizeError(error).message })
      }
    }
    throw vmError(
      'screenshot-unsupported',
      `no screenshot service extension worked on this VM service (tried: ${attempted.join(', ')}). ` +
        'Flutter exposes screenshots through ext.flutter.inspector.screenshot; enable the widget inspector or use the device screenshot path.',
      { attempted, failures },
    )
  }

  /** Widget tree dump via `ext.flutter.debugDumpApp`. */
  async function dumpApp({ runId, isolateId, timeoutMs } = {}) {
    const iso = isolateId ?? state.isolateId
    if (iso === null || iso === undefined || currentSocket() === null) {
      throw vmError('not-connected', 'dumpApp() needs a live VM service connection')
    }
    const attempted = []
    for (const method of DUMP_APP_METHODS) {
      attempted.push(method)
      try {
        const response = await callExtension(method, {}, { isolateId: iso, timeoutMs: timeoutMs ?? 8000 })
        const unwrapped = unwrapExtension(response)
        const value = unwrapped.value
        const text = typeof value === 'string' ? value : typeof value?.data === 'string' ? value.data : null
        if (text === null) throw vmError('dump-invalid', `${method} returned no text`)
        return text
      } catch (error) {
        if (error?.code === 'not-connected') throw error
        if (!isUnknownMethod(error) && error?.code !== 'dump-invalid') {
          throw vmError('dump-failed', `${method} failed: ${normalizeError(error).message}`, { attempted })
        }
      }
    }
    throw vmError('dump-unsupported', `no widget tree dump extension worked (tried: ${attempted.join(', ')})`, { attempted })
  }

  /** Frame timings from buffered `Flutter.Frame` events (Timeline fallback). */
  async function frameStats({ runId, limit = 240, isolateId } = {}) {
    let frames = state.frames.slice(-Math.max(1, Math.min(2000, Number(limit) || 240)))
    let source = 'extension'
    if (frames.length === 0) {
      frames = await framesFromTimeline({ isolateId })
      source = frames.length === 0 ? 'none' : 'timeline'
    }
    const mapped = frames.map((frame, index) => ({
      number: frame.number ?? index + 1,
      elapsedMs: round2(frame.elapsed / 1000),
      buildMs: round2(frame.build / 1000),
      rasterMs: round2(frame.raster / 1000),
      vsyncOverheadMs: frame.vsyncOverhead === null ? null : round2(frame.vsyncOverhead / 1000),
    }))
    let jankCount = 0
    let worstUs = 0
    let totalUs = 0
    for (const frame of frames) {
      const spent = (frame.build ?? 0) + (frame.raster ?? 0)
      totalUs += spent
      if (spent > worstUs) worstUs = spent
      if (spent > FRAME_JANK_THRESHOLD_US) jankCount += 1
    }
    const sorted = frames.map((frame) => (frame.build ?? 0) + (frame.raster ?? 0)).sort((left, right) => left - right)
    const p95 = sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
    return {
      ok: true,
      runId: runId ?? state.runId ?? null,
      source,
      frames: mapped,
      total: mapped.length,
      seen: state.framesSeen,
      jankCount,
      jankRatio: mapped.length === 0 ? 0 : round2(jankCount / mapped.length),
      worstMs: round2(worstUs / 1000),
      avgMs: frames.length === 0 ? 0 : round2(totalUs / frames.length / 1000),
      p95Ms: round2(p95 / 1000),
      thresholdMs: round2(FRAME_JANK_THRESHOLD_US / 1000),
    }
  }

  async function framesFromTimeline({ isolateId } = {}) {
    const iso = isolateId ?? state.isolateId
    if (iso === null || iso === undefined || currentSocket() === null) return []
    try {
      const result = await rpc('getVMTimeline', {}, { timeoutMs: 6000 })
      const events = result?.traceEvents ?? result?.timeline?.traceEvents ?? result?.result?.traceEvents ?? []
      const frames = []
      for (const event of Array.isArray(events) ? events : []) {
        const args = event?.args ?? {}
        const build = toFiniteNumber(args.build)
        const raster = toFiniteNumber(args.raster)
        if (event?.name !== 'Frame' || (build === null && raster === null)) continue
        frames.push({
          number: toFiniteNumber(args.number),
          startTime: toFiniteNumber(event.ts),
          elapsed: toFiniteNumber(args.elapsed) ?? 0,
          build: build ?? 0,
          raster: raster ?? 0,
          vsyncOverhead: toFiniteNumber(args.vsyncOverhead),
          at: nowMs(),
        })
      }
      return frames
    } catch (error) {
      logger?.debug?.(`vm: getVMTimeline failed: ${normalizeError(error).message}`)
      return []
    }
  }

  /** Call any service extension by name and return its unwrapped payload. */
  async function evaluateExtension({ runId, method, isolateId, args = {}, timeoutMs } = {}) {
    if (typeof method !== 'string' || method.trim() === '') {
      throw vmError('bad-request', 'evaluateExtension() needs { method }')
    }
    const response = await callExtension(method, args ?? {}, { isolateId, timeoutMs })
    const unwrapped = unwrapExtension(response)
    if (unwrapped.raw !== null && typeof unwrapped.raw === 'object' && unwrapped.raw.error !== undefined) {
      throw vmError('extension-error', `${method}: ${String(unwrapped.raw.error)}`, { method, response: unwrapped.raw })
    }
    return unwrapped.value
  }

  // --- introspection -------------------------------------------------------
  function isConnected() {
    return currentSocket() !== null && state.vmId !== null
  }

  function snapshot() {
    return {
      connected: isConnected(),
      runId: state.runId,
      vmId: state.vmId,
      version: state.version,
      vmServiceUri: state.wsUri,
      isolates: state.isolates.map((isolate) => ({
        id: isolate.id ?? null,
        name: isolate.name ?? null,
        pauseEvent: isolate.pauseEvent ?? null,
      })),
      isolateId: state.isolateId,
      streams: [...state.streams],
      lastError: state.lastError,
      httpMethod: state.httpMethod,
      httpLogging: state.httpLogging,
      structuredErrors: state.structuredErrors,
      frames: state.frames.length,
      events: state.events,
      connectedAt: state.connectedAt,
      lastEventAt: state.lastEventAt,
      reconnecting: state.reconnectTimer !== null,
    }
  }

  /** Raw JSON-RPC passthrough (contract: `vm.call(method, params, opts)`). */
  function call(method, params = {}, callOptions = {}) {
    if (typeof method !== 'string' || method.trim() === '') {
      return Promise.reject(vmError('bad-request', 'call() needs a method name'))
    }
    return sendRequest(method, params ?? {}, callOptions)
  }

  async function dispose() {
    state.stopped = true
    await disconnect({ silent: true }).catch(() => {})
    if (state.reconnectTimer !== null) {
      clearTimeout(state.reconnectTimer)
      state.reconnectTimer = null
    }
  }

  return {
    connect,
    disconnect,
    isConnected,
    call,
    subscribe,
    unsubscribe,
    snapshot,
    httpProfile,
    httpRequestDetail,
    clearHttpProfile,
    httpVersion,
    screenshot,
    dumpApp,
    frameStats,
    evaluateExtension,
    enableHttpLogging,
    enableStructuredErrors,
    /** Live isolate id (refreshed on reconnect/restart). */
    isolateId: () => state.isolateId,
    runId: () => state.runId,
    version: () => state.version,
    streams: () => [...state.streams],
    /** Force `getVM` after a hot restart so the new isolate id is picked up. */
    refresh: () => refreshVm({ timeoutMs: 5000 }),
    dispose,
  }
}

export default createVmService