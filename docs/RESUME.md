# RESUME — what is left, in order

Read this before any work. `docs/CONTRACTS.md` is the architecture contract and
`docs/CONTRACTS-AMENDMENTS.md` overrides it wherever they disagree.

## State (audited, not claimed)

Host — real and wired: `runner.js` (flutter run --machine supervisor),
`runconfig.js` (launch.json JSONC / entry points / devices / emulators / flavors),
`analyze.js` (analyzer machine format, test JSON reporter, pub get, clean, build,
doctor, format), `board.js` (kanban engine), `httpapi.js` (full route table,
including `/open`, `/file`, `/perf`, `/screenshot/file`, `/network/clear`,
`/board/cancel`, `/settings/rotate-token`, `/mcp`), `mcp.js`, `tools.js` (25
tools), plus `util/store/logs/settings/projects`.

Client — real: `00-prelude` (94 KB kit + i18n), `10-shell` (28 KB layout),
`20-runtime` (44 KB), `30-logs` (27 KB console), `40-network` (35 KB),
`50-board` (65 KB kanban with drag & drop), `60-quality` (55 KB analyze/tests/
exceptions/perf/screenshot/settings). `client/client.js` builds to 353 KB and
parses.

Tests: 51 offline, all passing — `node --test test/board.test.mjs` 29,
`test/tools.test.mjs` 6, `test/mcp.test.mjs` 16.

## VM layer — DONE (t3 attempt 2). 43 new tests, live-verified against a real Dart VM service.
## The one remaining task (blocker for QA sign-off)

Only real QA and `POST /logs/mark` remain. The VM layer already implements these
corrections (kept here as the record of what the SDK actually does, differing from
`CONTRACTS-AMENDMENTS.md` that change method names and call order:

1. Screenshot = `ext.flutter.inspector.getRootWidgetSummaryTree{objectGroup}` →
   `valueId` → `ext.flutter.inspector.screenshot{id, width, height,
   maxPixelRatio:"1.0", objectGroup}` → base64 PNG. (`_flutter.screenshot` does
   not exist.)
2. The HTTP profile is EMPTY until `ext.dart.io.httpEnableTimelineLogging
   {enabled:"true"}` runs on the live isolate. Enable on connect, disable on
   disconnect; use `getHttpProfile{updatedSince}` for deltas.
3. `Flutter.Error` has no `errors` array; enable
   `ext.flutter.inspector.structuredErrors{enabled:"true"}` and read
   `extensionData` (one diagnostics node + `errorsSinceReload` +
   `renderedErrorText`).
4. No `callServiceExtension` RPC — call the extension name with `{isolateId}`.
5. A stale isolate returns `{type:"Sentinel",kind:"Collected"}`: re-`getVM` and
   retry once.
6. `NetEntry`: `status = response.statusCode`,
   `durationMs = (response.endTime ?? endTime) - startTime`, `contentLength` is
   -1 when chunked, bodies are byte arrays decoded as UTF-8.
7. `ws.js` must be a dependency-free RFC6455 client (handshake, masked frames,
   ping/pong, close, fragmentation) — do not rely on a global `WebSocket`.

Also missing: `POST /logs/mark` (the client asks for it and degrades to a 404
toast; `flutter_log_mark` already exists as a tool).

## Then

1. `node --test test/` and `node scripts/build-client.mjs`.
2. Install: `plugin_manager` `install_bundle` with this directory, then
   `unlag_refresh`, then open the panel.
3. Real QA (never run yet): add a `flutter create` project, start a run on
   `-d windows`, hot reload, confirm logs + network + screenshot, drive a board
   card through create → dispatch → report → done, and call MCP
   `initialize`/`tools/list`/`tools/call` with the token from
   `~/.dsh/flutter-workbench/store.json`.

## Team state

Tasks t1 (research), t2 (runner/toolchain), t4 (board), t5 (api/mcp), t6
(ui-core), t7 (ui-data) are complete. t3 (VM layer) FAILED on `429 QUOTA` and
must be retried; t8 (verification) is blocked on it, and t9 (fix pass) on t8.
The account hit a person-level token rate limit, which killed five members
mid-turn — that is the only reason anything here is unfinished.
