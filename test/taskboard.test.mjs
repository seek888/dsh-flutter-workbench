/**
 * Task-board engine tests: the ported ledger must keep dsh-taskboard's gates —
 * agents cannot complete a task, a held task cannot be taken over, versions are
 * optimistic, dependencies block claims, and the checklist never completes a task.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { TB_LANES, TB_STATUSES, createTaskboard } from '../host/taskboard.js'

function fakeStore(initial = {}) {
  const data = { ...initial }
  return {
    data,
    get: (key, fallback) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback),
    set: (key, value) => {
      data[key] = value
      return Promise.resolve(value)
    },
  }
}

function makeBoard() {
  const store = fakeStore()
  const events = []
  const board = createTaskboard({
    store,
    bus: { emit: (type) => events.push(type) },
    logs: { append: () => ({}) },
    settings: { get: () => ({}) },
    ctx: { get: () => undefined },
    logger: { warn() {}, info() {}, error() {}, debug() {} },
  })
  return { board, store, events }
}

test('statuses and lanes match the upstream plugin', () => {
  assert.deepEqual(TB_STATUSES, ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled', 'archived'])
  assert.deepEqual(TB_LANES.map((lane) => lane.id), ['backlog', 'todo', 'in_progress', 'in_review', 'done'])
})

test('create → get → list round trip, version starts at 1', () => {
  const { board } = makeBoard()
  const created = board.create({ title: '登录页', urgency: 'urgent', workspaceId: 'C:/app', description: 'd', checklist: ['a', 'b'] }, { actor: 'agent-1' })
  assert.equal(created.task.status, 'todo')
  assert.equal(created.task.version, 1)
  assert.equal(created.task.checklistTotal, 2)

  const fetched = board.get(created.task.id)
  assert.equal(fetched.task.title, '登录页')
  assert.equal(fetched.task.checklist.length, 2)
  assert.equal(fetched.task.checklist[0].checked, false)

  const listed = board.list({ workspaceId: 'C:/app' })
  assert.equal(listed.tasks.length, 1)
  assert.equal(listed.tasks[0].urgency, 'urgent')
  assert.deepEqual(listed.tasks[0].dependencies, [])
})

test('create validates title, urgency and status', () => {
  const { board } = makeBoard()
  assert.throws(() => board.create({ title: '  ', urgency: 'normal' }), (error) => error.code === 'invalid-input')
  assert.throws(() => board.create({ title: 'x', urgency: 'red' }), (error) => error.code === 'invalid-input')
  assert.throws(() => board.create({ title: 'x', urgency: 'normal', status: 'weird' }), (error) => error.code === 'invalid-input')
})

test('illegal transitions are rejected', () => {
  const { board } = makeBoard()
  const { task } = board.create({ title: 'x', urgency: 'normal' })
  assert.throws(() => board.move({ id: task.id, status: 'done' }, { actorKind: 'user' }), (error) => error.code === 'invalid-transition')
  assert.throws(() => board.move({ id: task.id, status: 'in_review' }, { actorKind: 'user' }), (error) => error.code === 'invalid-transition')
})

test('an agent can never move a task to done, the user can', () => {
  const { board } = makeBoard()
  const { task } = board.create({ title: 'x', urgency: 'normal' })
  board.move({ id: task.id, status: 'in_progress' }, { actor: 'agent-1' })
  board.move({ id: task.id, status: 'in_review' }, { actor: 'agent-1' })
  const current = board.get(task.id).task
  assert.throws(
    () => board.move({ id: task.id, status: 'done', ifVersion: current.version }, { actor: 'agent-1', actorKind: 'agent' }),
    (error) => error.code === 'forbidden',
  )
  const done = board.move({ id: task.id, status: 'done', ifVersion: current.version }, { actor: 'user', actorKind: 'user' })
  assert.equal(done.task.status, 'done')
})

test('claiming records the holder and blocks a takeover', () => {
  const { board } = makeBoard()
  const { task } = board.create({ title: 'x', urgency: 'normal' })
  const claimed = board.move({ id: task.id, status: 'in_progress' }, { actor: 'sess-A' })
  assert.equal(claimed.task.claimedBy, 'sess-A')

  const version = board.get(task.id).task.version
  assert.throws(
    () => board.move({ id: task.id, status: 'in_review', ifVersion: version }, { actor: 'sess-B' }),
    (error) => error.code === 'forbidden',
  )
  // The holder may move it on.
  const moved = board.move({ id: task.id, status: 'in_review', ifVersion: version }, { actor: 'sess-A' })
  assert.equal(moved.task.status, 'in_review')
  assert.equal(moved.task.claimedBy, null, 'leaving in_progress releases the hold')
})

test('dependencies block a claim until the prerequisite is in review or done', () => {
  const { board } = makeBoard()
  const first = board.create({ title: 'A', urgency: 'normal' }).task
  const second = board.create({ title: 'B', urgency: 'normal', blockedBy: [first.id] }).task

  assert.throws(() => board.move({ id: second.id, status: 'in_progress' }, { actor: 'sess-A' }), (error) => error.code === 'invalid-input')

  board.move({ id: first.id, status: 'in_progress' }, { actor: 'sess-A' })
  board.move({ id: first.id, status: 'in_review', ifVersion: board.get(first.id).task.version }, { actor: 'sess-A' })
  const claimed = board.move({ id: second.id, status: 'in_progress' }, { actor: 'sess-A' })
  assert.equal(claimed.task.status, 'in_progress')
})

test('versions are optimistic', () => {
  const { board } = makeBoard()
  const { task } = board.create({ title: 'x', urgency: 'normal' })
  board.update({ id: task.id, ifVersion: 1, patch: { title: 'y' } })
  assert.throws(
    () => board.update({ id: task.id, ifVersion: 1, patch: { title: 'z' } }),
    (error) => error.code === 'version-conflict',
  )
  assert.throws(
    () => board.move({ id: task.id, status: 'in_progress', ifVersion: 1 }, { actor: 'a' }),
    (error) => error.code === 'version-conflict',
  )
})

test('checklist add/check/uncheck never completes the task', () => {
  const { board } = makeBoard()
  const { task } = board.create({ title: 'x', urgency: 'normal' })
  const added = board.checklist({ id: task.id, action: 'add', ifVersion: 1, items: ['跑通单测', '截图'] }, { actor: 'a' })
  assert.equal(added.total, 2)

  const firstItem = added.checklist[0]
  const checked = board.checklist({ id: task.id, action: 'check', ifVersion: added.task.version, itemId: firstItem.id, note: 'flutter test ok' }, { actor: 'a' })
  assert.equal(checked.done, 1)
  assert.equal(checked.checklist[0].note, 'flutter test ok')
  assert.equal(board.get(task.id).task.status, 'todo', 'checking items does not move the task')

  const unchecked = board.checklist({ id: task.id, action: 'uncheck', ifVersion: checked.task.version, itemId: firstItem.id }, { actor: 'a' })
  assert.equal(unchecked.done, 0)
  assert.equal(unchecked.checklist[0].note, undefined)
})

test('checklist validates its inputs', () => {
  const { board } = makeBoard()
  const { task } = board.create({ title: 'x', urgency: 'normal' })
  assert.throws(() => board.checklist({ id: task.id, action: 'add', ifVersion: 1, items: [] }, { actor: 'a' }), (error) => error.code === 'invalid-input')
  assert.throws(() => board.checklist({ id: task.id, action: 'check', ifVersion: 1 }, { actor: 'a' }), (error) => error.code === 'invalid-input')
  assert.throws(() => board.checklist({ id: task.id, action: 'nope', ifVersion: 1 }, { actor: 'a' }), (error) => error.code === 'invalid-input')
})

test('comments append and read back in order', () => {
  const { board } = makeBoard()
  const { task } = board.create({ title: 'x', urgency: 'normal' })
  board.commentAdd({ id: task.id, body: '开始做' }, { actor: 'a' })
  const second = board.commentAdd({ id: task.id, body: '做完了' }, { actor: 'a' })
  assert.equal(second.comment.body, '做完了')
  const comments = board.comments(task.id).comments
  assert.deepEqual(comments.map((comment) => comment.body), ['开始做', '做完了'])
  assert.throws(() => board.commentAdd({ id: task.id, body: '  ' }, { actor: 'a' }), (error) => error.code === 'invalid-input')
})

test('soft delete hides the task from lists but keeps the record', async () => {
  const { board, store } = makeBoard()
  const { task } = board.create({ title: 'x', urgency: 'normal' })
  const removed = board.remove({ id: task.id, ifVersion: 1 })
  assert.equal(removed.trashed, true)
  assert.equal(board.list({}).tasks.length, 0)
  assert.equal(board.list({ includeTrashed: true }).tasks.length, 1)
  assert.throws(() => board.get(task.id), (error) => error.code === 'not-found')
  // Writes are debounced; flush before looking at the stored payload.
  await board.dispose()
  assert.equal(store.data.taskboard.tasks.length, 1)
  assert.equal(typeof store.data.taskboard.tasks[0].trashedAt, 'number')
})

test('execution report attaches to the caller session run', () => {
  const { board } = makeBoard()
  const { task } = board.create({ title: 'x', urgency: 'normal' })
  assert.throws(() => board.executionReport({ summary: 'x' }, { sessionId: 'sess-A' }), (error) => error.code === 'not-found')

  board.startExecution({ id: task.id }, { sessionId: 'sess-A' })
  assert.equal(board.get(task.id).task.status, 'in_progress')
  const reported = board.executionReport({ summary: '修好了', changedFiles: ['lib/a.dart'], checks: ['flutter test ok'] }, { sessionId: 'sess-A' })
  assert.equal(reported.taskId, task.id)
  assert.equal(reported.report.summary, '修好了')
  assert.equal(reported.report.changes, undefined)

  board.finishExecution({ id: task.id }, { sessionId: 'sess-A' })
  const runs = board.get(task.id).task.executions
  assert.equal(runs[0].outcome, 'succeeded')
})

test('state survives a restart and emits change events', () => {
  const store = fakeStore()
  const events = []
  const first = createTaskboard({ store, bus: { emit: (type) => events.push(type) }, logs: { append: () => ({}) }, settings: { get: () => ({}) }, ctx: { get: () => undefined } })
  const { task } = first.create({ title: '持久化', urgency: 'normal' })
  assert.ok(events.includes('taskboard:change'))
  void first.dispose()

  const second = createTaskboard({ store, bus: { emit: () => {} }, logs: { append: () => ({}) }, settings: { get: () => ({}) }, ctx: { get: () => undefined } })
  const listed = second.list({})
  assert.equal(listed.tasks.length, 1)
  assert.equal(listed.tasks[0].id, task.id)
})

test('unknown ids fail with not-found', () => {
  const { board } = makeBoard()
  assert.throws(() => board.get('nope'), (error) => error.code === 'not-found')
  assert.throws(() => board.update({ id: 'nope', patch: {} }), (error) => error.code === 'not-found')
})