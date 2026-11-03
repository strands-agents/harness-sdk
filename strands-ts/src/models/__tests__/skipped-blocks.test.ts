import { describe, expect, it, vi } from 'vitest'
import { countSkipped, logSkippedBlocks, type SkippedBlocks } from '../skipped-blocks.js'

describe('logSkippedBlocks', () => {
  it('logs each notice once with its count', () => {
    const warn = vi.fn()
    const skipped: SkippedBlocks = new Map([
      ['notice a', 3],
      ['notice b', 1],
    ])

    logSkippedBlocks({ warn } as never, skipped)

    expect(warn.mock.calls.map(([message]) => message)).toEqual(['count=<3> | notice a', 'count=<1> | notice b'])
  })

  it('logs nothing when nothing was skipped', () => {
    const warn = vi.fn()

    logSkippedBlocks({ warn } as never, new Map())

    expect(warn).not.toHaveBeenCalled()
  })
})

describe('countSkipped', () => {
  it('counts repeated notices under the same message', () => {
    const skipped: SkippedBlocks = new Map()

    countSkipped(skipped, 'notice')
    countSkipped(skipped, 'notice')
    countSkipped(skipped, 'other')

    expect(Object.fromEntries(skipped)).toEqual({ notice: 2, other: 1 })
  })
})
