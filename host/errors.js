/**
 * STUB — owner: dev-vm. Replaced by the real implementation.
 * Deduped exception aggregation.
 */
export function createErrorStore() {
  return {
    ingest: () => null,
    ingestCapture: () => {},
    query: () => ({ groups: [], nextCursor: 0, total: 0 }),
    clear: () => {},
    dispose: () => {},
  }
}