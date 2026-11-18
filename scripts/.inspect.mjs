import { readFileSync, existsSync, statSync } from 'node:fs'

const files = process.argv.slice(2)
for (const file of files) {
  if (existsSync(file) === false) {
    process.stdout.write(`${file}  MISSING\n`)
    continue
  }
  const text = readFileSync(file, 'utf8')
  const state = text.includes('PLACEHOLDER') ? 'PLACEHOLDER' : 'REAL'
  process.stdout.write(`${file.padEnd(32)} ${String(statSync(file).size).padStart(7)} bytes ${String(text.split('\n').length).padStart(5)} lines  ${state}\n`)
}