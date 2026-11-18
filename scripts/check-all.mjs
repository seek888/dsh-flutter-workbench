#!/usr/bin/env node
/**
 * Syntax-check every JavaScript file in the bundle.
 * The generated `client/client.js` is checked by the build step; Host files are
 * checked here so a broken module fails before installation, not at activation.
 */
import { readdir, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

async function walk(dir, out = []) {
  for (const name of await readdir(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const full = join(dir, name)
    const info = await stat(full)
    if (info.isDirectory()) await walk(full, out)
    else if (name.endsWith('.js') || name.endsWith('.mjs')) out.push(full)
  }
  return out
}

const files = (await walk(root)).filter((file) => relative(root, file).startsWith('client') === false)
let failed = 0
for (const file of files) {
  try {
    await run(process.execPath, ['--check', file])
  } catch (error) {
    failed += 1
    process.stderr.write(`check-all: FAIL ${relative(root, file)}\n${error.stderr ?? ''}\n`)
  }
}
process.stdout.write(`check-all: ${files.length - failed}/${files.length} files ok\n`)
if (failed > 0) process.exit(1)