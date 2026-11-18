/**
 * The AI surface: one tool definition table shared by
 *   - the DSH tool registry (`registerTools`), so the agent in chat can call it, and
 *   - the MCP server (`mcpToolDescriptors`), so external agents can call it.
 *
 * Every tool is a thin adapter over the services built in index.js: no business
 * logic lives here, so the panel's buttons and the agent's tool calls can never
 * drift apart (docs/CONTRACTS.md §7 is this file's contract).
 */
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { clamp, normalizeError, truncate, uid } from './util.js'
import { resolveDataDir } from './store.js'

const text = (value) => [{ type: 'text', text: String(value) }]

/** Wrap a value in the JSON output schema every tool shares. */
const looseSchema = (properties = {}) => ({
  type: 'object',
  properties: { ok: { type: 'boolean' }, ...properties },
  additionalProperties: true,
})

function fail(code, message) {
  throw Object.assign(new Error(message), { code })
}

function requireService(service, label) {
  if (service === undefined || service === null) fail('unavailable', `${label} 服务不可用（插件子系统未启动）`)
  return service
}

function formatLogLine(entry) {
  const stamp = new Date(entry.at).toISOString().slice(11, 23)
  const level = String(entry.level ?? 'info').toUpperCase().padEnd(5)
  return `${stamp} ${level} [${entry.source}] ${entry.text}`
}

function formatNetLine(entry) {
  const status = entry.status === null || entry.status === undefined ? '---' : String(entry.status)
  const duration = entry.durationMs === null || entry.durationMs === undefined ? '?' : `${Math.round(entry.durationMs)}ms`
  const error = entry.error ? `  ⚠ ${entry.error}` : ''
  return `${status} ${String(entry.method ?? 'GET').padEnd(6)} ${duration.padStart(7)}  ${entry.uri}${error}`
}

function formatErrorGroups(groups) {
  if (groups.length === 0) return '没有捕获到异常'
  const blocks = groups.map((group) => {
    const frames = (group.frames ?? []).slice(0, 5).map((frame) => `    at ${frame.file}:${frame.line ?? '?'}`).join('\n')
    return [
      `[${group.fp}] ×${group.count} (${group.kind})`,
      `  ${group.message}`,
      frames,
    ].filter((line) => line !== '').join('\n')
  })
  return blocks.join('\n\n')
}

/** Resolve the project a call refers to: explicit id, else the active one. */
function pickProject(projects, projectId) {
  const service = requireService(projects, 'projects')
  if (projectId !== undefined && projectId !== null && String(projectId) !== '') {
    const project = service.get(String(projectId))
    if (project === null || project === undefined) fail('not-found', `未知项目 ${projectId}`)
    return project
  }
  const active = service.active()
  if (active === null || active === undefined) fail('no-project', '还没有添加任何 Flutter 项目：请先调用 flutter_projects(action=add, path=...)')
  return active
}

export function createToolDefinitions({ services, logger } = {}) {
  const { projects, runner, vm, network, errors, board, toolchain, logs, settings, store } = services ?? {}
  const definitions = []

  /** Mark a tool as belonging to a service that may be unbuilt. */
  function add(definition) {
    definitions.push(definition)
  }

  /* ---------------------------------------------------------------- status */

  add({
    name: 'flutter_status',
    description:
      '查看 Flutter 工作台当前状态：活动项目、运行阶段、设备、VM Service 地址、DevTools 链接、日志/异常/网络计数和看板统计。排查问题前先调用它。',
    parameters: {
      type: 'object',
      properties: { projectId: { type: 'string', description: '项目 id，省略则用当前活动项目' } },
      additionalProperties: false,
    },
    output: {
      schema: looseSchema({
        project: { type: ['object', 'null'] },
        run: { type: ['object', 'null'] },
        counters: { type: 'object' },
        board: { type: 'object' },
      }),
      render: (args, value) => {
        if (value?.project === null || value?.project === undefined) return text('还没有项目。用 flutter_projects(action=add, path=…) 添加。')
        const lines = [`项目：${value.project.name} (${value.project.path})`]
        if (value.run === null || value.run === undefined) {
          lines.push('运行：未启动（flutter_run 可启动）')
        } else {
          lines.push(`运行：${value.run.phase} · 设备 ${value.run.device?.name ?? '?'} · pid ${value.run.pid ?? '?'}`)
          if (value.run.vmServiceUri) lines.push(`VM Service：${value.run.vmServiceUri}`)
          if (value.run.devtoolsUrl) lines.push(`DevTools：${value.run.devtoolsUrl}`)
          if (value.run.error) lines.push(`最近错误：${value.run.error}`)
        }
        const counters = value.counters ?? {}
        lines.push(`日志 ${counters.logs ?? 0} 条（error ${counters.errors ?? 0}）· 网络请求 ${counters.network ?? 0} 条 · 异常组 ${counters.errorGroups ?? 0}`)
        const board = value.board ?? {}
        lines.push(`看板：待办 ${board.backlog ?? 0} · 就绪 ${board.ready ?? 0} · 执行中 ${board.running ?? 0} · 待验收 ${board.review ?? 0} · 完成 ${board.done ?? 0}`)
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      const project = projects?.active?.() ?? null
      const run = runner?.latestRun?.() ?? null
      const counts = logs?.counts?.() ?? { byLevel: {}, total: 0 }
      const net = network?.query?.({ limit: 1 }) ?? { total: 0 }
      const errs = errors?.query?.({ limit: 1 }) ?? { total: 0 }
      const snapshot = board?.snapshot?.() ?? { counts: {} }
      return {
        ok: true,
        project,
        run,
        counters: {
          logs: counts.total ?? 0,
          errors: (counts.byLevel?.error ?? 0) + (counts.byLevel?.fatal ?? 0),
          network: net.total ?? 0,
          errorGroups: errs.total ?? 0,
        },
        board: snapshot.counts ?? {},
      }
    },
  })

  /* -------------------------------------------------------------- projects */

  add({
    name: 'flutter_projects',
    description: '列出/添加/移除/选择 Flutter 项目。添加时会读取 pubspec.yaml 与平台目录。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'remove', 'select', 'refresh'], description: '操作' },
        path: { type: 'string', description: 'add 时必填：项目绝对路径' },
        id: { type: 'string', description: 'remove/select/refresh 时的项目 id' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: looseSchema({ projects: { type: 'array', items: { type: 'object' } }, activeProjectId: { type: ['string', 'null'] } }),
      render: (args, value) => {
        const list = value?.projects ?? []
        if (list.length === 0) return text('还没有项目')
        return text(list.map((p) => `${p.id === value.activeProjectId ? '●' : '○'} ${p.name} — ${p.path}${p.detected?.ok === false ? ` (⚠ ${p.detected.error})` : ''}`).join('\n'))
      },
    },
    async execute(args) {
      const service = requireService(projects, 'projects')
      const action = String(args?.action ?? 'list')
      if (action === 'add') {
        const project = await service.add({ path: String(args?.path ?? '') })
        return { ok: true, projects: service.list(), activeProjectId: service.activeId(), project }
      }
      if (action === 'remove') {
        await service.remove(String(args?.id ?? ''))
        return { ok: true, projects: service.list(), activeProjectId: service.activeId() }
      }
      if (action === 'select') {
        await service.select(String(args?.id ?? ''))
        return { ok: true, projects: service.list(), activeProjectId: service.activeId() }
      }
      if (action === 'refresh') {
        await service.refresh(String(args?.id ?? ''))
        return { ok: true, projects: service.list(), activeProjectId: service.activeId() }
      }
      return { ok: true, projects: service.list(), activeProjectId: service.activeId() }
    },
  })

  /* --------------------------------------------------------------- devices */

  add({
    name: 'flutter_devices',
    description: '列出可用的 Flutter 设备与模拟器。',
    parameters: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['devices', 'emulators'], description: '默认 devices' } },
      additionalProperties: false,
    },
    output: {
      schema: looseSchema({ devices: { type: 'array', items: { type: 'object' } } }),
      render: (args, value) => text((value?.devices ?? []).map((d) => `${d.id} · ${d.name} · ${d.platform}${d.emulator ? ' (模拟器)' : ''}`).join('\n') || '没有可用设备'),
    },
    async execute(args) {
      const tool = requireService(toolchain, 'toolchain')
      const kind = String(args?.kind ?? 'devices')
      const devices = kind === 'emulators' ? await tool.emulators() : await tool.devices()
      return { ok: true, devices }
    },
  })

  add({
    name: 'flutter_configs',
    description: '列出项目的运行配置：VS Code launch.json 配置、lib/main*.dart 入口、可用设备与 flavor。',
    parameters: {
      type: 'object',
      properties: { projectId: { type: 'string', description: '项目 id，省略用当前项目' } },
      additionalProperties: false,
    },
    output: {
      schema: looseSchema({ configs: { type: 'array', items: { type: 'object' } } }),
      render: (args, value) => {
        const lines = []
        for (const config of value?.configs ?? []) {
          lines.push(`[${config.source}] ${config.label} → ${config.program}${config.flavor ? ` · flavor ${config.flavor}` : ''} · ${config.mode}`)
        }
        if ((value?.warnings ?? []).length > 0) lines.push(`⚠ ${value.warnings.join('; ')}`)
        return text(lines.join('\n') || '没有发现运行配置')
      },
    },
    async execute(args) {
      const { discoverConfigs } = await import('./runconfig.js')
      const project = pickProject(projects, args?.projectId)
      const result = await discoverConfigs({ projectPath: project.path, flutterPath: settings?.get?.().flutterPath ?? '' })
      return { ok: true, ...result }
    },
  })

  /* ----------------------------------------------------------- run control */

  add({
    name: 'flutter_run',
    description: '启动 Flutter 项目（flutter run --machine），返回 runId 与运行状态。启动后可用 flutter_logs 读日志、flutter_network 读请求。',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '项目 id，省略用当前项目' },
        configId: { type: 'string', description: '运行配置 id（来自 flutter_configs）' },
        program: { type: 'string', description: '入口文件，如 lib/main.dart' },
        deviceId: { type: 'string', description: '设备 id，如 windows / edge / chrome' },
        mode: { type: 'string', enum: ['debug', 'profile', 'release'], description: '默认 debug' },
        flavor: { type: 'string', description: 'Flutter flavor' },
        dartDefines: { type: 'object', additionalProperties: { type: 'string' }, description: '--dart-define 键值' },
        args: { type: 'array', items: { type: 'string' }, description: '追加给 flutter run 的参数' },
      },
      additionalProperties: false,
    },
    output: {
      schema: looseSchema({ runId: { type: 'string' }, run: { type: 'object' } }),
      render: (args, value) => text(`已启动 ${value?.runId} · ${value?.run?.phase ?? '?'}${value?.run?.vmServiceUri ? ` · VM ${value.run.vmServiceUri}` : ''}`),
    },
    async execute(args) {
      const service = requireService(runner, 'runner')
      const project = pickProject(projects, args?.projectId)
      const config = {
        id: String(args?.configId ?? 'manual'),
        label: String(args?.configId ?? 'manual run'),
        program: String(args?.program ?? 'lib/main.dart'),
        deviceId: String(args?.deviceId ?? ''),
        mode: ['debug', 'profile', 'release'].includes(String(args?.mode)) ? String(args.mode) : 'debug',
        flavor: args?.flavor === undefined || args.flavor === null || String(args.flavor) === '' ? null : String(args.flavor),
        dartDefines: args?.dartDefines ?? {},
        args: Array.isArray(args?.args) ? args.args.map(String) : [],
        env: {},
        source: 'manual',
      }
      await projects?.touch?.(project.id)
      const started = await service.start({ projectPath: project.path, projectId: project.id, config })
      const state = service.state({ runId: started.runId })
      return { ok: true, runId: started.runId, run: state.runs?.find((item) => item.runId === started.runId) ?? null }
    },
  })

  add({
    name: 'flutter_stop',
    description: '停止 Flutter 运行（默认停止当前活动运行）。',
    parameters: { type: 'object', properties: { runId: { type: 'string' } }, additionalProperties: false },
    output: { schema: looseSchema({ stopped: { type: 'array', items: { type: 'string' } } }), render: (args, value) => text(`已停止：${(value?.stopped ?? []).join(', ') || '无'}`) },
    async execute(args) {
      const service = requireService(runner, 'runner')
      return { ok: true, ...(await service.stop({ runId: args?.runId })) }
    },
  })

  add({
    name: 'flutter_reload',
    description: '对运行中的 Flutter 应用执行热重载（hot reload）。',
    parameters: { type: 'object', properties: { runId: { type: 'string' } }, additionalProperties: false },
    output: { schema: looseSchema({ message: { type: 'string' } }), render: (args, value) => text(value?.message ?? (value?.ok === true ? '热重载完成' : '热重载失败')) },
    async execute(args) {
      const service = requireService(runner, 'runner')
      const result = await service.hotReload({ runId: args?.runId })
      return { ok: result.ok !== false, ...result }
    },
  })

  add({
    name: 'flutter_restart',
    description: '对运行中的 Flutter 应用执行热重启（hot restart，会重置应用状态）。',
    parameters: { type: 'object', properties: { runId: { type: 'string' } }, additionalProperties: false },
    output: { schema: looseSchema({ message: { type: 'string' } }), render: (args, value) => text(value?.message ?? (value?.ok === true ? '热重启完成' : '热重启失败')) },
    async execute(args) {
      const service = requireService(runner, 'runner')
      const result = await service.hotRestart({ runId: args?.runId })
      return { ok: result.ok !== false, ...result }
    },
  })

  /* ------------------------------------------------------------- log layer */

  add({
    name: 'flutter_logs',
    description:
      '读取 Flutter 运行日志（内存环形缓冲）。支持游标增量、级别、来源、正则过滤。来源：flutter/stdout/stderr/daemon/vm/network/toolchain/plugin/ai。先用 flutter_log_mark 打点，再按 since 取这段日志，可精确定位一次操作产生的输出。',
    parameters: {
      type: 'object',
      properties: {
        since: { type: 'number', description: '游标：上次返回的 nextCursor，省略取最近日志' },
        limit: { type: 'number', description: '条数，默认 200，最大 2000' },
        level: { type: 'string', enum: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'], description: '最低级别' },
        source: { type: 'string', description: '单一来源过滤' },
        pattern: { type: 'string', description: '正则/文本过滤' },
        runId: { type: 'string', description: '只看某次运行' },
        minutes: { type: 'number', description: '只看最近 N 分钟' },
      },
      additionalProperties: false,
    },
    output: {
      schema: looseSchema({ entries: { type: 'array', items: { type: 'object' } }, nextCursor: { type: 'number' } }),
      render: (args, value) => {
        const entries = value?.entries ?? []
        if (entries.length === 0) return text(`没有匹配的日志（nextCursor=${value?.nextCursor ?? 0}）`)
        const head = `共 ${entries.length} 条 · nextCursor=${value?.nextCursor ?? 0}\n`
        return text(head + entries.map(formatLogLine).join('\n'))
      },
    },
    async execute(args) {
      const service = requireService(logs, 'logs')
      const since = args?.minutes !== undefined
        ? Math.max(0, (service.cursor?.() ?? 0) - 0)
        : args?.since
      const query = {
        since: since === undefined ? undefined : Number(since),
        limit: clamp(args?.limit ?? 200, 1, 2000),
        level: args?.level,
        source: args?.source,
        pattern: args?.pattern,
        runId: args?.runId,
      }
      if (args?.minutes !== undefined) {
        query.since = 0
        const cutoff = Date.now() - clamp(args.minutes, 1, 1440) * 60000
        const result = service.query({ ...query, limit: query.limit })
        const filtered = result.entries.filter((entry) => entry.at >= cutoff)
        return { ok: true, entries: filtered, nextCursor: result.nextCursor, total: filtered.length }
      }
      const result = service.query(query)
      return { ok: true, ...result }
    },
  })

  add({
    name: 'flutter_log_mark',
    description: '在日志流里插入一条标记。配合 flutter_logs(since=…) 可以精确截取"从这条标记开始"的日志。',
    parameters: { type: 'object', properties: { text: { type: 'string', description: '标记文本' } }, required: ['text'], additionalProperties: false },
    output: { schema: looseSchema({ seq: { type: 'number' } }), render: (args, value) => text(`已打点 #${value?.seq ?? '?'}：${args?.text ?? ''}`) },
    async execute(args) {
      const service = requireService(logs, 'logs')
      const entry = service.mark(String(args?.text ?? ''))
      return { ok: true, seq: entry.seq }
    },
  })

  add({
    name: 'flutter_errors',
    description: '读取去重后的异常组：次数、首次/最后时间、消息、堆栈帧（可直接跳到 file:line）。比翻日志更快定位"哪里挂了"。',
    parameters: {
      type: 'object',
      properties: {
        since: { type: 'number' },
        limit: { type: 'number', description: '默认 20' },
        kind: { type: 'string', enum: ['flutter', 'dart', 'platform', 'test', 'analyze'] },
        pattern: { type: 'string' },
        runId: { type: 'string' },
      },
      additionalProperties: false,
    },
    output: {
      schema: looseSchema({ groups: { type: 'array', items: { type: 'object' } } }),
      render: (args, value) => text(formatErrorGroups(value?.groups ?? [])),
    },
    async execute(args) {
      const service = requireService(errors, 'errors')
      const result = service.query({
        since: args?.since === undefined ? undefined : Number(args.since),
        limit: clamp(args?.limit ?? 20, 1, 200),
        kind: args?.kind,
        pattern: args?.pattern,
        runId: args?.runId,
      })
      return { ok: true, ...result }
    },
  })

  /* --------------------------------------------------------- network layer */

  add({
    name: 'flutter_network',
    description:
      '读取 Flutter 应用的 HTTP 请求记录（来自 Dart VM Service 的 HTTP profile）：方法、URI、状态码、耗时、错误。排查接口 401/500/超时、看请求顺序和耗时时用。',
    parameters: {
      type: 'object',
      properties: {
        since: { type: 'number', description: '游标（上次的 nextCursor）' },
        limit: { type: 'number', description: '默认 100' },
        status: { type: 'string', description: '状态码过滤：200 / 4xx / 5xx / error' },
        pattern: { type: 'string', description: 'URI 正则' },
        errorsOnly: { type: 'boolean', description: '只看失败请求' },
      },
      additionalProperties: false,
    },
    output: {
      schema: looseSchema({ entries: { type: 'array', items: { type: 'object' } }, nextCursor: { type: 'number' } }),
      render: (args, value) => {
        const entries = value?.entries ?? []
        if (entries.length === 0) return text('没有网络请求记录（应用还没发请求，或未连接到 VM Service）')
        return text(`共 ${entries.length} 条 · nextCursor=${value?.nextCursor ?? 0}\n${entries.map(formatNetLine).join('\n')}`)
      },
    },
    async execute(args) {
      const service = requireService(network, 'network')
      await service.refresh?.({}).catch(() => {})
      const result = service.query({
        since: args?.since === undefined ? undefined : Number(args.since),
        limit: clamp(args?.limit ?? 100, 1, 500),
        status: args?.status,
        pattern: args?.pattern,
        errorsOnly: args?.errorsOnly === true,
      })
      return { ok: true, ...result }
    },
  })

  add({
    name: 'flutter_network_detail',
    description: '查看单条 HTTP 请求的完整请求/响应头与 body（过长会标注截断）。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'flutter_network 返回的请求 id' }, runId: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    output: { schema: looseSchema({ request: { type: 'object' } }), render: (args, value) => text(truncate(JSON.stringify(value?.request ?? {}, null, 2), 4000)) },
    async execute(args) {
      const service = requireService(network, 'network')
      const request = await service.detail({ id: String(args?.id ?? ''), runId: args?.runId })
      return { ok: true, request }
    },
  })

  /* -------------------------------------------------------- quality layer */

  add({
    name: 'flutter_analyze',
    description: '运行 dart analyze（machine 格式）并返回结构化问题列表：severity/file:line/column/code/message。改完代码先跑它。',
    parameters: { type: 'object', properties: { projectId: { type: 'string' } }, additionalProperties: false },
    output: {
      schema: looseSchema({ issues: { type: 'array', items: { type: 'object' } }, counts: { type: 'object' } }),
      render: (args, value) => {
        const counts = value?.counts ?? {}
        const issues = value?.issues ?? []
        const head = `错误 ${counts.error ?? 0} · 警告 ${counts.warning ?? 0} · 提示 ${counts.info ?? 0}`
        if (issues.length === 0) return text(`${head}\n没有发现问题`)
        const body = issues.slice(0, 60).map((issue) => `${issue.severity} ${issue.file}:${issue.line}:${issue.column} [${issue.code}] ${issue.message}`).join('\n')
        return text(`${head}\n${body}`)
      },
    },
    async execute(args) {
      const tool = requireService(toolchain, 'toolchain')
      const project = pickProject(projects, args?.projectId)
      const result = await tool.analyze({ projectPath: project.path })
      return { ok: true, ...result }
    },
  })

  add({
    name: 'flutter_test',
    description: '运行 flutter test（JSON reporter）并返回通过/失败/跳过统计、失败用例名与错误。',
    parameters: {
      type: 'object',
      properties: { projectId: { type: 'string' }, target: { type: 'string', description: '指定测试文件或目录' }, name: { type: 'string', description: '按用例名过滤' } },
      additionalProperties: false,
    },
    output: {
      schema: looseSchema({ passed: { type: 'number' }, failed: { type: 'number' }, tests: { type: 'array', items: { type: 'object' } } }),
      render: (args, value) => {
        const failed = value?.failed ?? 0
        const passed = value?.passed ?? 0
        const lines = [`通过 ${passed} · 失败 ${failed} · 跳过 ${value?.skipped ?? 0} · ${Math.round((value?.durationMs ?? 0) / 100) / 10}s`]
        for (const test of value?.tests ?? []) {
          if (test.status === 'failed') lines.push(`✗ ${test.name}${test.group ? ` (${test.group})` : ''}\n   ${truncate(test.error ?? '', 400)}`)
        }
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      const tool = requireService(toolchain, 'toolchain')
      const project = pickProject(projects, args?.projectId)
      const result = await tool.test({ projectPath: project.path, target: args?.target, name: args?.name })
      return { ok: true, ...result }
    },
  })

  add({
    name: 'flutter_toolchain',
    description: '运行其它 Flutter 工具命令：pubGet / clean / build / doctor / format。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['pubGet', 'clean', 'build', 'doctor', 'format'] },
        projectId: { type: 'string' },
        target: { type: 'string', description: 'build 目标：apk/appbundle/ios/web/windows/macos/linux' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: looseSchema({ output: { type: 'string' } }), render: (args, value) => text(truncate(value?.output ?? (value?.ok === true ? `${args?.action} 完成` : `${args?.action} 失败`), 4000)) },
    async execute(args) {
      const tool = requireService(toolchain, 'toolchain')
      const project = pickProject(projects, args?.projectId)
      const action = String(args?.action ?? '')
      if (action === 'pubGet') return { ok: true, ...(await tool.pubGet({ projectPath: project.path })) }
      if (action === 'clean') return { ok: true, ...(await tool.clean({ projectPath: project.path })) }
      if (action === 'build') return { ok: true, ...(await tool.build({ projectPath: project.path, target: String(args?.target ?? 'apk') })) }
      if (action === 'doctor') return { ok: true, ...(await tool.doctor({})) }
      if (action === 'format') return { ok: true, ...(await tool.format({ projectPath: project.path })) }
      fail('bad-request', `未知 action ${action}`)
      return { ok: false }
    },
  })

  /* ---------------------------------------------------------- UI snapshot */

  add({
    name: 'flutter_screenshot',
    description: '截取运行中应用的界面（VM Service 截图），保存为 PNG 并返回绝对路径。用 read_image 打开它就能看到界面长什么样。',
    parameters: { type: 'object', properties: { runId: { type: 'string' } }, additionalProperties: false },
    output: { schema: looseSchema({ path: { type: 'string' }, bytes: { type: 'number' } }), render: (args, value) => text(`截图已保存：${value?.path ?? '?'}（${value?.bytes ?? 0} bytes）用 read_image 查看。`) },
    async execute(args) {
      const service = requireService(vm, 'vm')
      const shot = await service.screenshot({ runId: args?.runId })
      if (typeof shot?.base64 !== 'string' || shot.base64 === '') fail('screenshot-empty', '截图返回为空')
      const dir = join(resolveDataDir(settings?.get?.().dataDir ?? ''), 'screenshots')
      await mkdir(dir, { recursive: true })
      const file = join(dir, `${uid('shot')}.png`)
      const buffer = Buffer.from(shot.base64, 'base64')
      await writeFile(file, buffer)
      return { ok: true, path: file, bytes: buffer.length }
    },
  })

  add({
    name: 'flutter_widget_tree',
    description: '导出当前应用的 Widget 树（debugDumpApp），用于确认某个 widget 是否真的在树上。',
    parameters: {
      type: 'object',
      properties: { runId: { type: 'string' }, isolateId: { type: 'string' }, maxChars: { type: 'number', description: '默认 8000' } },
      additionalProperties: false,
    },
    output: { schema: looseSchema({ tree: { type: 'string' } }), render: (args, value) => {
      const tree = typeof value?.tree === 'string' ? value.tree : ''
      if (tree === '') return text('没有拿到 Widget 树：应用未运行，或 debugDumpApp 在该平台不可用。')
      return text(truncate(tree, clamp(args?.maxChars ?? 8000, 500, 60000)))
    } },
    async execute(args) {
      const service = requireService(vm, 'vm')
      const tree = await service.dumpApp({ runId: args?.runId, isolateId: args?.isolateId })
      return { ok: true, tree }
    },
  })

  add({
    name: 'flutter_perf',
    description: '读取帧耗时统计：总帧数、掉帧数、最差帧的 build/raster 耗时。卡顿时用它判断是构建还是光栅化慢。',
    parameters: { type: 'object', properties: { runId: { type: 'string' } }, additionalProperties: false },
    output: { schema: looseSchema({ jankCount: { type: 'number' }, worstMs: { type: 'number' } }), render: (args, value) => text(`帧数 ${(value?.frames ?? []).length} · 掉帧 ${value?.jankCount ?? 0} · 最差 ${value?.worstMs ?? 0}ms`) },
    async execute(args) {
      const service = requireService(vm, 'vm')
      return { ok: true, ...(await service.frameStats({ runId: args?.runId })) }
    },
  })

  add({
    name: 'flutter_open',
    description: '在编辑器里打开文件（可定位到行），用于把日志/堆栈里的位置直接抛给用户看。',
    parameters: {
      type: 'object',
      properties: { file: { type: 'string', description: '绝对路径或相对项目路径' }, line: { type: 'number' } },
      required: ['file'],
      additionalProperties: false,
    },
    output: { schema: looseSchema({ opened: { type: 'boolean' } }), render: (args, value) => text(value?.opened === true ? `已打开 ${args?.file}:${args?.line ?? 1}` : '打开失败') },
    async execute(args) {
      const raw = String(args?.file ?? '')
      if (raw === '') fail('bad-request', 'file 必填')
      const project = projects?.active?.()
      const settingsValue = settings?.get?.() ?? {}
      const editor = String(settingsValue.editorCommand ?? 'code').trim() || 'code'
      const target = raw.startsWith('/') || /^[A-Za-z]:/.test(raw) ? raw : join(project?.path ?? '.', raw)
      const location = args?.line === undefined ? target : `${target}:${Number(args.line)}`
      await new Promise((resolve, reject) => {
        execFile(editor, ['-g', location], { windowsHide: true, timeout: 15000 }, (error) => {
          if (error === null) resolve()
          else reject(Object.assign(new Error(`无法启动编辑器 ${editor}：${error.message}`), { code: 'editor-failed' }))
        })
      })
      return { ok: true, opened: true, path: target, line: args?.line ?? null }
    },
  })

  /* ---------------------------------------------------------------- board */

  add({
    name: 'flutter_tasks',
    description:
      '看板任务：list 列表 / create 新建 / update 修改 / move 移动泳道 / delete 删除 / archive 归档已完成。泳道：backlog(待办) ready(就绪) running(执行中) review(待验收) verify(验证中) done(完成)。卡片带验收标准 acceptance 和验证命令 verify。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'move', 'delete', 'archive'] },
        id: { type: 'string', description: 'create 之外必填' },
        title: { type: 'string' },
        detail: { type: 'string' },
        lane: { type: 'string', enum: ['backlog', 'ready', 'running', 'review', 'verify', 'done'] },
        index: { type: 'number', description: 'move 时的目标位置' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        tags: { type: 'array', items: { type: 'string' } },
        acceptance: { type: 'array', items: { type: 'string' }, description: '验收标准（一条一句）' },
        verify: { type: 'array', items: { type: 'string' }, description: '可执行的验证命令' },
        files: { type: 'array', items: { type: 'string' } },
        deps: { type: 'array', items: { type: 'string' } },
        projectId: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: looseSchema({ task: { type: 'object' }, board: { type: 'object' } }),
      render: (args, value) => {
        if (Array.isArray(value?.tasks)) {
          const lanes = value.tasks
          if (lanes.length === 0) return text('看板是空的：用 action=create 建卡，或 flutter_task_decompose 让 AI 拆任务。')
          return text(lanes.map((task) => `[${task.lane}] ${task.title}${task.blocked ? ' (阻塞)' : ''}${task.result?.verdict === 'pass' ? ' ✓' : ''}`).join('\n'))
        }
        const task = value?.task
        if (task === undefined || task === null) return text('没有变化')
        return text(`[${task.lane}] ${task.title} · ${task.id}${task.acceptance?.length ? `\n验收：${task.acceptance.join(' | ')}` : ''}`)
      },
    },
    async execute(args) {
      const service = requireService(board, 'board')
      const action = String(args?.action ?? 'list')
      if (action === 'list') return { ok: true, tasks: service.snapshot().tasks, board: service.snapshot() }
      if (action === 'create') {
        const task = await service.addTask({
          title: String(args?.title ?? ''),
          detail: String(args?.detail ?? ''),
          lane: args?.lane,
          priority: args?.priority,
          tags: args?.tags,
          acceptance: args?.acceptance,
          verify: args?.verify,
          files: args?.files,
          deps: args?.deps,
          projectId: args?.projectId ?? projects?.activeId?.() ?? null,
        })
        return { ok: true, task, board: service.snapshot() }
      }
      if (action === 'update') return { ok: true, task: await service.updateTask({ id: String(args?.id ?? ''), patch: buildTaskPatch(args) }) }
      if (action === 'move') return { ok: true, task: await service.moveTask({ id: String(args?.id ?? ''), lane: String(args?.lane ?? ''), index: args?.index }) }
      if (action === 'delete') return { ok: true, ...(await service.removeTask({ id: String(args?.id ?? '') })) }
      if (action === 'archive') return { ok: true, ...(await service.archiveDone()) }
      fail('bad-request', `未知 action ${action}`)
      return { ok: false }
    },
  })

  add({
    name: 'flutter_task_decompose',
    description: '把一个想法/需求交给 AI 拆成多张看板卡：给出标题、详情、验收标准、验证命令、依赖，进入待办泳道。适合"我想加一个 XX 功能"这种输入。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '需求或想法，写得越具体拆得越准' },
        projectId: { type: 'string' },
        maxTasks: { type: 'number', description: '最多拆几张，默认 6' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: {
      schema: looseSchema({ tasks: { type: 'array', items: { type: 'object' } } }),
      render: (args, value) => {
        const tasks = value?.tasks ?? []
        if (tasks.length === 0) return text(`没有拆出任务${value?.error ? `：${value.error}` : ''}`)
        return text(tasks.map((task, index) => `${index + 1}. ${task.title}\n   ${task.detail ?? ''}\n   验收：${(task.acceptance ?? []).join(' | ')}`).join('\n'))
      },
    },
    async execute(args) {
      const service = requireService(board, 'board')
      const project = args?.projectId ? projects?.get?.(String(args.projectId)) : projects?.active?.()
      const result = await service.decompose({
        prompt: String(args?.prompt ?? ''),
        projectId: project?.id ?? null,
        maxTasks: clamp(args?.maxTasks ?? 6, 1, 20),
        provider: settings?.get?.().defaultProvider || undefined,
        model: settings?.get?.().defaultModel || undefined,
      })
      return { ok: (result.tasks ?? []).length > 0, ...result }
    },
  })

  add({
    name: 'flutter_task_dispatch',
    description: '把一张看板卡派给一个 AI 会话去做：会话会拿到卡片的验收标准和验证命令，做完后回报结果。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    output: { schema: looseSchema({ sessionId: { type: 'string' } }), render: (args, value) => text(`已派发：会话 ${value?.sessionId ?? '?'}`) },
    async execute(args) {
      const service = requireService(board, 'board')
      const result = await service.dispatch({
        id: String(args?.id ?? ''),
        provider: args?.provider,
        model: args?.model ?? settings?.get?.().defaultModel,
      })
      return { ok: true, ...result }
    },
  })

  add({
    name: 'flutter_task_report',
    description: '（供被派发的执行者调用）把工作结果回报给看板卡：状态、摘要、跑过的命令、证据、是否通过。通过则卡片进入待验收。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: ['working', 'blocked', 'done', 'failed'] },
        summary: { type: 'string' },
        commandsRun: {
          type: 'array',
          items: {
            type: 'object',
            properties: { command: { type: 'string' }, status: { type: 'string' }, exitCode: { type: 'number' } },
            additionalProperties: true,
          },
        },
        evidence: { type: 'array', items: { type: 'string' } },
        files: { type: 'array', items: { type: 'string' } },
        verdict: { type: 'string', enum: ['pass', 'fail'] },
        note: { type: 'string' },
      },
      required: ['id', 'status'],
      additionalProperties: false,
    },
    output: { schema: looseSchema({ task: { type: 'object' } }), render: (args, value) => text(`卡片已更新：${value?.task?.lane ?? '?'} · ${value?.task?.result?.verdict ?? '未判定'}`) },
    async execute(args) {
      const service = requireService(board, 'board')
      const task = await service.report({
        id: String(args?.id ?? ''),
        status: String(args?.status ?? 'working'),
        summary: String(args?.summary ?? ''),
        commandsRun: args?.commandsRun,
        evidence: args?.evidence,
        files: args?.files,
        verdict: args?.verdict,
        note: args?.note,
      })
      return { ok: true, task }
    },
  })

  return definitions
}

function buildTaskPatch(args) {
  const patch = {}
  for (const key of ['title', 'detail', 'lane', 'priority', 'tags', 'acceptance', 'verify', 'files', 'deps', 'projectId']) {
    if (args?.[key] !== undefined) patch[key] = args[key]
  }
  return patch
}

/** MCP `tools/list` payload derived from the same definitions. */
export function mcpToolDescriptors(definitions) {
  return (definitions ?? []).map((definition) => ({
    name: definition.name,
    description: definition.description,
    inputSchema: definition.parameters ?? { type: 'object', additionalProperties: true },
  }))
}

/**
 * Register every tool with the Host tool registry.
 * Returns a disposer; a missing `tools` service degrades to a no-op.
 */
export function registerTools({ ctx, services, logger }) {
  const tools = ctx?.get?.('tools')
  if (tools === undefined || typeof tools.register !== 'function') {
    logger?.warn?.('tools: registry unavailable; the agent will only reach the workbench through MCP')
    return () => {}
  }
  let definitions
  try {
    definitions = createToolDefinitions({ services, logger })
  } catch (error) {
    logger?.warn?.(`tools: definition build failed: ${normalizeError(error).message}`)
    return () => {}
  }
  const disposers = []
  for (const definition of definitions) {
    try {
      disposers.push(tools.register(definition))
    } catch (error) {
      logger?.warn?.(`tools: cannot register ${definition.name}: ${normalizeError(error).message}`)
    }
  }
  return () => {
    for (const dispose of disposers) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        /* registry already gone */
      }
    }
  }
}