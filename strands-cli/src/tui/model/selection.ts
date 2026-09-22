import { supportsThinking } from '@strands-agents/harness'

import type { ChatEffortOption } from '../chat/controller.js'
import { PROVIDER_IDS, type ProfileEffort, type ProviderId } from '../config.js'
import type { DetectedProviderEnvironment } from '../provider/environment.js'
import { providerModelExists, type ProviderModelDiscovery } from '../provider/discovery.js'

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const OPENAI_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
const GOOGLE_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const
const BEDROCK_GPT_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const BEDROCK_GPT_OSS_EFFORTS = ['low', 'medium', 'high'] as const
const BEDROCK_QWEN_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const BEDROCK_XAI_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const
/**
 * The CLI's loose runtime form of an effort setting: a level name, `auto`, or a toggle. Narrowed
 * to the library's `Effort` with `profileEffort()` before it reaches `createHarness`.
 */
export type EffortInput = string | boolean | null | undefined

const PROFILE_EFFORT_LEVELS: readonly ProfileEffort[] = [
  'auto',
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

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
  const supported = [...options.map((option) => option.id), 'auto']
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
  return PROFILE_EFFORT_LEVELS.find((level) => level === value) ?? 'auto'
}

function effortLevels(modelId: string): readonly string[] {
  const target = resolveModelTarget(modelId)
  if (!supportsThinking(target.specifier)) {
    return []
  }
  if (target.provider === 'anthropic') {
    return CLAUDE_EFFORTS
  }
  if (target.provider === 'openai' || target.provider === 'bedrock-mantle') {
    return OPENAI_EFFORTS
  }
  if (target.provider === 'google') {
    return GOOGLE_EFFORTS
  }
  const family = target.modelId.replace(/^(?:global|apac|us-gov|us|eu|au|jp)\./, '')
  if (family.startsWith('anthropic.')) {
    return CLAUDE_EFFORTS
  }
  if (family.startsWith('openai.gpt-5.6-') || family === 'openai.gpt-6-astra') {
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
  if (levels.includes(current) || (current === 'off' && levels.includes('none'))) {
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
