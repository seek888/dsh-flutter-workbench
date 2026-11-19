/**
 * Background board planning routes: POST /board/plan and POST /board/refine
 * answer with a job id immediately and the work happens behind it.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { ROUTE_PREFIX, createHttpApi } from '../host/httpapi.js'

const TOKEN = 'test-token'

function makeApi(boardOverrides = {}) {
  const jobs = []
  const board = {
    calls: [],
    async decompose(input) {
      this.calls.push(['decompose', input])
      return { tasks: [{ id: 't1', title: 'A', lane: 'backlog' }, { id: 't2', title: 'B', lane: 'backlog' }] }
    },
    async refine(input) {
      this.calls.push(['refine', input])
      return { task: { id: input.id, title: '改好了', lane: 'backlog' } }
    },
    ...boardOverrides,
  }
  const server = { routes: [], register(route) { this.routes.push(route); return () => {} } }
  const ctx = {
    get(name) {
      if (name === 'webServer') return server
      if (name === 'connection') return { requestRejection: () => undefined }
      if (name === 'agents') return { get: () => undefined }
      return undefined
    },
  }
  const services = { board, settings: { get: () => ({ mcpToken: TOKEN, mcpEnabled: true }) } }
  const api = createHttpApi({ ctx, services, logger: { warn() {}, error() {}, info() {} } })
  return { api, board, jobs }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

test('POST /board/plan starts a job and finishes with the created cards', async () => {
  const { api, board } = makeApi()
  const started = await api.handle({
    method: 'POST',
    path: `${ROUTE_PREFIX}/board/plan`,
    query: {},
    headers: {},
    body: { prompt: '做一个登录页', projectId: 'proj-1', maxTasks: 4 },
  })
  assert.equal(started.status, 200)
  assert.equal(started.body.ok, true)
  assert.equal(typeof started.body.jobId, 'string')
  assert.equal(started.body.status, 'running', 'the panel must not block on the agent')

  await settle()
  const done = await api.handle({ method: 'GET', path: `${ROUTE_PREFIX}/job`, query: { id: started.body.jobId }, headers: {} })
  assert.equal(done.status, 200)
  assert.equal(done.body.job.status, 'done')
  assert.equal(done.body.job.result.tasks.length, 2)
  assert.deepEqual(board.calls[0], ['decompose', { prompt: '做一个登录页', projectId: 'proj-1', maxTasks: 4 }])
})

test('POST /board/plan needs a prompt', async () => {
  const { api } = makeApi()
  const result = await api.handle({ method: 'POST', path: `${ROUTE_PREFIX}/board/plan`, query: {}, headers: {}, body: {} })
  assert.equal(result.status, 400)
  assert.equal(result.body.ok, false)
})

test('a failing plan job records the error instead of hanging', async () => {
  const { api } = makeApi({ async decompose() { throw Object.assign(new Error('agents unavailable'), { code: 'agents-unavailable' }) } })
  const started = await api.handle({ method: 'POST', path: `${ROUTE_PREFIX}/board/plan`, query: {}, headers: {}, body: { prompt: 'x' } })
  await settle()
  const done = await api.handle({ method: 'GET', path: `${ROUTE_PREFIX}/job`, query: { id: started.body.jobId }, headers: {} })
  assert.equal(done.body.job.status, 'failed')
  assert.equal(done.body.job.error.code, 'agents-unavailable')
})

test('POST /board/refine starts a job that returns the rewritten card', async () => {
  const { api } = makeApi()
  const started = await api.handle({
    method: 'POST',
    path: `${ROUTE_PREFIX}/board/refine`,
    query: {},
    headers: {},
    body: { id: 't1', prompt: '补验收标准' },
  })
  assert.equal(started.status, 200)
  await settle()
  const done = await api.handle({ method: 'GET', path: `${ROUTE_PREFIX}/job`, query: { id: started.body.jobId }, headers: {} })
  assert.equal(done.body.job.status, 'done')
  assert.equal(done.body.job.result.task.title, '改好了')
})

test('POST /board/refine validates its inputs', async () => {
  const { api } = makeApi()
  const missingId = await api.handle({ method: 'POST', path: `${ROUTE_PREFIX}/board/refine`, query: {}, headers: {}, body: { prompt: 'x' } })
  assert.equal(missingId.status, 400)
  const missingPrompt = await api.handle({ method: 'POST', path: `${ROUTE_PREFIX}/board/refine`, query: {}, headers: {}, body: { id: 't1' } })
  assert.equal(missingPrompt.status, 400)
})