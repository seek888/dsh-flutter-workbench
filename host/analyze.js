/**
 * Toolchain runners — `dart analyze`, `flutter test`, `pub get`, `clean`,
 * `build`, `doctor`, `format`, plus device/emulator listing.
 *
 * Everything here is machine-format first (no locale-dependent scraping):
 *   • `dart analyze --format machine` →
 *       `SEVERITY|TYPE|CODE|FILE|LINE|COL|LENGTH|MESSAGE` per line
 *       (VERIFIED on Dart 3.10.4: `ERROR|COMPILE_TIME_ERROR|INVALID_ASSIGNMENT|/abs/lib/broken.dart|4|13|17|A value of type 'String' can't be assigned to a variable of type 'int'.`)
 *   • `flutter test --reporter json` → newline-delimited JSON events
 *       (`start`, `suite`, `group`, `testStart`, `error`, `testDone`, `done`)
 *   • `flutter devices --machine` → one JSON array
 *
 * Every run streams the tail of its output on the `job:progress` bus event, is
 * bounded by `timeoutMs` (kill the whole tree), and reports a missing SDK as
 * `{ ok:false, code:'toolchain-missing' }` instead of throwing.
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  buildSpawnSpec,
  killProcessTree,
  listDevices,
  listEmulators,
  resolveBinaryPath,
} from './runconfig.js'
import { normalizeError, nowMs, safeJson, truncate } from './util.js'

export const DEFAULT_TIMEOUT_MS = 180000
export const TEST_TIMEOUT_MS = 600000
export const PATH_CACHE_TTL_MS = 15000
/** `flutter build <target>` targets the panel offers (contract §5.7). */
export const BUILD_TARGETS = ['apk', 'appbundle', 'ios', 'web', 'windows', 'macos', 'linux']

const MAX_RAW_BYTES = 2 * 1024 * 1024
const PROGRESS_INTERVAL_MS = 150
const TAIL_CHARS = 2000

/* ------------------------------------------------------------------ */
/* Pure parsers                                                        */
/* ------------------------------------------------------------------ */

const ANALYZE_SEVERITIES = { ERROR: 'error', WARNING: 'warning', INFO: 'info' }

/**
 * Parse `dart analyze --format machine` output.
 *
 * Row: `SEVERITY|TYPE|CODE|FILE|LINE|COL|LENGTH|MESSAGE`
 * The message is the last field and may itself contain `|`, so the split is
 * bounded to the first seven separators.
 *
 * @param {string} text
 * @returns {{ severity: 'error'|'warning'|'info', file: string, line: number,
 *             column: number, code: string, message: string }[]}
 */
export function parseAnalyzeMachine(text) {
  const issues = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    const parts = line.split('|')
    if (parts.length < 8) continue
    const severity = ANALYZE_SEVERITIES[parts[0].trim().toUpperCase()]
    if (severity === undefined) continue
    const file = parts[3].trim()
    if (file === '') continue
    issues.push({
      severity,
      file,
      line: toInt(parts[4], 0),
      column: toInt(parts[5], 0),
      code: parts[2].trim(),
      message: parts.slice(7).join('|').trim(),
    })
  }
  return issues
}

function toInt(value, fallback) {
  const number = Number.parseInt(String(value ?? '').trim(), 10)
  return Number.isFinite(number) ? number : fallback
}

/** Count analyzer issues by severity. */
export function summarizeIssues(issues) {
  const counts = { error: 0, warning: 0, info: 0 }
  for (const issue of Array.isArray(issues) ? issues : []) {
    if (issue === null || typeof issue !== 'object') continue
    if (Object.prototype.hasOwnProperty.call(counts, issue.severity)) counts[issue.severity] += 1
  }
  return counts
}

/**
 * Parse `flutter test --reporter json` (newline-delimited events).
 *
 * Observed event types: `start`, `suite`, `group`, `testStart`, `print`,
 * `error`, `testDone`, `done`. `testDone.result` is `success`, `failure` or
 * `error`; a skipped test is `success` + `skipped:true`. Loader pseudo-tests are
 * named `loading <path>` and flagged `hidden:true` — they are dropped.
 *
 * @param {string} text
 * @returns {{ passed: number, failed: number, skipped: number, durationMs: number,
 *             tests: { id: string, name: string, group: string|null,
 *                      status: 'passed'|'failed'|'skipped', durationMs: number,
 *                      error: string|null, stack: string|null }[],
 *             success: boolean|null, failedTests: string[] }}
 */
export function parseTestJson(text) {
  const byId = new Map()
  const order = []
  const groups = new Map()
  let durationMs = 0
  let success = null
  let sawDone = false

  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line[0] !== '{') continue
    const event = safeJson(line, null)
    if (event === null || typeof event !== 'object' || typeof event.type !== 'string') continue
    switch (event.type) {
      case 'group': {
        const group = event.group
        if (group !== null && typeof group === 'object' && group.id !== undefined && typeof group.name === 'string') {
          groups.set(String(group.id), group.name)
        }
        break
      }
      case 'testStart': {
        const test = event.test
        if (test === null || typeof test !== 'object' || test.id === undefined) break
        const id = String(test.id)
        if (byId.has(id)) break
        const entry = {
          id,
          name: typeof test.name === 'string' ? test.name : '',
          group: groupLabel(test.groupIDs, groups),
          status: 'passed',
          durationMs: 0,
          error: null,
          stack: null,
          startTime: toInt(event.time, 0),
          hidden: test.metadata?.skip === true ? false : false,
          done: false,
        }
        byId.set(id, entry)
        order.push(entry)
        break
      }
      case 'error': {
        const entry = byId.get(String(event.testID))
        if (entry === undefined) break
        entry.error = typeof event.error === 'string' && event.error !== '' ? event.error : null
        entry.stack = typeof event.stackTrace === 'string' && event.stackTrace !== '' ? event.stackTrace : null
        if (entry.error !== null) entry.status = 'failed'
        break
      }
      case 'testDone': {
        const entry = byId.get(String(event.testID))
        if (entry === undefined) break
        entry.done = true
        entry.hidden = event.hidden === true
        entry.durationMs = Math.max(0, toInt(event.time, 0) - entry.startTime)
        const result = String(event.result ?? 'success')
        if (event.skipped === true || result === 'skipped') entry.status = 'skipped'
        else if (result === 'success') entry.status = entry.status === 'failed' ? 'failed' : 'passed'
        else entry.status = 'failed'
        break
      }
      case 'done': {
        sawDone = true
        durationMs = toInt(event.time, durationMs)
        success = event.success === true
        break
      }
      default:
        break
    }
  }

  const tests = []
  for (const entry of order) {
    if (!entry.done) continue
    if (entry.hidden) continue
    if (entry.status === 'passed' && /^loading\s/.test(entry.name)) continue
    tests.push({
      id: entry.id,
      name: entry.name,
      group: entry.group,
      status: entry.status,
      durationMs: entry.durationMs,
      error: entry.error,
      stack: entry.stack,
    })
  }

  const passed = tests.filter((test) => test.status === 'passed').length
  const failedTests = tests.filter((test) => test.status === 'failed')
  const skipped = tests.filter((test) => test.status === 'skipped').length
  if (!sawDone && tests.length > 0) {
    durationMs = tests.reduce((sum, test) => sum + test.durationMs, 0)
  }
  return {
    passed,
    failed: failedTests.length,
    skipped,
    durationMs,
    tests,
    success,
    failedTests: failedTests.map((test) => test.name),
  }
}

function groupLabel(groupIDs, groups) {
  if (!Array.isArray(groupIDs)) return null
  const names = []
  for (const id of groupIDs) {
    const name = groups.get(String(id))
    if (typeof name === 'string' && name !== '') names.push(name)
  }
  return names.length === 0 ? null : names.join(' > ')
}

const ARTIFACT_EXTENSIONS = ['apk', 'aab', 'ipa', 'app', 'exe', 'msix', 'zip', 'dll', 'so', 'dylib', 'framework', 'js', 'wasm']

/**
 * Collect artifact paths mentioned in `flutter build` output, e.g.
 * `√ Built build\windows\x64\runner\Debug\app.exe` or
 * `✓ Built build/app/outputs/flutter-apk/app-release.apk (20.0MB)`.
 *
 * @param {string} output
 * @returns {string[]}
 */
export function parseBuildArtifacts(output) {
  const found = []
  const seen = new Set()
  const pattern = /(?:[A-Za-z]:[\\/][^\s"'`<>|,]+|\b(?:\.?[\\/])?build[\\/][^\s"'`<>|,]+)/g
  for (const raw of String(output ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    for (const match of line.matchAll(pattern)) {
      const token = match[0].replace(/[).;:]+$/, '').replace(/["'`]/g, '')
      const lower = token.toLowerCase()
      if (!ARTIFACT_EXTENSIONS.some((ext) => lower.endsWith(`.${ext}`))) continue
      if (seen.has(token)) continue
      seen.add(token)
      found.push(token)
    }
  }
  return found
}

/** Directories worth scanning for each build target (relative to the project). */
export function artifactDirsFor(target) {
  switch (String(target ?? '')) {
    case 'apk':
      return [{ dir: 'build/app/outputs/flutter-apk', match: /\.apk$/i }, { dir: 'build/app/outputs/apk', match: /\.apk$/i }]
    case 'appbundle':
      return [
        { dir: 'build/app/outputs/bundle/release', match: /\.aab$/i },
        { dir: 'build/app/outputs/bundle/debug', match: /\.aab$/i },
      ]
    case 'ios':
      return [
        { dir: 'build/ios/ipa', match: /\.ipa$/i },
        { dir: 'build/ios/iphoneos', match: /\.app$/i },
      ]
    case 'web':
      return [{ dir: 'build/web', match: null }]
    case 'windows':
      return [
        { dir: 'build/windows/x64/runner/Release', match: /\.exe$/i },
        { dir: 'build/windows/x64/runner/Debug', match: /\.exe$/i },
        { dir: 'build/windows/runner/Release', match: /\.exe$/i },
      ]
    case 'macos':
      return [
        { dir: 'build/macos/Build/Products/Release', match: /\.app$/i },
        { dir: 'build/macos/Build/Products/Debug', match: /\.app$/i },
      ]
    case 'linux':
      return [{ dir: 'build/linux/x64/release/bundle', match: null }]
    default:
      return []
  }
}

/**
 * Fallback artifact discovery from disk when the build output was quiet.
 *
 * @param {{ projectPath: string, target: string,
 *           readdir?: Function, stat?: Function, fileExists?: Function }} args
 * @returns {string[]}
 */
export function collectArtifactsFromDisk({ projectPath, target, readdir = readdirSync, stat = statSync, fileExists = existsSync } = {}) {
  const root = typeof projectPath === 'string' ? projectPath : ''
  if (root === '') return []
  const found = []
  for (const spec of artifactDirsFor(target)) {
    const absolute = path.join(root, spec.dir)
    try {
      if (spec.match === null) {
        if (fileExists(absolute) && stat(absolute).isDirectory()) found.push(absolute)
        continue
      }
      for (const entry of readdir(absolute)) {
        if (spec.match.test(String(entry))) found.push(path.join(absolute, String(entry)))
      }
    } catch {
      /* not built yet */
    }
  }
  return found
}

/* ------------------------------------------------------------------ */
/* Tool path resolution                                                */
/* ------------------------------------------------------------------ */

/**
 * Resolve the flutter/dart binaries: configured setting first, then PATH, then
 * the `dart` that ships inside the Flutter SDK.
 *
 * @param {{ flutterPath?: string, dartPath?: string, env?: object,
 *           platform?: NodeJS.Platform, fileExists?: Function, dirExists?: Function }} [args]
 * @returns {{ flutterPath: string|null, dartPath: string|null,
 *             source: 'config'|'PATH'|'missing', flutterSource: string|null,
 *             dartSource: string|null }}
 */
export function resolveToolPaths({
  flutterPath = '',
  dartPath = '',
  env = process.env,
  platform = process.platform,
  fileExists = existsSync,
  dirExists = undefined,
} = {}) {
  const common = { env, platform, fileExists, ...(dirExists === undefined ? {} : { dirExists }) }
  const flutter = resolveBinaryPath({ configured: flutterPath, name: 'flutter', ...common })
  let dart = resolveBinaryPath({ configured: dartPath, name: 'dart', ...common })
  if (dart === null && flutter !== null) {
    const binDir = path.dirname(flutter.path)
    const names = platform === 'win32' ? ['dart.exe', 'dart.bat', 'dart'] : ['dart', 'dart.exe']
    const candidates = []
    for (const name of names) candidates.push(path.join(binDir, 'cache', 'dart-sdk', 'bin', name))
    for (const name of names) candidates.push(path.join(binDir, name))
    for (const candidate of candidates) {
      if (fileExists(candidate)) {
        dart = { path: candidate, source: flutter.source }
        break
      }
    }
  }
  const sources = [flutter?.source, dart?.source].filter((item) => typeof item === 'string')
  const source = sources.includes('config') ? 'config' : sources.length > 0 ? 'PATH' : 'missing'
  return {
    flutterPath: flutter === null ? null : flutter.path,
    dartPath: dart === null ? null : dart.path,
    source,
    flutterSource: flutter === null ? null : flutter.source,
    dartSource: dart === null ? null : dart.source,
  }
}

/* ------------------------------------------------------------------ */
/* Toolchain service                                                   */
/* ------------------------------------------------------------------ */

const MISSING_HINT = 'Flutter/Dart SDK not found. Install the Flutter SDK or set flutterPath/dartPath in the workbench settings.'

/**
 * @param {{ settings?: any, logs?: any, bus?: any, logger?: any,
 *          spawn?: Function, killTree?: Function, env?: object,
 *          platform?: NodeJS.Platform, fileExists?: Function, now?: Function,
 *          pathCacheTtlMs?: number }} deps
 */
export function createToolchain({
  settings = null,
  logs = null,
  bus = null,
  logger = null,
  spawn: spawnImpl = spawn,
  killTree = killProcessTree,
  env = process.env,
  platform = process.platform,
  fileExists = existsSync,
  now = nowMs,
  pathCacheTtlMs = PATH_CACHE_TTL_MS,
} = {}) {
  let cache = { at: 0, key: '', value: null }
  let activeJobs = 0

  function settingsSnapshot() {
    try {
      const value = settings?.get?.()
      return value !== null && typeof value === 'object' ? value : {}
    } catch {
      return {}
    }
  }

  /** Cached `{ flutterPath, dartPath, source }` (re-resolved when settings change or TTL expires). */
  function resolvePaths() {
    const current = settingsSnapshot()
    const key = `${current.flutterPath ?? ''}\u0000${current.dartPath ?? ''}`
    const timestamp = now()
    if (cache.value !== null && cache.key === key && timestamp - cache.at < pathCacheTtlMs) return cache.value
    const value = resolveToolPaths({
      flutterPath: current.flutterPath ?? '',
      dartPath: current.dartPath ?? '',
      env,
      platform,
      fileExists,
    })
    cache = { at: timestamp, key, value }
    return value
  }

  function invalidate() {
    cache = { at: 0, key: '', value: null }
  }

  function appendLog(level, text, meta = null) {
    const value = String(text ?? '')
    if (value === '' || logs === null || typeof logs.append !== 'function') return null
    try {
      return logs.append({ source: 'toolchain', level, text: value, meta })
    } catch {
      return null
    }
  }

  function emitProgress(payload) {
    if (bus !== null && typeof bus.emit === 'function') {
      try {
        bus.emit('job:progress', payload)
      } catch {
        /* a listener must never break a run */
      }
    }
  }

  function missing(what) {
    const message = `${what} executable not found. ${MISSING_HINT}`
    appendLog('error', message, { code: 'toolchain-missing' })
    return { ok: false, code: 'toolchain-missing', message }
  }

  function normalizeProjectPath(projectPath) {
    return typeof projectPath === 'string' && projectPath.trim() !== '' ? projectPath.trim() : null
  }

  /**
   * Spawn one command, stream its tail to `job:progress`, honor the timeout and
   * kill the whole tree. Never rejects.
   */
  function execute({ action, file, args, cwd, timeoutMs, projectPath = null, maxBytes = MAX_RAW_BYTES }) {
    const startedAt = now()
    const limit = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS
    appendLog('info', `$ ${file} ${args.join(' ')}`, { action, cwd, projectPath })
    emitProgress({
      action,
      projectPath,
      phase: 'start',
      command: `${file} ${args.join(' ')}`,
      cwd,
      timeoutMs: limit,
      at: startedAt,
    })
    return new Promise((resolve) => {
      const result = {
        ok: false,
        action,
        code: null,
        stdout: '',
        stderr: '',
        output: '',
        timedOut: false,
        error: null,
        durationMs: 0,
      }
      let child
      const spec = buildSpawnSpec(file, args)
      try {
        child = spawnImpl(spec.file, spec.args, {
          cwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          ...spec.options,
        })
      } catch (error) {
        const normalized = normalizeError(error)
        result.error = normalized.message
        finish(`spawn failed: ${normalized.message}`)
        return
      }

      const append = (key, chunk) => {
        if (result[key].length >= maxBytes) return
        result[key] += chunk
      }
      let lastProgress = 0
      let settled = false

      const finish = (note = null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        result.output = result.stdout + (result.stderr === '' ? '' : `\n${result.stderr}`)
        result.durationMs = Math.max(0, now() - startedAt)
        result.ok = !result.timedOut && result.error === null && result.code !== null
        emitProgress({
          action,
          projectPath,
          phase: 'end',
          tail: tailOf(result.output),
          exitCode: result.code,
          ok: result.ok,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          at: now(),
          ...(note === null ? {} : { note }),
        })
        appendLog(
          result.ok ? 'info' : 'warn',
          `${action} finished code=${result.code ?? 'null'}${result.timedOut ? ' (timeout)' : ''} in ${result.durationMs}ms`,
          { action, projectPath, exitCode: result.code, timedOut: result.timedOut },
        )
        resolve(result)
      }

      const streamProgress = (chunk) => {
        const timestamp = now()
        if (timestamp - lastProgress < PROGRESS_INTERVAL_MS) return
        lastProgress = timestamp
        emitProgress({
          action,
          projectPath,
          phase: 'output',
          tail: tailOf((result.stdout + result.stderr).slice(-4000)),
          at: timestamp,
        })
      }

      child.stdout?.setEncoding?.('utf8')
      child.stderr?.setEncoding?.('utf8')
      child.stdout?.on('data', (chunk) => {
        append('stdout', String(chunk))
        streamProgress(chunk)
      })
      child.stderr?.on('data', (chunk) => {
        append('stderr', String(chunk))
        streamProgress(chunk)
      })
      child.on('error', (error) => {
        result.error = normalizeError(error).message
      })
      child.on('close', (code, signal) => {
        result.code = Number.isInteger(code) ? code : null
        if (result.error === null && signal !== null && signal !== undefined && result.timedOut === false) {
          result.error = `terminated by ${signal}`
        }
        finish()
      })
      const timer = setTimeout(() => {
        if (child.exitCode !== null || settled) return
        result.timedOut = true
        result.error = `timed out after ${limit}ms`
        appendLog('error', `${action} timed out after ${limit}ms; killing process tree`, { action, projectPath })
        killTree(child, { force: true })
        // If the tree refuses to die, settle anyway so the caller never hangs.
        setTimeout(() => finish('timeout'), 2000).unref?.()
      }, limit)
      if (typeof timer.unref === 'function') timer.unref()
    })
  }

  /* ------------------------------- actions ------------------------------- */

  async function analyze({ projectPath, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const root = normalizeProjectPath(projectPath)
    const empty = { issues: [], counts: { error: 0, warning: 0, info: 0 }, raw: '' }
    if (root === null) return { ok: false, code: 'bad-request', message: 'projectPath is required', ...empty }
    const paths = resolvePaths()
    if (paths.dartPath === null) return { ...missing('dart'), ...empty }
    const run = await execute({
      action: 'analyze',
      file: paths.dartPath,
      args: ['analyze', '--format', 'machine'],
      cwd: root,
      timeoutMs,
      projectPath: root,
    })
    const issues = parseAnalyzeMachine(run.stdout)
    const counts = summarizeIssues(issues)
    const base = { issues, counts, raw: truncate(run.output, 200000), exitCode: run.code, durationMs: run.durationMs }
    if (run.timedOut) return { ok: false, code: 'timeout', message: run.error ?? 'analyze timed out', ...base }
    if (run.code === null) return { ok: false, code: 'toolchain-error', message: run.error ?? 'analyze failed to run', ...base }
    return { ok: counts.error === 0, ...base }
  }

  async function test({ projectPath, target, name, timeoutMs = TEST_TIMEOUT_MS } = {}) {
    const root = normalizeProjectPath(projectPath)
    const empty = { passed: 0, failed: 0, skipped: 0, durationMs: 0, tests: [], raw: '', failedTests: [] }
    if (root === null) return { ok: false, code: 'bad-request', message: 'projectPath is required', ...empty }
    const paths = resolvePaths()
    if (paths.flutterPath === null) return { ...missing('flutter'), ...empty }
    const args = ['test', '--reporter', 'json']
    if (typeof name === 'string' && name.trim() !== '') args.push('--name', name.trim())
    if (typeof target === 'string' && target.trim() !== '') args.push(target.trim())
    const run = await execute({
      action: 'test',
      file: paths.flutterPath,
      args,
      cwd: root,
      timeoutMs,
      projectPath: root,
    })
    const parsed = parseTestJson(run.stdout)
    const base = { ...parsed, raw: truncate(run.output, 200000), exitCode: run.code }
    if (run.timedOut) return { ok: false, code: 'timeout', message: run.error ?? 'test run timed out', ...base }
    if (run.code === null) return { ok: false, code: 'toolchain-error', message: run.error ?? 'test failed to run', ...base }
    return { ok: run.code === 0 && parsed.failed === 0, ...base }
  }

  async function pubGet({ projectPath, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    return simpleFlutterAction('pubGet', ['pub', 'get'], { projectPath, timeoutMs })
  }

  async function clean({ projectPath, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    return simpleFlutterAction('clean', ['clean'], { projectPath, timeoutMs })
  }

  async function doctor({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const paths = resolvePaths()
    if (paths.flutterPath === null) return { ...missing('flutter'), output: '' }
    const run = await execute({
      action: 'doctor',
      file: paths.flutterPath,
      args: ['doctor', '-v'],
      cwd: os.homedir(),
      timeoutMs,
    })
    if (run.timedOut) return { ok: false, code: 'timeout', message: run.error ?? 'doctor timed out', output: truncate(run.output, 40000) }
    return { ok: run.code === 0, output: truncate(run.output, 40000), exitCode: run.code }
  }

  async function format({ projectPath, paths: targetPaths, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const root = normalizeProjectPath(projectPath)
    if (root === null) return { ok: false, code: 'bad-request', message: 'projectPath is required', output: '' }
    const resolved = resolvePaths()
    if (resolved.dartPath === null) return { ...missing('dart'), output: '' }
    const list = Array.isArray(targetPaths) ? targetPaths.map((item) => String(item)).filter((item) => item !== '') : []
    const run = await execute({
      action: 'format',
      file: resolved.dartPath,
      args: ['format', ...(list.length === 0 ? ['.'] : list)],
      cwd: root,
      timeoutMs,
      projectPath: root,
    })
    if (run.timedOut) return { ok: false, code: 'timeout', message: run.error ?? 'format timed out', output: truncate(run.output, 40000) }
    return { ok: run.code === 0, output: truncate(run.output, 40000), exitCode: run.code }
  }

  async function build({ projectPath, target = 'apk', extraArgs = [], timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const root = normalizeProjectPath(projectPath)
    const chosen = String(target ?? '').trim()
    if (root === null) return { ok: false, code: 'bad-request', message: 'projectPath is required', output: '', artifacts: [] }
    if (!BUILD_TARGETS.includes(chosen)) {
      return {
        ok: false,
        code: 'bad-request',
        message: `unsupported build target "${chosen}" (expected one of ${BUILD_TARGETS.join(', ')})`,
        output: '',
        artifacts: [],
      }
    }
    const paths = resolvePaths()
    if (paths.flutterPath === null) return { ...missing('flutter'), output: '', artifacts: [] }
    const args = ['build', chosen]
    for (const extra of Array.isArray(extraArgs) ? extraArgs : []) args.push(String(extra))
    const run = await execute({
      action: 'build',
      file: paths.flutterPath,
      args,
      cwd: root,
      timeoutMs,
      projectPath: root,
    })
    const fromOutput = parseBuildArtifacts(run.output)
    let artifacts = fromOutput
    if (artifacts.length === 0) {
      artifacts = collectArtifactsFromDisk({ projectPath: root, target: chosen, fileExists })
    }
    const base = { output: truncate(run.output, 40000), artifacts, exitCode: run.code, durationMs: run.durationMs }
    if (run.timedOut) return { ok: false, code: 'timeout', message: run.error ?? 'build timed out', ...base }
    if (run.code === null) return { ok: false, code: 'toolchain-error', message: run.error ?? 'build failed to run', ...base }
    return { ok: run.code === 0, ...base }
  }

  async function simpleFlutterAction(action, args, { projectPath, timeoutMs }) {
    const root = normalizeProjectPath(projectPath)
    if (root === null) return { ok: false, code: 'bad-request', message: 'projectPath is required', output: '' }
    const paths = resolvePaths()
    if (paths.flutterPath === null) return { ...missing('flutter'), output: '' }
    const run = await execute({ action, file: paths.flutterPath, args, cwd: root, timeoutMs, projectPath: root })
    if (run.timedOut) return { ok: false, code: 'timeout', message: run.error ?? `${action} timed out`, output: truncate(run.output, 40000) }
    if (run.code === null) return { ok: false, code: 'toolchain-error', message: run.error ?? `${action} failed to run`, output: truncate(run.output, 40000) }
    return { ok: run.code === 0, output: truncate(run.output, 40000), exitCode: run.code }
  }

  async function devices() {
    const paths = resolvePaths()
    if (paths.flutterPath === null) {
      appendLog('warn', `devices unavailable: ${MISSING_HINT}`)
      return []
    }
    try {
      return await listDevices({ flutterPath: paths.flutterPath, env })
    } catch (error) {
      appendLog('warn', `devices failed: ${normalizeError(error).message}`)
      return []
    }
  }

  async function emulators() {
    const paths = resolvePaths()
    if (paths.flutterPath === null) {
      appendLog('warn', `emulators unavailable: ${MISSING_HINT}`)
      return []
    }
    try {
      return await listEmulators({ flutterPath: paths.flutterPath, env })
    } catch (error) {
      appendLog('warn', `emulators failed: ${normalizeError(error).message}`)
      return []
    }
  }

  return {
    analyze,
    test,
    pubGet,
    clean,
    build,
    doctor,
    format,
    devices,
    emulators,
    resolvePaths,
    /** Force the next resolvePaths() to re-read settings (used after a settings PUT). */
    invalidatePaths: invalidate,
    _internal: {
      execute,
      tailOf,
      activeJobs: () => activeJobs,
    },
  }
}

/** Last `limit` characters of a text blob (for progress payloads). */
export function tailOf(text, limit = TAIL_CHARS) {
  const value = String(text ?? '')
  if (value.length <= limit) return value
  return value.slice(value.length - limit)
}