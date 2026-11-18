/**
 * Settings: the plugin's own persisted, user-editable state.
 *
 * Values seeded by `cordis.patch.yml` are the defaults; anything the panel (or
 * a tool) changes is stored in the plugin data file and wins from then on. The
 * merged result is what every other module receives.
 */
import { randomBytes } from 'node:crypto'
import { clamp, definedOnly, normalizeError } from './util.js'

/** Every setting, with its type, default and description for the UI. */
export const SETTING_SPEC = {
  flutterPath: { type: 'string', default: '', label: 'Flutter SDK 路径', hint: '留空则从 PATH 解析 flutter 可执行文件' },
  dartPath: { type: 'string', default: '', label: 'Dart SDK 路径', hint: '留空则从 PATH 解析 dart 可执行文件' },
  logCapacity: { type: 'number', default: 4000, label: '日志缓冲条数', hint: '200 - 200000' },
  autoStart: { type: 'boolean', default: false, label: '打开面板时自动启动上次的运行' },
  dataDir: { type: 'string', default: '', label: '数据目录', hint: '留空使用 ~/.dsh/flutter-workbench' },
  editorCommand: { type: 'string', default: 'code', label: '编辑器命令', hint: '用于从日志/堆栈跳到源码，例如 code 或 "code-insiders"' },
  mcpToken: { type: 'string', default: '', label: 'MCP 访问令牌', hint: '外部 MCP 客户端用它调用 /mcp' },
  defaultProvider: { type: 'string', default: '', label: 'AI provider', hint: '看板派发任务使用；留空用 DSH 默认' },
  defaultModel: { type: 'string', default: '', label: 'AI model', hint: '看板派发任务使用；留空用 DSH 默认' },
  autoRefreshMs: { type: 'number', default: 2000, label: '面板刷新间隔（毫秒）' },
  networkAutoRefreshMs: { type: 'number', default: 1500, label: '网络日志拉取间隔（毫秒）' },
  maxTaskConcurrency: { type: 'number', default: 1, label: '同时执行的看板任务数' },
  analysisEnabled: { type: 'boolean', default: true, label: '自动分析保存后的错误' },
  mcpEnabled: { type: 'boolean', default: true, label: '启用 MCP 接口' },
}

const NUMBER_LIMITS = {
  logCapacity: [200, 200000],
  autoRefreshMs: [500, 60000],
  networkAutoRefreshMs: [500, 60000],
  maxTaskConcurrency: [1, 8],
}

function coerce(key, value, spec) {
  if (spec.type === 'number') {
    const limits = NUMBER_LIMITS[key] ?? [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]
    return clamp(value, limits[0], limits[1])
  }
  if (spec.type === 'boolean') return value === true
  return typeof value === 'string' ? value : String(value ?? '')
}

/** Merge defaults ← patch/config ← stored values, coercing every field. */
export function normalizeSettings(sources) {
  const result = {}
  for (const [key, spec] of Object.entries(SETTING_SPEC)) {
    let value = spec.default
    for (const source of sources) {
      if (source === null || typeof source !== 'object') continue
      if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined && source[key] !== null) {
        value = source[key]
      }
    }
    result[key] = coerce(key, value, spec)
  }
  return result
}

/** Settings service: merged values, mutation, and a stable MCP token. */
export async function createSettings({ config, store, logger }) {
  const stored = store?.get('settings', {}) ?? {}
  let current = normalizeSettings([config, stored])

  if (current.mcpToken === '') {
    current = { ...current, mcpToken: randomBytes(18).toString('hex') }
    try {
      await store?.set('settings', current)
    } catch (error) {
      logger?.warn?.(`settings: cannot persist the generated MCP token: ${normalizeError(error).message}`)
    }
  }

  return {
    get() {
      return current
    },
    /** Patch only known keys; unknown keys are ignored, never thrown. */
    async save(patch) {
      const known = {}
      for (const key of Object.keys(SETTING_SPEC)) {
        if (patch !== null && typeof patch === 'object' && Object.prototype.hasOwnProperty.call(patch, key)) {
          known[key] = patch[key]
        }
      }
      if (Object.keys(known).length === 0) return current
      current = normalizeSettings([current, known])
      await store?.set('settings', current)
      return current
    },
    /** Replace the MCP token with a fresh one; returns the new value. */
    async rotateMcpToken() {
      current = { ...current, mcpToken: randomBytes(18).toString('hex') }
      await store?.set('settings', current)
      return current.mcpToken
    },
    /** Only the keys a client may see; the token is returned to the panel too (local UI). */
    redacted() {
      return { ...current }
    },
    descriptor() {
      return definedOnly(SETTING_SPEC)
    },
  }
}