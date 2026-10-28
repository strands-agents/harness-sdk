import { describe, it, expect } from 'vitest'
import { mergeModelInfo, type ModelInfo } from '../model-info.js'

const base: ModelInfo = {
  capabilities: { stateful: false, promptCaching: 'cachePoints' },
  limits: { contextWindow: 200_000 },
}

describe('mergeModelInfo', () => {
  it('returns the base when nothing else is given', () => {
    expect(mergeModelInfo(base)).toEqual(base)
  })

  it('inherits fields a later record leaves out or sets to undefined', () => {
    const merged = mergeModelInfo(
      base,
      { limits: { contextWindow: 1_000_000 } },
      { capabilities: { stateful: undefined } }
    )

    expect(merged.capabilities).toEqual(base.capabilities)
    expect(merged.limits?.contextWindow).toBe(1_000_000)
  })

  it('lets a later record win over an earlier one', () => {
    const merged = mergeModelInfo(base, { limits: { contextWindow: 1 } }, undefined, {
      capabilities: { promptCaching: 'unsupported' },
      limits: { contextWindow: 2 },
    })

    expect(merged.capabilities).toEqual({ stateful: false, promptCaching: 'unsupported' })
    expect(merged.limits?.contextWindow).toBe(2)
  })

  it('leaves out sections with nothing known', () => {
    expect(mergeModelInfo({}, undefined, { limits: { contextWindow: undefined } })).toEqual({})
  })

  it('returns a frozen record', () => {
    const merged = mergeModelInfo(base)

    expect(Object.isFrozen(merged)).toBe(true)
    expect(Object.isFrozen(merged.capabilities)).toBe(true)
    expect(Object.isFrozen(merged.limits)).toBe(true)
  })
})
