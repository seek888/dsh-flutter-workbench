/* ====================================================================== *
 * 00-prelude.js — owner: dev-ui-core
 * Tokens, i18n, HTTP client, polling hooks and the shared UI kit.
 * PLACEHOLDER: replace with the real implementation per docs/CONTRACTS.md §8.1.
 * ====================================================================== */

const h = React.createElement
const PANEL_ID = 'flutter-workbench'
const API = '/api/flutter-workbench'
const LOCALE_NS = 'flutter-workbench'

/** Design tokens — only host theme tokens, never literal colors. */
const T = {
  bg: 'transparent',
  bgRaised: 'var(--dsw-alias-bg-raised, var(--dsw-alias-bg-base))',
  bgInput: 'var(--dsw-alias-bg-input, var(--dsw-alias-bg-raised))',
  border: 'var(--dsw-alias-border-subtle, rgba(127,127,127,0.24))',
  borderStrong: 'var(--dsw-alias-border-strong, rgba(127,127,127,0.4))',
  text: 'var(--dsw-alias-text-primary)',
  textDim: 'var(--dsw-alias-text-secondary)',
  textFaint: 'var(--dsw-alias-text-tertiary, var(--dsw-alias-text-secondary))',
  brand: 'var(--dsw-alias-brand-primary)',
  ok: 'var(--dsw-alias-state-success, #3fb950)',
  warn: 'var(--dsw-alias-state-warning, #d29922)',
  error: 'var(--dsw-alias-state-error, #f85149)',
  radius: 'var(--dsw-radius-lg, 10px)',
  radiusSm: 'var(--dsw-radius-md, 6px)',
  font: 'var(--dsw-alias-font-family, system-ui, sans-serif)',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fs: 13,
}

const ZH = {
  'nav.runtime': '运行',
  'nav.logs': '日志',
  'nav.network': '网络',
  'nav.board': '看板',
  'nav.quality': '质量',
  'nav.settings': '设置',
  'common.loading': '加载中…',
  'common.empty': '暂无数据',
  'common.refresh': '刷新',
  'common.retry': '重试',
  'state.offline': '无法连接工作台后端',
  'boot.placeholder': '工作台模块正在构建中',
}
const EN = {
  'nav.runtime': 'Runtime',
  'nav.logs': 'Logs',
  'nav.network': 'Network',
  'nav.board': 'Board',
  'nav.quality': 'Quality',
  'nav.settings': 'Settings',
  'common.loading': 'Loading…',
  'common.empty': 'Nothing here yet',
  'common.refresh': 'Refresh',
  'common.retry': 'Retry',
  'state.offline': 'Cannot reach the workbench host',
  'boot.placeholder': 'Workbench modules are being built',
}

/** Active UI language; `90-apply.js` syncs it with the host locale service. */
let currentLocale = 'zh'
const LANG = () => currentLocale
function setActiveLocale(next) {
  if (next === 'en' || next === 'zh') currentLocale = next
}

function t(key, vars) {
  const dict = LANG() === 'en' ? EN : ZH
  let text = dict[key] ?? key
  if (vars !== undefined) {
    for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}

function buildQuery(query) {
  if (query === undefined || query === null) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  const search = params.toString()
  return search === '' ? '' : `?${search}`
}

async function api(path, options = {}) {
  const { method = 'GET', body, query, signal } = options
  const init = { method, cache: 'no-store', credentials: 'same-origin', signal }
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  let response
  try {
    response = await fetch(`${API}${path}${buildQuery(query)}`, init)
  } catch (error) {
    throw Object.assign(new Error(`${t('state.offline')} (${String(error?.message ?? error)})`), { status: 0, code: 'network' })
  }
  const text = await response.text()
  let data = null
  if (text !== '') {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }
  if (response.ok === false || (data !== null && data.ok === false)) {
    throw Object.assign(new Error(data?.message ?? `HTTP ${response.status}`), {
      status: response.status,
      code: data?.code ?? 'http',
      body: data,
    })
  }
  return data ?? {}
}

function usePoll(load, intervalMs, deps = []) {
  const [data, setData] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const loadRef = React.useRef(load)
  loadRef.current = load

  const refresh = React.useCallback(async () => {
    try {
      const value = await loadRef.current()
      setData(value)
      setError(null)
      return value
    } catch (issue) {
      setError(issue)
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    refresh()
    if (intervalMs > 0) {
      const timer = setInterval(() => {
        if (cancelled === false) refresh()
      }, intervalMs)
      return () => {
        cancelled = true
        clearInterval(timer)
      }
    }
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, ...deps])

  return { data, error, loading, refresh, setData, setError }
}

/* ---- minimal UI kit (dev-ui-core replaces with the full one) ---------- */

function Spinner({ size = 14 }) {
  return h('span', {
    style: {
      display: 'inline-block', width: size, height: size, borderRadius: size,
      border: `2px solid ${T.border}`, borderTopColor: T.brand,
      animation: 'fwb-spin 0.8s linear infinite',
    },
  })
}

function Btn({ children, onClick, kind = 'ghost', disabled = false, title, style }) {
  const palette = {
    primary: { bg: T.brand, fg: 'var(--dsw-alias-text-on-brand, #fff)', border: T.brand },
    ghost: { bg: 'transparent', fg: T.text, border: T.border },
    danger: { bg: 'transparent', fg: T.error, border: T.border },
  }[kind] ?? { bg: 'transparent', fg: T.text, border: T.border }
  return h('button', {
    type: 'button', title, disabled, onClick,
    style: {
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px',
      borderRadius: T.radiusSm, border: `1px solid ${palette.border}`, background: palette.bg,
      color: palette.fg, font: `inherit`, fontSize: T.fs, cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1, ...style,
    },
  }, children)
}

function Card({ children, style }) {
  return h('div', {
    style: {
      border: `1px solid ${T.border}`, borderRadius: T.radius, background: T.bgRaised,
      padding: 12, ...style,
    },
  }, children)
}

function Empty({ text }) {
  return h('div', { style: { padding: 28, textAlign: 'center', color: T.textFaint, fontSize: T.fs } }, text ?? t('common.empty'))
}

function PageStub({ name }) {
  return h('div', { style: { padding: 20 } },
    h(Card, null,
      h('div', { style: { fontWeight: 600, marginBottom: 6 } }, name),
      h('div', { style: { color: T.textDim, fontSize: T.fs } }, t('boot.placeholder'))))
}