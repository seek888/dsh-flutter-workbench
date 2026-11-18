/**
 * Project + run-config discovery for the Flutter workbench.
 *
 * Everything cheap and filesystem-bound lives here: `pubspec.yaml`/platform
 * detection, VS Code `launch.json` (JSONC) parsing, `lib/main*.dart` entry
 * points, `flutter devices --machine`, `flutter emulators`, android/ios flavors
 * and the aggregate `discoverConfigs()` the HTTP API hands to the panel.
 *
 * Pure helpers (`stripJsonc`, `parseLaunchJson`, `normalizeLaunchConfigs`,
 * `parsePubspec`, `parseDevicesMachine`, …) are exported separately so the unit
 * tests never touch a real filesystem or a Flutter SDK.
 */
import { spawn } from 'node:child_process'
import { existsSync, promises as fs, readdirSync } from 'node:fs'
import path from 'node:path'

import { nowMs, safeJson, truncate } from './util.js'

export const DEFAULT_PROGRAM = 'lib/main.dart'
/** Flutter platform folders we advertise as "enabled" for a project. */
export const PLATFORM_DIRS = ['android', 'ios', 'web', 'windows', 'macos', 'linux']
/** `flutter run` modes; anything else is coerced to `debug`. */
export const RUN_MODES = ['debug', 'profile', 'release']

const LAUNCH_RELATIVE = path.join('.vscode', 'launch.json')
const DEVICE_TIMEOUT_MS = 30000

/* ------------------------------------------------------------------ */
/* JSONC (VS Code launch.json)                                         */
/* ------------------------------------------------------------------ */

/**
 * Copy a JSON string literal verbatim (handles escapes) so comment/whitespace
 * stripping can never corrupt a value that happens to contain `//`.
 * Returns the index just past the closing quote.
 */
function copyString(source, start) {
  let index = start + 1
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') {
      index += 2
      continue
    }
    index += 1
    if (char === '"') break
  }
  return index
}

/**
 * Strip `//` line comments and `/* *\/` block comments from JSONC text.
 * String literals are preserved byte for byte.
 */
export function stripJsonc(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '')
  let out = ''
  let index = 0
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === '"') {
      const end = copyString(source, index)
      out += source.slice(index, end)
      index = end
      continue
    }
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
      index += 2
      continue
    }
    out += char
    index += 1
  }
  return out
}

/**
 * Remove trailing commas before `}` / `]`, string-aware.
 */
export function stripTrailingCommas(text) {
  const source = String(text ?? '')
  let out = ''
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (char === '"') {
      const end = copyString(source, index)
      out += source.slice(index, end)
      index = end
      continue
    }
    if (char === ',') {
      let look = index + 1
      while (look < source.length && /\s/.test(source[look])) look += 1
      if (source[look] === '}' || source[look] === ']') {
        index += 1
        continue
      }
    }
    out += char
    index += 1
  }
  return out
}

/**
 * Parse a VS Code `launch.json` (JSONC: comments + trailing commas allowed).
 * Never throws: a broken file yields `configurations: []` plus `error`.
 *
 * @param {string} text raw file contents
 * @returns {{ version: unknown, configurations: object[], error: string|null }}
 */
export function parseLaunchJson(text) {
  const raw = String(text ?? '')
  if (raw.trim() === '') return { version: undefined, configurations: [], error: null }
  const cleaned = stripTrailingCommas(stripJsonc(raw))
  const parsed = safeJson(cleaned, undefined)
  if (parsed === undefined || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { version: undefined, configurations: [], error: 'launch.json is not valid JSON' }
  }
  const configurations = Array.isArray(parsed.configurations) ? parsed.configurations.filter((item) => item !== null && typeof item === 'object') : []
  return { version: parsed.version, configurations, error: null }
}

/* ------------------------------------------------------------------ */
/* pubspec.yaml                                                        */
/* ------------------------------------------------------------------ */

function unquote(value) {
  const text = String(value ?? '').trim()
  if (text.length >= 2 && (text[0] === "'" || text[0] === '"') && text[text.length - 1] === text[0]) {
    return text.slice(1, -1)
  }
  return text
}

/**
 * Minimal indentation-aware pubspec reader: name, description, the Dart SDK
 * constraint and whether Flutter is actually a dependency.
 *
 * @param {string} text
 * @returns {{ name: string|null, description: string|null, sdkConstraint: string|null, hasFlutter: boolean }}
 */
export function parsePubspec(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  let name = null
  let description = null
  let sdkConstraint = null
  let hasFlutter = false
  let section = null
  for (const raw of lines) {
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = raw.length - raw.replace(/^\s+/, '').length
    if (indent === 0) {
      const top = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(trimmed)
      if (top !== null) {
        section = top[1]
        if (section === 'name' && name === null) name = unquote(top[2]) || null
        if (section === 'description' && description === null) description = unquote(top[2]) || null
      }
      continue
    }
    if (section === 'environment') {
      const sdk = /^sdk\s*:\s*(.+)$/.exec(trimmed)
      if (sdk !== null) sdkConstraint = unquote(sdk[1]) || null
      continue
    }
    if (section === 'dependencies' || section === 'dev_dependencies') {
      if (/^flutter\s*:\s*$/.test(trimmed)) hasFlutter = true
      if (/^flutter\s*:\s*\S+/.test(trimmed)) hasFlutter = true
      if (/^sdk\s*:\s*flutter\b/.test(trimmed)) hasFlutter = true
    }
  }
  return { name, description, sdkConstraint, hasFlutter }
}

/* ------------------------------------------------------------------ */
/* Flavors                                                             */
/* ------------------------------------------------------------------ */

const GRADLE_NON_FLAVOR_KEYS = new Set([
  'dimension',
  'applicationId',
  'applicationIdSuffix',
  'versionCode',
  'versionName',
  'versionNameSuffix',
  'signingConfig',
  'buildConfigField',
  'manifestPlaceholders',
  'resValue',
  'proguardFiles',
  'proguardFile',
  'minifyEnabled',
  'shrinkResources',
  'consumerProguardFiles',
  'initWith',
  'multiDexEnabled',
  'matchingFallbacks',
  'testInstrumentationRunner',
])

/** Extract the `{...}` block that follows `keyword`, respecting nesting. */
function extractBraceBlock(text, keyword) {
  const index = text.search(new RegExp(`${keyword}\\s*\\{`))
  if (index < 0) return null
  let cursor = text.indexOf('{', index)
  if (cursor < 0) return null
  let depth = 0
  const start = cursor
  for (; cursor < text.length; cursor += 1) {
    const char = text[cursor]
    if (char === '"') {
      cursor = copyString(text, cursor) - 1
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start + 1, cursor)
    }
  }
  return null
}

/**
 * Android `productFlavors { free { ... } paid { ... } }` → `['free','paid']`.
 * Works for both Groovy (`build.gradle`) and Kotlin (`build.gradle.kts`).
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseGradleFlavors(text) {
  const source = String(text ?? '')
  const block = extractBraceBlock(source, 'productFlavors')
  if (block === null) return []
  const flavors = []
  let depth = 0
  for (const raw of block.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('//')) continue
    if (depth === 0) {
      const declaration = /^([A-Za-z_][\w-]*)\s*(?:[{:]|=)/.exec(line)
      if (declaration !== null && !GRADLE_NON_FLAVOR_KEYS.has(declaration[1]) && declaration[1] !== 'productFlavors') {
        flavors.push(declaration[1])
      }
      const objectDecl = /^\{\s*([A-Za-z_][\w-]*)\s*=/.exec(line)
      if (objectDecl !== null && !GRADLE_NON_FLAVOR_KEYS.has(objectDecl[1])) flavors.push(objectDecl[1])
    }
    depth += (line.match(/\{/g) ?? []).length
    depth -= (line.match(/\}/g) ?? []).length
    if (depth < 0) depth = 0
  }
  return dedupe(flavors)
}

/**
 * iOS flavor xcconfig files: `ios/Flutter/Dev.xcconfig` → `Dev`.
 *
 * @param {string[]} names file basenames (with or without directories)
 * @returns {string[]}
 */
export function parseXcconfigFlavors(names) {
  const ignored = new Set(['generated', 'debug', 'release', 'flutter', 'app', 'runner', 'pods'])
  const flavors = []
  for (const name of Array.isArray(names) ? names : []) {
    const base = String(name ?? '').split(/[\\/]/).pop() ?? ''
    if (!/\.xcconfig$/i.test(base)) continue
    let stem = base.replace(/\.xcconfig$/i, '')
    stem = stem.replace(/-(debug|release|profile)$/i, '')
    if (stem === '' || ignored.has(stem.toLowerCase())) continue
    flavors.push(stem)
  }
  return dedupe(flavors)
}

/** `--flavor x` / `--flavor=x` and `"flavor": "x"` from launch configs. */
export function extractFlavorsFromConfigs(configs) {
  const flavors = []
  for (const config of Array.isArray(configs) ? configs : []) {
    if (config === null || typeof config !== 'object') continue
    if (typeof config.flavor === 'string' && config.flavor.trim() !== '') flavors.push(config.flavor.trim())
    for (const arg of Array.isArray(config.args) ? config.args : []) flavors.push(...flavorFromArg(arg))
  }
  return dedupe(flavors)
}

function flavorFromArg(arg) {
  const text = String(arg ?? '').trim()
  if (text === '--flavor') return []
  const eq = /^--flavor=(.+)$/.exec(text)
  if (eq !== null) return [eq[1].trim()].filter((item) => item !== '')
  return []
}

function dedupe(values) {
  const seen = new Set()
  const out = []
  for (const value of values) {
    const key = String(value)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Entry points                                                        */
/* ------------------------------------------------------------------ */

/**
 * `lib/main*.dart` files, default entry point first.
 *
 * @param {{ projectPath: string }} args
 * @returns {Promise<{ program: string, label: string, hint: string }[]>}
 */
export async function discoverEntryPoints({ projectPath } = {}) {
  const root = typeof projectPath === 'string' ? projectPath.trim() : ''
  if (root === '') return []
  let names = []
  try {
    const dir = await fs.readdir(path.join(root, 'lib'), { withFileTypes: true })
    names = dir.filter((entry) => entry.isFile() && /^main.*\.dart$/.test(entry.name)).map((entry) => entry.name)
  } catch {
    return []
  }
  names.sort((a, b) => {
    if (a === 'main.dart') return -1
    if (b === 'main.dart') return 1
    return a.localeCompare(b)
  })
  return names.map((name) => ({
    program: `lib/${name}`,
    label: name.replace(/\.dart$/, ''),
    hint: name === 'main.dart' ? 'default entry point' : `alternate entry point (${name})`,
  }))
}

/* ------------------------------------------------------------------ */
/* launch.json → RunConfig                                             */
/* ------------------------------------------------------------------ */

function optionalString(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

function toStringArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item))
  if (typeof value === 'string' && value.trim() !== '') return [value]
  return []
}

function normalizeEnv(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const env = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue
    env[String(key)] = String(item)
  }
  return env
}

function normalizeMode(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (text === 'profile' || text === 'release' || text === 'debug') return text
  return 'debug'
}

function detectModeArg(args) {
  for (const arg of args) {
    const text = String(arg).trim()
    if (text === '--release') return 'release'
    if (text === '--profile') return 'profile'
    if (text === '--debug') return 'debug'
  }
  return null
}

function detectFlavorArg(args) {
  for (let index = 0; index < args.length; index += 1) {
    const text = String(args[index]).trim()
    if (text === '--flavor') {
      const next = args[index + 1]
      if (next !== undefined && String(next).trim() !== '' && !String(next).startsWith('-')) return String(next).trim()
    }
    const inline = /^--flavor=(.+)$/.exec(text)
    if (inline !== null) return inline[1].trim()
  }
  return null
}

/** Collect `--dart-define` / `--dart-define-from-file` values into an object. */
export function collectDartDefines(raw, args = []) {
  const defines = {}
  const push = (pair) => {
    const text = String(pair ?? '')
    const split = text.indexOf('=')
    if (split <= 0) return
    const key = text.slice(0, split).trim()
    if (key === '') return
    defines[key] = text.slice(split + 1)
  }
  const source = raw?.dartDefines ?? raw?.dartDefine ?? null
  if (Array.isArray(source)) for (const item of source) push(item)
  else if (typeof source === 'string') for (const item of source.split(',')) push(item)
  else if (source !== null && typeof source === 'object') {
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined || value === null) continue
      defines[String(key)] = String(value)
    }
  }
  for (let index = 0; index < args.length; index += 1) {
    const text = String(args[index])
    const eq = /^--dart-define=(.+)$/.exec(text)
    if (eq !== null) push(eq[1])
    else if (text === '--dart-define') {
      const next = args[index + 1]
      if (next !== undefined) push(next)
    }
  }
  return defines
}

/** Drop flags the runner adds itself so nothing is passed twice. */
export function stripManagedArgs(args) {
  const out = []
  for (let index = 0; index < args.length; index += 1) {
    const text = String(args[index])
    if (text === '--flavor' || text === '--dart-define') {
      index += 1
      continue
    }
    if (/^--flavor=/.test(text) || /^--dart-define=/.test(text)) continue
    if (text === '--debug' || text === '--profile' || text === '--release') continue
    out.push(text)
  }
  return out
}

/** Resolve a config `program` against the project root, POSIX-separated. */
export function resolveProgram(program, projectPath) {
  const raw = optionalString(program) ?? DEFAULT_PROGRAM
  const normalized = raw.replace(/\\/g, '/')
  if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) return normalized
  const root = optionalString(projectPath)
  const relative = normalized.replace(/^\.\//, '')
  return root === null ? relative : `${String(root).replace(/\\/g, '/')}/${relative}`
}

function slugify(value) {
  const text = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return text === '' ? 'launch' : text
}

/**
 * VS Code `configurations` → the workbench `RunConfig` shape (§4).
 *
 * @param {object[]} rawConfigs
 * @param {{ projectPath?: string, source?: 'launch.json'|'entry'|'manual' }} [options]
 * @returns {{ id: string, label: string, source: string, program: string, deviceId: string,
 *            mode: 'debug'|'profile'|'release', flavor: string|null, dartDefines: object,
 *            args: string[], env: object }[]}
 */
export function normalizeLaunchConfigs(rawConfigs, { projectPath = '', source = 'launch.json' } = {}) {
  const list = Array.isArray(rawConfigs) ? rawConfigs : []
  const used = new Set()
  const configs = []
  list.forEach((raw, index) => {
    if (raw === null || typeof raw !== 'object') return
    const label = optionalString(raw.name) ?? optionalString(raw.label) ?? `Launch ${index + 1}`
    const args = toStringArray(raw.args)
    const mode = (raw.flutterMode ?? raw.mode ?? detectModeArg(args)) ?? 'debug'
    const flavor = optionalString(raw.flavor) ?? detectFlavorArg(args)
    const baseId = optionalString(raw.id) ?? slugify(label)
    let id = baseId
    let suffix = 2
    while (used.has(id)) {
      id = `${baseId}-${suffix}`
      suffix += 1
    }
    used.add(id)
    configs.push({
      id,
      label,
      source,
      program: resolveProgram(raw.program, projectPath),
      deviceId: optionalString(raw.deviceId) ?? optionalString(raw.device) ?? '',
      mode: normalizeMode(mode),
      flavor,
      dartDefines: collectDartDefines(raw, args),
      args: stripManagedArgs(args),
      env: normalizeEnv(raw.env),
    })
  })
  return configs
}

/* ------------------------------------------------------------------ */
/* Device / emulator listing                                           */
/* ------------------------------------------------------------------ */

const PLATFORM_PREFIX = [
  ['web-', 'web'],
  ['android', 'android'],
  ['ios', 'ios'],
  ['darwin', 'macos'],
  ['windows', 'windows'],
  ['linux', 'linux'],
  ['fuchsia', 'fuchsia'],
]

/** Map a `targetPlatform` string (`windows-x64`, `web-javascript`, …). */
export function devicePlatform(targetPlatform, fallback = '') {
  const text = String(targetPlatform ?? '').trim().toLowerCase()
  for (const [prefix, platform] of PLATFORM_PREFIX) {
    if (text.startsWith(prefix)) return platform
  }
  const raw = String(fallback ?? '').trim().toLowerCase()
  return raw === '' ? (text === '' ? 'unknown' : text) : raw
}

/**
 * Parse `flutter devices --machine`, which is a single JSON array.
 *
 * @param {string} text
 * @returns {{ id: string, name: string, platform: string, emulator: boolean,
 *            supported: boolean, targetPlatform: string|null }[]|null}
 *          `null` means "not a JSON array" so the caller can fall back.
 */
export function parseDevicesMachine(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return null
  const parsed = safeJson(trimmed, undefined)
  if (!Array.isArray(parsed)) return null
  return parsed
    .filter((item) => item !== null && typeof item === 'object' && item.id !== undefined)
    .map((item) => ({
      id: String(item.id),
      name: optionalString(item.name) ?? String(item.id),
      platform: devicePlatform(item.targetPlatform, item.platform),
      emulator: item.emulator === true,
      supported: item.isSupported !== false,
      targetPlatform: optionalString(item.targetPlatform),
    }))
}

/**
 * Parse human `flutter devices` output as a fallback.
 *
 * @param {string} text
 * @returns {{ id: string, name: string, platform: string, emulator: boolean,
 *            supported: boolean, targetPlatform: string|null }[]}
 */
export function parseDevicesPlain(text) {
  const devices = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || !line.includes('•')) continue
    const parts = line.split('•').map((part) => part.trim())
    if (parts.length < 3) continue
    const name = parts[0].replace(/\s*\((desktop|web|mobile)\)\s*$/i, '').trim()
    const id = parts[1]
    if (id === '' || /^id$/i.test(id)) continue
    const platform = devicePlatform(parts[2])
    devices.push({
      id,
      name: name === '' ? id : name,
      platform,
      emulator: /emulator|simulator/i.test(name) || /emulator|simulator/i.test(parts[2]),
      supported: !/unsupported/i.test(line),
      targetPlatform: parts[2],
    })
  }
  return devices
}

const EMULATOR_PLATFORM_HINTS = [
  ['android', 'android'],
  ['ios', 'ios'],
  ['chrome', 'web'],
  ['web', 'web'],
  ['windows', 'windows'],
  ['macos', 'macos'],
  ['linux', 'linux'],
]

/**
 * Parse `flutter emulators` output (`Id • Name • Manufacturer • Platform`).
 *
 * @param {string} text
 * @returns {{ id: string, name: string, platform: string }[]}
 */
export function parseEmulatorsPlain(text) {
  const emulators = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || !line.includes('•')) continue
    const parts = line.split('•').map((part) => part.trim())
    if (parts.length < 2) continue
    const id = parts[0]
    if (id === '' || /^id$/i.test(id)) continue
    const platformText = (parts[parts.length - 1] ?? '').toLowerCase()
    let platform = 'unknown'
    for (const [hint, value] of EMULATOR_PLATFORM_HINTS) {
      if (platformText.includes(hint)) {
        platform = value
        break
      }
    }
    emulators.push({ id, name: parts[1] === '' ? id : parts[1], platform })
  }
  return emulators
}

/** Parse `flutter emulators --machine` (newer SDKs) if it is a JSON array. */
export function parseEmulatorsMachine(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return null
  const parsed = safeJson(trimmed, undefined)
  if (!Array.isArray(parsed)) return null
  return parsed
    .filter((item) => item !== null && typeof item === 'object' && item.id !== undefined)
    .map((item) => ({
      id: String(item.id),
      name: optionalString(item.name) ?? String(item.id),
      platform: devicePlatform(item.platform ?? item.targetPlatform),
    }))
}

/* ------------------------------------------------------------------ */
/* Binary resolution + child-process helpers (shared by runner/analyze) */
/* ------------------------------------------------------------------ */

const WINDOWS_EXTENSIONS = ['', '.bat', '.cmd', '.exe']

/**
 * Resolve a tool binary from an explicit setting, then from PATH.
 *
 * @param {{ configured?: string, name: string, env?: object, platform?: NodeJS.Platform,
 *          fileExists?: (p: string) => boolean, dirExists?: (p: string) => boolean }} args
 * @returns {{ path: string, source: 'config'|'PATH' }|null}
 */
export function resolveBinaryPath({
  configured = '',
  name,
  env = process.env,
  platform = process.platform,
  fileExists = existsSync,
  dirExists = (target) => {
    try {
      return readdirSync(target) !== undefined
    } catch {
      return false
    }
  },
} = {}) {
  const binary = String(name ?? '').trim()
  if (binary === '') return null
  const configuredText = String(configured ?? '').trim().replace(/^"(.*)"$/, '$1')
  if (configuredText !== '') {
    if (fileExists(configuredText)) return { path: configuredText, source: 'config' }
    if (dirExists(configuredText)) {
      const found = firstExisting(binaryCandidates(configuredText, binary, platform), fileExists)
      if (found !== null) return { path: found, source: 'config' }
      const nested = firstExisting(binaryCandidates(path.join(configuredText, 'bin'), binary, platform), fileExists)
      if (nested !== null) return { path: nested, source: 'config' }
      return null
    }
    if (!configuredText.includes('/') && !configuredText.includes('\\')) {
      const found = firstExisting(pathCandidates(env, binary, platform), fileExists)
      return found === null ? null : { path: found, source: 'config' }
    }
    return null
  }
  const found = firstExisting(pathCandidates(env, binary, platform), fileExists)
  return found === null ? null : { path: found, source: 'PATH' }
}

function binaryCandidates(dir, binary, platform) {
  const extensions = platform === 'win32' ? WINDOWS_EXTENSIONS : ['']
  const out = []
  for (const ext of extensions) out.push(path.join(dir, `${binary}${ext}`))
  return out
}

function pathCandidates(env, binary, platform) {
  const rawPath = env?.PATH ?? env?.Path ?? env?.path ?? ''
  const delimiter = platform === 'win32' ? ';' : ':'
  const dirs = String(rawPath).split(delimiter).map((item) => item.trim()).filter((item) => item !== '')
  const out = []
  for (const dir of dirs) {
    for (const candidate of binaryCandidates(dir, binary, platform)) out.push(candidate)
  }
  return out
}

function firstExisting(candidates, fileExists) {
  for (const candidate of candidates) {
    try {
      if (fileExists(candidate)) return candidate
    } catch {
      /* ignore inaccessible PATH entries */
    }
  }
  return null
}

/** Quote one argument for a Windows `cmd.exe` command line. */
export function quoteWindowsArg(value) {
  const text = String(value ?? '')
  if (text === '') return '""'
  if (!/[\s"&|<>^()]/.test(text)) return text
  return `"${text.replace(/"/g, '\\"')}"`
}

/**
 * Build safe spawn options for a resolved binary: `.bat`/`.cmd` files need a
 * shell on Windows, plain executables do not (so no quoting surprises).
 *
 * @param {string} file
 * @param {string[]} args
 * @returns {{ file: string, args: string[], options: object }}
 */
export function buildSpawnSpec(file, args = []) {
  const isWindows = process.platform === 'win32'
  const list = args.map((item) => String(item))
  const needsShell = isWindows && (/\.(bat|cmd)$/i.test(file) || !/[\\/]/.test(file))
  if (!needsShell) {
    return { file, args: list, options: { shell: false, windowsHide: true } }
  }
  const command = [quoteWindowsArg(file), ...list.map(quoteWindowsArg)].join(' ')
  return { file: command, args: [], options: { shell: true, windowsHide: true } }
}

/**
 * Run a command to completion, capturing output. Never rejects; a timeout or a
 * missing binary is reported in the result so callers can branch on it.
 *
 * @param {{ file: string, args?: string[], cwd?: string, env?: object,
 *           timeoutMs?: number, maxBytes?: number,
 *           onStdout?: (text: string) => void, onStderr?: (text: string) => void }} options
 * @returns {Promise<{ code: number|null, signal: string|null, stdout: string,
 *                     stderr: string, timedOut: boolean, error: string|null }>}
 */
export function runCommand(options) {
  const { file, args = [], cwd = process.cwd(), env = process.env, timeoutMs = 0, maxBytes = 1024 * 1024 } = options ?? {}
  const spec = buildSpawnSpec(file, args)
  return new Promise((resolve) => {
    const result = { code: null, signal: null, stdout: '', stderr: '', timedOut: false, error: null }
    let child
    try {
      child = spawn(spec.file, spec.args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...spec.options,
      })
    } catch (error) {
      resolve({ ...result, error: String(error?.message ?? error) })
      return
    }

    const append = (key, text) => {
      if (result[key].length < maxBytes) result[key] += text
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      append('stdout', chunk)
      options?.onStdout?.(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      append('stderr', chunk)
      options?.onStderr?.(chunk)
    })
    child.on('error', (error) => {
      result.error = String(error?.message ?? error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      result.code = code
      result.signal = signal
      resolve(result)
    })
    const timer = timeoutMs > 0 ? setTimeout(() => {
      if (child.exitCode !== null || child.killed) return
      result.timedOut = true
      killProcessTree(child)
    }, timeoutMs) : null
    if (timer !== null && typeof timer.unref === 'function') timer.unref()
  })
}

/* ------------------------------------------------------------------ */
/* Process-tree kill (no zombie flutter/dart children)                 */
/* ------------------------------------------------------------------ */

/**
 * Kill a child and every process it spawned. On Windows `taskkill /T` is the
 * only reliable way to reap the engine subprocesses behind flutter.bat.
 *
 * @param {import('node:child_process').ChildProcess|null} child
 * @param {{ force?: boolean }} [options]
 */
export function killProcessTree(child, { force = true } = {}) {
  if (child === null || child === undefined) return
  const pid = typeof child.pid === 'number' ? child.pid : null
  try {
    if (pid !== null && process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], {
        windowsHide: true,
        stdio: 'ignore',
        detached: true,
      })
      killer.on('error', () => {})
      killer.unref()
    }
  } catch {
    /* best effort */
  }
  try {
    if (pid !== null && process.platform !== 'win32') {
      try {
        process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM')
      } catch {
        /* the process group may not exist */
      }
    }
    if (typeof child.kill === 'function') child.kill(force ? 'SIGKILL' : 'SIGTERM')
  } catch {
    /* best effort */
  }
}

/* ------------------------------------------------------------------ */
/* Discovery entry points                                              */
/* ------------------------------------------------------------------ */

/**
 * `flutter devices --machine`, falling back to human output.
 *
 * @param {{ flutterPath?: string, timeoutMs?: number, run?: Function, env?: object }} [options]
 * @returns {Promise<{ id: string, name: string, platform: string, emulator: boolean,
 *                    supported: boolean, targetPlatform: string|null }[]>}
 */
export async function listDevices({ flutterPath = '', timeoutMs = DEVICE_TIMEOUT_MS, run, env } = {}) {
  const exec = typeof run === 'function' ? run : runCommand
  const file = optionalString(flutterPath) ?? 'flutter'
  const attempt = async (args) => {
    try {
      const result = await exec({ file, args, timeoutMs, env })
      return typeof result?.stdout === 'string' ? result : { stdout: '', stderr: '', code: null }
    } catch {
      return { stdout: '', stderr: '', code: null }
    }
  }
  const machine = await attempt(['devices', '--machine'])
  const devices = parseDevicesMachine(machine.stdout)
  if (devices !== null) return devices
  const plain = await attempt(['devices'])
  return parseDevicesPlain(plain.stdout)
}

/**
 * `flutter emulators` (machine form on newer SDKs).
 *
 * @param {{ flutterPath?: string, timeoutMs?: number, run?: Function, env?: object }} [options]
 * @returns {Promise<{ id: string, name: string, platform: string }[]>}
 */
export async function listEmulators({ flutterPath = '', timeoutMs = DEVICE_TIMEOUT_MS, run, env } = {}) {
  const exec = typeof run === 'function' ? run : runCommand
  const file = optionalString(flutterPath) ?? 'flutter'
  const attempt = async (args) => {
    try {
      const result = await exec({ file, args, timeoutMs, env })
      return typeof result?.stdout === 'string' ? result : { stdout: '' }
    } catch {
      return { stdout: '' }
    }
  }
  const machine = await attempt(['emulators', '--machine'])
  const emulators = parseEmulatorsMachine(machine.stdout)
  if (emulators !== null) return emulators
  const plain = await attempt(['emulators'])
  return parseEmulatorsPlain(plain.stdout)
}

/** Read a directory listing without throwing. */
async function safeReaddir(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * Android `productFlavors`, iOS xcconfig flavors and `--flavor` mentions in
 * launch.json, deduped in discovery order.
 *
 * @param {{ projectPath: string }} args
 * @returns {Promise<string[]>}
 */
export async function readFlavors({ projectPath } = {}) {
  const root = optionalString(projectPath)
  if (root === null) return []
  const flavors = []

  const gradleFiles = [
    path.join(root, 'android', 'app', 'build.gradle'),
    path.join(root, 'android', 'app', 'build.gradle.kts'),
    path.join(root, 'android', 'build.gradle'),
    path.join(root, 'android', 'build.gradle.kts'),
  ]
  for (const file of gradleFiles) {
    try {
      const text = await fs.readFile(file, 'utf8')
      flavors.push(...parseGradleFlavors(text))
    } catch {
      /* optional file */
    }
  }

  const xcconfigDir = path.join(root, 'ios', 'Flutter')
  const entries = await safeReaddir(xcconfigDir)
  flavors.push(...parseXcconfigFlavors(entries.map((entry) => entry.name)))

  const launchFile = path.join(root, LAUNCH_RELATIVE)
  try {
    const parsed = parseLaunchJson(await fs.readFile(launchFile, 'utf8'))
    flavors.push(...extractFlavorsFromConfigs(parsed.configurations))
  } catch {
    /* optional file */
  }

  return dedupe(flavors)
}

/**
 * Project detection used by the registry (`Project.detected`).
 *
 * @param {{ projectPath: string, run?: Function }} args
 * @returns {Promise<{ ok: boolean, appName: string|null, description: string|null,
 *                     platforms: string[], flavors: string[], sdkConstraint: string|null,
 *                     error: string|null }>}
 */
export async function detectFlutterProject({ projectPath } = {}) {
  const empty = {
    ok: false,
    appName: null,
    description: null,
    platforms: [],
    flavors: [],
    sdkConstraint: null,
    error: null,
  }
  const root = optionalString(projectPath)
  if (root === null) return { ...empty, error: 'projectPath is required' }

  let pubspecText
  try {
    pubspecText = await fs.readFile(path.join(root, 'pubspec.yaml'), 'utf8')
  } catch (error) {
    const reason = error?.code === 'ENOENT' ? 'pubspec.yaml not found' : String(error?.message ?? error)
    return { ...empty, error: `not a Flutter project: ${reason}` }
  }

  const pubspec = parsePubspec(pubspecText)
  const platforms = []
  for (const dir of PLATFORM_DIRS) {
    const entries = await safeReaddir(path.join(root, dir))
    if (entries.length > 0) platforms.push(dir)
    else if (existsSync(path.join(root, dir))) platforms.push(dir)
  }
  const flavors = await readFlavors({ projectPath: root })

  if (!pubspec.hasFlutter) {
    return {
      ...empty,
      appName: pubspec.name,
      description: pubspec.description,
      platforms,
      flavors,
      sdkConstraint: pubspec.sdkConstraint,
      error: 'pubspec.yaml has no flutter dependency (this is a Dart package, not a Flutter app)',
    }
  }

  return {
    ok: true,
    appName: pubspec.name,
    description: pubspec.description,
    platforms,
    flavors,
    sdkConstraint: pubspec.sdkConstraint,
    error: null,
  }
}

/** Pick the most likely device: supported desktop first, then any supported. */
export function defaultDeviceId(devices) {
  const list = Array.isArray(devices) ? devices : []
  const supported = list.filter((device) => device?.supported !== false)
  const preferred = ['windows', 'macos', 'linux']
  for (const id of preferred) {
    const match = supported.find((device) => device.id === id)
    if (match !== undefined) return match.id
  }
  if (supported.length > 0) return supported[0].id
  return list.length > 0 ? list[0].id : ''
}

/** Build `RunConfig`s for bare entry points (no launch.json present). */
export function entryConfigs(entries, { projectPath = '', deviceId = '' } = {}) {
  return (Array.isArray(entries) ? entries : []).map((entry, index) => ({
    id: index === 0 ? 'main' : `main-${index}`,
    label: entry.label,
    source: 'entry',
    program: resolveProgram(entry.program, projectPath),
    deviceId,
    mode: 'debug',
    flavor: null,
    dartDefines: {},
    args: [],
    env: {},
  }))
}

/**
 * Everything the panel needs to offer a run: configs, entry points, devices,
 * emulators, flavors. Missing tools/files become `warnings`, never exceptions.
 *
 * @param {{ projectPath: string, flutterPath?: string, timeoutMs?: number, run?: Function, env?: object }} args
 * @returns {Promise<{ configs: object[], entries: object[], devices: object[],
 *                     emulators: object[], flavors: string[], launchFile: string|null,
 *                     warnings: string[] }>}
 */
export async function discoverConfigs({ projectPath, flutterPath = '', timeoutMs, run, env } = {}) {
  const warnings = []
  const root = optionalString(projectPath)
  const result = {
    configs: [],
    entries: [],
    devices: [],
    emulators: [],
    flavors: [],
    launchFile: null,
    warnings,
  }
  if (root === null) {
    warnings.push('projectPath is required')
    return result
  }

  result.entries = await discoverEntryPoints({ projectPath: root })
  result.flavors = await readFlavors({ projectPath: root })

  const launchFile = path.join(root, LAUNCH_RELATIVE)
  if (existsSync(launchFile)) {
    try {
      const parsed = parseLaunchJson(await fs.readFile(launchFile, 'utf8'))
      result.launchFile = launchFile
      if (parsed.error !== null) warnings.push(`launch.json: ${parsed.error}`)
      result.configs = normalizeLaunchConfigs(parsed.configurations, { projectPath: root, source: 'launch.json' })
    } catch (error) {
      warnings.push(`launch.json: ${String(error?.message ?? error)}`)
    }
  } else {
    warnings.push('no .vscode/launch.json found; entry points are offered as run configurations')
  }

  const binary = resolveBinaryPath({ configured: flutterPath, name: 'flutter', env })
  if (binary === null) {
    warnings.push(`flutter executable not found (configured: "${flutterPath || 'PATH'}"); device and emulator discovery skipped`)
  } else {
    try {
      result.devices = await listDevices({ flutterPath: binary.path, timeoutMs, run, env })
      if (result.devices.length === 0) warnings.push('flutter reported no devices')
    } catch (error) {
      warnings.push(`flutter devices failed: ${String(error?.message ?? error)}`)
    }
    try {
      result.emulators = await listEmulators({ flutterPath: binary.path, timeoutMs, run, env })
    } catch (error) {
      warnings.push(`flutter emulators failed: ${String(error?.message ?? error)}`)
    }
  }

  if (result.configs.length === 0 && result.entries.length > 0) {
    result.configs = entryConfigs(result.entries, { projectPath: root, deviceId: defaultDeviceId(result.devices) })
  }

  result.flavors = dedupe([...result.flavors, ...extractFlavorsFromConfigs(result.configs)])
  return result
}

/** Small helper so other modules can log discovery results consistently. */
export function summarizeDiscovery(discovery) {
  const found = discovery ?? {}
  return truncate(
    `configs=${(found.configs ?? []).length} entries=${(found.entries ?? []).length} ` +
      `devices=${(found.devices ?? []).length} flavors=${(found.flavors ?? []).join(',') || '-'} ` +
      `at=${nowMs()}`,
    400,
  )
}