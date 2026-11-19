/**
 * HTTP surface of the Flutter workbench panel — the UI's only data source.
 *
 * Deliberately transport-thin: every route resolves a service method and shapes
 * JSON. {@link createHttpApi} `handle()` is pure request/response plumbing (no
 * socket, unit-testable); `attach()` is the only place that touches
 * `ctx.get('webServer')` / `ctx.get('connection')`.
 *
 * Connection fence: a raw `prefix` route bypasses the host's `/api` fence, so
 * every non-MCP request is gated by `connection.requestRejection({ headers })`
 * before anything else runs. `/mcp` is the exception — external MCP clients have
 * no DSH cookie and authenticate with the plugin's own bearer token instead.
 *
 * The module is dependency-free Node ESM and never imports a host service at
 * top level; services arrive in `options.services` and are looked up defensively.
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import * as runconfig from './runconfig.js'
import { normalizeError, nowMs, readBody, safeJson, sendJson, uid } from './util.js'

/** Route prefix owned by this plugin (identical in the client half). */
export const ROUTE_PREFIX = '/api/flutter-workbench'
/** MCP JSON-RPC endpoint (inside {@link ROUTE_PREFIX}). */
export const MCP_PATH = `${ROUTE_PREFIX}/mcp`

/**
 * Alias root that sits OUTSIDE `/api`. The Desktop web carrier fences every
 * `/api/*` request with a DSH login cookie before any plugin route sees it, so a
 * cookie-less external MCP client (VS Code, Cursor, Claude Code) can only reach
 * this plugin through a non-`/api` path. Both paths run the same handler; the
 * aliased one rewrites to {@link ROUTE_PREFIX} on arrival.
 */
export const ALT_PREFIX = '/flutter-workbench'

/**
 * Rewrite the alias ingress onto the real prefix.
 * `/flutter-workbench/mcp` → `/api/flutter-workbench/mcp`; every other path is
 * returned unchanged, so the alias can never shadow a shipped route.
 * @param {string} pathname request path.
 * @returns {string} the path the router should see.
 */
export function resolveAliasPath(pathname) {
  const value = String(pathname ?? '')
  if (value === ALT_PREFIX) return ROUTE_PREFIX
  if (value.startsWith(`${ALT_PREFIX}/`)) return `${ROUTE_PREFIX}${value.slice(ALT_PREFIX.length)}`
  return value
}
/** Largest accepted JSON request body. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024
/** Toolchain jobs kept in memory (newest win). */
export const MAX_JOBS = 20
/** Actions `POST /toolchain` accepts. */
export const TOOLCHAIN_ACTIONS = Object.freeze(['analyze', 'test', 'pubGet', 'clean', 'build', 'doctor', 'format'])
/** `ts build` targets accepted by the toolchain service. */
export const BUILD_TARGETS = Object.freeze(['apk', 'appbundle', 'ios', 'web', 'windows', 'macos', 'linux'])
/** Run modes accepted by the runner. */
export const RUN_MODES = Object.freeze(['debug', 'profile', 'release'])

/** Returned by `safeJson` for unparsable text (parsed `null` stays distinct). */
const MISSING = Symbol('missing')

/** HTTP status per error code; anything unknown becomes 500. */
const STATUS_BY_CODE = {
  'bad-request': 400,
  'bad-json': 400,
  'bad-body': 400,
  'no-data': 422,
  'bad-image': 422,
  'not-found': 404,
  'method': 405,
  'conflict': 409,
  'too-large': 413,
  unauthenticated: 401,
  'token-required': 401,
  forbidden: 403,
  'mcp-disabled': 403,
  'not-implemented': 501,
  'service-unavailable': 503,
  'toolchain-missing': 503,
  timeout: 504,
}

/**
 * Build the HTTP API for one plugin instance.
 *
 * @param {object} options
 * @param {any} [options.ctx] plugin context (defaults to `services.ctx`).
 * @param {object} [options.services] project services (runner, logs, board, …).
 * @param {any} [options.logger] logger with debug/info/warn/error.
 * @returns {{
 *   handle: (input: { method?: string, path: string, query?: any, body?: any, headers?: Record<string, any> }) => Promise<{ status: number, body: any, headers?: Record<string, string> }>,
 *   attach: (ctx?: any) => () => void,
 *   dispose: () => void,
 *   ROUTE_PREFIX: string,
 *   MCP_PATH: string,
 * }}
 */
export function createHttpApi(options = {}) {
  const services = options.services ?? {}
  const logger = options.logger
  /** The plugin context: `webServer` and `connection` only exist there. */
  const baseCtx = options.ctx ?? null
  const startedAt = nowMs()
  /** @type {Map<string, any>} */
  const jobs = new Map()
  /** @type {null | (() => void)} */
  let activeDisposer = null

  // ---------------------------------------------------------------- services

  /** Read a service without throwing; falls back to the plugin context. */
  function lookup(name) {
    const fromServices = services === null || services === undefined ? undefined : services[name]
    if (fromServices !== undefined && fromServices !== null) return fromServices
    try {
      const fromCtx = typeof baseCtx?.get === 'function' ? baseCtx.get(name) : undefined
      return fromCtx ?? null
    } catch {
      return null
    }
  }

  /** The DSH connection fence verdict for one request, or null to allow it. */
  function fenceVerdict(headers) {
    const connection = lookup('connection')
    // Fail closed: a raw prefix route bypasses the host's own `/api` fence.
    if (connection === null || typeof connection.requestRejection !== 'function') return 403
    const rejection = connection.requestRejection({ headers })
    return rejection === undefined || rejection === null ? null : rejection
  }

  /** Read a service that a route cannot work without. */
  function require(name) {
    const value = lookup(name)
    if (value === null) throw unavailable(name)
    return value
  }

  /** 503 error carrying the recorded warning for that subsystem. */
  function unavailable(subsystem) {
    const warnings = Array.isArray(services?.warnings) ? services.warnings : []
    const note = warnings.find((item) => item !== null && typeof item === 'object' && item.subsystem === subsystem)
    const message = `${subsystem} subsystem is unavailable${typeof note?.message === 'string' ? `: ${note.message}` : ''}`
    return Object.assign(new Error(message), { code: 'service-unavailable' })
  }

  /** Read a value, degrading to `fallback` instead of failing the whole route. */
  async function safeValue(producer, fallback = null) {
    try {
      const value = await producer()
      return value === undefined || value === null ? fallback : value
    } catch (error) {
      logger?.debug?.(`httpapi: degraded read: ${normalizeError(error).message}`)
      return fallback
    }
  }

  // ----------------------------------------------------------------- helpers

  function badRequest(message) {
    return Object.assign(new Error(message), { code: 'bad-request' })
  }

  function notFound(message) {
    return Object.assign(new Error(message), { code: 'not-found' })
  }

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && Array.isArray(value) === false
  }

  /** Trimmed non-empty string or `undefined`. */
  function text(value) {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
  }

  function stringMap(value) {
    const result = {}
    for (const [key, item] of Object.entries(value ?? {})) result[String(key)] = String(item ?? '')
    return result
  }

  function omitKeys(object, keys) {
    const blocked = new Set(keys)
    const result = {}
    for (const [key, value] of Object.entries(object ?? {})) if (blocked.has(key) === false) result[key] = value
    return result
  }

  /** Route id relative to {@link ROUTE_PREFIX} (`/logs`, `/run/start`, `/`). */
  function routeId(path) {
    const raw = String(path ?? '')
    const withoutPrefix = raw.startsWith(ROUTE_PREFIX) ? raw.slice(ROUTE_PREFIX.length) : raw
    const clean = withoutPrefix.split('?')[0].split('#')[0].replace(/\/+$/, '')
    return clean === '' ? '/' : clean
  }

  function intOf(value, fallback, bounds = {}) {
    const parsed = Number(value)
    if (value === undefined || value === null || Number.isFinite(parsed) === false) return fallback
    const min = bounds.min ?? 0
    const max = bounds.max ?? Number.MAX_SAFE_INTEGER
    return Math.min(max, Math.max(min, Math.trunc(parsed)))
  }

  /**
   * Uniform query access. Accepts `URLSearchParams`, a plain object, a
   * `[key, value][]` list, or nothing; repeated keys are preserved so
   * `levels=error&levels=warn` and `levels=error,warn` behave the same.
   */
  function createQuery(source) {
    /** @type {Map<string, string[]>} */
    const bag = new Map()
    const add = (key, value) => {
      if (value === undefined || value === null) return
      const name = String(key)
      const list = bag.get(name) ?? []
      list.push(String(value))
      bag.set(name, list)
    }
    if (source !== undefined && source !== null) {
      if (typeof source.entries === 'function') {
        for (const [key, value] of source.entries()) add(key, value)
      } else if (typeof source.forEach === 'function' && typeof source.get === 'function') {
        source.forEach((value, key) => add(key, value))
      } else if (Array.isArray(source)) {
        for (const entry of source) if (Array.isArray(entry) && entry.length >= 2) add(entry[0], entry[1])
      } else if (typeof source === 'object') {
        for (const [key, value] of Object.entries(source)) {
          if (Array.isArray(value)) for (const item of value) add(key, item)
          else add(key, value)
        }
      }
    }
    const splitValue = (value) => {
      const parts = []
      for (const piece of String(value ?? '').split(',')) {
        const trimmed = piece.trim()
        if (trimmed !== '') parts.push(trimmed)
      }
      return parts
    }
    return {
      get(name) {
        const list = bag.get(String(name))
        return list === undefined || list.length === 0 ? undefined : list[0]
      },
      all(name) {
        const list = bag.get(String(name))
        if (list === undefined) return []
        const out = []
        for (const item of list) out.push(...splitValue(item))
        return out
      },
      has(name) {
        return bag.has(String(name))
      },
      text(name) {
        return text(this.get(name))
      },
      bool(name, fallback = false) {
        const value = this.get(name)
        if (value === undefined) return fallback
        return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
      },
      int(name, fallback, bounds) {
        return intOf(this.get(name), fallback, bounds)
      },
      names() {
        return [...bag.keys()]
      },
    }
  }

  // -------------------------------------------------------------- MCP access

  const SUPPORTED_PROTOCOLS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05'])

  /** Bearer header wins over `?token=`; both are compared to `settings.mcpToken`. */
  function tokenOf(headers, query) {
    for (const name of ['authorization', 'Authorization']) {
      const raw = headers?.[name]
      const value = Array.isArray(raw) ? raw[0] : raw
      if (typeof value === 'string' && /^bearer\s+/i.test(value)) return value.replace(/^bearer\s+/i, '').trim()
    }
    const fromQuery = query.get('token')
    return typeof fromQuery === 'string' ? fromQuery.trim() : ''
  }

  function mcpSettings() {
    const settings = lookup('settings')
    const view = typeof settings?.get === 'function' ? settings.get() : null
    return isPlainObject(view) ? view : {}
  }

  /** MCP routes bypass the DSH connection fence and use the plugin token instead. */
  async function handleMcp({ method, query, headers, body }) {
    if (method !== 'POST' && method !== 'GET' && method !== 'HEAD') {
      return { status: 405, headers: { allow: 'GET, POST' }, body: { ok: false, code: 'method', message: 'MCP 接口只支持 GET 与 POST' } }
    }
    if (mcpSettings().mcpEnabled === false) {
      return { status: 403, headers: {}, body: { ok: false, code: 'mcp-disabled', message: 'MCP 接口已在设置中关闭' } }
    }
    const expected = String(mcpSettings().mcpToken ?? '')
    const provided = tokenOf(headers, query)
    if (expected === '' || provided !== expected) {
      return {
        status: 401,
        headers: { 'www-authenticate': 'Bearer realm="flutter-workbench"' },
        body: {
          ok: false,
          code: 'unauthenticated',
          message: provided === '' ? '缺少 MCP 令牌：请带上 Authorization: Bearer <token> 或 ?token=' : 'MCP 令牌不正确',
        },
      }
    }

    const mcp = lookup('mcp')
    if (method === 'GET' || method === 'HEAD') {
      const info = await safeValue(() => (typeof mcp?.info === 'function' ? mcp.info() : null), null)
      return {
        status: 200,
        headers: {},
        body: {
          ok: true,
          name: typeof info?.name === 'string' ? info.name : 'dsh-flutter-workbench',
          version: typeof info?.version === 'string' ? info.version : String(services?.version ?? ''),
          toolCount: Number.isFinite(Number(info?.toolCount)) ? Number(info.toolCount) : 0,
          path: MCP_PATH,
          protocolVersions: [...SUPPORTED_PROTOCOLS],
        },
      }
    }

    if (mcp === null || typeof mcp.handleJsonRpc !== 'function') throw unavailable('mcp')
    const response = await mcp.handleJsonRpc(body, { token: provided })
    if (response === null || response === undefined) {
      // JSON-RPC notification: accepted, no body (MCP over HTTP uses 202).
      return { status: 202, headers: {}, body: null }
    }
    return { status: 200, headers: {}, body: response }
  }

  // ------------------------------------------------------------- job runner

  function pruneJobs() {
    while (jobs.size > MAX_JOBS) {
      let victim = null
      for (const job of jobs.values()) {
        if (job.status !== 'running') {
          victim = job.id
          break
        }
      }
      if (victim === null) victim = jobs.keys().next().value
      jobs.delete(victim)
    }
  }

  /** Start an async job and keep at most {@link MAX_JOBS} of them. */
  function startJob(action, work) {
    const id = uid('job')
    const job = { id, action, status: 'running', startedAt: nowMs() }
    jobs.set(id, job)
    pruneJobs()
    Promise.resolve()
      .then(work)
      .then(
        (result) => {
          job.status = 'done'
          job.result = result === undefined ? null : result
          job.finishedAt = nowMs()
        },
        (error) => {
          const normalized = normalizeError(error)
          job.status = 'failed'
          job.error = { code: normalized.code, message: normalized.message }
          job.finishedAt = nowMs()
          logger?.warn?.(`httpapi: job ${action} failed: ${normalized.message}`)
        },
      )
      .catch(() => {})
    return job
  }

  function listJobs(limit) {
    return [...jobs.values()].slice(Math.max(0, jobs.size - limit))
  }

  // ---------------------------------------------------------------- projects

  async function resolveProject(projectId) {
    const projects = lookup('projects')
    if (projects === null) throw unavailable('projects')
    const wanted = text(projectId) ?? (typeof projects.activeId === 'function' ? projects.activeId() : null)
    if (wanted === null || wanted === undefined || wanted === '') return null
    const project = typeof projects.get === 'function' ? projects.get(wanted) : null
    return project ?? null
  }

  function requireProjectPath(project) {
    if (project === null || typeof project.path !== 'string' || project.path.trim() === '') {
      throw badRequest('no project selected: add a project first (POST /project/add)')
    }
    return project.path
  }

  function emptyDiscovery() {
    return { configs: [], entries: [], devices: [], emulators: [], flavors: [], launchFile: null, warnings: [] }
  }

  function normalizeDiscovery(result) {
    const base = emptyDiscovery()
    if (isPlainObject(result)) {
      for (const key of ['configs', 'entries', 'devices', 'emulators', 'flavors']) {
        base[key] = Array.isArray(result[key]) ? result[key] : []
      }
      base.launchFile = typeof result.launchFile === 'string' ? result.launchFile : null
      base.warnings = Array.isArray(result.warnings) ? result.warnings.map((item) => String(item)) : []
    }
    return base
  }

  /** Project discovery through `host/runconfig.js`; device lists fall back to the toolchain. */
  async function discoverProject(projectPath) {
    if (projectPath === null) {
      const base = emptyDiscovery()
      base.warnings.push('no project selected')
      return base
    }
    const discovered = emptyDiscovery()
    const flutterPath = text(await safeValue(() => lookup('settings')?.get?.()?.flutterPath, ''))
    if (typeof runconfig.discoverConfigs === 'function') {
      try {
        const result = await runconfig.discoverConfigs({
          projectPath,
          ...(flutterPath === undefined ? {} : { flutterPath }),
        })
        Object.assign(discovered, normalizeDiscovery(result))
      } catch (error) {
        discovered.warnings.push(`config discovery failed: ${normalizeError(error).message}`)
      }
    } else {
      discovered.warnings.push('runconfig module is unavailable')
    }
    const toolchain = lookup('toolchain')
    if (discovered.devices.length === 0 && typeof toolchain?.devices === 'function') {
      discovered.devices = (await safeValue(() => toolchain.devices({}), [])) ?? []
    }
    if (discovered.emulators.length === 0 && typeof toolchain?.emulators === 'function') {
      discovered.emulators = (await safeValue(() => toolchain.emulators({}), [])) ?? []
    }
    return discovered
  }

  /** Build the RunConfig the runner expects out of a base config + explicit overrides. */
  function materializeRunConfig(base, body, configId) {
    const explicit = {}
    const program = text(body.program)
    if (program !== undefined) explicit.program = program
    const deviceId = text(body.deviceId)
    if (deviceId !== undefined) explicit.deviceId = deviceId
    const mode = text(body.mode)
    if (mode !== undefined) {
      if (RUN_MODES.includes(mode) === false) throw badRequest(`mode must be one of ${RUN_MODES.join(', ')}`)
      explicit.mode = mode
    }
    if (Object.prototype.hasOwnProperty.call(body, 'flavor')) explicit.flavor = body.flavor === null ? null : text(body.flavor) ?? null
    if (isPlainObject(body.dartDefines)) explicit.dartDefines = stringMap(body.dartDefines)
    if (Array.isArray(body.args)) explicit.args = body.args.map((item) => String(item))
    if (isPlainObject(body.env)) explicit.env = stringMap(body.env)

    const resolved = {
      id: typeof base?.id === 'string' ? base.id : (configId ?? 'manual'),
      label: typeof base?.label === 'string' ? base.label : `manual · ${explicit.program ?? 'lib/main.dart'}`,
      source: base?.source === 'launch.json' || base?.source === 'entry' ? base.source : 'manual',
      program: typeof base?.program === 'string' ? base.program : '',
      deviceId: typeof base?.deviceId === 'string' ? base.deviceId : '',
      mode: RUN_MODES.includes(base?.mode) ? base.mode : 'debug',
      flavor: typeof base?.flavor === 'string' ? base.flavor : null,
      dartDefines: isPlainObject(base?.dartDefines) ? { ...base.dartDefines } : {},
      args: Array.isArray(base?.args) ? [...base.args] : [],
      env: isPlainObject(base?.env) ? { ...base.env } : {},
      ...explicit,
    }
    if (resolved.program.trim() === '') {
      throw badRequest('program is required: pass `program` or a `configId` from GET /configs')
    }
    return resolved
  }

  // ------------------------------------------------------------- screenshots

  function screenshotsDir() {
    let root = ''
    const settingsView = mcpSettings()
    if (typeof settingsView.dataDir === 'string') root = settingsView.dataDir.trim()
    if (root === '') root = String(lookup('store')?.dir ?? '').trim()
    if (root === '') root = join(homedir(), '.dsh', 'flutter-workbench')
    return join(root, 'screenshots')
  }

  function decodeScreenshot(input) {
    const raw = typeof input === 'string' ? input.trim() : ''
    if (raw === '') throw Object.assign(new Error('VM Service returned no screenshot data'), { code: 'no-data' })
    const dataUrl = /^data:([^;,]+)?;base64,(.*)$/s.exec(raw)
    const mime = dataUrl?.[1] ?? ''
    const payload = (dataUrl === null ? raw : dataUrl[2]).replace(/\s+/g, '')
    const buffer = Buffer.from(payload, 'base64')
    if (buffer.length === 0) throw Object.assign(new Error('screenshot payload is empty'), { code: 'no-data' })
    return { buffer, mime }
  }

  /** PNG/JPEG size probe; anything else is written as-is with a `.png` name. */
  function imageMeta(buffer, reportedMime) {
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    if (buffer.length >= 24 && buffer.subarray(0, 8).equals(pngSignature)) {
      return { mime: 'image/png', ext: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
    }
    if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) return { mime: 'image/jpeg', ext: 'jpg' }
    return { mime: reportedMime === '' ? 'image/png' : reportedMime, ext: 'png' }
  }

  function fileStamp() {
    return new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '')
  }

  /** `path` or `path:line`, the form every editor accepts. */
  function fileLocation(file, line) {
    return line === null || line === undefined ? file : `${file}:${line}`
  }

  /**
   * Serve one already-written screenshot as raw bytes. Confined to the
   * screenshots directory so a crafted `?path=` cannot read anything else.
   */
  async function serveScreenshotFile(rawPath) {
    const requested = text(rawPath)
    if (requested === undefined) throw badRequest('path is required')
    const root = resolve(screenshotsDir())
    const target = isAbsolute(requested) ? resolve(requested) : resolve(root, requested)
    const inside = relative(root, target)
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
      logger?.warn?.(`httpapi: refused to serve ${requested} outside the screenshots directory`)
      throw Object.assign(new Error('only screenshots written by the workbench can be served'), { code: 'forbidden' })
    }
    const data = await readFile(target).catch((error) => {
      if (error?.code === 'ENOENT') throw notFound(`no such screenshot: ${target}`)
      throw error
    })
    const meta = imageMeta(data, '')
    return {
      status: 200,
      headers: {
        'content-type': meta.mime,
        'content-length': String(data.length),
        'cache-control': 'private, max-age=60',
        'x-content-type-options': 'nosniff',
      },
      body: data,
    }
  }

  // ----------------------------------------------------------------- routes

  /** @type {Map<string, (input: any) => Promise<any>>} */
  const routes = new Map()
  const route = (method, path, run) => routes.set(`${method} ${path}`, run)

  route('GET', '/health', async () => {
    const warnings = Array.isArray(services?.warnings) ? services.warnings : []
    const failed = new Set(warnings.map((item) => (isPlainObject(item) ? item.subsystem : null)))
    const available = (subsystem, serviceName) => lookup(serviceName ?? subsystem) !== null && failed.has(subsystem) === false
    return {
      status: 200,
      headers: {},
      body: {
        ok: true,
        version: String(services?.version ?? ''),
        uptimeMs: Math.max(0, nowMs() - Number(services?.bootedAt ?? startedAt)),
        services: {
          runner: available('runner'),
          vm: available('vmservice', 'vm'),
          board: available('board'),
          toolchain: available('toolchain'),
          mcp: available('mcp'),
        },
        warnings,
      },
    }
  })

  route('GET', '/state', async () => {
    const projects = lookup('projects')
    const runner = lookup('runner')
    const board = lookup('board')
    const logs = lookup('logs')
    const network = lookup('network')
    const errors = lookup('errors')
    const state = await safeValue(() => runner?.state?.({}), { runs: [], activeRunId: null }, null)
    const snapshot = await safeValue(() => board?.snapshot?.(), null, null)
    const logCounts = await safeValue(() => logs?.counts?.(), null, null)
    const networkTotal = await safeValue(async () => (await network?.query?.({ limit: 1 }))?.total ?? 0, 0, null)
    const errorTotal = await safeValue(async () => (await errors?.query?.({ limit: 1 }))?.total ?? 0, 0, null)
    return {
      status: 200,
      headers: {},
      body: {
        ok: true,
        projects: (await safeValue(() => projects?.list?.(), [], null)) ?? [],
        activeProjectId: (await safeValue(() => projects?.activeId?.(), null, null)) ?? null,
        runs: Array.isArray(state?.runs) ? state.runs : [],
        activeRunId: state?.activeRunId ?? null,
        settings: mcpSettings(),
        board: snapshot ?? { lanes: [], tasks: [], counts: {} },
        counters: {
          logs: logCounts ?? { byLevel: {}, bySource: {}, total: 0 },
          network: { total: Number(networkTotal) || 0 },
          errors: { total: Number(errorTotal) || 0 },
          jobs: jobs.size,
        },
      },
    }
  })

  route('POST', '/project/add', async ({ body }) => {
    const payload = isPlainObject(body) ? body : {}
    const path = text(payload.path)
    if (path === undefined) throw badRequest('path is required')
    const project = await require('projects').add({ path })
    return { status: 200, headers: {}, body: { ok: true, project } }
  })

  route('POST', '/project/remove', async ({ body }) => {
    const payload = isPlainObject(body) ? body : {}
    const id = text(payload.id)
    if (id === undefined) throw badRequest('id is required')
    const result = await require('projects').remove(id)
    return { status: 200, headers: {}, body: { ok: true, removed: result?.removed === true } }
  })

  route('POST', '/project/select', async ({ body }) => {
    const payload = isPlainObject(body) ? body : {}
    const id = text(payload.id)
    if (id === undefined) throw badRequest('id is required')
    const activeProjectId = await require('projects').select(id)
    return { status: 200, headers: {}, body: { ok: true, activeProjectId } }
  })

  route('GET', '/configs', async ({ query }) => {
    const project = await resolveProject(query.get('projectId'))
    const projectPath = project !== null && typeof project.path === 'string' ? project.path : null
    const discovered = await discoverProject(projectPath)
    if (discovered.flavors.length === 0 && Array.isArray(project?.detected?.flavors)) discovered.flavors = project.detected.flavors
    return { status: 200, headers: {}, body: { ok: true, ...discovered } }
  })

  route('POST', '/run/start', async ({ body }) => {
    const payload = isPlainObject(body) ? body : {}
    const project = await resolveProject(payload.projectId)
    const projectPath = requireProjectPath(project)
    const configId = text(payload.configId)
    let base = null
    if (configId !== undefined) {
      const discovered = await discoverProject(projectPath)
      base = discovered.configs.find((config) => config !== null && typeof config === 'object' && config.id === configId) ?? null
      if (base === null) throw notFound(`unknown run config: ${configId}`)
    }
    const config = materializeRunConfig(base, payload, configId)
    const started = await require('runner').start({ projectPath, projectId: project.id, config })
    const runId = typeof started?.runId === 'string' ? started.runId : config.id
    const state = await safeValue(() => lookup('runner')?.state?.(runId === undefined ? {} : { runId }), { runs: [] }, null)
    const runs = Array.isArray(state?.runs) ? state.runs : []
    const run = runs.find((item) => item?.runId === runId) ?? runs[runs.length - 1] ?? null
    await safeValue(() => lookup('projects')?.touch?.(project.id), null, null)
    return { status: 200, headers: {}, body: { ok: true, runId, run } }
  })

  route('POST', '/run/stop', async ({ body }) => {
    const payload = isPlainObject(body) ? body : {}
    const result = await require('runner').stop({ runId: text(payload.runId), force: payload.force === true })
    const stopped = Array.isArray(result?.stopped) ? result.stopped : []
    return { status: 200, headers: {}, body: { ok: true, stopped } }
  })

  route('POST', '/run/reload', async ({ body }) => {
    const payload = isPlainObject(body) ? body : {}
    const result = await require('runner').hotReload({ runId: text(payload.runId) })
    return {
      status: 200,
      headers: {},
      body: { ok: result?.ok !== false, message: String(result?.message ?? ''), runId: result?.runId ?? null },
    }
  })

  route('POST', '/run/restart', async ({ body }) => {
    const payload = isPlainObject(body) ? body : {}
    const result = await require('runner').hotRestart({ runId: text(payload.runId) })
    return {
      status: 200,
      headers: {},
      body: { ok: result?.ok !== false, message: String(result?.message ?? ''), runId: result?.runId ?? null },
    }
  })

  route('GET', '/logs', async ({ query }) => {
    const result = await require('logs').query({
      since: query.int('since', 0, { min: 0 }),
      limit: query.int('limit', 500, { min: 1, max: 20000 }),
      level: query.text('level'),
      levels: query.all('levels'),
      source: query.text('source'),
      sources: query.all('sources'),
      pattern: query.text('pattern'),
      runId: query.text('runId'),
    })
    return {
      status: 200,
      headers: {},
      body: {
        ok: true,
        entries: Array.isArray(result?.entries) ? result.entries : [],
        nextCursor: Number.isFinite(Number(result?.nextCursor)) ? Number(result.nextCursor) : 0,
        total: Number.isFinite(Number(result?.total)) ? Number(result.total) : 0,
      },
    }
  })

  route('POST', '/logs/mark', async ({ body }) => {
    // Time-correlation marker: the panel and the flutter_log_mark tool both use
    // it, then read the slice with GET /logs?since=<seq>.
    const payload = isPlainObject(body) ? body : {}
    const entry = require('logs').mark(text(payload.text))
    return {
      status: 200,
      headers: {},
      body: { ok: true, seq: Number.isFinite(Number(entry?.seq)) ? Number(entry.seq) : null },
    }
  })

  route('GET', '/errors', async ({ query }) => {
    const result = await require('errors').query({
      since: query.int('since', 0, { min: 0 }),
      limit: query.int('limit', 100, { min: 1, max: 2000 }),
      kind: query.text('kind'),
      pattern: query.text('pattern'),
      runId: query.text('runId'),
    })
    return {
      status: 200,
      headers: {},
      body: {
        ok: true,
        groups: Array.isArray(result?.groups) ? result.groups : [],
        nextCursor: Number.isFinite(Number(result?.nextCursor)) ? Number(result.nextCursor) : 0,
        total: Number.isFinite(Number(result?.total)) ? Number(result.total) : 0,
      },
    }
  })

  route('GET', '/network', async ({ query }) => {
    const result = await require('network').query({
      since: query.int('since', 0, { min: 0 }),
      limit: query.int('limit', 100, { min: 1, max: 2000 }),
      status: query.text('status'),
      method: query.text('method'),
      host: query.text('host'),
      pattern: query.text('pattern'),
      runId: query.text('runId'),
      errorsOnly: query.bool('errorsOnly', false),
    })
    return {
      status: 200,
      headers: {},
      body: {
        ok: true,
        entries: Array.isArray(result?.entries) ? result.entries : [],
        nextCursor: Number.isFinite(Number(result?.nextCursor)) ? Number(result.nextCursor) : 0,
        total: Number.isFinite(Number(result?.total)) ? Number(result.total) : 0,
      },
    }
  })

  route('POST', '/network/detail', async ({ body }) => {
    const payload = isPlainObject(body) ? body : {}
    const id = text(payload.id)
    if (id === undefined) throw badRequest('id is required')
    const request = await require('network').detail({ id, runId: text(payload.runId) })
    return { status: 200, headers: {}, body: { ok: true, request: request ?? null } }
  })

  // Extension (requested by the panel): clear the buffered HTTP traffic.
  route('POST', '/network/clear', async () => {
    require('network').clear()
    return { status: 200, headers: {}, body: { ok: true } }
  })

  route('POST', '/toolchain', async ({ body }) => {
    const payload = isPlainObject(body) ? body : {}
    const action = text(payload.action)
    if (action === undefined || TOOLCHAIN_ACTIONS.includes(action) === false) {
      throw badRequest(`action must be one of ${TOOLCHAIN_ACTIONS.join(', ')}`)
    }
    const toolchain = require('toolchain')
    const needsProject = action !== 'doctor'
    let projectPath = null
    if (needsProject) {
      const project = await resolveProject(payload.projectId)
      projectPath = requireProjectPath(project)
    }
    if (action === 'build') {
      const target = text(payload.target) ?? 'apk'
      if (BUILD_TARGETS.includes(target) === false) throw badRequest(`target must be one of ${BUILD_TARGETS.join(', ')}`)
    }
    const job = startJob(action, () => {
      switch (action) {
        case 'analyze':
          return toolchain.analyze({ projectPath })
        case 'test':
          return toolchain.test({ projectPath, target: text(payload.target), name: text(payload.name) })
        case 'pubGet':
          return toolchain.pubGet({ projectPath })
        case 'clean':
          return toolchain.clean({ projectPath })
        case 'build':
          return toolchain.build({ projectPath, target: text(payload.target) ?? 'apk' })
        case 'doctor':
          return toolchain.doctor({})
        case 'format':
          return toolchain.format({ projectPath, paths: Array.isArray(payload.paths) ? payload.paths.map(String) : undefined })
        default:
          throw badRequest(`unsupported action: ${action}`)
      }
    })
    return { status: 200, headers: {}, body: { ok: true, jobId: job.id, job: { ...job } } }
  })

  route('GET', '/job', async ({ query }) => {
    const id = query.text('id')
    if (id === undefined) throw badRequest('id is required')
    const job = jobs.get(id)
    if (job === undefined) throw notFound(`unknown job: ${id}`)
    return { status: 200, headers: {}, body: { ok: true, job: { ...job } } }
  })

  route('GET', '/jobs', async ({ query }) => {
    const limit = query.int('limit', MAX_JOBS, { min: 1, max: MAX_JOBS })
    return { status: 200, headers: {}, body: { ok: true, jobs: listJobs(limit).map((job) => ({ ...job })) } }
  })

  route('POST', '/screenshot', async ({ body }) => {
    const payload = isPlainObject(body) ? body : {}
    const vm = require('vm')
    const shot = await vm.screenshot({ runId: text(payload.runId) })
    const raw = typeof shot === 'string' ? shot : (shot?.base64 ?? shot?.data ?? '')
    const decoded = decodeScreenshot(raw)
    const meta = imageMeta(decoded.buffer, declaredMime(decoded.mime, shot?.mime))
    const dir = screenshotsDir()
    await mkdir(dir, { recursive: true })
    const file = join(dir, `screenshot-${fileStamp()}-${uid('shot')}.${meta.ext}`)
    await writeFile(file, decoded.buffer)
    /** The base64 payload never leaves the host: only the saved path. */
    return {
      status: 200,
      headers: {},
      body: {
        ok: true,
        path: file,
        bytes: decoded.buffer.length,
        ...(meta.width === undefined ? {} : { width: meta.width, height: meta.height }),
      },
    }
  })

  // Extension (requested by the panel): raw bytes for a saved screenshot.
  // `POST /screenshot` can only answer with a filesystem path and the browser
  // cannot read `file://`, so the page fetches the PNG through this route.
  // Both spellings are served so the client can try them in order.
  route('GET', '/file', async ({ query }) => serveScreenshotFile(query.get('path')))
  route('GET', '/screenshot/file', async ({ query }) => serveScreenshotFile(query.get('path')))

  // Extension (requested by the panel): frame/jank stats for the Quality page.
  route('GET', '/perf', async ({ query }) => {
    const vm = require('vm')
    const result = await vm.frameStats({ runId: query.text('runId') })
    return {
      status: 200,
      headers: {},
      body: {
        ok: true,
        perf: {
          frames: Array.isArray(result?.frames) ? result.frames : [],
          jankCount: Number(result?.jankCount) || 0,
          worstMs: Number(result?.worstMs) || 0,
        },
      },
    }
  })

  // Extension (requested by the panel): jump to `file:line` in the editor.
  // `services.openFile` wins when the host wires one; otherwise the configured
  // editor command is spawned detached (no shell, so no injection).
  route('POST', '/open', async ({ body }) => {
    const payload = isPlainObject(body) ? body : {}
    const file = text(payload.file)
    if (file === undefined) throw badRequest('file is required')
    const line = payload.line === undefined ? null : intOf(payload.line, 1, { min: 1, max: 10_000_000 })
    const hook = lookup('openFile')
    if (typeof hook === 'function') {
      const opened = await hook({ file, line })
      return { status: 200, headers: {}, body: { ok: true, opened: typeof opened === 'string' ? opened : fileLocation(file, line) } }
    }
    const project = await resolveProject(payload.projectId)
    const base = project !== null && typeof project.path === 'string' ? project.path : process.cwd()
    const target = isAbsolute(file) ? resolve(file) : resolve(base, file)
    const info = await stat(target).catch(() => null)
    if (info === null || info.isFile() === false) throw notFound(`file not found: ${target}`)
    const [command, ...args] = (text(mcpSettings().editorCommand) ?? 'code').split(/\s+/).filter(Boolean)
    if (command === undefined) throw badRequest('editorCommand is empty; set it in settings')
    const where = fileLocation(target, line)
    try {
      const child = spawn(command, [...args, where], { detached: true, stdio: 'ignore', windowsHide: true })
      child.on('error', (error) => logger?.warn?.(`httpapi: cannot open the editor: ${normalizeError(error).message}`))
      child.unref()
    } catch (error) {
      logger?.warn?.(`httpapi: cannot open the editor: ${normalizeError(error).message}`)
      throw Object.assign(new Error(`cannot open the editor (${command}): ${normalizeError(error).message}`), { code: 'bad-request' })
    }
    return { status: 200, headers: {}, body: { ok: true, opened: where } }
  })

  route('GET', '/board', async () => {
    const board = await require('board').snapshot()
    return { status: 200, headers: {}, body: { ok: true, board: board ?? { lanes: [], tasks: [], counts: {} } } }
  })

  route('POST', '/board/task', async ({ body }) => {
    const payload = isPlainObject(body) ? body : {}
    const board = require('board')
    const action = text(payload.action) ?? 'create'
    const snapshot = async () => (await safeValue(() => board.snapshot?.(), null, null)) ?? { lanes: [], tasks: [], counts: {} }
    if (action === 'create') {
      const input = isPlainObject(payload.task) ? payload.task : omitKeys(payload, ['action'])
      const task = await board.addTask(input)
      return { status: 200, headers: {}, body: { ok: true, task, board: await snapshot() } }
    }
    const id = text(payload.id)
    if (id === undefined) throw badRequest(`id is required for action ${action}`)
    if (action === 'update') {
      const patch = isPlainObject(payload.patch)
        ? payload.patch
        : isPlainObject(payload.task)
          ? payload.task
          : omitKeys(payload, ['action', 'id', 'patch'])
      const task = await board.updateTask({ id, patch })
      return { status: 200, headers: {}, body: { ok: true, task, board: await snapshot() } }
    }
    if (action === 'move') {
      const lane = text(payload.lane)
      if (lane === undefined) throw badRequest('lane is required for action move')
      const task = await board.moveTask({
        id,
        lane,
        ...(payload.index === undefined ? {} : { index: intOf(payload.index, 0, { min: 0 }) }),
        force: payload.force === true,
      })
      return { status: 200, headers: {}, body: { ok: true, task, board: await snapshot() } }
    }
    if (action === 'delete') {
      const result = await board.removeTask({ id })
      return { status: 200, headers: {}, body: { ok: true, removed: result?.removed === true, board: await snapshot() } }
    }
    if (action === 'archive') {
      const result = await board.archiveDone()
      return { status: 200, headers: {}, body: { ok: true, archived: Number(result?.archived) || 0, board: await snapshot() } }
    }
    throw badRequest(`action must be one of create, update, move, delete, archive (got ${action})`)
  })

  route('POST', '/board/decompose', async ({ body }) => {
    const payload = isPlainObject(body) ? body : {}
    const prompt = text(payload.prompt)
    if (prompt === undefined) throw badRequest('prompt is required')
    const result = await require('board').decompose({
      prompt,
      projectId: text(payload.projectId),
      ...(payload.maxTasks === undefined ? {} : { maxTasks: intOf(payload.maxTasks, 6, { min: 1, max: 50 }) }),
    })
    return { status: 200, headers: {}, body: { ok: true, tasks: Array.isArray(result?.tasks) ? result.tasks : [] } }
  })

  route('POST', '/board/plan', async ({ body }) => {
    // One sentence in, a whole board out — as a background job so the panel
    // never blocks for the minute an agent needs to think.
    const payload = isPlainObject(body) ? body : {}
    const prompt = text(payload.prompt)
    if (prompt === undefined) throw badRequest('prompt is required')
    const board = require('board')
    const job = startJob('board.plan', () => board.decompose({
      prompt,
      projectId: text(payload.projectId),
      ...(payload.maxTasks === undefined ? {} : { maxTasks: intOf(payload.maxTasks, 6, { min: 1, max: 50 }) }),
      ...(text(payload.provider) === undefined ? {} : { provider: text(payload.provider) }),
      ...(text(payload.model) === undefined ? {} : { model: text(payload.model) }),
    }))
    return { status: 200, headers: {}, body: { ok: true, jobId: job.id, status: job.status } }
  })

  route('POST', '/board/refine', async ({ body }) => {
    // The AI rewrites one card's fields; also a job because a model turn is slow.
    const payload = isPlainObject(body) ? body : {}
    const id = text(payload.id)
    if (id === undefined) throw badRequest('id is required')
    const prompt = text(payload.prompt)
    if (prompt === undefined) throw badRequest('prompt is required')
    const board = require('board')
    const job = startJob('board.refine', () => board.refine({
      id,
      prompt,
      ...(text(payload.provider) === undefined ? {} : { provider: text(payload.provider) }),
      ...(text(payload.model) === undefined ? {} : { model: text(payload.model) }),
    }))
    return { status: 200, headers: {}, body: { ok: true, jobId: job.id, status: job.status } }
  })

  route('POST', '/board/dispatch', async ({ body }) => {
    const payload = isPlainObject(body) ? body : {}
    const id = text(payload.id)
    if (id === undefined) throw badRequest('id is required')
    const result = await require('board').dispatch({ id, provider: text(payload.provider), model: text(payload.model) })
    return { status: 200, headers: {}, body: { ok: true, sessionId: result?.sessionId ?? null, task: result?.task ?? null } }
  })

  route('POST', '/board/report', async ({ body }) => {
    const payload = isPlainObject(body) ? body : {}
    const id = text(payload.id)
    if (id === undefined) throw badRequest('id is required')
    const status = text(payload.status)
    if (status === undefined) throw badRequest('status is required')
    const task = await require('board').report({
      id,
      status,
      summary: String(payload.summary ?? ''),
      commandsRun: Array.isArray(payload.commandsRun) ? payload.commandsRun : [],
      evidence: Array.isArray(payload.evidence) ? payload.evidence.map(String) : [],
      files: Array.isArray(payload.files) ? payload.files.map(String) : [],
      verdict: payload.verdict === 'pass' || payload.verdict === 'fail' ? payload.verdict : null,
      note: text(payload.note) ?? null,
    })
    return { status: 200, headers: {}, body: { ok: true, task } }
  })

  // Extension (requested by the panel): drop the agent attached to one card.
  route('POST', '/board/cancel', async ({ body }) => {
    const payload = isPlainObject(body) ? body : {}
    const id = text(payload.id)
    if (id === undefined) throw badRequest('id is required')
    const task = await require('board').cancelAgent({ id })
    return { status: 200, headers: {}, body: { ok: true, task: task ?? null } }
  })

  route('GET', '/settings', async () => ({ status: 200, headers: {}, body: { ok: true, settings: settingsView(), descriptor: settingsDescriptor() } }))

  route('POST', '/settings', async ({ body }) => {
    const payload = isPlainObject(body) ? body : {}
    const settings = require('settings')
    const patch = isPlainObject(payload.patch) ? payload.patch : omitKeys(payload, ['patch'])
    await settings.save(patch)
    return { status: 200, headers: {}, body: { ok: true, settings: settingsView(), descriptor: settingsDescriptor() } }
  })

  // Extension (requested by the panel): a fresh MCP bearer token.
  route('POST', '/settings/rotate-token', async () => {
    const settings = require('settings')
    if (typeof settings.rotateMcpToken !== 'function') {
      throw Object.assign(new Error('settings service cannot rotate the MCP token'), { code: 'service-unavailable' })
    }
    const mcpToken = await settings.rotateMcpToken()
    return { status: 200, headers: {}, body: { ok: true, mcpToken, settings: settingsView() } }
  })

  function settingsView() {
    const settings = require('settings')
    const view = typeof settings.redacted === 'function' ? settings.redacted() : settings.get()
    return isPlainObject(view) ? view : {}
  }

  /** Typed control metadata for the settings page (`SETTING_SPEC`). */
  function settingsDescriptor() {
    const settings = lookup('settings')
    if (typeof settings?.descriptor !== 'function') return {}
    try {
      const value = settings.descriptor()
      return isPlainObject(value) ? value : {}
    } catch {
      return {}
    }
  }

  function declaredMime(reported, fromShot) {
    if (typeof reported === 'string' && reported !== '') return reported
    if (typeof fromShot === 'string') return fromShot
    return ''
  }

  // ------------------------------------------------------------ dispatching

  const methodsByPath = new Map()
  for (const key of routes.keys()) {
    const [method, path] = key.split(' ')
    const list = methodsByPath.get(path) ?? []
    list.push(method)
    methodsByPath.set(path, list)
  }

  function notFoundResponse(id) {
    return { status: 404, headers: {}, body: { ok: false, code: 'not-found', message: `unknown route: ${id}` } }
  }

  function methodResponse(method, id) {
    const allow = methodsByPath.get(id) ?? []
    return {
      status: 405,
      headers: { allow: allow.join(', ') },
      body: { ok: false, code: 'method', message: `${method} is not allowed on ${id}` },
    }
  }

  /**
   * Dispatch one already-parsed request. Never throws.
   *
   * @param {{ method?: string, path: string, query?: any, body?: any, headers?: Record<string, any> }} input
   * @returns {Promise<{ status: number, headers?: Record<string, string>, body: any }>}
   */
  async function handle(input) {
    const method = String(input?.method ?? 'GET').toUpperCase()
    const id = routeId(input?.path)
    const query = createQuery(input?.query)
    const headers = isPlainObject(input?.headers) ? input.headers : {}
    const rawBody = input?.body
    // Every non-MCP path is a panel/browser path, so it answers to the host
    // fence. `/mcp` authenticates with the plugin token instead (below).
    if (id !== '/mcp') {
      const verdict = fenceVerdict(headers)
      if (verdict !== null) {
        return {
          status: verdict,
          headers: {},
          body: {
            ok: false,
            code: verdict === 401 ? 'unauthenticated' : 'forbidden',
            message: verdict === 401 ? 'DSH 登录已失效：请重新打开 dsh web 启动时打印的网址。' : '请求来源不受信任，已拒绝。',
          },
        }
      }
    }
    try {
      if (id === '/mcp') return await handleMcp({ method, query, headers, body: rawBody })
      const run = routes.get(`${method} ${id}`)
      if (run === undefined) return methodsByPath.has(id) ? methodResponse(method, id) : notFoundResponse(id)
      const result = await run({ method, path: id, query, headers, body: rawBody })
      return result ?? { status: 200, headers: {}, body: { ok: true } }
    } catch (error) {
      const normalized = normalizeError(error)
      const status = STATUS_BY_CODE[normalized.code] ?? 500
      if (status >= 500) logger?.error?.(`httpapi: ${method} ${id} failed: ${normalized.message}`)
      return { status, headers: {}, body: { ok: false, code: normalized.code, message: normalized.message } }
    }
  }

  // --------------------------------------------------------- HTTP transport

  /**
   * Node request handler for the registered prefix route.
   * @param {import('node:http').IncomingMessage} request incoming request.
   * @param {import('node:http').ServerResponse} response response.
   * @returns {Promise<void>} resolves after responding.
   */
  async function handler(request, response) {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      url.pathname = resolveAliasPath(url.pathname)
      const id = routeId(url.pathname)
      const isMcp = id === '/mcp'

      if (isMcp === false) {
        const rejection = fenceVerdict(request.headers)
        if (rejection !== null) {
          sendJson(response, rejection, {
            ok: false,
            code: rejection === 401 ? 'unauthenticated' : 'forbidden',
            message: rejection === 401 ? 'DSH 登录已失效：请重新打开 dsh web 启动时打印的网址。' : '请求来源不受信任，已拒绝。',
          })
          return
        }
      }

      let body = {}
      if (request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH') {
        let raw = ''
        try {
          raw = await readBody(request, MAX_BODY_BYTES)
        } catch (error) {
          const normalized = normalizeError(error)
          const tooLarge = normalized.code === 'too-large'
          sendJson(response, tooLarge ? 413 : 400, {
            ok: false,
            code: tooLarge ? 'too-large' : 'bad-body',
            message: tooLarge ? `请求体超过 ${MAX_BODY_BYTES} 字节上限` : normalized.message,
          })
          return
        }
        if (raw.trim() !== '') {
          const parsed = safeJson(raw, MISSING)
          if (parsed === MISSING) {
            sendJson(response, 400, { ok: false, code: 'bad-json', message: '请求体不是合法 JSON' })
            return
          }
          body = parsed
        }
      }

      const result = await handle({
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        body,
        headers: request.headers,
      })

      if (result.status === 304) {
        response.writeHead(304, { ...(result.headers ?? {}), 'cache-control': 'no-store' })
        response.end()
        return
      }
      if (Buffer.isBuffer(result.body)) {
        // Raw bytes (saved screenshots): never JSON-encode them.
        response.writeHead(result.status, { 'cache-control': 'no-store', ...(result.headers ?? {}) })
        response.end(result.body)
        return
      }
      if (result.body === null || result.body === undefined || result.status === 204) {
        response.writeHead(result.status, { 'cache-control': 'no-store', ...(result.headers ?? {}) })
        response.end()
        return
      }
      sendJson(response, result.status, result.body, result.headers ?? {})
    } catch (error) {
      const normalized = normalizeError(error)
      logger?.error?.(`httpapi: handler failed: ${normalized.message}`)
      try {
        sendJson(response, 500, { ok: false, code: normalized.code, message: normalized.message })
      } catch {
        /* the socket is already gone */
      }
    }
  }

  /**
   * Register the single prefix route (idempotent: a second attach is a no-op).
   * @param {any} [context] plugin context; defaults to the one given at creation.
   * @returns {() => void} disposer removing the route.
   */
  function attach(context) {
    if (activeDisposer !== null) return activeDisposer
    const target = context ?? baseCtx
    const server = typeof target?.get === 'function' ? target.get('webServer') : undefined
    if (server === undefined || server === null || typeof server.register !== 'function') {
      logger?.warn?.('httpapi: webServer unavailable; the panel will stay without data')
      return () => {}
    }
    const unregister = server.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
    // Second ingress outside `/api`: the DSH web carrier fences every `/api/*`
    // request with a login cookie, so cookie-less MCP clients only reach us here.
    let unregisterAlias = null
    try {
      unregisterAlias = server.register({ kind: 'prefix', path: ALT_PREFIX, handler })
    } catch (aliasError) {
      logger?.warn?.(`httpapi: alias route unavailable: ${normalizeError(aliasError).message}`)
    }
    let disposed = false
    const disposer = () => {
      if (disposed) return
      disposed = true
      activeDisposer = null
      try {
        if (typeof unregisterAlias === 'function') unregisterAlias()
        if (typeof unregister === 'function') unregister()
      } catch (error) {
        logger?.warn?.(`httpapi: route removal failed: ${normalizeError(error).message}`)
      }
    }
    activeDisposer = disposer
    return disposer
  }

  /** Remove the route (plugin unload); safe to call twice. */
  function dispose() {
    const disposer = activeDisposer
    activeDisposer = null
    if (typeof disposer === 'function') {
      try {
        disposer()
      } catch {
        /* teardown is best effort */
      }
    }
  }

  return { handle, attach, dispose, ROUTE_PREFIX, MCP_PATH, ALT_PREFIX }
}