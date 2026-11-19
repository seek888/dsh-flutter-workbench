/**
 * Device discovery regressions.
 *
 * The bug these lock down: the Flutter SDK ships an extension-less `bin/flutter`
 * shell script next to `bin/flutter.bat`. Picking the extension-less one made
 * `spawn` fail with ENOENT, which emptied the device list and broke `flutter run`
 * on Windows. Parsing also had to survive the mirror notice Flutter prints before
 * its JSON.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  buildSpawnSpec,
  parseDevicesMachine,
  parseDevicesPlain,
  resolveBinaryPath,
  resolveSpawnExecutable,
} from '../host/runconfig.js'

const isWindows = process.platform === 'win32'

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'fwb-device-'))
  try {
    return await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('resolveSpawnExecutable prefers the .bat sibling of an extension-less path', async () => {
  await withTempDir(async (dir) => {
    const bare = join(dir, 'flutter')
    await writeFile(bare, '#!/bin/sh\n')
    await writeFile(`${bare}.bat`, '@echo off\n')
    assert.equal(resolveSpawnExecutable(bare), `${bare}.bat`)
  })
})

test('resolveSpawnExecutable falls back to .exe and then to the input', async () => {
  await withTempDir(async (dir) => {
    const bare = join(dir, 'dart')
    await writeFile(`${bare}.exe`, 'MZ')
    assert.equal(resolveSpawnExecutable(bare), `${bare}.exe`)
    const missing = join(dir, 'nothing-here')
    assert.equal(resolveSpawnExecutable(missing), missing)
    // A bare command name (no separator) is left to the shell's PATHEXT.
    assert.equal(resolveSpawnExecutable('flutter'), 'flutter')
    // An already-extensioned path is untouched.
    assert.equal(resolveSpawnExecutable(`${bare}.exe`), `${bare}.exe`)
  })
})

test('resolveBinaryPath prefers a spawnable sibling over the shell script', async () => {
  await withTempDir(async (dir) => {
    const bare = join(dir, 'flutter')
    await writeFile(bare, '#!/bin/sh\n')
    await writeFile(`${bare}.bat`, '@echo off\n')
    const found = resolveBinaryPath({ configured: '', name: 'flutter', platform: 'win32', env: { PATH: dir } })
    assert.equal(found.path, `${bare}.bat`)
    assert.equal(found.source, 'PATH')

    // An explicitly configured extension-less path gets the same treatment.
    const configured = resolveBinaryPath({ configured: bare, name: 'flutter', platform: 'win32', env: { PATH: dir } })
    assert.equal(configured.path, `${bare}.bat`)
    assert.equal(configured.source, 'config')
  })
})

test('parseDevicesMachine survives the mirror notice that precedes the JSON', () => {
  const text = [
    'Flutter assets will be downloaded from https://storage.flutter-io.cn. Make sure you trust this source!',
    '[',
    '  {"name":"Windows","id":"windows","isSupported":true,"targetPlatform":"windows-x64","emulator":false,',
    '   "sdk":"Microsoft Windows 11","capabilities":{"hotReload":true,"screenshot":false}},',
    '  {"name":"Edge","id":"edge","isSupported":false,"targetPlatform":"web-javascript","emulator":false}',
    ']',
  ].join('\n')
  const devices = parseDevicesMachine(text)
  assert.equal(devices.length, 2)
  assert.deepEqual(devices[0], {
    id: 'windows',
    name: 'Windows',
    platform: 'windows',
    emulator: false,
    supported: true,
    targetPlatform: 'windows-x64',
    sdk: 'Microsoft Windows 11',
    capabilities: { hotReload: true, screenshot: false },
  })
  assert.equal(devices[1].supported, false)
  assert.equal(devices[1].sdk, null)
})

test('parseDevicesMachine handles an empty list and junk', () => {
  assert.deepEqual(parseDevicesMachine('[]'), [])
  assert.equal(parseDevicesMachine(''), null)
  assert.equal(parseDevicesMachine('no json here'), null)
  assert.equal(parseDevicesMachine('[{"no":"id"}]').length, 0)
})

test('parseDevicesPlain reads the human table', () => {
  const text = [
    'Found 2 connected devices:',
    'Windows (desktop) • windows • windows-x64    • Microsoft Windows 11',
    'Edge (web)        • edge    • web-javascript • Microsoft Edge 100.0.1185.36',
    '',
    'Run "flutter emulators" to list emulators.',
  ].join('\n')
  const devices = parseDevicesPlain(text)
  assert.equal(devices.length, 2)
  assert.equal(devices[0].id, 'windows')
  assert.equal(devices[0].name, 'Windows')
  assert.equal(devices[0].targetPlatform, 'windows-x64')
  assert.equal(devices[1].id, 'edge')
})

test('buildSpawnSpec runs a .bat through the shell on Windows', () => {
  if (isWindows === false) return
  const spec = buildSpawnSpec('C:\\flutter\\bin\\flutter.bat', ['devices', '--machine'])
  assert.equal(spec.options.shell, true)
  assert.ok(spec.file.includes('flutter.bat'))
  assert.equal(spec.args.length, 0, 'the whole command line goes through the shell')
})