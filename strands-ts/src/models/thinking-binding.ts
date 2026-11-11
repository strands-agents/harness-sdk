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
 * A caller-set `block_binding` is left as written. Without a config, adaptive thinking is added, since these models
 * think adaptively by default and some reject a config without a type; a forced tool rules thinking out.
 *
 * @internal
 */
export function thinkingWithDropBlock<T>(
  thinking: T | undefined,
  toolForced = false
): (T & { block_binding: { prefix_mismatch_behavior: 'drop_block' } }) | undefined {
  const config = thinking === undefined && !toolForced ? ({ type: 'adaptive' } as T) : thinking
  if (typeof config !== 'object' || config === null || Array.isArray(config) || 'block_binding' in config) {
    return undefined
  }
  return { ...config, block_binding: { prefix_mismatch_behavior: 'drop_block' } }
}
