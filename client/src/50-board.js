/* ====================================================================== *
 * 50-board.js — owner: dev-ui-data
 *
 * BoardPage: the AI-driven kanban board (docs/CONTRACTS.md §4 Task shape,
 * §6 board routes, §8.2 state/actions).
 *
 *   lanes    backlog → ready → running → review → verify → done, each with a
 *            live count; cards drag between lanes and reorder inside a lane
 *            (HTML5 drag events) with a keyboard/menu alternative
 *   moves    optimistic + rollback + error toast; entering `done` needs
 *            result.verdict === 'pass', otherwise a confirm/force path
 *   author   quick-add composer in the backlog header, editor modal
 *            (title/detail/acceptance/verify/files/priority/tags),
 *            "AI 拆解" dialog POST /board/decompose
 *   agent    per-card dispatch / report / cancel / open session, agent status,
 *            result and history timeline; AI-working cards and cards awaiting
 *            human acceptance are visually distinct
 *   strip    compact "我的待验收" summary at the top of the page
 *
 * Kit surface consumed: Btn, IconBtn, Pill, Chip, Card, Field, Input, TextArea,
 * Select, Modal, Empty, Spinner, Mono, t. Shared helpers come from 40-network.js
 * (fwbActions, fwbInvoke, fwbLines, fwbReadValue, fwbClock, fwbAgo, fwbCopy,
 * useFwbNotify, FwbPage, FwbNotice).
 * ====================================================================== */

/* ------------------------------------------------------------ constants -- */

const FWB_BOARD_LANES = ['backlog', 'ready', 'running', 'review', 'verify', 'done']
const FWB_BOARD_LANE_FALLBACK = FWB_BOARD_LANES.map((id, order) => ({ id, label: id, order }))
const FWB_BOARD_PRIORITIES = ['low', 'normal', 'high', 'urgent']
const FWB_BOARD_PRIORITY_RANK = { low: 1, normal: 2, high: 3, urgent: 4 }
/** Lanes where a human still has to sign the card off. */
const FWB_BOARD_REVIEW_LANES = ['review', 'verify']

function fwbClamp(value, lo, hi) {
  const n = Number(value)
  if (Number.isFinite(n) === false) return lo
  return Math.min(hi, Math.max(lo, n))
}

function fwbBoardLaneLabel(id) {
  if (FWB_BOARD_LANES.includes(id)) return t(`board.lane.${id}`)
  return String(id ?? '?')
}

function fwbBoardLaneTone(id) {
  if (id === 'running') return 'brand'
  if (id === 'review' || id === 'verify') return 'warn'
  if (id === 'done') return 'ok'
  if (id === 'ready') return 'info'
  return 'neutral'
}

function fwbBoardPriorityLabel(id) {
  return FWB_BOARD_PRIORITIES.includes(id) ? t(`board.priority.${id}`) : String(id ?? '')
}

function fwbBoardPriorityTone(id) {
  if (id === 'urgent') return 'error'
  if (id === 'high') return 'warn'
  if (id === 'low') return 'muted'
  return 'neutral'
}

function fwbBoardSort(a, b) {
  const oa = Number(a?.order)
  const ob = Number(b?.order)
  const left = Number.isFinite(oa) ? oa : Number.MAX_SAFE_INTEGER
  const right = Number.isFinite(ob) ? ob : Number.MAX_SAFE_INTEGER
  if (left !== right) return left - right
  return (Number(a?.createdAt) || 0) - (Number(b?.createdAt) || 0)
}

/** True while an agent is (or is about to be) holding the card. */
function fwbBoardAgentActive(task) {
  const status = task?.agent?.status
  return status === 'working' || status === 'queued'
}

/** True when the card is waiting for a human decision. */
function fwbBoardAwaitingAcceptance(task) {
  if (task === null || task === undefined) return false
  if (FWB_BOARD_REVIEW_LANES.includes(task.lane)) return true
  return task.result?.verdict === 'pass' && task.lane !== 'done'
}

function fwbBoardAgentLabel(task) {
  const status = task?.agent?.status
  if (status === 'working') return t('board.agentWorking')
  if (status === 'queued') return t('board.agentQueued')
  if (status === 'blocked') return t('board.agentBlocked')
  if (status === 'done') return t('board.agentDone')
  if (status === 'failed') return t('board.agentFailed')
  return t('board.agentIdle')
}

/**
 * Group tasks into lanes for rendering, applying an in-flight optimistic move
 * (`override = { id, lane, index }`) without touching server state. Lanes that
 * only exist in the data (older boards) are appended so nothing disappears.
 */
function fwbBoardBuckets(laneList, tasks, override) {
  const laneIds = laneList.map((lane) => lane.id)
  const buckets = new Map()
  for (const id of laneIds) buckets.set(id, [])
  const hasOverride = override !== null && override !== undefined && typeof override.id === 'string'
  let moved = null

  for (const task of tasks) {
    if (hasOverride === true && task?.id === override.id) {
      moved = task
      continue
    }
    const laneId = typeof task?.lane === 'string' && task.lane !== '' ? task.lane : 'backlog'
    if (buckets.has(laneId) === false) buckets.set(laneId, [])
    buckets.get(laneId).push(task)
  }
  for (const list of buckets.values()) list.sort(fwbBoardSort)
  if (hasOverride === true && moved !== null) {
    const laneId = buckets.has(override.lane) ? override.lane : (moved.lane ?? 'backlog')
    const list = buckets.get(laneId) ?? []
    const index = Number.isInteger(override.index) ? fwbClamp(override.index, 0, list.length) : list.length
    list.splice(index, 0, { ...moved, lane: laneId })
    buckets.set(laneId, list)
  }
  return laneIds.map((id) => ({ id, items: buckets.get(id) ?? [] }))
}

/** Filter predicate for the board toolbar. */
function fwbBoardMatches(task, filters) {
  if (task === null || task === undefined) return false
  if (filters.projectId !== '' && String(task.projectId ?? '') !== filters.projectId) return false
  if (filters.priority !== '' && String(task.priority ?? 'normal') !== filters.priority) return false
  if (filters.tag !== '') {
    const tags = Array.isArray(task.tags) ? task.tags : []
    if (tags.includes(filters.tag) === false) return false
  }
  if (filters.text !== '') {
    const needle = filters.text.toLowerCase()
    const haystack = [task.title, task.detail, ...(Array.isArray(task.tags) ? task.tags : [])]
      .map((part) => String(part ?? '').toLowerCase())
      .join('\n')
    if (haystack.includes(needle) === false) return false
  }
  return true
}

/** Poll GET /board (the board is the app's primary data source). */
function useFwbBoard(intervalMs) {
  const poll = usePoll(() => api('/board'), intervalMs, [])
  const payload = poll.data ?? null
  const board = payload?.board ?? payload ?? null
  const tasks = Array.isArray(board?.tasks) ? board.tasks : []
  const laneList = Array.isArray(board?.lanes) && board.lanes.length > 0
    ? [...board.lanes].sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
    : FWB_BOARD_LANE_FALLBACK
  return {
    board,
    tasks,
    laneList,
    loading: poll.loading === true,
    error: poll.error ?? null,
    refresh: poll.refresh,
  }
}

/** "command | status | exitCode" lines → the report payload shape. */
function fwbBoardParseCommands(text) {
  return fwbLines(text).map((line) => {
    const parts = line.split('|').map((part) => part.trim())
    const exit = Number(parts[2])
    const status = parts[1] === 'failed' ? 'failed' : 'passed'
    return { command: parts[0] ?? '', status, exitCode: Number.isFinite(exit) ? exit : null }
  }).filter((row) => row.command !== '')
}

function fwbBoardCommandsText(rows) {
  if (Array.isArray(rows) === false) return ''
  return rows.map((row) => [row?.command ?? '', row?.status ?? 'passed', row?.exitCode ?? ''].join(' | ')).join('\n')
}

/* ------------------------------------------------------------- composer -- */

/** Quick-add composer pinned to the top of the backlog column. */
function FwbBoardQuickAdd({ onCreate, busy }) {
  const [draft, setDraft] = React.useState('')
  const submit = async () => {
    const title = draft.trim()
    if (title === '') return
    const ok = await onCreate(title)
    if (ok === true) setDraft('')
  }
  return h('div', { style: { display: 'flex', gap: 4, padding: '6px 6px 4px' } },
    h(Input, {
      value: draft,
      onChange: (next) => setDraft(String(fwbReadValue(next) ?? '')),
      onKeyDown: (event) => {
        if (event?.key === 'Enter' && event.shiftKey !== true) {
          event.preventDefault()
          submit()
        }
      },
      onEnter: () => submit(),
      placeholder: t('board.quickAdd'),
      title: t('board.quickAddHint'),
      size: 'sm',
      style: { flex: 1, minWidth: 0 },
    }),
    h(Btn, { onClick: submit, kind: 'primary', disabled: busy === true || draft.trim() === '', style: { padding: '4px 8px' } }, busy === true ? h(Spinner, { size: 12 }) : t('board.add')))
}

/* ----------------------------------------------------------------- card -- */

function FwbBoardCard({ task, index, menuOpen, menuLanes, dragging, dropTarget, onOpen, onDragStart, onDragEnd, onDragOverCard, onDropAt, onMenu, onMoveLane, onKeyMove, busy, onDispatch, onReport, onCancelAgent, onOpenSession }) {
  const agentActive = fwbBoardAgentActive(task)
  const awaiting = fwbBoardAwaitingAcceptance(task)
  const blocked = task?.blocked === true || task?.agent?.status === 'blocked'
  const verdict = task?.result?.verdict ?? null
  const acceptance = Array.isArray(task?.acceptance) ? task.acceptance : []
  const verify = Array.isArray(task?.verify) ? task.verify : []
  const files = Array.isArray(task?.files) ? task.files : []
  const tags = Array.isArray(task?.tags) ? task.tags : []
  const history = Array.isArray(task?.history) ? task.history : []

  let border = T.border
  if (blocked === true) border = T.error
  else if (agentActive === true) border = T.brand
  else if (awaiting === true) border = T.warn

  return h('div', {
    draggable: true,
    tabIndex: 0,
    role: 'listitem',
    'data-task-id': task?.id,
    title: t('board.openHint'),
    onDragStart: (event) => {
      try {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', String(task?.id ?? ''))
        event.dataTransfer.setData('application/x-fwb-task', String(task?.id ?? ''))
      } catch (error) {
        /* some engines refuse custom types; the ref fallback still works */
      }
      onDragStart()
    },
    onDragEnd,
    onDragOver: (event) => {
      event.preventDefault()
      event.stopPropagation()
      onDragOverCard()
    },
    onDrop: (event) => {
      event.preventDefault()
      event.stopPropagation()
      onDropAt(index)
    },
    onClick: onOpen,
    onKeyDown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onOpen()
        return
      }
      if ((event.ctrlKey === true || event.metaKey === true) && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault()
        onKeyMove(event.key === 'ArrowLeft' ? -1 : 1)
      }
    },
    style: {
      position: 'relative', textAlign: 'left', cursor: 'grab', padding: '7px 8px', margin: '3px 6px',
      border: `1px solid ${border}`, borderLeft: `3px solid ${border}`,
      borderRadius: T.radiusSm, background: T.bgRaised, color: T.text, font: 'inherit',
      fontSize: 12, opacity: dragging === true ? 0.45 : 1,
      boxShadow: dropTarget === true ? `0 0 0 2px ${T.brand}` : 'none',
      outline: 'none',
    },
  },
    h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 6 } },
      h('div', { style: { flex: 1, minWidth: 0, fontWeight: 600, lineHeight: 1.35, overflowWrap: 'anywhere' } }, String(task?.title ?? '')),
      h(IconBtn, {
        onClick: (event) => {
          if (event !== undefined && event !== null && typeof event.stopPropagation === 'function') event.stopPropagation()
          onMenu()
        },
        title: t('board.moveTo'),
        size: 22,
        active: menuOpen === true,
        style: { flexShrink: 0 },
      }, '⋯')),

    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 5 } },
      h(Pill, { tone: fwbBoardPriorityTone(task?.priority), style: { fontSize: 10 } }, fwbBoardPriorityLabel(task?.priority)),
      agentActive === true ? h(Pill, { tone: 'brand', dot: true, style: { fontSize: 10 } }, `${fwbBoardAgentLabel(task)}`) : null,
      awaiting === true ? h(Pill, { tone: 'warn', style: { fontSize: 10, color: T.warn } }, t('board.awaitingAcceptance')) : null,
      blocked === true ? h(Pill, { tone: 'error', style: { fontSize: 10, color: T.error } }, t('board.blocked')) : null,
      verdict === 'pass' ? h(Pill, { tone: 'ok', style: { fontSize: 10, color: T.ok } }, t('board.verdictPass')) : null,
      verdict === 'fail' ? h(Pill, { tone: 'error', style: { fontSize: 10, color: T.error } }, t('board.verdictFail')) : null),

    tags.length > 0
      ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 4 } },
        tags.slice(0, 4).map((tag) => h('span', {
          key: String(tag),
          style: { fontSize: 10, padding: '1px 5px', borderRadius: 99, border: `1px solid ${T.border}`, color: T.textDim },
        }, String(tag))),
        tags.length > 4 ? h('span', { style: { fontSize: 10, color: T.textFaint } }, `+${tags.length - 4}`) : null)
      : null,

    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 5, color: T.textFaint, fontSize: 10 } },
      acceptance.length > 0 ? h('span', null, t('board.acceptanceCount', { n: acceptance.length })) : null,
      verify.length > 0 ? h('span', null, t('board.verifyCount', { n: verify.length })) : null,
      files.length > 0 ? h('span', null, t('board.filesCount', { n: files.length })) : null,
      history.length > 0 ? h('span', null, `${t('board.history')} ${history.length}`) : null),

    // Per-card agent buttons: they stop propagation so a click never opens the modal.
    h('div', {
      style: { display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 },
      onClick: (event) => event.stopPropagation(),
    },
      agentActive === false
        ? h(Btn, { onClick: onDispatch, kind: 'primary', disabled: busy === true, title: t('board.dispatchHint'), style: { padding: '2px 7px', fontSize: 11 } },
          busy === true ? t('board.dispatching') : t('board.dispatch'))
        : null,
      h(Btn, { onClick: onReport, title: t('board.reportHint'), style: { padding: '2px 7px', fontSize: 11 } }, t('board.report')),
      agentActive === true ? h(Btn, { onClick: onCancelAgent, kind: 'danger', style: { padding: '2px 7px', fontSize: 11 } }, t('board.cancel')) : null,
      task?.agent?.sessionId !== null && task?.agent?.sessionId !== undefined
        ? h(Btn, { onClick: onOpenSession, style: { padding: '2px 7px', fontSize: 11 } }, t('board.openSession'))
        : null),

    menuOpen === true
      ? h('div', {
        style: {
          position: 'absolute', right: 4, top: 22, zIndex: 20, minWidth: 130, padding: 4,
          border: `1px solid ${T.borderStrong}`, borderRadius: T.radiusSm, background: T.bgRaised,
          boxShadow: `0 6px 18px ${T.overlay}`,
        },
        onClick: (event) => event.stopPropagation(),
      },
        h('div', { style: { fontSize: 10, color: T.textFaint, padding: '2px 4px 4px' } }, t('board.moveTo')),
        menuLanes.map((lane) => h('button', {
          key: lane.id,
          type: 'button',
          disabled: lane.id === task?.lane,
          onClick: () => onMoveLane(lane.id),
          style: {
            display: 'block', width: '100%', textAlign: 'left', padding: '3px 6px', margin: '1px 0',
            border: 'none', borderRadius: T.radiusSm, background: 'transparent', color: T.text,
            font: 'inherit', fontSize: 11, cursor: lane.id === task?.lane ? 'default' : 'pointer',
            opacity: lane.id === task?.lane ? 0.45 : 1,
          },
        }, fwbBoardLaneLabel(lane.id))),
        h('div', { style: { borderTop: `1px solid ${T.border}`, marginTop: 3, paddingTop: 3 } },
          h('button', {
            type: 'button',
            onClick: onOpen,
            style: { display: 'block', width: '100%', textAlign: 'left', padding: '3px 6px', border: 'none', background: 'transparent', color: T.text, font: 'inherit', fontSize: 11, cursor: 'pointer', borderRadius: T.radiusSm },
          }, t('board.edit'))))
      : null)
}

/* ---------------------------------------------------------------- modal -- */

/** Card detail + editor: acceptance checklist, verify commands, history, result. */
function FwbBoardCardModal({ task, act, provider, model, onClose, onChanged, push, onOpenSession }) {
  const [editing, setEditing] = React.useState(() => task?.id === null || task?.id === undefined)
  const [draft, setDraft] = React.useState(() => ({
    title: String(task?.title ?? ''),
    detail: String(task?.detail ?? ''),
    acceptance: (Array.isArray(task?.acceptance) ? task.acceptance : []).join('\n'),
    verify: (Array.isArray(task?.verify) ? task.verify : []).join('\n'),
    files: (Array.isArray(task?.files) ? task.files : []).join('\n'),
    priority: String(task?.priority ?? 'normal'),
    tags: (Array.isArray(task?.tags) ? task.tags : []).join(', '),
  }))
  const [busy, setBusy] = React.useState(false)

  const acceptance = Array.isArray(task?.acceptance) ? task.acceptance : []
  const verify = Array.isArray(task?.verify) ? task.verify : []
  const files = Array.isArray(task?.files) ? task.files : []
  const history = Array.isArray(task?.history) ? task.history : []
  const result = task?.result ?? null
  const isNew = task?.id === null || task?.id === undefined

  const save = async () => {
    if (draft.title.trim() === '') {
      push(t('board.titleRequired'), 'warn')
      return
    }
    setBusy(true)
    const patch = {
      title: draft.title.trim(),
      detail: draft.detail,
      acceptance: fwbLines(draft.acceptance),
      verify: fwbLines(draft.verify),
      files: fwbLines(draft.files),
      priority: draft.priority,
      tags: String(draft.tags ?? '').split(',').map((tag) => tag.trim()).filter((tag) => tag !== ''),
    }
    try {
      if (isNew === true) {
        const input = { ...patch, lane: 'backlog' }
        await fwbInvoke(act, 'createTask', [input], () => api('/board/task', { method: 'POST', body: { action: 'create', ...input } }))
        push(t('board.created'), 'ok')
        if (typeof onChanged === 'function') onChanged()
        onClose()
        return
      }
      await fwbInvoke(act, 'updateTask', [{ id: task.id, patch }], () => api('/board/task', { method: 'POST', body: { action: 'update', id: task.id, patch } }))
      push(t('board.saved'), 'ok')
      setEditing(false)
      if (typeof onChanged === 'function') onChanged()
    } catch (error) {
      push(`${t('board.saveFailed')}: ${String(error?.message ?? error)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    try {
      await fwbInvoke(act, 'deleteTask', [task.id], () => api('/board/task', { method: 'POST', body: { action: 'delete', id: task.id } }))
      push(t('board.deleted'), 'ok')
      if (typeof onChanged === 'function') onChanged()
      onClose()
    } catch (error) {
      push(`${t('board.deleteFailed')}: ${String(error?.message ?? error)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const dispatch = async () => {
    setBusy(true)
    try {
      const payload = { id: task.id }
      if (provider !== '') payload.provider = provider
      if (model !== '') payload.model = model
      const response = await fwbInvoke(act, 'dispatchTask', [payload], () => api('/board/dispatch', { method: 'POST', body: payload }))
      const sessionId = response?.sessionId ?? response?.task?.agent?.sessionId ?? '—'
      push(t('board.dispatchOk', { id: String(sessionId) }), 'ok')
      if (typeof onChanged === 'function') onChanged()
    } catch (error) {
      push(`${t('board.dispatchFailed')}: ${String(error?.message ?? error)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const view = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12 } },
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' } },
      h(Pill, { tone: fwbBoardLaneTone(task?.lane) }, fwbBoardLaneLabel(task?.lane)),
      h(Pill, { tone: fwbBoardPriorityTone(task?.priority) }, fwbBoardPriorityLabel(task?.priority)),
      h(Pill, { tone: fwbBoardAgentActive(task) ? 'brand' : 'neutral' }, `${t('board.agent')}: ${fwbBoardAgentLabel(task)}`),
      result?.verdict === 'pass' ? h(Pill, { tone: 'ok', style: { color: T.ok } }, t('board.verdictPass')) : null,
      result?.verdict === 'fail' ? h(Pill, { tone: 'error', style: { color: T.error } }, t('board.verdictFail')) : null,
      task?.blocked === true ? h(Pill, { tone: 'error', style: { color: T.error } }, t('board.blocked')) : null),

    task?.detail !== null && task?.detail !== undefined && String(task.detail) !== ''
      ? h('div', { style: { whiteSpace: 'pre-wrap', lineHeight: 1.6, color: T.text } }, String(task.detail))
      : h('div', { style: { color: T.textFaint } }, t('board.noDetail')),

    h(Card, { title: t('board.acceptanceTitle'), style: { padding: 8 } },
      acceptance.length === 0
        ? h('div', { style: { color: T.textFaint, fontSize: 11 } }, t('board.noAcceptance'))
        : h('ol', { style: { margin: 0, paddingLeft: 18, lineHeight: 1.7 } },
          acceptance.map((item, index) => h('li', { key: `acc-${index}` }, String(item))))),

    h(Card, { title: t('board.verifyTitle'), style: { padding: 8 } },
      verify.length === 0
        ? h('div', { style: { color: T.textFaint, fontSize: 11 } }, t('board.noVerify'))
        : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          verify.map((command, index) => h('div', { key: `ver-${index}`, style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h(Mono, { style: { flex: 1, minWidth: 0, fontSize: 11, overflowWrap: 'anywhere' } }, String(command)),
            h(FwbCopyBtn, { value: String(command), label: t('net.copy'), notify: push }))))),

    files.length > 0
      ? h(Card, { title: t('board.filesTitle'), style: { padding: 8 } },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
          files.map((file, index) => h('div', { key: `file-${index}`, style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h(Mono, { style: { flex: 1, minWidth: 0, fontSize: 11, overflowWrap: 'anywhere' } }, String(file)),
            h(Btn, {
              style: { padding: '2px 6px', fontSize: 11 },
              onClick: () => {
                const target = String(file).split(':')
                const line = Number(target[1])
                fwbInvoke(act, 'openFile', [target[0], Number.isFinite(line) ? line : undefined], () => api('/open', { method: 'POST', body: { file: target[0], line: Number.isFinite(line) ? line : undefined } }))
                  .catch((issue) => push(String(issue?.message ?? issue), 'error'))
              },
            }, t('board.openFile'))))))
      : null,

    result !== null && result !== undefined
      ? h(Card, { title: t('board.result'), style: { padding: 8 } },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          String(result.summary ?? '') !== '' ? h('div', { style: { whiteSpace: 'pre-wrap' } }, String(result.summary)) : null,
          Array.isArray(result.commandsRun) && result.commandsRun.length > 0
            ? h('div', null,
              h('div', { style: { color: T.textFaint, fontSize: 11, marginBottom: 2 } }, t('board.commands')),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                result.commandsRun.map((row, index) => h('div', { key: `cmd-${index}`, style: { display: 'flex', gap: 6, alignItems: 'center' } },
                  h(Pill, { tone: row?.status === 'failed' ? 'error' : 'ok', style: { fontSize: 10, color: row?.status === 'failed' ? T.error : T.ok } }, String(row?.status ?? 'passed')),
                  h(Mono, { style: { flex: 1, minWidth: 0, fontSize: 11, overflowWrap: 'anywhere' } }, String(row?.command ?? '')),
                  Number.isFinite(Number(row?.exitCode)) ? h('span', { style: { color: T.textFaint, fontSize: 10 } }, `exit ${row.exitCode}`) : null))))
            : null,
          Array.isArray(result.evidence) && result.evidence.length > 0
            ? h('div', null,
              h('div', { style: { color: T.textFaint, fontSize: 11, marginBottom: 2 } }, t('board.evidence')),
              h('ul', { style: { margin: 0, paddingLeft: 16, lineHeight: 1.6 } },
                result.evidence.map((item, index) => h('li', { key: `ev-${index}` }, String(item)))))
            : null))
      : h('div', { style: { color: T.textFaint, fontSize: 11 } }, t('board.resultEmpty')),

    h(Card, { title: t('board.history'), style: { padding: 8 } },
      history.length === 0
        ? h('div', { style: { color: T.textFaint, fontSize: 11 } }, t('board.historyEmpty'))
        : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 0, position: 'relative' } },
          [...history].reverse().map((entry, index) => h('div', {
            key: `hist-${index}`,
            style: { display: 'flex', gap: 8, padding: '3px 0', borderLeft: `2px solid ${T.border}`, paddingLeft: 8, marginLeft: 2 },
          },
            h('span', { style: { color: T.textFaint, fontSize: 10, width: 74, flexShrink: 0 } }, fwbClock(entry?.at)),
            h('span', { style: { flex: 1, minWidth: 0, fontSize: 11 } },
              `${entry?.from === null || entry?.from === undefined ? '·' : fwbBoardLaneLabel(entry.from)} → ${fwbBoardLaneLabel(entry?.to)}`,
              entry?.note !== null && entry?.note !== undefined && String(entry.note) !== '' ? ` · ${String(entry.note)}` : '',
              h('span', { style: { color: T.textFaint } }, ` (${String(entry?.by ?? '—')})`))))) ),

    task?.agent?.lastReport !== null && task?.agent?.lastReport !== undefined
      ? h(Card, { title: t('board.lastReport'), style: { padding: 8 } },
        h('div', { style: { whiteSpace: 'pre-wrap', fontSize: 11, lineHeight: 1.6 } }, String(task.agent.lastReport)))
      : null)

  const form = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12 } },
    h(Field, { label: t('board.title') },
      h(Input, { value: draft.title, onChange: (next) => setDraft((prev) => ({ ...prev, title: String(fwbReadValue(next) ?? '') })), style: { width: '100%' } })),
    h(Field, { label: t('board.detail') },
      h(TextArea, { value: draft.detail, rows: 4, onChange: (next) => setDraft((prev) => ({ ...prev, detail: String(fwbReadValue(next) ?? '') })), style: { width: '100%' } })),
    h(Field, { label: t('board.acceptance'), hint: t('board.oneLineEach') },
      h(TextArea, { value: draft.acceptance, rows: 4, onChange: (next) => setDraft((prev) => ({ ...prev, acceptance: String(fwbReadValue(next) ?? '') })), style: { width: '100%' } })),
    h(Field, { label: t('board.verify'), hint: t('board.oneLineEach') },
      h(TextArea, { value: draft.verify, rows: 3, mono: true, onChange: (next) => setDraft((prev) => ({ ...prev, verify: String(fwbReadValue(next) ?? '') })), style: { width: '100%' } })),
    h(Field, { label: t('board.files'), hint: t('board.oneLineEach') },
      h(TextArea, { value: draft.files, rows: 3, mono: true, onChange: (next) => setDraft((prev) => ({ ...prev, files: String(fwbReadValue(next) ?? '') })), style: { width: '100%' } })),
    h('div', { style: { display: 'flex', gap: 10 } },
      h(Field, { label: t('board.priority'), style: { flex: 1 } },
        h(Select, {
          value: draft.priority,
          onChange: (next) => setDraft((prev) => ({ ...prev, priority: String(fwbReadValue(next) ?? 'normal') })),
          options: FWB_BOARD_PRIORITIES.map((id) => ({ value: id, label: fwbBoardPriorityLabel(id) })),
          style: { width: '100%' },
        })),
      h(Field, { label: t('board.tags'), hint: t('board.tagsHint'), style: { flex: 2 } },
        h(Input, { value: draft.tags, onChange: (next) => setDraft((prev) => ({ ...prev, tags: String(fwbReadValue(next) ?? '') })), style: { width: '100%' } }))))

  const footer = editing === true
    ? h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
      h(Btn, { onClick: () => (isNew === true ? onClose() : setEditing(false)), disabled: busy }, t('board.close')),
      h(Btn, { onClick: save, kind: 'primary', disabled: busy }, busy === true ? h(Spinner, { size: 12 }) : (isNew === true ? t('board.create') : t('board.save'))))
    : h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' } },
      isNew === true ? null : h(Btn, { onClick: remove, kind: 'danger', disabled: busy }, t('board.delete')),
      task?.agent?.sessionId !== null && task?.agent?.sessionId !== undefined ? h(Btn, { onClick: onOpenSession }, t('board.openSession')) : null,
      isNew === true ? null : h(Btn, { onClick: dispatch, disabled: busy }, t('board.dispatch')),
      h(Btn, { onClick: () => setEditing(true), kind: 'primary' }, t('board.edit')),
      h(Btn, { onClick: onClose }, t('board.close')))

  return h(Modal, {
    title: isNew === true ? t('board.new') : String(task?.title ?? t('board.edit')),
    onClose,
    width: 720,
    footer,
  },
    editing === true ? form : view)
}

/* --------------------------------------------------------------- report -- */

function FwbBoardReportModal({ task, act, onClose, onChanged, push }) {
  const [form, setForm] = React.useState(() => ({
    status: 'done',
    summary: String(task?.agent?.lastReport ?? ''),
    commands: fwbBoardCommandsText(task?.result?.commandsRun),
    evidence: (Array.isArray(task?.result?.evidence) ? task.result.evidence : []).join('\n'),
    files: (Array.isArray(task?.result?.files) ? task.result.files : []).join('\n'),
    verdict: task?.result?.verdict ?? '',
    note: '',
  }))
  const [busy, setBusy] = React.useState(false)

  const submit = async () => {
    setBusy(true)
    const payload = {
      id: task.id,
      status: form.status,
      summary: form.summary,
      commandsRun: fwbBoardParseCommands(form.commands),
      evidence: fwbLines(form.evidence),
      files: fwbLines(form.files),
      verdict: form.verdict === '' ? null : form.verdict,
      note: form.note === '' ? null : form.note,
    }
    try {
      await fwbInvoke(act, 'reportTask', [payload], () => api('/board/report', { method: 'POST', body: payload }))
      push(t('board.reportOk'), 'ok')
      if (typeof onChanged === 'function') onChanged()
      onClose()
    } catch (error) {
      push(`${t('board.reportFailed')}: ${String(error?.message ?? error)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  return h(Modal, {
    title: t('board.reportTitle'),
    onClose,
    width: 640,
    footer: h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
      h(Btn, { onClick: onClose, disabled: busy }, t('board.close')),
      h(Btn, { onClick: submit, kind: 'primary', disabled: busy }, busy === true ? h(Spinner, { size: 12 }) : t('board.reportSave'))),
  },
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12 } },
      h('div', { style: { display: 'flex', gap: 10 } },
        h(Field, { label: t('board.status'), style: { flex: 1 } },
          h(Select, {
            value: form.status,
            onChange: (next) => setForm((prev) => ({ ...prev, status: String(fwbReadValue(next) ?? 'done') })),
            options: ['done', 'failed', 'blocked', 'working'].map((id) => ({ value: id, label: t(`board.reportStatus.${id}`) })),
            style: { width: '100%' },
          })),
        h(Field, { label: t('board.verdict'), style: { flex: 1 } },
          h(Select, {
            value: form.verdict,
            onChange: (next) => setForm((prev) => ({ ...prev, verdict: String(fwbReadValue(next) ?? '') })),
            options: [{ value: '', label: t('board.verdictNone') }, { value: 'pass', label: t('board.verdictPass') }, { value: 'fail', label: t('board.verdictFail') }],
            style: { width: '100%' },
          }))),
      h(Field, { label: t('board.summary') },
        h(TextArea, { value: form.summary, rows: 3, onChange: (next) => setForm((prev) => ({ ...prev, summary: String(fwbReadValue(next) ?? '') })), style: { width: '100%' } })),
      h(Field, { label: t('board.commands'), hint: t('board.commandsHint') },
        h(TextArea, { value: form.commands, rows: 3, mono: true, onChange: (next) => setForm((prev) => ({ ...prev, commands: String(fwbReadValue(next) ?? '') })), style: { width: '100%' } })),
      h(Field, { label: t('board.evidence'), hint: t('board.oneLineEach') },
        h(TextArea, { value: form.evidence, rows: 3, onChange: (next) => setForm((prev) => ({ ...prev, evidence: String(fwbReadValue(next) ?? '') })), style: { width: '100%' } })),
      h(Field, { label: t('board.files'), hint: t('board.oneLineEach') },
        h(TextArea, { value: form.files, rows: 2, mono: true, onChange: (next) => setForm((prev) => ({ ...prev, files: String(fwbReadValue(next) ?? '') })), style: { width: '100%' } })),
      h(Field, { label: t('board.note') },
        h(Input, { value: form.note, onChange: (next) => setForm((prev) => ({ ...prev, note: String(fwbReadValue(next) ?? '') })), style: { width: '100%' } }))))
}

/* ------------------------------------------------------------ decompose -- */

function FwbBoardDecomposeModal({ act, projects, activeProjectId, onClose, onCreated, push }) {
  const [prompt, setPrompt] = React.useState('')
  const [maxTasks, setMaxTasks] = React.useState('6')
  const [projectId, setProjectId] = React.useState(String(activeProjectId ?? ''))
  const [busy, setBusy] = React.useState(false)
  const [created, setCreated] = React.useState(null)
  const [failure, setFailure] = React.useState(null)

  const submit = async () => {
    const text = prompt.trim()
    if (text === '') {
      push(t('board.decomposeNeedPrompt'), 'warn')
      return
    }
    setBusy(true)
    setFailure(null)
    const payload = { prompt: text }
    if (projectId !== '') payload.projectId = projectId
    const max = Number(maxTasks)
    if (Number.isFinite(max) && max > 0) payload.maxTasks = Math.round(max)
    try {
      const response = await fwbInvoke(act, 'decompose', [payload], () => api('/board/decompose', { method: 'POST', body: payload }))
      const tasks = Array.isArray(response?.tasks) ? response.tasks : []
      setCreated(tasks)
      if (tasks.length === 0) {
        setFailure(t('board.decomposeEmpty'))
        push(t('board.decomposeEmpty'), 'warn')
      } else {
        push(t('board.decomposeCreated', { n: tasks.length }), 'ok')
        if (typeof onCreated === 'function') onCreated()
      }
    } catch (error) {
      setFailure(String(error?.message ?? error))
      push(`${t('board.decomposeFailed')}: ${String(error?.message ?? error)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  return h(Modal, {
    title: t('board.decomposeTitle'),
    onClose,
    width: 680,
    footer: h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
      h(Btn, { onClick: onClose, disabled: busy }, t('board.close')),
      created !== null && created.length > 0 ? h(Btn, { onClick: submit, disabled: busy }, t('board.decomposeAgain')) : null,
      h(Btn, { onClick: submit, kind: 'primary', disabled: busy }, busy === true ? t('board.decomposeRunning') : t('board.decomposeRun'))),
  },
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12 } },
      h('div', { style: { color: T.textDim } }, t('board.decomposeHint')),
      h(Field, { label: t('board.decomposePrompt') },
        h(TextArea, {
          value: prompt,
          rows: 5,
          placeholder: t('board.decomposePlaceholder'),
          onChange: (next) => setPrompt(String(fwbReadValue(next) ?? '')),
          style: { width: '100%' },
        })),
      h('div', { style: { display: 'flex', gap: 10 } },
        h(Field, { label: t('board.decomposeMax'), style: { flex: 1 } },
          h(Input, { value: maxTasks, type: 'number', onChange: (next) => setMaxTasks(String(fwbReadValue(next) ?? '')), style: { width: '100%' } })),
        h(Field, { label: t('board.filterProject'), style: { flex: 2 } },
          h(Select, {
            value: projectId,
            onChange: (next) => setProjectId(String(fwbReadValue(next) ?? '')),
            options: [{ value: '', label: t('board.allProjects') }, ...(Array.isArray(projects) ? projects : []).map((project) => ({ value: String(project?.id ?? ''), label: String(project?.name ?? project?.id ?? '') }))],
            style: { width: '100%' },
          }))),
      failure !== null ? h('div', { style: { color: T.error, fontSize: 12 } }, failure) : null,
      created !== null && created.length > 0
        ? h(Card, { title: `${t('board.decomposeResult')} · ${created.length}`, style: { padding: 8 } },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            created.map((task, index) => h('div', { key: String(task?.id ?? index), style: { display: 'flex', alignItems: 'center', gap: 6 } },
              h(Pill, { tone: 'ok', style: { fontSize: 10, color: T.ok } }, t('board.created')),
              h('span', { style: { flex: 1, minWidth: 0, fontWeight: 600 } }, String(task?.title ?? '')),
              h('span', { style: { color: T.textFaint, fontSize: 10 } }, fwbBoardLaneLabel(task?.lane ?? 'backlog'))))))
        : null))
}

/* ----------------------------------------------------------------- page -- */

function BoardPage({ state, actions }) {
  const act = fwbActions(state, actions)
  const { notice, push, clear } = useFwbNotify(state, actions)
  const live = useFwbBoard(2500)
  const tasks = live.tasks
  const laneList = live.laneList
  const settings = state?.settings ?? {}

  const [filters, setFilters] = React.useState({ projectId: '', tag: '', priority: '', text: '' })
  const [overrides, setOverrides] = React.useState(null)   // optimistic move
  const [dragId, setDragId] = React.useState(null)
  const dragIdRef = React.useRef(null)
  const [dropLane, setDropLane] = React.useState(null)
  const [menuFor, setMenuFor] = React.useState(null)
  const [editing, setEditing] = React.useState(null)
  const [reporting, setReporting] = React.useState(null)
  const [decomposing, setDecomposing] = React.useState(false)
  const [forceAsk, setForceAsk] = React.useState(null)
  const [busyIds, setBusyIds] = React.useState({})
  const [creating, setCreating] = React.useState(false)

  const setDrag = (id) => {
    dragIdRef.current = id
    setDragId(id)
  }

  const withBusy = async (id, run) => {
    setBusyIds((prev) => ({ ...prev, [id]: true }))
    try {
      return await run()
    } finally {
      setBusyIds((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    }
  }

  // ---- mutation plumbing ------------------------------------------------
  const refresh = live.refresh

  // ---- one-sentence board planning (AI creates cards in the background) ---
  const [planPrompt, setPlanPrompt] = React.useState('')
  const [planJob, setPlanJob] = React.useState(null)

  const startPlan = async () => {
    const sentence = String(planPrompt ?? '').trim()
    if (sentence === '') {
      push(t('board.planNeedPrompt'), 'warn')
      return
    }
    try {
      // The route answers with a job id immediately; the agent works behind it.
      const response = await api('/board/plan', {
        method: 'POST',
        body: {
          prompt: sentence,
          ...(filters.projectId === '' ? {} : { projectId: filters.projectId }),
          maxTasks: 6,
        },
      })
      setPlanPrompt('')
      setPlanJob({ id: String(response?.jobId ?? ''), status: 'running', cards: [] })
    } catch (error) {
      push(`${t('board.planFailed')}: ${String(error?.message ?? error)}`, 'error')
    }
  }

  React.useEffect(() => {
    const jobId = planJob?.id
    if (typeof jobId !== 'string' || jobId === '' || planJob?.status !== 'running') return undefined
    let cancelled = false
    const timer = setInterval(async () => {
      try {
        const response = await api('/job', { query: { id: jobId } })
        const job = response?.job
        if (cancelled || job === null || job === undefined) return
        if (job.status === 'done') {
          const cards = Array.isArray(job.result?.tasks) ? job.result.tasks : []
          setPlanJob({ id: jobId, status: 'done', cards })
          push(t('board.planCreated', { n: cards.length }), cards.length > 0 ? 'ok' : 'warn')
          await refresh()
        } else if (job.status === 'failed') {
          setPlanJob({ id: jobId, status: 'failed', cards: [] })
          push(`${t('board.planFailed')}: ${String(job.error?.message ?? '')}`, 'error')
        }
      } catch {
        /* a poll that fails must not stop the loop */
      }
    }, 1200)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [planJob, refresh, push])

  const performMove = async (task, lane, index, force) => {
    setOverrides({ id: task.id, lane, index })
    try {
      if (force === true) {
        // Only the force path may bypass the acceptance gate → raw route call.
        await api('/board/task', { method: 'POST', body: { action: 'move', id: task.id, lane, index, force: true } })
      } else {
        await fwbInvoke(act, 'moveTask', [{ id: task.id, lane, index }],
          () => api('/board/task', { method: 'POST', body: { action: 'move', id: task.id, lane, index } }))
      }
      setOverrides(null)
      await refresh()
    } catch (error) {
      // Roll back to the server truth and tell the user why.
      setOverrides(null)
      push(`${t('board.moveFailed')}: ${String(error?.message ?? error)}`, 'error')
    }
  }

  const requestMove = (task, lane, index) => {
    if (task === null || task === undefined) return
    if (lane === 'done' && task?.result?.verdict !== 'pass') {
      setForceAsk({ task, lane, index })
      return
    }
    performMove(task, lane, index, false)
  }

  const dropAt = (lane, index) => {
    const id = dragIdRef.current
    setDrag(null)
    setDropLane(null)
    if (id === null || id === undefined) return
    const task = tasks.find((item) => item?.id === id)
    if (task === undefined) return
    requestMove(task, lane, index)
  }

  const moveLane = (task) => async (laneId) => {
    setMenuFor(null)
    if (laneId === task?.lane) return
    if (laneId === 'done' && task?.result?.verdict !== 'pass') {
      setForceAsk({ task, lane: laneId, index: null })
      return
    }
    await performMove(task, laneId, null, false)
  }

  /** Ctrl/⌘ + ←/→ — the keyboard alternative to dragging. */
  const keyMove = (task) => (direction) => {
    const order = laneList.map((lane) => lane.id)
    const current = order.indexOf(task?.lane)
    const nextIndex = fwbClamp(current + direction, 0, order.length - 1)
    if (current < 0 || nextIndex === current) return
    requestMove(task, order[nextIndex], null)
  }

  const createCard = async (input) => {
    setCreating(true)
    try {
      await fwbInvoke(act, 'createTask', [input],
        () => api('/board/task', { method: 'POST', body: { action: 'create', ...input } }))
      push(t('board.created'), 'ok')
      await refresh()
      return true
    } catch (error) {
      push(`${t('board.createFailed')}: ${String(error?.message ?? error)}`, 'error')
      return false
    } finally {
      setCreating(false)
    }
  }

  const dispatchCard = (task) => async () => {
    await withBusy(task.id, async () => {
      const payload = { id: task.id }
      if (String(settings.defaultProvider ?? '') !== '') payload.provider = settings.defaultProvider
      if (String(settings.defaultModel ?? '') !== '') payload.model = settings.defaultModel
      try {
        const response = await fwbInvoke(act, 'dispatchTask', [payload], () => api('/board/dispatch', { method: 'POST', body: payload }))
        const sessionId = response?.sessionId ?? response?.task?.agent?.sessionId ?? '—'
        push(t('board.dispatchOk', { id: String(sessionId) }), 'ok')
        await refresh()
      } catch (error) {
        push(`${t('board.dispatchFailed')}: ${String(error?.message ?? error)}`, 'error')
      }
    })
  }

  const cancelCard = (task) => async () => {
    await withBusy(task.id, async () => {
      try {
        await fwbInvoke(act, 'cancelTask', [{ id: task.id }],
          () => api('/board/cancel', { method: 'POST', body: { id: task.id } }))
        push(t('board.cancelOk'), 'ok')
        await refresh()
      } catch (error) {
        push(`${t('board.cancelFailed')}: ${String(error?.message ?? error)}`, 'error')
      }
    })
  }

  const openSession = (task) => async () => {
    const sessionId = task?.agent?.sessionId
    if (sessionId === null || sessionId === undefined || sessionId === '') return
    const fn = act.openSession
    if (typeof fn === 'function') {
      try {
        await fn(String(sessionId), task.id)
        return
      } catch (error) {
        push(String(error?.message ?? error), 'error')
        return
      }
    }
    const ok = await fwbCopy(String(sessionId))
    push(ok ? t('board.sessionCopied') : t('board.copyFailed'), ok ? 'info' : 'error')
  }

  const archiveDone = async () => {
    try {
      await fwbInvoke(act, 'archiveDone', [], () => api('/board/task', { method: 'POST', body: { action: 'archive' } }))
      push(t('board.archived'), 'ok')
      await refresh()
    } catch (error) {
      push(`${t('board.archiveFailed')}: ${String(error?.message ?? error)}`, 'error')
    }
  }

  // ---- derived data -----------------------------------------------------
  const filtered = React.useMemo(() => tasks.filter((task) => fwbBoardMatches(task, filters)), [tasks, filters])
  const buckets = React.useMemo(() => fwbBoardBuckets(laneList, filtered, overrides), [laneList, filtered, overrides])
  const reviewTasks = React.useMemo(
    () => tasks.filter((task) => task?.lane === 'review' || task?.lane === 'verify'),
    [tasks],
  )

  const projectOptions = React.useMemo(() => {
    const seen = new Map()
    for (const project of Array.isArray(state?.projects) ? state.projects : []) seen.set(String(project?.id ?? ''), String(project?.name ?? project?.id ?? ''))
    for (const task of tasks) {
      const id = String(task?.projectId ?? '')
      if (id !== '' && seen.has(id) === false) seen.set(id, id)
    }
    return [...seen.entries()].map(([value, label]) => ({ value, label }))
  }, [state?.projects, tasks])

  const tagOptions = React.useMemo(() => {
    const tags = new Set()
    for (const task of tasks) for (const tag of Array.isArray(task?.tags) ? task.tags : []) tags.add(String(tag))
    return [...tags].sort()
  }, [tasks])

  const header = h('div', {
    style: {
      display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: '8px 10px',
      borderBottom: `1px solid ${T.border}`, flexShrink: 0,
    },
  },
    h('div', { style: { fontWeight: 600, marginRight: 4 } }, t('board.title')),
    h(Select, {
      value: filters.projectId,
      onChange: (next) => setFilters((prev) => ({ ...prev, projectId: String(fwbReadValue(next) ?? '') })),
      options: [{ value: '', label: t('board.allProjects') }, ...projectOptions],
      style: { minWidth: 132 },
    }),
    h(Select, {
      value: filters.priority,
      onChange: (next) => setFilters((prev) => ({ ...prev, priority: String(fwbReadValue(next) ?? '') })),
      options: [{ value: '', label: t('board.allPriorities') }, ...FWB_BOARD_PRIORITIES.map((id) => ({ value: id, label: fwbBoardPriorityLabel(id) }))],
      style: { minWidth: 120 },
    }),
    tagOptions.length > 0
      ? h(Select, {
        value: filters.tag,
        onChange: (next) => setFilters((prev) => ({ ...prev, tag: String(fwbReadValue(next) ?? '') })),
        options: [{ value: '', label: t('board.allTags') }, ...tagOptions.map((tag) => ({ value: tag, label: tag }))],
        style: { minWidth: 110 },
      })
      : null,
    h('div', { style: { flex: 1, minWidth: 140 } },
      h(Input, {
        value: filters.text,
        onChange: (next) => setFilters((prev) => ({ ...prev, text: String(fwbReadValue(next) ?? '') })),
        placeholder: t('board.search'),
        style: { width: '100%' },
      })),
    h(Btn, { onClick: () => setDecomposing(true), kind: 'primary' }, t('board.decompose')),
    h(Btn, { onClick: () => setEditing({ task: null }) }, t('board.new')),
    h(Btn, { onClick: () => refresh() }, t('common.refresh')),
    h(Btn, { onClick: archiveDone, kind: 'danger' }, t('board.archiveDone')))

  const strip = h('div', {
    style: {
      display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: '5px 10px',
      borderBottom: `1px solid ${T.border}`, background: reviewTasks.length > 0 ? T.bgRaised : 'transparent',
      fontSize: 11, flexShrink: 0,
    },
  },
    h(Pill, { tone: reviewTasks.length > 0 ? 'warn' : 'neutral', style: { color: reviewTasks.length > 0 ? T.warn : T.textDim } },
      `${t('board.myReview')} · ${reviewTasks.length}`),
    reviewTasks.length === 0
      ? h('span', { style: { color: T.textFaint } }, t('board.myReviewEmpty'))
      : reviewTasks.slice(0, 4).map((task) => h(Chip, {
        key: task.id,
        onClick: () => setEditing({ task }),
        title: t('board.openHint'),
      }, String(task?.title ?? ''))),
    reviewTasks.length > 4 ? h('span', { style: { color: T.textFaint } }, `+${reviewTasks.length - 4}`) : null,
    h('div', { style: { flex: 1 } }),
    h('span', { style: { color: T.textFaint } }, t('board.keyHint')))

  const board = h('div', {
    style: { flex: 1, minHeight: 0, display: 'flex', gap: 8, padding: 8, overflowX: 'auto', alignItems: 'stretch' },
  },
    buckets.map((bucket) => {
      const items = bucket.items
      const laneId = bucket.id
      return h('div', {
        key: laneId,
        onDragOver: (event) => {
          event.preventDefault()
          if (dropLane !== laneId) setDropLane(laneId)
        },
        onDragLeave: () => setDropLane((current) => (current === laneId ? null : current)),
        onDrop: (event) => {
          event.preventDefault()
          dropAt(laneId, items.length)
        },
        style: {
          width: 246, flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: 0,
          border: `1px solid ${dropLane === laneId ? T.brand : T.border}`, borderRadius: T.radius,
          background: dropLane === laneId ? T.bgInput : 'transparent', transition: 'background 120ms linear',
        },
      },
        h('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px',
            borderBottom: `1px solid ${T.border}`, flexShrink: 0,
          },
        },
          h(Pill, { tone: fwbBoardLaneTone(laneId), style: { fontSize: 11 } }, fwbBoardLaneLabel(laneId)),
          h('span', {
            title: t('board.cardsCount', { n: items.length }),
            style: {
              fontSize: 10, minWidth: 18, textAlign: 'center', padding: '1px 5px', borderRadius: 99,
              border: `1px solid ${T.border}`, color: T.textDim, fontVariantNumeric: 'tabular-nums',
            },
          }, String(items.length)),
          h('div', { style: { flex: 1 } }),
          laneId === 'backlog' ? h(IconBtn, { onClick: () => setEditing({ task: null }), title: t('board.new'), size: 22 }, '+') : null),

        laneId === 'backlog'
          ? h(FwbBoardQuickAdd, { onCreate: (title) => createCard({ title, lane: 'backlog', priority: 'normal' }), busy: creating })
          : null,

        h('div', {
          style: { flex: 1, minHeight: 60, overflowY: 'auto', overflowX: 'hidden', paddingBottom: 4, display: 'flex', flexDirection: 'column' },
        },
          items.length === 0
            ? h('div', { style: { color: T.textFaint, fontSize: 11, padding: '14px 10px', textAlign: 'center' } }, dropLane === laneId ? t('board.dropHint') : t('board.empty'))
            : items.map((task, index) => h(FwbBoardCard, {
              key: String(task?.id ?? index),
              task,
              index,
              menuOpen: menuFor === task?.id,
              menuLanes: laneList,
              dragging: dragId === task?.id,
              dropTarget: false,
              busy: busyIds[task?.id] === true,
              onOpen: () => setEditing({ task }),
              onDragStart: () => setDrag(task?.id ?? null),
              onDragEnd: () => {
                setDrag(null)
                setDropLane(null)
              },
              onDragOverCard: () => setDropLane(laneId),
              onDropAt: (at) => dropAt(laneId, at),
              onMenu: () => setMenuFor((current) => (current === task?.id ? null : task?.id)),
              onMoveLane: moveLane(task),
              onKeyMove: keyMove(task),
              onDispatch: dispatchCard(task),
              onReport: () => setReporting({ task }),
              onCancelAgent: cancelCard(task),
              onOpenSession: openSession(task),
            }))))
    }))

  const planBar = h('div', {
    style: {
      display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '6px 10px',
      borderBottom: `1px solid ${T.border}`, flexShrink: 0,
    },
  },
    h('span', { style: { color: T.brand, fontSize: 13 }, title: t('board.planHint') }, '✨'),
    h('div', { style: { flex: 1, minWidth: 220 } },
      h(Input, {
        value: planPrompt,
        onChange: (next) => setPlanPrompt(String(fwbReadValue(next) ?? '')),
        onKeyDown: (event) => {
          if (event?.key === 'Enter') {
            event.preventDefault()
            startPlan()
          }
        },
        placeholder: t('board.planPlaceholder'),
        style: { width: '100%' },
      })),
    h(Btn, { kind: 'primary', onClick: startPlan, disabled: planJob?.status === 'running' },
      planJob?.status === 'running' ? t('board.planRunning') : t('board.planSubmit')),
    planJob?.status === 'done'
      ? h(Pill, { tone: (planJob.cards ?? []).length > 0 ? 'ok' : 'warn' }, t('board.planCreated', { n: (planJob.cards ?? []).length }))
      : null,
    planJob?.status === 'failed' ? h(Pill, { tone: 'error' }, t('board.planFailed')) : null,
    h('span', { style: { color: T.textFaint, fontSize: 11 } }, t('board.planHint')))

  return h(FwbPage, { notice, onDismiss: clear },
    header,
    planBar,
    strip,
    live.error !== null
      ? h('div', { style: { padding: '6px 10px', color: T.error, fontSize: 12, borderBottom: `1px solid ${T.border}` } },
        `${t('board.loadFailed')}: ${String(live.error?.message ?? live.error)}`)
      : null,
    board,

    editing !== null
      ? h(FwbBoardCardModal, {
        task: editing.task ?? { id: null, title: '', lane: 'backlog', priority: 'normal', acceptance: [], verify: [], files: [], tags: [], history: [], result: null, agent: null },
        act,
        provider: String(settings.defaultProvider ?? ''),
        model: String(settings.defaultModel ?? ''),
        onClose: () => setEditing(null),
        onChanged: () => refresh(),
        push,
        onOpenSession: openSession(editing.task ?? {}),
      })
      : null,

    reporting !== null
      ? h(FwbBoardReportModal, {
        task: reporting.task,
        act,
        onClose: () => setReporting(null),
        onChanged: () => refresh(),
        push,
      })
      : null,

    decomposing === true
      ? h(FwbBoardDecomposeModal, {
        act,
        projects: state?.projects,
        activeProjectId: state?.activeProjectId,
        onClose: () => setDecomposing(false),
        onCreated: () => refresh(),
        push,
      })
      : null,

    forceAsk !== null
      ? h(Modal, {
        title: t('board.forceTitle'),
        onClose: () => setForceAsk(null),
        width: 480,
        footer: h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
          h(Btn, { onClick: () => setForceAsk(null) }, t('board.cancelMove')),
          h(Btn, {
            onClick: () => {
              const ask = forceAsk
              setForceAsk(null)
              performMove(ask.task, ask.lane, ask.index, true)
            },
            kind: 'primary',
          }, t('board.forceConfirm'))),
      },
        h('div', { style: { fontSize: 12, lineHeight: 1.7, color: T.textDim } },
          h('div', { style: { marginBottom: 6 } }, t('board.forceBody')),
          h('div', { style: { fontWeight: 600, color: T.text } }, String(forceAsk.task?.title ?? ''))))
      : null)
}

/* ------------------------------------------------------------- locale -- */

fwbExtendLocale({
  'board.title': '看板',
  'board.new': '新建卡片',
  'board.decompose': 'AI 拆解',
  'board.decomposeTitle': 'AI 拆解需求',
  'board.decomposeHint': '写清楚要做什么，AI 会把它拆成若干张卡片放进「待办」。',
  'board.decomposePrompt': '需求描述',
  'board.decomposePlaceholder': '例如：给设置页加上 MCP 令牌轮换、连接提示和一键复制配置',
  'board.decomposeMax': '最多卡片数',
  'board.decomposeRun': '开始拆解',
  'board.decomposeAgain': '重新拆解',
  'board.decomposeRunning': '拆解中…',
  'board.decomposeEmpty': 'AI 没有返回可用的卡片',
  'board.decomposeCreated': '已创建 {n} 张卡片',
  'board.decomposeResult': '新建的卡片',
  'board.decomposeFailed': '拆解失败',
  'board.decomposeNeedPrompt': '请先写需求描述',
  'board.refresh': '刷新',
  'board.archiveDone': '归档已完成',
  'board.archived': '已归档完成的卡片',
  'board.archiveFailed': '归档失败',
  'board.allProjects': '全部项目',
  'board.allPriorities': '全部优先级',
  'board.allTags': '全部标签',
  'board.search': '搜索标题 / 详情 / 标签',
  'board.filterProject': '项目',
  'board.filterPriority': '优先级',
  'board.filterTag': '标签',
  'board.lane.backlog': '待办',
  'board.lane.ready': '就绪',
  'board.lane.running': '执行中',
  'board.lane.review': '待验收',
  'board.lane.verify': '验证中',
  'board.lane.done': '完成',
  'board.priority.low': '低',
  'board.priority.normal': '普通',
  'board.priority.high': '高',
  'board.priority.urgent': '紧急',
  'board.empty': '这一列还是空的',
  'board.dropHint': '松手放到这里',
  'board.quickAdd': '快速添加一张卡片…',
  'board.quickAddHint': '回车创建到「待办」',
  'board.add': '添加',
  'board.acceptanceCount': '验收 {n} 项',
  'board.verifyCount': '验证 {n} 条',
  'board.filesCount': '文件 {n}',
  'board.myReview': '我的待验收',
  'board.myReviewEmpty': '没有等待你验收的卡片',
  'board.agentWorking': 'AI 执行中',
  'board.agentQueued': '排队中',
  'board.agentBlocked': '受阻',
  'board.agentDone': '已完成',
  'board.agentFailed': '失败',
  'board.agent': 'AI 执行',
  'board.agentIdle': '未派发',
  'board.awaitingAcceptance': '待验收',
  'board.blocked': '受阻',
  'board.verdictPass': '通过',
  'board.verdictFail': '未通过',
  'board.verdictNone': '未判定',
  'board.verdict': '结论',
  'board.dispatch': '派给 AI',
  'board.dispatching': '派发中…',
  'board.dispatchHint': '创建一个 DSH 会话执行这张卡片',
  'board.dispatchOk': '已派发给 AI（会话 {id}）',
  'board.dispatchFailed': '派发失败',
  'board.report': '报告结果',
  'board.reportHint': '记录执行摘要、命令与结论',
  'board.reportTitle': '报告执行结果',
  'board.reportSave': '保存结果',
  'board.reportOk': '结果已记录',
  'board.reportFailed': '报告失败',
  'board.reportStatus.done': '完成',
  'board.reportStatus.failed': '失败',
  'board.reportStatus.blocked': '受阻',
  'board.reportStatus.working': '进行中',
  'board.cancel': '取消执行',
  'board.cancelOk': '已取消 AI 执行',
  'board.cancelFailed': '取消失败',
  'board.cancelMove': '先不退',
  'board.openSession': '打开会话',
  'board.sessionCopied': '会话 ID 已复制，请在 DSH 会话列表里打开',
  'board.copyFailed': '复制失败',
  'board.edit': '编辑',
  'board.openHint': '打开卡片详情',
  'board.moveTo': '移动到',
  'board.moveToLane': '移到 {lane}',
  'board.delete': '删除',
  'board.deleted': '卡片已删除',
  'board.deleteFailed': '删除失败',
  'board.title': '标题',
  'board.detail': '详情',
  'board.summary': '执行摘要',
  'board.acceptance': '验收标准（一行一条）',
  'board.acceptanceTitle': '验收清单',
  'board.verify': '验证命令（一行一条）',
  'board.verifyTitle': '验证命令',
  'board.files': '涉及文件（一行一条）',
  'board.filesTitle': '涉及文件',
  'board.tags': '标签（逗号分隔）',
  'board.tagsHint': '逗号分隔，例如 ui, api',
  'board.priority': '优先级',
  'board.oneLineEach': '一行一条',
  'board.save': '保存',
  'board.create': '创建卡片',
  'board.cardsCount': '{n} 张卡片',
  'board.titleRequired': '标题不能为空',
  'board.saved': '已保存',
  'board.created': '已创建',
  'board.createFailed': '创建失败',
  'board.saveFailed': '保存失败',
  'board.moveFailed': '移动失败',
  'board.loadFailed': '看板加载失败',
  'board.noDetail': '还没有填写详情',
  'board.noAcceptance': '还没有验收标准',
  'board.noVerify': '没有验证命令',
  'board.noVerifyShort': '未写验证命令',
  'board.commands': '运行的命令',
  'board.commandsHint': '每行：命令 | passed/failed | 退出码',
  'board.evidence': '证据',
  'board.result': '执行结果',
  'board.resultEmpty': '还没有执行结果',
  'board.lastReport': '最近一次回报',
  'board.history': '历史',
  'board.historyEmpty': '暂无历史',
  'board.status': '状态',
  'board.note': '备注',
  'board.openFile': '打开',
  'board.close': '关闭',
  'board.confirm': '确定',
  'board.forceTitle': '强制移入「完成」？',
  'board.forceBody': '这张卡片还没有通过验收（result.verdict 不是 pass）。强制完成会跳过验收门槛，并记录到历史里。',
  'board.forceConfirm': '强制完成',
  'board.keyHint': 'Ctrl/⌘ + ←/→ 切换列，拖拽可跨列移动',
  'board.laneMenu': '移动到其它列',
}, {
  'board.title': 'Board',
  'board.new': 'New card',
  'board.decompose': 'AI breakdown',
  'board.decomposeTitle': 'Break a requirement down with AI',
  'board.decomposeHint': 'Describe the work; the AI splits it into cards in your backlog.',
  'board.decomposePrompt': 'Requirement',
  'board.decomposePlaceholder': 'e.g. add MCP token rotation, a connect hint and copy-config to the settings page',
  'board.decomposeMax': 'Max cards',
  'board.decomposeRun': 'Break it down',
  'board.decomposeAgain': 'Run again',
  'board.decomposeRunning': 'Breaking down…',
  'board.decomposeEmpty': 'The AI returned no usable cards',
  'board.decomposeCreated': 'Created {n} cards',
  'board.decomposeResult': 'New cards',
  'board.decomposeFailed': 'Breakdown failed',
  'board.decomposeNeedPrompt': 'Write the requirement first',
  'board.refresh': 'Refresh',
  'board.archiveDone': 'Archive done',
  'board.archived': 'Archived the done cards',
  'board.archiveFailed': 'Archive failed',
  'board.allProjects': 'All projects',
  'board.allPriorities': 'All priorities',
  'board.allTags': 'All tags',
  'board.search': 'Search title / detail / tags',
  'board.filterProject': 'Project',
  'board.filterPriority': 'Priority',
  'board.filterTag': 'Tag',
  'board.lane.backlog': 'Backlog',
  'board.lane.ready': 'Ready',
  'board.lane.running': 'Running',
  'board.lane.review': 'Review',
  'board.lane.verify': 'Verify',
  'board.lane.done': 'Done',
  'board.priority.low': 'Low',
  'board.priority.normal': 'Normal',
  'board.priority.high': 'High',
  'board.priority.urgent': 'Urgent',
  'board.empty': 'This lane is empty',
  'board.dropHint': 'Drop here',
  'board.quickAdd': 'Quick add a card…',
  'board.quickAddHint': 'Enter creates it in the backlog',
  'board.add': 'Add',
  'board.acceptanceCount': '{n} acceptance',
  'board.verifyCount': '{n} checks',
  'board.filesCount': '{n} files',
  'board.myReview': 'Awaiting my review',
  'board.myReviewEmpty': 'Nothing is waiting for your review',
  'board.agentWorking': 'AI working',
  'board.agentQueued': 'Queued',
  'board.agentBlocked': 'Blocked',
  'board.agentDone': 'Done',
  'board.agentFailed': 'Failed',
  'board.agent': 'AI',
  'board.agentIdle': 'not dispatched',
  'board.awaitingAcceptance': 'Needs review',
  'board.blocked': 'Blocked',
  'board.verdictPass': 'Pass',
  'board.verdictFail': 'Fail',
  'board.verdictNone': 'Not judged',
  'board.verdict': 'Verdict',
  'board.dispatch': 'Dispatch to AI',
  'board.dispatching': 'Dispatching…',
  'board.dispatchHint': 'Start a DSH session that executes this card',
  'board.dispatchOk': 'Dispatched to AI (session {id})',
  'board.dispatchFailed': 'Dispatch failed',
  'board.report': 'Report result',
  'board.reportHint': 'Record the summary, commands and verdict',
  'board.reportTitle': 'Report the execution result',
  'board.reportSave': 'Save result',
  'board.reportOk': 'Result recorded',
  'board.reportFailed': 'Report failed',
  'board.reportStatus.done': 'Done',
  'board.reportStatus.failed': 'Failed',
  'board.reportStatus.blocked': 'Blocked',
  'board.reportStatus.working': 'In progress',
  'board.cancel': 'Cancel run',
  'board.cancelOk': 'Cancelled the AI run',
  'board.cancelFailed': 'Cancel failed',
  'board.cancelMove': 'Not now',
  'board.openSession': 'Open session',
  'board.sessionCopied': 'Session id copied — open it from the DSH session list',
  'board.copyFailed': 'Copy failed',
  'board.edit': 'Edit',
  'board.openHint': 'Open the card',
  'board.moveTo': 'Move to',
  'board.moveToLane': 'Move to {lane}',
  'board.delete': 'Delete',
  'board.deleted': 'Card deleted',
  'board.deleteFailed': 'Delete failed',
  'board.title': 'Title',
  'board.detail': 'Detail',
  'board.summary': 'Summary',
  'board.acceptance': 'Acceptance (one per line)',
  'board.acceptanceTitle': 'Acceptance checklist',
  'board.verify': 'Verify commands (one per line)',
  'board.verifyTitle': 'Verify commands',
  'board.files': 'Files (one per line)',
  'board.filesTitle': 'Files',
  'board.tags': 'Tags (comma separated)',
  'board.tagsHint': 'comma separated, e.g. ui, api',
  'board.priority': 'Priority',
  'board.oneLineEach': 'one per line',
  'board.save': 'Save',
  'board.create': 'Create card',
  'board.cardsCount': '{n} cards',
  'board.titleRequired': 'The title cannot be empty',
  'board.saved': 'Saved',
  'board.created': 'Created',
  'board.createFailed': 'Create failed',
  'board.saveFailed': 'Save failed',
  'board.moveFailed': 'Move failed',
  'board.loadFailed': 'Could not load the board',
  'board.noDetail': 'No detail yet',
  'board.noAcceptance': 'No acceptance criteria yet',
  'board.noVerify': 'No verify commands',
  'board.noVerifyShort': 'no verify command',
  'board.commands': 'Commands run',
  'board.commandsHint': 'per line: command | passed/failed | exit code',
  'board.evidence': 'Evidence',
  'board.result': 'Result',
  'board.resultEmpty': 'No result yet',
  'board.lastReport': 'Last report',
  'board.history': 'History',
  'board.historyEmpty': 'No history yet',
  'board.status': 'Status',
  'board.note': 'Note',
  'board.openFile': 'Open',
  'board.close': 'Close',
  'board.confirm': 'OK',
  'board.forceTitle': 'Force this card into Done?',
  'board.forceBody': 'This card has not passed acceptance (result.verdict is not pass). Forcing completion skips the gate and is recorded in the history.',
  'board.forceConfirm': 'Force done',
  'board.keyHint': 'Ctrl/⌘ + ←/→ switches lane, drag to move across lanes',
  'board.laneMenu': 'Move to another lane',
})