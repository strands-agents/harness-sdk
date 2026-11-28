import { supportsThinking } from '@strands-agents/harness'
import { EFFORT_LEVELS } from '@strands-agents/harness/internal'

import type { ChatEffortOption } from '../agent/types.js'
import { PROVIDER_IDS, type ProfileEffort, type ProviderId } from '../config/store.js'
import { providerModelExists, type ProviderModelDiscovery } from './discovery.js'
import type { DetectedProviderEnvironment } from './environment.js'

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const OPENAI_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
const OPENAI_NO_MINIMAL_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'] as const
const OPENAI_LOW_TO_XHIGH_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const
const OPENAI_MEDIUM_TO_XHIGH_EFFORTS = ['medium', 'high', 'xhigh'] as const
const OPENAI_HIGH_ONLY_EFFORTS = ['high'] as const
const OPENAI_GPT5_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const
const OPENAI_GPT5_1_EFFORTS = ['none', 'low', 'medium', 'high'] as const
const OPENAI_REASONING_BASIC_EFFORTS = ['low', 'medium', 'high'] as const
const OPENAI_NON_REASONING_PREFIXES = [
  'gpt-4o',
  'gpt-4.1',
  'gpt-4.5',
  'gpt-4',
  'gpt-3.5',
  'chatgpt',
  'o1-mini',
  'o1-preview',
] as const
// Ordered from specialized variants (-pro, -codex) to broader version families.
const OPENAI_EFFORT_RULES: readonly [readonly string[], readonly string[]][] = [
  [['gpt-5-pro'], OPENAI_HIGH_ONLY_EFFORTS],
  [['gpt-5.2-pro', 'gpt-5.4-pro', 'gpt-5.5-pro'], OPENAI_MEDIUM_TO_XHIGH_EFFORTS],
  [
    [
      'gpt-5.1-codex-max',
      'gpt-5.2-codex',
      'gpt-5.3-codex',
      'gpt-6-astra',
      'gpt-6.1-sol',
      'gpt-6.2-astra',
      'gpt-6.2-sol',
    ],
    OPENAI_LOW_TO_XHIGH_EFFORTS,
  ],
  [['gpt-5-codex', 'gpt-5.1-codex', 'o1', 'o3', 'o4', 'codex-mini', 'gpt-oss'], OPENAI_REASONING_BASIC_EFFORTS],
  [['gpt-5.2', 'gpt-5.4', 'gpt-5.5'], OPENAI_NO_MINIMAL_EFFORTS],
  [['gpt-5.1'], OPENAI_GPT5_1_EFFORTS],
  [['gpt-5'], OPENAI_GPT5_EFFORTS],
]
const GOOGLE_EFFORTS = ['low', 'medium', 'high'] as const
const GOOGLE_MINIMAL_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const
// Per-model levels by provider; mirrors MODEL_LEVELS in harness-ts src/models.ts.
const MODEL_EFFORTS: Record<string, [string, readonly string[]][]> = {
  google: [
    ['gemini-3.1-flash-lite-image', ['minimal', 'high']],
    ['gemini-3.6-flash', GOOGLE_MINIMAL_EFFORTS],
    ['gemini-3.5-flash', GOOGLE_MINIMAL_EFFORTS],
    ['gemini-3-flash-preview', GOOGLE_MINIMAL_EFFORTS],
    ['gemini-robotics-er-2-preview', GOOGLE_MINIMAL_EFFORTS],
  ],
  'bedrock-mantle': [['google.gemma-4-', ['none', 'high']]],
}
const BEDROCK_GPT_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const
// Converse rejects max on GPT-5.4/5.5 and none on GPT-6 Astra/6.1 Sol.
const BEDROCK_GPT_NO_MAX_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'] as const
const BEDROCK_GPT_NO_NONE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const BEDROCK_GPT_PREFIXES = ['openai.gpt-5.', 'openai.gpt-daybreak-', 'openai.gpt-6-', 'openai.gpt-6.'] as const
const BEDROCK_GPT_OSS_EFFORTS = ['low', 'medium', 'high'] as const
const BEDROCK_QWEN_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const BEDROCK_XAI_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const
/**
 * The CLI's loose runtime form of an effort setting: a level name, `auto`, or a toggle. Narrowed
 * to the library's `Effort` with `profileEffort()` before it reaches `createHarness`.
 */
export type EffortInput = string | boolean | null | undefined

export interface SelectableModel {
  id: string
  name: string
  description: string
  value?: string
  active?: boolean
  catalog?: ProviderId | 'current'
}

export type ProviderModelDiscoveryFunction = (
  provider: ProviderId,
  environment: DetectedProviderEnvironment
) => Promise<ProviderModelDiscovery>

export class ModelControlError extends Error {}

export function modelControlErrorMessage(error: unknown, control: 'model' | 'effort'): string {
  return error instanceof ModelControlError
    ? error.message
    : `Could not change ${control}. Check your provider connection and try again.`
}

export async function validateModelSelection(
  modelId: string,
  discover: ProviderModelDiscoveryFunction | undefined,
  environment: DetectedProviderEnvironment,
  selectionHint = 'Use /model to choose an available model.'
): Promise<void> {
  const target = resolveModelTarget(modelId)
  if (!discover || target.modelId.startsWith('arn:')) {
    return
  }
  const catalog = await discover(target.provider as ProviderId, environment).catch(() => undefined)
  const knownModelIds = catalog?.knownModelIds ?? catalog?.models.map((model) => model.id)
  const normalizeId = (id: string): string =>
    target.provider === 'google'
      ? id.replace(/^models\//u, '')
      : target.provider === 'ollama'
        ? id.replace(/:latest$/u, '')
        : id
  if (knownModelIds?.some((id) => normalizeId(id) === normalizeId(target.modelId))) {
    return
  }
  const complete = catalog?.complete ?? ['ollama', 'openai', 'bedrock-mantle', 'litellm'].includes(target.provider)
  const invalid =
    target.provider === 'anthropic' || target.provider === 'google'
      ? (await providerModelExists(target.provider, target.modelId, environment)) === false
      : catalog?.available && complete
  if (invalid) {
    throw new ModelControlError(`Unknown model ${JSON.stringify(modelId)}. ${selectionHint}`)
  }
}

export function validateEffortSelection(effort: string, options: readonly ChatEffortOption[]): void {
  const supported = [...options.map((option) => option.id), 'auto', 'off']
  if (!supported.includes(effort)) {
    throw new ModelControlError(
      `Reasoning effort ${JSON.stringify(effort)} is not supported. Choose: ${supported.join(', ')}.`
    )
  }
}

export interface ModelTarget {
  provider: string
  modelId: string
  specifier: string
}

export function effortValue(thinking: EffortInput): string {
  if (thinking === null || thinking === false) {
    return 'off'
  }
  if (thinking === true || thinking === undefined || thinking === 'auto') {
    return 'high'
  }
  return thinking
}

/** The persisted form keeps `auto` as `auto`: only an explicitly chosen effort is written as a level. */
export function profileEffort(thinking: EffortInput): ProfileEffort {
  if (thinking === true || thinking === undefined || thinking === 'auto') {
    return 'auto'
  }
  const value = effortValue(thinking)
  if (value === 'none') {
    return 'off'
  }
  return EFFORT_LEVELS.find((level) => level === value) ?? 'auto'
}

function matchesOpenaiPrefix(modelId: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => modelId === prefix || modelId.startsWith(`${prefix}-`))
}

function openaiEfforts(modelId: string): readonly string[] {
  if (
    modelId === 'chat-latest' ||
    modelId.includes('-chat-latest') ||
    matchesOpenaiPrefix(modelId, OPENAI_NON_REASONING_PREFIXES)
  ) {
    return []
  }
  const matched = OPENAI_EFFORT_RULES.find(([prefixes]) => matchesOpenaiPrefix(modelId, prefixes))
  if (matched !== undefined) {
    return matched[1]
  }
  // Unmatched OpenAI/shared codenames (e.g. gpt-5.6*, gpt-6-sol, gpt-6-luna,
  // gpt-6.1-terra, gpt-6-cyber) fail open to full OPENAI_EFFORTS, matching Bedrock's
  // unrestricted GPT defaults and setup-policy tests (only astra/6.1-sol/6.2-* drop none/minimal).
  return OPENAI_EFFORTS
}

function effortLevels(modelId: string): readonly string[] {
  const target = resolveModelTarget(modelId)
  if (target.provider === 'openai') {
    return openaiEfforts(target.modelId)
  }
  if (!supportsThinking(target.specifier)) {
    return []
  }
  const modelEfforts = MODEL_EFFORTS[target.provider]?.find(([prefix]) => target.modelId.startsWith(prefix))?.[1]
  if (modelEfforts) {
    return modelEfforts
  }
  if (target.provider === 'anthropic') {
    return CLAUDE_EFFORTS
  }
  if (target.provider === 'bedrock-mantle') {
    return OPENAI_EFFORTS
  }
  if (target.provider === 'google') {
    return GOOGLE_EFFORTS
  }
  const family = target.modelId.replace(/^(?:global|apac|us-gov|us|eu|au|jp)\./, '')
  if (family.startsWith('anthropic.')) {
    return CLAUDE_EFFORTS
  }
  if (family.startsWith('openai.gpt-5.4') || family.startsWith('openai.gpt-5.5')) {
    return BEDROCK_GPT_NO_MAX_EFFORTS
  }
  if (family.startsWith('openai.gpt-6-astra') || family.startsWith('openai.gpt-6.1-sol')) {
    return BEDROCK_GPT_NO_NONE_EFFORTS
  }
  if (BEDROCK_GPT_PREFIXES.some((prefix) => family.startsWith(prefix))) {
    return BEDROCK_GPT_EFFORTS
  }
  if (family.startsWith('openai.gpt-oss-')) {
    return BEDROCK_GPT_OSS_EFFORTS
  }
  if (family.startsWith('qwen.')) {
    return BEDROCK_QWEN_EFFORTS
  }
  if (family.startsWith('xai.')) {
    return BEDROCK_XAI_EFFORTS
  }
  return []
}

export function effortOptions(modelId: string, thinking: EffortInput): ChatEffortOption[] {
  const levels = effortLevels(modelId)
  const current = effortValue(thinking)
  return levels.map((effort) => ({
    id: effort,
    label: effort === 'none' ? 'Off' : effortDisplayLabel(effort),
    ...(effort === current || (effort === 'none' && current === 'off') ? { active: true } : {}),
  }))
}

export function effortDisplayLabel(thinking: EffortInput): string {
  if (thinking === null || thinking === false || thinking === 'off') {
    return 'Off'
  }
  if (thinking === true || thinking === undefined || thinking === 'auto') {
    return 'Auto'
  }
  return thinking === 'xhigh' ? 'Extra high' : thinking[0]!.toUpperCase() + thinking.slice(1)
}

export function effortForModel(
  modelId: string,
  thinking: Exclude<EffortInput, undefined>
): Exclude<EffortInput, undefined> {
  const levels = effortLevels(modelId)
  const current = effortValue(thinking)
  if (current === 'none') {
    return 'off'
  }
  if (current === 'off' || levels.includes(current)) {
    return thinking
  }
  return 'auto'
}

export function resolveModelTarget(modelId: string): ModelTarget {
  const trimmed = modelId.trim()
  if (!trimmed) {
    throw new ModelControlError('Model ID must not be empty.')
  }
  if (/\s/u.test(trimmed)) {
    throw new ModelControlError('Enter one model ID without spaces. Use /model to choose an available model.')
  }

  const separator = trimmed.indexOf('/')
  if (separator !== -1) {
    const provider = trimmed.slice(0, separator)
    const targetId = trimmed.slice(separator + 1)
    if (!/^[a-z][a-z0-9_-]*$/i.test(provider)) {
      return { provider: 'bedrock', modelId: trimmed, specifier: trimmed }
    }
    if (!targetId) {
      throw new ModelControlError('Model ID must not be empty.')
    }
    if (!PROVIDER_IDS.includes(provider as ProviderId)) {
      throw new ModelControlError(
        `Unsupported model provider ${JSON.stringify(provider)}. Use /model to choose a model.`
      )
    }
    return { provider, modelId: targetId, specifier: trimmed }
  }
  return { provider: 'bedrock', modelId: trimmed, specifier: trimmed }
}
