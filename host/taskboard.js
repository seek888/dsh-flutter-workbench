/**
 * Task-board engine — a faithful port of `dsh-taskboard`'s task ledger into the
 * Flutter workbench, so one plugin owns both the Flutter toolchain and the board.
 *
 * Model and gates match the upstream plugin (statuses, urgency, optimistic
 * `version`, claim ownership, dependency gate, DoD checklist, comments, execution
 * report, soft delete). Deliberately NOT ported: worktree isolation, cron
 * scheduling, external sync (ZenTao/TAPD), SSE. Those need host features we do
 * not own here; the tool surface stays the same so agents keep working.
 */
import { clamp, normalizeError, nowMs, uid } from './util.js'

/** Statuses, in board order. */
export const TB_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled', 'archived']
export const TB_URGENCIES = ['urgent', 'normal', 'relaxed']
export const TB_LANES = [
  { id: 'backlog', label: '待办池', order: 0 },
  { id: 'todo', label: '待办', order: 1 },
  { id: 'in_progress', label: '执行中', order: 2 },
  { id: 'in_review', label: '待验收', order: 3 },
  { id: 'done', label: '完成', order: 4 },
]

const STORE_KEY = 'taskboard'
const STORE_VERSION = 1
const MAX_CHECKLIST_ITEMS = 30
const MAX_COMMENT_CHARS = 4000
const MAX_TITLE_CHARS = 200

/** Legal transitions. `done` is additionally gated to a human actor. */
const TRANSITIONS = {
  backlog: ['todo', 'canceled'],
  todo: ['in_progress', 'canceled', 'backlog'],
  in_progress: ['in_review', 'todo', 'canceled'],
  in_review: ['in_progress', 'done', 'canceled'],
  done: ['archived', 'in_review'],
  canceled: ['todo', 'archived'],
  archived: [],
}

export function taskboardError(code, message) {
  return Object.assign(new Error(message), { code })
}

const fail = taskboardError

function asStatus(value) {
  const status = String(value ?? '')
  if (TB_STATUSES.includes(status) === false) {
    throw fail('invalid-input', `status must be one of ${TB_STATUSES.join(' | ')} (got "${value}")`)
  }
  return status
}

function asUrgency(value) {
  const urgency = String(value ?? '')
  if (TB_URGENCIES.includes(urgency) === false) {
    throw fail('invalid-input', `urgency must be one of ${TB_URGENCIES.join(' | ')} (got "${value}")`)
  }
  return urgency
}

function cleanText(value, limit) {
  if (value === null || value === undefined) return ''
  const text = String(value).replace(/\r\n/g, '\n').trim()
  return text.length <= limit ? text : text.slice(0, limit)
}

function cleanList(value, limit = 50, itemLimit = 400) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\r?\n/) : []
  const out = []
  for (const item of raw) {
    const text = cleanText(item, itemLimit)
    if (text !== '' && out.includes(text) === false) out.push(text)
    if (out.length >= limit) break
  }
  return out
}

function canTransition(from, to) {
  if (from === to) return true
  return (TRANSITIONS[from] ?? []).includes(to)
}

function isClaim(from, to) {
  return to === 'in_progress' && from !== 'in_progress'
}

function checklistFromTexts(texts) {
  return texts.slice(0, MAX_CHECKLIST_ITEMS).map((text) => ({ id: uid('chk'), text: cleanText(text, 200), checked: false }))
}

/** Board snapshot shape for the panel and the list tool. */
function summarize(task) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    urgency: task.urgency,
    version: task.version,
    workspaceId: task.workspaceId,
    claimedBy: task.claimedBy ?? null,
    blocked: task.blocked === true,
    checklistDone: (task.checklist ?? []).filter((item) => item.checked === true).length,
    checklistTotal: (task.checklist ?? []).length,
    updatedAt: task.updatedAt,
  }
}

export function createTaskboard({ store, bus, ctx, logs, settings, logger } = {}) {
  /** @type {{revision:number, tasks:any[]}} */
  let ledger = { revision: 0, tasks: [] }
  const loaded = store?.get?.(STORE_KEY, null)
  if (loaded !== null && typeof loaded === 'object' && Array.isArray(loaded.tasks)) {
    ledger = { revision: Number.isFinite(Number(loaded.revision)) ? Number(loaded.revision) : 0, tasks: loaded.tasks.filter((task) => task !== null && typeof task === 'object' && typeof task.id === 'string') }
  }

  let persistTimer = null

  function note(text, level = 'info') {
    try {
      logs?.append?.({ source: 'plugin', level, text: `taskboard: ${text}` })
    } catch {
      /* logging never breaks the ledger */
    }
  }

  function persistNow() {
    try {
      void Promise.resolve(store?.set?.(STORE_KEY, { version: STORE_VERSION, revision: ledger.revision, tasks: ledger.tasks })).catch((error) => {
        logger?.warn?.(`taskboard: cannot persist: ${normalizeError(error).message}`)
      })
    } catch (error) {
      logger?.warn?.(`taskboard: cannot persist: ${normalizeError(error).message}`)
    }
  }

  function touch() {
    ledger.revision += 1
    emit()
    if (persistTimer !== null) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      persistNow()
    }, 120)
    if (typeof persistTimer.unref === 'function') persistTimer.unref()
  }

  function emit() {
    try {
      bus?.emit?.('taskboard:change', snapshot())
    } catch {
      /* listeners must not break a write */
    }
  }

  function snapshot() {
    return {
      revision: ledger.revision,
      lanes: TB_LANES.map((lane) => ({ ...lane })),
      tasks: ledger.tasks.filter((task) => task.trashedAt === undefined && task.status !== 'archived').map(cloneTask),
    }
  }

  function cloneTask(task) {
    return JSON.parse(JSON.stringify(task))
  }

  function requireTask(id) {
    const key = cleanText(id, 200)
    const task = ledger.tasks.find((item) => item.id === key)
    if (task === undefined || task.trashedAt !== undefined) throw fail('not-found', `no task ${id}`)
    return task
  }

  function versionGuard(task, ifVersion) {
    const expected = Number(ifVersion)
    if (Number.isFinite(expected) === false) return
    if (expected !== task.version) {
      throw fail('version-conflict', `task ${task.id} is at v${task.version}, you read v${expected}; re-read and retry`)
    }
  }

  function dependencyError(task) {
    const blocking = (task.blockedBy ?? [])
      .map((id) => ledger.tasks.find((item) => item.id === id))
      .filter((dep) => dep !== undefined && ['in_review', 'done', 'archived'].includes(dep.status) === false)
    if (blocking.length === 0) return null
    return `blocked by unfinished prerequisites: ${blocking.map((dep) => `${dep.title} (${dep.id})`).join(', ')}`
  }

  function dependencyState(task) {
    return (task.blockedBy ?? []).map((id) => {
      const dep = ledger.tasks.find((item) => item.id === id)
      return dep === undefined
        ? { id, title: null, status: null }
        : { id, title: dep.title, status: dep.status }
    })
  }

  /** Which project the caller belongs to; an explicit arg always wins. */
  function resolveWorkspace(workspaceId) {
    const explicit = cleanText(workspaceId, 500)
    if (explicit !== '') return explicit
    try {
      const projects = ctx?.get?.('projects')
      const active = typeof projects?.active === 'function' ? projects.active() : null
      const projectPath = active !== null && typeof active === 'object' ? active.path : null
      if (typeof projectPath === 'string' && projectPath !== '') return projectPath
    } catch {
      /* fall through */
    }
    return 'workspace'
  }

  /* ------------------------------------------------------------------ API */

  function list({ workspaceId, status, urgency, includeTrashed = false } = {}) {
    const wantedWorkspace = cleanText(workspaceId, 500)
    const wantedStatus = status === undefined ? undefined : asStatus(status)
    const wantedUrgency = urgency === undefined ? undefined : asUrgency(urgency)
    const tasks = ledger.tasks.filter((task) => {
      if (includeTrashed === false && task.trashedAt !== undefined) return false
      if (wantedWorkspace !== '' && task.workspaceId !== wantedWorkspace) return false
      if (wantedStatus !== undefined && task.status !== wantedStatus) return false
      if (wantedUrgency !== undefined && task.urgency !== wantedUrgency) return false
      return true
    })
    return {
      revision: ledger.revision,
      tasks: tasks.map((task) => ({ ...summarize(task), dependencies: dependencyState(task) })),
    }
  }

  function get(id) {
    const task = requireTask(id)
    return { task: { ...cloneTask(task), dependencies: dependencyState(task) } }
  }

  function create(input, { actor = 'user' } = {}) {
    const title = cleanText(input?.title, MAX_TITLE_CHARS)
    if (title === '') throw fail('invalid-input', 'title is required')
    const urgency = asUrgency(input?.urgency ?? 'normal')
    const status = input?.status === undefined ? 'todo' : asStatus(input.status)
    if (status === 'archived') throw fail('invalid-input', 'a new task cannot start archived')
    const at = nowMs()
    const task = {
      id: uid('task'),
      title,
      description: cleanText(input?.description, 20000),
      prompt: cleanText(input?.prompt, 20000),
      workspaceId: resolveWorkspace(input?.workspaceId),
      urgency,
      status,
      version: 1,
      createdAt: at,
      updatedAt: at,
      updatedBy: actor,
      blocked: false,
      blockedBy: cleanList(input?.blockedBy, 50, 200),
      checklist: Array.isArray(input?.checklist) ? checklistFromTexts(cleanList(input.checklist, MAX_CHECKLIST_ITEMS, 200)) : [],
      comments: [],
      executions: [],
      execution: normalizeExecution(input?.execution),
      model: normalizeModel(input?.model),
      isolation: cleanText(input?.isolation, 40) === '' ? null : cleanText(input.isolation, 40),
      branch: cleanText(input?.branch, 200) === '' ? null : cleanText(input.branch, 200),
      permission: cleanText(input?.permission, 40) === '' ? null : cleanText(input.permission, 40),
      presetId: cleanText(input?.presetId, 200) === '' ? null : cleanText(input.presetId, 200),
    }
    ledger.tasks.push(task)
    touch()
    note(`created ${task.id} · ${task.title}`)
    return { task: summarize(task) }
  }

  function normalizeExecution(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { mode: 'claim' }
    const mode = cleanText(value.mode, 20) === 'scheduled' ? 'scheduled' : 'claim'
    if (mode === 'claim') return { mode }
    const cron = cleanText(value.cron, 120)
    const runAt = cleanText(value.runAt, 40)
    return { mode, ...(cron === '' ? {} : { cron }), ...(runAt === '' ? {} : { runAt }) }
  }

  function normalizeModel(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const provider = cleanText(value.provider, 120)
    const model = cleanText(value.model, 160)
    if (provider === '' && model === '') return null
    const effort = cleanText(value.reasoningEffort, 40)
    return { provider, model, ...(effort === '' ? {} : { reasoningEffort: effort }) }
  }

  function update(input, { actor = 'user' } = {}) {
    const task = requireTask(input?.id)
    versionGuard(task, input?.ifVersion)
    if (task.status === 'archived') throw fail('invalid-transition', 'archived tasks are immutable')
    const patch = input?.patch ?? {}
    if (patch.title !== undefined) {
      const title = cleanText(patch.title, MAX_TITLE_CHARS)
      if (title === '') throw fail('invalid-input', 'title cannot be empty')
      task.title = title
    }
    if (patch.description !== undefined) task.description = cleanText(patch.description, 20000)
    if (patch.prompt !== undefined) task.prompt = cleanText(patch.prompt, 20000)
    if (patch.urgency !== undefined) task.urgency = asUrgency(patch.urgency)
    if (patch.blockedBy !== undefined) task.blockedBy = cleanList(patch.blockedBy, 50, 200)
    if (patch.model !== undefined) task.model = normalizeModel(patch.model)
    if (patch.execution !== undefined) task.execution = normalizeExecution(patch.execution)
    if (patch.permission !== undefined) task.permission = cleanText(patch.permission, 40) === '' ? null : cleanText(patch.permission, 40)
    if (patch.presetId !== undefined) task.presetId = cleanText(patch.presetId, 200) === '' ? null : cleanText(patch.presetId, 200)
    if (patch.isolation !== undefined) task.isolation = cleanText(patch.isolation, 40) === '' ? null : cleanText(patch.isolation, 40)
    task.version += 1
    task.updatedAt = nowMs()
    task.updatedBy = actor
    touch()
    return { task: summarize(task), version: task.version }
  }

  function move(input, { actor = 'user', actorKind = 'agent' } = {}) {
    const task = requireTask(input?.id)
    const to = asStatus(input?.status)
    versionGuard(task, input?.ifVersion)
    if (to === 'done') {
      // The meaningful protection: the session WORKING the task may not declare
      // its own work done. A user driver (panel, or the user's own chat session)
      // still can — the panel-side confirmation upstream calls "GUI" is the panel
      // route here, and the user's own session is allowed so the gate is usable
      // before that UI exists.
      const running = (task.executions ?? []).filter((entry) => entry.outcome === 'running')
      const workedByCaller = running.some((entry) => entry.sessionId === actor)
      if (workedByCaller) {
        throw fail('forbidden', 'the session executing a task cannot move it to done; a human must accept it')
      }
    }
    if (canTransition(task.status, to) === false) {
      throw fail('invalid-transition', `illegal transition ${task.status} → ${to}`)
    }
    // Exclusive hold: a task being worked by one session cannot be taken over.
    if (task.status === 'in_progress' && task.claimedBy !== undefined && task.claimedBy !== actor) {
      throw fail('forbidden', `task ${task.id} is held by ${task.claimedBy}; it cannot be taken over`)
    }
    if (isClaim(task.status, to)) {
      const blocked = dependencyError(task)
      if (blocked !== null) throw fail('invalid-input', blocked)
      task.claimedBy = actor
      task.claimAt = nowMs()
      task.blocked = false
    }
    if (to !== 'in_progress') {
      delete task.claimedBy
      delete task.claimAt
    }
    task.status = to
    task.version += 1
    task.updatedAt = nowMs()
    task.updatedBy = actor
    touch()
    const dependents = ledger.tasks
      .filter((item) => (item.blockedBy ?? []).includes(task.id) && ['canceled', 'archived'].includes(to))
      .map((item) => ({ id: item.id, title: item.title }))
    return { task: summarize(task), ...(dependents.length === 0 ? {} : { affectedDependents: dependents }) }
  }

  function commentAdd(input, { actor = 'user' } = {}) {
    const task = requireTask(input?.id)
    const body = cleanText(input?.body, MAX_COMMENT_CHARS)
    if (body === '') throw fail('invalid-input', 'body is required')
    const comment = { id: uid('cmt'), at: nowMs(), by: actor, body }
    task.comments.push(comment)
    task.version += 1
    task.updatedAt = comment.at
    touch()
    return { comment, task: { id: task.id, version: task.version, status: task.status } }
  }

  function comments(id) {
    const task = requireTask(id)
    return { comments: task.comments.map((comment) => ({ ...comment })) }
  }

  function remove(input) {
    const task = requireTask(input?.id)
    versionGuard(task, input?.ifVersion)
    task.trashedAt = nowMs()
    task.version += 1
    task.updatedAt = task.trashedAt
    touch()
    return { task: { id: task.id, version: task.version }, trashed: true }
  }

  function checklist(input, { actor = 'user' } = {}) {
    const task = requireTask(input?.id)
    versionGuard(task, input?.ifVersion)
    if (task.status === 'archived') throw fail('invalid-transition', 'archived tasks are immutable')
    const action = cleanText(input?.action, 20)
    const items = Array.isArray(task.checklist) ? task.checklist : []
    if (action === 'add') {
      const texts = cleanList(input?.items, 10, 200)
      if (texts.length === 0) throw fail('invalid-input', 'items must carry 1..10 texts per add call')
      if (items.length + texts.length > MAX_CHECKLIST_ITEMS) {
        throw fail('invalid-input', `checklist may hold at most ${MAX_CHECKLIST_ITEMS} items (currently ${items.length})`)
      }
      items.push(...checklistFromTexts(texts))
    } else if (action === 'check' || action === 'uncheck') {
      const itemId = cleanText(input?.itemId, 200)
      if (itemId === '') throw fail('invalid-input', `itemId is required for ${action}`)
      const item = items.find((entry) => entry.id === itemId)
      if (item === undefined) throw fail('not-found', `no checklist item ${itemId} (task ${task.id})`)
      if (action === 'check') {
        item.checked = true
        item.checkedBy = actor
        item.checkedAt = nowMs()
        const evidence = cleanText(input?.note, 400)
        if (evidence !== '') item.note = evidence
      } else {
        item.checked = false
        delete item.checkedBy
        delete item.checkedAt
        delete item.note
      }
    } else {
      throw fail('invalid-input', `action must be add | check | uncheck (got "${input?.action}")`)
    }
    task.checklist = items
    task.version += 1
    task.updatedAt = nowMs()
    task.updatedBy = actor
    touch()
    const done = items.filter((item) => item.checked === true).length
    return { task: { id: task.id, version: task.version }, checklist: items.map((item) => ({ ...item })), done, total: items.length }
  }

  /** Attach the structured report to the caller's running execution. */
  function executionReport(input, { sessionId } = {}) {
    const summary = cleanText(input?.summary, 2000)
    if (summary === '') throw fail('invalid-input', 'summary is required')
    const report = {
      summary,
      changedFiles: cleanList(input?.changedFiles, 50, 300),
      checks: cleanList(input?.checks, 50, 300),
      artifacts: cleanList(input?.artifacts, 30, 300),
      risk: cleanText(input?.risk, 2000),
    }
    const target = ledger.tasks.find((task) => (task.executions ?? []).some((run) => run.sessionId === sessionId && run.outcome === 'running'))
    if (target === undefined) {
      throw fail('not-found', 'no task has a running execution for this session; start the task first')
    }
    const run = target.executions.find((entry) => entry.sessionId === sessionId && entry.outcome === 'running')
    run.report = report
    target.version += 1
    target.updatedAt = nowMs()
    touch()
    return { taskId: target.id, executionId: run.id, report }
  }

  /** Record a started execution (the panel or a tool starts the session). */
  function startExecution(input, { sessionId = null } = {}) {
    const task = requireTask(input?.id)
    versionGuard(task, input?.ifVersion)
    const at = nowMs()
    const run = { id: uid('run'), sessionId, outcome: 'running', startedAt: at }
    task.executions.push(run)
    if (task.status === 'todo' || task.status === 'backlog' || task.status === 'in_review') {
      task.status = 'in_progress'
      task.claimedBy = sessionId ?? 'panel'
      task.claimAt = at
    }
    task.version += 1
    task.updatedAt = at
    touch()
    return { task: summarize(task), executionId: run.id }
  }

  function finishExecution(input, { sessionId = null } = {}) {
    const task = requireTask(input?.id)
    const outcome = cleanText(input?.outcome, 20) === 'failed' ? 'failed' : 'succeeded'
    const run = (task.executions ?? []).filter((entry) => entry.sessionId === sessionId && entry.outcome === 'running').pop()
    if (run !== undefined) {
      run.outcome = outcome
      run.finishedAt = nowMs()
    }
    task.version += 1
    task.updatedAt = nowMs()
    touch()
    return { task: summarize(task) }
  }

  function lanes() {
    return TB_LANES.map((lane) => ({ ...lane, count: ledger.tasks.filter((task) => task.status === lane.id && task.trashedAt === undefined).length }))
  }

  async function dispose() {
    if (persistTimer !== null) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    persistNow()
  }

  return {
    // reads
    snapshot,
    lanes,
    list,
    get,
    comments,
    // writes
    create,
    update,
    move,
    remove,
    checklist,
    commentAdd,
    executionReport,
    startExecution,
    finishExecution,
    // lifecycle
    dispose,
    // constants for callers
    statuses: TB_STATUSES,
    urgencies: TB_URGENCIES,
  }
}