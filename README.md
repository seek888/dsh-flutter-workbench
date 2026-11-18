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
> Not implemented yet (files are labelled `STUB`):
> `host/runconfig.js`, `host/runner.js`, `host/analyze.js`, `host/ws.js`,
> `host/vmservice.js`, `host/network.js`, `host/errors.js`, `host/board.js`,
> `host/httpapi.js`, `host/mcp.js`, and the client pages `00/10/20/30/40/50/60`.
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
