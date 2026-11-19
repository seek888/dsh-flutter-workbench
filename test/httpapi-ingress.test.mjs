/**
 * Ingress tests: the alias route outside `/api`, the MCP token gate, and the
 * connection fence. These lock the behaviour that a DSH restart must preserve,
 * so the alias cannot silently stop registering.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { ALT_PREFIX, MCP_PATH, ROUTE_PREFIX, createHttpApi, resolveAliasPath } from '../host/httpapi.js'

const TOKEN = 'test-token-0123456789'

function fakeServer() {
  const routes = []
  return {
    routes,
    register(route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index !== -1) routes.splice(index, 1)
      }
    },
  }
}

function fakeCtx(overrides = {}) {
  const server = overrides.server ?? fakeServer()
  const settings = overrides.settings ?? { get: () => ({ mcpToken: TOKEN, mcpEnabled: true }) }
  const connection = overrides.connection ?? { requestRejection: () => undefined }
  const calls = { jsonRpc: [] }
  const services = {
    settings,
    logs: { mark: (text) => ({ seq: 7, text }) },
    mcp: {
      info: () => ({ name: 'dsh-flutter-workbench', version: '1.0.0', toolCount: 24 }),
      handleJsonRpc: async (body) => {
        calls.jsonRpc.push(body)
        return { jsonrpc: '2.0', id: body?.id ?? null, result: { ok: true } }
      },
    },
    ...overrides.services,
  }
  const registry = { webServer: server, settings, connection, ...(overrides.registry ?? {}) }
  const ctx = {
    get(name) {
      return registry[name]
    },
  }
  return { ctx, server, services, calls }
}

function makeApi(overrides = {}) {
  const fake = fakeCtx(overrides)
  const api = createHttpApi({ ctx: fake.ctx, services: fake.services, logger: { warn() {}, error() {}, info() {} } })
  return { ...fake, api }
}

test('alias paths rewrite onto the real prefix and never shadow other routes', () => {
  assert.equal(resolveAliasPath(`${ALT_PREFIX}/mcp`), MCP_PATH)
  assert.equal(resolveAliasPath(ALT_PREFIX), ROUTE_PREFIX)
  assert.equal(resolveAliasPath(`${ALT_PREFIX}/state`), `${ROUTE_PREFIX}/state`)
  assert.equal(resolveAliasPath(ROUTE_PREFIX + '/mcp'), MCP_PATH)
  assert.equal(resolveAliasPath('/'), '/')
  assert.equal(resolveAliasPath('/api/daily-work/state'), '/api/daily-work/state')
  assert.equal(resolveAliasPath(undefined), '')
  // A prefix whose first segment only LOOKS similar must not be rewritten.
  assert.equal(resolveAliasPath(`${ALT_PREFIX}-extra/mcp`), `${ALT_PREFIX}-extra/mcp`)
})

test('attach registers both the /api route and the alias route', () => {
  const { api, server } = makeApi()
  api.attach()
  const paths = server.routes.map((route) => `${route.kind}:${route.path}`).sort()
  assert.deepEqual(paths, [`prefix:${ROUTE_PREFIX}`, `prefix:${ALT_PREFIX}`].sort())
  for (const route of server.routes) assert.equal(typeof route.handler, 'function')
})

test('dispose removes both routes and is idempotent', () => {
  const { api, server } = makeApi()
  const dispose = api.attach()
  assert.equal(server.routes.length, 2)
  dispose()
  assert.equal(server.routes.length, 0)
  dispose()
  assert.equal(server.routes.length, 0)
})

test('the MCP path authenticates with the plugin token, not the DSH cookie', async () => {
  const { api, calls } = makeApi()
  const ok = await api.handle({
    method: 'POST',
    path: MCP_PATH,
    query: {},
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  })
  assert.equal(ok.status, 200)
  assert.equal(calls.jsonRpc.length, 1, 'the MCP server handled the request')
})

test('a missing or wrong MCP token is a 401 JSON body, never a plain gateway answer', async () => {
  const { api } = makeApi()
  for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: 'Bearer ' }]) {
    const result = await api.handle({ method: 'POST', path: MCP_PATH, query: {}, headers, body: { jsonrpc: '2.0', id: 1, method: 'ping' } })
    assert.equal(result.status, 401)
    assert.equal(result.body.ok, false)
    assert.equal(result.body.code, 'unauthenticated')
    assert.equal(typeof result.body.message, 'string')
  }
})

test('?token= is accepted as well as the bearer header', async () => {
  const { api } = makeApi()
  const result = await api.handle({ method: 'POST', path: MCP_PATH, query: { token: TOKEN }, headers: {}, body: { jsonrpc: '2.0', id: 1, method: 'ping' } })
  assert.equal(result.status, 200)
})

test('a disabled MCP switch answers 403', async () => {
  const { api } = makeApi({ settings: { get: () => ({ mcpToken: TOKEN, mcpEnabled: false }) } })
  const result = await api.handle({ method: 'POST', path: MCP_PATH, query: {}, headers: { authorization: `Bearer ${TOKEN}` }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } })
  assert.equal(result.status, 403)
  assert.equal(result.body.code, 'mcp-disabled')
})

test('non-MCP paths stay behind the DSH connection fence', async () => {
  const { api } = makeApi({ connection: { requestRejection: () => 401 } })
  const result = await api.handle({ method: 'GET', path: `${ROUTE_PREFIX}/health`, query: {}, headers: {} })
  assert.equal(result.status, 401)
  assert.equal(result.body.code, 'unauthenticated')
})

test('an unknown path under the prefix is a JSON 404', async () => {
  const { api } = makeApi()
  const result = await api.handle({ method: 'GET', path: `${ROUTE_PREFIX}/nope`, query: {}, headers: {} })
  assert.equal(result.status, 404)
  assert.equal(result.body.ok, false)
})

test('POST /logs/mark returns the marker sequence', async () => {
  const { api } = makeApi()
  const result = await api.handle({ method: 'POST', path: `${ROUTE_PREFIX}/logs/mark`, query: {}, headers: {}, body: { text: 'before reload' } })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.seq, 7)
})