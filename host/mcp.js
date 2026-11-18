/**
 * MCP (Model Context Protocol) server for the Flutter workbench.
 *
 * Transport-agnostic JSON-RPC 2.0: the HTTP layer owns sockets, auth and status
 * codes; this module owns message semantics. Tools are not declared here — the
 * single source of truth is `host/tools.js` (`createToolDefinitions` /
 * `mcpToolDescriptors`), so a DSH tool and an MCP tool are always the same tool.
 *
 * Implemented methods: `initialize`, `notifications/initialized`, `ping`,
 * `tools/list`, `tools/call`, `resources/list` (empty), `prompts/list` (empty).
 *
 * @module host/mcp
 */
import { createToolDefinitions, mcpToolDescriptors } from './tools.js'
import { normalizeError } from './util.js'

/** Protocol revisions this server can answer; the first one is the default. */
export const SUPPORTED_PROTOCOLS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05'])

/** Server identity advertised in `initialize`. */
export const SERVER_NAME = 'dsh-flutter-workbench'

const INSTRUCTIONS = [
  'Drives a local Flutter client-dev workbench: run/stop projects, hot reload and',
  'restart, read structured logs, inspect VM-service HTTP traffic, deduped exceptions,',
  'analyzer/test results, screenshots and an agent-driven kanban board.',
  'Call flutter_status first: it reports the project, run phase, device and VM URI.',
].join(' ')

const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603
/** MCP-specific: the bearer token presented to the HTTP layer is not valid. */
const UNAUTHORIZED = -32001

function responseOf(id, result) {
  return { jsonrpc: '2.0', id: id ?? null, result }
}

function errorOf(id, code, message, data) {
  const error = { code, message }
  if (data !== undefined) error.data = data
  return { jsonrpc: '2.0', id: id ?? null, error }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Array.isArray(value) === false
}

/**
 * Build the MCP server.
 *
 * @param {object} options
 * @param {object} [options.services] workbench services (settings, board, …).
 * @param {any} [options.logger] logger with debug/info/warn/error.
 * @param {string} [options.version] bundle version advertised in `serverInfo`.
 * @param {any[]} [options.definitions] test seam: overrides `host/tools.js`
 *   (production always derives the registry from tools.js).
 * @returns {{
 *   handleJsonRpc: (body: any, options?: { token?: string }) => Promise<any>,
 *   tools: { name: string, description: string, inputSchema: object }[],
 *   info: () => { name: string, version: string, toolCount: number, protocolVersions: string[] },
 * }}
 */
export function createMcpServer(options = {}) {
  const services = options.services ?? {}
  const logger = options.logger
  const version = typeof options.version === 'string' && options.version !== '' ? options.version : '0.0.0'

  /** @type {any[]} */
  let definitions = []
  /** @type {Promise<any[]> | null} */
  let pending = null
  /** @type {{ name: string, description: string, inputSchema: object }[]} */
  let descriptors = []

  /**
   * Map ToolDefs to MCP descriptors through `host/tools.js`. When that module is
   * still a stub (no descriptors) but definitions exist, fall back to the
   * documented ToolDef shape so the server stays usable.
   */
  function describe(list) {
    const mapped = []
    if (typeof mcpToolDescriptors === 'function') {
      try {
        const value = mcpToolDescriptors(list)
        if (Array.isArray(value)) {
          for (const item of value) if (isPlainObject(item) && typeof item.name === 'string') mapped.push(item)
        }
      } catch (error) {
        logger?.warn?.(`mcp: mcpToolDescriptors failed: ${normalizeError(error).message}`)
      }
    }
    if (mapped.length > 0 || list.length === 0) return mapped
    return list
      .filter((def) => isPlainObject(def) && typeof def.name === 'string')
      .map((def) => ({
        name: def.name,
        description: typeof def.description === 'string' ? def.description : '',
        inputSchema: isPlainObject(def.parameters) ? def.parameters : { type: 'object', properties: {} },
      }))
  }

  function adopt(list) {
    definitions = list.filter((def) => isPlainObject(def) && typeof def.name === 'string')
    descriptors = describe(definitions)
  }

  if (Array.isArray(options.definitions)) {
    adopt(options.definitions)
  } else {
    try {
      const value = createToolDefinitions({ services, logger })
      if (value !== null && typeof value?.then === 'function') {
        pending = Promise.resolve(value)
          .then((resolved) => (Array.isArray(resolved) ? resolved : []))
          .catch((error) => {
            logger?.warn?.(`mcp: tool definitions unavailable: ${normalizeError(error).message}`)
            return []
          })
      } else if (Array.isArray(value)) {
        adopt(value)
      }
    } catch (error) {
      logger?.warn?.(`mcp: tool definitions unavailable: ${normalizeError(error).message}`)
    }
  }

  /** Resolve a lazily-built tool registry before the first list/call. */
  async function ready() {
    if (pending === null) return
    const list = await pending
    pending = null
    adopt(Array.isArray(list) ? list : [])
  }

  /**
   * Render a tool result as MCP content blocks. A ToolDef may either return a
   * plain string from `output.render(args, value)` or — as `host/tools.js`
   * does — return ready-made `[{ type: 'text', text }]` blocks. Anything else
   * is JSON-stringified.
   */
  function renderContent(def, args, value) {
    const render = def?.output?.render
    if (typeof render === 'function') {
      try {
        const rendered = render(args, value)
        if (typeof rendered === 'string' && rendered !== '') return [{ type: 'text', text: rendered }]
        if (Array.isArray(rendered)) {
          const blocks = rendered.filter(
            (block) => isPlainObject(block) && block.type === 'text' && typeof block.text === 'string',
          )
          if (blocks.length > 0) return blocks
        }
      } catch (error) {
        logger?.warn?.(`mcp: render(${def?.name}) failed: ${normalizeError(error).message}`)
      }
    }
    if (typeof value === 'string') return [{ type: 'text', text: value }]
    if (value === undefined) return [{ type: 'text', text: 'null' }]
    try {
      return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    } catch {
      return [{ type: 'text', text: String(value) }]
    }
  }

  /** `tools/call` — unknown or missing tools answer -32601; tool failures are isError. */
  async function callTool(id, params) {
    await ready()
    const name = typeof params?.name === 'string' ? params.name : ''
    if (name === '') return errorOf(id, INVALID_PARAMS, 'tools/call requires a tool name')
    const def = definitions.find((item) => item.name === name)
    if (def === undefined) {
      return errorOf(id, METHOD_NOT_FOUND, `unknown tool: ${name}${definitions.length === 0 ? ' (no tools are registered yet)' : ''}`)
    }
    const execute = def.execute ?? def.run ?? def.handler
    if (typeof execute !== 'function') return errorOf(id, INTERNAL_ERROR, `tool ${name} has no execute() function`)
    const args = isPlainObject(params?.arguments) ? params.arguments : {}
    let value
    try {
      value = await execute(args)
    } catch (error) {
      const normalized = normalizeError(error)
      logger?.warn?.(`mcp: tool ${name} failed: ${normalized.message}`)
      const text = normalized.code === 'error' ? normalized.message : `${normalized.message} [${normalized.code}]`
      return responseOf(id, { content: [{ type: 'text', text }], isError: true })
    }
    return responseOf(id, { content: renderContent(def, args, value) })
  }

  function initializeResult(params) {
    const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : ''
    return {
      protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
      capabilities: {
        tools: { listChanged: false },
        resources: {},
        prompts: {},
      },
      serverInfo: { name: SERVER_NAME, version },
      instructions: INSTRUCTIONS,
    }
  }

  /** Does the caller's token match the plugin's `settings.mcpToken`? */
  function authorized(token) {
    if (token === undefined || token === null) return true // auth already enforced by the HTTP layer
    const settings = services?.settings
    const expected = typeof settings?.get === 'function' ? String(settings.get()?.mcpToken ?? '') : ''
    return expected !== '' && String(token) === expected
  }

  /** Answer one JSON-RPC message; returns `null` for notifications. */
  async function handleMessage(message, allow) {
    if (isPlainObject(message) === false) {
      return errorOf(null, INVALID_REQUEST, 'invalid request: expected a JSON-RPC object')
    }
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id') && message.id !== undefined
    const id = hasId ? message.id : null
    if (hasId === false) {
      // A notification is never answered; unknown ones are simply ignored.
      return null
    }
    if (allow === false) return errorOf(id, UNAUTHORIZED, 'invalid MCP token')
    const method = typeof message.method === 'string' ? message.method : ''
    if (method === '') return errorOf(id, INVALID_REQUEST, 'invalid request: missing method')
    if (message.jsonrpc !== undefined && message.jsonrpc !== '2.0') {
      return errorOf(id, INVALID_REQUEST, 'invalid request: jsonrpc must be "2.0"')
    }
    try {
      switch (method) {
        case 'initialize':
          return responseOf(id, initializeResult(message.params))
        case 'notifications/initialized':
        case 'notifications/cancelled':
        case 'notifications/progress':
          return null
        case 'ping':
          return responseOf(id, {})
        case 'tools/list':
          await ready()
          return responseOf(id, { tools: descriptors })
        case 'tools/call':
          return await callTool(id, message.params)
        case 'resources/list':
          return responseOf(id, { resources: [] })
        case 'resources/templates/list':
          return responseOf(id, { resourceTemplates: [] })
        case 'prompts/list':
          return responseOf(id, { prompts: [] })
        default:
          return errorOf(id, METHOD_NOT_FOUND, `method not found: ${method}`)
      }
    } catch (error) {
      const normalized = normalizeError(error)
      logger?.error?.(`mcp: ${method} failed: ${normalized.message}`)
      return errorOf(id, INTERNAL_ERROR, normalized.message, normalized.code)
    }
  }

  /**
   * Dispatch a parsed JSON-RPC payload (single message or batch array).
   *
   * @param {any} body parsed JSON body.
   * @param {{ token?: string }} [options] bearer token, when the transport enforces one.
   * @returns {Promise<object | object[] | null>} response, batch response, or
   *   `null` when every message was a notification.
   */
  async function handleJsonRpc(body, options = {}) {
    await ready()
    const allow = authorized(options?.token)
    if (Array.isArray(body)) {
      if (body.length === 0) return errorOf(null, INVALID_REQUEST, 'invalid request: empty batch')
      const out = []
      for (const message of body) {
        const result = await handleMessage(message, allow)
        if (result !== null) out.push(result)
      }
      return out.length === 0 ? null : out
    }
    return handleMessage(body, allow)
  }

  return {
    handleJsonRpc,
    get tools() {
      return descriptors
    },
    info() {
      return {
        name: SERVER_NAME,
        version,
        toolCount: descriptors.length,
        protocolVersions: [...SUPPORTED_PROTOCOLS],
        tools: descriptors.map((item) => item.name),
      }
    },
  }
}