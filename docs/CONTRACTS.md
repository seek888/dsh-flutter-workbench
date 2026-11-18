# CONTRACTS — dsh-flutter-workbench

Authoritative interface contract for every module in this bundle. **Read your
module's section before writing code. Do not change a shared shape without
telling the Lead.** `docs/FEATURE-SPEC.md` (research deliverable) may propose
more features; this file is what compiles and what the UI/API actually expose.

---

## 0. Product in one paragraph

A full-page DSH panel (`main` slot key `flutter-workbench`, plus a sidebar
`.panellist` icon) that runs Flutter projects on this machine, talks to the Dart
VM Service over WebSocket, and gives both the human and the AI a single place to
see: process state, structured logs, HTTP traffic, exceptions, analyzer/test
results, screenshots, and a kanban board whose cards an agent can execute. The
same capabilities are exposed as DSH tools and as an HTTP MCP server.

## 1. Hard rules for every contributor

1. **Plain JavaScript, ESM, zero dependencies.** No TypeScript, no bundler, no
   npm packages. Host half: Node ESM (`import`/`export`). Client half: plain
   functions concatenated by `scripts/build-client.mjs`.
2. **Never edit a file you do not own** (table below). Never edit
   `client/client.js` by hand — it is generated.
3. Host files must pass `node --check`. Client fragments must pass
   `node --check` after being wrapped (the build script checks).
4. Every new behavior needs a test under `test/` that runs with
   `node --test test/<file>.test.mjs` and prints nothing on success except TAP.
   Tests must not require Flutter, the network, or a GUI.
5. Defensive service access: `ctx.get('name')` + undefined check. Never let a
   missing optional service throw during `apply`.
6. No `console.log` in library code. Host logs go through the injected
   `logger`; client logs through the `console` builtin only for real errors.
7. Only `--dsw-alias-*` / `--dsw-radius-*` CSS tokens for color/radius in the
   panel. Literal colors only inside `icon.svg`.
8. All UI text goes through the locale dictionaries in `client/src/00-prelude.js`
   (`t('key')`), with both `zh` and `en` entries.
9. When you finish: `node --check` your files, run your tests, and report
   `{ files, tests, verified, open questions }`.

## 2. File ownership

| Path | Owner | Purpose |
|---|---|---|
| `package.json`, `cordis.patch.yml`, `index.js`, `scripts/*`, `locale/*`, `icon.svg`, `docs/CONTRACTS.md` | Lead | manifest, wiring, build, i18n metadata |
| `host/util.js`, `host/store.js`, `host/logs.js` | Lead | foundation (emitter, helpers, JSON store, log ring) |
| `host/runconfig.js`, `host/runner.js` | dev-runner | project/config discovery, process + flutter machine protocol |
| `host/ws.js`, `host/vmservice.js`, `host/network.js`, `host/errors.js` | dev-vm | minimal WS client, VM Service RPC/streams, HTTP profile, error aggregation |
| `host/board.js` | dev-board | kanban state machine, persistence, AI decompose/dispatch/report |
| `host/analyze.js` | dev-toolchain | analyze / test / pub get / clean / build / doctor / format / devices |
| `host/httpapi.js`, `host/mcp.js`, `host/tools.js` | dev-api | HTTP surface, MCP JSON-RPC, DSH tool definitions |
| `client/src/00-prelude.js` … `10-shell.js`, `20-runtime.js`, `30-logs.js` | dev-ui-core | tokens/i18n/API client/hooks, shell layout, runtime page, log console |
| `client/src/40-network.js`, `50-board.js`, `60-quality.js` | dev-ui-data | network inspector, kanban board, quality (analyze/test/errors/perf/screenshot/settings) |
| `client/src/90-apply.js` | Lead | slot registration + page composition |
| `test/*.test.mjs` | matching dev | unit tests, disjoint files |
| `docs/FEATURE-SPEC.md`, `docs/research/*` | researchers | research + feature spec |
| `README.md`, `docs/INSTALL.md`, `docs/MCP.md` | dev-docs | user docs |

## 3. Constants (identical in Host and Client)

```
PACKAGE       dsh-flutter-workbench
PANEL_ID      flutter-workbench
ROUTE_PREFIX  /api/flutter-workbench
MCP_PATH      /api/flutter-workbench/mcp
LOCALE_NS     flutter-workbench
DATA_DIR      ~/.dsh/flutter-workbench   (override: config.dataDir)
```

## 4. Data shapes (shared JSON)

```js
// LogEntry
{ seq:number, at:number /*epoch ms*/, runId:string|null, projectId:string|null,
  source:'flutter'|'stdout'|'stderr'|'daemon'|'vm'|'network'|'toolchain'|'plugin'|'ai',
  level:'trace'|'debug'|'info'|'warn'|'error'|'fatal',
  text:string, meta:object|null }

// RunState
{ runId:string, projectId:string, projectPath:string,
  config:{ id:string, label:string, program:string, deviceId:string, mode:'debug'|'profile'|'release',
           flavor:string|null, dartDefines:object, args:string[], env:object, source:'launch.json'|'entry'|'manual' },
  phase:'starting'|'running'|'reloading'|'restarting'|'stopping'|'stopped'|'failed'|'exited',
  pid:number|null, startedAt:number, finishedAt:number|null,
  device:{ id:string, name:string, platform:string, emulator:boolean }|null,
  appId:string|null,
  vmServiceUri:string|null, httpUri:string|null, devtoolsUrl:string|null,
  exitCode:number|null, error:string|null, hotReloads:number, hotRestarts:number }

// NetEntry (from the VM Service HTTP profile)
{ id:string, runId:string, at:number, method:string, uri:string, host:string, path:string,
  status:number|null, requestBytes:number|null, responseBytes:number|null,
  startMicros:number|null, endMicros:number|null, durationMs:number|null,
  requestHeaders:object|null, responseHeaders:object|null,
  error:string|null, contentPreview:string|null, complete:boolean }

// ErrorGroup (deduped exceptions)
{ fp:string, count:number, firstAt:number, lastAt:number,
  kind:'flutter'|'dart'|'platform'|'test'|'analyze',
  message:string, exception:string|null, stack:string|null,
  frames:{ file:string, line:number|null, column:number|null, symbol:string|null }[],
  context:string|null, handled:boolean, runId:string|null, lastSeq:number }

// Project
{ id:string, path:string, name:string, createdAt:number, lastUsedAt:number|null,
  detected:{ ok:boolean, appName:string|null, description:string|null,
             platforms:string[], flavors:string[], sdkConstraint:string|null, error:string|null } }

// RunConfig (what /run/start accepts)
{ id:string, label:string, source:'launch.json'|'entry'|'manual',
  program:string, deviceId:string, mode:'debug'|'profile'|'release',
  flavor:string|null, dartDefines:object, args:string[], env:object }

// Task (kanban)
{ id:string, title:string, detail:string, lane:'backlog'|'ready'|'running'|'review'|'verify'|'done',
  order:number, priority:'low'|'normal'|'high'|'urgent', tags:string[],
  acceptance:string[], verify:string[], files:string[], deps:string[],
  projectId:string|null, createdAt:number, updatedAt:number,
  history:{ at:number, from:string|null, to:string, note:string|null, by:string }[],
  agent:{ sessionId:string|null, status:'idle'|'queued'|'working'|'blocked'|'done'|'failed'|null,
          startedAt:number|null, finishedAt:number|null, lastReport:string|null } | null,
  result:{ summary:string, commandsRun:{command:string,status:string,exitCode:number|null}[], evidence:string[],
           files:string[], verdict:'pass'|'fail'|null } | null,
  blocked:boolean }

// BoardSnapshot
{ lanes:[{ id:string, label:string, order:number }], tasks:Task[], counts:Object<string,number> }
```

## 5. Host module interfaces

All exports are `export function createX({ ... })` returning a plain object with
methods. No classes required. Every method may return a value or a Promise.

### 5.1 Foundation (Lead — already implemented, read it first)

```js
// host/util.js
normalizeError(err, fallback?) -> { message, code }
clamp(n, lo, hi) -> number
safeJson(text, fallback) -> any
uid(prefix?) -> string
nowMs() -> number
monotonic() -> number
readBody(nodeReq, limitBytes?) -> Promise<string>
sendJson(nodeRes, status, body, headers?) -> void
sendText(nodeRes, status, text, headers?) -> void
fingerprint(text) -> string
parseStack(text) -> { file, line, column, symbol }[]
boxedLines(chunk) -> string[]          // split stdout chunks into lines, keep partials per buffer
createBus() -> { on(type, cb)->off, emit(type, payload), offAll() , types() }
sleep(ms) -> Promise<void>
formatBytes(n) -> string
// host/store.js
createStore({ ctx, dir, name, logger }) -> Promise<store>
  store.dir, store.file
  store.get(key, fallback) -> any
  store.set(key, value) -> Promise<void>
  store.update(key, fn) -> Promise<any>
  store.all() -> object
  store.flush() -> Promise<void>
  store.reset() -> Promise<void>
// host/logs.js
createLogStore({ capacity }) -> logStore
  append({ source, level, text, runId?, projectId?, meta? }) -> LogEntry
  appendMany(entries[]) -> LogEntry[]
  query({ since?, limit?, level?, levels?, source?, sources?, pattern?, runId?, projectId?, order? }) -> { entries, nextCursor, total }
  cursor() -> number
  clear({ runId? } = {}) -> void
  size() -> number
  counts() -> { byLevel, bySource, total }
  tail(n) -> LogEntry[]
```

### 5.2 `host/runconfig.js` (dev-runner)

```js
detectFlutterProject({ projectPath, run? }) -> Promise<Project['detected']>
parseLaunchJson(text) -> { version, configurations: RawLaunchConfig[] }   // pure, no fs
normalizeLaunchConfigs(rawConfigs, { projectPath }) -> RunConfig[]        // pure
discoverEntryPoints({ projectPath }) -> Promise<{ program, label, hint }[]> // lib/main*.dart etc.
listDevices({ flutterPath, timeoutMs? }) -> Promise<Device[]>              // Device = {id,name,platform,emulator}
listEmulators({ flutterPath }) -> Promise<{id,name,platform}[]>
readFlavors({ projectPath }) -> Promise<string[]>                         // android productFlavors + ios xcconfig + --flavor in launch.json
export async function discoverConfigs({ projectPath, flutterPath }) ->
  { configs: RunConfig[], entries, devices, emulators, flavors, launchFile: string|null, warnings: string[] }
```
Rules: `launch.json` may contain comments and trailing commas (VS Code JSONC) —
strip both before parsing. Missing/broken files return empty arrays plus a
warning, never throw. `flutter devices --machine` is the fastest device source;
fall back to parsing plain output.

### 5.3 `host/runner.js` (dev-runner)

```js
createRunner({ logs, bus, settings, logger }) -> runner
runner.start({ projectPath, projectId, config }) -> Promise<{ runId }>
runner.stop({ runId?, force? }) -> Promise<{ stopped: string[] }>
runner.hotReload({ runId? }) -> Promise<{ runId, ok, message }>
runner.hotRestart({ runId? }) -> Promise<{ runId, ok, message }>
runner.state({ runId? }) -> { runs: RunState[], activeRunId: string|null }
runner.latestRun() -> RunState|null
runner.onEvent(cb) -> off            // bus already covers it; keep for internal use
runner.dispose() -> Promise<void>    // kill every child on plugin unload
```
Rules:
- Spawn `flutter run --machine -d <device> [--flavor f] [--dart-define=k=v]
  [--debug|--profile|--release] <program> <extra args>` with `cwd=projectPath`.
- Machine protocol: child **stdout** carries one JSON array per line; request ids
  from `[{"id":N,"method":...}]` written to **stdin** as `JSON.stringify([...])+"\n"`.
  Handle at minimum: `app.start`, `app.started`, `app.debugPort`,
  `app.log`, `app.stop`, `app.webLaunchUrl`, `daemon.logMessage`,
  `daemon.showMessage`, `device.started`, `app.progress`.
  Verify the exact shapes yourself against a real `flutter run --machine`
  (see `docs/research/flutter-internals.md` when it lands) — this is the one
  place where guessing is not allowed.
- stderr → log source `stderr`, level heuristics (`Error:`/`Exception` → error).
- `app.debugPort` → set `vmServiceUri` (ws), `httpUri`, and emit bus event
  `run:vm-service` with `{ runId, vmServiceUri, httpUri, devtoolsUrl }`.
- Every phase change emits `run:state` with the full `RunState`.
- `devtoolsUrl` = `https://devtools.flutter.dev/?uri=<encoded vmServiceUri>`.
- Guard: one live run per project; starting again stops the previous one.
  Never leave zombie children; `dispose()` kills the tree.

### 5.4 `host/ws.js` + `host/vmservice.js` (dev-vm)

```js
// host/ws.js — dependency-free RFC6455 client
createWebSocketClient({ url, handshakeTimeoutMs?, logger? }) -> Promise<ws>
ws.send(text | Buffer), ws.close(), ws.onMessage(cb) -> off, ws.onClose(cb) -> off, ws.readyState
// host/vmservice.js
createVmService({ logs, bus, logger }) -> vm
vm.connect({ runId, wsUri }) -> Promise<{ ok, vmId?, version? }>
vm.disconnect({ runId? }) -> Promise<void>
vm.isConnected() -> boolean
vm.call(method, params?, { runId?, timeoutMs? }?) -> Promise<any>
vm.subscribe({ events: string[] }) -> Promise<void>       // streamListen for Logging/Extension/Timeline/VM
vm.snapshot() -> { connected, runId, vmId, isolates: [{id,name,pauseEvent?}], streams: string[], lastError? }
vm.httpProfile({ runId?, sinceId? }) -> Promise<{ entries: NetEntry[], nextSinceId?:string }>
vm.httpRequestDetail({ requestId, runId? }) -> Promise<{ requestHeaders, responseHeaders, requestBody?, responseBody?, truncated:boolean }>
vm.screenshot({ runId? }) -> Promise<{ base64:string, mime:'image/png' }>
vm.dumpApp({ runId?, isolateId? }) -> Promise<string>
vm.frameStats({ runId? }) -> Promise<{ frames:{number,elapsedMs,buildMs,rasterMs}[], jankCount, worstMs }>
vm.evaluateExtension({ runId?, method, isolateId?, args? }) -> Promise<any>
```
Rules: JSON-RPC 2.0 over WS (`{jsonrpc:'2.0',id,method,params}`). Auto-reconnect
with backoff while the run is alive; buffer `getVM`/`getIsolate` until the first
isolate exists. HTTP profile via `ext.dart.io.getHttpProfile` (fallback
`_getHttpProfile`); socket profile via `ext.dart.io.getSocketProfile`. Map to
`NetEntry` (assign stable ids by request id, keep deltas via `requests.length`
cursor). `screenshot` uses `_flutter.screenshot` (fallback:
`ext.flutter.screenshot`); base64 → the caller writes the PNG. All failures must
resolve `{ ok:false, error }` **or** throw `Error` with a `code` property — never
hang. Emit bus events: `vm:connected`, `vm:disconnected`, `vm:error`, `vm:event`.

### 5.5 `host/network.js`, `host/errors.js` (dev-vm)

```js
createNetworkStore({ vm, logs, bus, capacity }) -> netStore
netStore.refresh({ runId }?) -> Promise<{ added:number }>       // pulls vm.httpProfile, dedupes
netStore.query({ since?, limit?, status?, method?, pattern?, host?, errorsOnly?, runId? })
  -> { entries: NetEntry[], nextCursor:number, total:number }
netStore.detail({ id, runId? }) -> Promise<object>              // headers/bodies
netStore.clear() -> void
netStore.startAutoRefresh({ intervalMs=1500 }) -> void          // pull while a run is live

createErrorStore({ logs, bus, capacity }) -> errStore
errStore.ingest(entry) -> ErrorGroup|null   // accepts LogEntry-ish or raw {message,stack,kind}
errStore.query({ since?, limit?, kind?, pattern?, runId? }) -> { groups, nextCursor, total }
errStore.clear() -> void
errStore.ingestCapture(text) -> void        // capture-flutter-errors style input
```
Deduping uses `fingerprint(normalizedMessage + topFrames)`.

### 5.6 `host/board.js` (dev-board)

```js
createBoard({ store, bus, ctx, logs, settings, logger }) -> board
board.snapshot() -> BoardSnapshot
board.addTask(input) -> Task            // defaults: lane 'backlog', priority 'normal'
board.updateTask({ id, patch }) -> Task
board.moveTask({ id, lane, index? }) -> Task
board.removeTask({ id }) -> { removed:boolean }
board.archiveDone() -> { archived:number }
board.decompose({ prompt, projectId?, maxTasks?, provider?, model? }) -> Promise<{ tasks:Task[], raw:string }>
board.dispatch({ id, provider?, model?, cwd? }) -> Promise<{ sessionId, task:Task }>
board.report({ id, status, summary, commandsRun?, evidence?, files?, verdict?, note? }) -> Task
board.cancelAgent({ id }) -> Task
board.syncAgent(id) -> Task             // look up session status and update the card
board.onChange(cb) -> off               // bus 'board:change'
```
Rules:
- LANES = `backlog → ready → running → review → verify → done`; moving to `done`
  requires `result.verdict === 'pass'` unless the caller passes `force:true`
  (user drag). Moving backwards is allowed and always recorded in `history`.
- `decompose` asks an agent to return **JSON only** (a task array). Use
  `ctx.get('agents')`; if unavailable return `{ tasks: [], raw: '' }` with a
  clear error. Never invent cards from a failed parse.
- `dispatch` creates a DSH session whose seed prompt contains the card contract
  (objective, acceptance, verify commands, files), sets `agent.status='working'`,
  moves the card to `running`, and records `agent.sessionId`. Provider/model come
  from settings when the caller omits them.
- Persistence: one `store` key `board` holding `{ version:1, tasks, archived }`.
  Debounced writes (≤200ms). Bump `version` if the shape changes.

### 5.7 `host/analyze.js` (dev-toolchain)

```js
createToolchain({ settings, logs, bus, logger }) -> toolchain
toolchain.analyze({ projectPath, timeoutMs? }) -> Promise<{ issues:AnalyzerIssue[], counts:{error,warning,info}, raw:string }>
toolchain.test({ projectPath, target?, name?, timeoutMs? }) -> Promise<{ passed, failed, skipped, durationMs, tests:TestResult[], raw:string }>
toolchain.pubGet({ projectPath }) -> Promise<{ ok, output }>
toolchain.clean({ projectPath }) -> Promise<{ ok, output }>
toolchain.build({ projectPath, target:'apk'|'appbundle'|'ios'|'web'|'windows'|'macos'|'linux', extraArgs? }) -> Promise<{ ok, output, artifacts:string[] }>
toolchain.doctor({ }) -> Promise<{ ok, output }>
toolchain.format({ projectPath, paths? }) -> Promise<{ ok, output }>
toolchain.devices({ }) -> Promise<Device[]>
toolchain.emulators({ }) -> Promise<object[]>
toolchain.resolvePaths() -> { flutterPath, dartPath, source:'config'|'PATH' }
// AnalyzerIssue = { severity:'error'|'warning'|'info', file, line, column, code, message }
// TestResult    = { id, name, group, status:'passed'|'failed'|'skipped', durationMs, error?, stack? }
```
Rules: prefer machine formats — `dart analyze --format machine`
(`SEVERITY|TYPE|CODE|FILE|LINE|COL|LENGTH|MESSAGE`), `flutter test --reporter json`
(newline-delimited JSON events), `flutter devices --machine`. Always resolve the
binary from `config.flutterPath`/`config.dartPath` first, then `PATH`; if
missing, return `{ ok:false, code:'toolchain-missing' }` with a helpful message.
Long runs stream progress to the `flutter` log source and emit `job:progress`.
Never hang: honor `timeoutMs` (default 180000, tests 600000) and kill the tree.

### 5.8 `host/httpapi.js`, `host/mcp.js`, `host/tools.js` (dev-api)

```js
// host/httpapi.js
createHttpApi({ ctx, services, logger }) -> { handle, attach, dispose, ROUTE_PREFIX, MCP_PATH }
  // handle({ method, path, query, body, headers }) -> Promise<{ status, body, headers? }>
  // attach(ctx) registers the prefix route incl. /mcp; returns disposer
// host/mcp.js
createMcpServer({ services, logger, version }) -> {
  handleJsonRpc(body, { token? }) -> Promise<object|null>,   // null for notifications
  tools: McpToolDescriptor[],                               // derived from host/tools.js
  info()
}
// host/tools.js
createToolDefinitions({ services, logger }) -> ToolDef[]
  // ToolDef = { name, description, parameters: JSONSchema, output:{ schema, render(args,value) }, execute(args) }
registerTools({ ctx, services, logger }) -> disposer|undefined
mcpToolDescriptors(defs) -> [{ name, description, inputSchema }]
```
HTTP rules (copy `lib/routes.js` of `daily-work-hub` for the transport, it is
installed on this machine):
- Guard non-MCP paths with `ctx.get('connection')?.requestRejection({ headers })`
  → respond 401/403 as JSON. `/mcp` must accept `Authorization: Bearer <token>`
  or `?token=` matching `settings.mcpToken` and bypass that guard (external MCP
  clients have no DSH cookie).
- JSON in / JSON out, `cache-control: no-store`, CORS not needed.
- Never throw out of `handle`: convert to `{ status:500, body:{ ok:false, code, message } }`.

### 5.9 `index.js` wiring (Lead)

`apply(ctx, config)` builds settings → store → logs → bus → runner → vm →
network → errors → board → toolchain → httpapi (+route) → tools → mcp, all
individually wrapped so one failing module never disables the panel. Cleanup
kills children, closes sockets, removes the route.

## 6. HTTP API

Base `ROUTE_PREFIX`; every response is JSON; success bodies start `{ ok:true }`.
Errors: HTTP status + `{ ok:false, code, message }`.

| Method + path | Body / query | Result |
|---|---|---|
| `GET /health` | — | `{ ok, version, uptimeMs, services:{ runner, vm, board, toolchain, mcp } }` |
| `GET /state` | — | `{ ok, projects, activeProjectId, runs, activeRunId, settings, board, counters }` |
| `POST /project/add` | `{ path }` | `{ ok, project }` |
| `POST /project/remove` | `{ id }` | `{ ok }` |
| `POST /project/select` | `{ id }` | `{ ok, activeProjectId }` |
| `GET /configs` | `?projectId=` | `{ ok, configs, entries, devices, emulators, flavors, launchFile, warnings }` |
| `POST /run/start` | `{ projectId?, configId?, program?, deviceId?, mode?, flavor?, dartDefines?, args? }` | `{ ok, runId, run }` |
| `POST /run/stop` | `{ runId? }` | `{ ok, stopped }` |
| `POST /run/reload` | `{ runId? }` | `{ ok, message }` |
| `POST /run/restart` | `{ runId? }` | `{ ok, message }` |
| `GET /logs` | `?since&limit&level&levels&source&sources&pattern&runId` | `{ ok, entries, nextCursor, total }` |
| `GET /errors` | `?since&limit&kind&pattern&runId` | `{ ok, groups, nextCursor, total }` |
| `GET /network` | `?since&limit&status&pattern&errorsOnly` | `{ ok, entries, nextCursor, total }` |
| `POST /network/detail` | `{ id, runId? }` | `{ ok, request }` |
| `POST /toolchain` | `{ action, projectId?, target?, name? }` | `{ ok, jobId }` (async job) |
| `GET /job` | `?id=` | `{ ok, job }` |
| `GET /jobs` | `?limit=` | `{ ok, jobs }` |
| `POST /screenshot` | `{ runId? }` | `{ ok, path, bytes, width?, height? }` |
| `GET /board` | — | `{ ok, board }` |
| `POST /board/task` | `{ action:'create'|'update'|'move'|'delete'|'archive', ... }` | `{ ok, task?, board? }` |
| `POST /board/decompose` | `{ prompt, projectId?, maxTasks? }` | `{ ok, tasks }` |
| `POST /board/dispatch` | `{ id, provider?, model? }` | `{ ok, sessionId, task }` |
| `POST /board/report` | `{ id, status, summary, ... }` | `{ ok, task }` |
| `GET /settings` | — | `{ ok, settings }` |
| `POST /settings` | `{ patch }` | `{ ok, settings }` |
| `POST /mcp` | MCP JSON-RPC | MCP JSON-RPC response |
| `GET /mcp` | — | `{ ok, name, version, toolCount }` (human probe) |

Jobs: `{ id, action, status:'running'|'done'|'failed', startedAt, finishedAt?, result?, error? }`,
kept in memory, newest 20.

## 7. AI surface: DSH tools (= MCP tools)

Names are stable; the UI's "AI" buttons call the same host methods.

| Tool | Params | Returns |
|---|---|---|
| `flutter_status` | `{ projectId? }` | project, run phase, device, vm uri, devtools url, counters, board counts |
| `flutter_projects` | `{ action:'list'|'add'|'remove'|'select', path?, id? }` | project list |
| `flutter_devices` | `{ kind:'devices'|'emulators' }` | device list |
| `flutter_configs` | `{ projectId? }` | run configs, entries, flavors |
| `flutter_run` | `{ projectId?, configId?, program?, deviceId?, mode?, flavor?, dartDefines?, args? }` | runId + state |
| `flutter_stop` | `{ runId? }` | stopped ids |
| `flutter_reload` | `{ runId? }` | ok + message |
| `flutter_restart` | `{ runId? }` | ok + message |
| `flutter_logs` | `{ since?, limit?, level?, source?, pattern?, runId?, minutes? }` | entries + nextCursor |
| `flutter_errors` | `{ since?, limit?, kind?, pattern?, runId? }` | deduped groups with stacks |
| `flutter_network` | `{ since?, limit?, status?, pattern?, errorsOnly? }` | HTTP entries |
| `flutter_network_detail` | `{ id }` | headers/bodies for one request |
| `flutter_analyze` | `{ projectId?, wait? }` | issues + counts (wait until done) |
| `flutter_test` | `{ projectId?, target?, name?, wait? }` | pass/fail counts + failing tests |
| `flutter_toolchain` | `{ action:'pubGet'|'clean'|'build'|'doctor'|'format', projectId?, target? }` | ok + tail of output |
| `flutter_screenshot` | `{ runId? }` | saved PNG path (readable with `read_image`) |
| `flutter_widget_tree` | `{ runId?, isolateId?, maxChars? }` | widget tree text |
| `flutter_perf` | `{ runId? }` | frame stats + jank summary |
| `flutter_open` | `{ file, line? }` | opens `file:line` in the configured editor |
| `flutter_log_mark` | `{ text }` | inserts a marker entry (time correlation) |
| `flutter_tasks` | `{ action:'list'|'create'|'update'|'move'|'delete', ... }` | board/task |
| `flutter_task_decompose` | `{ prompt, projectId?, maxTasks? }` | created cards |
| `flutter_task_dispatch` | `{ id, provider?, model? }` | sessionId |
| `flutter_task_report` | `{ id, status, summary, commandsRun?, evidence?, verdict? }` | updated card |

MCP: `initialize`, `notifications/initialized`, `ping`, `tools/list`,
`tools/call`. `protocolVersion` echo the client's if it is `2025-03-26`,
`2025-06-18`, or `2024-11-05`; default `2025-06-18`. `tools/call` returns
`{ content:[{type:'text', text}], isError?:true }`, and for large payloads a
single text block with JSON. Optional `resources/list` → empty list.

## 8. Client half

Build: `node scripts/build-client.mjs` concatenates `client/src/*.js` in
lexicographic order into the loader wrapper and writes `client/client.js`.
Fragments share one function scope, so `90-apply.js` may call any function the
other fragments declare.

### 8.1 `00-prelude.js` (dev-ui-core) must provide
```js
const h = React.createElement
const PANEL_ID = 'flutter-workbench'
const API = '/api/flutter-workbench'
// tokens
const T = { bg, bgRaised, bgInput, border, borderStrong, text, textDim, textFaint, brand, brandText,
            ok, warn, error, radius, radiusSm, font, mono, spacing... }  // values = 'var(--dsw-alias-*)'
function api(path, { method='GET', body, query, signal }?) -> Promise<any>   // throws {status,code,message}
function usePoll(fn, intervalMs, deps?) -> { data, error, loading, refresh }
function useApiState()                                        // shared app state + actions
function t(key, vars?) -> string
const ZH = {...}, EN = {...}                                  // full dictionaries
// small UI kit (used by every page): Btn, IconBtn, Pill, Chip, Card, Field, Input, TextArea,
// Select, Checkbox, Tabs, Modal, Toast/useToast, Empty, Spinner, Table, SplitPane, Toolbar,
// Mono, Markdown-ish text, Kbd, Tooltip, ProgressBar, Badge
```
Rules: components are plain functions, props in, `h()` out. No external CSS
frameworks; one injected stylesheet for scrollbars/focus/keyframes only. Use
`--dsw-alias-*` tokens exclusively.

### 8.2 Pages (each exports one top-level component)
```js
// 10-shell.js  (dev-ui-core)
function WorkbenchApp()            // the registered main-panel component
// 20-runtime.js (dev-ui-core)
function RuntimePage({ state, actions })     // project/config/device pickers, run controls, live status
// 30-logs.js (dev-ui-core)
function LogsPage({ state, actions })        // console, filters, follow, copy, jump-to-code
// 40-network.js (dev-ui-data)
function NetworkPage({ state, actions })     // list + detail drawer
// 50-board.js (dev-ui-data)
function BoardPage({ state, actions })       // lanes, DnD, add/edit modal, decompose, dispatch
// 60-quality.js (dev-ui-data)
function QualityPage({ state, actions })     // analyze/test/errors/perf/screenshot
// 60-quality.js also: SettingsPage({ state, actions })
// 90-apply.js  (Lead)
```
`state` (from `useApiState`) must expose at least:
```js
{ snapshot, projects, activeProjectId, runs, activeRunId, configs, devices, logs, errors,
  network, board, jobs, settings, conn:{ ok, error },  // polling health
  actions:{ selectProject, addProject, removeProject, loadConfigs, startRun, stopRun, hotReload,
            hotRestart, fetchLogs, fetchErrors, fetchNetwork, networkDetail, runToolchain, getJob,
            screenshot, createTask, updateTask, moveTask, deleteTask, decompose, dispatchTask,
            reportTask, saveSettings, markLog, openFile, toast } }
```

### 8.3 Shell layout (dev-ui-core decides details, must include)
- Header: project switcher, run phase pill, run/reload/restart/stop buttons,
  device chip, VM/DevTools link, connection indicator.
- Left rail: nav (Runtime / Logs / Network / Board / Quality / Settings) + counts.
- Content: the selected page; persists selection in `sessionStorage`.
- Bottom status bar: log counters, active run id, keyboard hints.
- Keyboard: `Ctrl/Cmd+K` command palette (jump to page/action), `R` reload when
  the logs page is focused and no input is focused, `Esc` closes modals.
- Empty states everywhere; never show a blank panel.

## 9. Build / verify loop

```bash
node scripts/build-client.mjs      # concatenate + syntax check
node --check index.js
node --test test/                  # unit tests
```
Full acceptance is the QA task: install the bundle into the running Desktop
profile, then exercise `/health`, `/state`, a real `flutter run -d windows|edge`,
hot reload, logs, network, board, and both MCP `initialize` + `tools/list`.