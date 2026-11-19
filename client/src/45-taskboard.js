/* ====================================================================== *
 * 45-taskboard.js — owner: dev-board (ported by Lead)
 * TaskboardPage: the agent-first task board that replaced the separate
 * dsh-taskboard plugin. Five lanes, drag & drop, DoD checklist, comments,
 * execution report, worktree isolation and cron/one-shot scheduling.
 * ====================================================================== */

const TB_LANES = [
  { id: 'backlog', labelKey: 'tb.lane.backlog', tone: 'neutral' },
  { id: 'todo', labelKey: 'tb.lane.todo', tone: 'brand' },
  { id: 'in_progress', labelKey: 'tb.lane.inProgress', tone: 'warn' },
  { id: 'in_review', labelKey: 'tb.lane.inReview', tone: 'warn' },
  { id: 'done', labelKey: 'tb.lane.done', tone: 'ok' },
]

const TB_URGENCIES = [
  { id: 'urgent', labelKey: 'tb.urgency.urgent', color: 'error' },
  { id: 'normal', labelKey: 'tb.urgency.normal', color: 'brand' },
  { id: 'relaxed', labelKey: 'tb.urgency.relaxed', color: 'neutral' },
]

function tbUrgency(id) {
  return TB_URGENCIES.find((item) => item.id === id) ?? TB_URGENCIES[1]
}

function tbStyleButton(disabled) {
  return { cursor: disabled === true ? 'not-allowed' : 'pointer' }
}

/** One request to the board API; every call carries the version it is based on. */
async function tbCall(body) {
  const response = await api('/taskboard/task', { method: 'POST', body })
  return response ?? {}
}

/* ------------------------------------------------------------------ card */

function TbCard({ task, busy, onOpen, onDragStart, onDragEnd, dragged }) {
  const urgency = tbUrgency(task.urgency)
  const done = Number(task.checklistDone ?? 0)
  const total = Number(task.checklistTotal ?? 0)
  return h('div', {
    draggable: busy !== true,
    onDragStart: (event) => {
      event?.dataTransfer?.setData('text/plain', task.id)
      onDragStart(task.id)
    },
    onDragEnd: () => onDragEnd(),
    onClick: () => onOpen(task),
    style: {
      border: `1px solid ${dragged === true ? T.brand : T.border}`,
      borderLeft: `3px solid ${urgency.color === 'error' ? T.error : urgency.color === 'warn' ? T.warn : T.brand}`,
      borderRadius: T.radiusSm, background: T.bgRaised, padding: '6px 8px', marginBottom: 6,
      cursor: busy === true ? 'progress' : 'grab', opacity: busy === true ? 0.6 : 1,
      display: 'flex', flexDirection: 'column', gap: 4,
    },
  },
    h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 6 } },
      h('div', { style: { flex: 1, minWidth: 0, fontSize: 12, lineHeight: 1.35 } }, String(task.title ?? '')),
      busy === true ? h(Spinner, { size: 10 }) : null),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' } },
      h(Pill, { tone: urgency.color, style: { fontSize: 10 } }, t(urgency.labelKey)),
      total > 0 ? h(Pill, { tone: done === total ? 'ok' : 'neutral', style: { fontSize: 10 } }, `${done}/${total}`) : null,
      task.blocked === true ? h(Pill, { tone: 'error', style: { fontSize: 10 } }, t('tb.blocked')) : null,
      task.claimedBy === null || task.claimedBy === undefined ? null : h(Pill, { tone: 'warn', style: { fontSize: 10 } }, t('tb.claimed')),
      h('div', { style: { flex: 1 } }),
      h('span', { style: { color: T.textFaint, fontSize: 10, fontFamily: T.mono } }, `v${task.version}`)))
}

/* ---------------------------------------------------------------- modal */

function TbTaskModal({ task, settings, onClose, onChanged, push }) {
  const isNew = task === null || task === undefined || task.id === null || task.id === undefined
  const [form, setForm] = React.useState({
    title: String(task?.title ?? ''),
    description: String(task?.description ?? ''),
    prompt: String(task?.prompt ?? ''),
    urgency: String(task?.urgency ?? 'normal'),
    isolation: String(task?.isolation ?? settings.taskIsolation ?? 'none'),
    cron: String(task?.execution?.cron ?? ''),
    runAt: String(task?.execution?.runAt ?? ''),
    mode: String(task?.execution?.mode ?? 'claim'),
    provider: String(task?.model?.provider ?? ''),
    model: String(task?.model?.model ?? ''),
    checklistNew: '',
    comment: '',
    merge: true,
  })
  const [busy, setBusy] = React.useState(false)
  const [detail, setDetail] = React.useState(task ?? null)
  const [live, setLive] = React.useState(null)
  const set = (key) => (event) => setForm((prev) => ({ ...prev, [key]: String(fwbReadValue(event) ?? '') }))
  const version = Number(detail?.version ?? task?.version ?? 1)

  const refresh = async () => {
    if (isNew) return
    try {
      const response = await api('/taskboard/task', { query: { id: task.id } })
      setDetail(response?.task ?? null)
    } catch (error) {
      push(`${t('tb.loadFailed')}: ${String(error?.message ?? error)}`, 'error')
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  React.useEffect(() => { void refresh() }, [])

  const guard = async (run) => {
    setBusy(true)
    try {
      await run()
      await refresh()
      await onChanged()
    } catch (error) {
      push(String(error?.message ?? error), 'error')
    } finally {
      setBusy(false)
    }
  }

  const save = () => guard(async () => {
    const execution = form.mode === 'scheduled'
      ? { mode: 'scheduled', ...(form.cron === '' ? {} : { cron: form.cron }), ...(form.runAt === '' ? {} : { runAt: form.runAt }) }
      : { mode: 'claim' }
    const model = form.provider === '' && form.model === '' ? null : { provider: form.provider, model: form.model }
    if (isNew) {
      const created = await tbCall({
        action: 'create',
        title: form.title,
        description: form.description,
        prompt: form.prompt,
        urgency: form.urgency,
        isolation: form.isolation,
        execution,
        model,
        checklist: form.checklistNew.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== ''),
      })
      push(t('tb.created', { id: created?.task?.id ?? '' }), 'ok')
      onClose()
      return
    }
    await tbCall({
      action: 'update',
      id: detail.id,
      ifVersion: version,
      patch: {
        title: form.title, description: form.description, prompt: form.prompt,
        urgency: form.urgency, isolation: form.isolation, execution, model,
      },
    })
    push(t('tb.saved'), 'ok')
  })

  const act = (action, extra = {}) => guard(() => tbCall({ action, id: detail?.id ?? task?.id, ifVersion: version, ...extra }))

  const toggleItem = (item) => guard(() => tbCall({
    action: 'checklist',
    id: detail.id,
    ifVersion: version,
    checkAction: item.checked === true ? 'uncheck' : 'check',
    itemId: item.id,
    ...(item.checked === true ? {} : { note: String(live?.note ?? '') }),
  }))

  const addComments = () => guard(async () => {
    await tbCall({ action: 'comment', id: detail.id, body: form.comment })
    setForm((prev) => ({ ...prev, comment: '' }))
  })

  const run = () => act('execute', { isolation: form.isolation })
  const accept = () => act('accept', { merge: form.merge === true })
  const remove = () => guard(async () => {
    await tbCall({ action: 'delete', id: detail.id })
    onClose()
  })

  const showWorktree = () => guard(async () => {
    const response = await tbCall({ action: 'worktree', id: detail.id })
    setLive({ worktree: response })
  })

  const checklist = detail?.checklist ?? []
  const comments = detail?.comments ?? []
  const lastRun = (detail?.executions ?? []).slice(-1)[0] ?? null
  const report = lastRun?.report ?? null

  const formView = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12 } },
    h(Field, { label: t('tb.field.title') }, h(Input, { value: form.title, onChange: set('title'), style: { width: '100%' } })),
    h(Field, { label: t('tb.field.description') }, h(TextArea, { value: form.description, onChange: set('description'), rows: 3, style: { width: '100%' } })),
    h(Field, { label: t('tb.field.prompt') }, h(TextArea, { value: form.prompt, onChange: set('prompt'), rows: 2, style: { width: '100%' } })),
    h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
      h(Field, { label: t('tb.field.urgency'), style: { minWidth: 140 } },
        h(Select, { value: form.urgency, onChange: set('urgency'), options: TB_URGENCIES.map((item) => ({ value: item.id, label: t(item.labelKey) })) })),
      h(Field, { label: t('tb.field.isolation'), style: { minWidth: 160 } },
        h(Select, { value: form.isolation, onChange: set('isolation'), options: [
          { value: 'none', label: t('tb.isolation.none') },
          { value: 'worktree', label: t('tb.isolation.worktree') },
        ] }))),
    h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
      h(Field, { label: t('tb.field.execution'), style: { minWidth: 160 } },
        h(Select, { value: form.mode, onChange: set('mode'), options: [
          { value: 'claim', label: t('tb.execution.claim') },
          { value: 'scheduled', label: t('tb.execution.scheduled') },
        ] })),
      form.mode === 'scheduled'
        ? h(Field, { label: t('tb.field.cron'), style: { minWidth: 160 } }, h(Input, { value: form.cron, onChange: set('cron'), placeholder: '0 6 * * *' }))
        : null,
      form.mode === 'scheduled'
        ? h(Field, { label: t('tb.field.runAt'), style: { minWidth: 200 } }, h(Input, { value: form.runAt, onChange: set('runAt'), placeholder: '2026-11-20T09:00' }))
        : null),
    h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
      h(Field, { label: t('tb.field.provider'), style: { minWidth: 140 } }, h(Input, { value: form.provider, onChange: set('provider') })),
      h(Field, { label: t('tb.field.model'), style: { minWidth: 160 } }, h(Input, { value: form.model, onChange: set('model') }))),
    isNew
      ? h(Field, { label: t('tb.field.checklist'), }, h(TextArea, { value: form.checklistNew, onChange: set('checklistNew'), rows: 3, placeholder: t('tb.checklistPlaceholder'), style: { width: '100%' } }))
      : null)

  const detailView = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12 } },
    h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
      h(Pill, { tone: tbUrgency(detail?.urgency).color }, t(tbUrgency(detail?.urgency).labelKey)),
      h(Pill, { tone: 'neutral' }, `${t('tb.version')} v${version}`),
      detail?.claimedBy === null || detail?.claimedBy === undefined ? null : h(Pill, { tone: 'warn' }, `${t('tb.claimed')}: ${detail.claimedBy}`),
      h('div', { style: { flex: 1 } }),
      h('span', { style: { color: T.textFaint, fontSize: 11 } }, String(detail?.status ?? ''))),

    detail?.description ? h('div', null, h('div', { style: { color: T.textDim, marginBottom: 2 } }, t('tb.field.description')), detail.description) : null,
    detail?.prompt ? h('div', null, h('div', { style: { color: T.textDim, marginBottom: 2 } }, t('tb.field.prompt')), detail.prompt) : null,

    h('div', null,
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 } },
        h('div', { style: { color: T.textDim } }, t('tb.checklist')),
        h('span', { style: { color: T.textFaint, fontSize: 11 } }, `${checklist.filter((item) => item.checked === true).length}/${checklist.length}`),
        h('div', { style: { flex: 1 } }),
        h(Btn, { onClick: () => guard(async () => {
          const text = window.prompt(t('tb.checklistAddPrompt'))
          if (text === null || text.trim() === '') return
          await tbCall({ action: 'checklist', id: detail.id, ifVersion: version, checkAction: 'add', items: text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '') })
        }), disabled: busy }, t('tb.checklistAdd'))),
      checklist.length === 0
        ? h('div', { style: { color: T.textFaint } }, t('tb.checklistEmpty'))
        : checklist.map((item) => h('label', {
          key: item.id,
          style: { display: 'flex', alignItems: 'flex-start', gap: 6, padding: '3px 0', cursor: tbStyleButton(busy).cursor },
        },
          h(Checkbox, { checked: item.checked === true, onChange: () => toggleItem(item), disabled: busy }),
          h('span', { style: { flex: 1, textDecoration: item.checked === true ? 'line-through' : 'none', color: item.checked === true ? T.textDim : T.text } },
            String(item.text ?? ''),
            item.note ? h('span', { style: { color: T.textFaint, fontSize: 11 } }, ` — ${item.note}`) : null)))),

    lastRun === null ? null : h(Card, { style: { padding: 8 } },
      h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
        h('div', { style: { fontWeight: 600 } }, t('tb.lastRun')),
        h(Pill, { tone: lastRun.outcome === 'succeeded' ? 'ok' : lastRun.outcome === 'running' ? 'warn' : 'error', style: { fontSize: 10 } }, String(lastRun.outcome)),
        lastRun.isolation === 'worktree' ? h(Pill, { tone: 'brand', style: { fontSize: 10 } }, lastRun.branch ?? 'worktree') : null,
        h('div', { style: { flex: 1 } }),
        h(Btn, { onClick: showWorktree, disabled: busy, style: { fontSize: 11 } }, t('tb.worktreeStatus'))),
      report === null ? h('div', { style: { color: T.textFaint, marginTop: 4 } }, t('tb.noReport'))
        : h('div', { style: { marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4 } },
          h('div', null, report.summary),
          (report.checks ?? []).length > 0 ? h('div', { style: { color: T.textDim } }, `${t('tb.checks')}: ${(report.checks ?? []).join(' | ')}`) : null,
          (report.changedFiles ?? []).length > 0 ? h('div', { style: { color: T.textDim, fontFamily: T.mono, fontSize: 11 } }, (report.changedFiles ?? []).join(', ')) : null,
          report.risk ? h('div', { style: { color: T.warn } }, `${t('tb.risk')}: ${report.risk}`) : null),
      live?.worktree?.ok === true
        ? h('pre', { style: { margin: '6px 0 0', fontSize: 11, color: T.textDim, whiteSpace: 'pre-wrap' } }, JSON.stringify(live.worktree, null, 2))
        : null),

    h('div', null,
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 } },
        h('div', { style: { color: T.textDim } }, `${t('tb.comments')} · ${comments.length}`),
        h('div', { style: { flex: 1 } })),
      comments.slice(-6).map((comment) => h('div', { key: comment.id, style: { padding: '3px 0', borderTop: `1px solid ${T.border}` } },
        h('span', { style: { color: T.textFaint, fontSize: 11, fontFamily: T.mono } }, `${comment.by}: `),
        h('span', null, String(comment.body ?? '')))),
      h('div', { style: { display: 'flex', gap: 6, marginTop: 4 } },
        h(Input, { value: form.comment, onChange: set('comment'), placeholder: t('tb.commentPlaceholder'), style: { flex: 1 } }),
        h(Btn, { onClick: addComments, disabled: busy || form.comment.trim() === '' }, t('tb.commentAdd')))),

    h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', borderTop: `1px solid ${T.border}`, paddingTop: 8 } },
      h(Btn, { kind: 'primary', onClick: run, disabled: busy }, t('tb.execute')),
      h(Btn, { onClick: () => act('cancelRun'), disabled: busy }, t('tb.cancelRun')),
      h(Btn, { onClick: accept, disabled: busy }, t('tb.accept')),
      h(Btn, { onClick: () => act('move', { status: 'todo' }), disabled: busy }, t('tb.toTodo')),
      h(Btn, { onClick: () => act('move', { status: 'in_review' }), disabled: busy }, t('tb.toReview')),
      h('div', { style: { flex: 1 } }),
      h(Btn, { kind: 'danger', onClick: remove, disabled: busy }, t('tb.delete'))))

  const footer = h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
    h(Btn, { onClick: onClose, disabled: busy }, t('board.close')),
    isNew
      ? h(Btn, { kind: 'primary', onClick: save, disabled: busy || form.title.trim() === '' }, busy === true ? h(Spinner, { size: 12 }) : t('tb.create'))
      : h(Btn, { kind: 'primary', onClick: save, disabled: busy }, busy === true ? h(Spinner, { size: 12 }) : t('tb.save')))

  return h(Modal, { title: isNew ? t('tb.new') : String(detail?.title ?? t('tb.edit')), onClose, width: 760, footer }, isNew ? formView : detailView)
}

/* -------------------------------------------------------------- the page */

function TaskboardPage({ state, actions }) {
  const act = fwbActions(state, actions)
  const { notice, push, clear } = useFwbNotify(state, actions)
  const { data, error, refresh } = usePoll(() => api('/taskboard'), 2500)
  const { data: schedule } = usePoll(() => api('/taskboard/schedule'), 8000)
  const tasks = Array.isArray(data?.tasks) ? data.tasks : []
  const settings = state?.settings ?? {}

  const [editing, setEditing] = React.useState(null)
  const [busyIds, setBusyIds] = React.useState({})
  const [dragged, setDragged] = React.useState(null)
  const [dropLane, setDropLane] = React.useState(null)
  const [nowMs] = React.useState(() => Date.now())

  const withBusy = async (id, run) => {
    setBusyIds((prev) => ({ ...prev, [id]: true }))
    try {
      await run()
      await refresh()
    } catch (issue) {
      push(String(issue?.message ?? issue), 'error')
    } finally {
      setBusyIds((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    }
  }

  const moveCard = (task, lane) => {
    if (task === null || task === undefined || task.status === lane) return
    if (lane === 'done') {
      // Acceptance is a deliberate act: it commits and merges the task branch.
      if (window.confirm(t('tb.confirmAccept'))) {
        void withBusy(task.id, () => tbCall({ action: 'accept', id: task.id, ifVersion: task.version, merge: true }))
      }
      return
    }
    void withBusy(task.id, () => tbCall({ action: 'move', id: task.id, status: lane, ifVersion: task.version }))
  }

  const dropAt = (lane) => {
    const id = dragged
    setDragged(null)
    setDropLane(null)
    const task = tasks.find((item) => item.id === id)
    if (task !== undefined) moveCard(task, lane)
  }

  const quickAdd = async (title, urgency) => {
    if (String(title ?? '').trim() === '') return
    try {
      await tbCall({
        action: 'create',
        title: String(title).trim(),
        urgency,
        isolation: String(settings.taskIsolation ?? 'none'),
        execution: { mode: 'claim' },
      })
      push(t('tb.createdShort'), 'ok')
      await refresh()
    } catch (issue) {
      push(String(issue?.message ?? issue), 'error')
    }
  }

  const scheduleEntries = Array.isArray(schedule?.entries) ? schedule.entries : []

  const header = h('div', {
    style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: '6px 10px', borderBottom: `1px solid ${T.border}`, flexShrink: 0 },
  },
    h('div', { style: { fontWeight: 600, marginRight: 4 } }, t('tb.title')),
    h('span', { style: { color: T.textFaint, fontSize: 11 } }, `${t('tb.revision')} ${data?.revision ?? 0} · ${tasks.length}`),
    h('div', { style: { flex: 1 } }),
    schedule?.scheduler?.running === true
      ? h(Pill, { tone: 'ok', style: { fontSize: 10 } }, `${t('tb.schedulerOn')} · ${scheduleEntries.length}`)
      : h(Pill, { tone: 'neutral', style: { fontSize: 10 } }, t('tb.schedulerOff')),
    h(Btn, { onClick: () => setEditing({ task: null }) }, t('tb.new')),
    h(Btn, { onClick: () => refresh() }, t('common.refresh')))

  const lanes = TB_LANES.map((lane) => ({
    ...lane,
    items: tasks.filter((task) => task.status === lane.id),
  }))

  const column = (lane) => h('div', {
    key: lane.id,
    onDragOver: (event) => {
      event.preventDefault()
      if (dropLane !== lane.id) setDropLane(lane.id)
    },
    onDragLeave: () => setDropLane((current) => (current === lane.id ? null : current)),
    onDrop: (event) => {
      event.preventDefault()
      dropAt(lane.id)
    },
    style: {
      width: 236, flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: 0,
      border: `1px solid ${dropLane === lane.id ? T.brand : T.border}`, borderRadius: T.radius,
      background: dropLane === lane.id ? T.bgInput : 'transparent',
    },
  },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderBottom: `1px solid ${T.border}`, flexShrink: 0 } },
      h(Pill, { tone: lane.tone, style: { fontSize: 11 } }, t(lane.labelKey)),
      h('span', { style: { color: T.textFaint, fontSize: 11 } }, lane.items.length),
      h('div', { style: { flex: 1 } }),
      lane.id === 'backlog' || lane.id === 'todo'
        ? h(Btn, { onClick: () => setEditing({ task: { id: null, status: lane.id } }), style: { fontSize: 11, padding: '2px 6px' } }, '+')
        : null),
    h('div', { style: { flex: 1, overflowY: 'auto', padding: 6, minHeight: 60 } },
      lane.items.length === 0
        ? h('div', { style: { color: T.textFaint, fontSize: 11, padding: 6 } }, t('tb.emptyLane'))
        : lane.items.map((task) => h(TbCard, {
          key: task.id,
          task,
          busy: busyIds[task.id] === true,
          dragged: dragged === task.id,
          onOpen: (item) => setEditing({ task: item }),
          onDragStart: (id) => setDragged(id),
          onDragEnd: () => setDragged(null),
        }))))

  const board = h('div', { style: { flex: 1, minHeight: 0, display: 'flex', gap: 8, padding: 8, overflowX: 'auto', alignItems: 'stretch' } }, lanes.map(column))

  const scheduleBar = scheduleEntries.length === 0 ? null : h('div', {
    style: { display: 'flex', flexWrap: 'wrap', gap: 6, padding: '5px 10px', borderBottom: `1px solid ${T.border}`, fontSize: 11, flexShrink: 0 },
  },
    h('span', { style: { color: T.textDim } }, t('tb.upcoming')),
    scheduleEntries.slice(0, 6).map((entry) => h(Chip, {
      key: entry.id,
      title: entry.cron ?? entry.runAt ?? '',
      onClick: () => setEditing({ task: tasks.find((task) => task.id === entry.id) ?? { id: entry.id } }),
    }, `${entry.title} · ${entry.nextRunAt === null ? '—' : new Date(entry.nextRunAt).toLocaleString()}`)))

  return h(FwbPage, { notice, onDismiss: clear },
    header,
    scheduleBar,
    error !== null
      ? h('div', { style: { padding: '6px 10px', color: T.error, fontSize: 12, borderBottom: `1px solid ${T.border}` } }, `${t('tb.loadFailed')}: ${String(error?.message ?? error)}`)
      : null,
    board,
    editing !== null
      ? h(TbTaskModal, {
        task: editing.task,
        settings,
        onClose: () => setEditing(null),
        onChanged: refresh,
        push,
      })
      : null,
    h('div', { style: { display: 'flex', gap: 10, padding: '4px 10px', borderTop: `1px solid ${T.border}`, color: T.textFaint, fontSize: 11, flexShrink: 0 } },
      h('span', null, t('tb.hint.drag')),
      h('div', { style: { flex: 1 } }),
      h('span', null, `${t('tb.localTime')}: ${new Date(nowMs).toLocaleString()}`)))
}