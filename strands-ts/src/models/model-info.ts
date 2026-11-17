/**
 * What the SDK knows about models: the {@link ModelInfo} type, and the shared model info data.
 *
 * Every {@link ModelInfo} field is optional, and a missing or undefined field means unknown. The same
 * shape is used everywhere: the shared data file, the `modelInfo`
 * config override, and the resolved {@link Model.modelInfo}. A known `'unsupported'` disables a feature;
 * unknown leaves the SDK's existing default for that feature in place.
 *
 * `model-info.json` is copied from `shared/model-info.json` at the repository root (the source of truth for
 * every SDK) on install (`prepare`) and before build (`prebuild`); it is not committed.
 *
 * This is the first slice of the shape proposed in the model metadata design (PR #5305). Fields are
 * added when something outside the provider reads them.
 */

import modelInfoData from './model-info.json' with { type: 'json' }
/** How a model supports prompt caching. */
export type PromptCaching = 'unsupported' | 'auto' | 'cachePoints'

/**
 * What the model can do. A yes/no fact is a `boolean`; a fact with more than two states is a string
 * union, like {@link PromptCaching} (which mechanism). A fact about two features together gets its
 * own field named after the pair. `undefined` is unknown either way.
 */
export interface ModelCapabilities {
  /** Whether the model keeps conversation state server-side; {@link Model.stateful} reads it. */
  readonly stateful?: boolean | undefined
  /** Whether and how the model caches prompts. */
  readonly promptCaching?: PromptCaching | undefined
  /** Whether the model accepts a `toolChoice` that forces a tool call (`any` or a named tool). */
  readonly forcedToolChoice?: boolean | undefined
  /** Whether the provider can make the model's text output conform to a JSON schema. */
  readonly nativeStructuredOutput?: boolean | undefined
  /**
   * Whether the model summarizes history server-side through {@link Model.summarize}; set `false` in `modelInfo`
   * to summarize client-side.
   */
  readonly serverSideSummary?: boolean | undefined
  /**
   * Whether the model and provider take temporary messages: injected text the model reads only until the next user
   * message, such as Anthropic's turn-scoped system messages. When `true`, the provider receives each `InjectedBlock`
   * as stored and formats it; otherwise it receives only the latest user message's injected text, as text. The shared
   * data lists the models that take them, but `Model.modelInfo` reports `false` unless the provider can send them
   * (`AnthropicModel`). A `modelInfo` override that turns it on for another provider drops the injected text.
   */
  readonly temporaryMessages?: boolean | undefined
}

/** Size limits of the model. */
export interface ModelLimits {
  /** Context window size in tokens. */
  readonly contextWindow?: number | undefined
  /** Largest `maxTokens` the model accepts. Providers that need a default `maxTokens` use it. */
  readonly maxOutputTokens?: number | undefined
}

/** Everything the SDK knows about a model. Read it from {@link Model.modelInfo}. */
export interface ModelInfo {
  readonly capabilities?: ModelCapabilities
  readonly limits?: ModelLimits
}

function defined<T extends object>(section: T): T | undefined {
  const entries = Object.entries(section).filter(([, value]) => value !== undefined)
  return entries.length === 0 ? undefined : (Object.freeze(Object.fromEntries(entries)) as T)
}

/** Operations on {@link ModelInfo} records, like Python's `ModelInfo.merge`. */
export const ModelInfo = Object.freeze({
  /**
   * Merges partial records, later defined fields winning. Undefined and missing fields inherit.
   * A provider overriding {@link Model.modelInfo} layers its facts and then the user's override:
   * `ModelInfo.merge(super.modelInfo, { capabilities: { serverSideSummary: false } }, this.getConfig().modelInfo)`.
   *
   * @param parts - Partial records, in order of increasing precedence; `undefined` parts are skipped
   * @returns A new frozen record with only the known fields; a section nothing is known about is omitted
   */
  merge(...parts: (ModelInfo | undefined)[]): ModelInfo {
    const capabilities: Record<string, unknown> = {}
    const limits: Record<string, unknown> = {}
    for (const part of parts) {
      for (const [key, value] of Object.entries(part?.capabilities ?? {}))
        if (value !== undefined) capabilities[key] = value
      for (const [key, value] of Object.entries(part?.limits ?? {})) if (value !== undefined) limits[key] = value
    }
    const merged: { capabilities?: ModelCapabilities; limits?: ModelLimits } = {}
    const mergedCapabilities = defined(capabilities as ModelCapabilities)
    const mergedLimits = defined(limits as ModelLimits)
    if (mergedCapabilities) merged.capabilities = mergedCapabilities
    if (mergedLimits) merged.limits = mergedLimits
    return Object.freeze(merged)
  },
})

/**
 * Turns `serverSideSummary` off for providers that serve a model the shared info lists it for but have no
 * server-side summary of their own.
 *
 * @internal
 */
export const SERVER_SIDE_SUMMARY_OFF: ModelInfo = Object.freeze({ capabilities: { serverSideSummary: false } })

/**
 * An API a provider reaches a model through, where that API changes what the model supports: `'converse'` is the
 * Bedrock Converse API (`BedrockModel`, and `VercelModel` on amazon-bedrock).
 *
 * @internal
 */
export type ModelApi = 'converse'

/**
 * Where a model takes cache points, as far as it differs from the provider's own rules. Kept out of
 * {@link ModelInfo}; read it with {@link lookupCachePointRules}.
 *
 * @internal
 */
export interface CachePointRules {
  /** `'afterText'` when a cache point may sit only directly after text; unset leaves the provider's rule. */
  readonly cachePointPlacement?: 'afterText'
  /** `false` when the model rejects a cache point after the tool definitions. */
  readonly toolsCachePoint?: boolean
  /** `false` when the model rejects any cache point `ttl`. */
  readonly cachePointTTL?: boolean
  /** Most cache points one request may carry, across tool definitions, system prompt and messages. */
  readonly maxCachePoints?: number
}

/**
 * A shared model info entry: the model's {@link ModelInfo}, what changes on a given API, and its cache-point rules.
 *
 * @internal
 */
export interface ModelEntry extends ModelInfo {
  /** Facts that hold only on one API, merged over the entry by {@link lookupModelInfo}. */
  readonly apis?: Readonly<Partial<Record<ModelApi, ModelInfo>>>
  /** Where the model takes cache points. */
  readonly cachePointRules?: CachePointRules
}

interface ModelInfoData {
  readonly defaults: {
    readonly limits: { readonly contextWindow: number }
    readonly cachePointRules: CachePointRules & { readonly maxCachePoints: number }
  }
  readonly models: Readonly<Record<string, ModelEntry>>
}

// Bedrock appends a version to some ids (`claude-3-5-haiku-20241022-v1:0`); the base id carries the facts.
const VERSION_SUFFIX = /-(?:v\d+(?::\d+)?|\d+:\d+)$/
// Dated snapshots (`claude-opus-5-5-20260401`, `claude-haiku-4-5@20251001`) share the undated model's facts.
const DATE_SUFFIX = /[-@]\d{8}$/

const data = modelInfoData as ModelInfoData

/** Context window limit (in tokens) assumed for a model whose window is unknown. */
export const DEFAULT_CONTEXT_WINDOW_LIMIT = data.defaults.limits.contextWindow

const CAPABILITY_FIELDS = Object.keys({
  stateful: true,
  promptCaching: true,
  forcedToolChoice: true,
  nativeStructuredOutput: true,
  serverSideSummary: true,
  temporaryMessages: true,
} satisfies Record<keyof ModelCapabilities, true>)
const LIMIT_FIELDS = Object.keys({ contextWindow: true, maxOutputTokens: true } satisfies Record<
  keyof ModelLimits,
  true
>)
const MODEL_APIS = Object.keys({ converse: true } satisfies Record<ModelApi, true>)
const CACHE_POINT_RULE_FIELDS = Object.keys({
  cachePointPlacement: true,
  toolsCachePoint: true,
  cachePointTTL: true,
  maxCachePoints: true,
} satisfies Record<keyof CachePointRules, true>)

function pick(section: object | undefined, keys: readonly string[]): object | undefined {
  const picked = Object.fromEntries(Object.entries(section ?? {}).filter(([key]) => keys.includes(key)))
  return Object.keys(picked).length > 0 ? picked : undefined
}

// Keeps the fields the SDK types and skips the rest, as the Python SDK does: the data file is shared
// with other consumers (the harness), so it can carry fields the SDK doesn't read.
function knownFields(entry: ModelInfo): ModelInfo {
  const capabilities = pick(entry.capabilities, CAPABILITY_FIELDS)
  const limits = pick(entry.limits, LIMIT_FIELDS)
  return { ...(capabilities ? { capabilities } : {}), ...(limits ? { limits } : {}) } as ModelInfo
}

function knownEntry(entry: ModelEntry): ModelEntry {
  const apis = Object.entries(pick(entry.apis, MODEL_APIS) ?? {}).map(([api, info]) => [api, knownFields(info)])
  const cachePointRules = pick(entry.cachePointRules, CACHE_POINT_RULE_FIELDS)
  return {
    ...knownFields(entry),
    ...(apis.length > 0 ? { apis: Object.fromEntries(apis) } : {}),
    ...(cachePointRules ? { cachePointRules } : {}),
  } as ModelEntry
}

const MODELS: Readonly<Record<string, ModelEntry>> = Object.fromEntries(
  Object.entries(data.models).map(([id, entry]) => [id, Object.freeze(knownEntry(entry))])
)

/**
 * Finds the entry for a model id. Tries the id as given, then without a trailing Bedrock version
 * suffix, then without a trailing date, then with each leading dot-separated segment removed in
 * turn (`us.anthropic.claude-x` → `anthropic.claude-x` → `claude-x`), the same rule the Python SDK
 * applies. One entry therefore serves a model across providers and snapshots: `claude-opus-5-5`
 * answers for `anthropic.claude-opus-5-5-20260401-v1:0` too.
 *
 * @internal
 * @param modelId - The model id to look up
 * @returns The entry, or undefined when the id is not in the data
 */
export function lookupModel(modelId: string): ModelEntry | undefined {
  let candidate = modelId
  for (;;) {
    const unversioned = candidate.replace(VERSION_SUFFIX, '')
    for (const key of [candidate, unversioned, unversioned.replace(DATE_SUFFIX, '')]) {
      if (Object.hasOwn(MODELS, key)) return MODELS[key]
    }
    const dotIndex = candidate.indexOf('.')
    if (dotIndex === -1) return undefined
    candidate = candidate.substring(dotIndex + 1)
  }
}

/**
 * What the shared model info data knows about a model, on `api` when given.
 *
 * @internal
 * @param modelId - The model id to describe
 * @param api - The API the model is reached through; its facts win over the entry's
 * @returns What the data knows about the model; empty when it knows nothing
 */
export function lookupModelInfo(modelId: string, api?: ModelApi): ModelInfo {
  const entry = lookupModel(modelId)
  return ModelInfo.merge(entry, api ? entry?.apis?.[api] : undefined)
}

/**
 * Where a model takes cache points: the data's defaults, then the model's own rules.
 *
 * @internal
 * @param modelId - The model id to look up
 * @returns The model's cache-point rules; the defaults when the data does not list it
 */
export function lookupCachePointRules(modelId: string): CachePointRules & { readonly maxCachePoints: number } {
  return Object.freeze({ ...data.defaults.cachePointRules, ...lookupModel(modelId)?.cachePointRules })
}

/**
 * Whether `api` caches a model implicitly while the model takes cache points elsewhere, so a caller who wants cache
 * points must reach it through another API.
 *
 * @internal
 * @param modelId - The model id to look up
 * @param api - The API the model is reached through
 * @returns True when `api` caches implicitly and the model's entry takes cache points
 */
export function cachePointsOnlyOffApi(modelId: string, api: ModelApi): boolean {
  return (
    lookupModelInfo(modelId, api).capabilities?.promptCaching === 'auto' &&
    lookupModelInfo(modelId).capabilities?.promptCaching === 'cachePoints'
  )
}

/**
 * Looks up the context window limit for a model id.
 *
 * @internal
 * @param modelId - The model id to look up
 * @returns The context window limit in tokens, or undefined if not known
 */
export function getContextWindowLimit(modelId: string): number | undefined {
  return lookupModelInfo(modelId).limits?.contextWindow
}
