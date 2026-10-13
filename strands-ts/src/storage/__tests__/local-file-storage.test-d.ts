import { describe, it, expectTypeOf } from 'vitest'
import { LocalFileStorage, type LocalFileStorageConfig } from '../local-file-storage.js'
import { QmdSearchStrategy } from '../search/qmd.js'
import { KeywordSearchStrategy } from '../search/keyword.js'
import type { SandboxSafeSearchStrategy, SearchStrategy } from '../search/types.js'
import type { Sandbox } from '../../sandbox/base.js'

declare const sandbox: Sandbox
declare const maybeSandbox: Sandbox | undefined
declare const anyStrategy: SearchStrategy<LocalFileStorage>
const customStrategy = { search: async () => [] }

describe('LocalFileStorage sandbox and search strategy types', () => {
  it('rejects a host filesystem strategy with a sandbox', () => {
    // @ts-expect-error QmdSearchStrategy requires host filesystem access
    new LocalFileStorage('./dir', sandbox, new QmdSearchStrategy())
    // @ts-expect-error QmdSearchStrategy requires host filesystem access
    new LocalFileStorage('./dir', { sandbox, searchStrategy: new QmdSearchStrategy() })
    // @ts-expect-error a possibly-set sandbox cannot be combined with a host filesystem strategy
    new LocalFileStorage('./dir', maybeSandbox, new QmdSearchStrategy())
    // @ts-expect-error an arbitrary SearchStrategy may require host filesystem access
    new LocalFileStorage('./dir', sandbox, anyStrategy)
  })

  it('accepts a host filesystem strategy without a sandbox', () => {
    new LocalFileStorage('./dir', undefined, new QmdSearchStrategy())
    new LocalFileStorage('./dir', { searchStrategy: new QmdSearchStrategy() })
    new LocalFileStorage('./dir', undefined, anyStrategy)
  })

  it('accepts sandbox-safe strategies with a sandbox', () => {
    new LocalFileStorage('./dir', sandbox, KeywordSearchStrategy)
    new LocalFileStorage('./dir', sandbox, customStrategy)
    new LocalFileStorage('./dir', { sandbox, searchStrategy: customStrategy })
    new LocalFileStorage('./dir', maybeSandbox)
    new LocalFileStorage('./dir', { sandbox })
  })

  it('types QmdSearchStrategy as host filesystem and keyword search as sandbox-safe', () => {
    expectTypeOf<QmdSearchStrategy['requiresHostFs']>().toEqualTypeOf<true>()
    expectTypeOf(KeywordSearchStrategy).toMatchTypeOf<SandboxSafeSearchStrategy>()
    expectTypeOf(new QmdSearchStrategy()).not.toMatchTypeOf<SandboxSafeSearchStrategy<LocalFileStorage>>()
    expectTypeOf({ sandbox, searchStrategy: new QmdSearchStrategy() }).not.toMatchTypeOf<LocalFileStorageConfig>()
  })
})
