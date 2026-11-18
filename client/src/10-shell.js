/* ====================================================================== *
 * 10-shell.js — owner: dev-ui-core
 *
 * WorkbenchApp: the registered `main` panel. Header (project switcher, run
 * phase + controls, device chip, DevTools link, connection indicator), left
 * rail with per-page counts, a scrollable content area that renders one page
 * component, a command palette (Ctrl/Cmd+K) and a status bar.
 *
 * Page components are *called*, never defined here: RuntimePage and LogsPage
 * live in 20/30, NetworkPage / BoardPage / QualityPage / SettingsPage belong
 * to 40/50/60. Every reference is resolved behind a `typeof` guard so a
 * missing fragment renders a fallback instead of blanking the panel.
 * ====================================================================== */

/** Nav entries. `badge` names a counter slot from useApiState().counters. */
const FWB_PAGES = [
  { id: 'runtime', labelKey: 'nav.runtime', icon: 'runtime', badge: null },
  { id: 'logs', labelKey: 'nav.logs', icon: 'logs', badge: 'logs' },
  { id: 'network', labelKey: 'nav.network', icon: 'network', badge: 'network' },
  { id: 'board', labelKey: 'nav.board', icon: 'board', badge: 'tasks' },
  { id: 'quality', labelKey: 'nav.quality', icon: 'quality', badge: 'errors' },
  { id: 'settings', labelKey: 'nav.settings', icon: 'gear', badge: null },
]

/**
 * Lazy page resolution. Each entry is a thunk so `typeof` guards the identifier
 * at call time — a fragment that is not in the bundle yields null, not a
 * ReferenceError.
 */
const FWB_PAGE_COMPONENTS = {
  runtime: () => (typeof RuntimePage === 'function' ? RuntimePage : null),
  logs: () => (typeof LogsPage === 'function' ? LogsPage : null),
  network: () => (typeof NetworkPage === 'function' ? NetworkPage : null),
  board: () => (typeof BoardPage === 'function' ? BoardPage : null),
  quality: () => (typeof QualityPage === 'function' ? QualityPage : null),
  settings: () => (typeof SettingsPage === 'function' ? SettingsPage : null),
}

/** Page id safety net shared by the nav and the stored selection. */
function isKnownPage(id) {
  return FWB_PAGES.some((page) => page.id === id)
}

/** Shared button style for nav rows so hover/active look consistent. */
function navRowStyle(active) {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    height: 30,
    padding: '0 8px',
    borderRadius: T.radiusSm,
    border: '1px solid transparent',
    background: active === true ? T.selected : 'transparent',
    color: active === true ? T.text : T.textDim,
    fontSize: T.fsSm,
    fontWeight: active === true ? 600 : 500,
    cursor: 'pointer',
    textAlign: 'left',
  }
}

/** Small connection dot. */
function ConnDot({ ok, tone }) {
  const colors = toneColors(tone ?? (ok === true ? 'ok' : 'error'))
  return h('span', {
    style: {
      width: 7,
      height: 7,
      borderRadius: 7,
      flex: 'none',
      background: colors.fg,
      boxShadow: `0 0 0 2px ${colors.bg}`,
    },
  })
}

/** Error boundary so one broken page cannot blank the whole panel. */
class PageBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error: error ?? new Error('render failed') }
  }

  componentDidCatch(error) {
    console.error('[flutter-workbench] page render failed', error)
  }

  render() {
    if (this.state.error !== null) {
      const message = this.state.error?.message ?? String(this.state.error)
      return h('div', { style: { padding: 16 } },
        h(Card, { title: this.props.pageLabel ?? t('nav.section') },
          h('div', { style: { color: T.error, fontSize: T.fsSm, whiteSpace: 'pre-wrap' } },
            t('shell.errorBoundary', { message }),
            h('div', { style: { marginTop: 8 } },
              h(Btn, { onClick: () => this.setState({ error: null }) }, t('common.retry'))))))
    }
    return this.props.children
  }
}

/** Fallback for a page whose fragment is not in the bundle. */
function MissingPage({ pageLabel }) {
  return h('div', { style: { padding: 16 } },
    h(Card, { title: t('shell.fallbackTitle', { page: pageLabel }) },
      h('div', { style: { color: T.textDim, fontSize: T.fsSm, lineHeight: '19px' } }, t('shell.fallbackBody'))))
}

/** Device label used by the header chip. */
function deviceChipLabel(state) {
  const activeRun = (state?.runs ?? []).find((run) => run.runId === state?.activeRunId) ?? null
  const runDevice = activeRun?.device ?? null
  if (runDevice !== null && runDevice !== undefined) {
    return { label: runDevice.name ?? runDevice.id ?? t('shell.device'), tone: 'ok', title: `${runDevice.platform ?? ''}`.trim() }
  }
  const devices = state?.devices ?? []
  if (devices.length > 0) {
    const device = devices[0]
    return { label: device.name ?? device.id ?? t('shell.device'), tone: 'neutral', title: `${t('runtime.deviceCount', { n: devices.length })}` }
  }
  return { label: t('shell.deviceMissing'), tone: 'neutral', title: t('shell.deviceMissing') }
}

/**
 * Command list for the palette. Rebuilt on every open so it reflects the live
 * run/snapshot. Actions are invoked directly.
 */
function buildPaletteItems(state, actions, selectPage) {
  const items = FWB_PAGES.map((page) => ({
    id: `page:${page.id}`,
    group: 'pages',
    label: t(page.labelKey),
    hint: page.id,
    icon: page.icon,
    run: () => selectPage(page.id),
  }))
  const activeRun = (state?.runs ?? []).find((run) => run.runId === state?.activeRunId) ?? null
  const phase = activeRun?.phase ?? 'idle'
  const live = ['running', 'reloading', 'restarting'].includes(phase)
  const commands = [
    { id: 'run.start', label: t('runtime.start'), icon: 'play', disable: state?.activeProjectId === undefined || state?.activeProjectId === null, run: () => actions.startRun === undefined ? undefined : actions.startRun() },
    { id: 'run.check', label: t('run.active'), icon: 'terminal', run: () => selectPage('runtime') },
    { id: 'run.reload', label: t('runtime.reload'), icon: 'reload', disable: !live, run: () => (actions.hotReload === undefined ? undefined : actions.hotReload()) },
    { id: 'run.restart', label: t('runtime.restart'), icon: 'restart', disable: !live, run: () => (actions.hotRestart === undefined ? undefined : actions.hotRestart()) },
    { id: 'run.stop', label: t('runtime.stop'), icon: 'stop', disable: activeRun === null, run: () => (actions.stopRun === undefined ? undefined : actions.stopRun()) },
    { id: 'shell.refresh', label: t('common.refresh'), icon: 'refresh', run: () => (actions.refreshAll === undefined ? undefined : actions.refreshAll()) },
    { id: 'shell.addProject', label: t('shell.addProject'), icon: 'plus', run: () => selectPage('runtime') },
    { id: 'shell.devtools', label: t('runtime.openDevtools'), icon: 'external', disable: activeRun?.vmServiceUri === null || activeRun?.vmServiceUri === undefined, run: () => openDevtools(activeRun) },
    { id: 'shell.copyVm', label: t('shell.copyVmUri'), icon: 'copy', disable: activeRun?.vmServiceUri === null || activeRun?.vmServiceUri === undefined, run: () => copyVmUri(activeRun, actions) },
  ]
  return [...items, ...commands.filter((item) => !item.disable).concat(commands.filter((item) => item.disable))]
}

/** Open DevTools for a run (or report why it is not possible). */
function openDevtools(activeRun) {
  const url = activeRun?.devtoolsUrl ?? (activeRun?.vmServiceUri === null || activeRun?.vmServiceUri === undefined
    ? null
    : `https://devtools.flutter.dev/?uri=${encodeURIComponent(activeRun.vmServiceUri)}`)
  if (url === null) return false
  try {
    window.open(url, '_blank', 'noopener,noreferrer')
    return true
  } catch {
    return false
  }
}

/** Copy the VM service URI of the active run. */
async function copyVmUri(activeRun, actions) {
  const uri = activeRun?.vmServiceUri ?? ''
  if (uri === '') {
    if (actions?.toast !== undefined) actions.toast(t('shell.vmUriMissing'), 'warn')
    return false
  }
  const ok = await copyText(uri)
  if (actions?.toast !== undefined) actions.toast(ok ? t('common.copied') : t('common.copyFailed'), ok ? 'ok' : 'error')
  return ok
}

/** Command palette: page jumps plus run/home actions. */
function CommandPalette({ state, actions, onClose, selectPage }) {
  const [query, setQuery] = React.useState('')
  const [index, setIndex] = React.useState(0)
  const items = React.useMemo(() => buildPaletteItems(state, actions, (id) => {
    selectPage(id)
    onClose()
  }), [state, actions, selectPage, onClose])
  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return items
    return items.filter((item) => item.label.toLowerCase().includes(needle) || item.id.toLowerCase().includes(needle))
  }, [items, query])

  React.useEffect(() => { setIndex(0) }, [query])

  const execute = React.useCallback((item) => {
    if (item === null || item === undefined) return
    if (item.disable === true) return
    try {
      if (item.run !== undefined) item.run()
    } catch (error) {
      console.error('[flutter-workbench] palette command failed', error)
    }
    onClose()
  }, [onClose])

  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setIndex((current) => Math.min(filtered.length - 1, current + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setIndex((current) => Math.max(0, current - 1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      execute(filtered[index] ?? null)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  const pages = filtered.filter((item) => item.group === 'pages')
  const commands = filtered.filter((item) => item.group !== 'pages')

  return h(Modal, { title: t('shell.palette'), onClose, width: 560, footer: h('span', { style: { fontSize: T.fsXs, color: T.textFaint } }, t('shell.paletteHint')) },
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
      h(Input, {
        value: query,
        onChange: setQuery,
        onKeyDown,
        autoFocus: true,
        placeholder: t('shell.palettePlaceholder'),
      }),
      h('div', { className: 'fwb-scroll', style: { maxHeight: 360, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 2 } },
        filtered.length === 0 ? h(Empty, { text: t('shell.paletteEmpty'), compact: true }) : null,
        pages.length > 0 ? h('div', { style: { fontSize: T.fsXs, color: T.textFaint, padding: '4px 6px' } }, t('shell.palettePages')) : null,
        pages.map((item) => paletteRow(item, filtered.indexOf(item) === index, execute)),
        commands.length > 0 ? h('div', { style: { fontSize: T.fsXs, color: T.textFaint, padding: '6px 6px 4px' } }, t('shell.paletteActions')) : null,
        commands.map((item) => paletteRow(item, filtered.indexOf(item) === index, execute)))))
}

/** One palette row. */
function paletteRow(item, active, execute) {
  const [hover, bind] = useHover()
  return h('button', {
    key: item.id,
    type: 'button',
    'data-active': active,
    onMouseEnter: bind.onMouseEnter,
    onMouseLeave: bind.onMouseLeave,
    onClick: () => execute(item),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      width: '100%',
      height: 28,
      padding: '0 8px',
      borderRadius: T.radiusSm,
      border: '1px solid transparent',
      background: active === true ? T.selected : hover ? T.hover : 'transparent',
      color: item.disable === true ? T.textFaint : T.text,
      fontSize: T.fsSm,
      cursor: 'pointer',
      textAlign: 'left',
    },
  },
    h(Icon, { name: item.icon ?? 'dot', size: 13 }),
    h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.label),
    h('span', { style: { color: T.textFaint, fontSize: T.fsXs, fontFamily: T.mono } }, item.hint ?? ''))
}

/**
 * The registered main panel: `main` slot key `flutter-workbench`.
 * @returns {any} full-height workbench layout.
 */
function WorkbenchApp() {
  ensureStyles()
  const state = useApiState()
  const actions = state.actions ?? {}
  const [page, setPage] = useSessionState('fwb.page', 'runtime')
  const [paletteOpen, setPaletteOpen] = React.useState(false)
  const [addOpen, setAddOpen] = React.useState(false)
  const [addPath, setAddPath] = React.useState('')
  const [addBusy, setAddBusy] = React.useState(false)
  const [, bumpLocale] = React.useReducer((value) => value + 1, 0)

  const activePage = isKnownPage(page) ? page : 'runtime'
  React.useEffect(() => {
    if (activePage !== page) setPage('runtime')
  }, [activePage, page, setPage])

  const selectPage = React.useCallback((id) => {
    if (isKnownPage(id)) setPage(id)
  }, [setPage])

  const runs = state.runs ?? []
  const activeRun = runs.find((run) => run.runId === state.activeRunId) ?? null
  const phase = activeRun?.phase ?? 'idle'
  const live = phase === 'running' || phase === 'reloading' || phase === 'restarting'
  const busy = phase === 'starting' || phase === 'stopping' || phase === 'reloading' || phase === 'restarting'
  const projects = state.projects ?? []
  const counters = state.counters ?? {}
  const conn = state.conn ?? { ok: false, error: null }
  const chip = deviceChipLabel(state)
  const devtoolsUrl = activeRun?.devtoolsUrl !== null && activeRun?.devtoolsUrl !== undefined
    ? activeRun.devtoolsUrl
    : (activeRun?.vmServiceUri !== null && activeRun?.vmServiceUri !== undefined
      ? `https://devtools.flutter.dev/?uri=${encodeURIComponent(activeRun.vmServiceUri)}`
      : null)

  /* ---- keyboard: Ctrl/Cmd+K palette, Esc overlay, R refresh logs ------- */
  React.useEffect(() => {
    const onKey = (event) => {
      const meta = event.ctrlKey === true || event.metaKey === true
      if (meta && (event.key === 'k' || event.key === 'K')) {
        event.preventDefault()
        setPaletteOpen((open) => !open)
        return
      }
      if (meta || event.altKey === true) return
      if (event.key === 'Escape') {
        if (paletteOpen === true) {
          event.preventDefault()
          setPaletteOpen(false)
        }
        return
      }
      if (isTypingTarget(event.target) === true) return
      if (activePage === 'logs' && (event.key === 'r' || event.key === 'R')) {
        event.preventDefault()
        try {
          window.dispatchEvent(new CustomEvent('fwb:logs-refresh'))
        } catch {
          /* older engines: the LogsPage hit refresh itself */
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activePage, paletteOpen])

  const submitAddProject = React.useCallback(async () => {
    const path = addPath.trim()
    if (path === '') {
      actions.toast?.(t('shell.addProjectEmpty'), 'warn')
      return
    }
    setAddBusy(true)
    try {
      const result = await (actions.addProject === undefined ? Promise.reject(new Error(t('common.error'))) : actions.addProject(path))
      const project = result?.project ?? null
      actions.toast?.(t('shell.projectAdded', { name: project?.name ?? path }), 'ok')
      setAddOpen(false)
      setAddPath('')
      if (project?.id !== undefined && actions.selectProject !== undefined) await actions.selectProject(project.id)
    } catch (error) {
      actions.toast?.(t('common.actionFailed', { message: error?.message ?? String(error) }), 'error')
    } finally {
      setAddBusy(false)
    }
  }, [addPath, actions])

  const removeActiveProject = React.useCallback(async () => {
    const project = projects.find((item) => item.id === state.activeProjectId) ?? null
    if (project === null) return
    const ok = typeof window.confirm === 'function' ? window.confirm(t('shell.removeProjectConfirm', { name: project.name ?? project.path })) : true
    if (ok !== true) return
    try {
      await (actions.removeProject === undefined ? Promise.reject(new Error(t('common.error'))) : actions.removeProject(project.id))
      actions.toast?.(t('shell.projectRemoved'), 'ok')
    } catch (error) {
      actions.toast?.(t('common.actionFailed', { message: error?.message ?? String(error) }), 'error')
    }
  }, [actions, projects, state.activeProjectId])

  const toggleLocale = React.useCallback(() => {
    setActiveLocale(currentLocale === 'zh' ? 'en' : 'zh')
    bumpLocale()
  }, [bumpLocale])

  const pageDef = FWB_PAGES.find((item) => item.id === activePage) ?? FWB_PAGES[0]
  const resolve = FWB_PAGE_COMPONENTS[activePage]
  const PageComponent = resolve === undefined ? null : resolve()
  const pageNode = typeof PageComponent === 'function'
    ? h(PageComponent, { state, actions })
    : h(MissingPage, { pageLabel: t(pageDef.labelKey) })

  const runAction = (name, quiet) => async () => {
    const fn = actions[name]
    if (fn === undefined) return
    try {
      await fn()
    } catch (error) {
      if (quiet !== true) actions.toast?.(t('common.actionFailed', { message: error?.message ?? String(error) }), 'error')
    }
  }

  return h('div', {
    className: 'fwb-root',
    style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden', position: 'relative' },
  },
    /* ---------------------------------------------------------------- header */
    h('header', {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: 46,
        padding: '0 10px',
        borderBottom: `1px solid ${T.border}`,
        background: T.l1,
        flexShrink: 0,
        minWidth: 0,
      },
    },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0 } },
        h('span', {
          style: {
            width: 22, height: 22, borderRadius: T.radiusSm, display: 'inline-flex',
            alignItems: 'center', justifyContent: 'center',
            background: `color-mix(in srgb, ${T.brand} 18%, transparent)`, color: T.brand,
          },
        }, h(Icon, { name: 'terminal', size: 14 })),
        h('div', { style: { display: 'flex', flexDirection: 'column', lineHeight: '14px' } },
          h('strong', { style: { fontSize: T.fs } }, t('shell.title')),
          h('span', { style: { fontSize: 10, color: T.textFaint } }, t('shell.subtitle')))),
      h('div', { style: { width: 1, height: 22, background: T.border, flexShrink: 0 } }),
      /* project switcher */
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, width: 232, flexShrink: 1 } },
        h(Select, {
          value: state.activeProjectId ?? '',
          options: projects.map((project) => ({ value: project.id, label: project.name ?? project.path ?? project.id })),
          placeholder: projects.length === 0 ? t('shell.noProject') : t('shell.projectPlaceholder'),
          title: t('shell.projectPlaceholder'),
          onChange: (value) => { if (value !== '' && actions.selectProject !== undefined) actions.selectProject(value).catch((error) => actions.toast?.(t('common.actionFailed', { message: error?.message ?? String(error) }), 'error')) },
          style: { height: 26 },
        }),
        h(IconBtn, { icon: 'plus', title: t('shell.addProject'), onClick: () => setAddOpen(true) }),
        h(IconBtn, {
          icon: 'trash',
          title: t('shell.removeProject'),
          disabled: state.activeProjectId === undefined || state.activeProjectId === null,
          onClick: removeActiveProject,
        })),
      /* phase + run controls */
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 } },
        h(Pill, { tone: statusTone(phase), dot: true, title: activeRun?.runId ?? t('shell.noRun') }, t(`phase.${phase}`, {})),
        h(Btn, {
          kind: 'primary',
          size: 'sm',
          icon: 'play',
          title: t('runtime.start'),
          disabled: state.activeProjectId === undefined || state.activeProjectId === null || busy,
          onClick: runAction('startRun'),
        }, t('runtime.start')),
        h(IconBtn, { icon: 'reload', title: t('runtime.reload'), disabled: !live, onClick: runAction('hotReload') }),
        h(IconBtn, { icon: 'restart', title: t('runtime.restart'), disabled: !live, onClick: runAction('hotRestart') }),
        h(IconBtn, { icon: 'stop', title: t('runtime.stop'), disabled: activeRun === null || phase === 'stopping' || phase === 'stopped', onClick: runAction('stopRun') })),
      h('div', { style: { flex: 1, minWidth: 8 } }),
      /* device chip */
      h('button', {
        type: 'button',
        title: chip.title ?? t('shell.device'),
        onClick: () => selectPage('runtime'),
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 8px',
          borderRadius: T.radiusSm, border: `1px solid ${T.border}`, background: 'transparent',
          color: T.textDim, fontSize: T.fsXs, cursor: 'pointer', maxWidth: 180, overflow: 'hidden', flexShrink: 0,
        },
      },
        h(Icon, { name: 'device', size: 12 }),
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, chip.label)),
      /* DevTools */
      devtoolsUrl === null
        ? h(Btn, { size: 'sm', icon: 'external', disabled: true, title: t('runtime.devtoolsNeedsRun') }, t('shell.devtools'))
        : h('a', {
          href: devtoolsUrl,
          target: '_blank',
          rel: 'noreferrer noopener',
          title: t('runtime.openDevtools'),
          style: {
            display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 8px',
            borderRadius: T.radiusSm, border: `1px solid ${T.border}`, color: T.text,
            textDecoration: 'none', fontSize: T.fsXs, flexShrink: 0,
          },
        }, h(Icon, { name: 'external', size: 12 }), t('shell.devtools')),
      /* connection + polling */
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0, fontSize: T.fsXs, color: conn.ok === true ? T.textDim : T.error }, title: conn.error?.message ?? t('shell.connected') },
        h(ConnDot, { ok: conn.ok === true }),
        h('span', { style: { maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          conn.ok === true ? t('shell.connected') : t('shell.disconnected'))),
      h(IconBtn, {
        icon: state.paused === true ? 'play' : 'pause',
        title: state.paused === true ? t('shell.resumePolling') : t('shell.pausePolling'),
        active: state.paused === true,
        onClick: () => actions.setPaused?.(state.paused !== true),
      }),
      h(IconBtn, { icon: 'search', title: t('shell.palette'), onClick: () => setPaletteOpen(true) })),

    /* ---- offline banner ------------------------------------------------ */
    conn.ok === true ? null : h('div', {
      style: {
        display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px',
        background: `color-mix(in srgb, ${T.error} 12%, transparent)`,
        borderBottom: `1px solid color-mix(in srgb, ${T.error} 35%, transparent)`,
        color: T.error, fontSize: T.fsXs, flexShrink: 0,
      },
    },
      h(Icon, { name: 'warn', size: 13 }),
      h('span', { style: { flex: 1, minWidth: 0 } }, conn.error === null || conn.error === undefined
        ? t('state.connecting')
        : t('shell.offlineBody', { message: conn.error.message ?? String(conn.error) })),
      h(Btn, { size: 'sm', onClick: () => actions.refreshAll?.() }, t('common.retry'))),

    /* ---- body ---------------------------------------------------------- */
    h('div', { style: { display: 'flex', flex: 1, minHeight: 0, minWidth: 0 } },
      h('nav', {
        style: {
          width: 190, flexShrink: 0, borderRight: `1px solid ${T.border}`, background: T.l1,
          display: 'flex', flexDirection: 'column', padding: 6, gap: 2, minHeight: 0,
        },
      },
        h('div', { style: { padding: '4px 8px 6px', fontSize: 10, letterSpacing: 0.4, textTransform: 'uppercase', color: T.textFaint } }, t('nav.section')),
        FWB_PAGES.map((item) => {
          const active = item.id === activePage
          const count = item.badge === null ? 0 : Number(counters[item.badge] ?? 0)
          return h('button', {
            key: item.id,
            type: 'button',
            className: 'fwb-row',
            title: t(item.labelKey),
            onClick: () => selectPage(item.id),
            style: navRowStyle(active),
          },
            h(Icon, { name: item.icon, size: 14 }),
            h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, t(item.labelKey)),
            h(Badge, { count, tone: item.id === 'quality' ? 'error' : item.id === 'board' ? 'brand' : 'neutral' }))
        }),
        h('div', { style: { flex: 1 } }),
        state.paused === true ? h('div', { style: { padding: '4px 8px', fontSize: T.fsXs, color: T.warnLabel } }, t('shell.paused')) : null,
        h('button', {
          type: 'button',
          className: 'fwb-row',
          onClick: () => setPaletteOpen(true),
          style: navRowStyle(false),
        },
          h(Icon, { name: 'search', size: 13 }),
          h('span', { style: { flex: 1, textAlign: 'left' } }, t('shell.palette')),
          h(Kbd, null, '⌘K')),
        h('button', {
          type: 'button',
          className: 'fwb-row',
          onClick: toggleLocale,
          title: t('shell.switchLocale'),
          style: navRowStyle(false),
        },
          h(Icon, { name: 'file', size: 13 }),
          h('span', { style: { flex: 1, textAlign: 'left' } }, t('shell.locale')),
          h('span', { style: { fontSize: T.fsXs, color: T.textFaint } }, currentLocale === 'zh' ? '中' : 'EN'))),
      h('main', {
        className: 'fwb-scroll',
        style: { flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' },
      },
        h(PageBoundary, { key: activePage, pageLabel: t(pageDef.labelKey) }, pageNode))),

    /* ---- status bar ---------------------------------------------------- */
    h('footer', {
      style: {
        display: 'flex', alignItems: 'center', gap: 12, height: 26, padding: '0 10px',
        borderTop: `1px solid ${T.border}`, background: T.l1, color: T.textFaint,
        fontSize: 11, flexShrink: 0, minWidth: 0,
      },
    },
      h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
        h(ConnDot, { ok: conn.ok === true }),
        h('span', { style: { color: T.textDim } }, activeRun?.runId ?? t('shell.noRun'))),
      activeRun === null ? null : h('span', null, t(`phase.${phase}`, {})),
      h('span', null, t('shell.logsCount', { n: Number(counters.logs ?? 0) })),
      h('span', null, t('shell.errorsCount', { n: Number(counters.errors ?? 0) })),
      h('span', { style: { flex: 1 } }),
      state.paused === true ? h('span', { style: { color: T.warnLabel } }, t('shell.paused')) : null,
      h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(Kbd, null, '⌘K'), t('shell.hintPalette')),
      h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(Kbd, null, 'R'), t('shell.hintRefreshLogs')),
      h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(Kbd, null, 'Esc'), t('shell.hintEsc'))),

    /* ---- overlays ------------------------------------------------------ */
    paletteOpen ? h(CommandPalette, {
      state,
      actions,
      selectPage,
      onClose: () => setPaletteOpen(false),
    }) : null,

    addOpen ? h(Modal, {
      title: t('shell.addProjectTitle'),
      onClose: () => setAddOpen(false),
      width: 520,
      footer: [
        h(Btn, { key: 'cancel', onClick: () => setAddOpen(false) }, t('common.cancel')),
        h(Btn, { key: 'add', kind: 'primary', disabled: addBusy, onClick: submitAddProject }, addBusy ? t('common.loading') : t('common.add')),
      ],
    },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h(Field, { label: t('runtime.project'), hint: t('shell.addProjectHint') },
          h(Input, {
            value: addPath,
            onChange: setAddPath,
            onEnter: submitAddProject,
            placeholder: t('shell.addProjectPlaceholder'),
            mono: true,
            autoFocus: true,
          })))) : null,

    h(ToastHost, { toasts: state.toasts ?? [], onDismiss: (id) => actions.dismissToast?.(id) })
  )
}