# FEATURE-SPEC — dsh-flutter-workbench

Ranked, implementation-ready backlog for the panel described in
[CONTRACTS.md](../CONTRACTS.md). Every P0/P1 item below is buildable with the
modules and files that already exist (Host ESM + zero deps + one panel) and with
the protocol facts verified in
[research/flutter-internals.md](research/flutter-internals.md).

**Research constraint, stated up front:** this host has **no internet**
(`Invoke-WebRequest` to pub.dev / github / modelcontextprotocol fails; the
configured proxy `127.0.0.1:7890` is not listening). Market claims therefore come
from the shipped tooling on disk (Flutter 3.38.5 SDK sources, DevTools 2.51.1
assets, the `@modelcontextprotocol` SDK bundled inside the `dscord` plugin) plus
product knowledge; the URLs in §6 are canonical references, not fetched pages.

---

## 1. What the competition actually saves you

“Saves” = the manual steps a developer performs today without the tool. This is
the only ranking criterion used later.

| Tool / surface | Feature that matters | Steps it removes | Verdict for us |
|---|---|---|---|
| **Flutter DevTools — Inspector** | widget tree with `creationLocation{file,line,column}`; click a node → editor opens | find file → find line → scroll | **P0** — extension already gives us `creationLocation` for free |
| **DevTools — Network** | request list + full request/response headers, bodies, status, timing | open proxy / add logging / re-run | **P0** — same data via `ext.dart.io.*` |
| **DevTools — Logging / Console** | one merged stream, filter by source, structured errors | alt-tab between terminal tabs | **P0** (already in CONTRACTS) |
| **DevTools — Performance** | frame chart, jank markers, build/raster split | guess whether the jank is build or raster | **P0-lite** — `Flutter.Frame` gives build/raster per frame |
| **DevTools — Memory** | heap snapshots, allocation profile, diff | — | **P2 / don't build** (heavy UI, low daily use) |
| **DevTools — “Open DevTools”** | one URL that carries the VM service URI | copy ws URI, paste into browser | **P0** — we get `app.devTools.uri` ready-made from the machine protocol |
| **VS Code Dart/Flutter ext.** | `launch.json` configs; F5; hot reload key; **error lens** (inline message + stack, click → jump); Test explorer; TODO tree | copy a run command; copy stack traces | **P0**: launch.json parsing + inline error + jump. **P1**: test runner view. **Reject**: TODO tree (needs a whole-project index) |
| **Android Studio / IntelliJ Flutter** | run config dropdown, device picker, logcat pane, “Flutter Inspector” docked | — | same three affordances; we ship them as the Runtime page |
| **Sentry / Bugsnag triage** | dedupe by fingerprint, count, first/last seen, stack + breadcrumbs | re-reading 500 identical stack traces | **P0** — `ErrorGroup.fp/count/firstAt/lastAt` is already in CONTRACTS |
| **Charles / Proxyman** | sortable request list, “errors only”, status/colour coding, body viewer, timing waterfall | cert install + proxy setup | **P0** for list+detail; **reject** the MITM proxy itself (needs a process + certs) |
| **Console-style log viewers** | follow/tail, level colouring, regex filter, copy, “jump to source” | scroll-hunting | **P0**; virtualize past 200 rows (see internals §4) |
| **Linear / Jira / GitHub Projects** | board lanes, drag, per-card acceptance criteria, history | spreadsheet + memory | **P1** (board already contracts); P0 is only “dispatch card → agent → result lands back on the card” |
| **Cursor / Claude Code task lists** | a task the agent can *execute*: objective + acceptance + verify commands, result written back | re-typing context into the chat | **P0** — this is the product's differentiator: `dispatch` seeds the card contract, `report` closes it |
| **`flutter run` terminal itself** | the true source of truth for reload results (“Reloaded 1 library”, errors) | — | **P0**: never swallow it — show it verbatim |

---

## 2. Ranked backlog

Effort: **S** ≤ 2 h, **M** ≈ half a day, **L** ≈ a day or more (one dev, tests included).
“Deps” = files that must be touched. Nothing here needs a new npm package, a new
process, or a second panel.

### P0 — ship these or the product has no reason to exist

| ID | Feature | Page / module | Why it wins | Effort | Deps |
|---|---|---|---|---|---|
| **P0-1** | **Jump-to-code from anywhere**: every stack frame, analyzer issue, test failure and inspector node is a click → `flutter_open {file,line}` → editor at line | `60-quality.js`, `30-logs.js`; `host/tools.js`, `host/httpapi.js` | Removes the single most repeated manual step (copy `file:line`, switch app, find) | S | errors/analyze/test data + existing tool |
| **P0-2** | **Network inspector that is actually populated**: enable `ext.dart.io.httpEnableTimelineLogging` on connect, delta-poll `getHttpProfile` with `updatedSince`, bodies via `getHttpProfileRequest` (byte arrays → UTF-8), errors-only toggle, status colouring, duration | `40-network.js`; `host/network.js`, `host/vmservice.js` | The 401/500 loop is the most common client bug; DevTools-grade data becomes one click instead of a proxy install | M | must fix CONTRACTS #2 (see internals §5) |
| **P0-3** | **Truthful run state**: phase pill (starting/running/reloading/restarting/stopped/failed), verbatim reload result (`code`+`message`, e.g. *“Reloaded 1 library”*, *“No changes detected”*, failure text), last-reload age, VM connected/disconnected dot | `20-runtime.js`; `host/runner.js`, `host/vmservice.js` | Kills “hot reload did nothing” — the user can *see* whether anything happened | S | `app.restart` result already returns `{code,message}` |
| **P0-4** | **Structured error inbox**: `Flutter.Error` ingested with `errorsSinceReload`, `renderedErrorText`, `properties[]`→frames, fingerprint dedupe, count + first/last seen, one-click copy-as-markdown | `60-quality.js` (errors); `host/errors.js`, `host/vmservice.js` | Replaces re-reading 200 identical red screens; also the hand-off artifact to the AI | M | needs `ext.flutter.inspector.structuredErrors {enabled:"true"}` |
| **P0-5** | **Logs that behave like a console**: follow/tail, level+source filter, regex, markers (`flutter_log_mark`), cursor-based incremental fetch, jump-to-code, virtualized list, copy selection | `30-logs.js`; `host/logs.js` | Table stakes; without cursors the panel melts on a chatty app | M | — |
| **P0-6** | **Board card → agent → result on the same card**: dispatch seeds objective/acceptance/verify/files; report writes commands+evidence+verdict back; card cannot enter `done` without `verdict:'pass'` | `50-board.js`; `host/board.js` | The differentiator vs. DevTools: the debugging session becomes executable work | M | `ctx.get('agents')` must exist (graceful degrade otherwise) |
| **P0-7** | **One-click artifact pack**: screenshot button that works on desktop (`getRootWidgetSummaryTree` → `valueId` → `inspector.screenshot`) and saves a PNG under `~/.dsh/flutter-workbench/shots/` | `60-quality.js`; `host/vmservice.js` | “What does it look like right now” without a phone screenshot round-trip | S | replaces the wrong `_flutter.screenshot` in CONTRACTS |

### P1 — high value, clearly after the core loop

| ID | Feature | Page / module | Why | Effort | Deps |
|---|---|---|---|---|---|
| P1-1 | **Analyzer + test results as first-class lists** (`dart analyze --format machine`, `flutter test --reporter json`) with per-test duration and error, jump-to-code | `60-quality.js`; `host/analyze.js` | Test-failure loop without leaving the panel | M | std. machine formats |
| P1-2 | **Jank badge + frame strip** (`Flutter.Frame` → build/raster/elapsed bars, p95, “worst 10 frames”) | `60-quality.js`; `host/vmservice.js` | Answers “is it build or raster?” in one glance | M | `Extension` stream only |
| P1-3 | **Widget tree browser** (summary tree → children on expand, `creationLocation` → jump) | `60-quality.js`; `host/vmservice.js` | Inspector parity, read-only | M | `ext.flutter.inspector.*` |
| P1-4 | **Widget tree text dump** (`debugDumpApp`) with search + copy | `60-quality.js` | Cheapest inspector substitute (60 KB text, verified) | S | — |
| P1-5 | **Diffable request body viewer** (pretty JSON, size, truncation flag) | `40-network.js` | Bodies are byte arrays; a raw hex view is useless | S | — |
| P1-6 | **Run config matrix**: launch.json + entry points + flavors + device picker, remembered per project | `20-runtime.js`; `host/runconfig.js` | Stops re-typing `--flavor`/`--dart-define` | M | JSONC parsing |
| P1-7 | **`flutter attach` mode** (`flutter attach --machine`) to an already-running app | `20-runtime.js`; `host/runner.js` | Same protocol surface, reuse of the whole VM pipeline | M | new spawn variant only |
| P1-8 | **AI explain-error action**: send the top `ErrorGroup` (message+frames+last 50 log lines) to an agent and paste the answer under the error | `60-quality.js`; `host/errors.js` | Turns a red screen into a hypothesis without copy-paste | M | `ctx.get('agents')` |
| P1-9 | **Board ↔ error link**: “create card from this error” pre-filling title/acceptance/verify from the `ErrorGroup` | `50-board.js` + `60-quality.js` | Makes triage produce work items | S | — |
| P1-10 | **Command palette** (`Ctrl/Cmd+K`) over pages + actions + recent files | `10-shell.js` | Keyboard-first users stop hunting | S | — |

### P2 — only if the core is done and someone asks

| ID | Feature | Why it is P2 |
|---|---|---|
| P2-1 | Timeline waterfall (BUILD/LAYOUT/RASTER phases from the `Timeline` stream) | Floods the socket; needs a real trace UI. `Flutter.Frame` covers 90 % of jank questions |
| P2-2 | Memory: heap snapshot + allocation profile + diff | Large UI, DevTools already good, daily value low |
| P2-3 | CPU sampling flame chart (`Profiler` stream) | Needs a flame-chart renderer; a whole sub-project |
| P2-4 | Socket inspector UI (`ext.dart.io.getSocketProfile`) | Data exists, but nobody debugs sockets daily; keep the host method, no page |
| P2-5 | Multi-project dashboards / several live runs at once | CONTRACTS guards one run per project; the state machine would need a rework |
| P2-6 | SSE/WS push instead of polling | Removes ~60 req/min per page (internals §4), but polling already meets the latency target; only worth it if the panel is open all day |
| P2-7 | Board analytics (cycle time, agent success rate) | Nice, but nothing blocks on it |

---

## 3. P0 acceptance-level descriptions

Each is written so QA can pass/fail it without asking a question.

**P0-1 Jump-to-code.** Every rendered stack frame / analyzer issue / test failure
is a button. Clicking calls `flutter_open {file, line}` and the configured editor
opens at that line. A frame whose `file` is inside the Flutter SDK opens the SDK
file (not a “not found” toast). Frames with no `file` (e.g. `<asynchronous
suspension>`) render as non-clickable text, not a dead link. Keyboard: `Enter` on
a focused frame opens it. **Pass:** click the top frame of a real exception →
editor opens at the exact line named in the frame.

**P0-2 Network inspector.** On `vm:connected` the host calls
`ext.dart.io.httpEnableTimelineLogging {enabled:"true"}` (recorded in logs at
`debug`), and calls it with `"false"` on disconnect/stop. While the Network page
is visible it polls `getHttpProfile` with `updatedSince` every 1500 ms and the
list grows without duplicates. Rows show method, path+host, status (colour:
2xx ok, 3xx dim, 4xx warn, 5xx error, no-status error), duration
(`response.endTime ?? endTime − startTime`), and size. `errorsOnly` hides
everything with `status < 400 && status != null`. Clicking a row calls
`getHttpProfileRequest` and shows request/response headers as tables and bodies
decoded from the byte array (JSON pretty-printed when it parses, otherwise size +
hex preview, truncated flag when > `maxBodyBytes`). **Pass:** the app makes a
`401` call; the row appears within 2 s with status 401 and body
`{"error":"unauthorized"}`; with logging not enabled the page says
“network capture is off” instead of showing an empty list.

**P0-3 Truthful run state.** Header pill shows the phase from `RunState.phase`.
After `app.restart` the panel shows the **verbatim** `message` returned by the
machine protocol and a relative timestamp (“reload #3 · 12 s ago”), and the count
`hotReloads`/`hotRestarts` from `RunState`. When `code != 0` the message is
rendered as an error with the same text the terminal would print. VM connection
dot is green only while the WS is open, amber while reconnecting, red when the
run is alive but the VM is gone. **Pass:** trigger a reload with no file change →
panel shows “No changes detected”/`Reloaded 0 libraries`, not a spinner.

**P0-4 Structured error inbox.** Each `Flutter.Error` event produces exactly one
`ErrorGroup` whose `message` is `extensionData.description`, whose frames come
from `extensionData.properties` (`file`/`line` from any `file:///…:line:col`
occurrence, `symbol` from the leading identifier), and whose `context` is
`renderedErrorText`. Repeats of the same fingerprint increment `count` and update
`lastAt` instead of adding rows. `errorsSinceReload` is displayed (“error 2 since
reload”). Copy produces a markdown block: title, message, frames, last 20 log
lines. **Pass:** trigger the same exception twice → one row with `count: 2`.

**P0-5 Console behaviour.** `GET /logs?since=<cursor>` returns only newer
entries; UI keeps a 5 000-entry ring and renders a virtualized window (~30 nodes).
Follow mode auto-scrolls only when the user is already at the bottom. Filters
(level, source, regex) are applied host-side via the query and reflected in the
URL state. `flutter_log_mark` inserts a visible divider with a timestamp.
**Pass:** with 20 000 buffered lines, scrolling stays smooth and CPU stays flat
while following; clearing the filter shows the full buffer again.

**P0-6 Card → agent → card.** `POST /board/dispatch` creates a session whose
prompt contains the card's objective, acceptance bullets, verify commands and
files; the card moves to `running` and shows the session id. `report` writes
`result{summary,commandsRun,evidence,files,verdict}`, moves the card to `review`
(or `failed` when `verdict:'fail'`) and appends `history`. Dragging to `done`
without `verdict:'pass'` is refused with a toast naming the missing verdict;
`force:true` (explicit user action) is allowed and recorded. If `agents` is
unavailable, dispatch returns a clear error and the card stays put.
**Pass:** dispatch a card, let the agent report `pass`, drag to `done` — allowed;
dispatch another and try to drag to `done` before any report — refused.

**P0-7 Screenshot.** `POST /screenshot` returns `{ok, path, bytes, width,
height}` with a real PNG on disk; the panel renders it inline and offers
“reveal in folder”. Sequence used: `getRootWidgetSummaryTree {objectGroup}` →
`result.valueId` → `ext.flutter.inspector.screenshot {id, width, height,
maxPixelRatio:"1.0", objectGroup}` → base64 → file. Errors resolve to
`{ok:false, code, message}` (no hang). **Pass:** press the button on a live
`-d windows` run → PNG with the current UI, dimensions matching the requested
size.

---

## 4. Five UX flows (what people actually do)

### Flow A — “the screen is blank / red after startup”
1. Start the run; the header pill goes `starting → running`, and the bottom bar shows `app.started` time.
2. Quality page → **Errors**: the newest `ErrorGroup` is already at the top with `count`, `errorsSinceReload` and `renderedErrorText` (the same text the terminal prints).
3. Click the first frame → editor opens at `lib/main.dart:42`.
4. If there is no error at all: Quality → **Widget tree** (summary tree). Empty tree ⇒ app never called `runApp`; tree present but no `MaterialApp` ⇒ composition bug.
5. Press **Screenshot** to confirm what the engine actually shows (blank vs. red error box vs. spinner).
6. Logs page, filter `source=stderr` to see the tool's own complaints (build/toolchain).
   
*Steps removed:* open a terminal, scroll for the exception, copy the path, guess.

### Flow B — “a request returns 401”
1. Network page is already polling; status colours make the 401 row obvious; toggle **errors only** to drop the noise.
2. Click the row → drawer shows request headers (is `authorization` present? stale?), response headers, and the decoded body.
3. Filter by `host=api.example.com` + `status=4xx` to see whether *every* call fails or only one endpoint.
4. Compare with the previous successful call (same path, 200) — request-header diff shows the missing/changed header.
5. Click **Copy as cURL**; or press `J` on the row to open the calling file if the log line carried a frame.
6. Create a board card from the row (“fix 401 on POST /session”) with acceptance “200 + token refresh path covered”.

*Steps removed:* install a proxy, add `print` statements, restart the app.

### Flow C — “hot reload did nothing”
1. Header shows `reloading…` then `running`, plus the **verbatim** result: `Reloaded 0 libraries` = nothing changed, `No changes detected` = file not saved / wrong project.
2. `hotReloads` counter increments (it did *not* silently no-op).
3. Press **Restart** instead; the pill shows `restarting`, the VM dot goes amber (isolate id changes — see internals §2.7) and returns green.
4. Logs: `flutter` source shows the tool's own lines; if the reload failed, the failure text is inline (not swallowed).
5. If state is stale after restart: Quality → errors clears on `errorsSinceReload` reset; the panel re-resolves the isolate automatically.

*Steps removed:* staring at a terminal that scrolled past the one-line answer.

### Flow D — “a test fails”
1. Quality → **Tests** → Run; rows stream in (JSON reporter), failures first, each with duration.
2. Click a failing test → its `error` + `stack` open; click a stack frame → editor at that line.
3. **Rerun this test only** button (`flutter test --plain-name`), keeps the previous result for comparison.
4. `flutter_analyze` on the touched file shows whether the cause is a warning that became an error.
5. Logs marker `flutter_log_mark "after fix"` splits before/after in the console.
6. Card: “make test X pass” with `verify: flutter test test/x_test.dart`.

*Steps removed:* re-running the whole suite to see one failure again.

### Flow E — “the app janks”
1. Quality → **Perf**: sparkline of `build` and `raster` per frame from `Flutter.Frame`; p95 and the 10 worst frames listed.
2. Verdict line: *“build-bound”* (build > raster in the worst frames) vs *“raster-bound”*.
3. Click the worst frame → the frame's `startTime` is copied as a marker; switch to Logs and use the marker to cut exactly that window.
4. If build-bound: enable `ext.flutter.profileWidgetBuilds` and reload to get rebuild counts (P1).
5. If raster-bound: note it (shader/impeller territory) and create a card with the frame numbers as evidence.

*Steps removed:* exporting a trace to DevTools just to learn “build vs raster”.

---

## 5. Do not build (and why)

| Not building | Reason |
|---|---|
| Iframe-embedding DevTools (`devtools.flutter.dev?uri=…`) | Needs internet + a cross-origin ws bridge; the remote page cannot reach `127.0.0.1`'s VM service from a different origin. We link out instead (`app.devTools.uri`, which is local and correct) |
| MITM proxy / certificate install (Charles/Proxyman style) | Requires a separate process + OS trust store changes — outside “one Host module set + one panel”, and a security liability |
| Crash reporting backend (Sentry/Bugsnag SaaS) | Network + account + PII handling. Local fingerprint dedupe (P0-4) gives 80 % of the triage value |
| Interactive widget selection overlay on the device | Needs engine-side touch coordinates + a repaint loop + overlay; read-only tree + screenshot covers the debugging need |
| Code editing / AI auto-fix writing files | The panel would need buffers, undo and conflict handling; the agent channel already edits the repo properly |
| TODO/FIXME project index | Needs whole-project indexing (a second watcher); VS Code already does it |
| Memory & CPU profiler UIs | Huge, low frequency, and DevTools is one click away (we link) |
| Multi-run / multi-project live sessions | CONTRACTS deliberately allows one live run per project; changing that destabilises the runner |
| Kanban cloud sync / collaboration | Needs a server; the board is a local single-user tool |
| Device video recording | No protocol support in the machine protocol; screenshot only |
| Android/iOS emulator management | No Android SDK on this host; keep `flutter emulators` pass-through only (P2 at best) |
| Auto-updating the board from git (issues ↔ cards) | Needs `git` + a remote and a mapping UI; out of scope |

---

## 6. Citations

Primary (installed on this host, verified by reading/running):

- `D:\develop\flutter_windows_3.38.5-stable\flutter\packages\flutter_tools\lib\src\commands\daemon.dart` — machine protocol events/requests, `protocolVersion '0.6.1'`, `logToStdout: true` behaviour.
- `…\flutter\packages\flutter\lib\src\widgets\widget_inspector.dart:1008-1031` — `Flutter.Error` payload and `structuredErrors` gate.
- `…\flutter\packages\flutter\lib\src\scheduler\binding.dart:1382-1390` — `Flutter.Frame` fields.
- `…\flutter\bin\cache\dart-sdk\lib\io\network_profiling.dart` — `ext.dart.io.*` names, `HttpProfile` shape, `getVersion` 4.0.
- `…\flutter\bin\cache\dart-sdk\lib\_http\http_impl.dart:7-237, 3016-3020` — `HttpProfileRequest` fields and the `enableTimelineLogging` gate.
- `%APPDATA%\dsh-desktop\harness\profiles\.generations\live\dscord+…\node_modules\@modelcontextprotocol\core\dist\schemas-*.mjs` — MCP protocol version constants.
- `…\dscord\vendor\ds-bot\src\host\local-agents\mcp.js` — working Streamable-HTTP MCP server (202, SSE, bearer auth, schema flattening).

Secondary (canonical references; **not fetched — no network here**):

- Flutter DevTools overview — https://docs.flutter.dev/tools/devtools/overview
- DevTools Network view — https://docs.flutter.dev/tools/devtools/network
- DevTools Performance view — https://docs.flutter.dev/tools/devtools/performance
- DevTools Inspector — https://docs.flutter.dev/tools/devtools/inspector
- DevTools Memory view — https://docs.flutter.dev/tools/devtools/memory
- `flutter run` / interactive commands — https://docs.flutter.dev/tools/run
- Hot reload — https://docs.flutter.dev/tools/hot-reload
- `flutter run --machine` protocol (flutter_tools README) — https://github.com/flutter/flutter/blob/master/packages/flutter_tools/doc/daemon.md
- VM Service protocol — https://github.com/dart-lang/sdk/blob/main/runtime/vm/service/service.md
- dart:io service extensions — https://github.com/dart-lang/sdk/blob/main/runtime/vm/service/service_extension.md
- `package:vm_service` — https://pub.dev/packages/vm_service
- VS Code Dart/Flutter extension (launch.json, test runner) — https://dartcode.org/docs/
- Dart test JSON reporter — https://github.com/dart-lang/test/blob/master/pkgs/test/doc/json_reporter.md
- MCP transports (Streamable HTTP) — https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
- MCP lifecycle (`initialize`, `notifications/initialized`) — https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle
- Claude Code MCP config — https://docs.anthropic.com/en/docs/claude-code/mcp
- Cursor MCP — https://docs.cursor.com/context/model-context-protocol
- VS Code MCP servers — https://code.visualstudio.com/docs/copilot/chat/mcp-servers
- Proxyman — https://proxyman.io/ ; Charles — https://www.charlesproxy.com/
- Sentry grouping/fingerprints — https://docs.sentry.io/concepts/data-management/event-grouping/
- Linear board/cycles — https://linear.app/docs ; GitHub Projects — https://docs.github.com/issues/planning-and-tracking-with-projects
- `react-window` (virtualization baseline) — https://github.com/bvaughn/react-window
- Chrome rendering performance (frame budget) — https://web.dev/articles/rendering-performance

---

## 7. Open questions for the Lead

1. **`netStore` auto-refresh default** — CONTRACTS says `intervalMs=1500`; with
   `httpEnableTimelineLogging` on, each poll is cheap (`updatedSince`) but the flag
   also spams the `Timeline` stream. Recommendation: enable logging only while the
   Network page is open, and expose it in Settings.
2. **`vm.screenshot()` signature** must change to the two-call
   inspector sequence (CONTRACTS §5.4). Who owns that: `dev-vm`?
3. **`baseDir` vs `httpUri`** in `RunState` — the machine protocol gives `wsUri`
   and `baseUri` (a `file:///` path for desktop, an `http://` URL for web). Do we
   want `RunState.baseUri` instead of inventing `httpUri`? (The HTTP root *is*
   derivable from `wsUri`; `baseUri` is something else entirely.)
4. **`ErrorGroup.kind`** — `Flutter.Error` events are `kind:'flutter'`; analyzer
   issues should not enter the error store (separate list), otherwise the counts
   in the left rail double-count.