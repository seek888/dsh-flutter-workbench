/* ====================================================================== *
 * 20-runtime.js — owner: dev-ui-core
 * RuntimePage: project/config/device pickers, run controls, live status.
 * PLACEHOLDER: replace with the real implementation per docs/CONTRACTS.md §8.2.
 * ====================================================================== */

function RuntimePage({ state }) {
  return h(PageStub, { name: t('nav.runtime') })
}

/** Shared application state + actions (contract §8.2). PLACEHOLDER. */
function useApiState() {
  const snapshot = usePoll(() => api('/state'), 2000)
  const [toast, setToast] = React.useState(null)

  const actions = React.useMemo(() => ({
    refreshAll: () => snapshot.refresh(),
    toast: (message, tone) => setToast({ message: String(message ?? ''), tone: tone ?? 'info' }),
  }), [snapshot])

  return {
    snapshot: snapshot.data,
    conn: { ok: snapshot.error === null && snapshot.data !== null, error: snapshot.error },
    toast,
    actions,
  }
}