/**
 * Project registry: which Flutter projects this workbench knows about, which
 * one is active, and their detection metadata.
 *
 * Persisted under the `projects` store key so it survives restarts and travels
 * with the machine, not with any single repository.
 */
import { normalizeError, nowMs, uid } from './util.js'
import { detectFlutterProject } from './runconfig.js'

/** @param {{ store: any, logger?: any }} deps */
export function createProjects({ store, logger }) {
  /** @type {Map<string, any>} */
  let projects = new Map()
  let activeId = null

  const persisted = store?.get('projects', null)
  if (persisted !== null && typeof persisted === 'object') {
    for (const project of Array.isArray(persisted.list) ? persisted.list : []) {
      if (project !== null && typeof project === 'object' && typeof project.id === 'string') projects.set(project.id, project)
    }
    if (typeof persisted.activeId === 'string' && projects.has(persisted.activeId)) activeId = persisted.activeId
  }

  async function persist() {
    if (store === undefined) return
    await store.set('projects', { list: [...projects.values()], activeId })
  }

  function list() {
    return [...projects.values()].sort((a, b) => (b.lastUsedAt ?? b.createdAt ?? 0) - (a.lastUsedAt ?? a.createdAt ?? 0))
  }

  return {
    list,
    activeId: () => activeId,
    active() {
      return activeId === null ? null : projects.get(activeId) ?? null
    },
    get(id) {
      return projects.get(String(id)) ?? null
    },
    async add({ path }) {
      const raw = typeof path === 'string' ? path.trim() : ''
      if (raw === '') throw Object.assign(new Error('project path is required'), { code: 'bad-request' })
      const normalized = raw.replace(/[\\/]+$/, '')
      for (const existing of projects.values()) {
        if (existing.path.toLowerCase() === normalized.toLowerCase()) {
          await this.touch(existing.id)
          return existing
        }
      }
      const detected = await detectFlutterProject({ projectPath: normalized }).catch((error) => ({
        ok: false,
        appName: null,
        description: null,
        platforms: [],
        flavors: [],
        sdkConstraint: null,
        error: normalizeError(error).message,
      }))
      const project = {
        id: uid('proj'),
        path: normalized,
        name: detected.appName ?? baseName(normalized),
        createdAt: nowMs(),
        lastUsedAt: null,
        detected,
      }
      projects.set(project.id, project)
      if (activeId === null) activeId = project.id
      await persist()
      logger?.info?.(`project added: ${project.name} (${project.path})`)
      return project
    },
    async remove(id) {
      const key = String(id)
      if (projects.has(key) === false) return { removed: false }
      projects.delete(key)
      if (activeId === key) activeId = list()[0]?.id ?? null
      await persist()
      return { removed: true }
    },
    async select(id) {
      const key = String(id)
      if (projects.has(key) === false) throw Object.assign(new Error('unknown project'), { code: 'not-found' })
      activeId = key
      await persist()
      return activeId
    },
    async touch(id) {
      const project = projects.get(String(id))
      if (project === undefined) return null
      project.lastUsedAt = nowMs()
      await persist()
      return project
    },
    /** Re-detect (pubspec changed, flavors added). */
    async refresh(id) {
      const project = projects.get(String(id))
      if (project === undefined) throw Object.assign(new Error('unknown project'), { code: 'not-found' })
      project.detected = await detectFlutterProject({ projectPath: project.path })
      project.name = project.detected.appName ?? project.name
      await persist()
      return project
    },
    async persist() {
      await persist()
    },
  }
}

function baseName(path) {
  const parts = String(path).split(/[\\/]/).filter((part) => part !== '')
  return parts.length === 0 ? String(path) : parts[parts.length - 1]
}