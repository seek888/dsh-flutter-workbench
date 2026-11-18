/* ====================================================================== *
 * 10-shell.js — owner: dev-ui-core
 * WorkbenchApp: header, left rail, page switch, status bar.
 * PLACEHOLDER shell so the panel renders before the real one lands.
 * ====================================================================== */

const PAGES = [
  { id: 'runtime', labelKey: 'nav.runtime', render: (props) => h(RuntimePage, props) },
  { id: 'logs', labelKey: 'nav.logs', render: (props) => h(LogsPage, props) },
  { id: 'network', labelKey: 'nav.network', render: (props) => h(NetworkPage, props) },
  { id: 'board', labelKey: 'nav.board', render: (props) => h(BoardPage, props) },
  { id: 'quality', labelKey: 'nav.quality', render: (props) => h(QualityPage, props) },
  { id: 'settings', labelKey: 'nav.settings', render: (props) => h(SettingsPage, props) },
]

function readStoredPage() {
  try {
    const stored = sessionStorage.getItem('fwb.page')
    return stored !== null && PAGES.some((page) => page.id === stored) ? stored : 'runtime'
  } catch {
    return 'runtime'
  }
}

function WorkbenchApp() {
  const [page, setPage] = React.useState(readStoredPage)
  const state = useApiState()

  const selectPage = React.useCallback((next) => {
    setPage(next)
    try {
      sessionStorage.setItem('fwb.page', next)
    } catch {
      /* private mode */
    }
  }, [])

  React.useEffect(() => {
    if (typeof state?.actions?.refreshAll === 'function') state.actions.refreshAll()
  }, [state])

  const active = PAGES.find((entry) => entry.id === page) ?? PAGES[0]

  return h('div', {
    style: {
      display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
      color: T.text, fontSize: T.fs, fontFamily: T.font, background: T.bg,
    },
  },
    h('style', null, '@keyframes fwb-spin { to { transform: rotate(360deg) } }'),
    h('div', {
      style: {
        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
        borderBottom: `1px solid ${T.border}`, flexShrink: 0,
      },
    },
      h('strong', { style: { fontSize: 14 } }, 'Flutter'),
      h('span', { style: { color: T.textFaint } }, 'workbench'),
      h('div', { style: { flex: 1 } }),
      state?.conn?.ok === false && h('span', { style: { color: T.error } }, t('state.offline')),
      h(Btn, { onClick: () => state?.actions?.refreshAll?.() }, t('common.refresh'))),
    h('div', { style: { display: 'flex', flex: 1, minHeight: 0 } },
      h('nav', {
        style: {
          width: 132, flexShrink: 0, borderRight: `1px solid ${T.border}`,
          display: 'flex', flexDirection: 'column', padding: 6, gap: 2,
        },
      },
        PAGES.map((entry) => h('button', {
          key: entry.id, type: 'button', onClick: () => selectPage(entry.id),
          style: {
            textAlign: 'left', padding: '7px 10px', borderRadius: T.radiusSm,
            border: '1px solid transparent',
            background: entry.id === page ? T.bgInput : 'transparent',
            color: entry.id === page ? T.text : T.textDim,
            cursor: 'pointer', font: 'inherit', fontSize: T.fs,
          },
        }, t(entry.labelKey)))),
      h('main', { style: { flex: 1, minWidth: 0, overflow: 'auto' } },
        active.render({ state }))),
    h('div', {
      style: {
        display: 'flex', gap: 12, padding: '4px 12px', borderTop: `1px solid ${T.border}`,
        color: T.textFaint, fontSize: 11, flexShrink: 0,
      },
    },
      h('span', null, state?.snapshot?.activeRunId ?? '—'),
      h('span', null, `${state?.snapshot?.counters?.logs ?? 0} logs`)))
}