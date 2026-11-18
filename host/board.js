/**
 * STUB — owner: dev-board. Replaced by the real implementation.
 * Kanban board state machine.
 */
export const LANES = [
  { id: 'backlog', label: '待办', order: 0 },
  { id: 'ready', label: '就绪', order: 1 },
  { id: 'running', label: '执行中', order: 2 },
  { id: 'review', label: '待验收', order: 3 },
  { id: 'verify', label: '验证中', order: 4 },
  { id: 'done', label: '完成', order: 5 },
]

export function createBoard() {
  return {
    snapshot: () => ({ lanes: LANES, tasks: [], counts: {} }),
    addTask: async () => {
      throw Object.assign(new Error('board module not implemented yet'), { code: 'not-implemented' })
    },
    updateTask: async () => {
      throw Object.assign(new Error('board module not implemented yet'), { code: 'not-implemented' })
    },
    moveTask: async () => {
      throw Object.assign(new Error('board module not implemented yet'), { code: 'not-implemented' })
    },
    removeTask: async () => ({ removed: false }),
    archiveDone: async () => ({ archived: 0 }),
    decompose: async () => ({ tasks: [], raw: '' }),
    dispatch: async () => {
      throw Object.assign(new Error('board module not implemented yet'), { code: 'not-implemented' })
    },
    report: async () => {
      throw Object.assign(new Error('board module not implemented yet'), { code: 'not-implemented' })
    },
    cancelAgent: async () => {
      throw Object.assign(new Error('board module not implemented yet'), { code: 'not-implemented' })
    },
    syncAgent: async () => null,
    onChange: () => () => {},
    dispose: async () => {},
  }
}