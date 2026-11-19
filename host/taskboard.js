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
import { commitWorktree, createWorktree, mergeWorktree, worktreeStatus } from './worktree.js'
import { cronMatches, nextCronRun, parseCron } from './cron.js'

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

  /* ------------------------------------------------------- execution runner */

  const runHandles = new Map()

  /** The project directory a task belongs to. */
  function projectPathOf(task) {
    const raw = cleanText(task?.workspaceId, 500)
    return raw === '' ? process.cwd() : raw
  }

  function buildRunPrompt(task, { projectPath, worktreePath, degraded }) {
    const lines = [
      'You are executing one task of the DSH task board.',
      '',
      `Task id: ${task.id}`,
      `Title: ${task.title}`,
      `Urgency: ${task.urgency}`,
    ]
    if (task.description !== '') lines.push('', 'Description:', task.description)
    if (task.prompt !== '') lines.push('', 'Extra instructions:', task.prompt)
    lines.push('', `Project: ${projectPath}`)
    if (worktreePath !== null) {
      lines.push(`Work in this isolated worktree: ${worktreePath}`, 'Commit your work on that branch; do not touch the main working tree.')
    } else if (degraded !== null) {
      lines.push(`(Worktree isolation unavailable: ${degraded}. Work directly in the project directory.)`)
    }
    const checklist = task.checklist ?? []
    if (checklist.length > 0) {
      lines.push('', 'Acceptance checklist — tick each one with evidence:')
      for (const item of checklist) lines.push(`- [${item.id}] ${item.text}`)
    }
    lines.push(
      '',
      'Protocol (follow it exactly):',
      '1. Read the task first: `taskboard_get` with the id above.',
      '2. Work, then verify with the flutter_* tools (analyze / test / logs).',
      '3. Tick the checklist with `taskboard_checklist` (action=check, itemId=..., note=evidence).',
      '4. Submit `taskboard_execution_report` (summary / changedFiles / checks / risk).',
      '5. Add a handoff comment with `taskboard_comment_add`.',
      '6. Move the task to review: `taskboard_move` status=in_review with the CURRENT version.',
      'Never move a task to done — a human accepts it.',
    )
    return lines.join('\n')
  }

  /**
   * Start a real execution for a task: optionally create its worktree, spawn the
   * agent session, record the run and move the card to in_progress.
   */
  async function executeTask(input, { actor = 'panel' } = {}) {
    const task = requireTask(input?.id)
    if (task.status === 'archived') throw fail('invalid-transition', 'archived tasks are immutable')
    if ((task.executions ?? []).some((entry) => entry.outcome === 'running')) {
      throw fail('already-running', `task ${task.id} already has a running execution`)
    }
    const agents = (() => {
      try {
        return ctx?.get?.('agents') ?? null
      } catch {
        return null
      }
    })()
    if (agents === null || typeof agents.create !== 'function') {
      throw fail('agents-unavailable', 'ctx.get("agents") is unavailable')
    }

    const settingsValues = (() => {
      try {
        return settings?.get?.() ?? {}
      } catch {
        return {}
      }
    })()
    const projectPath = projectPathOf(task)
    const isolation = cleanText(input?.isolation ?? task.isolation ?? '', 20) === 'worktree' ? 'worktree' : 'none'
    let cwd = projectPath
    let branch = null
    let worktreePath = null
    let degraded = null
    if (isolation === 'worktree') {
      const made = await createWorktree({
        projectPath,
        taskId: task.id,
        title: task.title,
        branch: task.branch ?? '',
        dataDir: settingsValues.dataDir ?? '',
      })
      if (made.ok === true) {
        cwd = made.path
        branch = made.branch
        worktreePath = made.path
      } else {
        degraded = made.reason ?? 'worktree unavailable'
        note(`task ${task.id}: worktree degraded — ${degraded}`, 'warn')
      }
    }

    const pinned = normalizeModel(input?.model) ?? task.model ?? null
    const agentOptions = {}
    if (pinned !== null && pinned.provider !== '') agentOptions.provider = pinned.provider
    if (pinned !== null && pinned.model !== '') agentOptions.model = pinned.model
    if (pinned !== null && pinned.reasoningEffort !== undefined) agentOptions.reasoningEffort = pinned.reasoningEffort

    const sessionId = uid('tb-run')
    let handle = null
    try {
      handle = await agents.create({ sessionId, meta: { cwd }, agentOptions })
      if (handle?.agent === undefined || handle.agent === null) throw fail('agents-unavailable', 'agents.create returned no agent handle')
      await handle.agent.followup({ content: [{ type: 'text', text: buildRunPrompt(task, { projectPath, worktreePath, degraded }) }], source: { kind: 'flutter-workbench' } })
    } catch (error) {
      if (handle !== null && typeof handle.dispose === 'function') {
        try {
          await handle.dispose()
        } catch {
          /* ignore */
        }
      }
      const detail = normalizeError(error)
      note(`task ${task.id}: execution failed to start — ${detail.message}`, 'warn')
      throw fail('dispatch-failed', `cannot start the execution: ${detail.message}`)
    }
    runHandles.set(sessionId, handle)

    const at = nowMs()
    const run = { id: uid('run'), sessionId, outcome: 'running', startedAt: at, isolation, cwd, worktreePath, branch }
    task.executions.push(run)
    task.status = 'in_progress'
    task.claimedBy = sessionId
    task.claimAt = at
    task.version += 1
    task.updatedAt = at
    task.updatedBy = actor
    touch()
    note(`task ${task.id}: execution started (${isolation}${worktreePath === null ? '' : ` · ${branch}`})`)
    return { task: summarize(task), sessionId, executionId: run.id, worktreePath, branch, degraded }
  }

  /** Cancel a running execution and return the card to todo. */
  async function cancelExecution(input) {
    const task = requireTask(input?.id)
    const running = (task.executions ?? []).filter((entry) => entry.outcome === 'running')
    for (const run of running) {
      const handle = runHandles.get(run.sessionId)
      if (handle !== undefined) {
        runHandles.delete(run.sessionId)
        try {
          const agent = handle.agent
          if (agent !== null && typeof agent.cancel === 'function') agent.cancel({ kind: 'user' }, { keepInbox: true })
        } catch {
          /* the session may already be gone */
        }
        if (typeof handle.dispose === 'function') {
          try {
            await handle.dispose()
          } catch {
            /* ignore */
          }
        }
      }
      run.outcome = 'canceled'
      run.finishedAt = nowMs()
    }
    if (running.length > 0) {
      delete task.claimedBy
      delete task.claimAt
      if (task.status === 'in_progress') task.status = 'todo'
      task.version += 1
      task.updatedAt = nowMs()
      touch()
    }
    return { task: summarize(task), canceled: running.length }
  }

  /**
   * Accept a task: commit what the worktree holds, merge the branch into the
   * project, then move the card to done as a human action.
   */
  async function acceptTask(input, { actor = 'user' } = {}) {
    const task = requireTask(input?.id)
    versionGuard(task, input?.ifVersion)
    const merge = input?.merge !== false
    const lastRun = [...(task.executions ?? [])].reverse().find((entry) => typeof entry.worktreePath === 'string' && entry.worktreePath !== '')
    let commitResult = null
    let mergeResult = null
    if (lastRun !== undefined) {
      commitResult = await commitWorktree({ worktreePath: lastRun.worktreePath, message: `task ${task.id}: ${task.title}` })
      if (merge === true && lastRun.branch !== null && lastRun.branch !== undefined) {
        mergeResult = await mergeWorktree({ projectPath: projectPathOf(task), branch: lastRun.branch, message: `task ${task.id}: ${task.title}` })
      }
    }
    const moved = move({ id: task.id, status: 'done', ifVersion: task.version }, { actor, actorKind: 'user' })
    return { ...moved, worktree: { commit: commitResult, merge: mergeResult } }
  }

  /** Worktree state of a task's latest run (for the review panel). */
  async function worktreeState(input) {
    const task = requireTask(input?.id)
    const lastRun = [...(task.executions ?? [])].reverse().find((entry) => typeof entry.worktreePath === 'string' && entry.worktreePath !== '')
    if (lastRun === undefined) return { ok: false, reason: 'this task never ran in a worktree' }
    return { ok: true, branch: lastRun.branch, worktreePath: lastRun.worktreePath, ...(await worktreeStatus({ worktreePath: lastRun.worktreePath })) }
  }

  /* ------------------------------------------------------------ scheduling */

  /** When this task should run next, or null when it is not scheduled. */
  function nextScheduledAt(task, fromMs = nowMs()) {
    const schedule = task?.execution ?? { mode: 'claim' }
    if (schedule.mode !== 'scheduled') return null
    if (typeof schedule.runAt === 'string' && schedule.runAt !== '') {
      const at = parseRunAt(schedule.runAt)
      return at
    }
    if (typeof schedule.cron === 'string' && schedule.cron !== '') {
      try {
        // A stored anchor wins (it is what "next run" means after the first fire).
        const anchor = Number(task.scheduleState?.nextRunAt)
        if (Number.isFinite(anchor) && anchor > 0) return anchor
        // No anchor yet: the card is due during a matching minute, otherwise it
        // waits for the next one. (Computing only the *next* run would never be
        // due at the matching minute itself.)
        const minute = Math.floor(fromMs / 60000) * 60000
        const spec = parseCron(schedule.cron)
        if (cronMatches(spec, new Date(minute))) return minute
        return nextCronRun(spec, fromMs)
      } catch (error) {
        note(`task ${task.id}: bad cron "${schedule.cron}" — ${normalizeError(error).message}`, 'warn')
        return null
      }
    }
    return null
  }

  function parseRunAt(value) {
    if (/^\d+$/.test(value)) return Number(value)
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  /** Scheduled tasks that are due now (or overdue). */
  function dueScheduled(now = nowMs()) {
    const out = []
    for (const task of ledger.tasks) {
      if (task.trashedAt !== undefined) continue
      if (['archived', 'canceled', 'done', 'in_progress'].includes(task.status)) continue
      const at = nextScheduledAt(task, now)
      if (at === null || at > now) continue
      out.push({ id: task.id, title: task.title, dueAt: at, mode: task.status })
    }
    return out
  }

  /** Record that a scheduled run fired; recompute the next anchor. */
  function markScheduled(id, { lastRunAt = nowMs(), nextRunAt = null } = {}) {
    const task = requireTask(id)
    const schedule = task.execution ?? { mode: 'claim' }
    const at = nowMs()
    const anchor = nextRunAt !== null
      ? Number(nextRunAt)
      : typeof schedule.cron === 'string' && schedule.cron !== ''
        ? nextCronRun(schedule.cron, lastRunAt)
        : null
    task.scheduleState = { lastRunAt, nextRunAt: anchor }
    if (anchor === null && schedule.mode === 'scheduled') {
      // A one-shot run never fires twice.
      task.execution = { mode: 'claim' }
    }
    task.version += 1
    task.updatedAt = at
    touch()
    return { task: summarize(task), nextRunAt: anchor }
  }

  /** Scheduled tasks with their next fire time, for the panel. */
  function scheduleList(now = nowMs()) {
    return ledger.tasks
      .filter((task) => task.trashedAt === undefined && (task.execution ?? {}).mode === 'scheduled')
      .map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        cron: task.execution.cron ?? null,
        runAt: task.execution.runAt ?? null,
        lastRunAt: task.scheduleState?.lastRunAt ?? null,
        nextRunAt: nextScheduledAt(task, now),
      }))
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
    executeTask,
    cancelExecution,
    acceptTask,
    worktreeState,
    dueScheduled,
    markScheduled,
    scheduleList,
    nextScheduledAt,
    // lifecycle
    dispose,
    // constants for callers
    statuses: TB_STATUSES,
    urgencies: TB_URGENCIES,
  }
}