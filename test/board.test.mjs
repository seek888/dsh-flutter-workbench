/**
 * Board engine tests. Everything runs offline: a fake store, a fake bus, a fake
 * logs service and a fake `ctx` whose `get('agents')` returns a stub agent
 * factory, so the state machine, decomposition, dispatch and reporting are all
 * exercised without a model, a Flutter SDK or a session.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createBoard, LANES } from '../host/board.js'

/* ---------------------------------------------------------------- fakes */

function fakeStore(initial = {}) {
  const data = { ...initial }
  const calls = []
  return {
    data,
    calls,
    get(key, fallback) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback
    },
    set(key, value) {
      calls.push({ key, value })
      data[key] = value
      return Promise.resolve(value)
    },
    update(key, mutate) {
      return Promise.resolve(mutate(data[key])).then((next) => {
        if (next !== undefined) data[key] = next
        return data[key]
      })
    },
    all() {
      return data
    },
    flush() {
      return Promise.resolve()
    },
    reset() {
      return Promise.resolve()
    },
  }
}

function fakeBus() {
  const listeners = new Map()
  const emitted = []
  return {
    emitted,
    on(type, callback) {
      const set = listeners.get(type) ?? new Set()
      listeners.set(type, set)
      set.add(callback)
      return () => set.delete(callback)
    },
    emit(type, payload) {
      emitted.push({ type, payload })
      for (const callback of [...(listeners.get(type) ?? [])]) callback(payload)
    },
    types() {
      return [...listeners.keys()]
    },
  }
}

function fakeLogs() {
  const entries = []
  return {
    entries,
    append(entry) {
      entries.push(entry)
      return entry
    },
    counts() {
      return { byLevel: {}, bySource: {}, total: entries.length }
    },
  }
}

function fakeAgents(options = {}) {
  const created = []
  const sent = []
  const live = new Map()
  const disposed = []
  let reply = options.reply ?? ''
  return {
    created,
    sent,
    live,
    disposed,
    setReply(value) {
      reply = value
    },
    async create(request) {
      created.push(request)
      if (options.fail === true) throw Object.assign(new Error('no agent factory in this test'), { code: 'no-factory' })
      const sessionId = String(request.sessionId)
      const session = {
        header: { cwd: request.meta?.cwd },
        deriveMessages: () => (reply === '' ? [] : [{ role: 'assistant', content: [{ type: 'text', text: reply }] }]),
      }
      const agent = {
        id: sessionId,
        status: 'running',
        session,
        model: null,
        async followup(message) {
          sent.push({ sessionId, message })
        },
        async whenIdle() {
          agent.status = 'idle'
        },
        cancel() {
          agent.status = 'idle'
        },
      }
      live.set(sessionId, agent)
      return {
        agent,
        dispose: async () => {
          disposed.push(sessionId)
          live.delete(sessionId)
        },
      }
    },
    get(id) {
      return live.get(String(id))
    },
  }
}

function fakeCtx(agents, extras = {}) {
  const services = { agents, ...extras }
  return {
    get(name) {
      return services[name]
    },
  }
}

function makeBoard(overrides = {}) {
  const store = overrides.store ?? fakeStore()
  const bus = overrides.bus ?? fakeBus()
  const agents = overrides.agents ?? fakeAgents()
  const logs = overrides.logs ?? fakeLogs()
  return {
    store,
    bus,
    agents,
    logs,
    board: createBoard({
      store,
      bus,
      logs,
      ctx: overrides.ctx ?? fakeCtx(agents),
      settings: overrides.settings ?? { get: () => ({}) },
      logger: overrides.logger ?? { warn() {}, info() {}, error() {}, debug() {} },
    }),
  }
}

/* ----------------------------------------------------------------- tests */

test('lanes match the contract', () => {
  assert.deepEqual(LANES.map((lane) => lane.id), ['backlog', 'ready', 'running', 'review', 'verify', 'done'])
  assert.deepEqual(LANES.map((lane) => lane.label), ['待办', '就绪', '执行中', '待验收', '验证中', '完成'])
})

test('a new card has the exact task shape and starts in backlog', () => {
  const { board } = makeBoard()
  const task = board.addTask({ title: '实现登录页', detail: 'd', acceptance: ['a1'], verify: ['flutter test'], files: ['lib/login.dart'], priority: 'high', tags: ['ui'] })
  assert.deepEqual(Object.keys(task), [
    'id', 'title', 'detail', 'lane', 'order', 'priority', 'tags', 'acceptance', 'verify',
    'files', 'deps', 'projectId', 'createdAt', 'updatedAt', 'history', 'agent', 'result', 'blocked',
  ])
  assert.equal(task.lane, 'backlog')
  assert.equal(task.priority, 'high')
  assert.deepEqual(task.acceptance, ['a1'])
  assert.equal(task.agent, null)
  assert.equal(task.result, null)
  assert.equal(task.blocked, false)
  assert.equal(task.history.length, 1)
  assert.deepEqual(Object.keys(task.history[0]), ['at', 'from', 'to', 'note', 'by'])
  assert.equal(task.history[0].from, null)
  assert.equal(task.history[0].to, 'backlog')
})

test('a card requires a title', () => {
  const { board } = makeBoard()
  assert.throws(() => board.addTask({ detail: 'no title' }), (error) => error.code === 'invalid-input')
})

test('orders stay dense and drag-and-drop reorders within a lane', () => {
  const { board } = makeBoard()
  const first = board.addTask({ title: 'A' })
  const second = board.addTask({ title: 'B' })
  const third = board.addTask({ title: 'C' })
  assert.deepEqual([first.order, second.order, third.order], [0, 1, 2])

  board.moveTask({ id: third.id, lane: 'backlog', index: 0 })
  const backlogs = board.snapshot().tasks.filter((task) => task.lane === 'backlog')
  assert.deepEqual(backlogs.map((task) => task.title), ['C', 'A', 'B'])
  assert.deepEqual(backlogs.map((task) => task.order), [0, 1, 2])
})

test('cross-lane moves record history in both directions', () => {
  const { board } = makeBoard()
  const task = board.addTask({ title: 'A' })
  board.moveTask({ id: task.id, lane: 'ready', by: 'user' })
  let current = board.snapshot().tasks[0]
  assert.equal(current.lane, 'ready')
  assert.equal(current.history.length, 2)
  assert.equal(current.history[1].from, 'backlog')
  assert.equal(current.history[1].to, 'ready')

  board.moveTask({ id: task.id, lane: 'backlog', by: 'user', note: '需求又变了' })
  current = board.snapshot().tasks[0]
  assert.equal(current.lane, 'backlog')
  assert.equal(current.history.length, 3)
  assert.equal(current.history[2].from, 'ready')
  assert.equal(current.history[2].to, 'backlog')
  assert.equal(current.history[2].note, '需求又变了')
})

test('done requires a passing verdict unless forced', () => {
  const { board } = makeBoard()
  const task = board.addTask({ title: 'A' })
  assert.throws(() => board.moveTask({ id: task.id, lane: 'done' }), (error) => error.code === 'verdict-required')

  board.report({ id: task.id, status: 'done', summary: 'done', verdict: 'pass' })
  const moved = board.moveTask({ id: task.id, lane: 'done' })
  assert.equal(moved.lane, 'done')

  const forced = board.addTask({ title: 'B' })
  assert.equal(board.moveTask({ id: forced.id, lane: 'done', force: true }).lane, 'done')
})

test('move and update reject unknown lanes and unknown cards', () => {
  const { board } = makeBoard()
  const task = board.addTask({ title: 'A' })
  assert.throws(() => board.moveTask({ id: task.id, lane: 'nope' }), (error) => error.code === 'invalid-lane')
  assert.throws(() => board.moveTask({ id: 'missing', lane: 'ready' }), (error) => error.code === 'not-found')
  assert.throws(() => board.updateTask({ id: 'missing', patch: { title: 'x' } }), (error) => error.code === 'not-found')
})

test('updateTask patches whitelisted fields and routes lane changes through the gate', () => {
  const { board } = makeBoard()
  const task = board.addTask({ title: 'A' })
  const patched = board.updateTask({
    id: task.id,
    patch: { title: 'B', priority: 'urgent', acceptance: ['x'], createdAt: 1, id: 'hacked' },
  })
  assert.equal(patched.title, 'B')
  assert.equal(patched.priority, 'urgent')
  assert.deepEqual(patched.acceptance, ['x'])
  assert.equal(patched.id, task.id, 'id must not be patchable')
  assert.notEqual(patched.createdAt, 1, 'createdAt must not be patchable')

  const moved = board.updateTask({ id: task.id, patch: { lane: 'ready' } })
  assert.equal(moved.lane, 'ready')
})

test('removeTask and archiveDone report counts and keep the board consistent', async () => {
  const { board, store } = makeBoard()
  const keep = board.addTask({ title: 'keep' })
  const drop = board.addTask({ title: 'drop' })
  assert.deepEqual(board.removeTask({ id: drop.id }).removed, true)
  assert.deepEqual(board.removeTask({ id: drop.id }).removed, false)
  assert.equal(board.snapshot().tasks.length, 1)

  const finished = board.addTask({ title: 'done one' })
  board.moveTask({ id: finished.id, lane: 'done', force: true })
  const archived = board.archiveDone()
  assert.equal(archived.archived, 1)
  assert.equal(board.snapshot().tasks.length, 1, 'only the unfinished card stays')
  assert.equal(archived.board.tasks[0].id, keep.id, 'the unfinished card is the survivor')
  await board.flush()
  assert.equal(store.data.board.archived.length, 1)
  assert.equal(store.data.board.archived[0].id, finished.id)
})

test('mutation emits board:change and persists after the debounce window', async () => {
  const { board, bus, store } = makeBoard()
  assert.equal(store.calls.length, 0, 'nothing is written synchronously')
  board.addTask({ title: 'A' })
  assert.equal(store.calls.length, 0, 'the write is debounced')
  assert.equal(bus.emitted.length, 1)
  assert.equal(bus.emitted[0].type, 'board:change')
  assert.equal(bus.emitted[0].payload.tasks.length, 1)

  await new Promise((resolve) => setTimeout(resolve, 220))
  assert.equal(store.calls.length, 1, 'the debounced write must land well inside 200 ms of idle + margin')
  assert.equal(store.data.board.version, 1)
  assert.equal(store.data.board.tasks.length, 1)
})

test('onChange subscribes and unsubscribes', () => {
  const { board } = makeBoard()
  let seen = 0
  const off = board.onChange(() => {
    seen += 1
  })
  board.addTask({ title: 'A' })
  assert.equal(seen, 1)
  off()
  board.addTask({ title: 'B' })
  assert.equal(seen, 1)
})

test('state survives a restart through the store', async () => {
  const store = fakeStore()
  const first = makeBoard({ store })
  const task = first.board.addTask({ title: 'persisted', acceptance: ['a'] })
  first.board.moveTask({ id: task.id, lane: 'ready' })
  await first.board.flush()

  const store2 = fakeStore(store.data)
  const second = makeBoard({ store: store2 })
  const restored = second.board.snapshot().tasks
  assert.equal(restored.length, 1)
  assert.equal(restored[0].title, 'persisted')
  assert.equal(restored[0].lane, 'ready')
  assert.deepEqual(restored[0].acceptance, ['a'])
})

test('a malformed stored payload is quarantined instead of crashing', async () => {
  const store = fakeStore({ board: { version: 1, tasks: 'not-an-array' } })
  const { board } = makeBoard({ store })
  assert.equal(board.snapshot().tasks.length, 0)
  assert.ok(store.data['board-quarantine'] !== undefined, 'the raw payload must be kept for inspection')
  assert.equal(store.data['board-quarantine'].raw.tasks, 'not-an-array')

  const task = board.addTask({ title: 'still works' })
  assert.equal(task.title, 'still works')
})

test('a stored card with an unknown lane is repaired, a card without a title is dropped', () => {
  const store = fakeStore({
    board: {
      version: 1,
      tasks: [
        { id: 't1', title: 'ok', lane: 'weird-lane', order: 4 },
        { id: 't2', lane: 'ready' },
        { id: 't3', title: 'ok too', lane: 'ready' },
      ],
    },
  })
  const { board } = makeBoard({ store })
  const tasks = board.snapshot().tasks
  assert.equal(tasks.length, 2)
  assert.equal(tasks[0].id, 't1')
  assert.equal(tasks[0].lane, 'backlog')
  assert.deepEqual(tasks.map((task) => task.order), [0, 0], 'each lane is renumbered from zero')
})

test('decompose turns an agent reply into cards, honouring dependencies and the cap', async () => {
  const agents = fakeAgents()
  const reply = [
    'Sure, here is the plan:',
    '```json',
    JSON.stringify({
      tasks: [
        { title: 'B', detail: 'b', acceptance: ['b1'], verify: ['flutter test'], files: ['lib/b.dart'], priority: 'urgent', dependsOn: [1] },
        { title: 'A', detail: 'a', acceptance: ['a1'], verify: ['flutter analyze'], files: ['lib/a.dart'], priority: 'high', dependsOn: [] },
      ],
    }),
    '```',
  ].join('\n')
  agents.setReply(reply)
  const { board, agents: stub } = makeBoard({ agents })

  const result = await board.decompose({ prompt: '做一个登录页', maxTasks: 6 })
  assert.equal(result.error, undefined)
  assert.equal(result.tasks.length, 2)
  assert.equal(stub.created.length, 1, 'one planning session')
  assert.ok(stub.disposed.includes(stub.created[0].sessionId), 'the planning session is disposed')

  const created = result.tasks
  assert.deepEqual(created.map((task) => task.title), ['A', 'B'], 'dependency order wins over declaration order')
  assert.equal(created[0].lane, 'backlog')
  assert.equal(created[0].order, 0)
  assert.equal(created[1].order, 1)
  assert.deepEqual(created[1].deps, [created[0].id])
  assert.equal(created[1].priority, 'urgent')

  const snapshot = board.snapshot()
  assert.equal(snapshot.tasks.length, 2)
  assert.equal(snapshot.counts.backlog, 2)
})

test('decompose respects maxTasks', async () => {
  const agents = fakeAgents()
  agents.setReply(JSON.stringify({ tasks: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] }))
  const { board } = makeBoard({ agents })
  const result = await board.decompose({ prompt: 'x', maxTasks: 2 })
  assert.equal(result.tasks.length, 2)
})

test('decompose never fabricates cards from an unusable reply', async () => {
  const agents = fakeAgents()
  agents.setReply('I could not plan that, sorry.')
  const { board } = makeBoard({ agents })
  const result = await board.decompose({ prompt: 'x' })
  assert.equal(result.tasks.length, 0)
  assert.ok(result.error !== undefined)
  assert.equal(result.raw, 'I could not plan that, sorry.')
  assert.equal(board.snapshot().tasks.length, 0)
})

test('decompose reports an unavailable agent service instead of throwing', async () => {
  const { board } = makeBoard({ ctx: { get: () => undefined } })
  const result = await board.decompose({ prompt: 'x' })
  assert.equal(result.tasks.length, 0)
  assert.equal(result.error.code, 'agents-unavailable')
})

test('decompose surfaces a failing agent factory as an error, not a crash', async () => {
  const agents = fakeAgents({ fail: true })
  const { board } = makeBoard({ agents })
  const result = await board.decompose({ prompt: 'x' })
  assert.equal(result.tasks.length, 0)
  assert.equal(result.error.code, 'no-factory')
})

test('dispatch seeds the card contract into a worker session', async () => {
  const agents = fakeAgents()
  const settings = { get: () => ({ defaultProvider: 'test-provider', defaultModel: 'test-model' }) }
  const { board } = makeBoard({ agents, settings })
  const task = board.addTask({
    title: '修复 401',
    detail: '登录接口返回 401',
    acceptance: ['请求带上 Bearer token', '单测通过'],
    verify: ['flutter test test/auth_test.dart'],
    files: ['lib/auth.dart'],
  })

  const dispatched = await board.dispatch({ id: task.id, cwd: '/tmp/project' })
  assert.equal(dispatched.task.lane, 'running')
  assert.equal(dispatched.task.agent.status, 'working')
  assert.equal(dispatched.task.agent.sessionId, dispatched.sessionId)

  const request = agents.created[0]
  assert.deepEqual(request.agentOptions, { provider: 'test-provider', model: 'test-model' })
  assert.equal(request.meta.cwd, '/tmp/project')

  const prompt = agents.sent[0].message.content[0].text
  assert.ok(prompt.includes(task.id), 'the card id reaches the worker')
  assert.ok(prompt.includes('请求带上 Bearer token'), 'acceptance criteria reach the worker')
  assert.ok(prompt.includes('flutter test test/auth_test.dart'), 'verify commands reach the worker')
  assert.ok(prompt.includes('lib/auth.dart'), 'files reach the worker')
  assert.ok(prompt.includes('flutter_task_report'), 'the worker is told which tool reports back')
  assert.deepEqual(agents.sent[0].message.content[0].type, 'text')
})

test('dispatch refuses a second worker for the same card', async () => {
  const { board } = makeBoard()
  const task = board.addTask({ title: 'A' })
  await board.dispatch({ id: task.id })
  await assert.rejects(() => board.dispatch({ id: task.id }), (error) => error.code === 'already-running')
})

test('dispatch restricts tools for a read-only card', async () => {
  const agents = fakeAgents()
  const { board } = makeBoard({ agents })
  const task = board.addTask({ title: 'A', tags: ['read-only'] })
  await board.dispatch({ id: task.id })
  assert.equal(typeof agents.created[0].setup, 'function')
  const denied = []
  agents.created[0].setup({ tools: { restrict: (spec) => denied.push(spec) } })
  assert.deepEqual(denied[0], { deny: ['write', 'edit', 'pwsh', 'subagent', 'subagent_fork'] })
})

test('report moves a passing card to review and stores the result', async () => {
  const { board } = makeBoard()
  const task = board.addTask({ title: 'A' })
  await board.dispatch({ id: task.id })

  const reported = board.report({
    id: task.id,
    status: 'done',
    summary: '修好了',
    commandsRun: [{ command: 'flutter test', status: 'passed', exitCode: 0 }],
    evidence: ['lib/auth.dart:42'],
    files: ['lib/auth.dart'],
    verdict: 'pass',
  })
  assert.equal(reported.lane, 'review')
  assert.equal(reported.agent.status, 'done')
  assert.equal(reported.agent.lastReport, '修好了')
  assert.equal(reported.result.verdict, 'pass')
  assert.equal(reported.result.commandsRun.length, 1)
  assert.equal(reported.result.commandsRun[0].status, 'passed')
  assert.deepEqual(reported.result.evidence, ['lib/auth.dart:42'])
  assert.equal(reported.history.at(-1).from, 'running')
  assert.equal(reported.history.at(-1).to, 'review')
})

test('report returns a failing card to ready with the reason', async () => {
  const { board } = makeBoard()
  const task = board.addTask({ title: 'A' })
  await board.dispatch({ id: task.id })
  const reported = board.report({ id: task.id, status: 'failed', summary: '测试没通过', verdict: 'fail', note: 'auth_test 挂了两条' })
  assert.equal(reported.lane, 'ready')
  assert.equal(reported.agent.status, 'failed')
  assert.equal(reported.result.verdict, 'fail')
  assert.ok(reported.history.at(-1).note.includes('auth_test'))
})

test('report with status working only updates progress', async () => {
  const { board } = makeBoard()
  const task = board.addTask({ title: 'A' })
  await board.dispatch({ id: task.id })
  const reported = board.report({ id: task.id, status: 'working', summary: '还在改' })
  assert.equal(reported.lane, 'running')
  assert.equal(reported.agent.status, 'working')
})

test('a status done report defaults to a passing verdict', async () => {
  const { board } = makeBoard()
  const task = board.addTask({ title: 'A' })
  const reported = board.report({ id: task.id, status: 'done', summary: 'ok' })
  assert.equal(reported.result.verdict, 'pass')
  assert.equal(reported.lane, 'review')
})

test('syncAgent reflects live agent state and survives a dead session', async () => {
  const agents = fakeAgents()
  const { board } = makeBoard({ agents })
  const task = board.addTask({ title: 'A' })
  const dispatched = await board.dispatch({ id: task.id })

  agents.live.get(dispatched.sessionId).status = 'running'
  assert.equal(board.syncAgent(task.id).agent.status, 'working')
  agents.live.get(dispatched.sessionId).status = 'idle'
  assert.equal(board.syncAgent(task.id).agent.status, 'idle')

  agents.live.delete(dispatched.sessionId)
  const afterDeath = board.syncAgent(task.id)
  assert.equal(afterDeath.agent.status, 'blocked')
  assert.equal(board.syncAgent('missing'), null)
})

test('cancelAgent stops the worker and returns the card to ready', async () => {
  const agents = fakeAgents()
  const { board } = makeBoard({ agents })
  const task = board.addTask({ title: 'A' })
  const dispatched = await board.dispatch({ id: task.id })
  const cancelled = await board.cancelAgent({ id: task.id })
  assert.equal(cancelled.lane, 'ready')
  assert.equal(cancelled.agent.status, 'idle')
  assert.ok(agents.disposed.includes(dispatched.sessionId))
  assert.equal(cancelled.history.at(-1).note, 'worker cancelled')
})

test('board survives a missing store and a missing bus', () => {
  const board = createBoard({})
  const task = board.addTask({ title: 'no infra' })
  assert.equal(task.lane, 'backlog')
  assert.equal(board.snapshot().tasks.length, 1)
  assert.equal(board.onChange(() => {}) instanceof Function, true)
})