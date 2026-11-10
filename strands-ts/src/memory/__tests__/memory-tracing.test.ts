import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MemoryManager } from '../memory-manager.js'
import { ExtractionCoordinator, type ExtractionBinding } from '../extraction/coordinator.js'
import { resolveExtractionConfig } from '../extraction/resolve-extraction-config.js'
import { InvocationTrigger } from '../extraction/triggers.js'
import { Tracer } from '../../telemetry/tracer.js'
import type { MemoryStore, MemoryEntry } from '../types.js'
import type { ExtractionConfig, Extractor } from '../extraction/types.js'
import type { Model } from '../../models/model.js'
import type { MessageData } from '../../types/messages.js'

/**
 * Tracing tests for the memory subsystem. The TS Tracer is per-instance and real (no global to
 * patch), so we spy on Tracer.prototype to assert which span methods fire without a live exporter.
 */

function createStore(
  name: string,
  options?: {
    entries?: MemoryEntry[]
    writable?: boolean
    sinks?: ('add' | 'addMessages')[]
    searchError?: Error
    addError?: Error
    extraction?: ExtractionConfig
  }
): MemoryStore {
  const sinks = options?.sinks ?? (options?.writable ? ['add'] : [])
  const store: MemoryStore = {
    name,
    writable: !!options?.writable,
    search: options?.searchError
      ? vi.fn().mockRejectedValue(options.searchError)
      : vi.fn().mockResolvedValue(options?.entries ?? []),
    ...(options?.extraction && { extraction: options.extraction }),
  }
  if (sinks.includes('add')) {
    store.add = options?.addError ? vi.fn().mockRejectedValue(options.addError) : vi.fn().mockResolvedValue(undefined)
  }
  if (sinks.includes('addMessages')) {
    store.addMessages = vi.fn().mockResolvedValue(undefined)
  }
  return store
}

function binding(store: MemoryStore): ExtractionBinding {
  return { store, config: resolveExtractionConfig(store.extraction, store)! }
}

function userMsg(text: string): MessageData {
  return { role: 'user', content: [{ text }] }
}

describe('memory tracing', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('search', () => {
    it('starts and ends a search span with the retrieved entries', async () => {
      const startSpy = vi.spyOn(Tracer.prototype, 'startMemorySearchSpan')
      const endSpy = vi.spyOn(Tracer.prototype, 'endMemorySearchSpan')
      const mm = new MemoryManager({
        stores: [createStore('personal', { entries: [{ content: 'x' }] })],
        injection: false,
      })

      const results = await mm.search('preferences')

      expect(results).toHaveLength(1)
      expect(startSpy).toHaveBeenCalledTimes(1)
      expect(endSpy).toHaveBeenCalledTimes(1)
      const endArg = endSpy.mock.calls[0]![1]!
      expect(endArg.storeFailureCount).toBe(0)
      expect(endArg.entries).toEqual([{ content: 'x', storeName: 'personal' }])
    })

    it('counts a per-store failure but ends the span OK (not an error)', async () => {
      const endSpy = vi.spyOn(Tracer.prototype, 'endMemorySearchSpan')
      const good = createStore('good', { entries: [{ content: 'hit' }] })
      const bad = createStore('bad', { searchError: new Error('boom') })
      const mm = new MemoryManager({ stores: [good, bad], injection: false })

      const results = await mm.search('q')

      expect(results).toHaveLength(1)
      const endArg = endSpy.mock.calls[0]![1]!
      expect(endArg.storeFailureCount).toBe(1)
      expect(endArg.error).toBeUndefined()
    })

    it('ends the span with an error when a named store is unknown', async () => {
      const endSpy = vi.spyOn(Tracer.prototype, 'endMemorySearchSpan')
      const mm = new MemoryManager({ stores: [createStore('personal')], injection: false })

      await expect(mm.search('q', { stores: ['missing'] })).rejects.toThrow("store 'missing' not found")
      expect(endSpy.mock.calls[0]![1]!.error).toBeInstanceOf(Error)
    })
  })

  describe('add', () => {
    it('starts and ends an add span on success', async () => {
      const startSpy = vi.spyOn(Tracer.prototype, 'startMemoryAddSpan')
      const endSpy = vi.spyOn(Tracer.prototype, 'endMemoryAddSpan')
      const mm = new MemoryManager({ stores: [createStore('personal', { writable: true })], injection: false })

      await mm.add('remember this')

      expect(startSpy).toHaveBeenCalledTimes(1)
      expect(endSpy).toHaveBeenCalledTimes(1)
      expect(endSpy.mock.calls[0]![1]?.error).toBeUndefined()
    })

    it('ends the span with the AggregateError when a write fails', async () => {
      const endSpy = vi.spyOn(Tracer.prototype, 'endMemoryAddSpan')
      const mm = new MemoryManager({
        stores: [createStore('personal', { writable: true, addError: new Error('disk full') })],
        injection: false,
      })

      await expect(mm.add('remember this')).rejects.toThrow(AggregateError)
      const endArg = endSpy.mock.calls[0]![1]!
      expect(endArg.storeFailureCount).toBe(1)
      expect(endArg.error).toBeInstanceOf(AggregateError)
    })

    it('forces a root span for the detached fire-and-forget path', async () => {
      const startSpy = vi.spyOn(Tracer.prototype, 'startMemoryAddSpan')
      const mm = new MemoryManager({ stores: [createStore('personal', { writable: true })], injection: false })

      await mm.add('remember this', { stores: ['personal'] }, true)

      expect(startSpy.mock.calls[0]![0].forceRoot).toBe(true)
    })
  })

  describe('injection', () => {
    it('ends the inject span injected=true with the entry count on the happy path', async () => {
      const endSpy = vi.spyOn(Tracer.prototype, 'endMemoryInjectSpan')
      const mm = new MemoryManager({
        stores: [createStore('personal', { entries: [{ content: 'likes dark mode', storeName: 'personal' }] })],
        injection: true,
      })

      const rendered = await mm['_provideMemoryContext']([userMsg('hi')], {})

      expect(rendered).toContain('dark mode')
      const endArg = endSpy.mock.calls.at(-1)![1]!
      expect(endArg.injected).toBe(true)
      expect(endArg.entryCount).toBe(1)
    })

    it('ends injected=false when no query can be derived', async () => {
      const endSpy = vi.spyOn(Tracer.prototype, 'endMemoryInjectSpan')
      const mm = new MemoryManager({ stores: [createStore('personal')], injection: true })

      const rendered = await mm['_provideMemoryContext']([], {})

      expect(rendered).toBeUndefined()
      expect(endSpy.mock.calls.at(-1)![1]!.injected).toBe(false)
    })

    it('fails open with formatError=true when the format callback throws', async () => {
      const endSpy = vi.spyOn(Tracer.prototype, 'endMemoryInjectSpan')
      const mm = new MemoryManager({
        stores: [createStore('personal', { entries: [{ content: 'x', storeName: 'personal' }] })],
        injection: true,
      })

      const rendered = await mm['_provideMemoryContext']([userMsg('hi')], {
        format: () => {
          throw new Error('bad format')
        },
      })

      expect(rendered).toBeUndefined()
      const endArg = endSpy.mock.calls.at(-1)![1]!
      expect(endArg.injected).toBe(false)
      expect(endArg.formatError).toBe(true)
    })

    it('ends the inject span and rethrows when search throws', async () => {
      const endSpy = vi.spyOn(Tracer.prototype, 'endMemoryInjectSpan')
      const mm = new MemoryManager({ stores: [createStore('personal')], injection: true })
      vi.spyOn(mm, 'search').mockRejectedValue(new Error('search exploded'))

      await expect(mm['_provideMemoryContext']([userMsg('hi')], {})).rejects.toThrow('search exploded')
      // The span must be ended even though search threw, so it does not leak open.
      expect(endSpy).toHaveBeenCalled()
      expect(endSpy.mock.calls.at(-1)![1]!.injected).toBe(false)
    })

    it('fails open (ends injected=false) when the query callback throws', async () => {
      const endSpy = vi.spyOn(Tracer.prototype, 'endMemoryInjectSpan')
      const mm = new MemoryManager({ stores: [createStore('personal')], injection: true })

      // _resolveInjectionQuery catches a throwing query callback and returns undefined, so injection
      // is skipped (fails open) rather than rethrowing — the span ends injected=false.
      const rendered = await mm['_provideMemoryContext']([userMsg('hi')], {
        query: () => {
          throw new Error('query exploded')
        },
      })

      expect(rendered).toBeUndefined()
      expect(endSpy.mock.calls.at(-1)![1]!.injected).toBe(false)
    })
  })

  describe('extraction coordinator', () => {
    it('starts a root extract span and ends it OK on a successful save', async () => {
      const startSpy = vi.spyOn(Tracer.prototype, 'startMemoryExtractSpan')
      const endSpy = vi.spyOn(Tracer.prototype, 'endMemoryExtractSpan')
      const store = createStore('personal', {
        writable: true,
        sinks: ['addMessages'],
        extraction: { trigger: [new InvocationTrigger()] },
      })
      const coordinator = new ExtractionCoordinator([binding(store)], {} as Model, new Tracer())
      coordinator.record(userMsg('remember dark mode'))

      await coordinator.process(store)

      expect(startSpy).toHaveBeenCalledTimes(1)
      expect(endSpy.mock.calls.at(-1)![1]?.error).toBeUndefined()
      expect(store.addMessages).toHaveBeenCalledTimes(1)
    })

    it('ends the extract span with the error and swallows the failure', async () => {
      const endSpy = vi.spyOn(Tracer.prototype, 'endMemoryExtractSpan')
      const store = createStore('personal', {
        writable: true,
        sinks: ['addMessages'],
        extraction: { trigger: [new InvocationTrigger()] },
      })
      ;(store.addMessages as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('backend down'))
      const coordinator = new ExtractionCoordinator([binding(store)], {} as Model, new Tracer())
      coordinator.record(userMsg('remember dark mode'))

      // Must not throw: saving never breaks the agent loop.
      await coordinator.process(store)

      expect(endSpy.mock.calls.at(-1)![1]!.error).toBeInstanceOf(Error)
    })

    it('creates no span when there are no fresh messages', async () => {
      const startSpy = vi.spyOn(Tracer.prototype, 'startMemoryExtractSpan')
      const store = createStore('personal', {
        writable: true,
        sinks: ['addMessages'],
        extraction: { trigger: [new InvocationTrigger()] },
      })
      const coordinator = new ExtractionCoordinator([binding(store)], {} as Model, new Tracer())

      await coordinator.process(store)

      expect(startSpy).not.toHaveBeenCalled()
    })

    it('passes the written entry count to the span end (extractor route)', async () => {
      const endSpy = vi.spyOn(Tracer.prototype, 'endMemoryExtractSpan')
      const extractor: Extractor = {
        extract: vi.fn().mockResolvedValue([{ content: 'fact one' }, { content: 'fact two' }]),
      }
      const store = createStore('personal', {
        writable: true,
        sinks: ['add'],
        extraction: { trigger: [new InvocationTrigger()], extractor },
      })
      const coordinator = new ExtractionCoordinator([binding(store)], {} as Model, new Tracer())
      coordinator.record(userMsg('remember two things'))

      await coordinator.process(store)

      expect(endSpy.mock.calls.at(-1)![1]!.entryCount).toBe(2)
    })

    it('records entryCount=0 when all messages are filtered out', async () => {
      const endSpy = vi.spyOn(Tracer.prototype, 'endMemoryExtractSpan')
      const store = createStore('personal', {
        writable: true,
        sinks: ['addMessages'],
        extraction: { trigger: [new InvocationTrigger()] },
      })
      const coordinator = new ExtractionCoordinator([binding(store)], {} as Model, new Tracer())
      // Default filter excludes toolResult blocks, so this message is fully filtered.
      coordinator.record({ role: 'user', content: [{ toolResult: { toolUseId: '1', content: [] } } as never] })

      await coordinator.process(store)

      expect(store.addMessages).not.toHaveBeenCalled()
      expect(endSpy.mock.calls.at(-1)![1]!.entryCount).toBe(0)
    })

    it('a span-end failure does not throw nor mark the save as failed', async () => {
      vi.spyOn(Tracer.prototype, 'endMemoryExtractSpan').mockImplementation(() => {
        throw new Error('tracer down')
      })
      const store = createStore('personal', {
        writable: true,
        sinks: ['addMessages'],
        extraction: { trigger: [new InvocationTrigger()] },
      })
      const coordinator = new ExtractionCoordinator([binding(store)], {} as Model, new Tracer())
      coordinator.record(userMsg('remember dark mode'))

      // Must not throw despite the telemetry failure.
      await coordinator.process(store)

      expect(store.addMessages).toHaveBeenCalledTimes(1)
    })
  })
})
