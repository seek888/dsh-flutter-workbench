import { readFileSync } from 'node:fs'

const file = process.argv[2]
const lines = readFileSync(file, 'utf8').split('\n')
let depth = 0
let inBlockComment = false
let previousName = '(file start)'
let previousDepth = 0

const strip = (line) => {
  let out = ''
  let index = 0
  while (index < line.length) {
    if (inBlockComment === true) {
      const end = line.indexOf('*/', index)
      if (end === -1) return out
      inBlockComment = false
      index = end + 2
      continue
    }
    if (line.startsWith('/*', index) === true) {
      inBlockComment = true
      index += 2
      continue
    }
    if (line.startsWith('//', index) === true) return out
    const char = line[index]
    if (char === "'" || char === '"' || char === '`') {
      index++
      while (index < line.length) {
        if (line[index] === '\\') {
          index += 2
          continue
        }
        if (line[index] === char) {
          index++
          break
        }
        index++
      }
      continue
    }
    out += char
    index += 1
  }
  return out
}

for (let i = 0; i < lines.length; i++) {
  const raw = lines[i]
  if (/^(function |const [A-Za-z0-9_]+ = |fwbExtendLocale|const FWB_)/.test(raw) === true && depth !== 0) {
    process.stdout.write(`IMBALANCE before line ${i + 1}: ${previousName} left depth ${depth} (started at ${previousDepth})\n  now: ${raw.slice(0, 90)}\n`)
    previousName = raw.slice(0, 60)
    previousDepth = depth
  }
  const code = strip(raw)
  for (const char of code) {
    if ('([{'.includes(char) === true) depth++
    else if (')]}'.includes(char) === true) depth--
  }
  if (depth < 0) {
    process.stdout.write(`NEGATIVE depth at line ${i + 1}: ${raw.slice(0, 90)}\n`)
    depth = 0
  }
}

process.stdout.write(`final depth=${depth} (last block: ${previousName})\n`)