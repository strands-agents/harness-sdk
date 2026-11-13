/**
 * Strategy presets — named building blocks that resolve to concrete strategy configurations.
 *
 * Preset definitions (thresholds, methods, conditions) are internal defaults and may
 * change between releases as we tune based on real-world usage data. Treat the preset
 * name as the stable contract, not its expansion. Use raw `Offload.*` strategies when
 * you need a specific, pinned configuration.
 *
 * @experimental
 */

import type { ContextStrategy } from './types.js'
import { Offload } from './strategies/offload/index.js'

/**
 * Known preset name strings accepted in the strategies array.
 *
 * Preset names are the stable contract. The strategies they resolve to may change
 * between releases.
 *
 * - `'proactiveSummarization'` — batch summarize the oldest 30% of messages at 70% utilization
 * - `'largeToolOffloading'` — truncate tool results over 2500 tokens to a 1000-token preview
 * - `'overflowProtection'` — drop the oldest messages when the context window is full
 * - `'staleToolCleanup'` — drop tool results outside the newest 5 tool-result messages
 */
export const STRATEGY_PRESET_NAMES = [
  'proactiveSummarization',
  'largeToolOffloading',
  'overflowProtection',
  'staleToolCleanup',
] as const

/** String union of preset names. */
export type StrategyPresetName = (typeof STRATEGY_PRESET_NAMES)[number]

/**
 * Resolves a preset name to its default strategy array.
 *
 * @param name - The preset name
 * @returns The strategy array for the given preset
 * @internal
 */
export function resolvePreset(name: StrategyPresetName): ContextStrategy[] {
  // Defaults are tuning decisions, not API promises — adjust freely.
  switch (name) {
    case 'proactiveSummarization':
      return [Offload.summarize('*').when({ contextUtilization: '70%', preserveRecent: '70%' })]
    case 'largeToolOffloading':
      return [Offload.truncate('toolResults', { previewTokens: 1000 }).when({ blockThreshold: 2500 })]
    case 'overflowProtection':
      return [Offload.drop('*').when({ contextUtilization: '100%', preserveRecent: 4 })]
    case 'staleToolCleanup':
      return [Offload.drop('toolResults').when({ preserveRecent: 5 })]
  }
}

/**
 * Resolves a mixed array of strategies and preset names into a flat strategy array.
 *
 * @param entries - Array of raw strategies and/or preset name strings
 * @returns Flattened array of concrete strategies
 * @throws Error when an entry is nullish or an unknown preset name
 * @internal
 */
export function resolveStrategies(entries: (ContextStrategy | StrategyPresetName)[]): ContextStrategy[] {
  const strategies: ContextStrategy[] = []
  for (const entry of entries) {
    if (typeof entry === 'string') {
      if (!STRATEGY_PRESET_NAMES.includes(entry as StrategyPresetName)) {
        throw new Error(`Unknown strategy preset: "${entry}". Valid presets: ${STRATEGY_PRESET_NAMES.join(', ')}`)
      }
      strategies.push(...resolvePreset(entry as StrategyPresetName))
    } else if (entry === null || entry === undefined) {
      throw new Error(`Strategy entries must be a strategy or a preset name, got ${String(entry)}`)
    } else {
      strategies.push(entry)
    }
  }
  return strategies
}
