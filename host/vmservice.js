/**
 * STUB — owner: dev-vm. Replaced by the real implementation.
 * Dart VM Service RPC client.
 */
export function createVmService() {
  const unavailable = () => {
    throw Object.assign(new Error('vm service module not implemented yet'), { code: 'not-implemented' })
  }
  return {
    connect: unavailable,
    disconnect: async () => {},
    isConnected: () => false,
    call: unavailable,
    subscribe: unavailable,
    snapshot: () => ({ connected: false, runId: null, vmId: null, isolates: [], streams: [], lastError: 'not implemented' }),
    httpProfile: async () => ({ entries: [] }),
    httpRequestDetail: unavailable,
    screenshot: unavailable,
    dumpApp: unavailable,
    frameStats: unavailable,
    evaluateExtension: unavailable,
    dispose: async () => {},
  }
}