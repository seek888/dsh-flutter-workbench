/**
 * Tool registry tests: the definitions are the agent's only documented surface,
 * so their names, schemas and render functions must stay valid.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createToolDefinitions, mcpToolDescriptors } from '../host/tools.js'
import { createLogStore } from '../host/logs.js'

const baseLogs = createLogStore({ capacity: 50 })
baseLogs.append({ source: 'flutter', level: 'info', text: 'flutter: app started' })
baseLogs.append({ source: 'stderr', level: 'error', text: 'Unhandled exception: boom' })

function fakeServices(extra = {}) {
  return {
    logs: baseLogs,
    projects: {
      list: () => [{ id: 'p1', path: 'C:/app', name: 'app', detected: { ok: true } }],
      activeId: () => 'p1',
      active: () => ({ id: 'p1', path: 'C:/app', name: 'app', detected: { ok: true } }),
      get: (id) => (id === 'p1' ? { id: 'p1', path: 'C:/app', name: 'app' } : null),
      add: async () => ({ id: 'p2' }),
      remove: async () => ({ removed: true }),
      select: async () => 'p1',
      refresh: async () => ({ id: 'p1' }),
      touch: async () => null,
    },
    runner: {
      latestRun: () => ({ runId: 'r1', phase: 'running', device: { name: 'Windows' }, pid: 42 }),
      state: () => ({ runs: [{ runId: 'r1', phase: 'running' }], activeRunId: 'r1' }),
      start: async () => ({ runId: 'r1' }),
      stop: async () => ({ stopped: ['r1'] }),
      hotReload: async () => ({ ok: true, message: 'reloaded' }),
      hotRestart: async () => ({ ok: true, message: 'restarted' }),
    },
    board: {
      snapshot: () => ({ tasks: [], counts: { backlog: 0 } }),
      addTask: async () => ({ id: 't1', lane: 'backlog', title: 'x' }),
      updateTask: async () => ({ id: 't1', lane: 'ready' }),
      moveTask: async () => ({ id: 't1', lane: 'done' }),
      removeTask: async () => ({ removed: true }),
      archiveDone: async () => ({ archived: 0 }),
      decompose: async () => ({ tasks: [], raw: '' }),
      dispatch: async () => ({ sessionId: 's1' }),
      report: async () => ({ id: 't1', lane: 'review', result: { verdict: 'pass' } }),
    },
    network: {
      refresh: async () => ({ added: 0 }),
      query: () => ({ entries: [{ id: 'n1', method: 'GET', uri: 'https://api/x', status: 401, durationMs: 12 }], nextCursor: 1, total: 1 }),
      detail: async () => ({ requestHeaders: {} }),
    },
    errors: {
      query: () => ({ groups: [{ fp: 'abc', count: 2, kind: 'flutter', message: 'boom', frames: [{ file: 'a.dart', line: 3 }] }], nextCursor: 1, total: 1 }),
    },
    settings: { get: () => ({ dataDir: '', defaultModel: '', defaultProvider: '', editorCommand: 'code' }) },
    ...extra,
  }
}

test('definitions expose unique names and valid parameter schemas', () => {
  const definitions = createToolDefinitions({ services: fakeServices() })
  assert.ok(definitions.length >= 20, `expected the full surface, got ${definitions.length}`)
  const names = definitions.map((definition) => definition.name)
  assert.equal(new Set(names).size, names.length, 'tool names must be unique')
  for (const definition of definitions) {
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 10, `${definition.name} needs a real description`)
    assert.equal(typeof definition.execute, 'function')
    assert.equal(definition.parameters.type, 'object', `${definition.name} parameters must be an object schema`)
    assert.equal(typeof definition.output.render, 'function')
  }
})

test('every render function returns content blocks without throwing', () => {
  const definitions = createToolDefinitions({ services: fakeServices() })
  for (const definition of definitions) {
    const blocks = definition.output.render({}, { ok: true })
    assert.ok(Array.isArray(blocks), `${definition.name} render must return blocks`)
    assert.equal(blocks[0].type, 'text')
    assert.equal(typeof blocks[0].text, 'string')
    assert.ok(blocks[0].text.length > 0 || definition.name === 'flutter_network_detail', `${definition.name} rendered empty text`)
  }
})

test('mcpToolDescriptors mirror the definitions', () => {
  const definitions = createToolDefinitions({ services: fakeServices() })
  const descriptors = mcpToolDescriptors(definitions)
  assert.equal(descriptors.length, definitions.length)
  assert.deepEqual(Object.keys(descriptors[0]).sort(), ['description', 'inputSchema', 'name'])
})

test('log tool filters by level and returns a cursor', async () => {
  const definitions = createToolDefinitions({ services: fakeServices() })
  const tool = definitions.find((definition) => definition.name === 'flutter_logs')
  const result = await tool.execute({ level: 'error', limit: 10 })
  assert.equal(result.ok, true)
  assert.equal(result.entries.length, 1)
  assert.equal(result.entries[0].level, 'error')
  assert.ok(result.nextCursor >= 2)
})

test('status tool survives missing optional services', async () => {
  const definitions = createToolDefinitions({ services: { logs: baseLogs } })
  const tool = definitions.find((definition) => definition.name === 'flutter_status')
  const result = await tool.execute({})
  assert.equal(result.ok, true)
  assert.equal(result.project, null)
  assert.equal(typeof result.counters.logs, 'number')
})

test('run tool reports a missing project instead of crashing', async () => {
  const definitions = createToolDefinitions({ services: fakeServices({ projects: undefined }) })
  const tool = definitions.find((definition) => definition.name === 'flutter_run')
  await assert.rejects(() => tool.execute({}), (error) => error.code === 'unavailable')
})