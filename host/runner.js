/**
 * STUB — owner: dev-runner. Replaced by the real implementation.
 * Flutter process lifecycle + machine protocol.
 */
export function createRunner() {
  const unavailable = () => {
    throw Object.assign(new Error('runner module not implemented yet'), { code: 'not-implemented' })
  }
  return {
    start: unavailable,
    stop: async () => ({ stopped: [] }),
    hotReload: unavailable,
    hotRestart: unavailable,
    state: () => ({ runs: [], activeRunId: null }),
    latestRun: () => null,
    dispose: async () => {},
  }
}