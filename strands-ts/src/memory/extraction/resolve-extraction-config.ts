import type { MemoryStore } from '../types.js'
import { IntervalTrigger } from './triggers.js'
import { ModelExtractor } from './model-extractor.js'
import {
  DEFAULT_MEMORY_MESSAGE_FILTER,
  type ExtractionConfig,
  type ExtractionTrigger,
  type Extractor,
  type MemoryMessageFilter,
} from './types.js'

/**
 * Default cadence when an {@link ExtractionConfig} omits its `trigger`: extract every N turns.
 * @internal
 */
export const DEFAULT_EXTRACTION_TRIGGER_TURNS = 5

/**
 * An {@link ExtractionConfig} with every field resolved to a concrete value, ready to drive
 * extraction. Produced by {@link resolveExtractionConfig} so the {@link MemoryManager} and
 * {@link ExtractionCoordinator} never have to re-apply defaults or normalize shapes.
 * @internal
 */
export interface ResolvedExtractionConfig {
  /** Normalized to an array (a single trigger is wrapped). Never empty for a resolved config. */
  triggers: ExtractionTrigger[]
  /**
   * The extractor that distills facts client-side and stores them via the store's `add` method, or
   * `undefined` to use the store's `addMessages` method (server-side extraction).
   */
  extractor?: Extractor
  /** The content-block filter applied before extraction. */
  filter: MemoryMessageFilter
}

/**
 * Resolves a store's `extraction` setting into a {@link ResolvedExtractionConfig}, applying defaults.
 *
 * The single place the `boolean | ExtractionConfig` shorthand is interpreted: `false`/omitted is off
 * (returns `undefined`), `true` enables all defaults, an {@link ExtractionConfig} defaults its unset
 * fields. The defaults are:
 * - **trigger**: every {@link DEFAULT_EXTRACTION_TRIGGER_TURNS} turns. An explicit empty array is left
 *   empty for the {@link MemoryManager} to reject.
 * - **extractor**: chosen from the methods the store implements. A store that implements `addMessages`
 *   supports server-side extraction, so it defaults to no extractor: the manager hands raw messages to
 *   `addMessages` and the backend extracts them itself, with no model call. A store that implements only
 *   `add` cannot extract server-side, so it defaults to a {@link ModelExtractor} that distills facts
 *   client-side (via model calls) and stores each one through `add`.
 * - **filter**: {@link DEFAULT_MEMORY_MESSAGE_FILTER}.
 *
 * @param extraction - The store's `extraction` setting
 * @param store - The store, inspected for the write methods it implements to pick the default extractor
 * @returns The resolved config, or `undefined` when extraction is disabled
 * @internal
 */
export function resolveExtractionConfig(
  extraction: boolean | ExtractionConfig | undefined,
  store: Pick<MemoryStore, 'add' | 'addMessages'>
): ResolvedExtractionConfig | undefined {
  if (!extraction) {
    return undefined
  }
  const config: ExtractionConfig = extraction === true ? {} : extraction

  const triggers =
    config.trigger === undefined
      ? [new IntervalTrigger({ turns: DEFAULT_EXTRACTION_TRIGGER_TURNS })]
      : Array.isArray(config.trigger)
        ? config.trigger
        : [config.trigger]

  let extractor = config.extractor
  if (extractor === undefined) {
    // Pick the default extractor from the store's write methods:
    // - implements `addMessages` (whether or not it also implements `add`): extract server-side. Leave
    //   the extractor undefined so raw messages go straight to `addMessages` with no model call.
    // - implements only `add`: it cannot extract server-side, so default to a ModelExtractor that
    //   distills facts client-side and stores each via `add`.
    const implementsAdd = typeof store.add === 'function'
    const implementsAddMessages = typeof store.addMessages === 'function'
    if (implementsAdd && !implementsAddMessages) {
      extractor = new ModelExtractor()
    }
  }

  const filter = config.filter ?? DEFAULT_MEMORY_MESSAGE_FILTER

  return {
    triggers,
    ...(extractor !== undefined && { extractor }),
    filter,
  }
}
