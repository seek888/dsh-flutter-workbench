/**
 * Execution queue: concurrency cap, urgency ordering, de-duplication, failure
 * handling and the scheduler hand-off. `run` is a deferred promise here, so the
 * test drives completion explicitly and never touches a model or a timer.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRunQueue } from '../host/queue.js'
import { createTaskboard } from '../host/taskboard.js'
import { createScheduler } from '../host/scheduler.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** A run function whose promises the test settles by hand. */
function controlledRun() {
  const calls = []
  let gate = []
  return {
    calls,
    run(item) {
      const d = deferred()
      calls.push({ item, ...d })
      return d.promise
    },
    settle(index, value) {
      const call = calls[index]
      if (call !== undefined) call.resolve(value)
    },
    fail(index, error) {
      const call = calls[index]
      if (call !== undefined) call.reject(error)
    },
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('the queue never exceeds its concurrency limit', async () => {
  const control = controlledRun()
  const queue = createRunQueue({ maxConcurrent: 2, run: control.run })
  queue.enqueue({ taskId: 'a' })
  queue.enqueue({ taskId: 'b' })
  queue.enqueue({ taskId: 'c' })
  assert.equal(queue.stats().running.length, 2)
  assert.equal(queue.stats().queued.length, 1)
  assert.deepEqual(control.calls.map((call) => call.item.taskId), ['a', 'b'])

  control.settle(0)
  await tick()
  assert.equal(queue.stats().running.length, 2)
  assert.equal(queue.stats().queued.length, 0)
  assert.deepEqual(control.calls.map((call) => call.item.taskId), ['a', 'b', 'c'])
})

test('urgent work jumps ahead of what arrived earlier', async () => {
  const control = controlledRun()
  const queue = createRunQueue({ maxConcurrent: 1, run: control.run })
  queue.enqueue({ taskId: 'blocker' })
  queue.enqueue({ taskId: 'relaxed', priority: 'relaxed' })
  queue.enqueue({ taskId: 'urgent', priority: 'urgent' })
  assert.equal(queue.positionOf('urgent'), 1)
  assert.equal(queue.positionOf('relaxed'), 2)

  control.settle(0)
  await tick()
  assert.equal(control.calls[1].item.taskId, 'urgent')
  control.settle(1)
  await tick()
  assert.equal(control.calls[2].item.taskId, 'relaxed')
})

test('a task cannot be queued twice, nor while it is running', async () => {
  const control = controlledRun()
  const queue = createRunQueue({ maxConcurrent: 1, run: control.run })
  assert.equal(queue.enqueue({ taskId: 'a' }).accepted, true)
  assert.equal(queue.enqueue({ taskId: 'b' }).accepted, true)
  const duplicateQueued = queue.enqueue({ taskId: 'b' })
  assert.equal(duplicateQueued.accepted, false)
  assert.equal(duplicateQueued.reason, 'queued')
  assert.equal(duplicateQueued.position, 1)

  const duplicateRunning = queue.enqueue({ taskId: 'a' })
  assert.equal(duplicateRunning.accepted, false)
  assert.equal(duplicateRunning.reason, 'running')
})

test('a failed run frees its slot and is counted', async () => {
  const control = controlledRun()
  const queue = createRunQueue({ maxConcurrent: 1, run: control.run, logger: { warn() {} } })
  queue.enqueue({ taskId: 'a' })
  queue.enqueue({ taskId: 'b' })
  control.fail(0, new Error('boom'))
  await tick()
  assert.equal(queue.stats().failed, 1)
  assert.equal(control.calls.length, 2, 'the next item still starts')
  assert.equal(queue.stats().running.length, 1)
})

test('cancel drops a waiting item but cannot touch a running one', async () => {
  const control = controlledRun()
  const queue = createRunQueue({ maxConcurrent: 1, run: control.run })
  queue.enqueue({ taskId: 'a' })
  queue.enqueue({ taskId: 'b' })
  assert.deepEqual(queue.cancel('b'), { cancelled: true, running: false })
  assert.deepEqual(queue.cancel('a'), { cancelled: false, running: true })
  assert.equal(queue.stats().queued.length, 0)
})

test('raising the capacity starts waiting work immediately', async () => {
  const control = controlledRun()
  const queue = createRunQueue({ maxConcurrent: 1, run: control.run })
  queue.enqueue({ taskId: 'a' })
  queue.enqueue({ taskId: 'b' })
  assert.equal(control.calls.length, 1)
  queue.setCapacity(3)
  assert.equal(control.calls.length, 2)
  assert.equal(queue.stats().maxConcurrent, 3)
})

/* ------------------------------------------- scheduler hands off the queue */

function fakeStore() {
  const data = {}
  return {
    get: (key, fallback) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback),
    set: (key, value) => {
      data[key] = value
      return Promise.resolve(value)
    },
  }
}

test('the scheduler queues a due card once and moves its anchor', async () => {
  const board = createTaskboard({
    store: fakeStore(),
    bus: { emit: () => {} },
    logs: { append: () => ({}) },
    settings: { get: () => ({}) },
    ctx: { get: () => undefined },
    logger: { warn() {}, info() {}, error() {}, debug() {} },
  })
  const at = new Date(2026, 10, 20, 9, 0).getTime()
  const created = board.create({ title: '定时任务', urgency: 'urgent', workspaceId: process.cwd(), execution: { mode: 'scheduled', cron: '0 9 * * *' } })
  const enqueued = []
  const scheduler = createScheduler({
    taskboard: board,
    intervalMs: 2000,
    now: () => at,
    enqueue: (item) => {
      enqueued.push(item)
      return { accepted: true, position: 1 }
    },
  })
  const first = await scheduler.tick()
  assert.equal(first.fired.length, 1)
  assert.equal(enqueued.length, 1)
  assert.equal(enqueued[0].id, created.task.id)
  assert.equal(scheduler.stats().enqueued, 1)

  // Anchor moved → the same minute cannot fire it twice.
  const second = await scheduler.tick()
  assert.equal(second.fired.length, 0)
  assert.equal(enqueued.length, 1)
  scheduler.dispose()
})