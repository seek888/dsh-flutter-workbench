/**
 * STUB — owner: dev-vm. Replaced by the real implementation.
 * Network request store fed by the VM Service HTTP profile.
 */
export function createNetworkStore() {
  return {
    refresh: async () => ({ added: 0 }),
    query: () => ({ entries: [], nextCursor: 0, total: 0 }),
    detail: async () => {
      throw Object.assign(new Error('network module not implemented yet'), { code: 'not-implemented' })
    },
    clear: () => {},
    startAutoRefresh: () => {},
    dispose: () => {},
  }
}