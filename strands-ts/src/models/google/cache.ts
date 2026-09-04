/**
 * Managed CachedContent lifecycle for the Google model provider.
 *
 * Google's native `CachedContent` is a server-side, billed prefix cache keyed by an opaque resource
 * name. This module turns a `CacheConfig` into that resource: it resolves a content-derived identity,
 * reuses an existing cache with the same identity, and otherwise creates one holding the static prefix
 * (system instruction + tools). Identity is a fingerprint of the prefix, never session state, so any
 * caller sending the same prefix - across sessions or processes - shares one resource.
 *
 * The cache is opt-in: a bare or absent `CacheConfig` never creates a billed resource.
 *
 * @internal
 */

import { ApiError, type Caches, type CachedContent, type ContentUnion, type Tool, type ToolConfig } from '@google/genai'
import type { CacheConfig } from '../model.js'
import { logger } from '../../logging/logger.js'
import { warnOnce } from '../../logging/warn-once.js'

// Google caps displayName at 128 characters; a longer cacheKey is hashed to fit.
const DISPLAY_NAME_MAX = 128

// Fallback TTL when neither systemPromptTTL nor ttl names a duration.
const DEFAULT_TTL_SECONDS = 3600

// Length of the content-fingerprint identity; 16 hex chars (64 bits) avoids collisions within a
// caller's cache namespace while keeping display names short.
const FINGERPRINT_LENGTH = 16

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(s|m|h|d)?$/
const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 }

// caches.create failures that mean the prefix cannot be cached (too small, or model unsupported)
// rather than a genuine request error. Wording is not guaranteed stable, so matching stays narrow and
// the raw error is always logged at debug.
const UNCACHEABLE_STATUSES: ReadonlySet<string> = new Set(['INVALID_ARGUMENT', 'FAILED_PRECONDITION'])
const UNCACHEABLE_PHRASES = ['too small', 'minimum', 'cached content is too small', 'token count']

/**
 * Options for resolving a managed `CachedContent` resource.
 *
 * @internal
 */
export interface ResolveCachedContentOptions {
  /** The provider's configured cache settings. */
  cacheConfig: CacheConfig
  /** The Gemini model id the prefix targets. */
  modelId: string
  /** The system instruction to cache as part of the prefix. */
  systemInstruction?: ContentUnion
  /** The formatted Gemini tools to cache as part of the prefix. */
  tools?: Tool[]
  /** The tool config to cache alongside the tools. */
  toolConfig?: ToolConfig
  /** Skip the lookup and always create, used when recovering from an expired cache. */
  forceCreate?: boolean
}

/**
 * Whether a `CacheConfig` opts into managed `CachedContent` rather than implicit-only caching.
 *
 * Managed caching creates a billed resource, so it engages only when the caller set a field Google
 * can honor (`ttl`, a `systemPromptTTL` duration, or `cacheKey`) to a non-default value and did not
 * disable the system-prompt cache. Setting only an unsupported field (e.g. `strategy` or `toolsTTL`)
 * warns and is ignored rather than silently creating a resource, and a bare `{}` leaves today's
 * behavior unchanged.
 *
 * @param cacheConfig - The provider's configured cache settings.
 * @returns True when managed caching should be attempted.
 * @internal
 */
export function shouldEngageManaged(cacheConfig: CacheConfig): boolean {
  if (cacheConfig.systemPromptTTL === false) return false
  return hasSupportedFieldSet(cacheConfig)
}

/**
 * Warns once about configured `CacheConfig` fields Google's managed caching cannot honor.
 *
 * @param cacheConfig - The provider's configured cache settings, if any.
 * @internal
 */
export function warnUnsupported(cacheConfig: CacheConfig | undefined): void {
  if (cacheConfig === undefined) return

  const unsupported: string[] = []
  if (cacheConfig.strategy !== undefined && cacheConfig.strategy !== 'auto') unsupported.push('strategy')
  if (cacheConfig.toolsTTL !== undefined && cacheConfig.toolsTTL !== true) unsupported.push('toolsTTL')
  if (cacheConfig.messagesTTL !== undefined && cacheConfig.messagesTTL !== true) unsupported.push('messagesTTL')
  if (unsupported.length === 0) return

  warnOnce(
    logger,
    `fields=<${unsupported.join(', ')}> | cacheConfig fields have no effect on google managed caching, ignoring`
  )
}

/**
 * Resolves the `CachedContent` TTL as the API's `"<N>s"` form, or undefined to disable caching.
 *
 * Precedence: an explicit `systemPromptTTL` string, then `ttl`, then a one-hour default. A
 * non-positive or unparseable duration disables managed caching - an instantly-expired resource is
 * worse than none.
 *
 * @param cacheConfig - The provider's configured cache settings.
 * @returns The TTL as `"<N>s"`, or undefined to fall back to implicit caching.
 * @internal
 */
export function resolveTtl(cacheConfig: CacheConfig): string | undefined {
  const source = typeof cacheConfig.systemPromptTTL === 'string' ? cacheConfig.systemPromptTTL : cacheConfig.ttl
  const seconds = source === undefined ? DEFAULT_TTL_SECONDS : durationToSeconds(source)
  if (seconds === undefined || seconds <= 0) return undefined
  return `${seconds}s`
}

/**
 * Resolves the `displayName` identifying a reusable prefix, or undefined to opt out of caching.
 *
 * An explicit `cacheKey` is the identity (hashed only when it exceeds the 128-char display-name
 * cap); an empty `cacheKey` opts out. With no `cacheKey`, identity is a content fingerprint over the
 * static prefix (model, system prompt, tools, tool config) so any caller sending the same prefix
 * reuses one resource. The tool config is part of the identity because it is baked into the created
 * resource: two calls that share tools but force different tool choices must not collapse to one
 * cache, or the forced choice would be silently served from the other's baked config. Session
 * identity never contributes.
 *
 * @param cacheConfig - The provider's configured cache settings.
 * @param modelId - The Gemini model id the prefix targets.
 * @param systemInstruction - The system instruction cached as part of the prefix.
 * @param tools - The formatted Gemini tools cached as part of the prefix.
 * @param toolConfig - The tool config cached as part of the prefix.
 * @returns The display name to look up or create under, or undefined to fall back to implicit caching.
 * @internal
 */
export async function resolveDisplayName(
  cacheConfig: CacheConfig,
  modelId: string,
  systemInstruction: ContentUnion | undefined,
  tools: Tool[] | undefined,
  toolConfig: ToolConfig | undefined
): Promise<string | undefined> {
  if (cacheConfig.cacheKey !== undefined) {
    if (cacheConfig.cacheKey === '') return undefined
    if (cacheConfig.cacheKey.length <= DISPLAY_NAME_MAX) return cacheConfig.cacheKey
    return sha256Hex(cacheConfig.cacheKey)
  }

  const prefix = `${modelId}\n${stringifyPrefix(systemInstruction)}\n${toolsFingerprint(tools)}\n${toolConfigFingerprint(toolConfig)}`
  const fingerprint = await sha256Hex(prefix)
  return fingerprint.slice(0, FINGERPRINT_LENGTH)
}

/**
 * Returns the newest existing `CachedContent` resource name matching `displayName`, or undefined.
 *
 * `caches.list()` has no server-side `displayName` filter, so this scans and filters client-side,
 * breaking ties toward the newest `createTime` so a fresh resource supersedes a nearly-expired one.
 *
 * @param caches - The caches client.
 * @param displayName - The identity to match.
 * @returns The matching resource name, or undefined when none exists.
 * @internal
 */
export async function findCachedContent(caches: Caches, displayName: string): Promise<string | undefined> {
  const matches: CachedContent[] = []
  for await (const cached of await caches.list()) {
    if (cached.displayName === displayName && cached.name) matches.push(cached)
  }

  if (matches.length === 0) return undefined

  const newest = matches.reduce((best, cached) => (createTimeKey(cached) >= createTimeKey(best) ? cached : best))
  return newest.name
}

/**
 * Resolves the managed `CachedContent` resource name to attach, or undefined for implicit caching.
 *
 * A straight sequence of early returns: bail unless the config opts into managed caching and there is
 * a prefix to cache, resolve TTL and identity, reuse an existing resource with the same identity, and
 * otherwise create one holding the static prefix (system + tools).
 *
 * @param caches - The caches client.
 * @param options - The prefix and cache settings to resolve against.
 * @returns The resource name to attach, or undefined to fall back to implicit caching.
 * @internal
 */
export async function resolveCachedContent(
  caches: Caches,
  options: ResolveCachedContentOptions
): Promise<string | undefined> {
  const { cacheConfig, modelId, systemInstruction, tools, toolConfig, forceCreate = false } = options

  if (!shouldEngageManaged(cacheConfig)) return undefined

  if (systemInstruction === undefined && (tools === undefined || tools.length === 0)) {
    logger.debug('no system prompt or tools to cache | using implicit caching')
    return undefined
  }

  const ttl = resolveTtl(cacheConfig)
  if (ttl === undefined) return undefined

  const displayName = await resolveDisplayName(cacheConfig, modelId, systemInstruction, tools, toolConfig)
  if (displayName === undefined) return undefined

  if (!forceCreate) {
    const existing = await findCachedContent(caches, displayName)
    if (existing !== undefined) {
      logger.debug(`display_name=<${displayName}>, cached_content=<${existing}> | reusing cached content`)
      return existing
    }
  }

  return createOrImplicit(caches, { model: modelId, systemInstruction, tools, toolConfig, ttl, displayName })
}

/**
 * Whether a `caches.create` error means the prefix is too small or the model unsupported.
 *
 * Matches narrowly on the documented failure statuses plus a token-size phrase; anything else (for
 * example a malformed tool schema) is left to propagate.
 *
 * @param error - The error raised by `caches.create`.
 * @returns True when the failure means the prefix simply cannot be cached.
 * @internal
 */
export function isUncacheable(error: Error): boolean {
  const { status, message } = parseGoogleError(error)
  if (!UNCACHEABLE_STATUSES.has(status)) return false
  const lowerMessage = message.toLowerCase()
  return UNCACHEABLE_PHRASES.some((phrase) => lowerMessage.includes(phrase))
}

/**
 * Whether a generate error means the referenced `cachedContent` no longer exists.
 *
 * A `CachedContent` can expire (TTL) or be deleted between resolve and generate; the server then
 * rejects the request that references it.
 *
 * @param error - The error raised while generating.
 * @returns True when the referenced cache is gone.
 * @internal
 */
export function isMissingCache(error: Error): boolean {
  if (error instanceof ApiError && error.status === 404) return true
  const { status, message } = parseGoogleError(error)
  if (status === 'NOT_FOUND') return true
  const lowerMessage = message.toLowerCase()
  const collapsed = lowerMessage.replace(/ /g, '')
  return (
    collapsed.includes('cachedcontent') &&
    (lowerMessage.includes('not found') || lowerMessage.includes('does not exist'))
  )
}

/**
 * Creates a `CachedContent` for the static prefix, or returns undefined when the prefix is uncacheable.
 *
 * Isolates the one create call so its failure branch stays out of the resolver's control flow. An
 * "uncacheable" failure (prefix too small, or model unsupported) warns once and falls back to
 * implicit caching; any other error propagates so a real request error is never swallowed.
 */
async function createOrImplicit(
  caches: Caches,
  options: {
    model: string
    systemInstruction: ContentUnion | undefined
    tools: Tool[] | undefined
    toolConfig: ToolConfig | undefined
    ttl: string
    displayName: string
  }
): Promise<string | undefined> {
  const config: Parameters<Caches['create']>[0]['config'] = { ttl: options.ttl, displayName: options.displayName }
  if (options.systemInstruction !== undefined) config.systemInstruction = options.systemInstruction
  if (options.tools !== undefined) config.tools = options.tools
  if (options.toolConfig !== undefined) config.toolConfig = options.toolConfig

  try {
    const created = await caches.create({ model: options.model, config })
    logger.debug(`display_name=<${options.displayName}>, cached_content=<${created.name}> | created cached content`)
    return created.name
  } catch (error) {
    if (!(error instanceof Error)) throw error
    logger.debug(`display_name=<${options.displayName}>, error=<${error}> | cached content create failed`)
    if (isUncacheable(error)) {
      warnOnce(
        logger,
        `display_name=<${options.displayName}> | google declined to cache the prompt prefix ` +
          `(prefix too small or model unsupported), proceeding with implicit caching`
      )
      return undefined
    }
    throw error
  }
}

/**
 * Parses a Google API error into its `status`/`message`, matching `errors.ts`.
 *
 * The vendor `ApiError.message` carries a JSON body `{ "error": { "status", "message" } }`; a
 * non-JSON message falls back to the raw string.
 */
function parseGoogleError(error: Error): { status: string; message: string } {
  try {
    const parsed = JSON.parse(error.message)
    return { status: parsed?.error?.status ?? '', message: parsed?.error?.message ?? '' }
  } catch {
    return { status: '', message: error.message ?? '' }
  }
}

/**
 * Converts a duration such as `"5m"`/`"1h"`/`"300s"`/`"2d"` to whole seconds.
 *
 * A bare number is treated as seconds; fractional values truncate to whole seconds.
 */
function durationToSeconds(duration: string): number | undefined {
  const match = DURATION_PATTERN.exec(duration.trim())
  if (match === null || match[1] === undefined) return undefined
  const unitSeconds = UNIT_SECONDS[match[2] ?? 's']
  if (unitSeconds === undefined) return undefined
  return Math.trunc(parseFloat(match[1]) * unitSeconds)
}

/**
 * Reports whether a `CacheConfig` field Google's managed caching can honor is set to a non-default.
 *
 * Only `ttl`, a `systemPromptTTL` duration string, and `cacheKey` engage caching; the rest
 * (`strategy`, `toolsTTL`, `messagesTTL`) warn via `warnUnsupported` and never engage on their own.
 */
function hasSupportedFieldSet(cacheConfig: CacheConfig): boolean {
  return (
    cacheConfig.ttl !== undefined ||
    (cacheConfig.systemPromptTTL !== undefined && cacheConfig.systemPromptTTL !== true) ||
    cacheConfig.cacheKey !== undefined
  )
}

/**
 * Stable serialization of a system instruction for the identity fingerprint.
 */
function stringifyPrefix(systemInstruction: ContentUnion | undefined): string {
  if (systemInstruction === undefined) return ''
  return typeof systemInstruction === 'string' ? systemInstruction : JSON.stringify(systemInstruction)
}

/**
 * Stable serialization of formatted Gemini tools for the identity fingerprint; empty when none.
 */
function toolsFingerprint(tools: Tool[] | undefined): string {
  if (!tools || tools.length === 0) return ''
  return JSON.stringify(tools)
}

/**
 * Stable serialization of the tool config for the identity fingerprint; empty when none.
 */
function toolConfigFingerprint(toolConfig: ToolConfig | undefined): string {
  if (toolConfig === undefined) return ''
  return JSON.stringify(toolConfig)
}

/**
 * Sort key placing the newest `createTime` last; missing times sort oldest.
 */
function createTimeKey(cached: CachedContent): number {
  return cached.createTime ? Date.parse(cached.createTime) : 0
}

/**
 * Returns the hex SHA-256 of `value` via Web Crypto (browser + Node 20+).
 */
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
