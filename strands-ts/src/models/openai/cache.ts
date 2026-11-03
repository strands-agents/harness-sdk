/**
 * Shared prompt-caching translation for OpenAI adapters.
 *
 * Shared routing and retention fields for OpenAI-compatible requests. Content-level Responses
 * checkpoints are handled separately; older models and Chat Completions use implicit caching.
 *
 * @internal
 */

import type { CacheConfig } from '../model.js'
import type { AgentMetadata } from '../../agent/agent-metadata.js'
import { logger } from '../../logging/logger.js'
import { warnOnce } from '../../logging/warn-once.js'

// OpenAI's prompt_cache_retention accepts only these literals. ttl maps through only on an exact
// match — the SDK never guesses a conversion from an arbitrary duration string.
const RETENTION_LITERALS = ['in_memory', '24h'] as const
type RetentionLiteral = (typeof RETENTION_LITERALS)[number]

/**
 * The `CacheConfig`-derived fields both OpenAI request shapes share.
 */
interface CacheableRequest {
  prompt_cache_key?: string
  // Legacy retention literals remain supported here. New Responses TTLs can be passed via
  // native params.prompt_cache_options.ttl without changing existing CacheConfig behavior.
  prompt_cache_retention?: RetentionLiteral | null
}

/**
 * The OpenAI caching values to write, derived from a `CacheConfig`.
 *
 * @internal
 */
interface ResolvedOpenAICache {
  /** Stable identity OpenAI routes cache reads on (wire `prompt_cache_key`). */
  cacheKey?: string
  /** Retention literal to write, set only when the configured `ttl` names one. */
  retention?: RetentionLiteral
}

/**
 * Reports whether any placement field is set to something other than its default.
 *
 * Supported Responses models handle message checkpoints separately. Other placement fields are
 * not translated; a non-default value warrants a one-time warning.
 */
function hasPlacementConfig(cacheConfig: CacheConfig, supportsMessageCaching: boolean): boolean {
  return (
    (!supportsMessageCaching && cacheConfig.strategy !== undefined && cacheConfig.strategy !== 'auto') ||
    (cacheConfig.toolsTTL !== undefined && cacheConfig.toolsTTL !== true) ||
    (cacheConfig.systemPromptTTL !== undefined && cacheConfig.systemPromptTTL !== true) ||
    (!supportsMessageCaching && cacheConfig.messagesTTL !== undefined && cacheConfig.messagesTTL !== true)
  )
}

/**
 * Resolves the prompt-cache routing key: the configured value wins, else derive from the session.
 *
 * Returns the configured `cacheKey` when it names one; `cacheKey === false` is an explicit opt-out
 * (undefined). Left unset, `strands-<sessionId>` when the agent carries a session id, else undefined.
 *
 * @internal
 */
function resolveCacheKey(cacheConfig: CacheConfig, agentMetadata: AgentMetadata | undefined): string | undefined {
  if (cacheConfig.cacheKey === false) return undefined
  if (cacheConfig.cacheKey !== undefined) return cacheConfig.cacheKey
  if (agentMetadata?.sessionId !== undefined) return `strands-${agentMetadata.sessionId}`
  return undefined
}

/**
 * Resolves a `CacheConfig` into OpenAI caching values.
 *
 * The routing key is the configured `cacheKey`, or `strands-<sessionId>` derived from the agent's
 * session when no `cacheKey` is set. `cacheKey === false` opts out, resolving to no key.
 *
 * @internal
 */
export function resolveOpenAICache(
  cacheConfig: CacheConfig,
  agentMetadata?: AgentMetadata,
  supportsMessageCaching = false
): ResolvedOpenAICache {
  const openaiCache: ResolvedOpenAICache = {}

  const cacheKey = resolveCacheKey(cacheConfig, agentMetadata)
  if (cacheKey !== undefined) {
    openaiCache.cacheKey = cacheKey
  }

  if (cacheConfig.ttl !== undefined && (RETENTION_LITERALS as readonly string[]).includes(cacheConfig.ttl)) {
    openaiCache.retention = cacheConfig.ttl as RetentionLiteral
  }

  if (hasPlacementConfig(cacheConfig, supportsMessageCaching)) {
    warnOnce(
      logger,
      supportsMessageCaching
        ? 'openai responses caching | toolsTTL and systemPromptTTL are not applied'
        : 'openai caches prefixes automatically server-side | strategy, toolsTTL, systemPromptTTL and messagesTTL have no effect'
    )
  }

  return openaiCache
}

/**
 * Warns once that a `ttl` is not an OpenAI retention literal and was ignored.
 *
 * @param ttl - The unsupported ttl value; included in the message so `warnOnce`, which dedupes on the
 * exact string, does not collapse distinct misconfigurations into a single warning.
 * @internal
 */
export function warnUnsupportedRetention(ttl: string): void {
  warnOnce(logger, `ttl=<${ttl}> | cacheConfig.ttl is not an openai retention value, ignoring`)
}

/**
 * Maps a `CacheConfig` onto an OpenAI request in place.
 *
 * An explicit value already present in `request` (carried in from the user's `params`) always wins;
 * this fills in only what `params` did not set. A `ttl` that is not an OpenAI retention literal is
 * ignored, and the placement fields (`strategy`, `toolsTTL`, `systemPromptTTL`, `messagesTTL`) have no
 * effect here.
 *
 * The prompt-cache routing key resolves as: the configured `cacheKey` wins when set to a string,
 * `false` opts out; otherwise it falls back to `strands-<sessionId>` when the agent carries a
 * session id. A falsy result (empty or undefined) emits no key.
 *
 * @param request - The request being assembled; mutated in place.
 * @param cacheConfig - The provider's configured cache settings, if any.
 * @param agentMetadata - The invoking agent's metadata, used to derive a routing key when one is unset.
 * @param supportsMessageCaching - Whether the adapter handles message checkpoints separately.
 */
export function applyCacheConfig(
  request: CacheableRequest,
  cacheConfig: CacheConfig | undefined,
  agentMetadata?: AgentMetadata,
  supportsMessageCaching = false
): void {
  if (!cacheConfig) return
  const openaiCache = resolveOpenAICache(cacheConfig, agentMetadata, supportsMessageCaching)

  if (openaiCache.cacheKey && request.prompt_cache_key === undefined) {
    request.prompt_cache_key = openaiCache.cacheKey
  }

  if (request.prompt_cache_retention === undefined) {
    if (openaiCache.retention !== undefined) request.prompt_cache_retention = openaiCache.retention
    else if (cacheConfig.ttl !== undefined) warnUnsupportedRetention(cacheConfig.ttl)
  }
}
