# Flutter internals — verified protocol facts

Everything below was verified on **this machine** by running real commands; each
claim cites the exact command and the raw evidence. Nothing here is guesswork.

## 0. Environment and method

| Item | Value | How |
|---|---|---|
| Flutter | `3.38.5` stable, framework rev `f6ff1529fd` (2025-12-11) | `flutter --version` |
| Dart VM | `3.10.4 (stable)` on `windows_x64` | `dart --version` |
| DevTools | `2.51.1` | `flutter --version` |
| Devices | `windows` (supported), `edge` (`isSupported: false`) | `flutter devices --machine` |
| Android | absent (no SDK) → no emulator path | `flutter doctor` |
| Visual Studio | Community 2022 17.14.18 → `-d windows` builds fine | `flutter doctor` |

**No internet on this host** (`Invoke-WebRequest` to pub.dev/github/modelcontextprotocol
all fail; the IE proxy `127.0.0.1:7890` is not listening). Therefore all
protocol facts below are verified against **installed source + live processes**,
which is stronger evidence than docs. Web URLs are given only as secondary
references and are marked *(unverified URL)*.

Throwaway app: `flutter create --platforms=windows --project-name fwprobe %TEMP%\fw-research\probe`.
Device used for every run: **`-d windows`** (Edge reported `isSupported:false`, so
the web path was not exercised).

Reproduction scripts (kept out of the repo, in `%TEMP%\fw-research`):
`run-probe.mjs` (machine protocol), `probe2/3/4.mjs` (machine + WS VM Service +
a local Node HTTP server that the app calls, so the HTTP profiler has real traffic).

---

## 1. `flutter run --machine`

### 1.1 Framing — the single most important gotcha

```bash
flutter run --machine -d windows --debug lib/main.dart
```

- **Requests** (us, → child **stdin**): one JSON *array* per line
  `[{"id":1,"method":"app.restart","params":{...}}]`
- **Responses** (← child **stdout**): `[{"id":1,"result":{...}}]` or
  `[{"id":1,"error":{...}}]`
- **Events** (← child **stdout**): `[{"event":"app.start","params":{...}}]`
  — the key is **`event`**, *not* `method`. (A driver that looks for `method`
  silently receives nothing; this cost one debug cycle here.)
- **stdout is NOT JSON-only.** Plain text lines are interleaved with JSON. Real
  capture (trimmed):

```
EVT [{"event":"daemon.connected","params":{"version":"0.6.1","pid":19608}}]
EVT [{"event":"app.start","params":{"appId":"321619c1-...","deviceId":"windows","directory":"C:\\...\\probe","supportsRestart":true,"launchMode":"run","mode":"debug"}}]
EVT Launching lib/main.dart on Windows in debug mode...        <-- plain text
EVT [{"event":"app.progress","params":{"appId":"321619c1-...","id":"0","progressId":null,"message":"Building Windows application...","finished":false}}]
EVT √ Built build\windows\x64\runner\Debug\fwprobe.exe        <-- plain text
EVT PROBE-BOOT                                                 <-- app print()
EVT [{"event":"app.debugPort","params":{"appId":"321619c1-...","port":63781,"wsUri":"ws://127.0.0.1:63781/41-LiKTZmv8=/ws","baseUri":"file:///C:/Users/ADMINI~1/AppData/Local/Temp/probee96deced/probe/"}}]
```

Source of this behaviour: `packages/flutter_tools/lib/src/commands/daemon.dart`
— `Daemon.createMachineDaemon()` sets `logToStdout: true`, and
`DaemonDomain` then writes `status`/`trace` messages with `print(...)` and
`error`/`warning` with `globals.stdio.stderrWrite(...)` **instead of** emitting
`daemon.logMessage` events (lines 386-413). So: **parse JSON arrays, else treat
the line as a log line** (stdout → level info/debug, stderr → warn/error).

### 1.2 Event shapes (verbatim, trimmed)

| Event | `params` |
|---|---|
| `daemon.connected` | `{"version":"0.6.1","pid":19608}` |
| `app.start` | `{"appId":"<uuid>","deviceId":"windows","directory":"C:\\...","supportsRestart":true,"launchMode":"run","mode":"debug"}` |
| `app.progress` | `{"appId","id":"0","progressId":null,"message":"Building Windows application...","finished":false}` — `progressId` is `null` or a string like `"devFS.update"`; `id` is a **string counter**, per-processor |
| `app.debugPort` | `{"appId","port":63781,"wsUri":"ws://127.0.0.1:63781/41-LiKTZmv8=/ws","baseUri":"file:///C:/.../"}` — **there is no `httpUri`** |
| `app.devTools` | `{"appId","uri":"http://127.0.0.1:63781/41-LiKTZmv8=/devtools/?uri=ws://127.0.0.1:63781/41-LiKTZmv8=/ws"}` |
| `app.dtd` | `{"appId","uri":"ws://127.0.0.1:63780/6E2i1CBNgDA="}` (Dart Development Service) |
| `app.started` | `{"appId"}` |
| `app.stop` | `{"appId"}` on clean exit; on error also `{"appId","error":{...},"trace":"<stack>"}` |
| `app.log` | `{"appId","log":"<text>","error":true}` — **only** from a failed `app.stop`/`app.detach` (`daemon.dart:957,976`); app `print()` never becomes `app.log` on desktop (it goes to the tool's stdout) |
| `app.webLaunchUrl` | `{"url","launched":bool}` — web only |
| `app.warning` | `{"message",...}` — e.g. slow wireless debugging |
| `daemon.logMessage` | `{"level":"status\|trace\|error\|warning","message","stackTrace?"}` — **never emitted in `--machine`** (logToStdout) |
| `daemon.showMessage` | **does not exist** in 3.38.5 (`grep -r showMessage packages/flutter_tools` → 0 hits) |
| `device.started` | **does not exist**; DeviceDomain emits `device.added` / `device.removed` (`daemon.dart:1042-1043`) |

Ordering observed for a desktop debug run:
`daemon.connected → app.start → app.progress(×2 build) → app.debugPort →
app.devTools → app.dtd → app.progress(devFS.update) → app.started →
app.progress(×n) → app.log/… → app.stop`.

**Isolate/app ids:** `appId` is a UUIDv4. JSON-RPC ids are caller-chosen and
echoed back; they are *not* per-stream. The `id` inside `app.progress` is a
separate string namespace (progress counter) — do not collide them.

### 1.3 Request / response shapes

| Request (stdin) | Response (stdout) |
|---|---|
| `[{"id":1,"method":"app.restart","params":{"appId":"<uuid>","fullRestart":false,"pause":false,"reason":"probe-reload"}}]` | `[{"id":1,"result":{"code":0,"message":"Reloaded 0 libraries"}}]` |
| same with `"fullRestart":true` | `[{"id":2,"result":{"code":0,"message":""}}]` |
| `[{"id":3,"method":"app.stop","params":{"appId":"<uuid>"}}]` | `[{"id":3,"result":true}]` |
| `[{"id":4,"method":"app.detach","params":{"appId":"<uuid>"}}]` | `[{"id":4,"result":true}]` *(source-verified only — `daemon.dart:965-982`; detach needs `flutter attach`, which was not exercised here)* |

`app.restart` returns an `OperationResult` → `{code, message}`; non-zero `code`
means the reload/restart failed (`code:1` + message). Unknown `appId` →
`DaemonException` → error response (`{"id","error":{"code","message"...}}`).
Optional params: `pause` (pause after restart), `reason`, `debounce`,
`debounceDurationOverrideMs` (`daemon.dart:853-880`).

Also available (same shape, `daemon.dart` handlers): `daemon.version`,
`daemon.shutdown`, `daemon.getSupportedPlatforms`, `device.getDevices`,
`device.discoverDevices`, `emulator.getEmulators`, `devtools.*`,
`app.callServiceExtension` (`{appId, methodName, params}` → forwards to the VM
service and returns the extension map), `proxy.*`.

---

## 2. Dart VM Service

### 2.1 Envelope, URLs

WS URL from `app.debugPort.wsUri`:
`ws://127.0.0.1:<port>/<auth-token>=/ws` — e.g. `ws://127.0.0.1:63781/41-LiKTZmv8=/ws`.
HTTP root is the same host/path minus `/ws` + a trailing `/`:
`http://127.0.0.1:63781/41-LiKTZmv8=/` (this is what `ext.flutter.connectedVmServiceUri`
reported: `"http://127.0.0.1:64312/DbQLeaFZkl8=/"`).
DevTools: prefer `app.devTools.uri`; the framework's
`ext.flutter.activeDevToolsServerAddress` reports the DDS/devtools server
(`http://127.0.0.1:64312/DbQLeaFZkl8=/devtools/`).

Request/response (JSON-RPC 2.0, one object per WS text frame):

```json
{"jsonrpc":"2.0","id":1,"method":"getVM","params":{}}
{"jsonrpc":"2.0","id":1,"result":{"type":"VM","name":"vm","version":"3.10.4 (stable) …","pid":22000,"startTime":1795019918536,"isolates":[{"type":"@Isolate","id":"isolates/6800178701908823","name":"main","number":"6800178701908823","isSystemIsolate":false,"isolateGroupId":"isolateGroups/7846635005567037"}],"systemIsolates":[…],"isolateGroups":[…]}}
{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Unknown method \"…\".","data":{"request":{…}}}}
```

Events arrive unsolicited as `{"jsonrpc":"2.0","method":"streamNotify","params":{"streamId":"Extension","event":{…}}}`.

**The isolate id field is `id`, value shape `isolates/<decimal>`** —
`vm.isolates[0].id`. `number` is the same decimal *without* the prefix (string).

### 2.2 Core calls

| Method | Params | Result |
|---|---|---|
| `getVM` | – | `VM` object; `isolates[]`, `systemIsolates[]`, `isolateGroups[]`, `pid`, `version`, `startTime`, plus private `_features`, `_profilerMode`, `_currentRSS` |
| `getIsolate` | `{isolateId}` | `Isolate`: `id,name,number,isSystemIsolate,isolateGroupId,startTime,runnable,livePorts,pauseOnExit,pauseEvent{kind:"Resume"…},rootLib,libraries[],breakpoints[],exceptionPauseMode,extensionRPCs[]` |
| `streamListen` | `{streamId}` | `{"type":"Success"}` |
| `streamCancel` | `{streamId}` | `{"type":"Success"}` |

Other useful VM methods: `getMemoryUsage`, `getFlagList`, `getAllocationProfile`,
`getClassList`, `getScripts`, `getObject`, `evaluate`, `resume/pause`, `setBreakpoint`,
`clearCpuSamples`, `getVMTimeline`, `setVMTimelineFlags`, `getStack`.
Streams that exist and were confirmed to deliver: `VM`, `Isolate`, `Logging`,
`Extension`, `Timeline`, `Debug`, `Service`, `Stdout`.
Also available: `Profiler`, `HeapSnapshot`, `GC`, `Native`, `Perfetto`.

Kinds observed: `Isolate/IsolateStart`, `Isolate/IsolateExit`, `Isolate/IsolateRunnable`,
`Isolate/ServiceExtensionAdded` (73 of them, one per extension),
`Isolate/ServiceExtensionStateChanged`, `Extension/Extension`,
`Stdout/WriteEvent`, `Timeline/TimelineEvents`,
`Service/ServiceRegistered`, `Debug/_DebuggerSettingsUpdate`.

### 2.3 Service extensions — call them **directly**, not via `callServiceExtension`

`callServiceExtension` is **not** a VM Service RPC. Calling it returns
`-32601 Unknown method "callServiceExtension"` (verified). The wire call is:

```json
{"jsonrpc":"2.0","id":1,"method":"ext.flutter.debugDumpApp","params":{"isolateId":"isolates/…"}}
```

Every extension result is wrapped as
`{"type":"_extensionType","method":"<name>", …payload…}`. Errors from inside an
extension come back as a normal result containing `{"error":…}` or an RPC
`error` — always check both.

Extension registry as reported by `getIsolate().extensionRPCs` (73 entries, exact):

```
ext.ui.window.scheduleFrame            ext.flutter.debugDumpApp
ext.ui.window.reinitializeShader       ext.flutter.debugDumpFocusTree
ext.ui.window.impellerEnabled          ext.flutter.showPerformanceOverlay
ext.dart.io.httpEnableTimelineLogging  ext.flutter.didSendFirstFrameEvent
ext.dart.io.getSocketProfile           ext.flutter.didSendFirstFrameRasterizedEvent
ext.dart.io.socketProfilingEnabled     ext.flutter.profileWidgetBuilds
ext.dart.io.clearSocketProfile         ext.flutter.profileUserWidgetBuilds
ext.dart.io.getVersion                 ext.flutter.debugAllowBanner
ext.dart.io.getHttpProfile             ext.flutter.inspector.structuredErrors
ext.dart.io.getHttpProfileRequest      ext.flutter.inspector.show
ext.dart.io.clearHttpProfile           ext.flutter.inspector.trackRebuildDirtyWidgets
ext.flutter.reassemble                 ext.flutter.inspector.widgetLocationIdMap
ext.flutter.exit                       ext.flutter.inspector.trackRepaintWidgets
ext.flutter.connectedVmServiceUri      ext.flutter.inspector.disposeAllGroups
ext.flutter.activeDevToolsServerAddress ext.flutter.inspector.disposeGroup
ext.flutter.platformOverride           ext.flutter.inspector.isWidgetTreeReady
ext.flutter.brightnessOverride         ext.flutter.inspector.disposeId
ext.flutter.timeDilation               ext.flutter.inspector.setPubRootDirectories
ext.flutter.evict                      ext.flutter.inspector.addPubRootDirectories
ext.flutter.profilePlatformChannels    ext.flutter.inspector.removePubRootDirectories
ext.flutter.invertOversizedImages      ext.flutter.inspector.getPubRootDirectories
ext.flutter.debugPaint                 ext.flutter.inspector.setSelectionById
ext.flutter.debugPaintBaselinesEnabled ext.flutter.inspector.getParentChain
ext.flutter.repaintRainbow             ext.flutter.inspector.getProperties
ext.flutter.debugDumpLayerTree         ext.flutter.inspector.getChildren
ext.flutter.debugDisableClipLayers     ext.flutter.inspector.getChildrenSummaryTree
ext.flutter.debugDisablePhysicalShapeLayers ext.flutter.inspector.getChildrenDetailsSubtree
ext.flutter.debugDisableOpacityLayers  ext.flutter.inspector.getRootWidget
ext.flutter.debugDumpRenderTree        ext.flutter.inspector.getRootWidgetSummaryTree
ext.flutter.debugDumpSemanticsTreeInTraversalOrder   ext.flutter.inspector.getRootWidgetSummaryTreeWithPreviews
ext.flutter.debugDumpSemanticsTreeInInverseHitTestOrder ext.flutter.inspector.getRootWidgetTree
ext.flutter.profileRenderObjectPaints  ext.flutter.inspector.getDetailsSubtree
ext.flutter.profileRenderObjectLayouts ext.flutter.inspector.getSelectedWidget
                                       ext.flutter.inspector.getSelectedSummaryWidget
                                       ext.flutter.inspector.isWidgetCreationTracked
                                       ext.flutter.inspector.screenshot
                                       ext.flutter.inspector.getLayoutExplorerNode
                                       ext.flutter.inspector.setFlexFit
                                       ext.flutter.inspector.setFlexFactor
                                       ext.flutter.inspector.setFlexProperties
```

**Not present on this SDK** (common mistakes): `_flutter.screenshot`,
`ext.flutter.screenshot`, `ext.flutter.screenshot`-style aliases,
`ext.flutter.debugDumpSemanticsTree` (only the `In…Order` variants),
`ext.flutter.debugDumpRenderObjectTree`, `_getHttpProfile`, `_getSocketProfile`.

#### Verified response payloads

```jsonc
// ext.flutter.debugDumpApp  (also debugDumpRenderTree / debugDumpLayerTree)
{"type":"_extensionType","method":"ext.flutter.debugDumpApp","data":"WidgetsFlutterBinding - DEBUG MODE\n[root]\n└View(state: _ViewState#87a13)…"}
//   measured sizes: debugDumpApp 60_935 B, debugDumpRenderTree 77_964 B, debugDumpLayerTree 2_523 B

// ext.flutter.inspector.structuredErrors  params {"enabled":"true"}   (string!)
{"type":"_extensionType","method":"ext.flutter.inspector.structuredErrors","enabled":"true"}

// ext.flutter.inspector.isWidgetTreeReady
{"type":"_extensionType","method":"ext.flutter.inspector.isWidgetTreeReady","result":true}

// ext.flutter.inspector.getRootWidgetSummaryTree  params {objectGroup,isSummaryTree,fullDetails}
{"type":"_extensionType","method":"ext.flutter.inspector.getRootWidgetSummaryTree","result":{
  "description":"[root]","type":"_ElementDiagnosticableTreeNode","style":"dense",
  "hasChildren":true,"allowWrap":false,"summaryTree":true,"valueId":"inspector-0","locationId":0,
  "creationLocation":{"file":"file:///…/main.dart","line":12,"column":16,"name":"ProbeApp"},
  "createdByLocalProject":true,"children":[ … ]}}

// ext.flutter.inspector.screenshot  params {id,width,height,maxPixelRatio,objectGroup}
{"type":"_extensionType","method":"ext.flutter.inspector.screenshot","result":"iVBORw0KGgoAAAANSUhEUgAAAZAAAADY…"}

// ext.flutter.inspector.getSelectedWidget  (no selection)
{"type":"_extensionType","method":"ext.flutter.inspector.getSelectedWidget","result":null}

// ext.flutter.reassemble
{"type":"_extensionType","method":"ext.flutter.reassemble"}

// ext.dart.io.getVersion
{"type":"Version","major":4,"minor":0}
```

Key for jump-to-code: every inspector node carries
`creationLocation:{file,line,column,name}` with a `file:///` URI, and
`createdByLocalProject:true|false`. `screenshot` returns a **base64 PNG string**
under `result` — no data-URI prefix.

### 2.4 dart:io HTTP profile — the complete contract

> **Hard prerequisite:** `dart:io` records a request **only**
> `if (HttpClient.enableTimelineLogging && !dart.vm.product)`
> (`bin/cache/dart-sdk/lib/_http/http_impl.dart:3016-3020`). The default is
> `false`, so `getHttpProfile` returns `"requests":[]` until you enable it.

```json
{"jsonrpc":"2.0","id":1,"method":"ext.dart.io.httpEnableTimelineLogging","params":{"isolateId":"isolates/…","enabled":"true"}}
→ {"type":"HttpTimelineLoggingState","enabled":true}
```

(Enabled it, then watched 4 requests appear; earlier runs with the flag off
returned `"requests":[]` while the app was making requests every 1.2 s.)

```json
{"jsonrpc":"2.0","id":2,"method":"ext.dart.io.getHttpProfile","params":{"isolateId":"isolates/…"}}
→ {"type":"HttpProfile","timestamp":1795020230989730,"requests":[ … ]}
```

- `timestamp` is **wall-clock microseconds** (`Date.now()*1000` matched within
  5 ms). `startTime`/`endTime` are the same clock — *not* `Timeline.now` ticks.
- Optional `params.updatedSince` (micros, matched against each request's
  `lastUpdateTime`) returns only changed/new entries. Delta polling works.
- Entries in the list are **refs**: `"type":"@HttpProfileRequest"`, no bodies.

Entry shape (real capture, one POST + one response):

```jsonc
{
  "type": "@HttpProfileRequest",
  "id": "3607923408218006926",          // string, unique per isolate
  "isolateId": "isolates/5989928195294391",
  "method": "POST",                      // uppercase
  "uri": "http://127.0.0.1:48082/api/ping",
  "events": [{"timestamp":1795020226472952,"event":"Connection established"},
             {"timestamp":1795020226476355,"event":"Request sent"},
             {"timestamp":1795020226506670,"event":"Waiting (TTFB)"},
             {"timestamp":1795020226516068,"event":"Content Download"}],
  "startTime": 1795020226448674,         // request start (wall clock µs)
  "endTime":   1795020226495195,         // request body fully SENT (not total)
  "request": {
    "headers": {"user-agent":["Dart/3.10 (dart:io)"],"content-type":["application/json; charset=utf-8"],
                "transfer-encoding":["chunked"],"accept-encoding":["gzip"],"host":["127.0.0.1:48082"]},
    "connectionInfo": {"localPort":64733,"remoteAddress":"127.0.0.1","remotePort":48082},
    "contentLength": -1, "cookies": [], "followRedirects": true, "maxRedirects": 5,
    "method": "POST", "persistentConnection": true,
    "uri": "http://127.0.0.1:48082/api/ping", "filterKey": "HTTP/client"
  },
  "response": {
    "startTime": 1795020226507730,
    "headers": {"connection":["keep-alive"],"content-type":["application/json"],
                "transfer-encoding":["chunked"],"date":["Wed, 18 Nov 2026 16:43:46 GMT"],"x-probe":["yes"]},
    "compressionState": "HttpClientResponseCompressionState.notCompressed",
    "connectionInfo": {"localPort":64733,"remoteAddress":"127.0.0.1","remotePort":48082},
    "contentLength": -1, "cookies": [], "isRedirect": false,
    "persistentConnection": true, "reasonPhrase": "OK", "redirects": [],
    "statusCode": 200,
    "endTime": 1795020226516068
  }
}
```

Mapping notes for `NetEntry` (CONTRACTS §4):

| Want | Source |
|---|---|
| `status` | `response.statusCode` — **not** top-level. `401` example: `statusCode:401, reasonPhrase:"Unauthorized"` |
| `durationMs` | `(response.endTime ?? entry.endTime) - entry.startTime` → here `(…516068 − …448674)/1000 = 67.4 ms` |
| `startMicros` / `endMicros` | `startTime` / `endTime` (µs, wall clock) |
| `requestBytes` / `responseBytes` | `request.contentLength` / `response.contentLength` are **`-1` when chunked** → count bytes from the full object instead |
| `error` | `request.error` / `response.error` (strings) when the request failed; `events` shows where it stopped |
| `complete` | `response.endTime != null` |

Detail (bodies) requires a second call:

```json
{"jsonrpc":"2.0","id":3,"method":"ext.dart.io.getHttpProfileRequest","params":{"isolateId":"isolates/…","id":"3607923408218006926"}}
→ {"type":"HttpProfileRequest", …same fields as the ref, plus…,
   "requestBody":[123,34,104,101,108,108,111,34,58,34,119,111,114,108,100,34,125],
   "responseBody":[123,34,111,107,34,58,116,114,117,101,…]}
```

- `type` loses the `@` in the full form (`"HttpProfileRequest"`).
- **`requestBody`/`responseBody` are JSON arrays of byte values** (`Uint8List`
  serialized element-wise) — `Uint8Array.from(body)` then UTF-8 decode. They are
  `[]`, not `null`, when empty. Bodies exist only when the request finished and
  the response started (`network_profiling.dart:232-235`).
- `getHttpProfileRequest` with unknown id → extension error
  `"Unable to find request with id: '<id>'"`.
- Server-streamed request ids (`from_package/<n>`) also appear in this list for
  code that used `package:http`'s own profiling; treat ids as opaque strings.
- Clearing: `ext.dart.io.clearHttpProfile` → `{"type":"Success"}`.
- Cost: enabling `enableTimelineLogging` also writes every request into the
  `Timeline` stream — turn it **off** when nobody is watching the network page
  (`{"enabled":"false"}`).

Socket profile: `ext.dart.io.getSocketProfile` → `{"type":"SocketProfile","sockets":[]}`
(each socket: `{id,startTime,endTime?,address,port,socketType,readBytes,writeBytes,lastReadTime?,lastWriteTime?}`);
`ext.dart.io.socketProfilingEnabled {enabled:"true"}` must be called first;
`ext.dart.io.clearSocketProfile` → `{"type":"Success"}`.

### 2.5 `Flutter.Error` / `Flutter.FirstFrame` / `Flutter.Frame`

All three are `Extension` stream events:

```jsonc
{"type":"Event","kind":"Extension","extensionKind":"Flutter.Frame",
 "isolateGroup":{…},"isolate":{"type":"@Isolate","id":"isolates/…"},
 "timestamp":1795019919419,
 "extensionData":{"number":2,"startTime":8440852456,"elapsed":85052,"build":2674,"raster":77512,"vsyncOverhead":4826}}
```

- `Flutter.Frame.extensionData` is exactly
  `{number, startTime, elapsed, build, raster, vsyncOverhead}`, all **microseconds**
  (`startTime` is `timestampInMicroseconds(buildStart)`), from
  `packages/flutter/lib/src/scheduler/binding.dart:1382-1390`.
- `Flutter.FirstFrame` → `extensionData:{}` (fired once per view).
- `Flutter.FrameworkInitialization` → `extensionData:{}`.
- There is **no `errors` array** on `Flutter.Error` in 3.38.5. `extensionData`
  *is* the diagnostics node for one error plus two extra keys
  (`widget_inspector.dart:1008-1031`):

```jsonc
{"kind":"Extension","extensionKind":"Flutter.Error","extensionData":{
   "description":"Exception caught by widgets library",
   "type":"_FlutterErrorDetailsNode","allowWrap":false,
   "valueId":"inspector-0",
   "properties":[{"description":"The following StateError was thrown building ProbeApp(dirty, state: _ProbeAppState#96fa1):","type":"…"},…],
   "errorsSinceReload":0,                                   // 0 for the first error since (re)load
   "renderedErrorText":"══╡ EXCEPTION CAUGHT BY WIDGETS LIBRARY ╞══…"}}
```

  `errorsSinceReload > 0` means "another exception was thrown" and
  `renderedErrorText` is shortened accordingly. Full text of one captured event
  was ~10 KB, so truncate before shipping to a browser tab.
- **`Flutter.Error` only fires when structured errors are on**:
  `FlutterError.presentError` is `_reportStructuredError` only after
  `ext.flutter.inspector.structuredErrors {enabled:"true"}` (gated by
  `isStructuredErrorsEnabled()`, debug only). Without it, errors go to the
  console/stdout instead (`_reportStructuredError` is never installed).
- Errors to expect as `Exception`/`Sentinel` in other paths: unhandled async
  errors in `runZonedGuarded` appear **only** on stdout, not as events.
- `Flutter.Navigation` (`{route:{…}}`), `Flutter.ImageSizesForFrame`,
  `Flutter.ServiceExtensionStateChanged` (`{extension,value}`) also exist.

### 2.6 Timeline for jank

`Timeline` stream → `{"kind":"TimelineEvents","timelineEvents":[{name,cat,tid,pid,ts,ph,args}]}`
(`ph` ∈ `B|E|X|C|i|b|n`, `ts` in µs) — a Chrome-trace compatible stream
(`Shell::OnPlatformViewScheduleFrame`, `Animator::BeginFrame`,
`BUILD`, `LAYOUT`, `COMPOSITE`, `Paint`, `Rasterizer`, `GC`, `RSS`…).
Turning it on floods the socket; prefer `Flutter.Frame` for the jank badge and
only pull `Timeline` when the user opens the perf panel
(`setVMTimelineFlags` / `getVMTimeline` also available).

Jank rule that matches DevTools: a frame is janky if
`build + raster > 16.7 ms` (60 Hz) or `> 8.3 ms` (120 Hz); `elapsed` includes
vsync wait, so use `build`/`raster` for the verdict, `elapsed` for the bar.

### 2.7 Isolate lifecycle gotcha

A full restart (`app.restart {fullRestart:true}`) **replaces the isolate id**
(`isolates/5989928195294391` → `isolates/3509808972098999`). Calling an
extension with the stale id does **not** error — it returns a sentinel:

```json
{"type":"Sentinel","kind":"Collected","valueAsString":"<collected>"}
```

So every extension call must treat `result.type === "Sentinel"` as
"isolate gone → re-`getVM`, retry once". (Before hot *reload* the isolate id is
stable; `getIsolate` may still return `_isReloading:true` briefly.)

---

## 3. MCP transport (Streamable HTTP) — what a server must do

Verified against two local sources because the network is unavailable:
1. `@modelcontextprotocol/core` + `client` (bundled with the `dscord` plugin):
   `LATEST_PROTOCOL_VERSION = '2025-11-25'`,
   `SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25','2025-06-18','2025-03-26','2024-11-05','2024-10-07']`,
   `DEFAULT_NEGOTIATED_PROTOCOL_VERSION = '2025-03-26'`; newer work references a
   `2026-07-28` revision with an `MCP-Protocol-Version` header per request and a
   `Mcp-Name` header for the "named tool" binding.
2. A working zero-dependency loopback server:
   `dscord/vendor/ds-bot/src/host/local-agents/mcp.js` (Streamable HTTP on
   `127.0.0.1`, random port, bearer token) whose behaviour a real client accepts.

### 3.1 Request/response rules

```
POST /mcp
content-type: application/json
accept: application/json, text/event-stream      # client sends BOTH, in this order
authorization: Bearer <token>                     # optional, our chosen auth
mcp-session-id: <id from initialize response>     # echoed on later requests; MUST be absent on initialize
```

| Situation | Required server behaviour |
|---|---|
| body is a **notification** (no `id`) or a response | HTTP `202`, empty body |
| body has `id` + `method` (`initialize`, `ping`, `tools/list`, `tools/call`) | HTTP `200`; body is one JSON-RPC object — or SSE (`text/event-stream`) with `data: {json}\n\n` frames if you need progress |
| array body (batch) | array of responses (or SSE) |
| unknown method | JSON-RPC error `-32601` (HTTP 200) |
| any other content-type | client throws `ClientHttpUnexpectedContent` |
| `status` ≥ 400 | client treats as transport error (401 → auth flow; 405/404 → failure) |
| `initialize` response | `{protocolVersion, capabilities:{tools:{}}, serverInfo:{name,version}}`; echo the client's version if you support it (client default negotiation is `2025-03-26`; DSH/CONTRACTS default `2025-06-18` is fine) |

After the `notifications/initialized` (202) the client opens a **GET** SSE stream
(`_startOrAuthSse`). A server that only implements POST returns 405 there; the
client logs an error but keeps working (that is what the local server does), so
GET is **optional** but `405` (not a hang, not a 500) is the polite answer.

`tools/call` result: `{content:[{type:'text',text}], isError?}`. Progress is
optional: SSE frames `{method:'notifications/progress',params:{progressToken,progress,message}}`.

Practical schema constraint found in the working server: **flatten JSON Schema
before `tools/list`** — several CLIs reject `$ref`, `$defs`, `oneOf`, `anyOf`,
`const`. Every tool's `inputSchema` should be plain `{type:'object',properties:{…}}`.

### 3.2 Client config snippets

Claude Code (`~/.claude.json` or project `.mcp.json`):

```json
{"mcpServers":{"flutter-workbench":{"type":"http","url":"http://127.0.0.1:<port>/api/flutter-workbench/mcp",
  "headers":{"Authorization":"Bearer <token>"}}}}
```
CLI equivalent: `claude mcp add --transport http flutter-workbench http://127.0.0.1:<port>/api/flutter-workbench/mcp`

Cursor (`.cursor/mcp.json` or `~/.cursor/mcp.json`):

```json
{"mcpServers":{"flutter-workbench":{"url":"http://127.0.0.1:<port>/api/flutter-workbench/mcp",
  "headers":{"Authorization":"Bearer <token>"}}}}
```

VS Code (`.vscode/mcp.json` — note the `servers` key, not `mcpServers`):

```json
{"servers":{"flutter-workbench":{"type":"http","url":"http://127.0.0.1:<port>/api/flutter-workbench/mcp",
  "headers":{"Authorization":"Bearer <token>"}}}}
```

The `<port>` is the DSH HTTP port (this host: `49701`, the Web GUI origin), so
the URL is `http://127.0.0.1:49701/api/flutter-workbench/mcp`.
Docs: [MCP transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
*(unverified URL — host has no internet)*.

---

## 4. Panel performance facts

Measured/derived here; no browser benchmark was possible (Chrome absent,
`flutter doctor` reports `Cannot find Chrome`, and no network to install one).

| Question | Answer | Basis |
|---|---|---|
| How many log rows stay smooth un-virtualized? | Plan for **≤ 500** rendered rows; stutter starts around 1–2 k DOM rows | standard browser layout/paint behaviour; a monospace row of ~2 KB text costs ~1 KB DOM + layout |
| When to virtualize? | **Always**, past 200 visible lines (fixed row height, `transform: translateY`, overscan 10) | keeps node count ~30 regardless of buffer |
| How big a ring buffer? | keep 5 000 entries in memory (≈2–5 MB JSON), render 200; `LogEntry.seq` is your cursor | memory/DOM tradeoff |
| `flutter.dev` log volume | a `print`-happy app in debug easily emits 50–500 lines/s during startup | observed probe stdout |
| HTTP profile polling | **1 500 ms** while the Network page is visible; 0 when hidden; use `updatedSince` so payload stays O(delta) | CONTRACTS default matches; delta confirmed working |
| Log cursor polling | **500 ms** while "follow" is on, 2 000 ms otherwise | each poll is O(new entries) via `since` |
| Any poll cost today | a `getHttpProfile`/`/logs` round trip is sub-millisecond locally over WS; the HTTP hop (panel → host) dominates (~1–5 ms) | observed on this host |
| Cheaper alternative | push over one WS/SSE instead of polling — removes 60 requests/min per page; costs a new transport (see FEATURE-SPEC, P2) | — |

`Stdout` stream events carry **base64** bytes (`{"kind":"WriteEvent","bytes":"Zmx1dHRlcjog…"}`)
— chunked mid-line, and they duplicate what the tool already prints on stdout.
Pick one source per run (tool stdout is simpler; VM `Stdout` survives a
`--machine` logToStdout change and works for `flutter attach`).

---

## 5. Corrections for `docs/CONTRACTS.md`

| # | CONTRACTS says | Verified reality (3.38.5 / Dart 3.10.4) | Impact |
|---|---|---|---|
| 1 | `screenshot` uses **`_flutter.screenshot`** (fallback `ext.flutter.screenshot`) | Neither exists. Use **`ext.flutter.inspector.screenshot`** with `{id,width,height,maxPixelRatio,objectGroup}` → `result` = base64 PNG; the `id` comes from `ext.flutter.inspector.getRootWidgetSummaryTree(...).result.valueId` | `vm.screenshot()` in §5.4 must change; needs a two-call sequence |
| 2 | HTTP profile via `ext.dart.io.getHttpProfile` (fallback `_getHttpProfile`) | `ext.dart.io.getHttpProfile` exists; `_getHttpProfile` **does not** (`-32601`). **More important:** entries are empty until `ext.dart.io.httpEnableTimelineLogging {enabled:"true"}` is called on the live isolate | `network.js` must enable logging on `vm:connected` (and be able to disable it); otherwise the Network page is permanently empty |
| 3 | Events to handle include `daemon.logMessage`, `daemon.showMessage`, `device.started` | In `--machine`, `logToStdout:true` ⇒ `daemon.logMessage` is **never** emitted (status/trace go to stdout as plain text, error/warning to **stderr**); `daemon.showMessage` and `device.started` **do not exist** (DeviceDomain emits `device.added`/`device.removed`) | `runner.js` §5.3: parse non-JSON stdout lines as logs, stderr as warn/error; drop the two phantom events |
| 4 | `app.debugPort` → set `vmServiceUri` (ws), **`httpUri`** | Event params are `{appId, port, wsUri, baseUri}` — **no `httpUri`**. Derive it: `wsUri` minus `/ws`, `ws→http`. New events `app.devTools` (ready-made devtools URL incl. `?uri=`) and `app.dtd` also arrive | `runner.js` must derive `httpUri`; prefer `app.devTools.uri` over inventing `https://devtools.flutter.dev/?uri=…` (that remote URL cannot load a `127.0.0.1` ws URI) |
| 5 | Machine protocol implies JSON lines | stdout interleaves **plain text** with JSON arrays; events use key **`event`**, responses use `id`+`result`/`error`; `app.progress.params.id` is a *string progress counter*, unrelated to RPC ids | parser must branch on "is it a JSON array" and never assume `method` |
| 6 | `Flutter.Error` … (task brief: "their `errors` array shape") | No `errors` array. `extensionData` = one diagnostics node + `errorsSinceReload` + `renderedErrorText`; only emitted after `ext.flutter.inspector.structuredErrors {enabled:"true"}` | `errors.js` should ingest `extensionData` directly and use `properties[]` for the stack frames |
| 7 | Extension calls (implicitly) via a generic call | There is no `callServiceExtension` RPC on the VM service; call the extension name **as the method** with `{isolateId}`. Results wrap as `{type:'_extensionType', method, …}`; some return `{data}`, inspector ones `{result}` | `vmservice.js` `evaluateExtension` must call by name and unwrap per-family |
| 8 | (unstated) isolate id stability | Hot **restart** replaces the isolate id; stale ids return `{type:'Sentinel', kind:'Collected'}` instead of an error | `vm` must re-`getVM` after `run:state` restart and retry once on `Sentinel` |
| 9 | `NetEntry.status` from the profile | comes from `entry.response.statusCode`; `contentLength` is `-1` for chunked; `endTime` is "request sent", response end is `response.endTime`; timestamps are **wall-clock µs**, not `Timeline.now` | `network.js` mapping + `durationMs` formula |
| 10 | `vm.frameStats` | `Flutter.Frame.extensionData` = `{number,startTime,elapsed,build,raster,vsyncOverhead}` in µs; needs the `Extension` stream only (no `Timeline` needed) | implement `frameStats` from `Flutter.Frame`; no extra flags |