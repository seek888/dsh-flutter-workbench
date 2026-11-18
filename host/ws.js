/**
 * STUB — owner: dev-vm. Replaced by the real implementation.
 * Dependency-free RFC 6455 WebSocket client.
 */
export async function createWebSocketClient({ url }) {
  throw Object.assign(new Error(`websocket client not implemented (${url})`), { code: 'not-implemented' })
}

export default createWebSocketClient