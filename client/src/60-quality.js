/* ====================================================================== *
 * 60-quality.js — owner: dev-ui-data
 *
 * QualityPage: analyzer, tests, deduped exceptions, frames/jank, screenshot.
 * SettingsPage: every host setting as a typed control plus the MCP connection
 *               block (endpoint URL, token with copy/rotate, client hints).
 *
 * Host surface used (docs/CONTRACTS.md §6, §7):
 *   POST /toolchain { action:'analyze'|'test' } → { jobId }
 *   GET  /job?id=              → { job:{ id, action, status, result, error } }
 *   GET  /errors               → { groups:[ErrorGroup] }
 *   GET  /settings, POST /settings { patch }
 *   POST /screenshot           → { path, bytes, width, height } | { base64, mime }
 *   POST /open { file, line }  → editor jump (falls back to copying path:line)
 *   GET  /perf?runId=          → frame stats (no contract route; degrades cleanly)
 *
 * Kit surface consumed: Btn, IconBtn, Pill, Chip, Card, Field, Input, TextArea,
 * Select, Checkbox, Empty, Spinner, Mono, t. Shared helpers come from
 * 40-network.js and 50-board.js.
 * ====================================================================== */

/* ------------------------------------------------------------ constants -- */

const FWB_MCP_PATH = '/api/flutter-workbench/mcp'
const FWB_QUALITY_TABS = ['analyze', 'test', 'errors', 'perf', 'screenshot']
const FWB_SEVERITIES = ['error', 'warning', 'info']

/**
 * Fallback setting schema. GET /settings may include `descriptor`
 * (host/settings.js SETTING_SPEC); when it does not, the type is inferred from
 * the value and these defaults keep pickers/numbers sane.
 */
const FWB_SETTINGS_SPEC = {
  flutterPath: { type: 'string' },
  dartPath: { type: 'string' },
  editorCommand: { type: 'string' },
  dataDir: { type: 'string' },
  defaultProvider: { type: 'string' },
  defaultModel: { type: 'string' },
  logCapacity: { type: 'number' },
  autoRefreshMs: { type: 'number' },
  networkAutoRefreshMs: { type: 'number' },
  maxTaskConcurrency: { type: 'number' },
  autoStart: { type: 'boolean' },
  analysisEnabled: { type: 'boolean' },
  mcpEnabled: { type: 'boolean' },
  mcpToken: { type: 'string', secret: true },
}

/* -------------------------------------------------------------- helpers -- */

function fwbSeverityTone(severity) {
  if (severity === 'error') return 'error'
  if (severity === 'warning') return 'warn'
  if (severity === 'info') return 'info'
  return 'neutral'
}

function fwbSeverityLabel(severity) {
  if (severity === 'error') return t('quality.severity.error')
  if (severity === 'warning') return t('quality.severity.warning')
  if (severity === 'info') return t('quality.severity.info')
  return String(severity ?? '')
}

/** Jump to `file:line` through the editor action, falling back to a copy. */
function fwbJumpToFile(act, push, file, line) {
  const target = String(file ?? '')
  if (target === '') return
  const at = Number(line)
  const safeLine = Number.isFinite(at) && at > 0 ? at : undefined
  fwbInvoke(act, 'openFile', [target, safeLine], () => api('/open', { method: 'POST', body: { file: target, line: safeLine } }))
    .catch(async (issue) => {
      const copy = await fwbCopy(`${target}${safeLine === undefined ? '' : `:${safeLine}`}`)
      push(`${t('quality.openFailed')}: ${String(issue?.message ?? issue)}${copy === true ? ` ${t('quality.pathCopied')}` : ''}`, 'error')
    })
}

/** File path + line cell used by the analyzer and exception panes. */
function FwbFileLink({ file, line, column, act, push }) {
  const path = String(file ?? '')
  if (path === '') return null
  const where = `${path}${Number.isFinite(Number(line)) ? `:${line}` : ''}${Number.isFinite(Number(column)) ? `:${column}` : ''}`
  return h(Btn, {
    kind: 'text',
    title: t('quality.jumpHint', { where }),
    onClick: () => fwbJumpToFile(act, push, path, line),
    style: {
      padding: '1px 4px', border: 'none', background: 'transparent',
      color: T.brand, fontFamily: T.mono, fontSize: 11, cursor: 'pointer',
      textAlign: 'left', overflowWrap: 'anywhere', maxWidth: '100%',
    },
  }, where)
}

/**
 * Async toolchain runner: POST /toolchain returns a job id, then GET /job is
 * polled until the job leaves `running`.
 */
function useFwbJob(act) {
  const [job, setJob] = React.useState(null)
  const [starting, setStarting] = React.useState(false)
  const [error, setError] = React.useState(null)

  const run = React.useCallback(async (body) => {
    setStarting(true)
    setError(null)
    setJob(null)
    try {
      const response = await fwbInvoke(act, 'runToolchain', [body], () => api('/toolchain', { method: 'POST', body }))
      const id = response?.jobId ?? response?.job?.id ?? null
      if (id === null || id === undefined || id === '') {
        throw Object.assign(new Error(t('quality.noJob')), { code: 'no-job' })
      }
      setJob({ id, action: body?.action ?? '', status: 'running' })
    } catch (issue) {
      setError(issue)
      setStarting(false)
    }
  }, [act])

  const jobId = job?.id ?? null
  const jobStatus = job?.status ?? null

  React.useEffect(() => {
    if (jobId === null || jobStatus !== 'running') return undefined
    let cancelled = false
    let timer = null
    const tick = async () => {
      try {
        const response = await fwbInvoke(act, 'getJob', [jobId], () => api('/job', { query: { id: jobId } }))
        const next = response?.job ?? response ?? null
        if (cancelled === true) return
        if (next === null || typeof next !== 'object') {
          setError(Object.assign(new Error(t('quality.noJob')), { code: 'no-job' }))
          setStarting(false)
          return
        }
        setJob(next)
        if (next?.status === 'running') timer = setTimeout(tick, 700)
        else setStarting(false)
      } catch (issue) {
        if (cancelled === true) return
        setError(issue)
        setStarting(false)
      }
    }
    timer = setTimeout(tick, 400)
    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
    }
  }, [jobId, jobStatus, act])

  const reset = React.useCallback(() => {
    setJob(null)
    setError(null)
    setStarting(false)
  }, [])

  return { job, running: starting === true || jobStatus === 'running', error, run, reset }
}

/** Project selector shared by the analyze/test panes. */
function FwbProjectPicker({ projects, value, onChange }) {
  const list = Array.isArray(projects) ? projects : []
  if (list.length <= 1) {
    const only = list.find((project) => String(project?.id ?? '') === String(value ?? '')) ?? list[0] ?? null
    return h('span', { style: { color: T.textDim, fontSize: 11 } },
      only === null ? t('quality.noProject') : `📁 ${String(only.name ?? only.path ?? only.id ?? '')}`)
  }
  return h(Select, {
    value: String(value ?? ''),
    onChange: (next) => onChange(String(fwbReadValue(next) ?? '')),
    options: list.map((project) => ({ value: String(project?.id ?? ''), label: String(project?.name ?? project?.id ?? '') })),
    style: { minWidth: 150 },
  })
}

/** Job status strip (idle / running / failed) for a toolchain pane. */
function FwbJobStatus({ job, running, error, onRetry }) {
  if (error !== null && error !== undefined) {
    return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', color: T.error, fontSize: 12 } },
      h('span', { style: { flex: 1, minWidth: 0, overflowWrap: 'anywhere' } }, `${t('quality.jobFailed')}: ${String(error?.message ?? error)}`),
      typeof onRetry === 'function' ? h(Btn, { onClick: onRetry }, t('common.retry')) : null)
  }
  if (running === true) {
    return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', color: T.textDim, fontSize: 12 } },
      h(Spinner, { size: 12 }), t('quality.running'))
  }
  if (job?.status === 'failed') {
    return h('div', { style: { padding: '4px 0', color: T.error, fontSize: 12 } },
      `${t('quality.jobFailed')}: ${String(job?.error ?? '—')}`)
  }
  return null
}

/* -------------------------------------------------------------- analyze -- */

function FwbAnalyzePane({ state, act, push }) {
  const job = useFwbJob(act)
  const [projectId, setProjectId] = React.useState(String(state?.activeProjectId ?? ''))
  const [showRaw, setShowRaw] = React.useState(false)

  const result = job.job?.result ?? null
  const issues = Array.isArray(result?.issues) ? result.issues : []
  const counts = result?.counts ?? null

  const groups = React.useMemo(() => {
    const map = new Map(FWB_SEVERITIES.map((severity) => [severity, []]))
    for (const issue of issues) {
      const severity = String(issue?.severity ?? 'info')
      if (map.has(severity) === false) map.set(severity, [])
      map.get(severity).push(issue)
    }
    return [...map.entries()].filter(([, list]) => list.length > 0)
  }, [issues])

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: 10, minHeight: 0 } },
    h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } },
      h(FwbProjectPicker, { projects: state?.projects, value: projectId, onChange: setProjectId }),
      h(Btn, {
        kind: 'primary',
        disabled: job.running === true,
        onClick: () => job.run({ action: 'analyze', projectId: projectId === '' ? undefined : projectId }),
      }, job.running === true ? t('quality.analyzing') : t('quality.runAnalyze')),
      counts !== null
        ? h('div', { style: { display: 'flex', gap: 6 } },
          h(Pill, { tone: 'error', style: { color: T.error } }, `${t('quality.severity.error')} ${Number(counts.error ?? 0)}`),
          h(Pill, { tone: 'warn', style: { color: T.warn } }, `${t('quality.severity.warning')} ${Number(counts.warning ?? 0)}`),
          h(Pill, { tone: 'info' }, `${t('quality.severity.info')} ${Number(counts.info ?? 0)}`))
        : null,
      h('div', { style: { flex: 1 } }),
      result?.raw !== undefined ? h(Btn, { onClick: () => setShowRaw((value) => value !== true) }, showRaw === true ? t('quality.hideRaw') : t('quality.showRaw')) : null),

    h(FwbJobStatus, { job: job.job, running: job.running, error: job.error, onRetry: () => job.run({ action: 'analyze', projectId: projectId === '' ? undefined : projectId }) }),

    job.job?.status === 'done' && issues.length === 0
      ? h(Card, { style: { padding: 16, textAlign: 'center', color: T.ok } }, t('quality.analyzeClean'))
      : null,

    issues.length === 0 ? (job.job?.status === 'done' ? null : h(Empty, { text: t('quality.analyzeHint') })) : null,

    h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 } },
      groups.map(([severity, list]) => h(Card, {
        key: severity,
        title: `${fwbSeverityLabel(severity)} · ${list.length}`,
        style: { padding: 8 },
      },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
          list.map((issue, index) => h('div', {
            key: `${severity}-${index}`,
            style: { display: 'flex', gap: 8, alignItems: 'flex-start', padding: '3px 0', borderTop: index === 0 ? 'none' : `1px solid ${T.border}` },
          },
            h(Pill, { tone: fwbSeverityTone(severity), style: { fontSize: 10, color: fwbToneColor(fwbSeverityTone(severity)), flexShrink: 0 } }, String(issue?.code ?? severity)),
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div', { style: { fontSize: 12, lineHeight: 1.5, overflowWrap: 'anywhere' } }, String(issue?.message ?? '')),
              h(FwbFileLink, { file: issue?.file, line: issue?.line, column: issue?.column, act, push })))))) ),

    showRaw === true && result?.raw !== undefined
      ? h(Card, { title: t('quality.raw'), style: { padding: 8, maxHeight: 220, overflow: 'auto' } },
        h(Mono, { style: { fontSize: 11, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, String(result.raw ?? '')))
      : null))
}

/* ----------------------------------------------------------------- test -- */

function FwbTestPane({ state, act, push }) {
  const job = useFwbJob(act)
  const [projectId, setProjectId] = React.useState(String(state?.activeProjectId ?? ''))
  const [target, setTarget] = React.useState('')
  const [name, setName] = React.useState('')
  const [onlyFailed, setOnlyFailed] = React.useState(false)
  const [expanded, setExpanded] = React.useState({})

  const result = job.job?.result ?? null
  const tests = Array.isArray(result?.tests) ? result.tests : []
  const visible = onlyFailed === true ? tests.filter((test) => test?.status === 'failed') : tests

  const runTests = () => {
    const body = { action: 'test' }
    if (projectId !== '') body.projectId = projectId
    if (target.trim() !== '') body.target = target.trim()
    if (name.trim() !== '') body.name = name.trim()
    job.run(body)
  }

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: 10, minHeight: 0 } },
    h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 } },
      h(FwbProjectPicker, { projects: state?.projects, value: projectId, onChange: setProjectId }),
      h(Input, {
        value: target,
        placeholder: t('quality.testTarget'),
        onChange: (next) => setTarget(String(fwbReadValue(next) ?? '')),
        style: { minWidth: 180, flex: 1 },
      }),
      h(Input, {
        value: name,
        placeholder: t('quality.testName'),
        onChange: (next) => setName(String(fwbReadValue(next) ?? '')),
        style: { minWidth: 140 },
      }),
      h(Btn, { kind: 'primary', disabled: job.running === true, onClick: runTests },
        job.running === true ? t('quality.testing') : t('quality.runTest'))),

    h(FwbJobStatus, { job: job.job, running: job.running, error: job.error, onRetry: runTests }),

    result !== null
      ? h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 } },
        h(Pill, { tone: 'ok', style: { color: T.ok } }, `${t('quality.passed')} ${Number(result.passed ?? 0)}`),
        h(Pill, { tone: Number(result.failed ?? 0) > 0 ? 'error' : 'neutral', style: { color: Number(result.failed ?? 0) > 0 ? T.error : T.textDim } },
          `${t('quality.failed')} ${Number(result.failed ?? 0)}`),
        h(Pill, { tone: 'neutral' }, `${t('quality.skipped')} ${Number(result.skipped ?? 0)}`),
        h(Pill, { tone: 'info' }, fwbDuration(result.durationMs)),
        h('div', { style: { flex: 1 } }),
        h(Checkbox, { checked: onlyFailed, onChange: (next) => setOnlyFailed(fwbReadValue(next) === true), label: t('quality.onlyFailed') }))
      : null,

    tests.length === 0 && job.job?.status !== 'done' ? h(Empty, { text: t('quality.testHint') }) : null,
    tests.length === 0 && job.job?.status === 'done' ? h(Card, { style: { padding: 12, color: T.textDim, fontSize: 12 } }, t('quality.noTests')) : null,

    h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 } },
      visible.map((test, index) => {
        const key = String(test?.id ?? `${test?.name ?? index}`)
        const failed = test?.status === 'failed'
        const open = expanded[key] === true
        return h('div', {
          key,
          style: {
            border: `1px solid ${failed ? T.error : T.border}`, borderRadius: T.radiusSm,
            background: T.bgRaised, padding: '5px 8px',
          },
        },
          h('div', {
            style: { display: 'flex', alignItems: 'center', gap: 8, cursor: failed ? 'pointer' : 'default' },
            onClick: () => {
              if (failed !== true) return
              setExpanded((prev) => ({ ...prev, [key]: prev[key] !== true }))
            },
          },
            h('span', { style: { color: failed ? T.error : test?.status === 'skipped' ? T.textFaint : T.ok, width: 12 } },
              failed ? '✗' : test?.status === 'skipped' ? '–' : '✓'),
            h('span', { style: { flex: 1, minWidth: 0, fontSize: 12, overflowWrap: 'anywhere' } }, String(test?.name ?? '')),
            String(test?.group ?? '') !== '' ? h('span', { style: { color: T.textFaint, fontSize: 10 } }, String(test.group)) : null,
            h('span', { style: { color: T.textFaint, fontSize: 10, fontVariantNumeric: 'tabular-nums' } }, fwbDuration(test?.durationMs)),
            failed === true ? h('span', { style: { color: T.textDim, fontSize: 10 } }, open === true ? '▾' : '▸') : null),
          failed === true && open === true
            ? h('div', { style: { marginTop: 6, borderTop: `1px solid ${T.border}`, paddingTop: 6, display: 'flex', flexDirection: 'column', gap: 6 } },
              String(test?.error ?? '') !== '' ? h(Mono, { style: { fontSize: 11, color: T.error, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, String(test.error)) : null,
              String(test?.stack ?? '') !== ''
                ? h('div', null,
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 } },
                    h('span', { style: { flex: 1, color: T.textFaint, fontSize: 10, textTransform: 'uppercase' } }, t('quality.stack')),
                    h(FwbCopyBtn, { value: String(test.stack), notify: push })),
                  h(Mono, { style: { fontSize: 11, maxHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, String(test.stack)))
                : null)
            : null)
      })))
}

/* --------------------------------------------------------------- errors -- */

function FwbErrorsPane({ state, act, push }) {
  const [kind, setKind] = React.useState('')
  const [pattern, setPattern] = React.useState('')
  const [openFp, setOpenFp] = React.useState(null)

  const query = React.useMemo(() => {
    const next = { limit: 200 }
    if (kind !== '') next.kind = kind
    if (pattern !== '') next.pattern = pattern
    return next
  }, [kind, pattern])
  const queryKey = JSON.stringify(query)
  const poll = usePoll(
    () => fwbInvoke(act, 'fetchErrors', [query], () => api('/errors', { query })),
    3000,
    [queryKey])
  const groups = Array.isArray(poll.data?.groups) ? poll.data.groups : []

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: 10, minHeight: 0 } },
    h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 } },
      h(Select, {
        value: kind,
        onChange: (next) => setKind(String(fwbReadValue(next) ?? '')),
        options: [
          { value: '', label: t('quality.allKinds') },
          { value: 'flutter', label: 'flutter' },
          { value: 'dart', label: 'dart' },
          { value: 'platform', label: 'platform' },
          { value: 'test', label: 'test' },
          { value: 'analyze', label: 'analyze' },
        ],
        style: { minWidth: 130 },
      }),
      h(Input, {
        value: pattern,
        placeholder: t('quality.errorSearch'),
        onChange: (next) => setPattern(String(fwbReadValue(next) ?? '')),
        style: { flex: 1, minWidth: 160 },
      }),
      h(Btn, { onClick: () => poll.refresh() }, t('common.refresh')),
      h('span', { style: { color: T.textFaint, fontSize: 11 } }, t('quality.groupCount', { n: Number(poll.data?.total ?? groups.length) }))),

    poll.error !== null
      ? h('div', { style: { color: T.error, fontSize: 12 } }, `${t('quality.errorsFailed')}: ${String(poll.error?.message ?? poll.error)}`)
      : null,

    groups.length === 0
      ? h(Empty, { text: t('quality.errorsEmpty') })
      : h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 } },
        groups.map((group) => {
          const key = String(group?.fp ?? group?.message ?? Math.random())
          const open = openFp === key
          const frames = Array.isArray(group?.frames) ? group.frames : []
          const tone = group?.handled === true ? 'neutral' : 'error'
          return h('div', {
            key,
            style: { border: `1px solid ${open === true ? T.borderStrong : T.border}`, borderRadius: T.radiusSm, background: T.bgRaised },
          },
            h('div', {
              style: { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 8px', cursor: 'pointer' },
              onClick: () => setOpenFp(open === true ? null : key),
            },
              h(Pill, { tone, style: { fontSize: 10, color: tone === 'error' ? T.error : T.textDim, flexShrink: 0 } }, `×${Number(group?.count ?? 1)}`),
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { style: { fontSize: 12, lineHeight: 1.5, overflowWrap: 'anywhere' } }, String(group?.message ?? '')),
                h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, color: T.textFaint, fontSize: 10, marginTop: 2 } },
                  h('span', null, String(group?.kind ?? '—')),
                  h('span', null, `${t('quality.lastAt')} ${fwbClock(group?.lastAt)} (${fwbAgo(group?.lastAt)})`),
                  h('span', null, `${t('quality.firstAt')} ${fwbClock(group?.firstAt)}`),
                  String(group?.exception ?? '') !== '' ? h('span', null, String(group.exception)) : null)),
              h('span', { style: { color: T.textDim, fontSize: 11 } }, open === true ? '▾' : '▸')),

            open === true
              ? h('div', { style: { borderTop: `1px solid ${T.border}`, padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 6 } },
                frames.length > 0
                  ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 1 } },
                    frames.slice(0, 14).map((frame, index) => h('div', { key: `frame-${index}`, style: { display: 'flex', gap: 8, alignItems: 'center' } },
                      h('span', { style: { color: T.textFaint, fontSize: 10, width: 16, textAlign: 'right' } }, String(index + 1)),
                      h(FwbFileLink, { file: frame?.file, line: frame?.line, column: frame?.column, act, push }),
                      String(frame?.symbol ?? '') !== '' ? h('span', { style: { color: T.textDim, fontSize: 10, overflowWrap: 'anywhere' } }, String(frame.symbol)) : null)))
                  : null,
                String(group?.stack ?? '') !== ''
                  ? h('div', null,
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 } },
                      h('span', { style: { flex: 1, color: T.textFaint, fontSize: 10, textTransform: 'uppercase' } }, t('quality.stack')),
                      h(FwbCopyBtn, { value: String(group.stack), notify: push })),
                    h(Mono, { style: { fontSize: 11, maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, String(group.stack)))
                  : null,
                String(group?.context ?? '') !== ''
                  ? h('div', null,
                    h('div', { style: { color: T.textFaint, fontSize: 10, textTransform: 'uppercase', marginBottom: 2 } }, t('quality.context')),
                    h(Mono, { style: { fontSize: 11, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: T.textDim } }, String(group.context)))
                  : null)
              : null)
        })))
}

/* ----------------------------------------------------------------- perf -- */

function FwbPerfPane({ state, push }) {
  const [perf, setPerf] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [loading, setLoading] = React.useState(false)
  const runId = state?.activeRunId ?? null

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      // No contract route yet; the flutter_perf tool uses the same host method.
      const response = await api('/perf', { query: runId === null ? undefined : { runId } })
      setPerf(response?.perf ?? response ?? null)
    } catch (issue) {
      setError(issue)
      setPerf(null)
    } finally {
      setLoading(false)
    }
  }

  const frames = Array.isArray(perf?.frames) ? perf.frames : []
  const jankCount = Number(perf?.jankCount ?? 0)
  const worstMs = Number(perf?.worstMs ?? 0)
  const worst = React.useMemo(
    () => [...frames].sort((a, b) => (Number(b?.elapsedMs) || 0) - (Number(a?.elapsedMs) || 0)).slice(0, 5),
    [frames])

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: 10, minHeight: 0 } },
    h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } },
      h('span', { style: { color: T.textDim, fontSize: 11 } }, runId === null ? t('quality.noActiveRun') : `run ${String(runId)}`),
      h(Btn, { kind: 'primary', disabled: loading === true, onClick: load }, loading === true ? h(Spinner, { size: 12 }) : t('quality.loadPerf')),
      perf !== null
        ? h('div', { style: { display: 'flex', gap: 6 } },
          h(Pill, { tone: 'info' }, `${t('quality.frameCount')} ${frames.length}`),
          h(Pill, { tone: jankCount > 0 ? 'warn' : 'ok', style: { color: jankCount > 0 ? T.warn : T.ok } }, `${t('quality.jankCount')} ${jankCount}`),
          h(Pill, { tone: worstMs > 16 ? 'warn' : 'ok', style: { color: worstMs > 16 ? T.warn : T.ok } }, `${t('quality.worstFrame')} ${fwbDuration(worstMs)}`))
        : null),

    error !== null
      ? h(Card, { style: { padding: 12, fontSize: 12, color: T.textDim } },
        h('div', { style: { color: T.warn, marginBottom: 4 } }, t('quality.perfUnavailable')),
        h('div', { style: { fontFamily: T.mono, fontSize: 11, overflowWrap: 'anywhere' } }, String(error?.message ?? error)))
      : null,

    perf === null && error === null ? h(Empty, { text: t('quality.perfHint') }) : null,

    worst.length > 0
      ? h(Card, { title: t('quality.worstFrames'), style: { padding: 8 } },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
          worst.map((frame, index) => h('div', { key: `worst-${index}`, style: { display: 'flex', gap: 10, fontSize: 11 } },
            h('span', { style: { color: T.textFaint, width: 42 } }, `#${String(frame?.number ?? index)}`),
            h('span', { style: { color: T.text, width: 64, textAlign: 'right' } }, fwbDuration(frame?.elapsedMs)),
            h('span', { style: { color: T.textDim } }, `build ${fwbDuration(frame?.buildMs)}`),
            h('span', { style: { color: T.textDim } }, `raster ${fwbDuration(frame?.rasterMs)}`)))))
      : null,

    frames.length > 0
      ? h(Card, { title: t('quality.allFrames'), style: { padding: 8, flex: 1, minHeight: 0, overflow: 'auto' } },
        h('div', { style: { display: 'grid', gridTemplateColumns: '48px 1fr 1fr 1fr', gap: '2px 10px', fontSize: 11 } },
          h('span', { style: { color: T.textFaint } }, '#'),
          h('span', { style: { color: T.textFaint } }, t('quality.total')),
          h('span', { style: { color: T.textFaint } }, 'build'),
          h('span', { style: { color: T.textFaint } }, 'raster'),
          frames.map((frame, index) => h(React.Fragment, { key: `frame-row-${index}` },
            h('span', { style: { color: T.textFaint } }, String(frame?.number ?? index)),
            h('span', null, fwbDuration(frame?.elapsedMs)),
            h('span', null, fwbDuration(frame?.buildMs)),
            h('span', null, fwbDuration(frame?.rasterMs))))))
      : null)
}

/* ----------------------------------------------------------- screenshot -- */

/** Candidate image URLs for a POST /screenshot payload, most direct first. */
function fwbShotSources(shot) {
  if (shot === null || shot === undefined) return []
  const list = []
  if (typeof shot.dataUrl === 'string' && shot.dataUrl.startsWith('data:')) list.push(shot.dataUrl)
  const base64 = shot.base64 ?? shot.data
  if (typeof base64 === 'string' && base64 !== '') list.push(`data:${shot.mime ?? 'image/png'};base64,${base64}`)
  if (typeof shot.path === 'string' && shot.path !== '') {
    // The host saves the PNG; serve it back same-origin (see report).
    list.push(`${API}/file?path=${encodeURIComponent(shot.path)}`)
    list.push(`${API}/screenshot/file?path=${encodeURIComponent(shot.path)}`)
  }
  return list
}

function FwbScreenshotPane({ state, act, push }) {
  const [shot, setShot] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [loading, setLoading] = React.useState(false)
  const [sourceIndex, setSourceIndex] = React.useState(0)
  const runId = state?.activeRunId ?? null

  const sources = React.useMemo(() => fwbShotSources(shot), [shot])

  React.useEffect(() => {
    setSourceIndex(0)
  }, [shot])

  const capture = async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await fwbInvoke(act, 'screenshot', [runId === null ? {} : { runId }],
        () => api('/screenshot', { method: 'POST', body: runId === null ? {} : { runId } }))
      setShot(response ?? null)
      push(t('quality.shotSaved'), 'ok')
    } catch (issue) {
      setError(issue)
      setShot(null)
    } finally {
      setLoading(false)
    }
  }

  const src = sources[sourceIndex] ?? null

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: 10, minHeight: 0 } },
    h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } },
      h(Btn, { kind: 'primary', disabled: loading === true, onClick: capture }, loading === true ? h(Spinner, { size: 12 }) : t('quality.capture')),
      shot?.path !== undefined && shot?.path !== null
        ? h('span', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
          h(Mono, { style: { fontSize: 11, color: T.textDim, overflowWrap: 'anywhere' } }, String(shot.path)),
          h(FwbCopyBtn, { value: String(shot.path), label: t('quality.copyPath'), notify: push }))
        : null,
      Number.isFinite(Number(shot?.bytes)) ? h('span', { style: { color: T.textFaint, fontSize: 11 } }, fwbBytes(shot.bytes)) : null,
      Number.isFinite(Number(shot?.width)) && Number.isFinite(Number(shot?.height))
        ? h('span', { style: { color: T.textFaint, fontSize: 11 } }, `${shot.width}×${shot.height}`)
        : null),

    error !== null
      ? h('div', { style: { color: T.error, fontSize: 12 } }, `${t('quality.shotFailed')}: ${String(error?.message ?? error)}`)
      : null,

    shot === null
      ? h(Empty, { text: t('quality.shotHint') })
      : h(Card, { style: { padding: 8, flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center' } },
        src === null
          ? h('div', { style: { color: T.textDim, fontSize: 12 } }, t('quality.shotNoSource'))
          : h('img', {
            src,
            alt: t('quality.shotAlt'),
            onError: () => {
              // Try the next candidate route before giving up.
              setSourceIndex((current) => (current + 1 < sources.length ? current + 1 : current))
            },
            style: { maxWidth: '100%', maxHeight: '100%', border: `1px solid ${T.border}`, borderRadius: T.radiusSm, background: T.bgInput },
          })))
}

/* -------------------------------------------------------------- quality -- */

function FwbQualityTabs({ value, onChange }) {
  return h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4, padding: '8px 10px', borderBottom: `1px solid ${T.border}`, flexShrink: 0 } },
    FWB_QUALITY_TABS.map((id) => h(Chip, {
      key: id,
      active: value === id,
      onClick: () => onChange(id),
    }, t(`quality.tab.${id}`))))
}

function QualityPage({ state, actions }) {
  const act = fwbActions(state, actions)
  const { notice, push, clear } = useFwbNotify(state, actions)
  const [tab, setTab] = React.useState('analyze')

  return h(FwbPage, { notice, onDismiss: clear },
    h(FwbQualityTabs, { value: tab, onChange: setTab }),
    h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto' } },
      tab === 'analyze' ? h(FwbAnalyzePane, { state, act, push }) : null,
      tab === 'test' ? h(FwbTestPane, { state, act, push }) : null,
      tab === 'errors' ? h(FwbErrorsPane, { state, act, push }) : null,
      tab === 'perf' ? h(FwbPerfPane, { state, push }) : null,
      tab === 'screenshot' ? h(FwbScreenshotPane, { state, act, push }) : null))
}

/* ------------------------------------------------------------- settings -- */

function fwbOrigin() {
  try {
    if (typeof window !== 'undefined' && window.location !== undefined) return String(window.location.origin ?? '')
  } catch (error) {
    /* non-browser */
  }
  return ''
}

/** Absolute MCP endpoint; the path must equal MCP_PATH in host/httpapi.js. */
function fwbMcpUrl(state) {
  const path = String(state?.snapshot?.mcpPath ?? state?.mcpPath ?? FWB_MCP_PATH)
  return `${fwbOrigin()}${path}`
}

function fwbMcpSnippet(url, token, flavor) {
  const entry = { type: 'http', url }
  if (String(token ?? '') !== '') entry.headers = { Authorization: `Bearer ${token}` }
  const body = flavor === 'cursor'
    ? { mcpServers: { 'flutter-workbench': entry } }
    : { servers: { 'flutter-workbench': entry } }
  try {
    return JSON.stringify(body, null, 2)
  } catch (error) {
    return '{}'
  }
}

function fwbSettingType(key, value, descriptor) {
  const declared = descriptor !== null && descriptor !== undefined ? descriptor[String(key)] : null
  const type = declared?.type
  if (type === 'number' || type === 'boolean' || type === 'string') return type
  const fallback = FWB_SETTINGS_SPEC[String(key)]?.type
  if (fallback !== undefined) return fallback
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  return 'string'
}

/** t() returns the key itself when a translation is missing — use it as a probe. */
function fwbSettingLabel(key, declared) {
  const probe = `settings.field.${String(key)}`
  const translated = t(probe)
  if (translated !== probe) return translated
  return String(declared?.label ?? key)
}

function fwbSettingHint(key, declared) {
  const probe = `settings.hint.${String(key)}`
  const translated = t(probe)
  if (translated !== probe) return translated
  const hint = declared?.hint
  return hint === undefined || hint === null ? '' : String(hint)
}

/** One typed control for a setting value. */
function FwbSettingRow({ name, value, type, onChange, disabled }) {
  if (type === 'boolean') {
    return h(Checkbox, {
      checked: value === true,
      disabled,
      onChange: (next) => onChange(fwbReadValue(next) === true),
      label: String(name),
    })
  }
  if (type === 'number') {
    return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      h(Input, {
        value: String(value ?? ''),
        type: 'number',
        onEnter: null,
        onChange: (next) => {
          const raw = fwbReadValue(next)
          const num = Number(raw)
          onChange(Number.isFinite(num) ? num : 0)
        },
        style: { width: 140 },
      }))
  }
  return h(Input, {
    value: String(value ?? ''),
    onChange: (next) => onChange(String(fwbReadValue(next) ?? '')),
    style: { width: '100%' },
  })
}

function SettingsPage({ state, actions }) {
  const act = fwbActions(state, actions)
  const { notice, push, clear } = useFwbNotify(state, actions)

  const initial = state?.settings ?? null
  const [saved, setSaved] = React.useState(initial)
  const [draft, setDraft] = React.useState(initial)
  const [descriptor, setDescriptor] = React.useState(null)
  const [loading, setLoading] = React.useState(initial === null)
  const [failure, setFailure] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [showToken, setShowToken] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    setFailure(null)
    try {
      const response = await api('/settings')
      const settings = response?.settings ?? response?.values ?? null
      setSaved(settings)
      setDraft(settings)
      setDescriptor(response?.descriptor ?? response?.spec ?? null)
    } catch (issue) {
      setFailure(issue)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  const values = draft ?? saved ?? {}
  const baseline = saved ?? {}
  const keys = React.useMemo(() => {
    const seen = new Set()
    for (const key of Object.keys(FWB_SETTINGS_SPEC)) seen.add(key)
    for (const key of Object.keys(values)) seen.add(key)
    if (descriptor !== null && descriptor !== undefined) for (const key of Object.keys(descriptor)) seen.add(key)
    return [...seen].sort()
  }, [values, descriptor])

  const dirtyKeys = keys.filter((key) => {
    if (key === 'mcpToken') return false
    const left = values[key]
    const right = baseline[key]
    return String(left) !== String(right) || typeof left !== typeof right
  })

  const setValue = (key) => (next) => setDraft((prev) => ({ ...(prev ?? {}), [key]: next }))

  const save = async () => {
    const patch = {}
    for (const key of dirtyKeys) patch[key] = values[key]
    if (Object.keys(patch).length === 0) {
      push(t('settings.nothingToSave'), 'info')
      return
    }
    setBusy(true)
    try {
      await fwbInvoke(act, 'saveSettings', [patch], () => api('/settings', { method: 'POST', body: { patch } }))
      push(t('settings.saved'), 'ok')
      await load()
    } catch (issue) {
      push(`${t('settings.saveFailed')}: ${String(issue?.message ?? issue)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const rotate = async () => {
    setBusy(true)
    try {
      const response = await fwbInvoke(act, 'rotateMcpToken', [], () => api('/settings/rotate-token', { method: 'POST', body: {} }))
      const token = response?.mcpToken ?? response?.settings?.mcpToken ?? response?.token ?? null
      if (token !== null && token !== undefined) {
        setDraft((prev) => ({ ...(prev ?? {}), mcpToken: String(token) }))
        setSaved((prev) => ({ ...(prev ?? {}), mcpToken: String(token) }))
        setShowToken(true)
      }
      push(t('settings.rotated'), 'ok')
      await load()
    } catch (issue) {
      push(`${t('settings.rotateFailed')}: ${String(issue?.message ?? issue)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const token = String(values.mcpToken ?? '')
  const mcpUrl = fwbMcpUrl(state)
  const genericKeys = keys.filter((key) => key !== 'mcpToken')

  const rows = genericKeys.map((key) => {
    const declared = descriptor !== null && descriptor !== undefined ? descriptor[String(key)] : null
    const type = fwbSettingType(key, values[key], descriptor)
    return h('div', {
      key,
      style: { display: 'flex', flexDirection: 'column', gap: 2, padding: '7px 0', borderTop: `1px solid ${T.border}` },
    },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        h('span', { style: { fontSize: 12, fontWeight: 600 } }, fwbSettingLabel(key, declared)),
        h('span', { style: { color: T.textFaint, fontSize: 10, fontFamily: T.mono } }, String(key)),
        dirtyKeys.includes(key) === true ? h(Pill, { tone: 'warn', style: { fontSize: 10, color: T.warn } }, t('settings.dirty')) : null),
      fwbSettingHint(key, declared) === '' ? null : h('div', { style: { color: T.textFaint, fontSize: 11 } }, fwbSettingHint(key, declared)),
      h('div', { style: { marginTop: 3 } },
        h(FwbSettingRow, { name: fwbSettingLabel(key, declared), value: values[key], type, onChange: setValue(key), disabled: busy })))
  })

  if (loading === true && saved === null) {
    return h(FwbPage, { notice, onDismiss: clear },
      h('div', { style: { padding: 24, textAlign: 'center', color: T.textDim } }, h(Spinner, null), ` ${t('common.loading')}`))
  }

  return h(FwbPage, { notice, onDismiss: clear },
    h('div', {
      style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: `1px solid ${T.border}`, flexShrink: 0 },
    },
      h('strong', null, t('settings.title')),
      h('div', { style: { flex: 1 } }),
      h(Btn, { onClick: load, disabled: busy }, t('common.refresh')),
      h(Btn, { onClick: () => setDraft(saved), disabled: busy || dirtyKeys.length === 0 }, t('settings.reset')),
      h(Btn, { onClick: save, kind: 'primary', disabled: busy || dirtyKeys.length === 0 },
        busy === true ? h(Spinner, { size: 12 }) : t('settings.save'))),

    h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 10 } },
      failure !== null
        ? h('div', { style: { color: T.error, fontSize: 12 } }, `${t('settings.loadFailed')}: ${String(failure?.message ?? failure)}`)
        : null,

      // ---- MCP connection block (endpoint, token, client hints) ----------
      h(Card, { title: t('settings.mcpTitle'), style: { padding: 10 } },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 } },
          h('div', { style: { color: T.textDim } }, t('settings.mcpHint')),
          h(Field, { label: t('settings.mcpUrl'), hint: t('settings.mcpUrlHint') },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
              h(Mono, { style: { flex: 1, minWidth: 0, fontSize: 11, overflowWrap: 'anywhere' } }, mcpUrl),
              h(FwbCopyBtn, { value: mcpUrl, label: t('net.copy'), notify: push }))),
          h(Field, { label: t('settings.mcpToken'), hint: t('settings.mcpTokenHint') },
            h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 } },
              h(Mono, { style: { flex: 1, minWidth: 160, fontSize: 11, overflowWrap: 'anywhere' } },
                showToken === true ? (token === '' ? t('settings.noToken') : token) : (token === '' ? t('settings.noToken') : '•'.repeat(Math.min(token.length, 32)))),
              h(Btn, { onClick: () => setShowToken((value) => value !== true) }, showToken === true ? t('settings.hide') : t('settings.show')),
              h(FwbCopyBtn, { value: token, label: t('net.copy'), notify: push, disabled: token === '' }),
              h(Btn, { onClick: rotate, kind: 'danger', disabled: busy }, t('settings.rotate'))),
            ),

          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, borderTop: `1px solid ${T.border}`, paddingTop: 8 } },
            h('div', { style: { color: T.textDim } }, t('settings.connectHint')),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                h('span', { style: { flex: 1, color: T.textFaint, fontSize: 11 } }, t('settings.vscodeLabel')),
                h(FwbCopyBtn, { value: fwbMcpSnippet(mcpUrl, token, 'vscode'), notify: push })),
              h(Mono, { style: { fontSize: 11, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 150, overflow: 'auto' } }, fwbMcpSnippet(mcpUrl, token, 'vscode'))),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                h('span', { style: { flex: 1, color: T.textFaint, fontSize: 11 } }, t('settings.cursorLabel')),
                h(FwbCopyBtn, { value: fwbMcpSnippet(mcpUrl, token, 'cursor'), notify: push })),
              h(Mono, { style: { fontSize: 11, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 150, overflow: 'auto' } }, fwbMcpSnippet(mcpUrl, token, 'cursor')))))),

      // ---- every other setting, typed ------------------------------------
      h(Card, { title: t('settings.all'), style: { padding: 10 } },
        rows.length === 0 ? h(Empty, { text: t('settings.empty') }) : h('div', { style: { display: 'flex', flexDirection: 'column' } }, rows)),

      h('div', { style: { color: T.textFaint, fontSize: 11 } }, t('settings.dataDirHint'))))
}

/* ------------------------------------------------------------- locale -- */

fwbExtendLocale({
  'quality.tab.analyze': '分析',
  'quality.tab.test': '测试',
  'quality.tab.errors': '异常',
  'quality.tab.perf': '性能',
  'quality.tab.screenshot': '截图',
  'quality.severity.error': '错误',
  'quality.severity.warning': '警告',
  'quality.severity.info': '提示',
  'quality.runAnalyze': '运行分析',
  'quality.analyzing': '分析中…',
  'quality.analyzeClean': '没有发现任何问题 🎉',
  'quality.analyzeHint': '对当前项目运行 dart analyze，结果按严重程度分组显示。',
  'quality.showRaw': '显示原始输出',
  'quality.hideRaw': '隐藏原始输出',
  'quality.raw': '原始输出',
  'quality.runTest': '运行测试',
  'quality.testing': '测试中…',
  'quality.testHint': '运行 flutter test，失败用例会带上错误与堆栈。',
  'quality.testTarget': '测试文件或目录（可选）',
  'quality.testName': '按用例名过滤（可选）',
  'quality.passed': '通过',
  'quality.failed': '失败',
  'quality.skipped': '跳过',
  'quality.onlyFailed': '只看失败',
  'quality.noTests': '没有测试结果',
  'quality.stack': '堆栈',
  'quality.context': '上下文',
  'quality.groupCount': '共 {n} 组',
  'quality.allKinds': '全部类型',
  'quality.errorSearch': '搜索异常信息',
  'quality.errorsEmpty': '还没有捕获到异常',
  'quality.errorsFailed': '加载异常失败',
  'quality.firstAt': '首次',
  'quality.lastAt': '最后',
  'quality.jobFailed': '任务失败',
  'quality.noJob': '任务没有返回 id',
  'quality.running': '执行中…',
  'quality.noProject': '还没有打开项目',
  'quality.loadPerf': '拉取帧统计',
  'quality.perfHint': '从运行中的应用读取帧耗时：build / raster 与掉帧数。',
  'quality.perfUnavailable': '帧统计接口暂不可用（宿主还没有 /perf 路由）',
  'quality.frameCount': '帧数',
  'quality.jankCount': '掉帧',
  'quality.worstFrame': '最差帧',
  'quality.worstFrames': '最差帧 TOP 5',
  'quality.allFrames': '全部帧',
  'quality.total': '总耗时',
  'quality.noActiveRun': '当前没有运行中的实例',
  'quality.capture': '截取当前界面',
  'quality.shotSaved': '已截图',
  'quality.shotFailed': '截图失败',
  'quality.shotHint': '点击「截取当前界面」通过 VM Service 保存一张 PNG。',
  'quality.shotNoSource': '宿主返回了路径但没有可用的图片源（需要 /file 路由或 base64）',
  'quality.shotAlt': '应用截图',
  'quality.copyPath': '复制路径',
  'quality.openFailed': '无法在编辑器中打开',
  'quality.pathCopied': '已复制路径:行号',
  'quality.jumpHint': '在编辑器中打开 {where}',
  'settings.title': '设置',
  'settings.all': '全部设置项',
  'settings.save': '保存',
  'settings.saved': '已保存',
  'settings.saveFailed': '保存失败',
  'settings.reset': '撤销修改',
  'settings.dirty': '已修改',
  'settings.nothingToSave': '没有需要保存的修改',
  'settings.loadFailed': '加载设置失败',
  'settings.empty': '宿主没有返回任何设置项',
  'settings.dataDirHint': '这些值由插件保存，覆盖 cordis.patch.yml 里的默认值。',
  'settings.mcpTitle': 'MCP 连接',
  'settings.mcpHint': '外部 MCP 客户端（VS Code / Cursor）用下面的 URL 和令牌连接这个工作台。',
  'settings.mcpUrl': 'MCP 端点',
  'settings.mcpUrlHint': '请求头带 Authorization: Bearer <令牌>',
  'settings.mcpToken': '访问令牌',
  'settings.mcpTokenHint': '只在本机可见；泄露后点「轮换」重新生成',
  'settings.noToken': '（宿主还没有生成令牌）',
  'settings.show': '显示',
  'settings.hide': '隐藏',
  'settings.rotate': '轮换',
  'settings.rotated': '令牌已轮换',
  'settings.rotateFailed': '轮换失败',
  'settings.connectHint': '把下面的片段粘进客户端的 MCP 配置：',
  'settings.vscodeLabel': 'VS Code（.vscode/mcp.json）',
  'settings.cursorLabel': 'Cursor（~/.cursor/mcp.json）',
  'settings.field.flutterPath': 'Flutter SDK 路径',
  'settings.field.dartPath': 'Dart SDK 路径',
  'settings.field.editorCommand': '编辑器命令',
  'settings.field.dataDir': '数据目录',
  'settings.field.defaultProvider': 'AI provider',
  'settings.field.defaultModel': 'AI model',
  'settings.field.logCapacity': '日志缓冲条数',
  'settings.field.autoRefreshMs': '面板刷新间隔（毫秒）',
  'settings.field.networkAutoRefreshMs': '网络日志拉取间隔（毫秒）',
  'settings.field.maxTaskConcurrency': '同时执行的看板任务数',
  'settings.field.autoStart': '打开面板时自动启动上次的运行',
  'settings.field.analysisEnabled': '自动分析保存后的错误',
  'settings.field.mcpEnabled': '启用 MCP 接口',
  'settings.hint.flutterPath': '留空则从 PATH 解析 flutter',
  'settings.hint.dartPath': '留空则从 PATH 解析 dart',
  'settings.hint.editorCommand': '例如 code 或 code-insiders',
  'settings.hint.dataDir': '留空使用 ~/.dsh/flutter-workbench',
  'settings.hint.defaultProvider': '看板派发任务使用；留空用 DSH 默认',
  'settings.hint.defaultModel': '看板派发任务使用；留空用 DSH 默认',
  'settings.hint.logCapacity': '200 - 200000',
  'settings.hint.autoRefreshMs': '500 - 60000',
  'settings.hint.networkAutoRefreshMs': '500 - 60000',
  'settings.hint.maxTaskConcurrency': '1 - 8',
  'settings.hint.autoStart': '不需要手动点运行',
  'settings.hint.analysisEnabled': '保存文件后自动跑一次分析',
  'settings.hint.mcpEnabled': '关闭后 /mcp 会拒绝请求',
}, {
  'quality.tab.analyze': 'Analyze',
  'quality.tab.test': 'Tests',
  'quality.tab.errors': 'Exceptions',
  'quality.tab.perf': 'Performance',
  'quality.tab.screenshot': 'Screenshot',
  'quality.severity.error': 'Error',
  'quality.severity.warning': 'Warning',
  'quality.severity.info': 'Info',
  'quality.runAnalyze': 'Run analyzer',
  'quality.analyzing': 'Analyzing…',
  'quality.analyzeClean': 'No issues found 🎉',
  'quality.analyzeHint': 'Run dart analyze on the active project; issues are grouped by severity.',
  'quality.showRaw': 'Show raw output',
  'quality.hideRaw': 'Hide raw output',
  'quality.raw': 'Raw output',
  'quality.runTest': 'Run tests',
  'quality.testing': 'Testing…',
  'quality.testHint': 'Run flutter test; failing tests include their error and stack.',
  'quality.testTarget': 'Test file or folder (optional)',
  'quality.testName': 'Filter by test name (optional)',
  'quality.passed': 'passed',
  'quality.failed': 'failed',
  'quality.skipped': 'skipped',
  'quality.onlyFailed': 'Failing only',
  'quality.noTests': 'No test results',
  'quality.stack': 'Stack',
  'quality.context': 'Context',
  'quality.groupCount': '{n} groups',
  'quality.allKinds': 'All kinds',
  'quality.errorSearch': 'Search exception messages',
  'quality.errorsEmpty': 'No exceptions captured yet',
  'quality.errorsFailed': 'Could not load exceptions',
  'quality.firstAt': 'first',
  'quality.lastAt': 'last',
  'quality.jobFailed': 'Job failed',
  'quality.noJob': 'The job returned no id',
  'quality.running': 'Running…',
  'quality.noProject': 'No project open',
  'quality.loadPerf': 'Load frame stats',
  'quality.perfHint': 'Read frame timings from the running app: build / raster and jank count.',
  'quality.perfUnavailable': 'Frame stats are unavailable (the host has no /perf route yet)',
  'quality.frameCount': 'frames',
  'quality.jankCount': 'jank',
  'quality.worstFrame': 'worst frame',
  'quality.worstFrames': 'Worst frames (top 5)',
  'quality.allFrames': 'All frames',
  'quality.total': 'total',
  'quality.noActiveRun': 'No live run right now',
  'quality.capture': 'Capture the screen',
  'quality.shotSaved': 'Screenshot saved',
  'quality.shotFailed': 'Screenshot failed',
  'quality.shotHint': 'Click "Capture the screen" to save a PNG through the VM Service.',
  'quality.shotNoSource': 'The host returned a path but no readable image source (needs a /file route or base64)',
  'quality.shotAlt': 'App screenshot',
  'quality.copyPath': 'Copy path',
  'quality.openFailed': 'Could not open in the editor',
  'quality.pathCopied': 'Copied path:line',
  'quality.jumpHint': 'Open {where} in the editor',
  'settings.title': 'Settings',
  'settings.all': 'All settings',
  'settings.save': 'Save',
  'settings.saved': 'Saved',
  'settings.saveFailed': 'Save failed',
  'settings.reset': 'Revert',
  'settings.dirty': 'changed',
  'settings.nothingToSave': 'Nothing to save',
  'settings.loadFailed': 'Could not load settings',
  'settings.empty': 'The host returned no settings',
  'settings.dataDirHint': 'These values are persisted by the plugin and override the cordis.patch.yml defaults.',
  'settings.mcpTitle': 'MCP connection',
  'settings.mcpHint': 'Point an external MCP client (VS Code / Cursor) at this workbench with the URL and token below.',
  'settings.mcpUrl': 'MCP endpoint',
  'settings.mcpUrlHint': 'Send Authorization: Bearer <token>',
  'settings.mcpToken': 'Access token',
  'settings.mcpTokenHint': 'Visible only on this machine; rotate it if it leaks',
  'settings.noToken': '(the host has not generated a token yet)',
  'settings.show': 'Show',
  'settings.hide': 'Hide',
  'settings.rotate': 'Rotate',
  'settings.rotated': 'Token rotated',
  'settings.rotateFailed': 'Rotate failed',
  'settings.connectHint': 'Paste this snippet into the client MCP config:',
  'settings.vscodeLabel': 'VS Code (.vscode/mcp.json)',
  'settings.cursorLabel': 'Cursor (~/.cursor/mcp.json)',
  'settings.field.flutterPath': 'Flutter SDK path',
  'settings.field.dartPath': 'Dart SDK path',
  'settings.field.editorCommand': 'Editor command',
  'settings.field.dataDir': 'Data directory',
  'settings.field.defaultProvider': 'AI provider',
  'settings.field.defaultModel': 'AI model',
  'settings.field.logCapacity': 'Log buffer size',
  'settings.field.autoRefreshMs': 'Panel refresh (ms)',
  'settings.field.networkAutoRefreshMs': 'Network pull interval (ms)',
  'settings.field.maxTaskConcurrency': 'Concurrent board tasks',
  'settings.field.autoStart': 'Auto-start the last run when the panel opens',
  'settings.field.analysisEnabled': 'Analyze automatically after a save',
  'settings.field.mcpEnabled': 'Enable the MCP endpoint',
  'settings.hint.flutterPath': 'empty → resolve flutter from PATH',
  'settings.hint.dartPath': 'empty → resolve dart from PATH',
  'settings.hint.editorCommand': 'e.g. code or code-insiders',
  'settings.hint.dataDir': 'empty → ~/.dsh/flutter-workbench',
  'settings.hint.defaultProvider': 'used for board dispatch; empty → DSH default',
  'settings.hint.defaultModel': 'used for board dispatch; empty → DSH default',
  'settings.hint.logCapacity': '200 - 200000',
  'settings.hint.autoRefreshMs': '500 - 60000',
  'settings.hint.networkAutoRefreshMs': '500 - 60000',
  'settings.hint.maxTaskConcurrency': '1 - 8',
  'settings.hint.autoStart': 'no manual run needed',
  'settings.hint.analysisEnabled': 'run the analyzer after each save',
  'settings.hint.mcpEnabled': '/mcp rejects requests while disabled',
})