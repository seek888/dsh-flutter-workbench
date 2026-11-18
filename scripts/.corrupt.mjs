import { readdirSync, readFileSync } from 'node:fs'

const root = 'client/src'
const names = readdirSync(root).filter((name) => name.endsWith('.js')).sort()
const suspects = ['ooard', 'oorder', 'oackground', 'laoel', 'oadge', 'outton']
for (const name of names) {
  const text = readFileSync(`${root}/${name}`, 'utf8')
  const hits = suspects.map((word) => [word, text.split(word).length - 1]).filter(([, count]) => count > 0)
  const board = text.split('board').length - 1
  const order = text.split('order').length - 1
  const background = text.split('background').length - 1
  process.stdout.write(
    `${name.padEnd(22)} board=${String(board).padStart(4)} order=${String(order).padStart(4)} background=${String(background).padStart(4)}` +
    `${hits.length === 0 ? '' : `  SUSPECT: ${hits.map(([word, count]) => `${word}×${count}`).join(' ')}`}\n`,
  )
}