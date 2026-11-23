import { describe, expect, it } from 'vitest'
import * as experimental from '../index.js'
import * as root from '../../index.js'
import * as contextManager from '../../context-manager/index.js'
// Type-only exports, checked when the tests compile.
import type {
  DeferConditions,
  DeferConfig,
  DeferStrategy,
  DeferTarget,
  DeferredToolLoading,
  ServerToolBlockData,
  ServerToolDelta,
  ToolSearch,
  ToolSearchContext,
  ToolSearcher,
} from '../index.js'

describe('experimental barrel', () => {
  it('exports deferred tool loading and ServerToolBlock, which the stable barrels leave out', () => {
    const config: DeferConfig = { search: 'auto' satisfies ToolSearch }
    const target: DeferTarget = 'toolSpecs'
    const delivery: DeferredToolLoading = 'native'
    expect([config, target, delivery]).toBeDefined()
    expect(experimental).toMatchObject({
      KeywordToolSearcher: expect.any(Function),
      ServerToolBlock: expect.any(Function),
    })
    expect(root).not.toHaveProperty('ServerToolBlock')
    expect(contextManager).not.toHaveProperty('KeywordToolSearcher')
  })
})

export type { DeferConditions, DeferStrategy, ServerToolBlockData, ServerToolDelta, ToolSearchContext, ToolSearcher }
