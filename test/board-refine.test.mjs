/**
 * AI card refinement: one sentence in, fields rewritten by the agent, applied
 * through the same updateTask path the UI uses.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createBoard } from '../host/board.js'

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

function fakeBus() {
  return { on: () => () => {}, emit: () => {} }
}

function fakeAgents(reply) {
  const created = []
  const sent = []
  let current = reply
  return {
    created,
    sent,
    setReply: (value) => {
      current = value
    },
    async create(request) {
      created.push(request)
      return {
        agent: {
          id: request.sessionId,
          status: 'running',
          session: { deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: current }] }] },
          async followup(message) {
            sent.push(message)
          },
          async whenIdle() {},
        },
        dispose: async () => {},
      }
    },
  }
}

function makeBoard(reply) {
  const agents = fakeAgents(reply)
  const board = createBoard({
    store: fakeStore(),
    bus: fakeBus(),
    logs: { append: () => ({}) },
    settings: { get: () => ({}) },
    ctx: { get: (name) => (name === 'agents' ? agents : undefined) },
    logger: { warn() {}, info() {}, error() {}, debug() {} },
  })
  return { board, agents }
}

test('refine applies only the fields the agent returned', async () => {
  const { board, agents } = makeBoard('{"patch":{"title":"登录页","acceptance":["空密码提示","错误码展示"],"priority":"high"}}')
  const task = board.addTask({ title: '登录', detail: '保持这个详情', acceptance: ['旧的'] })
  const result = await board.refine({ id: task.id, prompt: '标题改一下，补两条验收，优先级调高' })

  assert.equal(result.error, undefined)
  assert.equal(result.task.title, '登录页')
  assert.deepEqual(result.task.acceptance, ['空密码提示', '错误码展示'])
  assert.equal(result.task.priority, 'high')
  assert.equal(result.task.detail, '保持这个详情', 'untouched fields keep their value')
  assert.equal(agents.created.length, 1, 'one ephemeral planning session')
})

test('refine tolerates fences and a "fields" wrapper', async () => {
  const { board } = makeBoard(['Sure:', '```json', '{"fields":{"verify":["flutter analyze","flutter test"]}}', '```'].join('\n'))
  const task = board.addTask({ title: 'x' })
  const result = await board.refine({ id: task.id, prompt: '补验证命令' })
  assert.deepEqual(result.task.verify, ['flutter analyze', 'flutter test'])
})

test('refine ignores illegal fields and a lane it must not set', async () => {
  const { board } = makeBoard('{"patch":{"id":"hacked","createdAt":1,"detail":"新详情","lane":"不存在的泳道"}}')
  const task = board.addTask({ title: 'x' })
  const result = await board.refine({ id: task.id, prompt: '改详情' })
  assert.equal(result.task.id, task.id)
  assert.notEqual(result.task.createdAt, 1)
  assert.equal(result.task.detail, '新详情')
  assert.equal(result.task.lane, 'backlog')
})

test('refine reports a prose-only answer without touching the card', async () => {
  const { board } = makeBoard('这个卡片我觉得还行，不用改。')
  const task = board.addTask({ title: '原样' })
  const result = await board.refine({ id: task.id, prompt: '看看能改啥' })
  assert.equal(result.error.code, 'parse-failed')
  assert.equal(result.task.title, '原样')
  assert.equal(result.raw, '这个卡片我觉得还行，不用改。')
})

test('refine fails closed when the agent service is missing', async () => {
  const board = createBoard({
    store: fakeStore(),
    bus: fakeBus(),
    logs: { append: () => ({}) },
    settings: { get: () => ({}) },
    ctx: { get: () => undefined },
    logger: { warn() {}, info() {}, error() {}, debug() {} },
  })
  const task = board.addTask({ title: 'x' })
  const result = await board.refine({ id: task.id, prompt: '改' })
  assert.equal(result.error.code, 'agents-unavailable')
  assert.equal(result.task.title, 'x')
})

test('refine needs a prompt', async () => {
  const { board } = makeBoard('{"patch":{"title":"不该发生"}}')
  const task = board.addTask({ title: 'x' })
  const result = await board.refine({ id: task.id, prompt: '   ' })
  assert.equal(result.error.code, 'invalid-input')
  assert.equal(result.task.title, 'x')
})

test('refine rejects an unknown card', async () => {
  const { board } = makeBoard('{}')
  await assert.rejects(() => board.refine({ id: 'nope', prompt: '改' }), (error) => error.code === 'not-found')
})