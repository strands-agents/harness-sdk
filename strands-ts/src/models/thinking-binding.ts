/**
 * Recovery for replayed thinking blocks that a history edit invalidated.
 *
 * Preserved-thinking Claude models bind each thinking block to the content before it. When that content
 * changes, enforcing accounts reject the request unless it asks the API to drop the stale blocks.
 */

/**
 * Beta that lets a request drop thinking blocks invalidated by an edit to the history before them.
 *
 * @internal
 */
export const THINKING_BINDING_BETA = 'thinking-binding-controls-2026-08-01'

const THINKING_BINDING_ERROR = 'bound to a different conversation'

/**
 * Beta for on-demand compaction, which summarizes older turns server side so thinking in the turns kept
 * after it stays valid.
 *
 * @internal
 */
export const COMPACTION_BETA = 'compact-2026-09-04'

const PRESERVED_THINKING_MODELS = /claude-(?:opus-5-5|sonnet-5-5|haiku-5-5|fable-5-1)(?!\d)/

/**
 * Whether the model binds each thinking block to the content before it.
 *
 * @internal
 */
export function hasPreservedThinking(modelId: string): boolean {
  return PRESERVED_THINKING_MODELS.test(modelId)
}

/**
 * Whether the provider rejected a replayed thinking block because history before it changed.
 *
 * @internal
 */
export function isThinkingBindingError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(THINKING_BINDING_ERROR)
}

/**
 * Return the thinking config with stale blocks dropped, or undefined if it cannot or should not change.
 *
 * A caller-set `block_binding` is left as written.
 *
 * @internal
 */
export function thinkingWithDropBlock<T>(
  thinking: T
): (T & { block_binding: { prefix_mismatch_behavior: 'drop_block' } }) | undefined {
  if (typeof thinking !== 'object' || thinking === null || Array.isArray(thinking) || 'block_binding' in thinking) {
    return undefined
  }
  return { ...thinking, block_binding: { prefix_mismatch_behavior: 'drop_block' } }
}
