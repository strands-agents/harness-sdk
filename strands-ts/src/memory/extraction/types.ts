import type { JSONValue } from '../../types/json.js'
import type { MessageData, ContentBlockData } from '../../types/messages.js'
import type { Model } from '../../models/model.js'
import type { LocalAgent } from '../../types/agent.js'
import type { Tracer } from '../../telemetry/tracer.js'

// `keyof` over a union yields only the keys every member shares (none, here). The conditional makes
// it distribute over each member instead, collecting the union of their individual keys.
type DistributedKeyof<Union> = Union extends unknown ? keyof Union : never

/**
 * Content block kinds that {@link MemoryMessageFilter} can exclude before messages reach an
 * {@link Extractor} or the no-extractor passthrough.
 *
 * Derived from the SDK's {@link ContentBlockData} union: every member's discriminator key is its
 * kind (`{ toolUse: ... }` → `'toolUse'`, `{ text: string }` → `'text'`), so this tracks new block
 * types automatically instead of drifting. Matches the runtime `_blockKind` used to filter.
 */
export type MemoryContentBlockType = DistributedKeyof<ContentBlockData>

/**
 * Filters content blocks out of messages before extraction.
 *
 * Blocks whose kind is in {@link exclude} are stripped; a message left with no content is dropped
 * entirely. Defaults to excluding tool traffic (`toolUse` / `toolResult`), which is rarely useful as
 * long-term memory and adds noise.
 */
export interface MemoryMessageFilter {
  /** Content block kinds to strip before extraction. */
  exclude: MemoryContentBlockType[]
}

/** Default filter: drop tool-call traffic, keep everything else (text, reasoning, media). */
export const DEFAULT_MEMORY_MESSAGE_FILTER: MemoryMessageFilter = {
  exclude: ['toolUse', 'toolResult'],
}

/**
 * A discrete entry produced by an {@link Extractor}, ready to be written to a store via its `add`.
 */
export interface ExtractionResult {
  /** The textual content of the entry. */
  content: string
  /** Optional metadata to associate with the entry. */
  metadata?: Record<string, JSONValue>
}

/**
 * Context passed to {@link Extractor.extract}.
 *
 * Lets the manager hand an extractor a fallback model without the extractor having to be wired to
 * the agent directly. {@link ModelExtractor} uses its own configured model when set, else
 * {@link defaultModel}.
 */
export interface ExtractorContext {
  /** Model an extractor without its own falls back to (`agent.auxModel > agent.model`). */
  defaultModel?: Model
  /**
   * Tracer for wrapping the extractor's model call in a span, parented to the active extraction
   * span. Supplied by the {@link ExtractionCoordinator}; omitted for direct/standalone use.
   * @internal
   */
  tracer?: Tracer
}

/**
 * Transforms conversation messages into discrete, searchable entries.
 *
 * Implementations distill raw turns into facts worth remembering. Optional on a store's
 * {@link ExtractionConfig}: when absent, the manager passes messages straight to the store (see the
 * no-extractor passthrough on {@link MemoryStore}), which is the right path for backends that
 * extract server-side.
 */
export interface Extractor {
  /**
   * Extract entries from a batch of messages.
   *
   * @param messages - The filtered messages to extract from
   * @param context - Optional context (e.g. a fallback model)
   * @returns The entries to write to the store
   */
  extract(messages: MessageData[], context?: ExtractorContext): Promise<ExtractionResult[]>
}

/**
 * Context handed to {@link ExtractionTrigger.attach} so a trigger can wire itself into the agent
 * lifecycle and signal when extraction should run for its store.
 */
export interface ExtractionTriggerContext {
  /** The agent the trigger attaches its hooks to. */
  agent: LocalAgent
  /** Save this store's unsaved messages now. Runs in the background and returns immediately, so calling it from a hook never blocks the agent. To await completion, see {@link MemoryManager.flush}. */
  fire: () => void
}

/**
 * Controls when a store's {@link ExtractionConfig} runs.
 *
 * A trigger is a self-attaching value object: {@link attach} wires whatever agent hooks the trigger
 * needs and calls {@link ExtractionTriggerContext.fire} when extraction should happen. Extend this
 * class for custom triggering logic.
 *
 * A trigger must eventually fire for its store's buffered messages to be written: the high-water-mark
 * dedup means skipped turns are still picked up on the *next* fire, but a trigger that never fires
 * never extracts (and its messages stay buffered for the session). For a guaranteed final write at a
 * boundary, the caller uses {@link MemoryManager.flush}, which force-completes regardless of triggers.
 */
export abstract class ExtractionTrigger {
  /** Stable identifier for this trigger kind, used in logging. */
  abstract readonly name: string

  /**
   * Wire this trigger into the agent lifecycle.
   *
   * Called once per store during {@link MemoryManager} initialization. Register hooks on
   * `context.agent` and call `context.fire()` when extraction should run.
   *
   * @param context - The agent to attach to and the fire callback bound to this trigger's store
   */
  abstract attach(context: ExtractionTriggerContext): void
}

/**
 * Per-store automatic-extraction configuration.
 *
 * Lives on a store (via {@link MemoryStoreConfig}) so different stores can extract on different
 * schedules and in different styles. {@link trigger} decides *when*; {@link extractor} decides *how*
 * (omit it to pass raw messages straight to the store); {@link filter} prunes content blocks first.
 */
export interface ExtractionConfig {
  /**
   * When to run extraction. A single trigger or an array; multiple triggers compose (extraction runs
   * whenever any of them fires). Omit to default to every 5 turns; an explicit empty array is
   * rejected at construction.
   */
  trigger?: ExtractionTrigger | ExtractionTrigger[]
  /**
   * How to turn messages into entries (client-side extraction). When set, the store must implement
   * `add` and each produced entry is stored through it. When omitted, the default depends on the
   * store's write methods: a store implementing `addMessages` uses server-side extraction (the manager
   * hands it the raw messages, no model call), while a store implementing only `add` defaults to a
   * {@link ModelExtractor} that distills facts client-side.
   */
  extractor?: Extractor
  /**
   * Content blocks to strip before extraction. Defaults to {@link DEFAULT_MEMORY_MESSAGE_FILTER}
   * (excludes `toolUse` / `toolResult`).
   *
   * For use cases or extractors with value in distilling over the *full* turn you instead want
   * everything: pass `{ exclude: [] }` so tool blocks reach `addMessages`.
   */
  filter?: MemoryMessageFilter
}
