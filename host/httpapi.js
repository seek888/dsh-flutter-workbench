/**
 * STUB — owner: dev-api. Replaced by the real implementation.
 * HTTP surface: one prefix route serving /state, /logs, /board, /mcp …
 */
export const ROUTE_PREFIX = '/api/flutter-workbench'
export const MCP_PATH = '/api/flutter-workbench/mcp'

export function createHttpApi() {
  return {
    ROUTE_PREFIX,
    MCP_PATH,
    async handle({ path }) {
      return { status: 501, body: { ok: false, code: 'not-implemented', message: `HTTP API not implemented yet (${path})` } }
    },
    attach() {
      return () => {}
    },
    dispose() {},
  }
}