/**
 * Host-side scheduler for the task board.
 *
 * The timer lives in the Host process, so a scheduled task fires even with the
 * browser closed (that is the whole point of a cron card). Ticks are tolerant:
 * a slow execution never overlaps the next tick, a failed one is logged and
 * rescheduled instead of retried in a tight loop.
 */
import { normalizeError, nowMs } from './util.js'

const DEFAULT_INTERVAL_MS = 20000

/**
 * @param {{ taskboard: any, logs?: any, bus?: any, logger?: any,
 *           intervalMs?: number, execute?: (taskId: string) => Promise<any>,
 *           now?: () => number }} deps
 */
export function createScheduler({ taskboard, logs, bus, logger, intervalMs = DEFAULT_INTERVAL_MS, execute, now = nowMs } = {}) {
  const tickMs = Number.isFinite(Number(intervalMs)) ? Math.max(2000, Number(intervalMs)) : DEFAULT_INTERVAL_MS
  let timer = null
  let ticking = false
  const stats = { ticks: 0, fired: 0, failures: 0, lastTickAt: null, lastError: null }

  function note(level, text) {
    try {
      logs?.append?.({ source: 'plugin', level, text: `scheduler: ${text}` })
    } catch {
      /* logging must never stop the loop */
    }
    if (level === 'warn' || level === 'error') logger?.warn?.(text)
  }

  /** One pass: fire everything that is due, one at a time. */
  async function tick() {
    if (ticking === true) return { skipped: true }
    if (taskboard === undefined || taskboard === null) return { skipped: true }
    ticking = true
    stats.ticks += 1
    stats.lastTickAt = now()
    const fired = []
    try {
      const due = taskboard.dueScheduled(now())
      for (const item of due) {
        try {
          const result = await execute(item.id)
          fired.push({ id: item.id, ...result })
          stats.fired += 1
          // Recompute the anchor from the moment we fired.
          taskboard.markScheduled(item.id, { lastRunAt: now() })
          note('info', `fired ${item.id} (${item.title})`)
          try {
            bus?.emit?.('taskboard:scheduled', { id: item.id, title: item.title, at: now() })
          } catch {
            /* ignore */
          }
        } catch (error) {
          stats.failures += 1
          const detail = normalizeError(error)
          stats.lastError = detail.message
          note('warn', `could not fire ${item.id}: ${detail.message}`)
          // Do not spin: push the anchor forward by one tick.
          try {
            taskboard.markScheduled(item.id, { lastRunAt: now() })
          } catch {
            /* ignore */
          }
        }
      }
    } finally {
      ticking = false
    }
    return { fired }
  }

  return {
    start() {
      if (timer !== null) return
      timer = setInterval(() => {
        void tick()
      }, tickMs)
      if (typeof timer.unref === 'function') timer.unref()
      note('info', `scheduler started (every ${tickMs}ms)`)
    },
    stop() {
      if (timer === null) return
      clearInterval(timer)
      timer = null
    },
    tick,
    stats: () => ({ ...stats, running: timer !== null, intervalMs: tickMs }),
    dispose() {
      this.stop()
    },
  }
}