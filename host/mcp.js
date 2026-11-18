/**
 * STUB — owner: dev-api. Replaced by the real implementation.
 * MCP JSON-RPC server (initialize / tools/list / tools/call).
 */
export function createMcpServer() {
  return {
    async handleJsonRpc() {
      return { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'MCP server not implemented yet' } }
    },
    tools: [],
    info: () => ({ name: 'dsh-flutter-workbench', version: '0.0.0', toolCount: 0, implemented: false }),
  }
}