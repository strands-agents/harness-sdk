import { describe, it, expect } from 'vitest'
import { resolvePreset, resolveStrategies, STRATEGY_PRESET_NAMES } from '../presets.js'
import { ContextManager } from '../context-manager.js'

describe('presets', () => {
  describe('resolvePreset', () => {
    it.each(STRATEGY_PRESET_NAMES)('resolves %s to a non-empty strategy array', (name) => {
      const strategies = resolvePreset(name)
      expect(strategies.length).toBeGreaterThan(0)
      for (const strategy of strategies) {
        expect(strategy).toHaveProperty('name')
        expect(strategy).toHaveProperty('apply')
      }
    })

    it('proactiveSummarization resolves to a summarize strategy', () => {
      const strategies = resolvePreset('proactiveSummarization')
      expect(strategies).toHaveLength(1)
      expect(strategies[0]!.name).toBe('offload:summarize')
    })

    it('largeToolOffloading resolves to a truncate strategy', () => {
      const strategies = resolvePreset('largeToolOffloading')
      expect(strategies).toHaveLength(1)
      expect(strategies[0]!.name).toBe('offload:truncate')
    })

    it('overflowProtection resolves to a truncate strategy', () => {
      const strategies = resolvePreset('overflowProtection')
      expect(strategies).toHaveLength(1)
      expect(strategies[0]!.name).toBe('offload:truncate')
    })

    it('staleToolCleanup resolves to a drop strategy', () => {
      const strategies = resolvePreset('staleToolCleanup')
      expect(strategies).toHaveLength(1)
      expect(strategies[0]!.name).toBe('offload:drop')
    })
  })

  describe('resolveStrategies', () => {
    it('passes raw strategies through unchanged', () => {
      const raw = { name: 'custom', apply: async () => false }
      const result = resolveStrategies([raw])
      expect(result).toEqual([raw])
    })

    it('resolves preset strings to strategy arrays', () => {
      const result = resolveStrategies(['largeToolOffloading'])
      expect(result).toHaveLength(1)
      expect(result[0]!.name).toBe('offload:truncate')
    })

    it('handles mixed arrays of presets and raw strategies', () => {
      const raw = { name: 'custom', apply: async () => false }
      const result = resolveStrategies(['largeToolOffloading', raw, 'overflowProtection'])
      expect(result).toHaveLength(3)
      expect(result[0]!.name).toBe('offload:truncate')
      expect(result[1]!.name).toBe('custom')
      expect(result[2]!.name).toBe('offload:truncate')
    })

    it('preserves order of preset expansion', () => {
      const result = resolveStrategies(['staleToolCleanup', 'proactiveSummarization'])
      expect(result).toHaveLength(2)
      expect(result[0]!.name).toBe('offload:drop')
      expect(result[1]!.name).toBe('offload:summarize')
    })

    it('throws for unknown preset string', () => {
      expect(() => resolveStrategies(['proactiveSummarisation' as any])).toThrow(
        'Unknown strategy preset: "proactiveSummarisation"'
      )
    })
  })

  describe('ContextManager.from', () => {
    it('resolves preset strings in a config strategies array', () => {
      const cm = ContextManager.from({ strategies: ['largeToolOffloading', 'proactiveSummarization'] })
      expect(cm).toBeInstanceOf(ContextManager)
    })

    it('resolves a mix of preset strings and raw strategies', () => {
      const cm = ContextManager.from({
        strategies: ['largeToolOffloading', { name: 'custom', apply: async () => false }],
      })
      expect(cm).toBeInstanceOf(ContextManager)
    })

    it('resolves "auto" preset', () => {
      expect(ContextManager.from('auto')).toBeInstanceOf(ContextManager)
    })

    it('resolves "agentic" preset', () => {
      expect(ContextManager.from('agentic')).toBeInstanceOf(ContextManager)
    })

    it('returns undefined for false', () => {
      expect(ContextManager.from(false)).toBeUndefined()
    })

    it('returns undefined for undefined', () => {
      expect(ContextManager.from(undefined)).toBeUndefined()
    })

    it('throws for unknown preset string', () => {
      expect(() => ContextManager.from('atuo' as any)).toThrow('Unknown contextManager preset')
    })
  })
})
