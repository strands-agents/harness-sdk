import { describe, it, expect, vi } from 'vitest'
import { resolveExtractionConfig, DEFAULT_EXTRACTION_TRIGGER_TURNS } from '../resolve-extraction-config.js'
import { IntervalTrigger, InvocationTrigger } from '../triggers.js'
import { ModelExtractor } from '../model-extractor.js'
import { DEFAULT_MEMORY_MESSAGE_FILTER, type Extractor } from '../types.js'
import type { MemoryStore } from '../../types.js'

/** A minimal store stub exposing only the write sinks the resolver inspects. */
function sinks(have: 'add' | 'addMessages' | 'both'): Pick<MemoryStore, 'add' | 'addMessages'> {
  return {
    ...((have === 'add' || have === 'both') && { add: vi.fn() }),
    ...((have === 'addMessages' || have === 'both') && { addMessages: vi.fn() }),
  }
}

describe('resolveExtractionConfig', () => {
  describe('enablement shorthand', () => {
    it('returns undefined when extraction is false', () => {
      expect(resolveExtractionConfig(false, sinks('add'))).toBeUndefined()
    })

    it('returns undefined when extraction is undefined', () => {
      expect(resolveExtractionConfig(undefined, sinks('add'))).toBeUndefined()
    })

    it('resolves true to a fully-defaulted config', () => {
      const resolved = resolveExtractionConfig(true, sinks('add'))
      expect(resolved).toBeDefined()
      expect(resolved!.triggers).toHaveLength(1)
      expect(resolved!.triggers[0]).toBeInstanceOf(IntervalTrigger)
      expect(resolved!.filter).toBe(DEFAULT_MEMORY_MESSAGE_FILTER)
    })
  })

  describe('trigger defaulting and normalization', () => {
    it('defaults an omitted trigger to an IntervalTrigger of DEFAULT_EXTRACTION_TRIGGER_TURNS', () => {
      const resolved = resolveExtractionConfig({}, sinks('addMessages'))!
      // Structural equality compares the constructed IntervalTrigger (including its turns) without
      // reaching into private fields, so it stays valid if IntervalTrigger's internals change.
      expect(resolved.triggers).toEqual([new IntervalTrigger({ turns: DEFAULT_EXTRACTION_TRIGGER_TURNS })])
      expect(DEFAULT_EXTRACTION_TRIGGER_TURNS).toBe(5)
    })

    it('wraps a single trigger into an array', () => {
      const trigger = new InvocationTrigger()
      const resolved = resolveExtractionConfig({ trigger }, sinks('addMessages'))!
      expect(resolved.triggers).toEqual([trigger])
    })

    it('passes an explicit trigger array through unchanged', () => {
      const triggers = [new InvocationTrigger(), new IntervalTrigger({ turns: 2 })]
      const resolved = resolveExtractionConfig({ trigger: triggers }, sinks('addMessages'))!
      expect(resolved.triggers).toEqual(triggers)
    })

    it('leaves an explicit empty trigger array empty (so the manager can reject it)', () => {
      const resolved = resolveExtractionConfig({ trigger: [] }, sinks('addMessages'))!
      expect(resolved.triggers).toEqual([])
    })
  })

  describe('capability-based extractor default', () => {
    it('defaults an add-only store to a ModelExtractor', () => {
      const resolved = resolveExtractionConfig(true, sinks('add'))!
      expect(resolved.extractor).toBeInstanceOf(ModelExtractor)
    })

    it('defaults an addMessages-only store to the passthrough (no extractor)', () => {
      const resolved = resolveExtractionConfig(true, sinks('addMessages'))!
      expect(resolved.extractor).toBeUndefined()
    })

    it('defaults a both-sinks store to the passthrough (no extractor)', () => {
      const resolved = resolveExtractionConfig(true, sinks('both'))!
      expect(resolved.extractor).toBeUndefined()
    })

    it('keeps an explicit extractor even on an addMessages store', () => {
      const extractor: Extractor = { extract: vi.fn() }
      const resolved = resolveExtractionConfig({ extractor }, sinks('both'))!
      expect(resolved.extractor).toBe(extractor)
    })
  })

  describe('filter defaulting', () => {
    it('defaults to DEFAULT_MEMORY_MESSAGE_FILTER', () => {
      expect(resolveExtractionConfig(true, sinks('add'))!.filter).toBe(DEFAULT_MEMORY_MESSAGE_FILTER)
    })

    it('passes an explicit filter through', () => {
      const filter = { exclude: [] as never[] }
      expect(resolveExtractionConfig({ filter }, sinks('add'))!.filter).toBe(filter)
    })
  })
})
