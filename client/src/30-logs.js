/* ====================================================================== *
 * 30-logs.js — owner: dev-ui-core
 *
 * LogsPage: a real console over the host's log ring buffer.
 *
 *  - incremental fetch with the `since` cursor (append + dedupe by seq);
 *  - follow mode with auto-scroll and a "N new lines" jump button;
 *  - level chips, source chips, a run filter and a debounced regex search
 *    (invalid regex is reported instead of silently ignored);
 *  - ANSI-free monospace rows with a level colour, click to expand metadata
 *    and stack frames, "jump to source" through actions.openFile;
 *  - row virtualization (fixed offsets, absolute rows) so 4000 buffered lines
 *    stay smooth, and it grows correctly when a row is expanded;
 *  - copy all / export .log / clear view and honest empty states.
 * ====================================================================== */

/** Client-side mirror cap — host capacity is settings.logCapacity (default 4000). */
const LOG_BUFFER_LIMIT = 4000
/** Page size for one fetch window. */
const LOG_PAGE_LIMIT = 500
/** Follow-mode poll cadence. */
const LOG_POLL_MS = 1000
/** Collapsed row height (px) — must match the rendered row. */
const LOG_ROW_HEIGHT = 22

/**
 * Fetch one log window, preferring the shared action so other pages see the
 * same totals, and falling back to a direct request if the action is missing.
 */
async function loadLogWindow(actions, query) {
  if (actions !== null && actions !== undefined && typeof actions.fetchLogs === 'function') {
    return actions.fetchLogs(query)
  }
  const data = await api('/logs', { query })
  return {
    entries: Array.isArray(data.entries) ? data.entries : [],
    nextCursor: Number(data.nextCursor ?? 0),
    total: Number(data.total ?? 0),
    dropped: Number(data.dropped ?? 0),
  }
}

/**
 * Extract `{ file, line, column, symbol }` frames from a log entry:
 * explicit `meta.frames`, a `meta.stack` string, or `file.dart:line:col`
 * patterns inside the text.
 */
function extractFrames(entry) {
  const frames = []
  const push = (file, line, column, symbol) => {
    if (file === undefined || file === null || file === '') return
    frames.push({
      file: String(file),
      line: line === undefined || line === null || Number.isNaN(Number(line)) ? null : Number(line),
      column: column === undefined || column === null || Number.isNaN(Number(column)) ? null : Number(column),
      symbol: symbol === undefined || symbol === null || symbol === '' ? null : String(symbol),
    })
  }
  const meta = entry?.meta
  if (meta !== null && typeof meta === 'object') {
    if (Array.isArray(meta.frames)) {
      for (const frame of meta.frames) push(frame?.file, frame?.line, frame?.column, frame?.symbol)
    } else if (typeof meta.stack === 'string') {
      for (const line of meta.stack.split('\n')) {
        const match = line.match(/((?:[A-Za-z]:)?[^\s():]+\.dart):(\d+)(?::(\d+))?/)
        if (match !== null) push(match[1], match[2], match[3], line.trim())
      }
    }
  }
  if (frames.length === 0 && typeof entry?.text === 'string') {
    for (const line of entry.text.split('\n')) {
      const match = line.match(/((?:[A-Za-z]:)?[^\s():]+\.dart):(\d+)(?::(\d+))?/)
      if (match !== null) push(match[1], match[2], match[3], null)
      if (frames.length >= 12) break
    }
  }
  return frames.slice(0, 24)
}

/** Estimated height of an expanded row (metadata + frames, clamped). */
function expandedRowHeight(entry) {
  const meta = entry?.meta
  let metaLines = 0
  if (meta !== null && meta !== undefined) {
    try {
      metaLines = JSON.stringify(meta, null, 2).split('\n').length
    } catch {
      metaLines = 1
    }
  }
  const frames = extractFrames(entry).length
  const metaHeight = meta === null || meta === undefined ? 0 : Math.min(180, metaLines * 16 + 10)
  const framesHeight = frames === 0 ? 0 : Math.min(180, frames * 17 + 20)
  return LOG_ROW_HEIGHT + 6 + metaHeight + framesHeight
}

/** Build a highlight regex from the search box; null when empty/invalid. */
function buildHighlightPattern(text) {
  const value = String(text ?? '')
  if (value.trim() === '') return { regex: null, error: null }
  try {
    return { regex: new RegExp(value, 'gi'), error: null }
  } catch (error) {
    return { regex: null, error: error?.message ?? String(error) }
  }
}

/** Split text into nodes, wrapping matches of `regex`. */
function highlightText(text, regex) {
  const value = String(text ?? '')
  if (regex === null) return value
  const parts = []
  let lastIndex = 0
  regex.lastIndex = 0
  let match = regex.exec(value)
  let guard = 0
  while (match !== null && guard < 200) {
    guard += 1
    if (match.index > lastIndex) parts.push(value.slice(lastIndex, match.index))
    parts.push(h('mark', {
      key: `m${guard}-${match.index}`,
      style: {
        background: `color-mix(in srgb, ${T.warn} 40%, transparent)`,
        color: 'inherit',
        borderRadius: T.radiusXs,
        padding: '0 1px',
      },
    }, match[0]))
    lastIndex = match.index + match[0].length
    if (match[0] === '') break
    match = regex.exec(value)
  }
  if (lastIndex < value.length) parts.push(value.slice(lastIndex))
  return parts.length === 0 ? value : parts
}

/** Binary search: index of the last offset <= target. */
function findRowIndex(offsets, target) {
  let low = 0
  let high = offsets.length - 1
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2)
    if (offsets[mid] <= target) low = mid
    else high = mid - 1
  }
  return low
}

/** One console row (collapsed line + expansion). */
function LogRow({ entry, top, height, expanded, onToggle, onOpenFile, regex }) {
  const [hover, bind] = useHover()
  const tone = levelTone(entry.level)
  const colors = toneColors(tone)
  const time = formatTime(entry.at, { ms: true })
  const text = stripAnsi(entry.text)
  const frames = expanded === true ? extractFrames(entry) : []
  const hasMeta = entry.meta !== null && entry.meta !== undefined
  const expandable = hasMeta || frames.length > 0
  return h('div', {
    style: {
      position: 'absolute',
      left: 0,
      right: 0,
      top,
      height,
      display: 'flex',
      flexDirection: 'column',
      borderBottom: `1px solid ${T.border}`,
      background: hover && expandable ? T.hover : 'transparent',
      overflow: 'hidden',
    },
    ...bind,
  },
    h('div', {
      role: expandable ? 'button' : undefined,
      onClick: expandable ? onToggle : undefined,
      title: expandable ? (expanded === true ? t('logs.collapseHint') : t('logs.expandHint')) : undefined,
      style: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        height: LOG_ROW_HEIGHT,
        padding: '0 8px',
        cursor: expandable ? 'pointer' : 'default',
        fontSize: T.fsSm,
        lineHeight: `${LOG_ROW_HEIGHT}px`,
        minWidth: 0,
      },
    },
      h('span', { style: { width: 84, flex: 'none', color: T.textFaint, fontFamily: T.mono, fontSize: T.fsXs } }, time),
      h('span', {
        style: {
          width: 42, flex: 'none', textAlign: 'center', borderRadius: T.radiusXs, height: 15, lineHeight: '15px',
          marginTop: 3, background: colors.bg, color: colors.fg, fontSize: 10, fontWeight: 700,
          textTransform: 'uppercase', letterSpacing: 0.3,
        },
      }, entry.level ?? 'info'),
      h('span', {
        style: {
          width: 62, flex: 'none', color: T.textDim, fontFamily: T.mono, fontSize: T.fsXs,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        },
        title: entry.source,
      }, entry.source ?? ''),
      h('span', {
        style: {
          flex: 1, minWidth: 0, fontFamily: T.mono, fontSize: T.fsSm, color: tone === 'error' ? T.error : tone === 'warn' ? T.warnLabel : T.text,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        },
        title: truncate(text, 400),
      }, highlightText(text, regex)),
      expandable ? h(Icon, { name: expanded === true ? 'chevronDown' : 'chevronRight', size: 11, color: T.textFaint, style: { marginTop: 5 } }) : null),

    expanded === true
      ? h('div', {
        style: {
          padding: '2px 8px 6px 92px',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          overflow: 'hidden',
          flex: 1,
          minHeight: 0,
        },
      },
        frames.length === 0 ? null : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 1 } },
          h('div', { style: { fontSize: T.fsXs, color: T.textFaint } }, t('logs.frames')),
          frames.map((frame, index) => h('div', { key: index, style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
            h(Mono, { size: T.fsXs, style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              `${frame.file}${frame.line === null ? '' : `:${frame.line}`}${frame.column === null ? '' : `:${frame.column}`}${frame.symbol === null ? '' : `  ${truncate(frame.symbol, 90)}`}`),
            h(Btn, {
              size: 'sm',
              icon: 'code',
              onClick: (event) => {
                if (event !== undefined && event.stopPropagation !== undefined) event.stopPropagation()
                onOpenFile(frame.file, frame.line)
              },
            }, t('logs.openSource'))))),
        hasMeta
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
            h('div', { style: { fontSize: T.fsXs, color: T.textFaint } }, t('logs.meta')),
            h('pre', {
              className: 'fwb-scroll',
              style: {
                margin: 0,
                padding: '4px 6px',
                maxHeight: 150,
                overflow: 'auto',
                borderRadius: T.radiusSm,
                border: `1px solid ${T.border}`,
                background: T.code,
                color: T.textDim,
                fontFamily: T.mono,
                fontSize: T.fsXs,
                lineHeight: '15px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              },
            }, safeJson(entry.meta)))
          : null)
      : null)
}

/** Stable pretty JSON for metadata (never throws). */
function safeJson(value) {
  try {
    const text = JSON.stringify(value, null, 2)
    return text === undefined ? String(value) : text
  } catch {
    return String(value)
  }
}

/**
 * Log console page.
 * @param {{state: object, actions: object}} props page props from the shell.
 * @returns {any} page element.
 */
function LogsPage({ state: sharedState, actions: sharedActions }) {
  ensureStyles()
  const s = sharedState ?? {}
  const a = sharedActions ?? s.actions ?? {}
  const activeRunId = s.activeRunId ?? null

  const [entries, setEntries] = React.useState(() => (Array.isArray(s.logs?.entries) ? s.logs.entries : []))
  const [total, setTotal] = React.useState(Number(s.logs?.total ?? 0))
  const [dropped, setDropped] = React.useState(Number(s.logs?.dropped ?? 0))
  const [cursor, setCursor] = React.useState(Number(s.logs?.nextCursor ?? 0))
  const [follow, setFollow] = React.useState(true)
  const [levelList, setLevelList] = React.useState([])
  const [sourceList, setSourceList] = React.useState([])
  const [search, setSearch] = React.useState('')
  const [pattern, setPattern] = React.useState('')
  const [runOnly, setRunOnly] = React.useState(false)
  const [expanded, setExpanded] = React.useState({})
  const [newCount, setNewCount] = React.useState(0)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(null)
  const [scrollTop, setScrollTop] = React.useState(0)
  const [viewport, setViewport] = React.useState(520)
  const [atBottom, setAtBottom] = React.useState(true)

  const listRef = React.useRef(null)
  const cursorRef = React.useRef(cursor)
  const entriesRef = React.useRef(entries)
  cursorRef.current = cursor
  entriesRef.current = entries

  /* Actions/state live in refs so fetch callbacks stay identity-stable. */
  const liveRef = React.useRef({ actions: a, runId: activeRunId })
  liveRef.current = { actions: a, runId: activeRunId }

  const query = React.useMemo(() => {
    const next = { limit: LOG_PAGE_LIMIT }
    if (levelList.length > 0) next.levels = levelList
    if (sourceList.length > 0) next.sources = sourceList
    if (pattern !== '') next.pattern = pattern
    if (runOnly === true) {
      const runId = liveRef.current.runId
      if (runId !== null && runId !== undefined) next.runId = runId
    }
    return next
  }, [levelList, sourceList, pattern, runOnly, activeRunId])

  const queryRef = React.useRef(query)
  queryRef.current = query

  const highlight = React.useMemo(() => buildHighlightPattern(pattern), [pattern])
  const regex = highlight.regex

  /* Debounce the search box into the server-side `pattern`. */
  React.useEffect(() => {
    const timer = window.setTimeout(() => setPattern(search.trim()), 260)
    return () => window.clearTimeout(timer)
  }, [search])

  /** Full reload: newest matching window from since=0. */
  const reload = React.useCallback(async () => {
    setLoading(true)
    try {
      const payload = await loadLogWindow(liveRef.current.actions, { ...queryRef.current, since: 0 })
      setEntries(payload.entries.slice(-LOG_BUFFER_LIMIT))
      setTotal(Number(payload.total ?? 0))
      setDropped(Number(payload.dropped ?? 0))
      setCursor(Number(payload.nextCursor ?? 0))
      cursorRef.current = Number(payload.nextCursor ?? 0)
      setNewCount(0)
      setError(null)
    } catch (issue) {
      setError(issue ?? new Error(t('state.offline')))
    } finally {
      setLoading(false)
    }
  }, [])

  /** Incremental pull: only entries newer than the cursor. */
  const pull = React.useCallback(async () => {
    try {
      const since = Number(cursorRef.current) || 0
      const payload = await loadLogWindow(liveRef.current.actions, { ...queryRef.current, since })
      if (payload.entries.length > 0) {
        const known = new Set(entriesRef.current.map((entry) => entry.seq))
        const fresh = payload.entries.filter((entry) => known.has(entry.seq) !== true)
        if (fresh.length > 0) {
          setEntries((previous) => {
            const merged = [...previous, ...fresh]
            return merged.length > LOG_BUFFER_LIMIT ? merged.slice(merged.length - LOG_BUFFER_LIMIT) : merged
          })
          if (follow !== true) setNewCount((count) => count + fresh.length)
        }
      }
      setTotal(Number(payload.total ?? 0))
      setDropped(Number(payload.dropped ?? 0))
      if (payload.nextCursor > 0) {
        setCursor(Number(payload.nextCursor))
        cursorRef.current = Number(payload.nextCursor)
      }
      setError(null)
    } catch (issue) {
      setError(issue ?? new Error(t('state.offline')))
    } finally {
      setLoading(false)
    }
  }, [follow])

  /* Reload whenever the server-side filter set changes. */
  React.useEffect(() => { void reload() }, [query, reload])

  /* Follow polling. */
  React.useEffect(() => {
    if (follow !== true) return undefined
    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void pull()
    }, LOG_POLL_MS)
    return () => window.clearInterval(timer)
  }, [follow, pull])

  /* The shell's `R` hint asks the console for a full reload. */
  React.useEffect(() => {
    const onRefresh = () => { void reload() }
    window.addEventListener('fwb:logs-refresh', onRefresh)
    return () => window.removeEventListener('fwb:logs-refresh', onRefresh)
  }, [reload])

  /* Measure the scroll viewport once mounted and on resize. */
  React.useEffect(() => {
    const node = listRef.current
    if (node === null || node === undefined) return undefined
    const measure = () => setViewport(node.clientHeight || 520)
    measure()
    let observer = null
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(measure)
      observer.observe(node)
    } else {
      window.addEventListener('resize', measure)
    }
    return () => {
      if (observer !== null) observer.disconnect()
      else window.removeEventListener('resize', measure)
    }
  }, [])

  /* Keep the newest line visible while following. */
  React.useEffect(() => {
    if (follow !== true) return
    const node = listRef.current
    if (node === null || node === undefined) return
    node.scrollTop = node.scrollHeight
    setScrollTop(node.scrollTop)
    setAtBottom(true)
  }, [entries.length, follow])

  const toggleInList = (list, value, setList) => {
    setList(list.includes(value) ? list.filter((item) => item !== value) : [...list, value])
  }

  const toggleRow = (seq) => {
    setExpanded((previous) => ({ ...previous, [seq]: previous[seq] !== true }))
  }

  const openFile = (file, line) => {
    const action = liveRef.current.actions
    if (typeof action.openFile === 'function') {
      void action.openFile(file, line)
      return
    }
    void copyText(`${file}${line === null || line === undefined ? '' : `:${line}`}`)
    action.toast?.(t('logs.openFailed', { message: t('common.copyFailed') }), 'error')
  }

  const consoleText = React.useCallback(() => entriesRef.current.map((entry) => {
    const stamp = formatTime(entry.at, { ms: true })
    return `${stamp} ${String(entry.level ?? 'info').toUpperCase().padEnd(5)} ${String(entry.source ?? '').padEnd(9)} ${stripAnsi(entry.text)}`
  }).join('\n'), [])

  const copyAll = async () => {
    const text = consoleText()
    const ok = await copyText(text)
    a.toast?.(ok ? t('logs.copyAllDone', { n: entriesRef.current.length }) : t('common.copyFailed'), ok ? 'ok' : 'error')
  }

  const exportAll = () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const name = downloadText(`flutter-workbench-${stamp}.log`, consoleText())
    a.toast?.(t('logs.exported', { name }), 'ok')
  }

  const clearView = () => {
    setEntries([])
    entriesRef.current = []
    setExpanded({})
    setNewCount(0)
    a.toast?.(t('logs.cleared'), 'ok')
  }

  const markLog = async () => {
    if (typeof a.markLog !== 'function') return
    const text = typeof window.prompt === 'function' ? window.prompt(t('logs.markPrompt'), '') : ''
    if (text === null || text === undefined) return
    try {
      await a.markLog(text)
      a.toast?.(t('logs.marked'), 'ok')
      await pull()
    } catch (issue) {
      a.toast?.(t('common.actionFailed', { message: issue?.message ?? String(issue) }), 'error')
    }
  }

  const jumpToBottom = () => {
    const node = listRef.current
    if (node !== null && node !== undefined) {
      node.scrollTop = node.scrollHeight
      setScrollTop(node.scrollTop)
    }
    setFollow(true)
    setNewCount(0)
  }

  /* ---- virtualization ------------------------------------------------- */

  const rowHeights = React.useMemo(() => entries.map((entry) => (
    expanded[entry.seq] === true ? expandedRowHeight(entry) : LOG_ROW_HEIGHT
  )), [entries, expanded])

  const offsets = React.useMemo(() => {
    const list = new Array(rowHeights.length + 1)
    list[0] = 0
    for (let index = 0; index < rowHeights.length; index += 1) list[index + 1] = list[index] + rowHeights[index]
    return list
  }, [rowHeights])

  const visible = React.useMemo(() => {
    if (entries.length === 0) return { start: 0, end: 0 }
    const start = Math.max(0, findRowIndex(offsets, Math.max(0, scrollTop)) - 1)
    const end = Math.min(entries.length, findRowIndex(offsets, scrollTop + viewport + 1) + 2)
    return { start, end }
  }, [entries.length, offsets, scrollTop, viewport])

  const filtersActive = levelList.length > 0 || sourceList.length > 0 || pattern !== '' || runOnly === true

  const resetFilters = () => {
    setLevelList([])
    setSourceList([])
    setSearch('')
    setPattern('')
    setRunOnly(false)
  }

  const onListScroll = (event) => {
    const node = event.currentTarget
    setScrollTop(node.scrollTop)
    const gap = node.scrollHeight - node.scrollTop - node.clientHeight
    const bottom = gap < 24
    setAtBottom(bottom)
    if (bottom !== true && follow === true) setFollow(false)
  }

  return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, minWidth: 0 } },
    /* ---- toolbar ---------------------------------------------------- */
    h('div', {
      style: {
        display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 12px',
        borderBottom: `1px solid ${T.border}`, flexShrink: 0, background: T.l1,
      },
    },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
        h('div', { style: { flex: '1 1 220px', minWidth: 180 } },
          h(Input, {
            value: search,
            onChange: setSearch,
            placeholder: t('logs.searchPlaceholder'),
            mono: true,
            invalid: highlight.error !== null,
            size: 'sm',
          })),
        h(Chip, {
          active: follow,
          onClick: () => { if (follow !== true) jumpToBottom(); else setFollow(false) },
          title: follow === true ? t('logs.followOn') : t('logs.followPaused'),
        }, h(Icon, { name: follow === true ? 'pause' : 'play', size: 11 }), t('logs.follow')),
        h(Chip, {
          active: runOnly,
          onClick: () => setRunOnly((value) => value !== true),
          disabled: activeRunId === null || activeRunId === undefined,
          title: t('logs.currentRunOnly'),
        }, t('logs.currentRunOnly')),
        h('div', { style: { flex: 1 } }),
        h(IconBtn, { icon: 'refresh', title: t('common.refresh'), onClick: () => { void reload() } }),
        h(IconBtn, { icon: 'spark', title: t('logs.mark'), onClick: () => { void markLog() } }),
        h(IconBtn, { icon: 'copy', title: t('logs.copyAll'), onClick: () => { void copyAll() } }),
        h(IconBtn, { icon: 'download', title: t('logs.export'), onClick: exportAll }),
        h(IconBtn, { icon: 'trash', title: t('logs.clear'), onClick: clearView })),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', rowGap: 4 } },
        h('span', { style: { fontSize: T.fsXs, color: T.textFaint } }, t('logs.levels')),
        LEVELS.map((level) => h(Chip, {
          key: level,
          active: levelList.includes(level),
          onClick: () => toggleInList(levelList, level, setLevelList),
          title: level,
        }, level)),
        h('span', { style: { width: 1, height: 16, background: T.border } }),
        h('span', { style: { fontSize: T.fsXs, color: T.textFaint } }, t('logs.sources')),
        SOURCES.map((source) => h(Chip, {
          key: source,
          active: sourceList.includes(source),
          onClick: () => toggleInList(sourceList, source, setSourceList),
        }, source)),
        filtersActive ? h(Btn, { size: 'sm', kind: 'text', onClick: resetFilters }, t('logs.resetFilters')) : null),
      highlight.error === null ? null : h('div', { style: { fontSize: T.fsXs, color: T.error } }, t('logs.regexInvalid', { message: highlight.error })),
      error === null ? null : h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 8, fontSize: T.fsXs, color: T.error,
          padding: '4px 6px', borderRadius: T.radiusSm,
          background: `color-mix(in srgb, ${T.error} 10%, transparent)`,
        },
      },
        h(Icon, { name: 'warn', size: 12 }),
        h('span', { style: { flex: 1, minWidth: 0 } }, error.message ?? String(error)),
        h(Btn, { size: 'sm', onClick: () => { void reload() } }, t('common.retry')))),

    /* ---- console ---------------------------------------------------- */
    h('div', { style: { position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
      entries.length === 0
        ? h('div', { style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' } },
          loading === true
            ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, color: T.textDim } }, h(Spinner, null), t('common.loading'))
            : h(Empty, {
              icon: 'logs',
              title: filtersActive ? t('logs.noMatch') : t('logs.emptyTitle'),
              body: t('logs.emptyBody'),
              action: filtersActive ? h(Btn, { size: 'sm', onClick: resetFilters }, t('logs.resetFilters')) : null,
            }))
        : h('div', {
            ref: listRef,
            className: 'fwb-scroll',
            onScroll: onListScroll,
            style: { flex: 1, minHeight: 0, overflow: 'auto', position: 'relative', fontFamily: T.mono },
          },
          h('div', { style: { position: 'relative', height: offsets[offsets.length - 1] } },
            entries.slice(visible.start, visible.end).map((entry, index) => {
              const rowIndex = visible.start + index
              return h(LogRow, {
                key: entry.seq,
                entry,
                top: offsets[rowIndex],
                height: rowHeights[rowIndex],
                expanded: expanded[entry.seq] === true,
                onToggle: () => toggleRow(entry.seq),
                onOpenFile: openFile,
                regex,
              })
            }))),

      /* new-lines pill while scrolled up */
      newCount > 0 && follow !== true
        ? h('button', {
          type: 'button',
          onClick: jumpToBottom,
          style: {
            position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 10,
            display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 10px',
            borderRadius: T.radiusMd, border: `1px solid ${T.borderStrong}`, background: T.bgRaised,
            color: T.text, fontSize: T.fsXs, cursor: 'pointer', boxShadow: T.shadow,
          },
        },
          h(Icon, { name: 'arrowDown', size: 11 }),
          t('logs.newLines', { n: newCount }))
        : null),

    /* ---- status strip ----------------------------------------------- */
    h('div', {
      style: {
        display: 'flex', alignItems: 'center', gap: 10, padding: '3px 12px',
        borderTop: `1px solid ${T.border}`, color: T.textFaint, fontSize: T.fsXs,
        flexShrink: 0, flexWrap: 'wrap', background: T.l1,
      },
    },
      h('span', null, t('logs.showing', { shown: entries.length, total })),
      dropped > 0 ? h('span', { style: { color: T.warnLabel } }, t('logs.truncated', { n: LOG_BUFFER_LIMIT })) : null,
      entries.length > LOG_PAGE_LIMIT ? h('span', null, t('logs.virtualized', { n: entries.length })) : null,
      filtersActive ? h('span', { style: { color: T.brand } }, t('logs.filtersActive')) : null,
      atBottom !== true && follow !== true ? h('span', { style: { color: T.warnLabel } }, t('logs.followPaused')) : null,
      h('span', { style: { flex: 1 } }),
      h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(Kbd, null, 'R'), t('logs.follow'))))
}