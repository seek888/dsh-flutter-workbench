/**
 * Scheduling and worktree isolation.
 *
 * Pure where possible: cron maths needs no clock, the worktree helpers degrade
 * on a non-repository, and the execution path runs against a stub agent service
 * so a run is observable without spawning a model.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { cronMatches, nextCronRun, parseCron } from '../host/cron.js'
import { branchSlug, isGitRepo } from '../host/worktree.js'
import { createTaskboard } from '../host/taskboard.js'
import { createScheduler } from '../host/scheduler.js'

/* ------------------------------------------------------------------ cron */

test('cron parses the supported grammar and rejects junk', () => {
  const spec = parseCron('*/15 9-18 * * MON-FRI')
  assert.equal(spec.minutes.size, 4)
  assert.equal(spec.hours.size, 10)
  assert.equal(spec.domRestricted, false)
  assert.equal(spec.dowRestricted, true)
  assert.deepEqual([...spec.daysOfWeek].sort(), [1, 2, 3, 4, 5])
  assert.throws(() => parseCron('* * *'), (error) => error.code === 'invalid-cron')
  assert.throws(() => parseCron('61 * * * *'), (error) => error.code === 'invalid-cron')
  assert.throws(() => parseCron('*/0 * * * *'), (error) => error.code === 'invalid-cron')
})

test('cronMatches reads the wall clock', () => {
  const spec = parseCron('30 9 * * *')
  assert.equal(cronMatches(spec, new Date(2026, 10, 19, 9, 30, 0)), true)
  assert.equal(cronMatches(spec, new Date(2026, 10, 19, 9, 31, 0)), false)
  assert.equal(cronMatches(spec, new Date(2026, 10, 19, 10, 30, 0)), false)
})

test('nextCronRun returns the next matching minute', () => {
  const from = new Date(2026, 10, 19, 9, 7, 30).getTime()
  const next = nextCronRun('*/15 * * * *', from)
  assert.equal(new Date(next).getMinutes(), 15)
  assert.equal(new Date(next).getHours(), 9)

  const daily = nextCronRun('0 6 * * *', from)
  assert.equal(new Date(daily).getHours(), 6)
  assert.ok(new Date(daily).getTime() > from)
})

/* -------------------------------------------------------------- worktree */

test('branch slugs are readable and stable', () => {
  const slug = branchSlug('登录页 Login Page!', 'task_abc12345')
  assert.match(slug, /^task\/.*[0-9a-z]{8}$/)
  assert.ok(slug.length <= 60)
  assert.equal(slug.includes(' '), false)
  // Pure-CJK titles fall back to the id tail rather than an empty branch.
  assert.match(branchSlug('登录页', 'task_abc12345'), /^task\/[0-9a-z]{8}$/)
})

test('worktree helpers degrade on a non-repository', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fwb-wt-'))
  try {
    assert.equal(await isGitRepo(dir), false)
    assert.equal(await isGitRepo(''), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------- taskboard runs */

function fakeStore() {
  const data = {}
  return {
    data,
    get: (key, fallback) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback),
    set: (key, value) => {
      data[key] = value
      return Promise.resolve(value)
    },
  }
}

function fakeAgents() {
  const created = []
  const sent = []
  return {
    created,
    sent,
    async create(request) {
      created.push(request)
      return {
        agent: {
          id: request.sessionId,
          async followup(message) {
            sent.push(message)
          },
          async whenIdle() {},
          cancel() {},
        },
        dispose: async () => {},
      }
    },
  }
}

function makeBoard({ withAgents = true, settings = {} } = {}) {
  const agents = fakeAgents()
  const store = fakeStore()
  const board = createTaskboard({
    store,
    bus: { emit: () => {} },
    logs: { append: () => ({}) },
    settings: { get: () => settings },
    ctx: { get: (name) => (name === 'agents' && withAgents ? agents : undefined) },
    logger: { warn() {}, info() {}, error() {}, debug() {} },
  })
  return { board, agents, store }
}

test('a cron card becomes due only when its minute arrives', () => {
  const { board } = makeBoard()
  const created = board.create({ title: '每日构建', urgency: 'normal', execution: { mode: 'scheduled', cron: '0 6 * * *' } })
  assert.equal(board.dueScheduled(new Date(2026, 10, 19, 5, 59).getTime()).length, 0)
  const due = board.dueScheduled(new Date(2026, 10, 19, 6, 0).getTime())
  assert.equal(due.length, 1)
  assert.equal(due[0].id, created.task.id)
})

test('a one-shot runAt fires once, then the card drops back to claim mode', () => {
  const { board } = makeBoard()
  const at = new Date(2026, 10, 19, 12, 0).getTime()
  const created = board.create({ title: '一次性', urgency: 'normal', execution: { mode: 'scheduled', runAt: String(at) } })
  assert.equal(board.dueScheduled(at - 60000).length, 0)
  assert.equal(board.dueScheduled(at).length, 1)

  board.markScheduled(created.task.id, { lastRunAt: at })
  assert.equal(board.dueScheduled(at + 60000).length, 0, 'a one-shot card never fires again')
  const reloaded = board.get(created.task.id).task
  assert.equal(reloaded.execution.mode, 'claim')
})

test('a cron card reschedules itself after firing', () => {
  const { board } = makeBoard()
  const created = board.create({ title: '每小时', urgency: 'normal', execution: { mode: 'scheduled', cron: '0 * * * *' } })
  const firedAt = new Date(2026, 10, 19, 9, 0).getTime()
  const marked = board.markScheduled(created.task.id, { lastRunAt: firedAt })
  assert.equal(new Date(marked.nextRunAt).getHours(), 10)
  assert.equal(board.dueScheduled(firedAt + 60000).length, 0)
  assert.equal(board.dueScheduled(new Date(2026, 10, 19, 10, 0).getTime()).length, 1)
})

test('executeTask spawns a session, records the run and claims the card', async () => {
  const { board, agents } = makeBoard()
  const created = board.create({ title: '修复 401', urgency: 'urgent', workspaceId: process.cwd(), checklist: ['测试通过'] })
  const started = await board.executeTask({ id: created.task.id, isolation: 'none' })
  assert.equal(started.task.status, 'in_progress')
  assert.equal(started.task.claimedBy, started.sessionId)
  assert.equal(agents.created.length, 1)
  const prompt = agents.sent[0].content[0].text
  assert.ok(prompt.includes(created.task.id))
  assert.ok(prompt.includes('taskboard_execution_report'))
  assert.ok(prompt.includes('Never move a task to done'))
  // The report now attaches to this run.
  const reported = board.executionReport({ summary: 'done' }, { sessionId: started.sessionId })
  assert.equal(reported.taskId, created.task.id)
})

test('executeTask degrades to the project dir when worktree isolation is not possible', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fwb-run-'))
  try {
    const { board } = makeBoard()
    const created = board.create({ title: 'x', urgency: 'normal', workspaceId: dir, isolation: 'worktree' })
    const started = await board.executeTask({ id: created.task.id, isolation: 'worktree' })
    assert.equal(started.worktreePath, null)
    assert.match(String(started.degraded), /not a git repository/)
    assert.equal(started.task.status, 'in_progress')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('executeTask refuses a second concurrent run and needs an agent service', async () => {
  const { board } = makeBoard()
  const created = board.create({ title: 'x', urgency: 'normal', workspaceId: process.cwd() })
  await board.executeTask({ id: created.task.id, isolation: 'none' })
  await assert.rejects(() => board.executeTask({ id: created.task.id, isolation: 'none' }), (error) => error.code === 'already-running')

  const noAgents = makeBoard({ withAgents: false })
  const task = noAgents.board.create({ title: 'y', urgency: 'normal', workspaceId: process.cwd() })
  await assert.rejects(() => noAgents.board.executeTask({ id: task.task.id }), (error) => error.code === 'agents-unavailable')
})

test('acceptTask moves a finished card to done as a human action', async () => {
  const { board } = makeBoard()
  const created = board.create({ title: 'x', urgency: 'normal', workspaceId: process.cwd() })
  const started = await board.executeTask({ id: created.task.id, isolation: 'none' })
  board.finishExecution({ id: created.task.id }, { sessionId: started.sessionId })
  board.move({ id: created.task.id, status: 'in_review', ifVersion: board.get(created.task.id).task.version }, { actor: started.sessionId })
  const accepted = await board.acceptTask({ id: created.task.id, ifVersion: board.get(created.task.id).task.version })
  assert.equal(accepted.task.status, 'done')
  assert.equal(accepted.worktree.merge, null, 'no worktree was used, so nothing to merge')
})

test('schedulers fire due cards exactly once per tick', async () => {
  const { board } = makeBoard()
  const at = new Date(2026, 10, 19, 12, 0).getTime()
  board.create({ title: '定时跑', urgency: 'normal', workspaceId: process.cwd(), execution: { mode: 'scheduled', runAt: String(at) } })
  const fired = []
  const scheduler = createScheduler({
    taskboard: board,
    intervalMs: 2000,
    now: () => at,
    execute: async (id) => {
      fired.push(id)
      return { ok: true }
    },
  })
  const result = await scheduler.tick()
  assert.equal(result.fired.length, 1)
  assert.equal(fired.length, 1)
  // Next tick is quiet: the card was rescheduled (one-shot → claim mode).
  const second = await scheduler.tick()
  assert.equal(second.fired.length, 0)
  scheduler.dispose()
})

test('a failing execution is logged and does not spin the scheduler', async () => {
  const { board } = makeBoard()
  const at = new Date(2026, 10, 19, 12, 0).getTime()
  board.create({ title: '总是失败', urgency: 'normal', workspaceId: process.cwd(), execution: { mode: 'scheduled', cron: '0 12 * * *' } })
  const scheduler = createScheduler({
    taskboard: board,
    intervalMs: 2000,
    now: () => at,
    execute: async () => {
      throw new Error('worker bob')
    },
  })
  const first = await scheduler.tick()
  assert.equal(first.fired.length, 0)
  assert.equal(scheduler.stats().failures, 1)
  const second = await scheduler.tick()
  assert.equal(second.fired.length, 0, 'the anchor moved forward, no tight retry loop')
  scheduler.dispose()
})