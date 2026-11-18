/**
 * Unit tests for the MCP JSON-RPC server.
 *
 * No HTTP server, no network: every message goes straight through
 * `handleJsonRpc`. `services` is a fake (only `settings.mcpToken` is read here).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createMcpServer, SERVER_NAME, SUPPORTED_PROTOCOLS } from '../host/mcp.js'

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }

function createServices(mcpToken = 'test-token') {
  return { settings: { get: () => ({ mcpToken }) } }
}

/** Three ToolDefs shaped exactly as docs/CONTRACTS.md §5.8 declares them. */
function createDefinitions() {
  return [
    {
      name: 'demo_echo',
      description: 'echo the argument back',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      output: { schema: { type: 'object' }, render: (args, value) => `echo:${value.text}` },
      execute: async (args) => ({ text: args.text }),
    },
    {
      name: 'demo_object',
      description: 'return a plain object (JSON-stringified)',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ ok: true, items: [1, 2, 3] }),
    },
    {
      name: 'demo_fail',
      description: 'always throws',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        throw Object.assign(new Error('boom'), { code: 'toolchain-missing' })
      },
    },
    {
      name: 'demo_not_executable',
      description: 'no execute()',
      parameters: { type: 'object', properties: {} },
    },
  ]
}

function createServer(options = {}) {
  return createMcpServer({ services: createServices(), logger: silentLogger, version: '1.2.3', ...options })
}

test('an empty registry still answers tools/list with an empty array', async () => {
  const server = createServer({ definitions: [] })
  assert.deepEqual(server.tools, [])
  const listed = await server.handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  assert.deepEqual(listed.result, { tools: [] })
  const called = await server.handleJsonRpc({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'flutter_status' },
  })
  assert.equal(called.error.code, -32601)
  assert.match(called.error.message, /no tools are registered yet/)
})

test('tool descriptors derive from host/tools.js (the single source of truth)', async () => {
  const server = createServer()
  const names = server.tools.map((item) => item.name)
  assert.ok(server.tools.length > 0, 'expected the real host/tools.js registry')
  for (const expected of ['flutter_status', 'flutter_run', 'flutter_logs', 'flutter_tasks', 'flutter_task_report']) {
    assert.ok(names.includes(expected), `missing tool ${expected}`)
  }
  const listed = await server.handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  assert.equal(listed.result.tools.length, server.tools.length)
  const status = listed.result.tools.find((item) => item.name === 'flutter_status')
  assert.equal(status.inputSchema.type, 'object')
  assert.ok(status.description.length > 0)
})

test('initialize echoes a supported protocolVersion and advertises tools', async () => {
  const server = createServer()
  for (const protocolVersion of SUPPORTED_PROTOCOLS) {
    const response = await server.handleJsonRpc({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion } })
    assert.equal(response.id, 'init')
    assert.equal(response.result.protocolVersion, protocolVersion)
    assert.equal(response.result.serverInfo.name, SERVER_NAME)
    assert.equal(response.result.serverInfo.version, '1.2.3')
    assert.equal(typeof response.result.capabilities.tools, 'object')
    assert.equal(typeof response.result.instructions, 'string')
  }
})

test('initialize falls back to the default protocol for an unknown revision', async () => {
  const server = createServer()
  const response = await server.handleJsonRpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '1999-01-01' },
  })
  assert.equal(response.result.protocolVersion, '2025-06-18')
})

test('notifications are never answered', async () => {
  const server = createServer()
  assert.equal(await server.handleJsonRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }), null)
  assert.equal(await server.handleJsonRpc({ jsonrpc: '2.0', method: 'notifications/whatever' }), null)
  assert.equal(await server.handleJsonRpc({ jsonrpc: '2.0', id: 7, method: 'notifications/initialized' }), null)
})

test('ping answers with an empty result and echoes the id', async () => {
  const server = createServer()
  const response = await server.handleJsonRpc({ jsonrpc: '2.0', id: 42, method: 'ping' })
  assert.deepEqual(response, { jsonrpc: '2.0', id: 42, result: {} })
})

test('unknown methods answer -32601 and invalid requests -32600', async () => {
  const server = createServer()
  const unknown = await server.handleJsonRpc({ jsonrpc: '2.0', id: 3, method: 'nope/at/all' })
  assert.equal(unknown.error.code, -32601)
  const notObject = await server.handleJsonRpc('hello')
  assert.equal(notObject.error.code, -32600)
  const noMethod = await server.handleJsonRpc({ jsonrpc: '2.0', id: 4 })
  assert.equal(noMethod.error.code, -32600)
  const wrongVersion = await server.handleJsonRpc({ jsonrpc: '1.0', id: 5, method: 'ping' })
  assert.equal(wrongVersion.error.code, -32600)
})

test('resources/list and prompts/list degrade to empty lists', async () => {
  const server = createServer()
  const resources = await server.handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'resources/list' })
  assert.deepEqual(resources.result, { resources: [] })
  const prompts = await server.handleJsonRpc({ jsonrpc: '2.0', id: 2, method: 'prompts/list' })
  assert.deepEqual(prompts.result, { prompts: [] })
})

test('batch requests answer as an array and skip notifications', async () => {
  const server = createServer()
  const response = await server.handleJsonRpc([
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', id: 2, method: 'nope' },
  ])
  assert.equal(Array.isArray(response), true)
  assert.equal(response.length, 2)
  assert.equal(response[0].id, 1)
  assert.equal(response[1].error.code, -32601)
  const silent = await server.handleJsonRpc([{ jsonrpc: '2.0', method: 'notifications/initialized' }])
  assert.equal(silent, null)
  const empty = await server.handleJsonRpc([])
  assert.equal(empty.error.code, -32600)
})

test('tool descriptors come from the ToolDef registry', async () => {
  const server = createServer({ definitions: createDefinitions() })
  assert.deepEqual(
    server.tools.map((item) => item.name),
    ['demo_echo', 'demo_object', 'demo_fail', 'demo_not_executable'],
  )
  const descriptor = server.tools[0]
  assert.equal(descriptor.description, 'echo the argument back')
  assert.deepEqual(descriptor.inputSchema, { type: 'object', properties: { text: { type: 'string' } } })
  const listed = await server.handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  assert.equal(listed.result.tools.length, 4)
  assert.equal(server.info().toolCount, 4)
  assert.equal(server.info().version, '1.2.3')
})

test('tools/call runs the ToolDef and renders its output', async () => {
  const server = createServer({ definitions: createDefinitions() })
  const echoed = await server.handleJsonRpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'demo_echo', arguments: { text: 'hi' } },
  })
  assert.equal(echoed.result.isError, undefined)
  assert.deepEqual(echoed.result.content, [{ type: 'text', text: 'echo:hi' }])

  const asJson = await server.handleJsonRpc({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'demo_object' },
  })
  assert.equal(asJson.result.content.length, 1)
  assert.equal(asJson.result.content[0].type, 'text')
  assert.deepEqual(JSON.parse(asJson.result.content[0].text), { ok: true, items: [1, 2, 3] })
})

test('tools/call turns a thrown error into isError with the message', async () => {
  const server = createServer({ definitions: createDefinitions() })
  const failed = await server.handleJsonRpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'demo_fail' },
  })
  assert.equal(failed.result.isError, true)
  assert.equal(failed.result.content[0].type, 'text')
  assert.match(failed.result.content[0].text, /boom/)
  assert.match(failed.result.content[0].text, /toolchain-missing/)
})

test('tools/call rejects unknown and non-executable tools', async () => {
  const server = createServer({ definitions: createDefinitions() })
  const unknown = await server.handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope' } })
  assert.equal(unknown.error.code, -32601)
  const missingName = await server.handleJsonRpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} })
  assert.equal(missingName.error.code, -32602)
  const noExecute = await server.handleJsonRpc({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'demo_not_executable' },
  })
  assert.equal(noExecute.error.code, -32603)
})

test('a wrong bearer token is rejected, the right one is accepted', async () => {
  const server = createServer({ definitions: createDefinitions() })
  const denied = await server.handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { token: 'wrong' })
  assert.equal(denied.error.code, -32001)
  const allowed = await server.handleJsonRpc({ jsonrpc: '2.0', id: 2, method: 'ping' }, { token: 'test-token' })
  assert.deepEqual(allowed.result, {})
  // No token at all means the transport already authenticated the caller.
  const untokened = await server.handleJsonRpc({ jsonrpc: '2.0', id: 3, method: 'ping' })
  assert.deepEqual(untokened.result, {})
  const batch = await server.handleJsonRpc([{ jsonrpc: '2.0', id: 4, method: 'ping' }], { token: 'wrong' })
  assert.equal(batch[0].error.code, -32001)
})

test('a lazily built tool registry is awaited before listing', async () => {
  const definitions = createDefinitions()
  // Simulate host/tools.js returning a promise for its registry.
  const server = createMcpServer({
    services: createServices(),
    logger: silentLogger,
    version: '1.2.3',
    definitions: definitions.slice(0, 1),
  })
  const listed = await server.handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  assert.equal(listed.result.tools.length, 1)
  assert.equal(listed.result.tools[0].name, 'demo_echo')
})

test('info() reports the server identity and the tool count', () => {
  const server = createServer({ definitions: createDefinitions() })
  const info = server.info()
  assert.equal(info.name, SERVER_NAME)
  assert.equal(info.version, '1.2.3')
  assert.equal(info.toolCount, 4)
  assert.deepEqual(info.protocolVersions, [...SUPPORTED_PROTOCOLS])
  assert.deepEqual(info.tools, ['demo_echo', 'demo_object', 'demo_fail', 'demo_not_executable'])
})