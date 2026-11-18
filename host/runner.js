/**
 * Flutter process supervisor — one `flutter run --machine` child per project.
 *
 * ── MACHINE PROTOCOL: VERIFIED AGAINST A REAL RUN (2026-11-19) ───────────────
 * Environment: Flutter 3.38.5 / Dart 3.10.4, Windows 11, device `windows`
 * (probe: `flutter create` in %TEMP% + `flutter run --machine -d windows`).
 * Every frame below was observed on the child's **stdout**, one JSON array per
 * line; plain (non-JSON) stdout lines are interleaved and must be tolerated:
 *
 *   [{"event":"daemon.connected","params":{"version":"0.6.1","pid":16696}}]
 *   [{"event":"app.start","params":{"appId":"<uuid>","deviceId":"windows",
 *      "directory":"C:\\...","supportsRestart":true,"launchMode":"run","mode":"debug"}}]
 *   [{"event":"app.progress","params":{"appId":"<uuid>","id":"0","progressId":null,
 *      "message":"Building Windows application...","finished":false}}]
 *      // note: `id` is a STRING (a progress id, NOT a request id);
 *      // finished frames may omit `message`.
 *   [{"event":"app.debugPort","params":{"appId":"<uuid>","port":64045,
 *      "wsUri":"ws://127.0.0.1:64045/RIt3b3RS8rI=/ws",
 *      "baseUri":"file:///C:/.../debug_assembly/"}}]
 *      // NO httpUri on desktop; derive http://host:port/<token>/ from wsUri.
 *   [{"event":"app.devTools","params":{"appId":"<uuid>",
 *      "uri":"http://127.0.0.1:64045/RIt3b3RS8rI=/devtools/?uri=ws://127.0.0.1:64045/RIt3b3RS8rI=/ws"}}]
 *   [{"event":"app.dtd","params":{"appId":"<uuid>","uri":"ws://127.0.0.1:64044/m7oXlAUI45U="}}]
 *   [{"event":"app.started","params":{"appId":"<uuid>"}}]
 *   [{"event":"app.log","params":{"appId":"<uuid>","log":"...","error":false}}]
 *      // documented by flutter's daemon protocol but NOT emitted for desktop
 *      // prints: `debugPrint()`/`print()` output arrived as PLAIN stdout lines
 *      // ("PROBE-PRINT tick=1"), which is why plain stdout is kept as source
 *      // `stdout` and `app.log` is handled defensively.
 *   [{"event":"app.webLaunchUrl","params":{"url":"http://localhost:64383","launched":false}}]
 *      // web-server device: note the params carry NO appId and there is no
 *      // app.debugPort until a browser attaches to the debug service.
 *   [{"event":"app.stop","params":{"appId":"<uuid>"}}]
 *   [{"event":"daemon.logMessage","params":{"level":"status","message":"..."}}]
 *   [{"event":"daemon.showMessage","params":{"level":"info","title":"...","message":"..."}}]
 *   [{"event":"device.started","params":{"appId":"<uuid>","deviceId":"...","directory":"..."}}]
 *
 * Request → response (same stdout channel), requests written to **stdin** as one
 * JSON array per line:
 *   write: [{"id":1,"method":"app.restart","params":{"appId":"<uuid>","fullRestart":false}}]
 *   read:  [{"id":1,"result":{"code":0,"message":"Reloaded 0 libraries"}}]
 *   write: [{"id":2,"method":"app.restart","params":{"appId":"<uuid>","fullRestart":true}}]
 *   read:  [{"id":2,"result":{"code":0,"message":""}}]        // empty message on restart
 *   write: [{"id":3,"method":"app.stop","params":{"appId":"<uuid>"}}]
 *   read:  [{"id":3,"result":true}]                            // then event app.stop
 *   Error responses carry `{"id":N,"error":{"code":"...","message":"..."}}`.
 *   `app.stop` makes flutter exit with code 0 ~110ms later.
 *
 * Plain stdout lines observed alongside the frames (logged as source `stdout`):
 *   "Launching lib\\main.dart on Windows in debug mode...", "√ Built build\\...\\fw_probe.exe",
 *   "Reloaded 0 libraries in 188ms (...)", "Restarted application in 367ms.",
 *   "Application finished."
 * stderr carries toolchain notices, e.g. "Flutter assets will be downloaded from ...".
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

import { guessLevel } from './logs.js'
import {
  buildSpawnSpec,
  defaultDeviceId,
  killProcessTree,
  listDevices,
  resolveBinaryPath,
} from './runconfig.js'
import { createLineSplitter, normalizeError, nowMs, sleep, truncate, uid } from './util.js'

/** DevTools deep link, per contract §5.3. */
export const DEVTOOLS_URI_PREFIX = 'https://devtools.flutter.dev/?uri='

export const RUN_PHASES = ['starting', 'running', 'reloading', 'restarting', 'stopping', 'stopped', 'failed', 'exited']
const LIVE_PHASES = new Set(['starting', 'running', 'reloading', 'restarting', 'stopping'])
const TERMINAL_PHASES = new Set(['stopped', 'failed', 'exited'])

const REQUEST_TIMEOUT_MS = 60000
const STOP_TIMEOUT_MS = 15000
const SPAWN_TIMEOUT_MS = 8000
const RUN_HISTORY = 20
const DEFAULT_PROGRAM = 'lib/main.dart'

/* ------------------------------------------------------------------ */
/* Pure protocol helpers                                               */
/* ------------------------------------------------------------------ */

/**
 * Build the exact argv for the child process (contract §5.3 order):
 * `run --machine -d <device> [--flavor f] [--dart-define=k=v] [--debug|--profile|--release] <program> [args]`
 *
 * @param {{ mode?: string, flavor?: string|null, dartDefines?: object, args?: string[] }} config
 * @param {string} deviceId
 * @param {string} [program]
 * @returns {string[]}
 */
export function buildRunArgs(config, deviceId, program = DEFAULT_PROGRAM) {
  const mode = ['debug', 'profile', 'release'].includes(config?.mode) ? config.mode : 'debug'
  const args = ['run', '--machine', '-d', String(deviceId ?? '')]
  const flavor = config?.flavor
  if (typeof flavor === 'string' && flavor.trim() !== '') args.push('--flavor', flavor.trim())
  const defines = config?.dartDefines
  if (defines !== null && typeof defines === 'object' && !Array.isArray(defines)) {
    for (const [key, value] of Object.entries(defines)) {
      if (key === '' || value === undefined || value === null) continue
      args.push(`--dart-define=${key}=${value}`)
    }
  }
  args.push(`--${mode}`)
  const entry = typeof program === 'string' && program.trim() !== '' ? program.trim() : DEFAULT_PROGRAM
  args.push(entry)
  for (const extra of Array.isArray(config?.args) ? config.args : []) args.push(String(extra))
  return args
}

/** `ws://127.0.0.1:64045/TOKEN=/ws` → `http://127.0.0.1:64045/TOKEN=/` (desktop has no httpUri). */
export function deriveHttpUri(wsUri) {
  if (typeof wsUri !== 'string' || wsUri === '') return null
  let text = wsUri.trim()
  if (text.startsWith('ws://')) text = `http://${text.slice('ws://'.length)}`
  else if (text.startsWith('wss://')) text = `https://${text.slice('wss://'.length)}`
  else if (!/^https?:\/\//.test(text)) return null
  if (text.endsWith('/ws')) text = text.slice(0, -'/ws'.length)
  if (!text.endsWith('/')) text += '/'
  return text
}

/** Contract §5.3: `https://devtools.flutter.dev/?uri=<encodeURIComponent(wsUri)>`. */
export function devtoolsUrlFor(vmServiceUri) {
  if (typeof vmServiceUri !== 'string' || vmServiceUri === '') return null
  return `${DEVTOOLS_URI_PREFIX}${encodeURIComponent(vmServiceUri)}`
}

/**
 * Parse one stdout line as a machine-protocol JSON array.
 *
 * @param {string} line
 * @returns {object[]|null} frames, or `null` when the line is plain text/garbage
 */
export function parseMachineLine(line) {
  const text = typeof line === 'string' ? line.trim() : ''
  if (text === '' || text[0] !== '[') return null
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  return parsed.filter((frame) => frame !== null && typeof frame === 'object')
}

/** Parse a whole chunk of lines, ignoring non-protocol output. */
export function parseMachineOutput(text) {
  const frames = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const parsed = parseMachineLine(line)
    if (parsed !== null) frames.push(...parsed)
  }
  return frames
}

/**
 * Classify one frame: `event` / `response` / `error-response` / `unknown`.
 *
 * @param {object} frame
 */
export function classifyFrame(frame) {
  if (frame === null || typeof frame !== 'object') return { kind: 'unknown' }
  if (typeof frame.event === 'string') {
    return {
      kind: 'event',
      event: frame.event,
      params: frame.params !== null && typeof frame.params === 'object' ? frame.params : {},
    }
  }
  if (frame.id !== undefined) {
    if (frame.error !== undefined) {
      const error = frame.error !== null && typeof frame.error === 'object' ? frame.error : {}
      return {
        kind: 'error-response',
        id: frame.id,
        code: typeof error.code === 'string' ? error.code : 'flutter-error',
        message: typeof error.message === 'string' ? error.message : String(frame.error),
      }
    }
    return { kind: 'response', id: frame.id, result: frame.result }
  }
  return { kind: 'unknown' }
}

/** stderr level heuristic (reuses the shared `guessLevel`, with error overlays). */
export function stderrLevel(text) {
  const line = String(text ?? '')
  if (/^\s*(Unhandled exception|Error:|ERROR:)/.test(line)) return 'error'
  if (/^\s*(Warning|WARNING|warn:)/.test(line)) return 'warn'
  return guessLevel(line)
}

/** Map a `daemon.*` level string to a log level. */
export function daemonLevel(level) {
  const text = String(level ?? '').toLowerCase()
  if (text === 'error' || text === 'fatal') return text
  if (text === 'warning' || text === 'warn') return 'warn'
  if (text === 'debug' || text === 'trace') return 'debug'
  return 'info'
}

/** Infer a `RunState['device']` from a device id when the shell list is absent. */
export function deviceFromId(id) {
  const key = typeof id === 'string' ? id.trim() : ''
  if (key === '') return null
  const lower = key.toLowerCase()
  let platform = 'unknown'
  if (lower.startsWith('windows')) platform = 'windows'
  else if (lower.startsWith('macos') || lower.startsWith('darwin')) platform = 'macos'
  else if (lower.startsWith('linux')) platform = 'linux'
  else if (lower.startsWith('android')) platform = 'android'
  else if (lower.startsWith('ios') || lower.startsWith('iphone') || lower.startsWith('ipad')) platform = 'ios'
  else if (lower.includes('chrome') || lower.includes('edge') || lower.includes('web')) platform = 'web'
  return { id: key, name: key, platform, emulator: false }
}

/** Normalize a caller-supplied config into the full `RunConfig` shape (§4). */
export function normalizeRunConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const defines = {}
  if (raw.dartDefines !== null && typeof raw.dartDefines === 'object' && !Array.isArray(raw.dartDefines)) {
    for (const [key, value] of Object.entries(raw.dartDefines)) {
      if (value === undefined || value === null) continue
      defines[String(key)] = String(value)
    }
  }
  const args = Array.isArray(raw.args) ? raw.args.map((item) => String(item)) : []
  const mode = ['debug', 'profile', 'release'].includes(raw.mode) ? raw.mode : 'debug'
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : 'manual',
    label: typeof raw.label === 'string' && raw.label !== '' ? raw.label : 'Manual run',
    source: ['launch.json', 'entry', 'manual'].includes(raw.source) ? raw.source : 'manual',
    program: typeof raw.program === 'string' && raw.program.trim() !== '' ? raw.program.trim() : DEFAULT_PROGRAM,
    deviceId: typeof raw.deviceId === 'string' ? raw.deviceId.trim() : '',
    mode,
    flavor: typeof raw.flavor === 'string' && raw.flavor.trim() !== '' ? raw.flavor.trim() : null,
    dartDefines: defines,
    args,
    env: raw.env !== null && typeof raw.env === 'object' && !Array.isArray(raw.env) ? { ...raw.env } : {},
  }
}

/** Create a `RunState` (§4) in the `starting` phase. */
export function createRunState({ runId, projectId, projectPath, config, device = null }) {
  return {
    runId,
    projectId,
    projectPath,
    config: { ...config },
    phase: 'starting',
    pid: null,
    startedAt: nowMs(),
    finishedAt: null,
    device,
    appId: null,
    vmServiceUri: null,
    httpUri: null,
    devtoolsUrl: null,
    exitCode: null,
    error: null,
    hotReloads: 0,
    hotRestarts: 0,
  }
}

/** Snapshot for emitting over the bus (no internal fields leak). */
export function snapshotRunState(run) {
  if (run === null || typeof run !== 'object') return null
  return {
    runId: run.runId,
    projectId: run.projectId,
    projectPath: run.projectPath,
    config: { ...run.config, dartDefines: { ...run.config.dartDefines }, args: [...run.config.args] },
    phase: run.phase,
    pid: run.pid,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    device: run.device === null ? null : { ...run.device },
    appId: run.appId,
    vmServiceUri: run.vmServiceUri,
    httpUri: run.httpUri,
    devtoolsUrl: run.devtoolsUrl,
    exitCode: run.exitCode,
    error: run.error,
    hotReloads: run.hotReloads,
    hotRestarts: run.hotRestarts,
  }
}

/** Is this run still attached to a live child? */
export function isLivePhase(phase) {
  return LIVE_PHASES.has(String(phase))
}

/* ------------------------------------------------------------------ */
/* Supervisor                                                          */
/* ------------------------------------------------------------------ */

/**
 * @param {{ logs?: any, bus?: any, settings?: any, logger?: any, projects?: any,
 *          spawn?: Function, killTree?: Function, requestTimeoutMs?: number }} deps
 */
export function createRunner({
  logs = null,
  bus = null,
  settings = null,
  logger = null,
  projects = null,
  spawn: spawnImpl = spawn,
  killTree = killProcessTree,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  /** @type {Map<string, any>} */
  const runs = new Map()
  /** @type {Map<string, import('node:child_process').ChildProcess>} */
  const children = new Map()
  /** @type {Map<string, Map<any, any>>} */
  const pending = new Map()
  /** @type {Map<string, string>} projectId → runId */
  const activeByProject = new Map()
  const splitters = new Map()
  const listeners = new Set()
  let requestSeq = 0
  let disposed = false

  const emit = (type, payload) => {
    if (bus !== null && typeof bus.emit === 'function') bus.emit(type, payload)
    for (const listener of [...listeners]) {
      try {
        listener({ type, payload })
      } catch {
        /* never let a listener break the supervisor */
      }
    }
  }

  function appendLog(run, source, level, text, meta = null) {
    const value = typeof text === 'string' ? text : String(text ?? '')
    if (value === '' || logs === null || typeof logs.append !== 'function') return null
    try {
      return logs.append({
        source,
        level,
        text: value,
        runId: run?.runId ?? null,
        projectId: run?.projectId ?? null,
        meta,
      })
    } catch {
      return null
    }
  }

  function emitState(run) {
    emit('run:state', snapshotRunState(run))
  }

  function setPhase(run, phase, patch = null) {
    if (!RUN_PHASES.includes(phase)) return
    const changed = run.phase !== phase
    run.phase = phase
    if (patch !== null && typeof patch === 'object') Object.assign(run, patch)
    if (TERMINAL_PHASES.has(phase) && run.finishedAt === null) run.finishedAt = nowMs()
    if (changed || patch !== null) emitState(run)
  }

  function settingsSnapshot() {
    try {
      const value = settings?.get?.()
      return value !== null && typeof value === 'object' ? value : {}
    } catch {
      return {}
    }
  }

  function resolveFlutterBinary() {
    const current = settingsSnapshot()
    return resolveBinaryPath({ configured: current.flutterPath ?? '', name: 'flutter', env: process.env })
  }

  /** Live run for a project id/path, if any. */
  function liveRunForProject(projectId, projectPath) {
    const root = typeof projectPath === 'string' ? projectPath.toLowerCase() : ''
    for (const run of runs.values()) {
      if (!LIVE_PHASES.has(run.phase)) continue
      if (run.projectId === projectId) return run
      if (root !== '' && String(run.projectPath).toLowerCase() === root) return run
    }
    return null
  }

  function pruneRuns() {
    if (runs.size <= RUN_HISTORY) return
    const finished = [...runs.values()].filter((run) => TERMINAL_PHASES.has(run.phase)).sort((a, b) => a.startedAt - b.startedAt)
    while (runs.size > RUN_HISTORY && finished.length > 0) {
      const oldest = finished.shift()
      runs.delete(oldest.runId)
      splitters.delete(oldest.runId)
    }
  }

  /* ---------------- request / response ---------------- */

  function writeRequest(run, method, params, timeoutMs) {
    if (disposed) return Promise.resolve({ ok: false, code: 'disposed', message: 'runner disposed' })
    const child = children.get(run.runId)
    if (child === undefined || child.stdin === null || child.stdin === undefined || child.stdin.destroyed === true) {
      return Promise.resolve({ ok: false, code: 'not-running', message: 'no live flutter process' })
    }
    requestSeq += 1
    const id = requestSeq
    const frame = [{ id, method, params: params ?? {} }]
    const wait = new Promise((resolve) => {
      const entry = {
        resolve,
        method,
        timer: null,
      }
      entry.timer = setTimeout(() => {
        const table = pending.get(run.runId)
        if (table !== undefined) table.delete(id)
        resolve({ ok: false, code: 'timeout', message: `${method} timed out after ${timeoutMs}ms` })
      }, Math.max(1000, Number(timeoutMs) || REQUEST_TIMEOUT_MS))
      if (typeof entry.timer.unref === 'function') entry.timer.unref()
      let table = pending.get(run.runId)
      if (table === undefined) {
        table = new Map()
        pending.set(run.runId, table)
      }
      table.set(id, entry)
    })
    try {
      child.stdin.write(`${JSON.stringify(frame)}\n`)
    } catch (error) {
      settleRequest(run.runId, id, { ok: false, code: 'write-failed', message: normalizeError(error).message })
    }
    return wait
  }

  function settleRequest(runId, id, value) {
    const table = pending.get(runId)
    if (table === undefined) return false
    const entry = table.get(id)
    if (entry === undefined) return false
    table.delete(id)
    if (table.size === 0) pending.delete(runId)
    clearTimeout(entry.timer)
    entry.resolve(value)
    return true
  }

  function rejectPending(runId, value) {
    const table = pending.get(runId)
    if (table === undefined) return
    pending.delete(runId)
    for (const entry of table.values()) {
      clearTimeout(entry.timer)
      entry.resolve(value)
    }
  }

  /* ---------------- frame handling ---------------- */

  function handleFrame(run, frame) {
    const classified = classifyFrame(frame)
    if (classified.kind === 'response') {
      settleRequest(run.runId, classified.id, { ok: true, result: classified.result })
      return
    }
    if (classified.kind === 'error-response') {
      settleRequest(run.runId, classified.id, { ok: false, code: classified.code, message: classified.message })
      return
    }
    if (classified.kind !== 'event') {
      appendLog(run, 'daemon', 'debug', truncate(JSON.stringify(frame), 500), { frame: 'unknown' })
      return
    }
    const params = classified.params
    switch (classified.event) {
      case 'daemon.connected': {
        appendLog(run, 'daemon', 'info', `daemon connected (version ${params.version ?? '?'}, pid ${params.pid ?? '?'})`, {
          event: classified.event,
        })
        return
      }
      case 'app.start': {
        if (typeof params.appId === 'string' && params.appId !== '') run.appId = params.appId
        if (typeof params.deviceId === 'string' && params.deviceId !== '') {
          run.device = { ...(deviceFromId(params.deviceId) ?? {}), ...(run.device ?? {}) }
        }
        appendLog(
          run,
          'daemon',
          'info',
          `app.start device=${params.deviceId ?? '?'} mode=${params.mode ?? '?'} launchMode=${params.launchMode ?? '?'}`,
          { event: classified.event },
        )
        emitState(run)
        return
      }
      case 'app.started': {
        if (typeof params.appId === 'string' && params.appId !== '') run.appId = params.appId
        setPhase(run, 'running')
        appendLog(run, 'flutter', 'info', 'Application started')
        return
      }
      case 'app.debugPort': {
        const vmServiceUri =
          typeof params.wsUri === 'string' && params.wsUri !== ''
            ? params.wsUri
            : Number.isFinite(Number(params.port))
              ? `ws://127.0.0.1:${Number(params.port)}/ws`
              : null
        const httpUri =
          typeof params.httpUri === 'string' && params.httpUri !== ''
            ? params.httpUri
            : typeof params.baseUri === 'string' && /^https?:\/\//.test(params.baseUri)
              ? params.baseUri
              : deriveHttpUri(vmServiceUri)
        run.vmServiceUri = vmServiceUri
        run.httpUri = httpUri
        run.devtoolsUrl = devtoolsUrlFor(vmServiceUri)
        emit('run:vm-service', {
          runId: run.runId,
          projectId: run.projectId,
          vmServiceUri: run.vmServiceUri,
          httpUri: run.httpUri,
          devtoolsUrl: run.devtoolsUrl,
        })
        emitState(run)
        return
      }
      case 'app.devTools': {
        // flutter prints a ready-to-open local DevTools url; keep it as log meta.
        appendLog(run, 'daemon', 'debug', `devtools: ${params.uri ?? ''}`, { devtools: params.uri ?? null })
        return
      }
      case 'app.dtd': {
        appendLog(run, 'daemon', 'debug', `dart tooling daemon: ${params.uri ?? ''}`, { dtd: params.uri ?? null })
        return
      }
      case 'app.log': {
        const text = typeof params.log === 'string' ? params.log : ''
        const level = params.error === true ? 'error' : guessLevel(text)
        appendLog(run, 'flutter', level, text, { event: classified.event })
        return
      }
      case 'app.progress': {
        const message = typeof params.message === 'string' ? params.message : ''
        const progressId = params.progressId ?? null
        if (message !== '') {
          appendLog(run, 'flutter', 'debug', message, { progressId, finished: params.finished === true })
        }
        return
      }
      case 'app.webLaunchUrl': {
        const url = typeof params.url === 'string' ? params.url : ''
        if (url !== '') {
          if (run.httpUri === null) run.httpUri = url
          appendLog(run, 'daemon', 'info', `web app served at ${url}`, { launched: params.launched === true })
          emitState(run)
        }
        return
      }
      case 'app.stop':
      case 'app.detach': {
        appendLog(run, 'daemon', 'info', classified.event === 'app.detach' ? 'app detached' : 'app stopped')
        if (LIVE_PHASES.has(run.phase) && run.phase !== 'stopping') setPhase(run, 'stopping')
        return
      }
      case 'daemon.logMessage': {
        appendLog(run, 'daemon', daemonLevel(params.level), String(params.message ?? ''))
        return
      }
      case 'daemon.showMessage': {
        const title = typeof params.title === 'string' ? params.title : ''
        const message = typeof params.message === 'string' ? params.message : ''
        appendLog(run, 'daemon', daemonLevel(params.level), title === '' ? message : `${title}: ${message}`, {
          actions: Array.isArray(params.actions) ? params.actions.length : 0,
        })
        return
      }
      case 'device.started':
      case 'device.attached':
      case 'device.launched': {
        appendLog(run, 'daemon', 'info', `${classified.event} ${params.deviceId ?? ''}`.trim(), {
          event: classified.event,
        })
        return
      }
      default: {
        const text = truncate(JSON.stringify(frame), 400)
        appendLog(run, 'daemon', 'debug', `${classified.event}: ${text}`, { event: classified.event })
      }
    }
  }

  /* ---------------- child lifecycle ---------------- */

  function attachChild(run, child) {
    children.set(run.runId, child)
    run.pid = typeof child.pid === 'number' ? child.pid : null
    const outSplit = createLineSplitter()
    const errSplit = createLineSplitter()

    child.stdout?.setEncoding?.('utf8')
    child.stderr?.setEncoding?.('utf8')

    child.stdout?.on('data', (chunk) => {
      for (const line of outSplit.push('stdout', chunk)) {
        const frames = parseMachineLine(line)
        if (frames === null) {
          appendLog(run, 'stdout', guessLevel(line), line)
          continue
        }
        for (const frame of frames) handleFrame(run, frame)
      }
    })
    child.stderr?.on('data', (chunk) => {
      for (const line of errSplit.push('stderr', chunk)) {
        appendLog(run, 'stderr', stderrLevel(line), line)
      }
    })
    child.on('error', (error) => {
      const { message, code } = normalizeError(error)
      rejectPending(run.runId, { ok: false, code: 'child-error', message })
      setPhase(run, 'failed', { error: `spawn failed: ${message}`, exitCode: null })
      appendLog(run, 'daemon', 'error', `spawn failed: ${message}`, { code })
      children.delete(run.runId)
      activeByProject.delete(run.projectId)
    })
    child.on('exit', (code, signal) => {
      children.delete(run.runId)
      activeByProject.delete(run.projectId)
      rejectPending(run.runId, { ok: false, code: 'exited', message: 'flutter process exited' })
      const tail = outSplit.flush('stdout')
      for (const line of tail) {
        const frames = parseMachineLine(line)
        if (frames === null) appendLog(run, 'stdout', guessLevel(line), line)
        else for (const frame of frames) handleFrame(run, frame)
      }
      for (const line of errSplit.flush('stderr')) appendLog(run, 'stderr', stderrLevel(line), line)
      const exitCode = Number.isInteger(code) ? code : null
      if (run.phase === 'stopping') {
        // A requested stop always settles as `stopped`, never as `exited`.
        setPhase(run, 'stopped', { exitCode })
      } else if (run.phase === 'stopped' || run.phase === 'failed') {
        run.exitCode = exitCode
        emitState(run)
      } else {
        setPhase(run, 'exited', {
          exitCode,
          error: signal !== null && signal !== undefined ? `terminated by ${signal}` : run.error,
        })
      }
      appendLog(run, 'daemon', code === 0 ? 'info' : 'warn', `flutter run exited (code ${code ?? 'null'})`)
    })
    emitState(run)
  }

  function waitForSpawn(child, timeoutMs = SPAWN_TIMEOUT_MS) {
    return new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => finish({ ok: true, message: 'spawn timeout assumed ok' }), timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      child.once?.('spawn', () => finish({ ok: true, message: null }))
      child.once?.('error', (error) => finish({ ok: false, message: normalizeError(error).message }))
      if (typeof child.pid === 'number' && child.pid > 0 && child.exitCode === null && typeof child.once !== 'function') {
        finish({ ok: true, message: null })
      }
    })
  }

  function waitForExit(child, timeoutMs = 5000) {
    if (child === null || child === undefined) return Promise.resolve(true)
    if (child.exitCode !== null && child.exitCode !== undefined) return Promise.resolve(true)
    return new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => finish(false), timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      child.once?.('exit', () => finish(true))
    })
  }

  async function stopOne(run, { force = false, timeoutMs = STOP_TIMEOUT_MS } = {}) {
    const child = children.get(run.runId)
    if (child === undefined) {
      if (LIVE_PHASES.has(run.phase)) setPhase(run, 'stopped')
      activeByProject.delete(run.projectId)
      return run
    }
    setPhase(run, 'stopping')
    if (!force && typeof run.appId === 'string' && run.appId !== '') {
      // Graceful: flutter exits by itself right after app.stop.
      await Promise.race([writeRequest(run, 'app.stop', { appId: run.appId }, 5000), sleep(6000)])
      const exited = await waitForExit(child, Math.min(timeoutMs, 8000))
      if (!exited) {
        children.delete(run.runId)
        killTree(child, { force: true })
      }
    } else {
      children.delete(run.runId)
      killTree(child, { force: true })
    }
    rejectPending(run.runId, { ok: false, code: 'stopped', message: 'run stopped' })
    const stopped = await waitForExit(child, 3000)
    if (!stopped) {
      children.delete(run.runId)
      killTree(child, { force: true })
    }
    children.delete(run.runId)
    activeByProject.delete(run.projectId)
    if (run.phase !== 'exited' && run.phase !== 'failed') setPhase(run, 'stopped')
    appendLog(run, 'daemon', 'info', 'run stopped')
    return run
  }

  /* ---------------- public API ---------------- */

  async function start({ projectPath, projectId, config } = {}) {
    if (disposed) throw Object.assign(new Error('runner disposed'), { code: 'disposed' })
    const root = typeof projectPath === 'string' ? projectPath.trim() : ''
    if (root === '') throw Object.assign(new Error('projectPath is required'), { code: 'bad-request' })
    if (!existsSync(root)) throw Object.assign(new Error(`project path does not exist: ${root}`), { code: 'not-found' })

    const normalized = normalizeRunConfig(config)
    const projectKey =
      typeof projectId === 'string' && projectId !== ''
        ? projectId
        : (typeof projects?.activeId === 'function' ? projects.activeId() : null) ?? root

    // One live run per project: starting again stops the previous one.
    const previous = liveRunForProject(projectKey, root)
    if (previous !== null) await stopOne(previous, { force: true })

    const runId = uid('run')
    const binary = resolveFlutterBinary()
    const initialDevice = normalized.deviceId !== '' ? deviceFromId(normalized.deviceId) : null
    const run = createRunState({
      runId,
      projectId: projectKey,
      projectPath: root,
      config: normalized,
      device: initialDevice,
    })
    runs.set(runId, run)

    if (binary === null) {
      const current = settingsSnapshot()
      const message = `flutter executable not found (setting flutterPath="${current.flutterPath ?? ''}"); install the Flutter SDK or set it in Settings`
      setPhase(run, 'failed', { error: message })
      appendLog(run, 'daemon', 'error', message)
      throw Object.assign(new Error(message), { code: 'toolchain-missing', runId })
    }

    let deviceId = normalized.deviceId
    if (deviceId === '') {
      try {
        const devices = await listDevices({ flutterPath: binary.path, timeoutMs: 15000 })
        deviceId = defaultDeviceId(devices)
      } catch {
        deviceId = ''
      }
      if (deviceId === '') {
        deviceId = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
      }
      run.config.deviceId = deviceId
    }
    const device = deviceFromId(deviceId)
    run.device = device

    const args = buildRunArgs(run.config, deviceId, normalized.program)
    const spec = buildSpawnSpec(binary.path, args)
    const env = { ...process.env, ...(normalized.env ?? {}) }
    appendLog(run, 'daemon', 'info', `spawning ${binary.path} ${args.join(' ')}`, {
      cwd: root,
      source: binary.source,
      config: normalized.id,
    })
    setPhase(run, 'starting')
    emitState(run)

    let child
    try {
      child = spawnImpl(spec.file, spec.args, {
        cwd: root,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...spec.options,
      })
    } catch (error) {
      const { message, code } = normalizeError(error)
      setPhase(run, 'failed', { error: message })
      appendLog(run, 'daemon', 'error', `spawn threw: ${message}`, { code })
      throw Object.assign(new Error(`cannot spawn flutter: ${message}`), { code: 'spawn-failed', runId })
    }

    const readiness = await waitForSpawn(child)
    if (!readiness.ok) {
      setPhase(run, 'failed', { error: `spawn failed: ${readiness.message}` })
      appendLog(run, 'daemon', 'error', `spawn failed: ${readiness.message}`)
      throw Object.assign(new Error(`cannot spawn flutter: ${readiness.message}`), { code: 'spawn-failed', runId })
    }

    attachChild(run, child)
    activeByProject.set(projectKey, runId)
    pruneRuns()
    if (typeof projects?.touch === 'function' && projectKey !== root) {
      Promise.resolve(projects.touch(projectKey)).catch(() => {})
    }
    return { runId, run: snapshotRunState(run) }
  }

  async function stop({ runId, force = false } = {}) {
    const targets = []
    if (typeof runId === 'string' && runId !== '') {
      const run = runs.get(runId)
      if (run !== undefined) targets.push(run)
    } else {
      for (const run of runs.values()) if (LIVE_PHASES.has(run.phase)) targets.push(run)
    }
    const stopped = []
    for (const run of targets) {
      await stopOne(run, { force: force === true })
      stopped.push(run.runId)
    }
    return { stopped }
  }

  async function reloadOrRestart(runId, fullRestart) {
    const target = pickRun(runId)
    if (target === null) return { runId: runId ?? null, ok: false, message: 'no active run' }
    if (target.appId === null) return { runId: target.runId, ok: false, message: 'the app has not started yet' }
    if (!children.has(target.runId)) return { runId: target.runId, ok: false, message: 'flutter process is not running' }
    const phase = fullRestart ? 'restarting' : 'reloading'
    setPhase(target, phase)
    appendLog(target, 'daemon', 'info', fullRestart ? 'hot restart requested' : 'hot reload requested')
    const response = await writeRequest(
      target,
      'app.restart',
      { appId: target.appId, fullRestart: fullRestart === true },
      requestTimeoutMs,
    )
    if (LIVE_PHASES.has(target.phase) && target.phase !== 'stopping') setPhase(target, 'running')
    if (fullRestart) target.hotRestarts += 1
    else target.hotReloads += 1
    emitState(target)
    if (!response.ok) {
      appendLog(target, 'daemon', 'warn', `${fullRestart ? 'hot restart' : 'hot reload'} failed: ${response.message}`)
      return { runId: target.runId, ok: false, message: response.message }
    }
    const result = response.result !== null && typeof response.result === 'object' ? response.result : {}
    const code = typeof result.code === 'number' ? result.code : 0
    const ok = code === 0
    const message =
      typeof result.message === 'string' && result.message !== ''
        ? result.message
        : ok
          ? fullRestart
            ? 'hot restart complete'
            : 'hot reload complete'
          : `flutter reported code ${code}`
    appendLog(target, 'flutter', ok ? 'info' : 'warn', message)
    return { runId: target.runId, ok, message }
  }

  /** Internal RunState (not a snapshot) for the newest live run, then the newest run. */
  function pickRunInternal(runId) {
    if (typeof runId === 'string' && runId !== '') {
      const run = runs.get(runId)
      if (run !== undefined) return run
      return null
    }
    let live = null
    for (const run of runs.values()) {
      if (!LIVE_PHASES.has(run.phase)) continue
      if (live === null || run.startedAt > live.startedAt) live = run
    }
    if (live !== null) return live
    let newest = null
    for (const run of runs.values()) {
      if (newest === null || run.startedAt > newest.startedAt) newest = run
    }
    return newest
  }

  const pickRun = (runId) => pickRunInternal(runId)

  function latestRun() {
    let best = null
    for (const run of runs.values()) {
      if (best === null) {
        best = run
        continue
      }
      if (LIVE_PHASES.has(run.phase) && !LIVE_PHASES.has(best.phase)) best = run
      else if (LIVE_PHASES.has(run.phase) === LIVE_PHASES.has(best.phase) && run.startedAt > best.startedAt) best = run
    }
    return best === null ? null : snapshotRunState(best)
  }

  function state({ runId } = {}) {
    if (typeof runId === 'string' && runId !== '') {
      const run = runs.get(runId)
      return { runs: run === undefined ? [] : [snapshotRunState(run)], activeRunId: run === undefined ? null : run.runId }
    }
    const active = (() => {
      let best = null
      for (const run of runs.values()) {
        if (!LIVE_PHASES.has(run.phase)) continue
        if (best === null || run.startedAt > best.startedAt) best = run
      }
      return best
    })()
    return {
      runs: [...runs.values()]
        .sort((a, b) => a.startedAt - b.startedAt)
        .map(snapshotRunState)
        .filter((item) => item !== null),
      activeRunId: active === null ? null : active.runId,
    }
  }

  function onEvent(callback) {
    if (typeof callback !== 'function') return () => {}
    listeners.add(callback)
    return () => listeners.delete(callback)
  }

  async function dispose() {
    if (disposed) return
    disposed = true
    const ids = [...children.keys()]
    for (const runId of ids) {
      const run = runs.get(runId)
      const child = children.get(runId)
      children.delete(runId)
      rejectPending(runId, { ok: false, code: 'disposed', message: 'runner disposed' })
      if (run !== undefined) setPhase(run, 'stopped')
      killTree(child, { force: true })
    }
    for (const runId of [...children.keys()]) {
      killTree(children.get(runId), { force: true })
      children.delete(runId)
    }
    children.clear()
    pending.clear()
    activeByProject.clear()
    splitters.clear()
    listeners.clear()
    if (logger !== null && typeof logger.info === 'function') logger.info('runner disposed')
  }

  return {
    start,
    stop,
    hotReload: ({ runId } = {}) => reloadOrRestart(runId, false),
    hotRestart: ({ runId } = {}) => reloadOrRestart(runId, true),
    state,
    latestRun,
    onEvent,
    dispose,
    /** internal, used by tests: process/formula helpers considered stable */
    _internals: { runs, children, liveRunForProject, writeRequest },
  }
}