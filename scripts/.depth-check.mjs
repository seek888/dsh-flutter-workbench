import { readFileSync } from 'node:fs'

const file = process.argv[2]
const from = Number(process.argv[3] ?? 1)
const to = Number(process.argv[4] ?? 100000)
const lines = readFileSync(file, 'utf8').split('\n')
let depth = 0
for (let i = 0; i < lines.length; i++) {
  const line = lines[i]
  for (const char of line) {
    if ('([{'.includes(char)) depth++
    else if (')]}'.includes(char)) depth--
  }
  const number = i + 1
  if (number >= from && number <= to) {
    process.stdout.write(`${String(number).padStart(4)} d=${String(depth).padStart(3)} | ${line.slice(0, 120)}\n`)
  }
}
process.stdout.write(`final depth=${depth}\n`)