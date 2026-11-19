/**
 * dsh-flutter-workbench — Host half.
 *
 * One `ctx.effect` owns the whole lifecycle: settings → store → logs → bus →
 * runner → VM service → network/errors → board → toolchain → HTTP route →
 * agent tools. Every subsystem is built defensively so one failing module never
 * disables the panel; the panel's `/health` reports which ones came up.
 */
import { createBoard } from './host/board.js'
import { createErrorStore } from './host/errors.js'
import { createHttpApi } from './host/httpapi.js'
import { createLogStore } from './host/logs.js'
import { createMcpServer } from './host/mcp.js'
import { createNetworkStore } from './host/network.js'
import { createProjects } from './host/projects.js'
import { createRunner } from './host/runner.js'
import { createSettings } from './host/settings.js'
import { createStore } from './host/store.js'
import { createToolchain } from './host/analyze.js'
import { createTaskboard } from './host/taskboard.js'
import { registerTools } from './host/tools.js'
import { createVmService } from './host/vmservice.js'
import { createBus, createLogger, normalizeError, nowMs } from './host/util.js'

export const name = 'dsh-flutter-workbench'
/** The HTTP carrier is the only hard dependency; everything else is optional. */
export const inject = ['webServer']
export const VERSION = '0.1.0'

/**
 * Plugin body.
 * @param {any} ctx Cordis plugin context.
 * @param {unknown} config the row config.
 */
export function apply(ctx, config) {
  const bootedAt = nowMs()
  const warnings = []
  const logger = createLogger('flutter-workbench', (line) => {
    if (process.env.DSH_FLUTTER_WORKBENCH_DEBUG === '1') process.stderr.write(`${line}\n`)
  })

  ctx.effect(async () => {
    const bus = createBus()
    const disposers = []

    /** Build one subsystem, recording the failure instead of throwing. */
    async function build(label, factory, fallback = null, required = false) {
      try {
        const value = await factory()
        return value ?? fallback
      } catch (error) {
        const { message, code } = normalizeError(error)
        warnings.push({ subsystem: label, message, code })
        logger.warn(`${label} unavailable: ${message}`)
        if (required) throw error
        return fallback
      }
    }

    const store = await build('store', () => createStore({ dir: undefined, name: 'workbench', logger }), null, true)
    const settings = await build('settings', () => createSettings({ config, store, logger }))
    const resolved = settings?.get?.() ?? {}
    const logs = createLogStore({ capacity: resolved.logCapacity })

    // Every log line the panel shows also travels on the bus so tool modules can
    // react without polling the buffer.
    bus.on('log', (entry) => {
      if (entry !== undefined && entry !== null) logs.append(entry)
    })

    const projects = await build('projects', () => createProjects({ store, logger }))

    const runner = await build('runner', () =>
      createRunner({ logs, bus, settings, logger, projects }),
    )
    const vm = await build('vmservice', () => createVmService({ logs, bus, logger }))
    const network = await build('network', () => createNetworkStore({ vm, logs, bus, settings, logger }))
    const errors = await build('errors', () => createErrorStore({ logs, bus, logger }))
    const board = await build('board', () => createBoard({ store, bus, ctx, logs, settings, logger }))
    const toolchain = await build('toolchain', () => createToolchain({ settings, logs, bus, logger }))
    // The task board: a port of dsh-taskboard's ledger, so this one plugin owns
    // both the Flutter toolchain and the agent task board.
    const taskboard = await build('taskboard', () => createTaskboard({ store, bus, ctx, logs, settings, logger }))

    const services = {
      ctx,
      bus,
      logger,
      store,
      settings,
      logs,
      projects,
      runner,
      vm,
      network,
      errors,
      board,
      toolchain,
      taskboard,
      version: VERSION,
      bootedAt,
      warnings,
    }

    // A live run hands its VM service URI to the observability modules.
    disposers.push(
      bus.on('run:vm-service', (payload) => {
        if (payload?.vmServiceUri === undefined || payload.vmServiceUri === null) return
        vm?.connect?.({ runId: payload.runId, wsUri: payload.vmServiceUri }).catch((error) => {
          logger.warn(`vm connect failed: ${normalizeError(error).message}`)
        })
      }),
    )
    disposers.push(
      bus.on('run:state', (state) => {
        if (state?.vmServiceUri === null || state?.vmServiceUri === undefined) {
          if (state?.phase === 'stopped' || state?.phase === 'failed' || state?.phase === 'exited') {
            vm?.disconnect?.({ runId: state.runId }).catch(() => {})
          }
        }
      }),
    )

    const mcp = await build('mcp', () => createMcpServer({ services, logger, version: VERSION }))
    const httpapi = await build('httpapi', () => createHttpApi({ ctx, services: { ...services, mcp }, logger }))

    if (httpapi !== null && typeof httpapi.attach === 'function') {
      const disposeRoute = httpapi.attach(ctx)
      if (typeof disposeRoute === 'function') disposers.push(disposeRoute)
    } else {
      warnings.push({ subsystem: 'http', message: 'HTTP route was not attached', code: 'no-route' })
    }

    const disposeTools = await build('tools', () => registerTools({ ctx, services }))
    if (typeof disposeTools === 'function') disposers.push(disposeTools)

    // Optional: surface live app health to the agent's prompt so it does not
    // have to call a tool to notice a crashed run. Never fatal.
    await build('prompt', () => {
      const systemPrompt = ctx.get('systemPrompt')
      if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') return null
      const dispose = systemPrompt.section({
        name: 'flutter-workbench',
        order: 60,
        text: () => {
          const run = runner?.latestRun?.() ?? null
          const counts = logs.counts()
          if (run === null) return ''
          const lines = [`Flutter workbench: ${run.phase} · ${run.projectPath}${run.device ? ` · ${run.device.name}` : ''}`]
          if (run.error !== null) lines.push(`last error: ${run.error}`)
          if (counts.byLevel.error + counts.byLevel.fatal > 0) lines.push(`error logs buffered: ${counts.byLevel.error + counts.byLevel.fatal} (tool: flutter_logs)`)
          return lines.join('\n')
        },
      })
      if (typeof dispose === 'function') disposers.push(dispose)
      return null
    })

    const ready = warnings.filter((item) => item.subsystem !== 'prompt')
    if (ready.length > 0) logger.warn(`degraded subsystems: ${ready.map((item) => item.subsystem).join(', ')}`)

    return async () => {
      for (const dispose of disposers.reverse()) {
        try {
          await dispose()
        } catch {
          /* teardown is best effort */
        }
      }
      await runner?.dispose?.().catch?.(() => {})
      await vm?.dispose?.().catch?.(() => {})
      try {
        await taskboard?.dispose?.()
      } catch {
        /* ledger flush is best effort */
      }
      await store?.flush?.().catch?.(() => {})
    }
  })
}