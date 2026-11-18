# dsh-flutter-workbench

A Flutter client-dev workbench as a DeepSeek Harness plugin: one full-page panel
that runs your project, hot reloads it, streams the logs, inspects HTTP traffic
through the Dart VM Service, and gives both you and the AI a kanban board whose
cards an agent can execute. The same capabilities are exposed to the AI as DSH
tools and as an HTTP MCP server.

> ## Status: PARTIAL — scaffold installed, feature modules still stubs
>
> Built and verified on this machine:
> - bundle installs into a DSH Desktop profile (`application: applied`, no warnings)
> - the panel is registered live: `main` slot key `flutter-workbench` + a sidebar icon
> - `docs/CONTRACTS.md` — the full module / HTTP / tool / client contract
> - `host/util.js`, `host/store.js`, `host/logs.js`, `host/settings.js`, `host/projects.js` (complete)
> - `host/tools.js` — 25 AI/MCP tools over the workbench services (complete, tested)
> - client bundle pipeline (`scripts/build-client.mjs`) + shell skeleton + slot registration
>
> Implemented on the Host: `runner.js` (flutter run --machine supervisor),
> `runconfig.js` (launch.json / entry points / devices / flavors), `analyze.js`
> (analyzer, tests, pub get, build, doctor, format), `board.js` (kanban engine),
> `httpapi.js` (full route table incl. /open and /mcp), `mcp.js`, `tools.js`
> (25 tools), plus the shared `util/store/logs/settings/projects` foundation.
> Implemented in the Client: all six pages — prelude+shell (94 KB / 28 KB),
> runtime (44 KB), logs (27 KB), network (35 KB), board (65 KB),
> quality+settings (55 KB). `client/client.js` builds to 353 KB and parses.
>
> **Still stubbed — the VM-service layer:** `host/ws.js`,
> `host/vmservice.js`, `host/network.js`, `host/errors.js`. Until those land,
> run/hot-reload/logs/analyze/test/board all work, but the network inspector,
> screenshots, widget-tree dump, frame stats and exception de-duplication do not
> (they depend on the Dart VM Service socket). Read
> `docs/CONTRACTS-AMENDMENTS.md` before writing them: five of its ten corrections
> change method names and call sequences.
>
> Tests: `node --test test/board.test.mjs` 29/29, `test/tools.test.mjs` 6/6,
> `test/mcp.test.mjs` 16/16 (51 total, all offline).
>
> The development run hit the account's token rate limit before the parallel
> authors could land their modules. The task graph, per-module contracts and
> acceptance criteria are preserved (see `docs/CONTRACTS.md` §2 and the task
> list in the team), so the work resumes without re-planning.

## What it will do when complete

1. **Run** — discovers `.vscode/launch.json` configurations, `lib/main*.dart`
   entry points, devices/emulators and flavors, then runs
   `flutter run --machine` and supervises it.
2. **Debug loop** — hot reload, hot restart, stop, exit-code and crash detection,
   VM Service WebSocket URI and a DevTools deep link.
3. **Logs** — bounded ring buffer with levels, sources (flutter/stdout/stderr/
   daemon/vm/network/ai), cursors, regex search, markers for time correlation.
4. **Network** — HTTP profile from the VM Service (`ext.dart.io.*`): method, URI,
   status, durations, headers and bodies, error highlighting.
5. **Quality** — `dart analyze` machine format, `flutter test` JSON reporter,
   deduped exception groups with file:line frames, frame/jank stats, screenshots.
6. **AI** — 25 tools (`flutter_status`, `flutter_logs`, `flutter_network`,
   `flutter_run`, `flutter_reload`, `flutter_analyze`, `flutter_test`,
   `flutter_screenshot`, `flutter_tasks`, …) plus a JSON-RPC MCP endpoint at
   `/api/flutter-workbench/mcp` with a bearer token.
7. **Board** — six lanes (backlog → ready → running → review → verify → done),
   drag & drop, acceptance criteria, verify commands, AI decomposition of an
   idea into cards, dispatch of a card to an agent, result reporting.

## Install

```bash
git clone <this repo> dsh-flutter-workbench
```

Then in DSH: Plugin Manager → install bundle from the cloned directory
(or, from a Harness session, `plugin_manager` `install_bundle` with that
absolute path). No build step and no npm dependencies: the host half is plain
Node ESM and `client/client.js` is generated from `client/src/*.js`.

## Develop

```bash
node scripts/build-client.mjs   # concatenate client fragments + syntax check
node scripts/check-all.mjs      # syntax check every host file
node --test test/               # unit tests (offline, no Flutter needed)
```

Read `docs/CONTRACTS.md` first: it is the authoritative interface contract for
every module, the HTTP route table, the tool table and the client boundaries.
