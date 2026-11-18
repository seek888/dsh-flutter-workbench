import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const files = process.argv.slice(2)

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const wrapped = `(function () {\n${text}\n})\n`
  const temp = `scripts/.wrap-${file.replace(/[\\/.]/g, '-')}.cjs`
  writeFileSync(temp, wrapped, 'utf8')
  try {
    await run(process.execPath, ['--check', temp])
    process.stdout.write(`${file}: syntax OK\n`)
  } catch (error) {
    const message = String(error.stderr ?? error.message ?? '')
    const match = /\.cjs:(\d+)/.exec(message)
    const line = match === null ? null : Number(match[1]) - 1
    const first = message.split('\n').find((row) => row.includes('Error')) ?? message.split('\n')[0]
    process.stdout.write(`${file}: FAIL${line === null ? '' : ` at line ${line}`}\n${first.trim()}\n`)
    if (line !== null) {
      const lines = wrapped.split('\n')
      for (let i = Math.max(1, line - 3); i <= Math.min(lines.length, line + 3); i++) {
        process.stdout.write(`${String(i - 1).padStart(5)} | ${lines[i - 1]}\n`)
      }
    }
  } finally {
    try {
      rmSync(temp)
    } catch {
      /* ignore */
    }
  }
}