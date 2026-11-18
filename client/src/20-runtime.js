/* ====================================================================== *
 * 20-runtime.js — owner: dev-ui-core
 *
 * Two things:
 *  1. `useApiState()` — the single shared state + actions layer every page
 *     receives (CONTRACTS §8.2). It polls `/state` at the configured cadence,
 *     stops polling while the document is hidden, and reports a connection
 *     error instead of throwing.
 *  2. `RuntimePage({ state, actions })` — project / config / device / mode
 *     pickers, the start/stop/reload/restart toolbar with optimistic phase,
 *     the live run detail (VM URI + DevTools) and a recent-run summary.
 * ====================================================================== */

/** Run phases that mean "a child process exists". */
const LIVE_PHASES = ['starting', 'running', 'reloading', 'restarting']
/** Default poll cadence before /state has delivered `settings.autoRefreshMs`. */
const DEFAULT_REFRESH_MS = 2000

/* ---------------------------------------------------------------------- *
 * Small pure helpers (unique names: the bundle shares one scope)
 * ---------------------------------------------------------------------- */

/** object → `[{ key, value }]` rows for the dart-define editor. */
function definesToRows(defines) {
  if (defines === null || typeof defines !== 'object') return []
  return Object.keys(defines).map((key) => ({ key, value: String(defines[key] ?? '') }))
}

/** `[{ key, value }]` rows → object, dropping empty keys and duplicates. */
function rowsToDefines(rows) {
  const result = {}
  for (const row of rows ?? []) {
    const key = String(row?.key ?? '').trim()
    if (key === '') continue
    result[key] = String(row?.value ?? '')
  }
  return result
}

/** Split a space separated argument string; honors "double quoted" groups. */
function parseArgsText(text) {
  const value = String(text ?? '').trim()
  if (value === '') return []
  const parts = value.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  return parts.map((part) => part.replace(/^["']|["']$/g, ''))
}

/** Non-empty string or undefined, for request bodies. */
function optionalText(value) {
  const text = String(value ?? '').trim()
  return text === '' ? undefined : text
}

/** Whether a run phase means "live". */
function isLivePhase(phase) {
  return LIVE_PHASES.includes(String(phase ?? ''))
}

/** Build the `/run/start` body from the draft plus caller overrides. */
function draftToRunBody(draft, overrides) {
  const merged = { ...(draft ?? {}), ...(overrides ?? {}) }
  const body = {
    projectId: merged.projectId === undefined || merged.projectId === null ? undefined : merged.projectId,
    configId: merged.configId === undefined || merged.configId === null || merged.configId === '' ? undefined : merged.configId,
    program: optionalText(merged.program),
    deviceId: optionalText(merged.deviceId),
    mode: optionalText(merged.mode) ?? 'debug',
    flavor: optionalText(merged.flavor),
    dartDefines: merged.dartDefines !== null && typeof merged.dartDefines === 'object' ? merged.dartDefines : {},
    args: Array.isArray(merged.args) ? merged.args : parseArgsText(merged.args),
  }
  return body
}

/* ---------------------------------------------------------------------- *
 * useApiState — shared state + actions (§8.2)
 * ---------------------------------------------------------------------- */

/**
 * The workbench's shared state. One `/state` poll drives the shell; every
 * other endpoint is pulled on demand by the page that needs it (and mirrored
 * here so a page switch keeps the last window).
 * @returns {object} state + actions (§8.2 shape).
 */
function useApiState() {
  ensureStyles()

  const [paused, setPausedFlag] = React.useState(false)
  const [cadence, setCadence] = React.useState(DEFAULT_REFRESH_MS)
  const [draft, setDraftState] = React.useState({
    projectId: null,
    configId: null,
    program: '',
    deviceId: '',
    mode: 'debug',
    flavor: '',
    dartDefines: {},
    args: '',
  })
  const [configState, setConfigState] = React.useState({
    projectId: null,
    configs: [],
    entries: [],
    devices: [],
    emulators: [],
    flavors: [],
    launchFile: null,
    warnings: [],
    loading: false,
    error: null,
  })
  const [logs, setLogs] = React.useState({ entries: [], nextCursor: 0, total: 0 })
  const [errors, setErrors] = React.useState({ groups: [], nextCursor: 0, total: 0 })
  const [network, setNetwork] = React.useState({ entries: [], nextCursor: 0, total: 0 })
  const [board, setBoard] = React.useState(null)
  const [jobs, setJobs] = React.useState([])

  const toastQueue = useToast()
  const showToast = toastQueue.show

  const snapshotPoll = usePoll(
    () => api('/state'),
    paused === true ? 0 : cadence,
    [paused, cadence],
  )
  const snapshot = snapshotPoll.data ?? null
  const activeProjectId = snapshot?.activeProjectId ?? null
  const activeProjectRef = React.useRef(activeProjectId)
  activeProjectRef.current = activeProjectId

  /* Adopt the host refresh cadence once /state delivers settings. */
  React.useEffect(() => {
    const next = Number(snapshot?.settings?.autoRefreshMs)
    if (Number.isFinite(next) && next >= 500 && next <= 60000 && next !== cadence) setCadence(next)
  }, [snapshot, cadence])

  /** Refresh `/state` and return the fresh snapshot (or null on failure). */
  const refreshAll = React.useCallback(async () => {
    const value = await snapshotPoll.refresh()
    return value
  }, [snapshotPoll.refresh])

  const setDraft = React.useCallback((patch) => {
    setDraftState((previous) => {
      const next = { ...previous, ...(patch ?? {}) }
      return next
    })
  }, [])

  const setPaused = React.useCallback((next) => {
    setPausedFlag(next === true)
  }, [])

  const toast = React.useCallback((message, tone) => showToast(message, tone ?? 'info'), [showToast])
  const dismissToast = toastQueue.dismiss

  /* ---- projects ------------------------------------------------------ */

  const selectProject = React.useCallback(async (id) => {
    const data = await api('/project/select', { method: 'POST', body: { id } })
    setDraftState((previous) => ({ ...previous, projectId: data.activeProjectId ?? id, configId: null, program: '' }))
    await snapshotPoll.refresh()
    return data
  }, [snapshotPoll.refresh])

  const addProject = React.useCallback(async (path) => {
    const data = await api('/project/add', { method: 'POST', body: { path } })
    await snapshotPoll.refresh()
    const project = data.project ?? null
    if (project?.id !== undefined) {
      setDraftState((previous) => ({ ...previous, projectId: project.id, configId: null, program: '' }))
      try {
        await api('/project/select', { method: 'POST', body: { id: project.id } })
      } catch {
        /* the project exists; selection is a convenience */
      }
      await snapshotPoll.refresh()
    }
    return data
  }, [snapshotPoll.refresh])

  const removeProject = React.useCallback(async (id) => {
    const data = await api('/project/remove', { method: 'POST', body: { id } })
    setDraftState((previous) => (previous.projectId === id ? { ...previous, projectId: null, configId: null, program: '' } : previous))
    await snapshotPoll.refresh()
    return data
  }, [snapshotPoll.refresh])

  /* ---- configs / devices -------------------------------------------- */

  const loadConfigs = React.useCallback(async (projectId) => {
    const target = projectId ?? activeProjectRef.current
    if (target === null || target === undefined || target === '') {
      const empty = {
        projectId: null, configs: [], entries: [], devices: [], emulators: [], flavors: [],
        launchFile: null, warnings: [], loading: false, error: null,
      }
      setConfigState(empty)
      return empty
    }
    setConfigState((previous) => ({ ...previous, loading: true, error: null }))
    try {
      const data = await api('/configs', { query: { projectId: target } })
      const next = {
        projectId: target,
        configs: Array.isArray(data.configs) ? data.configs : [],
        entries: Array.isArray(data.entries) ? data.entries : [],
        devices: Array.isArray(data.devices) ? data.devices : [],
        emulators: Array.isArray(data.emulators) ? data.emulators : [],
        flavors: Array.isArray(data.flavors) ? data.flavors : [],
        launchFile: data.launchFile ?? null,
        warnings: Array.isArray(data.warnings) ? data.warnings : [],
        loading: false,
        error: null,
      }
      setConfigState(next)
      setDraftState((previous) => seedDraft(previous, next))
      return next
    } catch (error) {
      setConfigState((previous) => ({ ...previous, loading: false, error }))
      throw error
    }
  }, [])

  /* Auto-load configs whenever the selected project changes. */
  React.useEffect(() => {
    if (activeProjectId === null || activeProjectId === undefined) return
    if (configState.projectId === activeProjectId) return
    if (configState.loading === true) return
    loadConfigs(activeProjectId).catch((error) => {
      showToast(t('runtime.configLoadFailed', { message: error?.message ?? String(error) }), 'error')
    })
  }, [activeProjectId, configState.projectId, configState.loading, loadConfigs, showToast])

  /* ---- run lifecycle ------------------------------------------------- */

  const startRun = React.useCallback(async (input) => {
    const body = draftToRunBody(draft, input)
    if (body.projectId === undefined || body.projectId === null) body.projectId = activeProjectRef.current ?? undefined
    const data = await api('/run/start', { method: 'POST', body })
    await snapshotPoll.refresh()
    return data
  }, [draft, snapshotPoll.refresh])

  const stopRun = React.useCallback(async (runId) => {
    const body = {}
    const target = runId ?? snapshot?.activeRunId ?? null
    if (target !== null && target !== undefined) body.runId = target
    const data = await api('/run/stop', { method: 'POST', body })
    await snapshotPoll.refresh()
    return data
  }, [snapshot?.activeRunId, snapshotPoll.refresh])

  const hotReload = React.useCallback(async (runId) => {
    const body = {}
    const target = runId ?? snapshot?.activeRunId ?? null
    if (target !== null && target !== undefined) body.runId = target
    const data = await api('/run/reload', { method: 'POST', body })
    await snapshotPoll.refresh()
    return data
  }, [snapshot?.activeRunId, snapshotPoll.refresh])

  const hotRestart = React.useCallback(async (runId) => {
    const body = {}
    const target = runId ?? snapshot?.activeRunId ?? null
    if (target !== null && target !== undefined) body.runId = target
    const data = await api('/run/restart', { method: 'POST', body })
    await snapshotPoll.refresh()
    return data
  }, [snapshot?.activeRunId, snapshotPoll.refresh])

  /* ---- logs / errors / network --------------------------------------- */

  const fetchLogs = React.useCallback(async (query) => {
    const data = await api('/logs', { query })
    const payload = {
      entries: Array.isArray(data.entries) ? data.entries : [],
      nextCursor: Number(data.nextCursor ?? 0),
      total: Number(data.total ?? 0),
      dropped: Number(data.dropped ?? 0),
    }
    setLogs(payload)
    return payload
  }, [])

  const fetchErrors = React.useCallback(async (query) => {
    const data = await api('/errors', { query })
    const payload = {
      groups: Array.isArray(data.groups) ? data.groups : [],
      nextCursor: Number(data.nextCursor ?? 0),
      total: Number(data.total ?? 0),
    }
    setErrors(payload)
    return payload
  }, [])

  const fetchNetwork = React.useCallback(async (query) => {
    const data = await api('/network', { query })
    const payload = {
      entries: Array.isArray(data.entries) ? data.entries : [],
      nextCursor: Number(data.nextCursor ?? 0),
      total: Number(data.total ?? 0),
    }
    setNetwork(payload)
    return payload
  }, [])

  const networkDetail = React.useCallback(async (input) => {
    const data = await api('/network/detail', { method: 'POST', body: { id: input?.id, runId: input?.runId } })
    return data.request ?? data
  }, [])

  const markLog = React.useCallback(async (text) => {
    const data = await api('/logs/mark', { method: 'POST', body: { text: String(text ?? '') } })
    return data
  }, [])

  /* ---- jobs / toolchain ---------------------------------------------- */

  const listJobs = React.useCallback(async (limit) => {
    const data = await api('/jobs', { query: limit === undefined ? undefined : { limit } })
    const payload = Array.isArray(data.jobs) ? data.jobs : []
    setJobs(payload)
    return payload
  }, [])

  const getJob = React.useCallback(async (id) => {
    const data = await api('/job', { query: { id } })
    return data.job ?? data
  }, [])

  const runToolchain = React.useCallback(async (input) => {
    const body = {
      action: input?.action,
      projectId: input?.projectId ?? activeProjectRef.current ?? undefined,
      target: input?.target,
      name: input?.name,
    }
    const data = await api('/toolchain', { method: 'POST', body })
    void listJobs().catch(() => undefined)
    return data
  }, [listJobs])

  const screenshot = React.useCallback(async (input) => {
    const body = {}
    const target = input?.runId ?? snapshot?.activeRunId ?? null
    if (target !== null && target !== undefined) body.runId = target
    const data = await api('/screenshot', { method: 'POST', body })
    return data
  }, [snapshot?.activeRunId])

  /* ---- board --------------------------------------------------------- */

  const adoptBoard = React.useCallback((data) => {
    if (data !== null && data !== undefined && data.board !== undefined && data.board !== null) {
      setBoard(data.board)
      return data.board
    }
    return null
  }, [])

  const refreshBoard = React.useCallback(async () => {
    const data = await api('/board')
    const next = data.board ?? null
    setBoard(next)
    return next
  }, [])

  const boardAction = React.useCallback(async (body) => {
    const data = await api('/board/task', { method: 'POST', body })
    adoptBoard(data)
    if (data.board === undefined) await refreshBoard().catch(() => undefined)
    return data
  }, [adoptBoard, refreshBoard])

  const createTask = React.useCallback((input) => boardAction({ action: 'create', ...(input ?? {}) }), [boardAction])
  const updateTask = React.useCallback((input) => boardAction({ action: 'update', id: input?.id, patch: input?.patch ?? {} }), [boardAction])
  const moveTask = React.useCallback((input) => boardAction({ action: 'move', id: input?.id, lane: input?.lane, index: input?.index }), [boardAction])
  const deleteTask = React.useCallback((id) => boardAction({ action: 'delete', id }), [boardAction])
  const archiveDone = React.useCallback(() => boardAction({ action: 'archive' }), [boardAction])

  const decompose = React.useCallback(async (input) => {
    const body = {
      prompt: String(input?.prompt ?? ''),
      projectId: input?.projectId ?? activeProjectRef.current ?? undefined,
      maxTasks: input?.maxTasks,
    }
    const data = await api('/board/decompose', { method: 'POST', body })
    await refreshBoard().catch(() => undefined)
    return data
  }, [refreshBoard])

  const dispatchTask = React.useCallback(async (input) => {
    const data = await api('/board/dispatch', { method: 'POST', body: { id: input?.id, provider: input?.provider, model: input?.model } })
    adoptBoard(data)
    return data
  }, [adoptBoard])

  const reportTask = React.useCallback(async (input) => {
    const data = await api('/board/report', { method: 'POST', body: input ?? {} })
    adoptBoard(data)
    return data
  }, [adoptBoard])

  /* ---- settings ------------------------------------------------------ */

  const saveSettings = React.useCallback(async (patch) => {
    const data = await api('/settings', { method: 'POST', body: { patch: patch ?? {} } })
    await snapshotPoll.refresh()
    return data.settings ?? null
  }, [snapshotPoll.refresh])

  /* ---- editor bridge / misc ------------------------------------------ */

  /**
   * Open `file:line`. The host endpoint is `POST /open` (see the t6 report:
   * CONTRACTS §6 needed this route). It never throws: when the route is
   * missing the path is copied to the clipboard and a toast explains it.
   */
  const openFile = React.useCallback(async (file, line) => {
    const target = file !== null && typeof file === 'object'
      ? { file: file.file, line: file.line }
      : { file, line }
    const filePath = String(target.file ?? '')
    if (filePath === '') return { ok: false }
    try {
      const data = await api('/open', { method: 'POST', body: { file: filePath, line: target.line ?? null } })
      return { ok: true, data }
    } catch (error) {
      const label = target.line === undefined || target.line === null ? filePath : `${filePath}:${target.line}`
      const copied = await copyText(label)
      showToast(t('logs.openFailed', { message: `${error?.message ?? String(error)} · ${copied ? label : t('common.copyFailed')}` }), 'error')
      return { ok: false, copied, error }
    }
  }, [showToast])

  const refreshAllAndConfigs = React.useCallback(async () => {
    await refreshAll()
    if (activeProjectRef.current !== null && activeProjectRef.current !== undefined) {
      await loadConfigs(activeProjectRef.current).catch(() => undefined)
    }
  }, [loadConfigs, refreshAll])

  /* ---- derived state ------------------------------------------------- */

  const projects = Array.isArray(snapshot?.projects) ? snapshot.projects : []
  const runs = Array.isArray(snapshot?.runs) ? snapshot.runs : []
  const activeRunId = snapshot?.activeRunId ?? null
  const activeRun = runs.find((run) => run.runId === activeRunId) ?? null
  const settings = snapshot?.settings ?? null
  const hostBoard = snapshot?.board ?? null
  const effectiveBoard = board ?? hostBoard
  const hostCounters = snapshot?.counters ?? {}
  const counters = {
    projects: projects.length,
    runs: runs.length,
    running: runs.filter((run) => isLivePhase(run.phase)).length,
    logs: Number(hostCounters.logs ?? logs.total ?? 0),
    errors: Number(hostCounters.errors ?? errors.total ?? 0),
    network: Number(hostCounters.network ?? network.total ?? 0),
    tasks: Array.isArray(effectiveBoard?.tasks) ? effectiveBoard.tasks.length : Number(hostCounters.tasks ?? 0),
  }

  const actions = {
    /* projects */
    selectProject,
    addProject,
    removeProject,
    /* configs */
    loadConfigs,
    /* runs */
    startRun,
    stopRun,
    hotReload,
    hotRestart,
    /* windows pulled on demand */
    fetchLogs,
    fetchErrors,
    fetchNetwork,
    networkDetail,
    markLog,
    /* toolchain + jobs */
    runToolchain,
    getJob,
    listJobs,
    screenshot,
    /* board */
    refreshBoard,
    createTask,
    updateTask,
    moveTask,
    deleteTask,
    archiveDone,
    decompose,
    dispatchTask,
    reportTask,
    /* settings + editor + ui */
    saveSettings,
    openFile,
    toast,
    dismissToast,
    refreshAll,
    refreshAllAndConfigs,
    setPaused,
    setDraft,
  }

  return {
    /* app state */
    snapshot,
    projects,
    activeProjectId,
    runs,
    activeRunId,
    activeRun,
    configs: configState.configs,
    configEntries: configState.entries,
    devices: configState.devices,
    emulators: configState.emulators,
    flavors: configState.flavors,
    launchFile: configState.launchFile,
    configWarnings: configState.warnings,
    configLoading: configState.loading,
    configError: configState.error,
    logs,
    errors,
    network,
    board: effectiveBoard,
    jobs,
    settings,
    counters,
    paused,
    draft,
    toasts: toastQueue.toasts,
    conn: {
      ok: snapshotPoll.error === null && snapshot !== null,
      error: snapshotPoll.error,
      loading: snapshotPoll.loading,
      lastOkAt: snapshotPoll.lastOkAt,
    },
    /* actions (§8.2) */
    actions,
  }
}

/**
 * Seed the run draft from freshly loaded configs. Keeps the user's picks when
 * the same project is reloaded and the chosen config still exists.
 */
function seedDraft(previous, loaded) {
  const configs = loaded?.configs ?? []
  const devices = loaded?.devices ?? []
  const sameProject = previous.projectId === loaded?.projectId
  const keep = sameProject && configs.some((config) => config.id === previous.configId)
  if (keep) {
    return { ...previous, deviceId: previous.deviceId === '' && devices.length > 0 ? (devices[0].id ?? '') : previous.deviceId }
  }
  const config = configs.length > 0 ? configs[0] : null
  if (config !== null) {
    return {
      projectId: loaded?.projectId ?? null,
      configId: config.id ?? null,
      program: config.program ?? '',
      deviceId: config.deviceId ?? (devices[0]?.id ?? ''),
      mode: config.mode ?? 'debug',
      flavor: config.flavor ?? '',
      dartDefines: config.dartDefines !== null && typeof config.dartDefines === 'object' ? { ...config.dartDefines } : {},
      args: Array.isArray(config.args) ? config.args.join(' ') : '',
    }
  }
  return {
    projectId: loaded?.projectId ?? null,
    configId: null,
    program: 'lib/main.dart',
    deviceId: devices[0]?.id ?? '',
    mode: 'debug',
    flavor: '',
    dartDefines: {},
    args: '',
  }
}

/* ---------------------------------------------------------------------- *
 * RuntimePage
 * ---------------------------------------------------------------------- */

/** One label/value row in the run detail card. */
function RunDetailRow({ label, children, mono, wrap }) {
  return h('div', {
    style: { display: 'grid', gridTemplateColumns: '92px minmax(0, 1fr)', gap: 8, alignItems: 'baseline', padding: '2px 0' },
  },
    h('div', { style: { color: T.textFaint, fontSize: T.fsXs } }, label),
    h('div', {
      style: {
        minWidth: 0,
        fontSize: T.fsSm,
        color: T.text,
        fontFamily: mono === true ? T.mono : 'inherit',
        whiteSpace: wrap === false ? 'nowrap' : 'normal',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        wordBreak: 'break-word',
      },
    }, children))
}

/** A selectable run-configuration card. */
function ConfigCard({ config, selected, onSelect }) {
  const [hover, bind] = useHover()
  const sourceKey = config.source === 'launch.json' ? 'runtime.configSourceLaunch' : config.source === 'entry' ? 'runtime.configSourceEntry' : 'runtime.configSourceManual'
  const defines = config.dartDefines !== null && typeof config.dartDefines === 'object' ? Object.keys(config.dartDefines).length : 0
  return h('button', {
    type: 'button',
    onClick: onSelect,
    ...bind,
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 3,
      width: '100%',
      textAlign: 'left',
      padding: '7px 9px',
      borderRadius: T.radiusSm,
      border: `1px solid ${selected === true ? T.brand : T.border}`,
      background: selected === true ? T.selected : hover ? T.hover : 'transparent',
      color: T.text,
      cursor: 'pointer',
    },
  },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, width: '100%' } },
      h('span', { style: { flex: 1, minWidth: 0, fontWeight: 600, fontSize: T.fsSm, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, config.label ?? config.id),
      config.source === undefined ? null : h(Pill, { tone: config.source === 'launch.json' ? 'info' : 'neutral' }, t(sourceKey))),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: T.fsXs, color: T.textFaint } },
      h('span', { style: { fontFamily: T.mono } }, config.program ?? 'lib/main.dart'),
      config.mode === undefined ? null : h('span', null, `· ${config.mode}`),
      config.deviceId === undefined || config.deviceId === null || config.deviceId === '' ? null : h('span', null, `· ${config.deviceId}`),
      h('span', null, `· ${t('runtime.definesCount', { n: defines })}`)))
}

/**
 * Runtime page: project/config/device/mode pickers, run controls with an
 * optimistic phase, the live run detail and the recent-run summary.
 * @param {{state: object, actions: object}} props page props from the shell.
 * @returns {any} page element.
 */
function RuntimePage({ state: sharedState, actions: sharedActions }) {
  ensureStyles()
  const s = sharedState ?? {}
  const a = sharedActions ?? s.actions ?? {}
  const draft = s.draft ?? {}
  const configs = s.configs ?? []
  const devices = s.devices ?? []
  const projects = s.projects ?? []
  const runs = s.runs ?? []
  const activeRun = runs.find((run) => run.runId === s.activeRunId) ?? null
  const [pending, setPending] = React.useState(null)
  const [defineRows, setDefineRows] = React.useState(() => definesToRows(draft.dartDefines))
  const [argsText, setArgsText] = React.useState(draft.args ?? '')
  const [addPath, setAddPath] = React.useState('')
  const [addOpen, setAddOpen] = React.useState(false)
  const [addBusy, setAddBusy] = React.useState(false)
  const [now, setNow] = React.useState(() => Date.now())

  /* Re-seed the local editors when the draft jumps to another config. */
  const draftKey = `${draft.projectId ?? ''}|${draft.configId ?? ''}`
  React.useEffect(() => {
    setDefineRows(definesToRows(draft.dartDefines))
    setArgsText(String(draft.args ?? ''))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey])

  /* Clear the optimistic phase as soon as the host reports a new one. */
  const livePhase = activeRun?.phase ?? 'idle'
  React.useEffect(() => { setPending(null) }, [livePhase, activeRun?.runId])

  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const displayPhase = pending ?? livePhase
  const busy = displayPhase === 'starting' || displayPhase === 'stopping'
  const live = isLivePhase(displayPhase)
  const canStart = s.activeProjectId !== undefined && s.activeProjectId !== null && busy !== true && displayPhase !== 'stopping'

  const runWith = (phase, task, failKey) => async () => {
    setPending(phase)
    try {
      await task()
    } catch (error) {
      a.toast?.(t(failKey, { message: error?.message ?? String(error) }), 'error')
    } finally {
      setPending(null)
    }
  }

  const onStart = runWith('starting', async () => {
    const data = await (a.startRun === undefined
      ? Promise.reject(new Error(t('common.error')))
      : a.startRun())
    if (data?.runId !== undefined) a.toast?.(t('runtime.started', { id: data.runId }), 'ok')
  }, 'runtime.startFailed')

  const onStop = runWith('stopping', async () => {
    const data = await (a.stopRun === undefined ? Promise.reject(new Error(t('common.error'))) : a.stopRun())
    a.toast?.(t('runtime.stopped', { n: (data?.stopped ?? []).length ?? 0 }), 'ok')
  }, 'runtime.stopFailed')

  const onReload = runWith('reloading', async () => {
    await (a.hotReload === undefined ? Promise.reject(new Error(t('common.error'))) : a.hotReload())
    a.toast?.(t('runtime.reloaded'), 'ok')
  }, 'runtime.reloadFailed')

  const onRestart = runWith('restarting', async () => {
    await (a.hotRestart === undefined ? Promise.reject(new Error(t('common.error'))) : a.hotRestart())
    a.toast?.(t('runtime.restarted'), 'ok')
  }, 'runtime.restartFailed')

  const rescan = async () => {
    try {
      await (a.loadConfigs === undefined
        ? Promise.reject(new Error(t('common.error')))
        : a.loadConfigs(s.activeProjectId))
    } catch (error) {
      a.toast?.(t('runtime.configLoadFailed', { message: error?.message ?? String(error) }), 'error')
    }
  }

  const submitAddProject = async () => {
    const path = addPath.trim()
    if (path === '') {
      a.toast?.(t('shell.addProjectEmpty'), 'warn')
      return
    }
    setAddBusy(true)
    try {
      const data = await (a.addProject === undefined ? Promise.reject(new Error(t('common.error'))) : a.addProject(path))
      a.toast?.(t('shell.projectAdded', { name: data?.project?.name ?? path }), 'ok')
      setAddOpen(false)
      setAddPath('')
    } catch (error) {
      a.toast?.(t('common.actionFailed', { message: error?.message ?? String(error) }), 'error')
    } finally {
      setAddBusy(false)
    }
  }

  /* Keep the draft in sync with the local define/args editors. */
  const commitDefines = (rows) => {
    setDefineRows(rows)
    a.setDraft?.({ dartDefines: rowsToDefines(rows) })
  }
  const commitArgs = (text) => {
    setArgsText(text)
    a.setDraft?.({ args: text })
  }

  const deviceOptions = devices.map((device) => ({
    value: device.id,
    label: `${device.name ?? device.id}${device.platform === undefined ? '' : ` · ${device.platform}`}${device.emulator === true ? ' · emu' : ''}`,
  }))

  const vmUri = activeRun?.vmServiceUri ?? null
  const devtoolsUrl = activeRun?.devtoolsUrl !== null && activeRun?.devtoolsUrl !== undefined
    ? activeRun.devtoolsUrl
    : (vmUri === null ? null : `https://devtools.flutter.dev/?uri=${encodeURIComponent(vmUri)}`)
  const uptime = activeRun === null
    ? 0
    : (activeRun.finishedAt === null || activeRun.finishedAt === undefined ? now : activeRun.finishedAt) - (activeRun.startedAt ?? now)

  const pickProject = async (value) => {
    if (value === '') return
    try {
      await (a.selectProject === undefined ? Promise.reject(new Error(t('common.error'))) : a.selectProject(value))
    } catch (error) {
      a.toast?.(t('common.actionFailed', { message: error?.message ?? String(error) }), 'error')
    }
  }

  const recentRuns = runs.slice(-6).reverse()

  /* ---- left column: controls ---------------------------------------- */
  const left = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, padding: 12, minWidth: 0 } },
    h(Card, {
      title: t('runtime.controls'),
      subtitle: t('runtime.subtitle'),
      right: h(IconBtn, { icon: 'refresh', title: t('runtime.refreshConfigs'), onClick: rescan }),
    },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        /* project */
        h(Field, { label: t('runtime.project'), hint: projects.length === 0 ? t('runtime.noProject') : t('runtime.projectHint') },
          h('div', { style: { display: 'flex', gap: 6 } },
            h(Select, {
              value: s.activeProjectId ?? '',
              options: projects.map((project) => ({ value: project.id, label: project.name ?? project.path ?? project.id })),
              placeholder: projects.length === 0 ? t('shell.noProject') : t('shell.projectPlaceholder'),
              onChange: (value) => { void pickProject(value) },
            }),
            h(IconBtn, { icon: 'plus', title: t('shell.addProject'), onClick: () => setAddOpen(true) }))),
        /* configs */
        h(Field, { label: t('runtime.config'), hint: configs.length === 0 ? t('runtime.configEmptyHint') : undefined },
          s.configLoading === true
            ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, color: T.textDim, fontSize: T.fsSm } }, h(Spinner, null), t('common.loading'))
            : configs.length === 0
              ? h(Empty, { text: t('runtime.configEmpty'), compact: true })
              : h('div', { className: 'fwb-scroll', style: { display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 220, overflow: 'auto' } },
                configs.map((config) => h(ConfigCard, {
                  key: config.id ?? config.label,
                  config,
                  selected: config.id === draft.configId,
                  onSelect: () => a.setDraft?.({
                    configId: config.id ?? null,
                    program: config.program ?? '',
                    deviceId: config.deviceId ?? '',
                    mode: config.mode ?? 'debug',
                    flavor: config.flavor ?? '',
                    dartDefines: config.dartDefines ?? {},
                    args: Array.isArray(config.args) ? config.args.join(' ') : '',
                  }),
                })))),
        /* device */
        h(Field, { label: t('runtime.device'), hint: devices.length === 0 ? t('runtime.noDevice') : t('runtime.deviceCount', { n: devices.length }) },
          h('div', { style: { display: 'flex', gap: 6 } },
            h(Select, {
              value: draft.deviceId ?? '',
              options: deviceOptions,
              placeholder: devices.length === 0 ? t('device.none') : t('device.select'),
              onChange: (value) => a.setDraft?.({ deviceId: value }),
            }),
            h(IconBtn, { icon: 'refresh', title: t('runtime.deviceRefresh'), onClick: rescan }))),
        /* mode */
        h(Field, { label: t('runtime.mode'), hint: draft.mode === 'release' ? t('runtime.modeReleaseHint') : draft.mode === 'profile' ? t('runtime.modeProfileHint') : t('runtime.modeDebugHint') },
          h('div', { style: { display: 'flex', gap: 4 } },
            ['debug', 'profile', 'release'].map((mode) => h(Chip, {
              key: mode,
              active: draft.mode === mode,
              onClick: () => a.setDraft?.({ mode }),
            }, mode)))),
        /* flavor + program */
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } },
          h(Field, { label: t('runtime.flavor'), hint: t('runtime.flavorHint') },
            h(Input, { value: draft.flavor ?? '', onChange: (value) => a.setDraft?.({ flavor: value }), placeholder: 'dev', size: 'sm' })),
          h(Field, { label: t('runtime.program'), hint: t('runtime.programHint') },
            h(Input, { value: draft.program ?? '', onChange: (value) => a.setDraft?.({ program: value }), placeholder: 'lib/main.dart', mono: true, size: 'sm' }))),
        /* dart defines */
        h(Field, { label: t('runtime.dartDefines') },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            defineRows.length === 0
              ? h('div', { style: { fontSize: T.fsXs, color: T.textFaint } }, t('runtime.dartDefinesEmpty'))
              : defineRows.map((row, index) => h('div', { key: index, style: { display: 'grid', gridTemplateColumns: '1fr 1fr 24px', gap: 4 } },
                h(Input, {
                  value: row.key,
                  placeholder: t('runtime.defineKey'),
                  size: 'sm',
                  mono: true,
                  onChange: (value) => commitDefines(defineRows.map((item, itemIndex) => (itemIndex === index ? { ...item, key: value } : item))),
                }),
                h(Input, {
                  value: row.value,
                  placeholder: t('runtime.defineValue'),
                  size: 'sm',
                  mono: true,
                  onChange: (value) => commitDefines(defineRows.map((item, itemIndex) => (itemIndex === index ? { ...item, value } : item))),
                }),
                h(IconBtn, {
                  icon: 'minus',
                  size: 24,
                  title: t('common.remove'),
                  onClick: () => commitDefines(defineRows.filter((item, itemIndex) => itemIndex !== index)),
                }))),
            h('div', null,
              h(Btn, {
                size: 'sm',
                icon: 'plus',
                onClick: () => commitDefines([...defineRows, { key: '', value: '' }]),
              }, t('runtime.addDefine'))))),
        /* args */
        h(Field, { label: t('runtime.args'), hint: t('runtime.argsHint') },
          h(Input, { value: argsText, onChange: commitArgs, placeholder: '--verbose', mono: true })),

        /* run configuration warnings */
        (s.configWarnings ?? []).length === 0 ? null : h('div', {
          style: {
            display: 'flex', flexDirection: 'column', gap: 3, padding: '6px 8px',
            borderRadius: T.radiusSm, border: `1px solid color-mix(in srgb, ${T.warn} 40%, transparent)`,
            background: `color-mix(in srgb, ${T.warn} 10%, transparent)`, color: T.warnLabel, fontSize: T.fsXs,
          },
        },
          h('div', { style: { fontWeight: 600 } }, t('runtime.warnings')),
          (s.configWarnings ?? []).map((warning, index) => h('div', { key: index }, `· ${warning}`))),

        h('div', { style: { fontSize: T.fsXs, color: T.textFaint, fontFamily: T.mono, wordBreak: 'break-all' } },
          s.launchFile === null || s.launchFile === undefined
            ? t('runtime.launchFileNone')
            : t('runtime.launchFile', { path: s.launchFile })),

        /* toolbar */
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', paddingTop: 2 } },
          h(Btn, { kind: 'primary', icon: 'play', disabled: !canStart, onClick: onStart, title: t('runtime.start') },
            pending === 'starting' ? t('runtime.starting') : t('runtime.start')),
          h(Btn, { icon: 'stop', disabled: live !== true || busy === true, onClick: onStop }, t('runtime.stop')),
          h(Btn, { icon: 'reload', disabled: displayPhase !== 'running', onClick: onReload }, t('runtime.reload')),
          h(Btn, { icon: 'restart', disabled: displayPhase !== 'running', onClick: onRestart }, t('runtime.restart')),
          pending === null ? null : h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5, color: T.textDim, fontSize: T.fsXs } },
            h(Spinner, { size: 11 }),
            t(`phase.${pending}`, {}))))))

  /* ---- right column: live run + recent --------------------------------- */
  const detail = activeRun === null
    ? h(Empty, {
      icon: 'play',
      title: t('run.noActiveTitle'),
      body: t('run.noActiveBody'),
      action: h(Btn, { kind: 'primary', icon: 'play', disabled: !canStart, onClick: onStart }, t('runtime.start')),
    })
    : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
      h(RunDetailRow, { label: t('run.phase') },
        h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
          h(Pill, { tone: statusTone(displayPhase), dot: true }, t(`phase.${displayPhase}`, {})),
          pending === null ? null : h(Spinner, { size: 11 }))),
      h(RunDetailRow, { label: t('run.id'), mono: true }, activeRun.runId ?? t('common.notAvailable')),
      h(RunDetailRow, { label: t('run.project') }, activeRun.projectPath ?? activeRun.projectId ?? t('common.notAvailable')),
      h(RunDetailRow, { label: t('run.program'), mono: true }, activeRun.config?.program ?? draft.program ?? t('common.notAvailable')),
      h(RunDetailRow, { label: t('run.device') }, activeRun.device === null || activeRun.device === undefined
        ? t('shell.deviceMissing')
        : `${activeRun.device.name ?? activeRun.device.id}${activeRun.device.platform === undefined ? '' : ` · ${activeRun.device.platform}`}`),
      h(RunDetailRow, { label: t('runtime.mode') }, activeRun.config?.mode ?? t('common.notAvailable')),
      h(RunDetailRow, { label: t('run.pid') }, activeRun.pid === null || activeRun.pid === undefined ? t('common.notAvailable') : String(activeRun.pid)),
      h(RunDetailRow, { label: t('run.startedAt') }, formatTime(activeRun.startedAt, { date: true })),
      h(RunDetailRow, { label: t('run.duration') }, formatDuration(Math.max(0, uptime))),
      h(RunDetailRow, { label: t('run.exitCode') }, activeRun.exitCode === null || activeRun.exitCode === undefined
        ? t('common.notAvailable')
        : h('span', { style: { color: activeRun.exitCode === 0 ? T.ok : T.error } }, String(activeRun.exitCode))),
      h(RunDetailRow, { label: t('run.hotReloads') }, t('run.count', { n: activeRun.hotReloads ?? 0 })),
      h(RunDetailRow, { label: t('run.hotRestarts') }, t('run.count', { n: activeRun.hotRestarts ?? 0 })),
      h(RunDetailRow, { label: t('run.appId') }, activeRun.appId ?? t('common.notAvailable')),
      h(RunDetailRow, { label: t('run.vmService') },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flexWrap: 'wrap' } },
          h(Mono, { size: T.fsXs, dim: true, style: { flex: 1, minWidth: 120 } }, vmUri ?? t('shell.vmUriMissing')),
          vmUri === null ? null : h(IconBtn, {
            icon: 'copy',
            title: t('shell.copyVmUri'),
            onClick: async () => {
              const ok = await copyText(vmUri)
              a.toast?.(ok ? t('common.copied') : t('common.copyFailed'), ok ? 'ok' : 'error')
            },
          }),
          devtoolsUrl === null ? null : h('a', {
            href: devtoolsUrl,
            target: '_blank',
            rel: 'noreferrer noopener',
            title: t('runtime.openDevtools'),
            style: {
              display: 'inline-flex', alignItems: 'center', gap: 4, height: 22, padding: '0 7px',
              borderRadius: T.radiusSm, border: `1px solid ${T.border}`, color: T.text,
              textDecoration: 'none', fontSize: T.fsXs,
            },
          }, h(Icon, { name: 'external', size: 11 }), t('shell.devtools')))),
      activeRun.httpUri === null || activeRun.httpUri === undefined ? null : h(RunDetailRow, { label: t('run.httpUri'), mono: true }, activeRun.httpUri),
      activeRun.error === null || activeRun.error === undefined ? null : h(RunDetailRow, { label: t('run.error') },
        h('span', { style: { color: T.error, wordBreak: 'break-word' } }, activeRun.error)))

  const right = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 12px 12px 0', minWidth: 0 } },
    h(Card, { title: t('run.active'), right: activeRun === null ? null : h(Pill, { tone: statusTone(displayPhase) }, t(`phase.${displayPhase}`, {})) }, detail),
    h(Card, { title: t('run.recent'), subtitle: recentRuns.length === 0 ? t('runtime.recentEmpty') : undefined },
      h(Table, {
        dense: true,
        maxHeight: 260,
        rows: recentRuns,
        rowKey: (row) => row.runId,
        empty: h(Empty, { text: t('run.empty'), compact: true }),
        columns: [
          {
            key: 'phase',
            label: t('run.phase'),
            width: 92,
            render: (row) => h(Pill, { tone: statusTone(row.phase) }, t(`phase.${row.phase}`, {})),
          },
          { key: 'runId', label: t('run.id'), mono: true, width: 110 },
          { key: 'projectPath', label: t('run.project'), dim: true, render: (row) => truncate(row.projectPath ?? row.projectId ?? '—', 34) },
          { key: 'startedAt', label: t('run.startedAt'), width: 70, nowrap: true, render: (row) => formatTime(row.startedAt, { clock: true }) },
          {
            key: 'duration',
            label: t('run.duration'),
            width: 78,
            nowrap: true,
            render: (row) => formatDuration(Math.max(0, (row.finishedAt ?? now) - (row.startedAt ?? now))),
          },
          {
            key: 'exitCode',
            label: t('run.exitCode'),
            width: 62,
            nowrap: true,
            render: (row) => (row.exitCode === null || row.exitCode === undefined
              ? t('common.notAvailable')
              : h('span', { style: { color: row.exitCode === 0 ? T.ok : T.error } }, String(row.exitCode))),
          },
        ],
      })))

  return h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', minHeight: 0 } },
    h('div', { style: { flex: '0 1 420px', minWidth: 320, maxWidth: 460, minHeight: 0 } }, left),
    h('div', { style: { flex: '1 1 480px', minWidth: 320, minHeight: 0 } }, right),
    addOpen ? h(Modal, {
      title: t('shell.addProjectTitle'),
      onClose: () => setAddOpen(false),
      width: 520,
      footer: [
        h(Btn, { key: 'cancel', onClick: () => setAddOpen(false) }, t('common.cancel')),
        h(Btn, { key: 'add', kind: 'primary', disabled: addBusy, onClick: submitAddProject }, addBusy ? t('common.loading') : t('common.add')),
      ],
    },
      h(Field, { label: t('runtime.project'), hint: t('shell.addProjectHint') },
        h(Input, {
          value: addPath,
          onChange: setAddPath,
          onEnter: submitAddProject,
          placeholder: t('shell.addProjectPlaceholder'),
          mono: true,
          autoFocus: true,
        }))) : null)
}