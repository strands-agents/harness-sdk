import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { main } from '../../src/cli/run.js'

const environment = process.env.NODE_ENV
Object.assign(process.stdin, { isTTY: true, setRawMode() {} })
Object.assign(process.stdout, { isTTY: true, columns: 120, rows: 42 })
let renders = 0
let ready = false
process.stdout.write = (chunk) => {
  renders++
  ready ||= chunk.toString().includes('Quickstart')
  return true
}

void main(['--setup']).catch((error) => {
  process.stderr.write(String(error))
  process.exit(1)
})
while (!ready) {
  await delay(20)
}
const initialRenders = renders
for (let index = 0; index < 20; index++) {
  process.stdin.push(Buffer.from(index % 2 ? '\u001b[A' : '\u001b[B'))
  await delay(20)
}
assert.ok(renders > initialRenders)
assert.equal(process.env.NODE_ENV, environment)
assert.equal(performance.getEntriesByType('measure').length, 0)
process.exit(0)
