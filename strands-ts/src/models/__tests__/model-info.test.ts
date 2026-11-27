import { describe, it, expect } from 'vitest'
import { acceptsMimeType, ModelInfo } from '../model-info.js'

const base: ModelInfo = {
  capabilities: { stateful: false, promptCaching: 'cachePoints' },
  limits: { contextWindow: 200_000 },
}

describe('ModelInfo.merge', () => {
  it('returns the base when nothing else is given', () => {
    expect(ModelInfo.merge(base)).toEqual(base)
  })

  it('inherits fields a later record leaves out or sets to undefined', () => {
    const merged = ModelInfo.merge(
      base,
      { limits: { contextWindow: 1_000_000 } },
      { capabilities: { stateful: undefined } }
    )

    expect(merged.capabilities).toEqual(base.capabilities)
    expect(merged.limits?.contextWindow).toBe(1_000_000)
  })

  it('lets a later record win over an earlier one', () => {
    const merged = ModelInfo.merge(base, { limits: { contextWindow: 1 } }, undefined, {
      capabilities: { promptCaching: 'unsupported' },
      limits: { contextWindow: 2 },
    })

    expect(merged.capabilities).toEqual({ stateful: false, promptCaching: 'unsupported' })
    expect(merged.limits?.contextWindow).toBe(2)
  })

  it('keeps an empty accepted list as known, frozen', () => {
    const merged = ModelInfo.merge(
      { capabilities: { acceptedMimeTypes: ['image/png'] } },
      { capabilities: { acceptedMimeTypes: [] } }
    )

    expect(merged.capabilities?.acceptedMimeTypes).toEqual([])
    expect(Object.isFrozen(merged.capabilities?.acceptedMimeTypes)).toBe(true)
  })

  it('leaves out sections with nothing known', () => {
    expect(ModelInfo.merge({}, undefined, { limits: { contextWindow: undefined } })).toEqual({})
  })

  it('returns a frozen record', () => {
    const merged = ModelInfo.merge(base)

    expect(Object.isFrozen(merged)).toBe(true)
    expect(Object.isFrozen(merged.capabilities)).toBe(true)
    expect(Object.isFrozen(merged.limits)).toBe(true)
  })
})

describe('acceptsMimeType', () => {
  it.each<[readonly string[] | undefined, string, boolean]>([
    [undefined, 'application/x-anything', true],
    [[], 'image/png', false],
    [['image/png'], 'image/png', true],
    [['image/png'], 'IMAGE/PNG', true],
    [['Image/PNG'], 'image/png', true],
    [['text/plain'], 'text/plain; charset=utf-8', true],
    [['image/png'], 'image/jpeg', false],
    [['video/*'], 'video/mp4', true],
    [['video/*'], 'audio/mp4', false],
  ])('with %j accepts %s: %s', (acceptedMimeTypes, mimeType, expected) => {
    expect(acceptsMimeType({ capabilities: { acceptedMimeTypes } }, mimeType)).toBe(expected)
  })
})
