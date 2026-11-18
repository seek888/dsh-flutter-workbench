/* ====================================================================== *
 * 40-network.js — owner: dev-ui-data
 *
 * NetworkPage: HTTP request inspector fed by the VM Service HTTP profile.
 *   toolbar: status chips (2xx/3xx/4xx/5xx/error) + method filter + search +
 *            pause/clear/export
 *   list:    virtualised rows (status tone, method, shortened path, duration)
 *   drawer:  POST /network/detail — request/response headers and bodies with an
 *            explicit truncation notice, per-section copy and "copy as cURL"
 *
 * This file also owns the small set of helpers every dev-ui-data page reuses
 * (formatting, clipboard, download, notices, locale extension). Every helper is
 * prefixed `fwb…`/`useFwb…` because all fragments share one function scope with
 * the prelude and the other pages.
 *
 * Kit surface consumed (docs/CONTRACTS.md §8.1): Btn, IconBtn, Pill, Chip, Card,
 * Field, Input, TextArea, Select, Checkbox, Modal, Empty, Spinner, Mono, t.
 * ====================================================================== */

/* ---------------------------------------------------------------- helpers -- */

/** Pages receive `{ state }`; actions may be nested or handed down separately. */
function fwbActions(state, actions) {
  const fromState = state !== null && typeof state === 'object' ? state.actions : null
  if (fromState !== null && typeof fromState === 'object') return fromState
  return actions !== null && typeof actions === 'object' ? actions : {}
}

/**
 * Prefer a shared client action; fall back to the documented HTTP route when the
 * action is missing. Errors from an existing action always propagate — a
 * rejected mutation must never be retried through a second transport.
 */
async function fwbInvoke(act, name, args, fallback) {
  const fn = act !== null && act !== undefined ? act[name] : undefined
  if (typeof fn === 'function') return fn(...args)
  if (typeof fallback === 'function') return fallback()
  throw Object.assign(new Error(`client action not available: ${name}`), { code: 'action-missing' })
}

/** Accept either a DOM change event or the raw value from a kit control. */
function fwbReadValue(next) {
  if (next === null || next === undefined) return next
  if (typeof next === 'object') {
    if (next.target !== undefined && next.target !== null) {
      if (next.target.type === 'checkbox') return next.target.checked === true
      return next.target.value
    }
    if (next.currentTarget !== undefined && next.currentTarget !== null) return next.currentTarget.value
    if (next.value !== undefined) return next.value
  }
  return next
}

/** Split a textarea/JSON list field into trimmed non-empty lines. */
function fwbLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

function fwbBytes(count) {
  const value = Number(count)
  if (Number.isFinite(value) === false || value < 0) return '—'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function fwbDuration(ms) {
  const value = Number(ms)
  if (Number.isFinite(value) === false) return '—'
  if (value < 1) return `${Math.round(value * 1000)}µs`
  if (value < 1000) return `${Math.round(value)}ms`
  return `${(value / 1000).toFixed(value < 10000 ? 2 : 1)}s`
}

function fwbPad2(value) {
  return String(value).padStart(2, '0')
}

/** HH:MM:SS in local time; empty for a missing timestamp. */
function fwbClock(stamp) {
  const value = Number(stamp)
  if (Number.isFinite(value) === false || value <= 0) return '—'
  const date = new Date(value)
  return `${fwbPad2(date.getHours())}:${fwbPad2(date.getMinutes())}:${fwbPad2(date.getSeconds())}`
}

/** "12s ago" / "3m ago" style relative label for timelines. */
function fwbAgo(stamp) {
  const value = Number(stamp)
  if (Number.isFinite(value) === false || value <= 0) return '—'
  const delta = Math.max(0, Date.now() - value)
  if (delta < 5000) return t('time.justNow')
  const seconds = Math.round(delta / 1000)
  if (seconds < 60) return t('time.secondsAgo', { n: seconds })
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t('time.minutesAgo', { n: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t('time.hoursAgo', { n: hours })
  return t('time.daysAgo', { n: Math.round(hours / 24) })
}

/** Clipboard write with a document.execCommand fallback for non-secure hosts. */
async function fwbCopy(text) {
  const value = String(text ?? '')
  if (value === '') return false
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined && navigator.clipboard !== null) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch (error) {
    /* fall through to the textarea trick */
  }
  try {
    const node = document.createElement('textarea')
    node.value = value
    node.setAttribute('readonly', 'readonly')
    node.style.position = 'fixed'
    node.style.top = '-1000px'
    node.style.opacity = '0'
    document.body.appendChild(node)
    node.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(node)
    return ok === true
  } catch (error) {
    return false
  }
}

/** Download a generated blob (export buttons); no host endpoint required. */
function fwbDownload(filename, text, mime) {
  try {
    const blob = new Blob([String(text ?? '')], { type: String(mime ?? 'text/plain;charset=utf-8') })
    const href = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = href
    link.download = filename
    link.style.display = 'none'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    setTimeout(() => URL.revokeObjectURL(href), 2000)
    return true
  } catch (error) {
    return false
  }
}

/**
 * Notice channel: prefers the shared `actions.toast(message, tone)`; when the
 * shell does not provide one the page keeps its own banner so no feedback is
 * silently lost.
 */
function useFwbNotify(state, actions) {
  const [notice, setNotice] = React.useState(null)
  const act = fwbActions(state, actions)
  const push = React.useCallback((message, tone) => {
    const text = String(message ?? '')
    if (text === '') return
    if (typeof act.toast === 'function') {
      act.toast(text, tone ?? 'info')
      return
    }
    setNotice({ message: text, tone: tone ?? 'info', at: Date.now() })
  }, [act])
  const clear = React.useCallback(() => setNotice(null), [])

  React.useEffect(() => {
    if (notice === null) return undefined
    const timer = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(timer)
  }, [notice])

  return { notice, push, clear }
}

function fwbToneColor(tone) {
  if (tone === 'ok') return T.ok
  if (tone === 'warn') return T.warn
  if (tone === 'error') return T.error
  if (tone === 'info') return T.brand
  return T.textDim
}

/** Small inline banner used when the shell has no toast host. */
function FwbNotice({ notice, onDismiss }) {
  if (notice === null || notice === undefined) return null
  const color = fwbToneColor(notice.tone)
  return h('div', {
    role: 'status',
    style: {
      display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', margin: '6px 8px',
      border: `1px solid ${color}`, borderRadius: T.radiusSm, color, fontSize: 12,
      background: T.bgRaised,
    },
  },
    h('span', { style: { flex: 1, minWidth: 0, overflowWrap: 'anywhere' } }, notice.message),
    h(Btn, { onClick: onDismiss, title: t('net.close') }, '✕'))
}

/** Copy button that reports its own state without needing a toast host. */
function FwbCopyBtn({ value, label, notify, kind, disabled }) {
  const [state, setState] = React.useState('idle')
  React.useEffect(() => {
    if (state === 'idle') return undefined
    const timer = setTimeout(() => setState('idle'), 1600)
    return () => clearTimeout(timer)
  }, [state])

  const onClick = async () => {
    const ok = await fwbCopy(value)
    setState(ok ? 'done' : 'failed')
    if (typeof notify === 'function') notify(ok ? t('net.copied') : t('net.copyFailed'), ok ? 'ok' : 'error')
  }

  const text = state === 'done' ? t('net.copied') : state === 'failed' ? t('net.copyFailed') : (label ?? t('net.copy'))
  return h(Btn, { onClick, kind: kind ?? 'ghost', title: t('net.copy'), disabled: disabled === true, style: { padding: '3px 8px', fontSize: 11 } }, text)
}

/** Top-level page scaffold shared by the three data pages. */
function FwbPage({ children, notice, onDismiss, gap }) {
  return h('div', {
    style: {
      display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
      color: T.text, fontSize: T.fs, fontFamily: T.font, gap: gap ?? 0,
    },
  },
    h(FwbNotice, { notice, onDismiss }),
    children)
}

/** Label/value grid used by the network drawer and the settings/quality panes. */
function FwbKeyValues({ entries, mono }) {
  const rows = entries === null || entries === undefined ? [] : entries
  if (rows.length === 0) return h('div', { style: { color: T.textFaint, fontSize: 12, padding: '4px 0' } }, t('net.noHeaders'))
  return h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(110px, 32%) 1fr', gap: '2px 10px', fontSize: 12 } },
    rows.map((row, index) => h(React.Fragment, { key: `${row[0]}-${index}` },
      h('div', { style: { color: T.textFaint, overflowWrap: 'anywhere' } }, String(row[0])),
      h('div', { style: { color: T.text, overflowWrap: 'anywhere', fontFamily: mono === false ? T.font : T.mono } }, String(row[1])))))
}

/** Pretty-print a body value; objects become indented JSON. */
function fwbBodyText(body) {
  if (body === null || body === undefined) return ''
  if (typeof body === 'string') return body
  try {
    return JSON.stringify(body, null, 2)
  } catch (error) {
    return String(body)
  }
}

/** Header object → ordered [name, value] pairs. */
function fwbHeaderRows(headers) {
  if (headers === null || headers === undefined || typeof headers !== 'object') return []
  return Object.keys(headers).map((name) => [name, Array.isArray(headers[name]) ? headers[name].join(', ') : headers[name]])
}

/* -------------------------------------------------------------- locale -- */

/**
 * Extend the shared dictionaries without touching 00-prelude.js (not ours).
 * 90-apply registers the same ZH/EN objects with the locale service, so the keys
 * must be present before apply runs — fragment top-level code is early enough.
 */
function fwbExtendLocale(zh, en) {
  try {
    if (typeof ZH === 'object' && ZH !== null && Object.isFrozen(ZH) !== true) Object.assign(ZH, zh)
    if (typeof EN === 'object' && EN !== null && Object.isFrozen(EN) !== true) Object.assign(EN, en)
  } catch (error) {
    console.error('[flutter-workbench] locale extension failed', error)
  }
}

/* -------------------------------------------------------------- network -- */

/** Status buckets offered by the toolbar; server-side via ?status=/?errorsOnly. */
const FWB_NET_FILTERS = ['all', '2xx', '3xx', '4xx', '5xx', 'error']
const FWB_NET_METHODS = ['', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
const FWB_NET_ROW_HEIGHT = 28

function fwbNetFilterLabel(id) {
  if (id === 'all') return t('net.all')
  if (id === 'error') return t('net.errors')
  return t(`net.c${String(id).charAt(0)}`)
}

/** ok / warn / error / neutral tone for one request. */
function fwbNetTone(entry) {
  if (entry === null || entry === undefined) return 'neutral'
  if (entry.error !== null && entry.error !== undefined && entry.error !== '') return 'error'
  const status = Number(entry.status)
  if (Number.isFinite(status) === false || status <= 0) return entry.complete === false ? 'neutral' : 'neutral'
  if (status >= 500) return 'error'
  if (status >= 400) return 'warn'
  if (status >= 300) return 'neutral'
  return 'ok'
}

function fwbNetStatusText(entry) {
  if (entry === null || entry === undefined) return '—'
  if (entry.error !== null && entry.error !== undefined && entry.error !== '') return t('net.errorLabel')
  const status = Number(entry.status)
  return Number.isFinite(status) && status > 0 ? String(status) : (entry.complete === false ? '…' : '—')
}

/** Shortest useful path: path + query, clipped in the middle from the left. */
function fwbNetPath(entry, max) {
  const limit = Number(max) > 0 ? Number(max) : 120
  if (entry === null || entry === undefined) return ''
  const raw = String(entry.path ?? '') !== '' ? String(entry.path) : String(entry.uri ?? '')
  if (raw.length <= limit) return raw
  return `…${raw.slice(raw.length - limit + 1)}`
}

function fwbNetCounts(entries) {
  const counts = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, error: 0 }
  for (const entry of entries) {
    if (entry?.error) {
      counts.error += 1
      continue
    }
    const status = Number(entry?.status)
    if (Number.isFinite(status) === false || status <= 0) continue
    if (status >= 500) counts['5xx'] += 1
    else if (status >= 400) counts['4xx'] += 1
    else if (status >= 300) counts['3xx'] += 1
    else counts['2xx'] += 1
  }
  return counts
}

/** Build a replayable cURL command from the list entry plus loaded detail. */
function fwbNetCurl(entry, detail) {
  const method = String(entry?.method ?? 'GET').toUpperCase()
  const url = String(entry?.uri ?? entry?.path ?? '')
  const parts = [`curl -X ${method} '${url}'`]
  const headers = (detail?.requestHeaders ?? entry?.requestHeaders) ?? {}
  const rows = fwbHeaderRows(headers)
  for (const [name, value] of rows) {
    if (/^(content-length|host|connection|accept-encoding)$/i.test(String(name))) continue
    parts.push(`  -H '${String(name)}: ${String(value)}'`)
  }
  const body = fwbBodyText(detail?.requestBody ?? null)
  if (body !== '') parts.push(`  --data-raw '${body.replace(/'/g, `'\\''`)}'`)
  return parts.join(' \\\n')
}

function FwbNetRow({ entry, active, onClick, top }) {
  const tone = fwbNetTone(entry)
  const color = fwbToneColor(tone)
  const path = fwbNetPath(entry, 160)
  return h('div', {
    role: 'row',
    tabIndex: 0,
    title: `${String(entry?.method ?? '')} ${String(entry?.uri ?? '')}\n${fwbNetStatusText(entry)} · ${fwbDuration(entry?.durationMs)}`,
    onClick,
    onKeyDown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onClick()
      }
    },
    style: {
      position: 'absolute', top, left: 0, right: 0, height: FWB_NET_ROW_HEIGHT,
      display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px',
      fontSize: 12, cursor: 'pointer', borderRadius: T.radiusSm,
      background: active === true ? T.bgInput : 'transparent',
      border: `1px solid ${active === true ? T.borderStrong : 'transparent'}`,
      boxSizing: 'border-box',
    },
  },
    h('span', { style: { width: 52, flexShrink: 0, color, fontWeight: 600, fontVariantNumeric: 'tabular-nums' } }, fwbNetStatusText(entry)),
    h('span', { style: { width: 58, flexShrink: 0, color: T.textDim, fontFamily: T.mono, fontSize: 11 } }, String(entry?.method ?? '')),
    h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: entry?.error ? T.error : T.text, fontFamily: T.mono, fontSize: 11 } }, path),
    h('span', { style: { width: 62, flexShrink: 0, textAlign: 'right', color: T.textDim, fontVariantNumeric: 'tabular-nums' } }, fwbDuration(entry?.durationMs)),
    h('span', { style: { width: 58, flexShrink: 0, textAlign: 'right', color: T.textFaint, fontSize: 11, fontVariantNumeric: 'tabular-nums' } }, fwbClock(entry?.at)))
}

/**
 * Windowed list: only the rows around the scroll viewport are mounted, so a
 * 500-entry buffer stays smooth. Row height is fixed (FWB_NET_ROW_HEIGHT).
 */
function FwbNetList({ entries, selectedId, onSelect }) {
  const viewRef = React.useRef(null)
  const [scrollTop, setScrollTop] = React.useState(0)
  const [viewport, setViewport] = React.useState(460)

  React.useEffect(() => {
    const node = viewRef.current
    if (node === null || node === undefined) return undefined
    const measure = () => setViewport(node.clientHeight || 460)
    measure()
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(measure)
      observer.observe(node)
      return () => observer.disconnect()
    }
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  if (entries.length === 0) {
    return h('div', { style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' } },
      h(Card, { style: { maxWidth: 420, textAlign: 'center' } },
        h('div', { style: { fontWeight: 600, marginBottom: 6 } }, t('net.empty')),
        h('div', { style: { color: T.textDim, fontSize: 12, lineHeight: 1.6 } }, t('net.emptyHint'))))
  }

  const total = entries.length
  const first = Math.max(0, Math.floor(scrollTop / FWB_NET_ROW_HEIGHT) - 8)
  const visible = Math.ceil(viewport / FWB_NET_ROW_HEIGHT) + 16
  const slice = entries.slice(first, Math.min(total, first + visible))

  return h('div', {
    ref: viewRef,
    onScroll: (event) => setScrollTop(event.currentTarget.scrollTop),
    style: { flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', position: 'relative' },
  },
    h('div', { style: { height: total * FWB_NET_ROW_HEIGHT, position: 'relative' } },
      slice.map((entry, index) => {
        const top = (first + index) * FWB_NET_ROW_HEIGHT
        const id = entry?.id ?? `row-${first + index}`
        return h(FwbNetRow, {
          key: id,
          entry,
          top,
          active: selectedId !== null && selectedId === entry?.id,
          onClick: () => onSelect(entry),
        })
      })))
}

/** One labelled block in the drawer: header row with a copy button + body. */
function FwbNetSection({ title, text, notify, empty }) {
  const body = String(text ?? '')
  return h('div', { style: { borderTop: `1px solid ${T.border}`, padding: '8px 0' } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 } },
      h('div', { style: { flex: 1, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: T.textFaint } }, title),
      body === '' ? null : h(FwbCopyBtn, { value: body, notify })),
    body === ''
      ? h('div', { style: { color: T.textFaint, fontSize: 12 } }, empty ?? t('net.noBody'))
      : h(Mono, { style: { display: 'block', maxHeight: 240, overflow: 'auto', fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: T.text } }, body))
}

function FwbNetDetail({ entry, detail, error, loading, onClose, notify }) {
  if (entry === null || entry === undefined) {
    return h('div', { style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, color: T.textFaint, fontSize: 12, textAlign: 'center' } }, t('net.selectHint'))
  }

  const tone = fwbNetTone(entry)
  const color = fwbToneColor(tone)
  const requestBody = fwbBodyText(detail?.requestBody ?? null) || String(entry?.contentPreview ?? '')
  const responseBody = fwbBodyText(detail?.responseBody ?? null)
  const truncated = detail?.truncated === true

  return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
    h('div', { style: { padding: '8px 10px', borderBottom: `1px solid ${T.border}`, flexShrink: 0 } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        h(Pill, { tone, style: { color } }, `${String(entry.method ?? '').toUpperCase()} ${fwbNetStatusText(entry)}`),
        h('div', { style: { flex: 1, minWidth: 0 } }),
        h(FwbCopyBtn, { value: String(entry.uri ?? entry.path ?? ''), label: t('net.copyUrl'), notify }),
        h(Btn, { onClick: onClose, title: t('net.close'), style: { padding: '3px 8px' } }, '✕')),
      h('div', {
        title: String(entry.uri ?? ''),
        style: { marginTop: 6, fontFamily: T.mono, fontSize: 11, color: T.text, overflowWrap: 'anywhere', wordBreak: 'break-all' },
      }, String(entry.uri ?? entry.path ?? ''))),
    h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 10px 12px' } },
      loading === true ? h('div', { style: { padding: 16, textAlign: 'center', color: T.textDim, fontSize: 12 } }, h(Spinner, null), ` ${t('common.loading')}`) : null,
      error !== null && error !== undefined
        ? h('div', { style: { margin: '8px 0', padding: '6px 8px', border: `1px solid ${T.error}`, borderRadius: T.radiusSm, color: T.error, fontSize: 12 } }, String(error?.message ?? error))
        : null,
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '4px 10px', padding: '8px 0', fontSize: 12 } },
        h('div', null, h('div', { style: { color: T.textFaint, fontSize: 11 } }, t('net.colTime')), h('div', null, fwbClock(entry.at))),
        h('div', null, h('div', { style: { color: T.textFaint, fontSize: 11 } }, t('net.colDuration')), h('div', null, fwbDuration(entry.durationMs))),
        h('div', null, h('div', { style: { color: T.textFaint, fontSize: 11 } }, t('net.host')), h('div', { style: { overflowWrap: 'anywhere' } }, String(entry.host ?? '—'))),
        h('div', null, h('div', { style: { color: T.textFaint, fontSize: 11 } }, t('net.size')),
          h('div', null, `${fwbBytes(entry.requestBytes)} → ${fwbBytes(entry.responseBytes)}`))),
      truncated === true
        ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, margin: '4px 0 8px' } },
          h(Pill, { tone: 'warn', style: { color: T.warn } }, t('net.truncated')),
          h('span', { style: { color: T.textDim, fontSize: 11 } }, t('net.truncatedNote')))
        : null,
      error !== null && error !== undefined && entry.error
        ? h(FwbNetSection, { title: t('net.errorLabel'), text: String(entry.error), notify })
        : null,
      h(FwbNetSection, { title: t('net.requestHeaders'), text: fwbHeaderRows(detail?.requestHeaders ?? entry.requestHeaders).map((row) => `${row[0]}: ${row[1]}`).join('\n'), notify, empty: t('net.noHeaders') }),
      h(FwbNetSection, { title: t('net.responseHeaders'), text: fwbHeaderRows(detail?.responseHeaders ?? entry.responseHeaders).map((row) => `${row[0]}: ${row[1]}`).join('\n'), notify, empty: t('net.noHeaders') }),
      h(FwbNetSection, { title: t('net.requestBody'), text: requestBody, notify }),
      h(FwbNetSection, { title: t('net.responseBody'), text: responseBody, notify }),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, paddingTop: 10, borderTop: `1px solid ${T.border}` } },
        h(FwbCopyBtn, { value: fwbNetCurl(entry, detail), label: t('net.copyCurl'), notify, kind: 'primary' }),
        h('span', { style: { color: T.textFaint, fontSize: 11 } }, t('net.curlHint'))))
}

function NetworkPage({ state, actions }) {
  const act = fwbActions(state, actions)
  const { notice, push, clear } = useFwbNotify(state, actions)
  const [statusFilter, setStatusFilter] = React.useState('all')
  const [method, setMethod] = React.useState('')
  const [searchDraft, setSearchDraft] = React.useState('')
  const [pattern, setPattern] = React.useState('')
  const [paused, setPaused] = React.useState(false)
  const [selected, setSelected] = React.useState(null)
  const [detail, setDetail] = React.useState({ loading: false, data: null, error: null })

  React.useEffect(() => {
    const timer = setTimeout(() => setPattern(searchDraft.trim()), 280)
    return () => clearTimeout(timer)
  }, [searchDraft])

  const query = React.useMemo(() => {
    const next = { limit: 500 }
    if (statusFilter === 'error') next.errorsOnly = true
    else if (statusFilter !== 'all') next.status = statusFilter
    if (method !== '') next.method = method
    if (pattern !== '') next.pattern = pattern
    return next
  }, [statusFilter, method, pattern])

  const queryKey = JSON.stringify(query)
  const pollMs = paused === true ? 0 : 1500
  const loadNetwork = React.useCallback(
    () => fwbInvoke(act, 'fetchNetwork', [query], () => api('/network', { query })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [act, queryKey])
  const poll = usePoll(loadNetwork, pollMs, [queryKey])
  const entries = Array.isArray(poll.data?.entries) ? poll.data.entries : []
  const total = Number.isFinite(Number(poll.data?.total)) ? Number(poll.data.total) : entries.length
  const counts = React.useMemo(() => fwbNetCounts(entries), [entries])
  const failure = poll.error ?? null

  // Selected request detail: POST /network/detail { id, runId }.
  const selectedId = selected?.id ?? null
  const selectedRunId = selected?.runId ?? null
  React.useEffect(() => {
    if (selectedId === null) {
      setDetail({ loading: false, data: null, error: null })
      return undefined
    }
    let cancelled = false
    setDetail({ loading: true, data: null, error: null })
    fwbInvoke(act, 'networkDetail', [{ id: selectedId, runId: selectedRunId }],
      () => api('/network/detail', { method: 'POST', body: { id: selectedId, runId: selectedRunId } }))
      .then((response) => {
        if (cancelled === true) return
        const request = response?.request ?? response?.detail ?? response ?? null
        setDetail({ loading: false, data: request, error: null })
      })
      .catch((issue) => {
        if (cancelled === true) return
        setDetail({ loading: false, data: null, error: issue })
      })
    return () => {
      cancelled = true
    }
  }, [selectedId, selectedRunId])

  // Keep the drawer in sync with the live list (a refreshed row carries new bytes).
  React.useEffect(() => {
    if (selectedId === null || paused === true) return
    const fresh = entries.find((entry) => entry?.id === selectedId)
    if (fresh !== undefined && fresh !== selected) setSelected(fresh)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, paused, entries.length, selectedId])

  const onClear = async () => {
    try {
      await api('/network/clear', { method: 'POST', body: {} })
      setSelected(null)
      setDetail({ loading: false, data: null, error: null })
      push(t('net.cleared'), 'ok')
      poll.refresh()
    } catch (issue) {
      push(String(issue?.message ?? issue), 'error')
    }
  }

  const onExport = () => {
    if (entries.length === 0) {
      push(t('net.nothingToExport'), 'warn')
      return
    }
    const payload = JSON.stringify({ exportedAt: Date.now(), query, total, entries }, null, 2)
    const ok = fwbDownload(`flutter-network-${Date.now()}.json`, payload, 'application/json')
    push(ok ? t('net.exported', { n: entries.length }) : t('net.exportFailed'), ok ? 'ok' : 'error')
  }

  const toolbar = h('div', {
    style: {
      display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: '8px 10px',
      borderBottom: `1px solid ${T.border}`, flexShrink: 0,
    },
  },
    FWB_NET_FILTERS.map((id) => h(Chip, {
      key: id,
      active: statusFilter === id,
      onClick: () => setStatusFilter(id),
      title: id === 'error' ? t('net.errorsOnlyHint') : '',
    }, `${fwbNetFilterLabel(id)}${id !== 'all' && id !== 'error' ? ` ${counts[id] ?? 0}` : id === 'error' ? ` ${counts.error}` : ''}`)),
    h('div', { style: { width: 1, height: 18, background: T.border, margin: '0 2px' } }),
    h(Select, {
      value: method,
      onChange: (next) => setMethod(String(fwbReadValue(next) ?? '')),
      options: FWB_NET_METHODS.map((id) => ({ value: id, label: id === '' ? t('net.allMethods') : id })),
      style: { minWidth: 116 },
    }),
    h('div', { style: { flex: 1, minWidth: 160 } },
      h(Input, {
        value: searchDraft,
        onChange: (next) => setSearchDraft(String(fwbReadValue(next) ?? '')),
        placeholder: t('net.search'),
        style: { width: '100%' },
      })),
    h(Btn, { onClick: () => setPaused((value) => value !== true), title: paused === true ? t('net.resumeHint') : t('net.pauseHint') },
      paused === true ? `▶ ${t('net.resume')}` : `⏸ ${t('net.pause')}`),
    h(Btn, { onClick: () => poll.refresh() }, t('common.refresh')),
    h(Btn, { onClick: onClear, kind: 'danger' }, t('net.clear')),
    h(Btn, { onClick: onExport }, t('net.export')))

  const listHeader = h('div', {
    style: {
      display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', fontSize: 10,
      textTransform: 'uppercase', letterSpacing: 0.5, color: T.textFaint,
      borderBottom: `1px solid ${T.border}`, flexShrink: 0,
    },
  },
    h('span', { style: { width: 52 } }, t('net.colStatus')),
    h('span', { style: { width: 58 } }, t('net.colMethod')),
    h('span', { style: { flex: 1, minWidth: 0 } }, t('net.colPath')),
    h('span', { style: { width: 62, textAlign: 'right' } }, t('net.colDuration')),
    h('span', { style: { width: 58, textAlign: 'right' } }, t('net.colTime')))

  const footer = h('div', {
    style: {
      display: 'flex', alignItems: 'center', gap: 10, padding: '4px 10px',
      borderTop: `1px solid ${T.border}`, color: T.textFaint, fontSize: 11, flexShrink: 0,
    },
  },
    h('span', null, t('net.total', { n: total })),
    paused === true ? h('span', { style: { color: T.warn } }, t('net.paused')) : h('span', { style: { color: T.ok } }, t('net.live')),
    h('div', { style: { flex: 1 } }),
    h('span', null, `${t('net.colStatus')} 2xx/${counts['2xx']} 3xx/${counts['3xx']} 4xx/${counts['4xx']} 5xx/${counts['5xx']}`))

  return h(FwbPage, { notice, onDismiss: clear },
    toolbar,
    failure !== null
      ? h('div', { style: { padding: '6px 10px', color: T.error, fontSize: 12, borderBottom: `1px solid ${T.border}` } },
        `${t('net.loadFailed')}: ${String(failure?.message ?? failure)}`)
      : null,
    h('div', { style: { flex: 1, minHeight: 0, display: 'flex' } },
      h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' } },
        listHeader,
        h(FwbNetList, { entries, selectedId, onSelect: (entry) => setSelected(entry) }),
        footer),
      h('div', {
        style: {
          width: 460, maxWidth: '55%', minWidth: 280, flexShrink: 0,
          borderLeft: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', minHeight: 0,
        },
      },
        h(FwbNetDetail, {
          entry: selected,
          detail: detail.data,
          error: detail.error,
          loading: detail.loading,
          onClose: () => setSelected(null),
          notify: push,
        }))))
}

/* ------------------------------------------------------------- locale data -- */

fwbExtendLocale({
  'time.justNow': '刚刚',
  'time.secondsAgo': '{n} 秒前',
  'time.minutesAgo': '{n} 分钟前',
  'time.hoursAgo': '{n} 小时前',
  'time.daysAgo': '{n} 天前',
  'net.all': '全部',
  'net.c2': '2xx',
  'net.c3': '3xx',
  'net.c4': '4xx',
  'net.c5': '5xx',
  'net.errors': '错误',
  'net.errorsOnlyHint': '只显示失败或超时的请求',
  'net.allMethods': '全部方法',
  'net.search': '搜索 URL / 主机 / 路径',
  'net.pause': '暂停',
  'net.resume': '继续',
  'net.pauseHint': '暂停实时拉取（已记录的数据保留）',
  'net.resumeHint': '恢复实时拉取',
  'net.paused': '已暂停',
  'net.live': '实时',
  'net.clear': '清空',
  'net.cleared': '网络记录已清空',
  'net.export': '导出',
  'net.exported': '已导出 {n} 条请求',
  'net.exportFailed': '导出失败',
  'net.nothingToExport': '没有可导出的请求',
  'net.empty': '还没有 HTTP 请求',
  'net.emptyHint': '运行应用并让它发起网络请求。VM Service 的 HTTP 分析数据会实时出现在这里。',
  'net.total': '共 {n} 条',
  'net.colStatus': '状态',
  'net.colMethod': '方法',
  'net.colPath': '路径',
  'net.colDuration': '耗时',
  'net.colTime': '时间',
  'net.host': '主机',
  'net.size': '大小',
  'net.requestHeaders': '请求头',
  'net.responseHeaders': '响应头',
  'net.requestBody': '请求体',
  'net.responseBody': '响应体',
  'net.noHeaders': '无',
  'net.noBody': '（未捕获到内容）',
  'net.errorLabel': 'ERR',
  'net.truncated': '已截断',
  'net.truncatedNote': '内容超出上限，这里只显示前一部分。',
  'net.copy': '复制',
  'net.copyUrl': '复制 URL',
  'net.copyCurl': '复制为 cURL',
  'net.copied': '已复制',
  'net.copyFailed': '复制失败',
  'net.curlHint': '可直接在终端重放这条请求',
  'net.selectHint': '选择一条请求即可查看请求头、响应头与正文。',
  'net.close': '关闭',
  'net.detailFailed': '加载请求详情失败',
  'net.loadFailed': '加载网络请求失败',
}, {
  'time.justNow': 'just now',
  'time.secondsAgo': '{n}s ago',
  'time.minutesAgo': '{n}m ago',
  'time.hoursAgo': '{n}h ago',
  'time.daysAgo': '{n}d ago',
  'net.all': 'All',
  'net.c2': '2xx',
  'net.c3': '3xx',
  'net.c4': '4xx',
  'net.c5': '5xx',
  'net.errors': 'Errors',
  'net.errorsOnlyHint': 'Only failed or timed-out requests',
  'net.allMethods': 'All methods',
  'net.search': 'Search URL / host / path',
  'net.pause': 'Pause',
  'net.resume': 'Resume',
  'net.pauseHint': 'Stop pulling live traffic (captured rows stay)',
  'net.resumeHint': 'Resume live traffic',
  'net.paused': 'paused',
  'net.live': 'live',
  'net.clear': 'Clear',
  'net.cleared': 'Network capture cleared',
  'net.export': 'Export',
  'net.exported': 'Exported {n} requests',
  'net.exportFailed': 'Export failed',
  'net.nothingToExport': 'No requests to export',
  'net.empty': 'No HTTP requests yet',
  'net.emptyHint': 'Run the app and let it make network calls — the VM Service HTTP profile shows up here live.',
  'net.total': '{n} requests',
  'net.colStatus': 'Status',
  'net.colMethod': 'Method',
  'net.colPath': 'Path',
  'net.colDuration': 'Time',
  'net.colTime': 'At',
  'net.host': 'Host',
  'net.size': 'Size',
  'net.requestHeaders': 'Request headers',
  'net.responseHeaders': 'Response headers',
  'net.requestBody': 'Request body',
  'net.responseBody': 'Response body',
  'net.noHeaders': 'none',
  'net.noBody': '(nothing captured)',
  'net.errorLabel': 'ERR',
  'net.truncated': 'Truncated',
  'net.truncatedNote': 'The body exceeds the capture limit; only the first part is shown.',
  'net.copy': 'Copy',
  'net.copyUrl': 'Copy URL',
  'net.copyCurl': 'Copy as cURL',
  'net.copied': 'Copied',
  'net.copyFailed': 'Copy failed',
  'net.curlHint': 'Replay this request straight from a terminal',
  'net.selectHint': 'Pick a request to inspect headers, bodies and timing.',
  'net.close': 'Close',
  'net.detailFailed': 'Could not load the request detail',
  'net.loadFailed': 'Could not load network requests',
})