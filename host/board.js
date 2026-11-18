/**
 * Kanban board engine for the Flutter workbench Host half.
 *
 * Owns the card state machine (backlog → ready → running → review → verify →
 * done), persistence through the injected JSON store, AI decomposition of an
 * idea into cards, worker-session dispatch, worker reporting, and live agent
 * state reflection.
 *
 * The whole engine is plain ESM with zero dependencies and is testable offline:
 * inject a fake store, a fake bus and a fake `ctx` whose `get('agents')`
 * returns a stub.
 */
import { clamp, normalizeError, nowMs, sleep, uid, withTimeout } from './util.js'

/** The six lanes, in the order the UI renders them. */
export const LANES = [
  { id: 'backlog', label: '待办', order: 0 },
  { id: 'ready', label: '就绪', order: 1 },
  { id: 'running', label: '执行中', order: 2 },
  { id: 'review', label: '待验收', order: 3 },
  { id: 'verify', label: '验证中', order: 4 },
  { id: 'done', label: '完成', order: 5 },
]

/** Lane ids in forward order. */
export const LANE_IDS = LANES.map((lane) => lane.id)

const LANE_ORDER = new Map(LANES.map((lane) => [lane.id, lane.order]))
const AGENT_STATUSES = new Set(['idle', 'queued', 'working', 'blocked', 'done', 'failed'])
const READONLY_DENY = ['write', 'edit', 'pwsh', 'subagent', 'subagent_fork']
/** The tool a dispatched worker must call to hand its result back. */
const REPORT_TOOL = 'flutter_task_report'
const BOARD_KEY = 'board'
const QUARANTINE_KEY = 'board-quarantine'
const BOARD_VERSION = 1
const PERSIST_DEBOUNCE_MS = 120
const DEFAULT_MAX_TASKS = 6
const MAX_TASKS_CAP = 24
const DEFAULT_DECOMPOSE_TIMEOUT_MS = 120000
const MAX_HISTORY = 200
const MAX_ARCHIVED = 500
const MAX_COMMANDS = 50

const PRIORITY_ALIASES = new Map([
  ['p0', 'urgent'], ['p1', 'high'], ['p2', 'normal'], ['p3', 'low'],
  ['critical', 'urgent'], ['blocker', 'urgent'], ['urgent', 'urgent'],
  ['high', 'high'], ['important', 'high'], ['major', 'high'],
  ['normal', 'normal'], ['medium', 'normal'], ['default', 'normal'], ['p2-normal', 'normal'],
  ['low', 'low'], ['minor', 'low'], ['trivial', 'low'],
])

function fail(code, message) {
  return Object.assign(new Error(message), { code })
}

/** Trim, normalise newlines and bound a string. */
function cleanText(value, limit = 2000) {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'string' ? value : String(value)
  const normalised = text.replace(/\r\n/g, '\n').trim()
  return normalised.length <= limit ? normalised : normalised.slice(0, limit)
}

/** Array of distinct non-empty strings from an array or a newline-separated string. */
function cleanList(value, limit = 40) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\r?\n/) : []
  const out = []
  const seen = new Set()
  for (const item of raw) {
    if (item === null || item === undefined) continue
    const text = cleanText(item, 4000)
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    out.push(text)
    if (out.length >= limit) break
  }
  return out
}

function coercePriority(value) {
  const key = cleanText(value, 40).toLowerCase()
  if (key === '') return 'normal'
  return PRIORITY_ALIASES.get(key) ?? 'normal'
}

function coerceLane(value, fallback = 'backlog') {
  const key = cleanText(value, 40)
  return LANE_IDS.includes(key) ? key : fallback
}

function coerceAgentStatus(value) {
  const key = cleanText(value, 40)
  return AGENT_STATUSES.has(key) ? key : null
}

function newAgent() {
  return { sessionId: null, status: null, startedAt: null, finishedAt: null, lastReport: null }
}



function normalizeCommands(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (item === null || item === undefined) continue
    if (typeof item === 'string') {
      const command = cleanText(item, 2000)
      if (command !== '') out.push({ command, status: 'passed', exitCode: null })
      continue
    }
    if (typeof item !== 'object' || Array.isArray(item)) continue
    const command = cleanText(item.command ?? item.cmd, 2000)
    if (command === '') continue
    const raw = cleanText(item.status ?? item.result, 40).toLowerCase()
    const status = raw === 'fail' || raw === 'failed' || raw === 'error' ? 'failed' : raw === 'skipped' ? 'skipped' : 'passed'
    const exitCode = Number.isFinite(Number(item.exitCode)) ? Number(item.exitCode) : null
    out.push({ command, status, exitCode })
    if (out.length >= MAX_COMMANDS) break
  }
  return out
}

/** Exact §4 Task shape, deep-cloned so callers cannot mutate board state. */
function cloneTask(task) {
  return {
    id: task.id,
    title: task.title,
    detail: task.detail,
    lane: task.lane,
    order: task.order,
    priority: task.priority,
    tags: [...task.tags],
    acceptance: [...task.acceptance],
    verify: [...task.verify],
    files: [...task.files],
    deps: [...task.deps],
    projectId: task.projectId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    history: task.history.map((entry) => ({ ...entry })),
    agent: task.agent === null ? null : { ...task.agent },
    result: task.result === null
      ? null
      : {
        summary: task.result.summary,
        commandsRun: task.result.commandsRun.map((item) => ({ ...item })),
        evidence: [...task.result.evidence],
        files: [...task.result.files],
        verdict: task.result.verdict,
      },
    blocked: task.blocked === true,
  }
}

/* ------------------------------------------------------------------ JSON */

function tryParseJson(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    const repaired = trimmed.replace(/,\s*([}\]])/g, '$1')
    if (repaired === trimmed) return undefined
    try {
      return JSON.parse(repaired)
    } catch {
      return undefined
    }
  }
}

/** First balanced JSON object/array inside a string, respecting strings. */
function sliceBalanced(text) {
  const source = String(text ?? '')
  const start = source.search(/[{[]/)
  if (start === -1) return ''
  const open = source[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  return ''
}

/** Extract the first JSON value from an agent reply (fences and prose allowed). */
function extractJson(text) {
  const source = String(text ?? '')
  const candidates = []
  const fenced = /```[a-zA-Z]*\s*\r?\n?([\s\S]*?)```/g
  let match = fenced.exec(source)
  while (match !== null) {
    candidates.push(match[1])
    match = fenced.exec(source)
  }
  candidates.push(source)
  for (const candidate of candidates) {
    const direct = tryParseJson(candidate)
    if (direct !== undefined) return { value: direct }
    const sliced = sliceBalanced(candidate)
    if (sliced !== '') {
      const parsed = tryParseJson(sliced)
      if (parsed !== undefined) return { value: parsed }
    }
  }
  return { value: undefined }
}

function pickTaskArray(value) {
  if (Array.isArray(value)) return value
  if (value === null || typeof value !== 'object') return null
  for (const key of ['tasks', 'task', 'cards', 'items', 'plan', 'data']) {
    const candidate = value[key]
    if (Array.isArray(candidate)) return candidate
    if (candidate !== null && typeof candidate === 'object' && Array.isArray(candidate.tasks)) return candidate.tasks
  }
  return null
}

function normalizeSpec(item, index) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return null
  const title = cleanText(item.title ?? item.name ?? item.subject, 200)
  if (title === '') return null
  let dependsOn = item.dependsOn ?? item.deps ?? item.depends ?? []
  if (Array.isArray(dependsOn) === false) dependsOn = dependsOn === null || dependsOn === undefined ? [] : [dependsOn]
  return {
    index,
    title,
    detail: cleanText(item.detail ?? item.description ?? item.objective, 20000),
    acceptance: cleanList(item.acceptance ?? item.criteria ?? item.done, 40),
    verify: cleanList(item.verify ?? item.commands ?? item.verification, 40),
    files: cleanList(item.files ?? item.scope ?? item.paths, 200),
    tags: cleanList(item.tags ?? item.labels, 20),
    priority: coercePriority(item.priority),
    dependsOn: dependsOn.filter((ref) => ref !== null && ref !== undefined),
  }
}

function resolveDepIndex(ref, specs) {
  if (typeof ref === 'number' && Number.isFinite(ref)) {
    const index = Math.trunc(ref)
    return index >= 0 && index < specs.length ? index : null
  }
  if (typeof ref === 'string') {
    const trimmed = ref.trim()
    if (trimmed === '') return null
    if (/^\d+$/.test(trimmed)) {
      const index = Number(trimmed)
      return index >= 0 && index < specs.length ? index : null
    }
    const exact = specs.findIndex((spec) => spec.title === trimmed)
    if (exact !== -1) return exact
    const lower = trimmed.toLowerCase()
    const loose = specs.findIndex((spec) => spec.title.toLowerCase() === lower)
    return loose === -1 ? null : loose
  }
  return null
}

/** Kahn's algorithm over spec indexes; cycles fall back to declaration order. */
function orderSpecsByDependencies(specs) {
  const count = specs.length
  const incoming = new Array(count).fill(0)
  const edges = Array.from({ length: count }, () => [])
  for (let index = 0; index < count; index += 1) {
    const seen = new Set()
    for (const ref of specs[index].dependsOn) {
      const target = resolveDepIndex(ref, specs)
      if (target === null || target === index || seen.has(target)) continue
      seen.add(target)
      edges[target].push(index)
      incoming[index] += 1
    }
  }
  const ready = []
  for (let index = 0; index < count; index += 1) if (incoming[index] === 0) ready.push(index)
  ready.sort((a, b) => a - b)
  const order = []
  while (ready.length > 0) {
    const current = ready.shift()
    order.push(current)
    for (const next of edges[current]) {
      incoming[next] -= 1
      if (incoming[next] === 0) {
        ready.push(next)
        ready.sort((a, b) => a - b)
      }
    }
  }
  if (order.length !== count) {
    for (let index = 0; index < count; index += 1) if (order.includes(index) === false) order.push(index)
  }
  return order
}

function parseTasksReply(raw, maxTasks) {
  const textValue = typeof raw === 'string' ? raw : ''
  if (textValue.trim() === '') {
    return { specs: [], error: { code: 'empty-reply', message: 'the agent returned no text' } }
  }
  const extracted = extractJson(textValue)
  if (extracted.value === undefined) {
    return { specs: [], error: { code: 'parse-failed', message: 'the agent reply contains no JSON object' } }
  }
  const list = pickTaskArray(extracted.value)
  if (list === null) {
    return { specs: [], error: { code: 'parse-failed', message: 'the agent JSON has no task array' } }
  }
  const specs = []
  for (let index = 0; index < list.length; index += 1) {
    const spec = normalizeSpec(list[index], index)
    if (spec !== null) specs.push(spec)
    if (specs.length >= maxTasks) break
  }
  if (specs.length === 0) {
    return { specs: [], error: { code: 'no-tasks', message: 'every parsed card was missing a title' } }
  }
  return { specs, error: null }
}

/* ------------------------------------------------------------- agent I/O */

function textOfContent(content) {
  if (Array.isArray(content) === false) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('')
}

/** Last assistant text of an agent, from derived messages or its own events. */
function lastAssistantText(agent) {
  const session = agent?.session
  if (session === null || session === undefined) return ''
  if (typeof session.deriveMessages === 'function') {
    try {
      const messages = session.deriveMessages()
      if (Array.isArray(messages)) {
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index]
          if (message?.role !== 'assistant') continue
          const value = textOfContent(message.content)
          if (value !== '') return value
        }
      }
    } catch {
      /* fall through to events */
    }
  }
  if (typeof session.ownEvents === 'function') {
    try {
      const events = session.ownEvents()
      if (Array.isArray(events)) {
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const event = events[index]
          if (event?.type !== 'assistant/message') continue
          const value = textOfContent(event.data?.message?.content)
          if (value !== '') return value
        }
      }
    } catch {
      /* ignore */
    }
  }
  return ''
}

async function waitForIdle(agent, timeoutMs) {
  if (agent === null || agent === undefined) return
  if (typeof agent.whenIdle === 'function') {
    await withTimeout(Promise.resolve(agent.whenIdle()), timeoutMs, 'agent turn')
    return
  }
  const deadline = nowMs() + timeoutMs
  while (nowMs() < deadline) {
    if (agent.status !== 'running') return
    await sleep(120)
  }
  throw fail('timeout', 'the agent did not settle in time')
}

function messageSource() {
  return { kind: 'flutter-workbench' }
}

function buildDecomposePrompt({ prompt, maxTasks, projectId }) {
  const lines = [
    'You are the planning assistant of a Flutter developer workbench.',
    'Turn the idea below into a small, executable kanban plan.',
    '',
    'Idea:',
    '"""',
    prompt,
    '"""',
    '',
  ]
  if (projectId !== null && projectId !== undefined) lines.push(`Project id: ${projectId}`, '')
  lines.push(
    `Return at most ${maxTasks} cards (fewer is better). Each card must be an independently verifiable unit of work.`,
    '',
    'Rules:',
    '- "title": short imperative title, at most 80 characters.',
    '- "detail": what to build, why, and the constraints a worker must respect.',
    '- "acceptance": array of concrete, checkable acceptance criteria (one per string).',
    '- "verify": array of shell commands a worker must run to prove the card, for example "flutter analyze" or "flutter test test/widget_test.dart".',
    '- "files": array of project-relative paths the card will probably touch.',
    '- "priority": one of "low", "normal", "high", "urgent".',
    '- "dependsOn": array of 0-based indexes of OTHER cards in your own array that must be finished first.',
    '',
    'Answer with STRICT JSON only. No prose, no markdown fences, no comments:',
    '{"tasks":[{"title":"...","detail":"...","acceptance":["..."],"verify":["..."],"files":["..."],"priority":"normal","dependsOn":[]}]}',
  )
  return lines.join('\n')
}

function buildWorkerPrompt(task, projectPath) {
  const lines = [
    'You own one card of the DSH Flutter workbench kanban board.',
    '',
    `Card id: ${task.id}`,
    `Title: ${task.title}`,
    `Priority: ${task.priority}`,
  ]
  if (task.tags.length > 0) lines.push(`Tags: ${task.tags.join(', ')}`)
  lines.push('', `Project: ${projectPath}`, '')
  if (task.detail !== '') lines.push('Objective:', task.detail, '')
  if (task.files.length > 0) {
    lines.push('Likely files (stay inside the project; touch only what the card needs):')
    for (const file of task.files) lines.push(`- ${file}`)
    lines.push('')
  }
  if (task.acceptance.length > 0) {
    lines.push('Acceptance criteria — every one must hold:')
    for (let index = 0; index < task.acceptance.length; index += 1) lines.push(`${index + 1}. ${task.acceptance[index]}`)
    lines.push('')
  }
  if (task.verify.length > 0) {
    lines.push('Verify commands — actually run them and keep the real output:')
    for (const command of task.verify) lines.push(`- ${command}`)
    lines.push('')
  }
  if (task.deps.length > 0) lines.push(`Already-finished dependency cards: ${task.deps.join(', ')}`, '')
  lines.push(
    'Rules:',
    '- Read the code before editing it; keep the change scoped to this card.',
    '- Use the flutter_* workbench tools to run the app, read logs, run analyzer and tests.',
    '- Never mark yourself done when a verify command fails or a criterion is unmet.',
    '',
    `When you finish — success OR failure — call the tool \`${REPORT_TOOL}\` with exactly:`,
    '{',
    `  "id": "${task.id}",`,
    '  "status": "done" | "failed" | "blocked",',
    '  "summary": "one paragraph: what you changed and what you verified",',
    '  "commandsRun": [{ "command": "...", "status": "passed" | "failed", "exitCode": 0 }],',
    '  "evidence": ["file:line facts or short command output excerpts"],',
    '  "files": ["relative/paths/you/changed"],',
    '  "verdict": "pass" | "fail",',
    '  "note": "anything the human should know before accepting"',
    '}',
    '',
    'A human accepts the card afterwards, so be honest: verdict=pass only when everything above passed.',
  )
  return lines.join('\n')
}

/* ---------------------------------------------------------------- factory */

export function createBoard({ store, bus, ctx, logs, settings, logger } = {}) {
  const handles = new Map()
  let persistTimer = null
  let disposed = false

  function note(level, textValue) {
    try {
      logs?.append?.({ source: 'plugin', level, text: textValue })
    } catch {
      /* logging must never break the board */
    }
    if (level === 'warn' || level === 'error') logger?.warn?.(textValue)
  }

  function safeService(name) {
    try {
      return ctx?.get?.(name) ?? null
    } catch {
      return null
    }
  }

  function settingsValues() {
    try {
      return settings?.get?.() ?? {}
    } catch {
      return {}
    }
  }

  /* ------------------------------------------------------------ loading */

  function quarantine(value, reason) {
    note('warn', `board: stored payload quarantined (${reason})`)
    if (store === null || typeof store.set !== 'function') return
    try {
      void Promise.resolve(store.set(QUARANTINE_KEY, { at: nowMs(), reason, raw: value })).catch(() => {})
    } catch {
      /* best effort */
    }
  }

  function readStored() {
    let value = null
    try {
      value = store?.get?.(BOARD_KEY, null) ?? null
    } catch {
      value = null
    }
    if (value === null || value === undefined) return { tasks: [], archived: [] }
    const valid = typeof value === 'object' && Array.isArray(value) === false && Array.isArray(value.tasks)
    if (valid === false) {
      quarantine(value, 'expected { version, tasks[] }')
      return { tasks: [], archived: [] }
    }
    return { tasks: value.tasks, archived: Array.isArray(value.archived) ? value.archived : [] }
  }

  function repairTask(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const id = cleanText(raw.id, 200)
    const title = cleanText(raw.title, 200)
    if (id === '' || title === '') return null
    const createdAt = Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : nowMs()
    const updatedAt = Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : createdAt
    const agentRaw = raw.agent
    let agent = null
    if (agentRaw !== null && typeof agentRaw === 'object' && Array.isArray(agentRaw) === false) {
      agent = {
        sessionId: cleanText(agentRaw.sessionId, 200) === '' ? null : cleanText(agentRaw.sessionId, 200),
        status: coerceAgentStatus(agentRaw.status),
        startedAt: Number.isFinite(Number(agentRaw.startedAt)) ? Number(agentRaw.startedAt) : null,
        finishedAt: Number.isFinite(Number(agentRaw.finishedAt)) ? Number(agentRaw.finishedAt) : null,
        lastReport: cleanText(agentRaw.lastReport, 20000) === '' ? null : cleanText(agentRaw.lastReport, 20000),
      }
    }
    const resultRaw = raw.result
    let result = null
    if (resultRaw !== null && typeof resultRaw === 'object' && Array.isArray(resultRaw) === false) {
      const verdictRaw = cleanText(resultRaw.verdict, 20).toLowerCase()
      result = {
        summary: cleanText(resultRaw.summary, 20000),
        commandsRun: normalizeCommands(resultRaw.commandsRun),
        evidence: cleanList(resultRaw.evidence, 100),
        files: cleanList(resultRaw.files, 200),
        verdict: verdictRaw === 'pass' ? 'pass' : verdictRaw === 'fail' ? 'fail' : null,
      }
    }
    const history = []
    for (const entry of Array.isArray(raw.history) ? raw.history : []) {
      if (entry === null || typeof entry !== 'object') continue
      history.push({
        at: Number.isFinite(Number(entry.at)) ? Number(entry.at) : createdAt,
        from: entry.from === null || entry.from === undefined ? null : coerceLane(entry.from, 'backlog'),
        to: coerceLane(entry.to, 'backlog'),
        note: cleanText(entry.note, 2000) === '' ? null : cleanText(entry.note, 2000),
        by: cleanText(entry.by, 40) === '' ? 'user' : cleanText(entry.by, 40),
      })
    }
    return {
      id,
      title,
      detail: cleanText(raw.detail, 20000),
      lane: coerceLane(raw.lane),
      order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : 0,
      priority: coercePriority(raw.priority),
      tags: cleanList(raw.tags, 40),
      acceptance: cleanList(raw.acceptance, 40),
      verify: cleanList(raw.verify, 40),
      files: cleanList(raw.files, 200),
      deps: cleanList(raw.deps, 50),
      projectId: cleanText(raw.projectId, 200) === '' ? null : cleanText(raw.projectId, 200),
      createdAt,
      updatedAt,
      history: history.slice(-MAX_HISTORY),
      agent,
      result,
      blocked: raw.blocked === true,
    }
  }

  const loaded = readStored()
  const state = { tasks: [], archived: [] }
  const seenIds = new Set()
  let repaired = 0
  for (const raw of loaded.tasks) {
    const task = repairTask(raw)
    if (task === null || seenIds.has(task.id)) {
      repaired += 1
      continue
    }
    seenIds.add(task.id)
    state.tasks.push(task)
  }
  for (const raw of loaded.archived) {
    const task = repairTask(raw)
    if (task === null || seenIds.has(task.id)) continue
    seenIds.add(task.id)
    state.archived.push(task)
  }
  for (const lane of LANE_IDS) renumber(lane)
  if (repaired > 0) note('warn', `board: dropped ${repaired} invalid stored card(s)`)

  /* ------------------------------------------------------------ ordering */

  function laneTasks(lane) {
    return state.tasks
      .filter((task) => task.lane === lane)
      .sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })
  }

  function renumber(lane) {
    laneTasks(lane).forEach((task, index) => {
      task.order = index
    })
  }

  function appendToLane(task) {
    const peers = laneTasks(task.lane).filter((item) => item.id !== task.id)
    peers.push(task)
    peers.forEach((item, index) => {
      item.order = index
    })
  }

  function insertInto(task, index) {
    const peers = laneTasks(task.lane).filter((item) => item.id !== task.id)
    const at = index === undefined || index === null || Number.isFinite(Number(index)) === false
      ? peers.length
      : clamp(Number(index), 0, peers.length)
    peers.splice(at, 0, task)
    peers.forEach((item, position) => {
      item.order = position
    })
  }

  function findTask(id) {
    const key = cleanText(id, 200)
    if (key === '') return null
    return state.tasks.find((task) => task.id === key) ?? null
  }

  function requireTask(id) {
    const task = findTask(id)
    if (task === null) throw fail('not-found', `unknown card ${id}`)
    return task
  }

  /* --------------------------------------------------------- persistence */

  function serialize() {
    return {
      version: BOARD_VERSION,
      tasks: state.tasks.map(cloneTask),
      archived: state.archived.map(cloneTask),
    }
  }

  async function persistNow() {
    if (store === null || typeof store.set !== 'function') return
    try {
      await store.set(BOARD_KEY, serialize())
    } catch (error) {
      note('warn', `board: cannot persist: ${normalizeError(error).message}`)
    }
  }

  function schedulePersist() {
    if (disposed === true) return
    if (persistTimer !== null) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      void persistNow()
    }, PERSIST_DEBOUNCE_MS)
    if (typeof persistTimer.unref === 'function') persistTimer.unref()
  }

  function snapshot() {
    const counts = {}
    for (const lane of LANE_IDS) counts[lane] = 0
    const tasks = [...state.tasks]
      .sort((a, b) => {
        const laneDiff = (LANE_ORDER.get(a.lane) ?? 99) - (LANE_ORDER.get(b.lane) ?? 99)
        if (laneDiff !== 0) return laneDiff
        if (a.order !== b.order) return a.order - b.order
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })
      .map(cloneTask)
    for (const task of tasks) counts[task.lane] = (counts[task.lane] ?? 0) + 1
    return { lanes: LANES.map((lane) => ({ ...lane })), tasks, counts }
  }

  function emit() {
    try {
      bus?.emit?.('board:change', snapshot())
    } catch (error) {
      note('warn', `board: listener failed: ${normalizeError(error).message}`)
    }
  }

  function touch() {
    emit()
    schedulePersist()
  }

  /* --------------------------------------------------------- task shaping */

  function createTask(input, { by = 'user', noteText = null } = {}) {
    const title = cleanText(input?.title, 200)
    if (title === '') throw fail('invalid-input', 'task title is required')
    const lane = coerceLane(input?.lane)
    const at = nowMs()
    const providedId = cleanText(input?.id, 200)
    const task = {
      id: providedId !== '' && seenIds.has(providedId) === false ? providedId : uid('task'),
      title,
      detail: cleanText(input?.detail, 20000),
      lane,
      order: 0,
      priority: coercePriority(input?.priority),
      tags: cleanList(input?.tags, 40),
      acceptance: cleanList(input?.acceptance, 40),
      verify: cleanList(input?.verify, 40),
      files: cleanList(input?.files, 200),
      deps: cleanList(input?.deps, 50),
      projectId: cleanText(input?.projectId, 200) === '' ? null : cleanText(input?.projectId, 200),
      createdAt: at,
      updatedAt: at,
      history: [{ at, from: null, to: lane, note: noteText === null ? null : cleanText(noteText, 2000), by }],
      agent: null,
      result: null,
      blocked: input?.blocked === true,
    }
    seenIds.add(task.id)
    state.tasks.push(task)
    // Append at the tail of the lane: sorting first would place the new card by
    // an order value that is still zero and could land before an existing card.
    appendToLane(task)
    return task
  }

  function transition(task, lane, { at = nowMs(), by = 'user', noteText = null } = {}) {
    const from = task.lane
    if (from !== lane) {
      const peers = laneTasks(from).filter((item) => item.id !== task.id)
      peers.forEach((item, index) => {
        item.order = index
      })
      task.lane = lane
      appendToLane(task)
      task.history.push({
        at,
        from,
        to: lane,
        note: noteText === null ? null : cleanText(noteText, 2000),
        by,
      })
      if (task.history.length > MAX_HISTORY) task.history = task.history.slice(-MAX_HISTORY)
    }
    task.updatedAt = at
    return task
  }

  /* ------------------------------------------------------------- project */

  function projectPathOf(value) {
    if (value === null || value === undefined || typeof value === 'string') return null
    return typeof value.path === 'string' && value.path !== '' ? value.path : null
  }

  function resolveProjectPath({ projectId, cwd } = {}) {
    if (typeof cwd === 'string' && cwd.trim() !== '') return cwd.trim()
    const projects = safeService('projects')
    const wanted = cleanText(projectId, 200) === '' ? null : cleanText(projectId, 200)
    try {
      if (projects !== null) {
        if (wanted !== null && typeof projects.get === 'function') {
          const path = projectPathOf(projects.get(wanted))
          if (path !== null) return path
        }
        if (typeof projects.active === 'function') {
          const active = projects.active()
          const direct = projectPathOf(active)
          if (direct !== null) return direct
          const id = typeof active === 'string' ? active : active?.id
          if (typeof id === 'string' && typeof projects.get === 'function') {
            const viaId = projectPathOf(projects.get(id))
            if (viaId !== null) return viaId
          }
        }
        if (typeof projects.list === 'function') {
          const list = projects.list()
          if (Array.isArray(list) && list.length > 0) {
            const hit = wanted === null ? list[0] : list.find((item) => item?.id === wanted)
            const path = projectPathOf(hit)
            if (path !== null) return path
          }
        }
      }
      const run = safeService('runner')?.latestRun?.()
      if (run?.projectPath !== undefined && run?.projectPath !== null) return String(run.projectPath)
    } catch {
      /* fall through */
    }
    return process.cwd()
  }

  /* ------------------------------------------------------------------ API */

  function addTask(input) {
    const task = createTask(input ?? {}, {
      by: cleanText(input?.by, 40) === '' ? 'user' : cleanText(input?.by, 40),
      noteText: input?.note === undefined ? 'created' : input.note,
    })
    touch()
    note('info', `board: card created ${task.id} · ${task.title}`)
    return cloneTask(task)
  }

  function updateTask(input) {
    const task = requireTask(input?.id)
    const patch = input?.patch ?? input?.fields ?? {}
    if (patch === null || typeof patch !== 'object') throw fail('invalid-input', 'patch must be an object')
    if (patch.lane !== undefined && coerceLane(patch.lane, task.lane) !== task.lane) {
      return moveTask({
        id: task.id,
        lane: patch.lane,
        index: patch.index,
        force: patch.force,
        note: input?.note,
        by: patch.by ?? input?.by,
      })
    }
    if (patch.title !== undefined) {
      const title = cleanText(patch.title, 200)
      if (title === '') throw fail('invalid-input', 'title cannot be empty')
      task.title = title
    }
    if (patch.detail !== undefined) task.detail = cleanText(patch.detail, 20000)
    if (patch.priority !== undefined) task.priority = coercePriority(patch.priority)
    if (patch.tags !== undefined) task.tags = cleanList(patch.tags, 40)
    if (patch.acceptance !== undefined) task.acceptance = cleanList(patch.acceptance, 40)
    if (patch.verify !== undefined) task.verify = cleanList(patch.verify, 40)
    if (patch.files !== undefined) task.files = cleanList(patch.files, 200)
    if (patch.deps !== undefined) task.deps = cleanList(patch.deps, 50)
    if (patch.projectId !== undefined) task.projectId = cleanText(patch.projectId, 200) === '' ? null : cleanText(patch.projectId, 200)
    if (patch.blocked !== undefined) task.blocked = patch.blocked === true
    task.updatedAt = nowMs()
    touch()
    return cloneTask(task)
  }

  function moveTask(input) {
    const task = requireTask(input?.id)
    const lane = cleanText(input?.lane, 40)
    if (LANE_IDS.includes(lane) === false) throw fail('invalid-lane', `unknown lane ${input?.lane}`)
    const by = cleanText(input?.by, 40) === '' ? 'user' : cleanText(input?.by, 40)
    const at = nowMs()
    if (lane === 'done' && task.result?.verdict !== 'pass' && input?.force !== true) {
      throw fail('verdict-required', 'a card can only enter done with verdict "pass" (or force: true)')
    }
    if (task.lane === lane) {
      if (input?.index !== undefined) {
        insertInto(task, input.index)
        task.updatedAt = at
        touch()
      }
      return cloneTask(task)
    }
    transition(task, lane, { at, by, noteText: input?.note ?? null })
    if (input?.index !== undefined) insertInto(task, input.index)
    else appendToLane(task)
    touch()
    return cloneTask(task)
  }

  function removeTask(input) {
    const key = cleanText(input?.id, 200)
    const index = state.tasks.findIndex((task) => task.id === key)
    if (index === -1) return { removed: false, board: snapshot() }
    const [task] = state.tasks.splice(index, 1)
    seenIds.delete(task.id)
    renumber(task.lane)
    touch()
    note('info', `board: card removed ${task.id}`)
    return { removed: true, board: snapshot() }
  }

  function archiveDone() {
    const done = state.tasks.filter((task) => task.lane === 'done')
    if (done.length === 0) return { archived: 0, board: snapshot() }
    for (const task of done) {
      const index = state.tasks.indexOf(task)
      if (index !== -1) state.tasks.splice(index, 1)
      state.archived.push(task)
    }
    if (state.archived.length > MAX_ARCHIVED) state.archived = state.archived.slice(-MAX_ARCHIVED)
    renumber('done')
    touch()
    note('info', `board: archived ${done.length} completed card(s)`)
    return { archived: done.length, board: snapshot() }
  }

  function createTasksFromSpecs(specs, { projectId = null, by = 'ai' } = {}) {
    if (specs.length === 0) return []
    const order = orderSpecsByDependencies(specs)
    const createdIds = new Map()
    const created = []
    for (const sourceIndex of order) {
      const spec = specs[sourceIndex]
      const deps = []
      for (const ref of spec.dependsOn) {
        const target = resolveDepIndex(ref, specs)
        if (target === null || target === sourceIndex) continue
        const id = createdIds.get(target)
        if (id !== undefined && deps.includes(id) === false) deps.push(id)
      }
      const task = createTask({
        title: spec.title,
        detail: spec.detail,
        acceptance: spec.acceptance,
        verify: spec.verify,
        files: spec.files,
        priority: spec.priority,
        tags: spec.tags,
        deps,
        projectId: spec.projectId ?? projectId,
      }, { by, noteText: 'created by AI decomposition' })
      createdIds.set(sourceIndex, task.id)
      created.push(task)
    }
    return created
  }

  async function decompose(input) {
    const prompt = cleanText(input?.prompt, 20000)
    if (prompt === '') {
      return { tasks: [], raw: '', error: { code: 'invalid-input', message: 'prompt is required' } }
    }
    const agents = safeService('agents')
    if (agents === null || typeof agents.create !== 'function') {
      return { tasks: [], raw: '', error: { code: 'agents-unavailable', message: 'ctx.get("agents") is unavailable' } }
    }
    const maxTasks = clamp(input?.maxTasks ?? DEFAULT_MAX_TASKS, 1, MAX_TASKS_CAP)
    const values = settingsValues()
    const provider = cleanText(input?.provider, 120) === '' ? cleanText(values.defaultProvider, 120) : cleanText(input.provider, 120)
    const model = cleanText(input?.model, 160) === '' ? cleanText(values.defaultModel, 160) : cleanText(input.model, 160)
    const cwd = resolveProjectPath({ projectId: input?.projectId, cwd: input?.cwd })
    const timeoutMs = clamp(input?.timeoutMs ?? DEFAULT_DECOMPOSE_TIMEOUT_MS, 5000, 600000)
    const sessionId = uid('fwb-plan')
    const agentOptions = {}
    if (provider !== '') agentOptions.provider = provider
    if (model !== '') agentOptions.model = model
    let handle = null
    let raw = ''
    try {
      handle = await agents.create({ sessionId, meta: { cwd }, agentOptions })
      if (handle?.agent === undefined || handle.agent === null) throw fail('agents-unavailable', 'agents.create returned no agent handle')
      await handle.agent.followup({
        content: [{ type: 'text', text: buildDecomposePrompt({ prompt, maxTasks, projectId: input?.projectId ?? null }) }],
        source: messageSource(),
      })
      await waitForIdle(handle.agent, timeoutMs)
      raw = lastAssistantText(handle.agent)
    } catch (error) {
      const detail = normalizeError(error)
      note('warn', `board: decompose failed: ${detail.message}`)
      return { tasks: [], raw, error: { code: detail.code, message: detail.message } }
    } finally {
      if (handle !== null && typeof handle.dispose === 'function') {
        try {
          await handle.dispose()
        } catch {
          /* ephemeral planning session */
        }
      }
    }
    const parsed = parseTasksReply(raw, maxTasks)
    if (parsed.error !== null) {
      note('warn', `board: decompose returned no usable cards (${parsed.error.code})`)
      return { tasks: [], raw, error: parsed.error }
    }
    const created = createTasksFromSpecs(parsed.specs, { projectId: input?.projectId ?? null, by: 'ai' })
    touch()
    note('info', `board: AI decomposed "${prompt.slice(0, 60)}" into ${created.length} card(s)`)
    return { tasks: created.map(cloneTask), raw }
  }

  async function dispatch(input) {
    const task = requireTask(input?.id)
    if (task.agent !== null && task.agent.sessionId !== null && task.agent.status === 'working') {
      throw fail('already-running', `card ${task.id} already has a worker session`)
    }
    const agents = safeService('agents')
    if (agents === null || typeof agents.create !== 'function') {
      throw fail('agents-unavailable', 'ctx.get("agents") is unavailable')
    }
    const values = settingsValues()
    const provider = cleanText(input?.provider, 120) === '' ? cleanText(values.defaultProvider, 120) : cleanText(input.provider, 120)
    const model = cleanText(input?.model, 160) === '' ? cleanText(values.defaultModel, 160) : cleanText(input.model, 160)
    const cwd = resolveProjectPath({ projectId: task.projectId, cwd: input?.cwd })
    const readonly = input?.readonly === true || task.tags.includes('read-only')
    const sessionId = uid('fwb-card')
    const agentOptions = {}
    if (provider !== '') agentOptions.provider = provider
    if (model !== '') agentOptions.model = model
    const setup = readonly === false
      ? undefined
      : (agentCtx) => {
        try {
          agentCtx?.tools?.restrict?.({ deny: [...READONLY_DENY] })
        } catch {
          /* restriction is best effort */
        }
      }
    let handle = null
    try {
      handle = await agents.create({ sessionId, meta: { cwd }, agentOptions, setup })
      if (handle?.agent === undefined || handle.agent === null) throw fail('agents-unavailable', 'agents.create returned no agent handle')
      await handle.agent.followup({
        content: [{ type: 'text', text: buildWorkerPrompt(task, cwd) }],
        source: messageSource(),
      })
    } catch (error) {
      if (handle !== null && typeof handle.dispose === 'function') {
        try {
          await handle.dispose()
        } catch {
          /* ignore */
        }
      }
      const detail = normalizeError(error)
      note('warn', `board: dispatch failed for ${task.id}: ${detail.message}`)
      throw fail('dispatch-failed', `cannot start the worker session: ${detail.message}`)
    }
    handles.set(sessionId, handle)
    const at = nowMs()
    task.agent = {
      sessionId,
      status: 'working',
      startedAt: at,
      finishedAt: null,
      lastReport: null,
    }
    task.blocked = false
    transition(task, 'running', {
      at,
      by: cleanText(input?.by, 40) === '' ? 'user' : cleanText(input.by, 40),
      noteText: `dispatched to ${provider === '' ? 'default' : provider}/${model === '' ? 'default' : model}`,
    })
    touch()
    note('info', `board: card ${task.id} dispatched to session ${sessionId}`)
    return { sessionId, task: cloneTask(task) }
  }

  function ensureAgent(task) {
    if (task.agent === null) task.agent = newAgent()
    return task.agent
  }

  function normalizeReportStatus(value) {
    const key = cleanText(value, 40).toLowerCase()
    if (key === 'done' || key === 'pass' || key === 'passed' || key === 'completed' || key === 'complete') return 'done'
    if (key === 'failed' || key === 'fail' || key === 'error') return 'failed'
    if (key === 'blocked' || key === 'stuck') return 'blocked'
    return 'working'
  }

  function report(input) {
    const task = requireTask(input?.id)
    const at = nowMs()
    const status = normalizeReportStatus(input?.status)
    const verdictRaw = cleanText(input?.verdict, 20).toLowerCase()
    let verdict = verdictRaw === 'pass' || verdictRaw === 'passed' ? 'pass' : verdictRaw === 'fail' || verdictRaw === 'failed' ? 'fail' : null
    if (verdict === null) {
      if (status === 'done') verdict = 'pass'
      else if (status === 'failed' || status === 'blocked') verdict = 'fail'
    }
    const result = {
      summary: cleanText(input?.summary, 20000),
      commandsRun: normalizeCommands(input?.commandsRun),
      evidence: cleanList(input?.evidence, 100),
      files: cleanList(input?.files, 200),
      verdict,
    }
    task.result = result
    const agent = ensureAgent(task)
    agent.lastReport = result.summary === '' ? cleanText(input?.note, 20000) : result.summary
    agent.finishedAt = at
    const passed = verdict === 'pass' && status !== 'failed' && status !== 'blocked'
    if (status === 'working') {
      agent.status = 'working'
      task.updatedAt = at
      touch()
      return cloneTask(task)
    }
    agent.status = passed ? 'done' : status === 'blocked' ? 'blocked' : 'failed'
    const fallbackNote = passed
      ? 'worker reported pass'
      : cleanText(input?.note, 2000) !== ''
        ? cleanText(input.note, 2000)
        : result.summary !== '' ? result.summary : 'worker reported failure'
    const target = passed ? 'review' : 'ready'
    if (task.lane === target) {
      task.updatedAt = at
    } else {
      transition(task, target, { at, by: cleanText(input?.by, 40) === '' ? 'agent' : cleanText(input.by, 40), noteText: fallbackNote })
    }
    touch()
    note(passed ? 'info' : 'warn', `board: card ${task.id} reported ${verdict ?? 'unknown'} → ${target}`)
    return cloneTask(task)
  }

  function querySessionState(sessionId) {
    for (const key of ['sessionQuery', 'sessions']) {
      const service = safeService(key)
      if (service === null || typeof service !== 'object') continue
      try {
        const value = typeof service.get === 'function' ? service.get(sessionId) : null
        if (value === null || value === undefined) continue
        const status = typeof value === 'string' ? value : typeof value.status === 'string' ? value.status : null
        if (status === 'running') return 'working'
        if (status === 'failed' || status === 'error') return 'failed'
        if (status === 'idle' || status === 'completed' || status === 'stopped') return 'idle'
      } catch {
        /* keep looking */
      }
    }
    return null
  }

  function syncAgent(id) {
    const task = findTask(id)
    if (task === null) return null
    const agent = task.agent
    if (agent === null || agent.sessionId === null || agent.sessionId === undefined) return cloneTask(task)
    let live = null
    try {
      live = safeService('agents')?.get?.(agent.sessionId) ?? null
    } catch {
      live = null
    }
    let status = null
    if (live !== null && live !== undefined) {
      const raw = cleanText(live.status, 40)
      status = raw === 'running' ? 'working' : raw === 'failed' ? 'failed' : 'idle'
    } else {
      status = querySessionState(agent.sessionId)
      if (status === null) status = agent.status === 'done' ? 'done' : 'blocked'
    }
    if (status !== agent.status) {
      agent.status = status
      if (status === 'working' && agent.startedAt === null) agent.startedAt = nowMs()
      task.updatedAt = nowMs()
      touch()
    }
    return cloneTask(task)
  }

  async function cancelAgent(input) {
    const task = requireTask(input?.id)
    const agent = task.agent
    if (agent === null || agent.sessionId === null || agent.sessionId === undefined) return cloneTask(task)
    const sessionId = agent.sessionId
    try {
      const live = safeService('agents')?.get?.(sessionId) ?? null
      if (live !== null && typeof live.cancel === 'function') live.cancel({ kind: 'user' }, { keepInbox: true })
    } catch {
      /* the session may already be gone */
    }
    const handle = handles.get(sessionId)
    if (handle !== undefined) {
      handles.delete(sessionId)
      if (typeof handle.dispose === 'function') {
        try {
          await handle.dispose()
        } catch {
          /* ignore */
        }
      }
    }
    const at = nowMs()
    agent.status = 'idle'
    agent.finishedAt = at
    agent.lastReport = 'cancelled by the user'
    if (task.lane === 'running') {
      transition(task, 'ready', { at, by: cleanText(input?.by, 40) === '' ? 'user' : cleanText(input.by, 40), noteText: 'worker cancelled' })
    } else {
      task.updatedAt = at
    }
    touch()
    note('warn', `board: card ${task.id} worker cancelled`)
    return cloneTask(task)
  }

  function onChange(callback) {
    if (typeof callback !== 'function' || bus === null || typeof bus?.on !== 'function') return () => {}
    return bus.on('board:change', callback)
  }

  async function flush() {
    if (persistTimer !== null) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    await persistNow()
  }

  async function dispose() {
    disposed = true
    if (persistTimer !== null) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    await persistNow()
    handles.clear()
  }

  return {
    snapshot,
    addTask,
    updateTask,
    moveTask,
    removeTask,
    deleteTask: removeTask,
    archiveDone,
    decompose,
    dispatch,
    report,
    syncAgent,
    cancelAgent,
    onChange,
    flush,
    dispose,
  }
}