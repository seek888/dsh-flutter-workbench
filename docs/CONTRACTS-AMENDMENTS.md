# CONTRACTS amendments (verified on this host)

Evidence: `docs/research/flutter-internals.md` §5 (Flutter 3.38.5 / Dart 3.10.4,
`-d windows`). These override the corresponding sentences in `docs/CONTRACTS.md`.
Read this file before implementing `runner.js`, `vmservice.js`, `network.js`.

1. **Screenshot** — `_flutter.screenshot` and `ext.flutter.screenshot` do not
   exist. Sequence: `ext.flutter.inspector.getRootWidgetSummaryTree{objectGroup}`
   → take `result.valueId` → `ext.flutter.inspector.screenshot{id, width, height,
   maxPixelRatio:"1.0", objectGroup}` → base64 PNG.
2. **HTTP profile is empty by default** — `_getHttpProfile` returns -32601. Entries
   stay empty until `ext.dart.io.httpEnableTimelineLogging{enabled:"true"}` is
   called on the live isolate (default is false). Enable on connect, disable on
   disconnect. Also available: `ext.dart.io.clearHttpProfile`,
   `ext.dart.io.getHttpProfile{updatedSince}` (delta polling).
3. **Machine protocol events** — with `--machine`, `logToStdout` is true, so
   `daemon.logMessage` is NEVER emitted; status/trace arrive on stdout as plain
   text, error/warning on stderr. `daemon.showMessage` and `device.started` do
   not exist (use `device.added`/`device.removed`). Stdout INTERLEAVES plain text
   with JSON arrays; event objects carry key `"event"`, not `"method"`.
4. **`app.debugPort` params** are `{appId, port, wsUri, baseUri}` — there is NO
   `httpUri`. Derive it (drop `/ws`, ws→http). New: `app.devTools {uri}` and
   `app.dtd {uri}`; prefer `app.devTools.uri`. The hardcoded
   `https://devtools.flutter.dev/?uri=<local ws>` cannot work.
5. **No `callServiceExtension` RPC** (-32601). Call the extension name itself with
   `{isolateId}`. Results wrap: `debugDumpApp*` → `{data}`, `inspector.*` →
   `{result}`, `dart:io` → raw object.
6. **`Flutter.Error` has no `errors` array** — `extensionData` is one diagnostics
   node plus `errorsSinceReload` + `renderedErrorText` + `properties[]`, and it
   only fires after `ext.flutter.inspector.structuredErrors{enabled:"true"}`.
7. **Isolate lifecycle** — a full restart replaces the isolate id; a stale id
   returns `{type:"Sentinel", kind:"Collected"}` (not an error). Re-`getVM` and
   retry once on Sentinel.
8. **NetEntry mapping** — `status` = `response.statusCode` (not top level);
   `durationMs` = `(response.endTime ?? endTime) - startTime` (`endTime` means
   "request sent"); `contentLength` is -1 when chunked; timestamps are wall-clock
   µs; `getHttpProfileRequest` bodies are JSON arrays of bytes (decode as UTF-8).
9. **MCP** — client sends `Accept: application/json, text/event-stream`, needs
   202+empty for notifications and 200+JSON (or SSE) for requests. Latest SDK
   protocol version 2025-11-25; the CONTRACTS default 2025-06-18 is accepted.
   Flatten JSON Schema (no `$ref`/`oneOf`/`const`) before `tools/list`.
10. **Polling/perf** — enable timeline logging only while the Network page is
    visible (it also floods the Timeline stream). Poll 1500 ms visible / 0 hidden;
    log cursor 500 ms following, 2000 ms otherwise; virtualize past 200 rows with
    a 5k ring.

Open question left to the integrator: keep `httpUri` (derived) or expose
`baseUri`, which is a `file:///` path on desktop.
