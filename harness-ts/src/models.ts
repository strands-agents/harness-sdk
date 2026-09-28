/**
 * Model resolution from `provider/name` strings, with per-provider reasoning-effort config.
 *
 * Consumers pass a ready `Model` instance, a `"provider/name"` string, a bare Bedrock model
 * id, or `undefined` for the harness default. Every provider uses its real model ids directly.
 * The `effort` level is mapped to each provider's own request fields here, so the caller sets
 * one value regardless of provider.
 *
 * Prompt caching is requested via `caching` and reaches the provider one of two ways: the harness
 * configures Bedrock and Anthropic direct (cache points covering messages and tools), while OpenAI,
 * Google, bedrock-mantle, and litellm cache automatically server-side (Gemini on models 2.5 and
 * newer; litellm through its OpenAI-compatible backend). Only a pre-built `Model` or `ModelRouter`
 * instance can't be honored (its provider is unknown), so a warning is logged.
 *
 * Providers are imported dynamically so a consumer only needs the peer dependency for the
 * provider they actually use (`@anthropic-ai/sdk`, `openai`, or `@google/genai`); Bedrock
 * needs none. This makes resolution async.
 */

import { Model, ModelRouter, type JSONValue } from '@strands-agents/sdk'
import { DEFAULT_MODEL } from './defaults.js'
import { warnOnce } from './logging.js'
import type { Effort } from './types/agent.js'

const ANTHROPIC_MAX_TOKENS = 32_000

// Claude's real max_tokens ceiling by tier, verified live against Bedrock Converse. Applied on
// Bedrock and Anthropic-direct only — other Bedrock-hosted model families aren't known to need
// this. Matched as a substring so any Bedrock region/vendor prefix in front of it doesn't matter.
const CLAUDE_MAX_TOKENS: Readonly<Record<string, number>> = {
  'claude-opus-': 128_000,
  'claude-sonnet-': 128_000,
  'claude-haiku-': 64_000,
  'claude-fable-': 128_000,
}

const CLAUDE_MAX_TOKENS_BY_VERSION: ReadonlyArray<readonly [string, number]> = [
  ['claude-opus-4-5', 64_000],
  ['claude-opus-4.5', 64_000],
  ['claude-sonnet-4-5', 64_000],
  ['claude-sonnet-4.5', 64_000],
]

function claudeMaxTokens(modelId: string): number | undefined {
  const pinned = CLAUDE_MAX_TOKENS_BY_VERSION.find(([needle]) => modelId.includes(needle))?.[1]
  if (pinned !== undefined) {
    return pinned
  }
  return Object.entries(CLAUDE_MAX_TOKENS).find(([needle]) => modelId.includes(needle))?.[1]
}

// Small, fast model per provider for the web_fetch summarizer. Keyed by the main agent's provider
// so the summarizer shares its credentials. Kept byte-identical with `_WEB_FETCH_MODELS` in the
// Python `models.py`.
const WEB_FETCH_MODELS: Record<string, string> = {
  bedrock: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
  'bedrock-mantle': 'openai.gpt-5.6-luna',
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-5.6-luna',
  google: 'gemini-3.5-flash',
}

// Cross-region inference profile prefixes stripped from a Bedrock model id before matching its
// provider family. Kept byte-identical with `_BEDROCK_REGION_PREFIXES` in the Python `models.py`.
// Providers whose endpoint can be repointed by an env var. A non-default endpoint publishes its
// own model list, so the vended small summarizer is not guaranteed to exist on it.
const CUSTOM_ENDPOINT_VARS: Record<string, string | undefined> = {
  anthropic: 'ANTHROPIC_BASE_URL',
  openai: 'OPENAI_BASE_URL',
}

const BEDROCK_REGION_PREFIXES = ['global.', 'apac.', 'us.', 'eu.', 'au.', 'jp.'] as const

// Reasoning levels each provider's API accepts. `'off'` is the harness's spelling of a provider's
// "none" where it has one (OpenAI, Bedrock GPT and Qwen) and omits the reasoning field elsewhere.
// The harness validates against the resolved provider's set so an unsupported level fails here rather
// than as a request error.
const ANTHROPIC_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const OPENAI_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'none'] as const
const BEDROCK_GPT_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const BEDROCK_GPT_OSS_LEVELS = ['low', 'medium', 'high'] as const
const BEDROCK_QWEN_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const BEDROCK_XAI_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const
const GOOGLE_LEVELS = ['minimal', 'low', 'medium', 'high'] as const
const NO_THINKING_LEVELS: readonly string[] = []

const ADAPTIVE_THINKING_SINCE: Record<string, [number, number]> = { opus: [4, 6], sonnet: [4, 6] }
const EXTENDED_THINKING_SINCE: Record<string, [number, number]> = { opus: [4, 5], sonnet: [4, 5], haiku: [4, 5] }
const CLAUDE_ID =
  /claude-(?:(\d{1,2})(?:[-.](\d{1,2}))?-)?(opus|sonnet|haiku|fable|mythos)(?:[-.](\d{1,2}))?(?:[-.](\d{1,2}))?(?!\d)/
const EXTENDED_THINKING_BUDGETS: Readonly<Record<string, number>> = {
  low: 2_048,
  medium: 8_192,
  high: 16_384,
  xhigh: 32_768,
  max: 49_152,
}

function atLeast(version: [number, number], floor: [number, number] | undefined): boolean {
  if (floor === undefined) {
    return false
  }
  return version[0] > floor[0] || (version[0] === floor[0] && version[1] >= floor[1])
}

function claudeThinkingMode(modelId: string): 'adaptive' | 'extended' | null {
  const match = CLAUDE_ID.exec(modelId)
  if (match === null) {
    return 'adaptive'
  }
  const [leadMajor, leadMinor, family, major, minor] = [match[1], match[2], match[3] ?? '', match[4], match[5]]
  if (major === undefined && leadMajor === undefined) {
    const takesAdaptive = EXTENDED_THINKING_SINCE[family] === undefined || ADAPTIVE_THINKING_SINCE[family] !== undefined
    return takesAdaptive ? 'adaptive' : 'extended'
  }
  const version: [number, number] =
    major === undefined ? [Number(leadMajor), Number(leadMinor ?? 0)] : [Number(major), Number(minor ?? 0)]
  if (EXTENDED_THINKING_SINCE[family] === undefined) {
    return 'adaptive'
  }
  if (atLeast(version, ADAPTIVE_THINKING_SINCE[family])) {
    return 'adaptive'
  }
  return atLeast(version, EXTENDED_THINKING_SINCE[family]) ? 'extended' : null
}

function claudeThinking(effort: string): Record<string, unknown> {
  return {
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort },
  }
}

function claudeExtendedThinking(effort: string, maxTokens: number): Record<string, unknown> {
  const budget = Math.min(EXTENDED_THINKING_BUDGETS[effort] ?? EXTENDED_THINKING_BUDGETS.high!, maxTokens - 1)
  return { thinking: { type: 'enabled', budget_tokens: budget } }
}

function claudeThinkingBlock(modelId: string, effort: string, maxTokens: number): Record<string, unknown> {
  return claudeThinkingMode(modelId) === 'extended' ? claudeExtendedThinking(effort, maxTokens) : claudeThinking(effort)
}

function bedrockFamily(modelId: string): string {
  const unprefixed = BEDROCK_REGION_PREFIXES.find((prefix) => modelId.startsWith(prefix))
  return unprefixed ? modelId.slice(unprefixed.length) : modelId
}

function bedrockLevels(modelId: string): readonly string[] {
  const family = bedrockFamily(modelId)
  if (family.startsWith('anthropic.')) {
    return claudeThinkingMode(family) !== null ? ANTHROPIC_LEVELS : NO_THINKING_LEVELS
  }
  if (family.startsWith('openai.gpt-5.6-') || family === 'openai.gpt-6-astra') {
    return BEDROCK_GPT_LEVELS
  }
  if (family.startsWith('openai.gpt-oss-')) {
    return BEDROCK_GPT_OSS_LEVELS
  }
  if (family.startsWith('qwen.')) {
    return BEDROCK_QWEN_LEVELS
  }
  if (family.startsWith('xai.')) {
    return BEDROCK_XAI_LEVELS
  }
  return NO_THINKING_LEVELS
}

function bedrockEffort(modelId: string, effort: Effort): string | null {
  const levels = bedrockLevels(modelId)
  // Families that take no level get none by default; an explicit level is rejected by resolveEffort.
  return resolveEffort(effort, levels.length > 0 ? 'high' : null, levels, `Bedrock model ${modelId}`)
}

function bedrockThinking(modelId: string, effort: string | null): JSONValue | undefined {
  if (effort === null) {
    return undefined
  }
  const family = bedrockFamily(modelId)
  if (family.startsWith('anthropic.')) {
    return claudeThinkingBlock(family, effort, claudeMaxTokens(modelId) ?? ANTHROPIC_MAX_TOKENS) as JSONValue
  }
  if (family.startsWith('openai.gpt-5.6-') || family === 'openai.gpt-6-astra') {
    return { reasoning: { effort } }
  }
  if (family.startsWith('openai.gpt-oss-')) {
    return { reasoning_effort: effort }
  }
  if (family.startsWith('qwen.')) {
    return { reasoning_effort: effort }
  }
  if (family.startsWith('xai.')) {
    return { reasoning_effort: effort }
  }
  return undefined
}

async function bedrock(modelId: string, effort: string | null, _webSearch: boolean, caching: boolean): Promise<Model> {
  const { BedrockModel } = await import('@strands-agents/sdk/models/bedrock')
  // The 'auto' strategy injects cache points (messages and tools) for Anthropic model ids on
  // Bedrock, and is a no-op for models that don't support caching.
  const cacheConfig = caching ? { strategy: 'auto' as const } : undefined
  const thinking = bedrockThinking(modelId, effort)
  const maxTokens = claudeMaxTokens(modelId)
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION
  return new BedrockModel({
    modelId,
    ...(region ? { region } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(cacheConfig ? { cacheConfig } : {}),
    ...(thinking ? { additionalRequestFields: thinking } : {}),
  })
}

async function anthropic(
  modelId: string,
  effort: string | null,
  _webSearch: boolean,
  caching: boolean
): Promise<Model> {
  const { AnthropicModel } = await import('@strands-agents/sdk/models/anthropic')

  const cacheConfig = caching ? { strategy: 'auto' as const } : undefined
  const maxTokens = claudeMaxTokens(modelId) ?? ANTHROPIC_MAX_TOKENS
  return new AnthropicModel({
    modelId,
    maxTokens,
    ...(cacheConfig ? { cacheConfig } : {}),
    ...(effort === null ? {} : { params: claudeThinkingBlock(modelId, effort, maxTokens) }),
  })
}

// `_caching` is unused: OpenAI caches server-side with no opt-in.
async function openai(modelId: string, effort: string | null, webSearch: boolean, _caching: boolean): Promise<Model> {
  const { OpenAIModel } = await import('@strands-agents/sdk/models/openai')
  const params: Record<string, unknown> = {}
  if (effort !== null) {
    params.reasoning = { effort }
  }
  // The Responses API merges built-in tools carried in `params` with the agent's function tools.
  if (webSearch) {
    params.tools = [{ type: 'web_search' }]
  }
  return new OpenAIModel(Object.keys(params).length === 0 ? { modelId } : { modelId, params })
}

// `_caching` is unused: Mantle caches server-side automatically.
async function bedrockMantle(
  modelId: string,
  effort: string | null,
  webSearch: boolean,
  _caching: boolean
): Promise<Model> {
  const { OpenAIModel } = await import('@strands-agents/sdk/models/openai')
  const params: Record<string, unknown> = {}
  if (effort !== null) {
    params.reasoning = { effort }
  }
  if (webSearch) {
    params.tools = [{ type: 'web_search', external_web_access: true }]
  }
  return new OpenAIModel({
    modelId,
    bedrockMantleConfig: {},
    ...(Object.keys(params).length === 0 ? {} : { params }),
  })
}

// `_caching` is unused: Gemini caches implicitly server-side (models 2.5 and newer).
async function gemini(modelId: string, effort: string | null, webSearch: boolean, _caching: boolean): Promise<Model> {
  const { GoogleModel } = await import('@strands-agents/sdk/models/google')
  return new GoogleModel({
    modelId,
    ...(effort === null ? {} : { params: { thinkingConfig: { thinkingLevel: effort } } }),
    // `builtInTools` is appended alongside functionDeclarations, so search coexists with tools.
    ...(webSearch ? { builtInTools: [{ googleSearch: {} }] } : {}),
  })
}

async function ollama(modelId: string, _effort: string | null, _webSearch: boolean, _caching: boolean): Promise<Model> {
  const { OpenAIModel } = await import('@strands-agents/sdk/models/openai')
  return new OpenAIModel({
    api: 'chat',
    modelId,
    apiKey: process.env.OLLAMA_API_KEY ?? 'ollama',
    clientConfig: { baseURL: openAICompatibleBaseUrl(process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434') },
  })
}

// `_caching` is unused: LiteLLM caches server-side via its OpenAI-compatible backend.
async function litellm(
  modelId: string,
  _effort: string | null,
  _webSearch: boolean,
  _caching: boolean
): Promise<Model> {
  const { OpenAIModel } = await import('@strands-agents/sdk/models/openai')
  return new OpenAIModel({
    api: 'chat',
    modelId,
    apiKey: process.env.LITELLM_API_KEY ?? 'litellm',
    clientConfig: {
      baseURL: openAICompatibleBaseUrl(process.env.LITELLM_BASE_URL ?? 'http://127.0.0.1:4000'),
    },
  })
}

function openAICompatibleBaseUrl(value: string): string {
  return value.replace(/\/+$/u, '').endsWith('/v1') ? value.replace(/\/+$/u, '') : `${value.replace(/\/+$/u, '')}/v1`
}

interface Provider {
  build: (modelId: string, effort: string | null, webSearch: boolean, caching: boolean) => Promise<Model>
  recommended: string | null
  levels: readonly string[]
  // Native web search is enabled through model config on the providers whose SDK exposes a
  // non-clobbering seam for it (OpenAI Responses `params.tools` for OpenAI and bedrock-mantle, Gemini
  // `builtInTools`); `hasWebSearch` narrows bedrock-mantle to its GPT-5/GPT-6 models. Bedrock Converse has no
  // mechanism. Anthropic-direct gets `anthropicTools` in @strands-agents/sdk 1.19.0; on 1.18.0 a
  // `params.tools` entry would still overwrite the function tools, so it stays `false` until then
  // (Python already enables it through `anthropic_tools`).
  webSearch: boolean
  // Whether prompt caching is in effect when requested, whether or not the harness configures anything:
  // Bedrock and Anthropic direct (the harness sets cache points and tool caching) plus OpenAI, Google,
  // bedrock-mantle, and litellm (automatic server-side). Only a pre-built `Model` instance can't
  // be honored (its provider is unknown), so the factory warns there.
  caching: boolean
}

const PROVIDERS: Record<string, Provider> = {
  bedrock: { build: bedrock, recommended: 'high', levels: ANTHROPIC_LEVELS, webSearch: false, caching: true },
  'bedrock-mantle': {
    build: bedrockMantle,
    recommended: 'high',
    levels: OPENAI_LEVELS,
    webSearch: true,
    caching: true,
  },
  anthropic: { build: anthropic, recommended: 'high', levels: ANTHROPIC_LEVELS, webSearch: false, caching: true },
  openai: { build: openai, recommended: 'high', levels: OPENAI_LEVELS, webSearch: true, caching: true },
  google: { build: gemini, recommended: 'high', levels: GOOGLE_LEVELS, webSearch: true, caching: true },
  ollama: { build: ollama, recommended: null, levels: NO_THINKING_LEVELS, webSearch: false, caching: false },
  litellm: { build: litellm, recommended: null, levels: NO_THINKING_LEVELS, webSearch: false, caching: true },
}

/** Every value the `effort` option accepts, for validation of untyped (JSON / JS) callers. */
export const EFFORT_LEVELS: readonly Effort[] = ['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * Map an `effort` to the level sent to a provider: the provider's `none` (or `null`, omitting the
 * reasoning field, where it has no such level) for `'off'`, the provider's recommended level for
 * `'auto'`, the level itself when the provider supports it; anything else throws.
 */
function resolveEffort(
  effort: Effort,
  recommended: string | null,
  levels: readonly string[],
  subject = 'this provider'
): string | null {
  if (effort === 'off') {
    return levels.includes('none') ? 'none' : null
  }
  if (effort === 'auto') {
    return recommended
  }
  if (typeof effort === 'string' && levels.includes(effort)) {
    return effort
  }
  if (!EFFORT_LEVELS.includes(effort)) {
    throw new Error(`Effort ${JSON.stringify(effort)} is not valid. Supported: ${EFFORT_LEVELS.join(', ')}.`)
  }
  const supported = levels.filter((level) => level !== 'none')
  const detail =
    supported.length > 0
      ? `Supported levels: ${supported.join(', ')} (or 'auto', 'off').`
      : "It supports no reasoning levels; pass 'auto' or 'off'."
  throw new Error(`Effort ${JSON.stringify(effort)} is not supported by ${subject}. ${detail}`)
}

function splitProvider(spec: string): [string, string] {
  const sepIndex = spec.indexOf('/')
  return sepIndex === -1 ? ['bedrock', spec] : [spec.slice(0, sepIndex), spec.slice(sepIndex + 1)]
}

/**
 * Throw `error` when a feature was requested explicitly but can't be honored; otherwise (the
 * feature is on only by default) warn and let the caller build without it.
 */
function requireOrWarn(explicit: boolean, error: string, warning: string): void {
  if (explicit) {
    throw new Error(error)
  }
  warnOnce(warning)
}

/**
 * Resolve the `model` argument into a concrete `Model` instance.
 *
 * A passed-in `Model`/`ModelRouter` instance is used verbatim; `effort` and `caching` do not apply
 * to it. The harness warns once when one of them was requested explicitly and stays silent when they are
 * only on by default. `webSearch` turns on the model's native search and is only passed for models
 * that have one (`supportsWebSearch`).
 *
 * @param model - A `Model` instance, a `"provider/name"` string, a bare Bedrock model id, or
 *   `undefined` to use `defaultModel`.
 * @param defaultModel - The model string to use when `model` is `undefined`.
 * @param effort - Reasoning effort, mapped to the resolved provider's request fields.
 * @returns The resolved `Model` instance.
 */
export async function resolveModel(
  model: Model | ModelRouter | string | undefined,
  defaultModel: string,
  effort: Effort = 'auto',
  webSearch = false,
  caching = false,
  cachingExplicit = false
): Promise<Model | ModelRouter> {
  if (model instanceof Model || model instanceof ModelRouter) {
    // The instance's provider is unknown, so none of these can be applied; the caller configures
    // them on the instance. Warn (once) and pass the instance through, never throw.
    if (effort !== 'auto') {
      warnOnce(
        `effort ${JSON.stringify(effort)} not applied to a pre-built Model instance or ModelRouter; configure reasoning on the instance`
      )
    }
    if (caching && cachingExplicit) {
      warnOnce('prompt caching not applied to a pre-built Model instance or ModelRouter; configure it on the instance')
    }
    return model
  }
  const spec = model ?? defaultModel

  const [providerName, name] = splitProvider(spec)

  const provider = PROVIDERS[providerName]
  if (provider === undefined) {
    const supported = Object.keys(PROVIDERS).sort().join(', ')
    throw new Error(
      `Unknown model provider ${JSON.stringify(providerName)} in ${JSON.stringify(spec)}. ` +
        `Supported providers: ${supported}. Pass a Model instance for anything else.`
    )
  }

  const nativeSearch = webSearch && hasWebSearch(providerName, name)

  if (caching && !provider.caching) {
    const supported = Object.keys(PROVIDERS)
      .filter((p) => PROVIDERS[p]!.caching)
      .join(', ')
    requireOrWarn(
      cachingExplicit,
      `Provider ${JSON.stringify(providerName)} does not support prompt caching. ` +
        `Providers with caching: ${supported}. Pass caching: false, or switch to a supported provider.`,
      `provider=<${providerName}> | prompt caching not supported by this provider; continuing without it`
    )
  }
  const unsupportedCaching = providerName === 'bedrock' && bedrockFamily(name).startsWith('anthropic.claude-3-haiku-')
  if (caching && unsupportedCaching) {
    requireOrWarn(
      cachingExplicit,
      `Model ${providerName}/${name} does not support prompt caching. Pass caching: false.`,
      `model=<${providerName}/${name}> | prompt caching not supported by this model; continuing without it`
    )
  }

  const claudeDirectWithoutAdaptive = providerName === 'anthropic' && claudeThinkingMode(name) === null
  return provider.build(
    name,
    providerName === 'bedrock'
      ? bedrockEffort(name, effort)
      : resolveEffort(
          effort,
          claudeDirectWithoutAdaptive ? null : provider.recommended,
          claudeDirectWithoutAdaptive ? NO_THINKING_LEVELS : provider.levels,
          claudeDirectWithoutAdaptive ? `model ${name}` : 'this provider'
        ),
    nativeSearch,
    caching && provider.caching && !unsupportedCaching
  )
}

/**
 * Whether `model` accepts image and document blocks in a tool result.
 *
 * OpenAI-family models on Bedrock Converse reject both outright ("This model doesn't support the
 * image field for user messages"), which fails the whole turn rather than degrading, so `read`
 * describes those files in text instead.
 *
 * A `ModelRouter` may switch models mid-conversation, so every candidate has to accept media for the
 * tool to keep emitting it: one rejecting candidate is enough to fail a turn. A `BedrockModel`
 * instance is resolved through its configured `modelId`; any other instance has an unknown provider
 * and is assumed capable. Pass `builtinTools.read.media` to override.
 *
 * Async where the Python `_supports_media` is sync: the SDK's Bedrock model is only reachable
 * through a dynamic import here.
 */
export async function supportsMedia(model: Model | ModelRouter | string | undefined): Promise<boolean> {
  if (model instanceof ModelRouter) {
    const results = await Promise.all(model.candidates.map((candidate) => supportsMedia(candidate.model)))
    return results.every(Boolean)
  }
  if (model instanceof Model) {
    const { BedrockModel } = await import('@strands-agents/sdk/models/bedrock')
    if (!(model instanceof BedrockModel)) {
      return true
    }
    const modelId = model.getConfig().modelId
    return typeof modelId === 'string' ? supportsMedia(modelId) : true
  }
  const [providerName, name] = splitProvider(model ?? DEFAULT_MODEL)
  if (providerName === 'bedrock') {
    return !bedrockFamily(name).startsWith('openai.')
  }
  return true
}

export function supportsThinking(model: Model | ModelRouter | string | undefined): boolean {
  if (model instanceof Model || model instanceof ModelRouter) {
    return true
  }
  const [providerName, name] = splitProvider(model ?? DEFAULT_MODEL)
  if (providerName === 'bedrock') {
    return bedrockLevels(name).length > 0
  }
  if (providerName === 'anthropic') {
    return claudeThinkingMode(name) !== null
  }
  return (PROVIDERS[providerName]?.levels.length ?? 0) > 0
}

/**
 * Whether native web search can be enabled for `model`.
 *
 * A `Model` instance has an unknown provider, so this is `false`; the caller configures search
 * on the instance directly. `undefined` resolves to the default model.
 *
 * @param model - A `Model` instance, a `"provider/name"` string, a bare Bedrock id, or undefined.
 * @returns Whether the resolved model supports native web search.
 */
export function supportsWebSearch(model: Model | ModelRouter | string | undefined): boolean {
  if (model instanceof Model || model instanceof ModelRouter) {
    return false
  }
  const [providerName, name] = splitProvider(model ?? DEFAULT_MODEL)
  return hasWebSearch(providerName, name)
}

function hasWebSearch(providerName: string, name: string): boolean {
  const provider = PROVIDERS[providerName]
  if (provider === undefined || !provider.webSearch) {
    return false
  }
  // Bedrock Web Search is only served for Mantle's GPT-5/GPT-6 models; other families reject the tool (HTTP 400).
  return providerName !== 'bedrock-mantle' || name.startsWith('openai.gpt-5.') || name.startsWith('openai.gpt-6-')
}

/**
 * Resolve the model the web_fetch summarizer runs on.
 *
 * An explicit `webFetchModel` (`builtinTools.web_fetch.model`: a `Model` instance or
 * `"provider/name"` string) wins. With none set, pick the small fast model for the main agent's
 * provider so the summarizer shares its credentials; when the main model is a `Model` instance
 * (provider unknown), reuse it as the summarizer. On Bedrock the summarizer follows the main
 * model's family (Anthropic-on-Bedrock gets Haiku, OpenAI-on-Bedrock gets the OpenAI small model);
 * a Bedrock family we can't identify reuses the main model and logs a warning rather than
 * guessing. Thinking is never applied: summarizing a page is a fast task.
 *
 * `caching` is deliberately not forwarded: the single message carries the per-call prompt before the
 * page body, so every fetch would write a cache entry no later call can read.
 *
 * @param mainModel - The main agent's `model` argument (instance, string, or undefined).
 * @param webFetchModel - Explicit summarizer override, or undefined to use the provider table.
 * @returns The resolved summarizer `Model` instance.
 */
export async function resolveWebFetchModel(
  mainModel: Model | ModelRouter | string | undefined,
  webFetchModel: Model | ModelRouter | string | undefined
): Promise<Model> {
  if (webFetchModel instanceof ModelRouter) {
    return webFetchModel.defaultModel
  }
  if (webFetchModel instanceof Model) {
    return webFetchModel
  }
  if (webFetchModel !== undefined) {
    return concreteModel(await resolveModel(webFetchModel, webFetchModel, 'off'))
  }

  if (mainModel instanceof ModelRouter) {
    return mainModel.defaultModel
  }
  if (mainModel instanceof Model) {
    return mainModel
  }
  const main = mainModel ?? DEFAULT_MODEL
  const [providerName, name] = splitProvider(main)
  let small: string | undefined
  if (providerName === 'bedrock') {
    small = bedrockWebFetchModel(name)
    if (small === undefined) {
      warnOnce(
        `model=<${main}> | could not identify the Bedrock model family for the web_fetch ` +
          'summarizer; reusing the main model. Pass builtinTools.web_fetch.model to choose a smaller one.'
      )
      return concreteModel(await resolveModel(main, main, 'off'))
    }
  } else if (CUSTOM_ENDPOINT_VARS[providerName] && process.env[CUSTOM_ENDPOINT_VARS[providerName]!]) {
    const baseUrlVar = CUSTOM_ENDPOINT_VARS[providerName]!
    warnOnce(
      `model=<${main}> | ${baseUrlVar} points provider <${providerName}> at a non-default endpoint, ` +
        'which serves its own model list, so the vended summarizer may not exist there; reusing the ' +
        'main model. Pass builtinTools.web_fetch.model to choose a smaller one.'
    )
    return concreteModel(await resolveModel(main, main, 'off'))
  } else {
    small = WEB_FETCH_MODELS[providerName]
  }
  if (small === undefined) {
    if (providerName === 'ollama' || providerName === 'litellm') {
      warnOnce(
        `model=<${main}> | no separate web_fetch summarizer is configured for provider ` +
          `<${providerName}>; reusing the main model. Pass builtinTools.web_fetch.model to choose another model.`
      )
      return concreteModel(await resolveModel(main, main, 'off'))
    }
    throw new Error(
      `No default web_fetch model for provider ${JSON.stringify(providerName)}. ` +
        'Pass builtinTools.web_fetch.model explicitly, or disable web_fetch via builtinTools.'
    )
  }
  return concreteModel(await resolveModel(`${providerName}/${small}`, small, 'off'))
}

function concreteModel(model: Model | ModelRouter): Model {
  return model instanceof ModelRouter ? model.defaultModel : model
}

/**
 * Small Bedrock summarizer id for a Bedrock main model `name`, or `undefined` if the family is
 * unidentifiable.
 *
 * Bedrock hosts models from several providers, so the summarizer follows the main model's family.
 * An Anthropic-on-Bedrock model (an `anthropic.` prefix, after any cross-region prefix like `us.`)
 * gets Anthropic Haiku; an OpenAI-on-Bedrock model (an `openai.` prefix) gets the OpenAI small model
 * hosted on Bedrock (`openai.` + the OpenAI-provider summarizer). Either way the summarizer shares
 * the main model's provider. Any other family is unidentifiable and returns `undefined` so the
 * caller can reuse the main model rather than guess.
 */
function bedrockWebFetchModel(name: string): string | undefined {
  const family = bedrockFamily(name)
  if (family.startsWith('anthropic.')) {
    return WEB_FETCH_MODELS.bedrock!
  }
  if (family.startsWith('openai.')) {
    const prefix = name.slice(0, name.length - family.length)
    return `${prefix}openai.${WEB_FETCH_MODELS.openai}`
  }
  return undefined
}
