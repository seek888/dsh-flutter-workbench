/**
 * JSON-file persistence for the workbench (tasks, projects, settings).
 * One file per plugin; atomic writes through a temp file + rename; serialized
 * write chain so concurrent updates never interleave.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { normalizeError, safeJson } from './util.js'

/** Default data directory: `~/.dsh/flutter-workbench`. */
export function resolveDataDir(configDir) {
  const configured = typeof configDir === 'string' ? configDir.trim() : ''
  if (configured !== '') return configured
  return join(homedir(), '.dsh', 'flutter-workbench')
}

/**
 * Open the store.
 * @param {{ dir?: string, name?: string, logger?: any }} options
 */
export async function createStore({ dir, name = 'store', logger } = {}) {
  const targetDir = dir ?? resolveDataDir('')
  const file = join(targetDir, `${name}.json`)
  let data = {}
  let writeChain = Promise.resolve()

  try {
    await mkdir(dirname(file), { recursive: true })
    const text = await readFile(file, 'utf8')
    const parsed = safeJson(text, null)
    if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed) === false) data = parsed
  } catch (error) {
    if (error?.code !== 'ENOENT') logger?.warn?.(`store: cannot read ${file}: ${normalizeError(error).message}`)
  }

  async function persist() {
    const text = JSON.stringify(data, null, 2)
    const temp = `${file}.tmp`
    await mkdir(dirname(file), { recursive: true })
    await writeFile(temp, text, 'utf8')
    await rename(temp, file)
  }

  return {
    get dir() {
      return targetDir
    },
    get file() {
      return file
    },
    get(key, fallback = undefined) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback
    },
    all() {
      return data
    },
    async set(key, value) {
      data[key] = value
      writeChain = writeChain.then(persist, persist)
      await writeChain
      return value
    },
    async update(key, mutate) {
      const next = await mutate(data[key])
      if (next !== undefined) data[key] = next
      writeChain = writeChain.then(persist, persist)
      await writeChain
      return data[key]
    },
    async flush() {
      await writeChain
    },
    async reset() {
      data = {}
      writeChain = writeChain.then(persist, persist)
      await writeChain
    },
  }
}