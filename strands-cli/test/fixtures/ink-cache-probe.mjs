import assert from 'node:assert/strict'
import { URL } from 'node:url'

await import('#ink-text-cache')
await import('#ink-text-cache')

const entrypoint = import.meta.resolve('ink')
const { default: measure } = await import(new URL('./measure-text.js', entrypoint))
const { default: wrap } = await import(new URL('./wrap-text.js', entrypoint))

assert.deepEqual(measure('红色\nabc'), { width: 4, height: 2 })
const first = measure('sentinel')
for (let index = 0; index < 1_001; index++) {
  measure(`revision-${index}`)
}
assert.notStrictEqual(measure('sentinel'), first)
assert.equal(wrap('abcdef', 2, 'hard'), 'ab\ncd\nef')
assert.equal(wrap('abcdef', 4, 'truncate-end'), 'abc…')
process.stdout.write('bounded Ink cache active\n')
