/**
 * The 10 `taskboard_*` agent tools, ported from `dsh-taskboard` so the Flutter
 * workbench is the only plugin the user needs. Names, parameters and gates match
 * the upstream plugin: an agent can never move a task to `done`, a task held by
 * one session cannot be taken over, and every write is version-checked.
 */
import { normalizeError } from './util.js'

const text = (value) => [{ type: 'text', text: String(value) }]

const looseSchema = (properties = {}) => ({
  type: 'object',
  properties: { ok: { type: 'boolean' }, ...properties },
  additionalProperties: true,
})

/** The caller of a tool: agents by default, the panel passes `actorKind: 'user'`. */
function callerOf(exec) {
  const sessionId = typeof exec?.sessionId === 'string' && exec.sessionId !== '' ? exec.sessionId : null
  const kind = exec?.actorKind === 'user' ? 'user' : 'agent'
  return { sessionId, kind, actor: sessionId ?? kind }
}

function requireBoard(services) {
  const board = services?.taskboard
  if (board === undefined || board === null) {
    throw Object.assign(new Error('taskboard 服务不可用（插件子系统未启动）'), { code: 'unavailable' })
  }
  return board
}

function formatTaskLine(task) {
  const badge = task.claimedBy === null ? '' : ` · 由 ${task.claimedBy} 持有`
  const checklist = task.checklistTotal > 0 ? ` · 清单 ${task.checklistDone}/${task.checklistTotal}` : ''
  const blocked = task.blocked === true ? ' · 阻塞' : ''
  return `[${task.status}/${task.urgency}] ${task.title} (${task.id}) v${task.version}${badge}${checklist}${blocked}`
}

export function createTaskboardToolDefinitions({ services } = {}) {
  const definitions = []
  const add = (definition) => definitions.push(definition)

  add({
    name: 'taskboard_list',
    description:
      '列出任务看板上的任务。可按项目(workspaceId)、状态或紧急度筛选，返回精简摘要（id、标题、状态、紧急度、版本、持有者）。开工前先看这里，找本项目中可认领的待办任务。',
    parameters: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: '按项目筛选：项目路径或 id' },
        status: { type: 'string', description: '按状态筛选（backlog/todo/in_progress/in_review/done/canceled/archived）' },
        urgency: { type: 'string', description: '按紧急度筛选（urgent/normal/relaxed）' },
        includeTrashed: { type: 'boolean', description: '包含已删除任务（默认 false）' },
      },
      additionalProperties: false,
    },
    output: {
      schema: looseSchema({ tasks: { type: 'array', items: { type: 'object' } } }),
      render: (args, value) => {
        const tasks = value?.tasks ?? []
        const head = `任务 ${tasks.length} 条（台账 rev ${value?.revision ?? '?'}）`
        if (tasks.length === 0) return text(`${head}：无匹配任务。`)
        return text([head, ...tasks.map(formatTaskLine)].join('\n'))
      },
    },
    async execute(args) {
      const board = requireBoard(services)
      return { ok: true, ...board.list(args ?? {}) }
    },
  })

  add({
    name: 'taskboard_get',
    description: '读取单个任务的全部内容：描述、prompt、项目、紧急度、状态、评论、执行记录、版本。认领或开始干活前必须先读它（含评论）。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '任务 id' } },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: looseSchema({ task: { type: 'object' } }),
      render: (args, value) => {
        const task = value?.task
        if (task === undefined || task === null) return text('任务不存在。')
        const lines = [
          `${task.title} (${task.id}) v${task.version}`,
          `状态 ${task.status} · 紧急度 ${task.urgency} · 项目 ${task.workspaceId}`,
        ]
        if (task.description !== '') lines.push('', `描述：${task.description}`)
        if (task.prompt !== '') lines.push('', `执行 prompt：${task.prompt}`)
        const deps = task.dependencies ?? []
        if (deps.length > 0) lines.push('', `依赖：${deps.map((dep) => `${dep.title ?? dep.id}[${dep.status ?? '?'}]`).join(', ')}`)
        const checklist = task.checklist ?? []
        if (checklist.length > 0) {
          lines.push('', '验收清单：')
          for (const item of checklist) lines.push(`${item.checked === true ? '☑' : '☐'} ${item.text}${item.note === undefined ? '' : `（证据: ${item.note}）`} id=${item.id}`)
        }
        const comments = task.comments ?? []
        if (comments.length > 0) {
          lines.push('', `评论 ${comments.length} 条：`)
          for (const comment of comments.slice(-5)) lines.push(`- ${comment.by}: ${String(comment.body).slice(0, 200)}`)
        }
        const runs = task.executions ?? []
        if (runs.length > 0) lines.push('', `执行记录 ${runs.length} 条，最后一条：${runs[runs.length - 1].outcome}`)
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      const board = requireBoard(services)
      return { ok: true, ...board.get(args?.id) }
    },
  })

  add({
    name: 'taskboard_create',
    description:
      '在任务看板上创建任务。必填：title、workspaceId（项目）、urgency（urgent/normal/relaxed）。可选：description、prompt（执行时发给新会话）、status（默认 todo，backlog 表示未批准执行）、execution、model、checklist（验收清单）。不要为琐碎请求建卡。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '一句话标题（1..200 字符）' },
        workspaceId: { type: 'string', description: '任务所属项目：项目路径或 id（省略则用当前项目）' },
        urgency: { type: 'string', description: 'urgent（红）| normal（紫）| relaxed（蓝）' },
        description: { type: 'string', description: '任务内容说明' },
        prompt: { type: 'string', description: '额外执行说明；会话会收到 title+description+prompt' },
        blockedBy: { type: 'array', items: { type: 'string' }, description: '同项目的前置任务 id' },
        status: { type: 'string', description: '初始状态，默认 todo' },
        execution: {
          type: 'object',
          description: '执行配置：{mode:"claim"}（默认）或 {mode:"scheduled", cron/runAt}（当前版本仅记录，不调度）',
          properties: { mode: { type: 'string' }, cron: { type: 'string' }, runAt: { type: 'string' } },
        },
        model: {
          type: 'object',
          description: '把执行固定到某个模型：{provider, model, reasoningEffort?}',
          properties: { provider: { type: 'string' }, model: { type: 'string' }, reasoningEffort: { type: 'string' } },
        },
        checklist: { type: 'array', items: { type: 'string' }, description: '验收清单（DoD）条目，最多 30 条' },
        isolation: { type: 'string', description: 'worktree | none（当前版本仅记录）' },
        branch: { type: 'string', description: '任务分支名（仅记录）' },
        permission: { type: 'string', description: 'read-only | workspace-write | danger-full-access' },
        presetId: { type: 'string', description: '执行会话使用的 agent preset' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    output: {
      schema: looseSchema({ task: { type: 'object' } }),
      render: (args, value) => {
        const task = value?.task
        return text(task === undefined ? '创建失败。' : `已创建任务 ${task.id} [${task.status}] v${task.version}。写入前先 taskboard_get 读取。`)
      },
    },
    async execute(args, exec) {
      const board = requireBoard(services)
      const { actor } = callerOf(exec)
      return { ok: true, ...board.create({ ...args, urgency: args?.urgency ?? 'normal' }, { actor }) }
    },
  })

  add({
    name: 'taskboard_update',
    description: '修改任务内容（标题、描述、执行 prompt、紧急度、依赖、模型、验收清单之外的字段）。跨多个字段请一次传完；必须带 ifVersion 做乐观锁。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 id' },
        ifVersion: { type: 'number', description: '你读到的任务版本；不匹配则失败' },
        title: { type: 'string' },
        description: { type: 'string' },
        prompt: { type: 'string' },
        urgency: { type: 'string' },
        blockedBy: { type: 'array', items: { type: 'string' } },
        model: { type: 'object', properties: { provider: { type: 'string' }, model: { type: 'string' }, reasoningEffort: { type: 'string' } } },
        permission: { type: 'string' },
        presetId: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: looseSchema({ task: { type: 'object' } }),
      render: (args, value) => text(value?.task === undefined ? '修改失败。' : `任务 ${value.task.id} 已更新到 v${value.version ?? value.task.version}。`),
    },
    async execute(args, exec) {
      const board = requireBoard(services)
      const { actor } = callerOf(exec)
      const patch = {}
      for (const key of ['title', 'description', 'prompt', 'urgency', 'blockedBy', 'model', 'permission', 'presetId']) {
        if (args?.[key] !== undefined) patch[key] = args[key]
      }
      return { ok: true, ...board.update({ id: args?.id, ifVersion: args?.ifVersion, patch }, { actor }) }
    },
  })

  add({
    name: 'taskboard_move',
    description:
      '在状态之间移动任务（必须带 ifVersion）。认领 = todo→in_progress（只有属于该项目的会话可认领；不要抢占别的会话持有的任务）。实现并自验后：先评论，再 in_progress→in_review。你永远不能把任务移到 done —— 那需要用户在看板上确认。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 id' },
        status: { type: 'string', description: '目标状态' },
        ifVersion: { type: 'number', description: '你读到的任务版本；不匹配则失败' },
        archiveSessions: { type: 'boolean', description: '移到 archived 时是否一并归档执行会话（默认 false）' },
      },
      required: ['id', 'status'],
      additionalProperties: false,
    },
    output: {
      schema: looseSchema({ task: { type: 'object' } }),
      render: (args, value) => {
        const task = value?.task
        if (task === undefined) return text('移动失败。')
        const dependents = value?.affectedDependents ?? []
        const extra = dependents.length === 0 ? '' : ` 以下任务的依赖未满足，请调整依赖：${dependents.map((dep) => `${dep.title} (${dep.id})`).join(', ')}。`
        return text(`任务 ${task.id} 已移到 ${task.status}，当前 v${task.version}。${extra}`)
      },
    },
    async execute(args, exec) {
      const board = requireBoard(services)
      const { actor, kind } = callerOf(exec)
      return { ok: true, ...board.move({ id: args?.id, status: args?.status, ifVersion: args?.ifVersion, archiveSessions: args?.archiveSessions }, { actor, actorKind: kind }) }
    },
  })

  add({
    name: 'taskboard_comment_add',
    description: '给任务追加进度/汇报评论。交接到待验收时，评论应cover：改了什么、怎么验证的、结果、剩余风险。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '任务 id' }, body: { type: 'string', description: '评论内容（1..4000 字符）' } },
      required: ['id', 'body'],
      additionalProperties: false,
    },
    output: {
      schema: looseSchema({ comment: { type: 'object' } }),
      render: (args, value) => text(value?.comment === undefined ? '评论失败。' : `已评论 ${value.task?.id ?? ''}（现在 v${value.task?.version ?? '?'}）。`),
    },
    async execute(args, exec) {
      const board = requireBoard(services)
      const { actor } = callerOf(exec)
      return { ok: true, ...board.commentAdd({ id: args?.id, body: args?.body }, { actor }) }
    },
  })

  add({
    name: 'taskboard_comments',
    description: '读取一个任务的所有评论（按时间正序）。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '任务 id' } },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: looseSchema({ comments: { type: 'array', items: { type: 'object' } } }),
      render: (args, value) => {
        const comments = value?.comments ?? []
        if (comments.length === 0) return text('没有评论。')
        return text(comments.map((comment) => `${comment.by}: ${comment.body}`).join('\n'))
      },
    },
    async execute(args) {
      const board = requireBoard(services)
      return { ok: true, ...board.comments(args?.id) }
    },
  })

  add({
    name: 'taskboard_delete',
    description: '软删除任务（标记 trash，用户在 GUI 里确认彻底删除）。必须带 ifVersion。优先用 canceled/archived，只有建错了才删。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '任务 id' }, ifVersion: { type: 'number', description: '你读到的任务版本' } },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: looseSchema({ task: { type: 'object' } }),
      render: (args, value) => text(value?.trashed === true ? `已删除（软删）${value.task?.id ?? ''}。` : '删除失败。'),
    },
    async execute(args) {
      const board = requireBoard(services)
      return { ok: true, ...board.remove({ id: args?.id, ifVersion: args?.ifVersion }) }
    },
  })

  add({
    name: 'taskboard_checklist',
    description:
      '管理任务的验收清单（DoD）。动作：add（追加条目，每次 ≤10 条）、check（勾选并附证据）、uncheck（取消勾选）。勾选永远不会让任务完成 —— done 只能由用户操作。需要 ifVersion。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 id' },
        action: { type: 'string', description: 'add | check | uncheck' },
        ifVersion: { type: 'number', description: '你读到的任务版本' },
        items: { type: 'array', items: { type: 'string' }, description: 'add 时要追加的条目（1..10 条，每条 ≤200 字符）' },
        itemId: { type: 'string', description: 'check/uncheck 的条目 id' },
        note: { type: 'string', description: '勾选时记录的证据（≤400 字符）' },
      },
      required: ['id', 'action'],
      additionalProperties: false,
    },
    output: {
      schema: looseSchema({ checklist: { type: 'array', items: { type: 'object' } } }),
      render: (args, value) => {
        const checklist = value?.checklist ?? []
        const lines = checklist.map((item, index) => `${item.checked === true ? '☑' : '☐'} [${index + 1}] ${item.text}${item.note === undefined ? '' : `（证据: ${item.note}）`} id=${item.id}`)
        return text(`任务 ${value?.task?.id ?? ''} 验收清单 ${value?.done ?? 0}/${value?.total ?? 0} 已完成，当前 v${value?.task?.version ?? '?'}：\n${lines.join('\n')}`)
      },
    },
    async execute(args, exec) {
      const board = requireBoard(services)
      const { actor } = callerOf(exec)
      return { ok: true, ...board.checklist({ id: args?.id, action: args?.action, ifVersion: args?.ifVersion, items: args?.items, itemId: args?.itemId, note: args?.note }, { actor }) }
    },
  })

  add({
    name: 'taskboard_execution_report',
    description:
      '为你当前正在执行的任务提交结构化执行报告（摘要/改动文件/如何验证/产物/剩余风险）。请在移到 in_review 之前提交；再次提交会覆盖上一份报告。',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '做了什么（1..2000 字符）' },
        changedFiles: { type: 'array', items: { type: 'string' }, description: '改动的文件路径（≤50 × 300 字符）' },
        checks: { type: 'array', items: { type: 'string' }, description: '如何验证的（如测试命令与结果，≤50 条）' },
        artifacts: { type: 'array', items: { type: 'string' }, description: '值得复核的产物（构建结果、截图、文档，≤30 条）' },
        risk: { type: 'string', description: '已知剩余风险或后续事项（≤2000 字符，可选）' },
      },
      required: ['summary'],
      additionalProperties: false,
    },
    output: {
      schema: looseSchema({ taskId: { type: 'string' }, report: { type: 'object' } }),
      render: (args, value) => {
        if (value?.taskId === undefined) return text('报告提交失败。')
        return text(`执行报告已记录到任务 ${value.taskId}（执行 ${value.executionId}）：${String(value.report?.summary ?? '').slice(0, 120)}\n接下来：taskboard_comment_add 留交接评论，然后 taskboard_move 移至待验收 in_review。`)
      },
    },
    async execute(args, exec) {
      const board = requireBoard(services)
      const { sessionId } = callerOf(exec)
      return { ok: true, ...board.executionReport(args ?? {}, { sessionId }) }
    },
  })

  return definitions
}

/** One-line probe used by /health. */
export function describeTaskboardTooling(services) {
  try {
    const board = services?.taskboard
    if (board === undefined || board === null) return { available: false, tasks: 0 }
    const snapshot = board.snapshot()
    return { available: true, tasks: snapshot.tasks.length, revision: snapshot.revision }
  } catch (error) {
    return { available: false, tasks: 0, error: normalizeError(error).message }
  }
}