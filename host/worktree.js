/**
 * Per-task git worktree isolation.
 *
 * Each execution can run in its own worktree on its own branch, so parallel
 * tasks never fight over the working tree. Not a git repository → the caller
 * degrades to running in the project directory (the task board records that).
 *
 * Worktrees live OUTSIDE the project (under the plugin data dir) so the user's
 * repository never gains an untracked `.dsh-worktrees/` directory.
 */
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { resolveDataDir } from './store.js'
import { normalizeError, nowMs } from './util.js'
import { runCommand } from './runconfig.js'

const GIT_TIMEOUT_MS = 120000

function git(args, { cwd, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  return runCommand({ file: 'git', args, cwd, timeoutMs, maxBytes: 4 * 1024 * 1024 })
}

/** Is `dir` inside a git work tree? */
export async function isGitRepo(dir) {
  if (typeof dir !== 'string' || dir === '' || existsSync(dir) === false) return false
  const result = await git(['rev-parse', '--is-inside-work-tree'], { cwd: dir, timeoutMs: 20000 })
  return result.code === 0 && String(result.stdout).trim() === 'true'
}

/** Turn a task title into a readable branch segment. */
export function branchSlug(title, id) {
  const ascii = String(title ?? '')
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 40)
  const tail = String(id ?? '').replace(/[^a-zA-Z0-9]/g, '').slice(-8) || nowMs().toString(36)
  return ascii === '' ? `task/${tail}` : `task/${ascii}-${tail}`
}

/**
 * Create (or reuse) the worktree for one task execution.
 *
 * @param {{ projectPath: string, taskId: string, title?: string, branch?: string,
 *           dataDir?: string, base?: string }} input
 * @returns {Promise<{ ok: boolean, path?: string, branch?: string, reason?: string, reused?: boolean }>}
 */
export async function createWorktree({ projectPath, taskId, title = '', branch = '', dataDir = '', base = 'HEAD' }) {
  const repo = String(projectPath ?? '')
  if (repo === '') return { ok: false, reason: 'project path is empty' }
  if ((await isGitRepo(repo)) === false) return { ok: false, reason: 'not a git repository' }

  const wantedBranch = String(branch ?? '').trim() !== '' ? String(branch).trim() : branchSlug(title, taskId)
  const short = String(taskId ?? '').replace(/[^a-zA-Z0-9]/g, '').slice(-12) || nowMs().toString(36)
  const root = path.join(resolveDataDir(dataDir), 'worktrees')
  const target = path.join(root, `${path.basename(repo)}-${short}`)

  try {
    await mkdir(root, { recursive: true })
  } catch (error) {
    return { ok: false, reason: `cannot prepare the worktree root: ${normalizeError(error).message}` }
  }

  if (existsSync(target)) {
    // Reuse only when it is still a worktree of this repo on the wanted branch.
    const check = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: target })
    if (check.code === 0 && String(check.stdout).trim() === wantedBranch) {
      return { ok: true, path: target, branch: wantedBranch, reused: true }
    }
    await removeWorktree({ projectPath: repo, worktreePath: target })
  }

  const branchExists = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${wantedBranch}`], { cwd: repo })
  const args = branchExists.code === 0
    ? ['worktree', 'add', target, wantedBranch]
    : ['worktree', 'add', '-b', wantedBranch, target, base]
  const created = await git(args, { cwd: repo })
  if (created.code !== 0) {
    return { ok: false, reason: `git worktree add failed: ${String(created.stderr || created.stdout || created.error || '').trim().slice(0, 500)}` }
  }
  return { ok: true, path: target, branch: wantedBranch }
}

/** Remove a worktree (best effort; never throws). */
export async function removeWorktree({ projectPath, worktreePath }) {
  if (typeof worktreePath !== 'string' || worktreePath === '') return { ok: false }
  if (typeof projectPath === 'string' && projectPath !== '' && existsSync(projectPath)) {
    const result = await git(['worktree', 'remove', '--force', worktreePath], { cwd: projectPath, timeoutMs: 60000 })
    if (result.code === 0) return { ok: true }
  }
  try {
    await rm(worktreePath, { recursive: true, force: true })
    return { ok: true, reason: 'removed the directory directly' }
  } catch (error) {
    return { ok: false, reason: normalizeError(error).message }
  }
}

/** What the task's worktree currently holds: uncommitted files and commits. */
export async function worktreeStatus({ worktreePath, base = 'HEAD' }) {
  if (typeof worktreePath !== 'string' || worktreePath === '' || existsSync(worktreePath) === false) {
    return { ok: false, reason: 'worktree does not exist' }
  }
  const status = await git(['status', '--porcelain'], { cwd: worktreePath })
  const log = await git(['log', '--oneline', `${base}..HEAD`], { cwd: worktreePath })
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath })
  const files = String(status.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => line.replace(/^\S+\s+/, ''))
  return {
    ok: true,
    branch: String(branch.stdout ?? '').trim(),
    dirty: files.length > 0,
    changedFiles: files.slice(0, 200),
    commits: String(log.stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .slice(0, 100),
  }
}

/** Commit whatever the agent left in the worktree, so nothing is lost. */
export async function commitWorktree({ worktreePath, message }) {
  if (existsSync(worktreePath) === false) return { ok: false, reason: 'worktree does not exist' }
  const add = await git(['add', '-A'], { cwd: worktreePath })
  if (add.code !== 0) return { ok: false, reason: String(add.stderr ?? '').trim().slice(0, 300) }
  const status = await git(['status', '--porcelain'], { cwd: worktreePath })
  if (String(status.stdout ?? '').trim() === '') return { ok: true, committed: false }
  const commit = await git(['-c', 'user.name=dsh-workbench', '-c', 'user.email=workbench@local', 'commit', '-m', String(message ?? 'task work').slice(0, 200)], { cwd: worktreePath })
  if (commit.code !== 0) return { ok: false, reason: String(commit.stderr ?? '').trim().slice(0, 300) }
  const head = await git(['rev-parse', '--short', 'HEAD'], { cwd: worktreePath })
  return { ok: true, committed: true, commit: String(head.stdout ?? '').trim() }
}

/** Merge a finished task branch into the project's current branch. */
export async function mergeWorktree({ projectPath, branch, message }) {
  if (typeof projectPath !== 'string' || projectPath === '') return { ok: false, reason: 'project path is empty' }
  if ((await isGitRepo(projectPath)) === false) return { ok: false, reason: 'not a git repository' }
  const text = String(message ?? '').trim() === '' ? `merge ${branch}` : String(message).trim().slice(0, 200)
  const result = await git(['merge', '--no-ff', String(branch), '-m', text], { cwd: projectPath })
  return result.code === 0
    ? { ok: true, output: String(result.stdout ?? '').trim().slice(0, 2000) }
    : { ok: false, reason: String(result.stderr || result.stdout || '').trim().slice(0, 1000) }
}

/** Every worktree git knows about for this repository. */
export async function listWorktrees({ projectPath }) {
  if ((await isGitRepo(projectPath)) === false) return []
  const result = await git(['worktree', 'list', '--porcelain'], { cwd: projectPath })
  if (result.code !== 0) return []
  const entries = []
  let current = null
  for (const line of String(result.stdout ?? '').split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current !== null) entries.push(current)
      current = { path: line.slice('worktree '.length).trim(), branch: null, head: null }
    } else if (current !== null && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim()
    } else if (current !== null && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim()
    }
  }
  if (current !== null) entries.push(current)
  return entries
}