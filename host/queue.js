/**
 * Execution queue for the task board.
 *
 * The scheduler used to fire one due card at a time; with N worktrees and N
 * sessions there is no reason to stay serial. This queue keeps at most
 * `maxConcurrent` runs alive, orders the waiters by urgency then arrival, and
 * refuses to queue the same task twice (queued or running).
 *
 * Pure-ish: `run` and `now` are injected, so the ordering, the concurrency cap
 * and the failure path are all testable without a model or a timer.
 */
import { normalizeError, nowMs } from './util.js'

/** Lower rank runs first. Unknown urgencies behave like `normal`. */
const PRIORITY_RANK = { urgent: 0, normal: 1, relaxed: 2 }

export function createRunQueue({ maxConcurrent = 2, run, now = nowMs, logger, onEvent } = {}) {
  const limit = clampConcurrency(maxConcurrent)
  let capacity = limit
  /** @type {{taskId:string,label:string,priority:string,enqueuedAt:number,seq:number,meta:object}[]} */
  let waiting = []
  /** @type {Map<string, {taskId:string,label:string,priority:string,startedAt:number,seq:number}>} */
  const running = new Map()
  let seq = 0
  let completed = 0
  let failed = 0
  let disposed = false
  let pumping = false

  function clampConcurrency(value) {
    const n = Number(value)
    if (Number.isFinite(n) === false) return 2
    return Math.max(1, Math.min(8, Math.round(n)))
  }

  function emit(type, payload) {
    try {
      onEvent?.(type, payload)
    } catch {
      /* listeners must never break the queue */
    }
  }

  function failLog(message) {
    try {
      logger?.warn?.(`queue: ${message}`)
    } catch {
      /* ignore */
    }
  }

  function rankOf(priority) {
    return PRIORITY_RANK[priority] ?? 1
  }

  /** Waiting items in the order they will start. */
  function ordered() {
    return [...waiting].sort((a, b) => {
      const rank = rankOf(a.priority) - rankOf(b.priority)
      if (rank !== 0) return rank
      return a.seq - b.seq
    })
  }

  function positionOf(taskId) {
    const index = ordered().findIndex((item) => item.taskId === taskId)
    return index === -1 ? 0 : index + 1
  }

  /**
   * Ask for a slot. Returns `{ accepted, position, reason }`; `position` is 1
   * based and `0` once running.
   */
  function enqueue({ taskId, label = '', priority = 'normal', meta = {} } = {}) {
    const id = String(taskId ?? '')
    if (id === '') throw Object.assign(new Error('taskId is required'), { code: 'invalid-input' })
    if (disposed === true) return { accepted: false, position: 0, reason: 'disposed' }
    if (running.has(id)) return { accepted: false, position: 0, reason: 'running' }
    if (waiting.some((item) => item.taskId === id)) {
      return { accepted: false, position: positionOf(id), reason: 'queued' }
    }
    seq += 1
    waiting.push({ taskId: id, label: String(label ?? ''), priority: String(priority ?? 'normal'), enqueuedAt: now(), seq, meta })
    const position = ordered().findIndex((item) => item.taskId === id) + 1
    emit('queued', { taskId: id, position })
    pump()
    return { accepted: true, position: running.has(id) ? 0 : position }
  }

  function takeNext() {
    if (waiting.length === 0) return null
    const sorted = ordered()
    const next = sorted[0]
    waiting = waiting.filter((item) => item.taskId !== next.taskId)
    return next
  }

  /** Start as many waiting runs as the cap allows. */
  function pump() {
    if (pumping === true || disposed === true) return
    pumping = true
    try {
      while (running.size < capacity) {
        const next = takeNext()
        if (next === null) break
        startOne(next)
      }
    } finally {
      pumping = false
    }
  }

  function startOne(item) {
    const record = { taskId: item.taskId, label: item.label, priority: item.priority, startedAt: now(), seq: item.seq }
    running.set(item.taskId, record)
    emit('start', { taskId: item.taskId })
    let promise
    try {
      promise = Promise.resolve(run(item))
    } catch (error) {
      promise = Promise.reject(error)
    }
    promise
      .then(
        () => {
          completed += 1
        },
        (error) => {
          failed += 1
          failLog(`run ${item.taskId} failed: ${normalizeError(error).message}`)
          emit('failed', { taskId: item.taskId, message: normalizeError(error).message })
        },
      )
      .then(() => {
        running.delete(item.taskId)
        emit('finished', { taskId: item.taskId })
        pump()
      })
      .catch(() => {})
  }

  /** Drop a waiting task (a running one must be cancelled through its owner). */
  function cancel(taskId) {
    const id = String(taskId ?? '')
    const before = waiting.length
    waiting = waiting.filter((item) => item.taskId !== id)
    const removed = before !== waiting.length
    if (removed) emit('cancelled', { taskId: id })
    return { cancelled: removed, running: running.has(id) }
  }

  function stats() {
    return {
      maxConcurrent: capacity,
      running: [...running.values()].map((item) => ({ ...item })),
      queued: ordered().map((item, index) => ({ taskId: item.taskId, label: item.label, priority: item.priority, enqueuedAt: item.enqueuedAt, position: index + 1 })),
      completed,
      failed,
    }
  }

  function setCapacity(value) {
    capacity = clampConcurrency(value)
    pump()
    return capacity
  }

  function dispose() {
    disposed = true
    waiting = []
  }

  return {
    enqueue,
    cancel,
    pump,
    stats,
    setCapacity,
    dispose,
    isBusy: () => running.size > 0 || waiting.length > 0,
    positionOf,
  }
}