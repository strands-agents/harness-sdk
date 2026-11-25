import { isDeepStrictEqual } from 'node:util'

import type { Effort } from '@strands-agents/harness'
import { EFFORT_LEVELS, resolveModel } from '@strands-agents/harness/internal'

import { errorMessage } from '../terminal/text.js'
import { isRecord } from '../values.js'

export type ReasoningFields = Record<string, unknown>

interface ModelClass {
  readonly provider: string
  readonly key: string
}

const TYPESCRIPT_CLASSES: Readonly<Record<string, ModelClass>> = {
  BedrockModel: { provider: 'bedrock', key: 'additionalRequestFields' },
  AnthropicModel: { provider: 'anthropic', key: 'params' },
  OpenAIModel: { provider: 'openai', key: 'params' },
}

const PYTHON_CLASSES: Readonly<Record<string, ModelClass>> = {
  BedrockModel: { provider: 'bedrock', key: 'additional_request_fields' },
  AnthropicModel: { provider: 'anthropic', key: 'params' },
  OpenAIResponsesModel: { provider: 'openai', key: 'params' },
}

const HARNESS_FIELDS: Readonly<Record<string, string>> = {
  bedrock: 'additionalRequestFields',
  anthropic: 'params',
  openai: 'params',
}

const classesFor = (python: boolean): Readonly<Record<string, ModelClass>> =>
  python ? PYTHON_CLASSES : TYPESCRIPT_CLASSES

const AUTO = 'auto'

export interface ModelObject {
  readonly className: string
  readonly python: boolean
  readonly modelId: unknown
  readonly fields: unknown
  readonly maxTokens?: unknown
  readonly api?: unknown
}

export interface ModelEffort {
  readonly spec: string
  readonly levels: readonly string[]
  readonly current: string
  fieldsFor(effort: string): ReasoningFields | undefined
}

export class ModelEffortUnavailable extends Error {}

export const isEffortModelClass = (className: string, python: boolean): boolean => className in classesFor(python)

const modelClassOf = (className: string, python: boolean): ModelClass => {
  const classes = classesFor(python)
  const modelClass = classes[className]
  if (!modelClass)
    throw new ModelEffortUnavailable(
      `strands dev can set effort only on ${Object.keys(classes).join(', ')} objects, not on ${className}.`
    )
  return modelClass
}

export const effortFieldsKey = (className: string, python: boolean): string => modelClassOf(className, python).key

const withinTokenLimit = (fields: ReasoningFields | undefined, maxTokens: unknown): ReasoningFields | undefined => {
  const thinking = fields?.thinking
  if (!fields || !isRecord(thinking) || typeof thinking.budget_tokens !== 'number' || typeof maxTokens !== 'number')
    return fields
  return thinking.budget_tokens < maxTokens
    ? fields
    : { ...fields, thinking: { ...thinking, budget_tokens: maxTokens - 1 } }
}

const harnessFields = async (spec: string, key: string, effort: string): Promise<ReasoningFields | undefined> => {
  const model = (await resolveModel(spec, spec, effort as Effort)) as unknown as { getConfig(): ReasoningFields }
  const value = model.getConfig()[key]
  return isRecord(value) ? value : undefined
}

const entriesWhere = (fields: ReasoningFields, keep: (key: string) => boolean): ReasoningFields =>
  Object.fromEntries(Object.entries(fields).filter(([key]) => keep(key)))

export const modelEffort = async ({
  className,
  python,
  modelId,
  fields,
  maxTokens,
  api,
}: ModelObject): Promise<ModelEffort> => {
  const modelClass = modelClassOf(className, python)
  if (modelClass.provider === 'openai' && api === 'chat')
    throw new ModelEffortUnavailable(
      `The ${className} uses the Chat Completions API, and the harness sets effort only for the Responses API.`
    )
  if (typeof modelId !== 'string' || !modelId)
    throw new ModelEffortUnavailable(
      `The ${className} sets no model id, so strands dev cannot look up its reasoning settings.`
    )
  const spec = `${modelClass.provider}/${modelId}`
  const results = await Promise.allSettled(
    EFFORT_LEVELS.map((level) => harnessFields(spec, HARNESS_FIELDS[modelClass.provider]!, level))
  )
  const byLevel = new Map<string, ReasoningFields | undefined>()
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') byLevel.set(EFFORT_LEVELS[index]!, withinTokenLimit(result.value, maxTokens))
  })
  if (byLevel.size === 0) {
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    throw new ModelEffortUnavailable(
      `strands dev could not read the reasoning settings for ${spec}: ${errorMessage(failure?.reason)}`
    )
  }
  const controlled = new Set([...byLevel.values()].flatMap((value) => Object.keys(value ?? {})))
  const configured = isRecord(fields) ? fields : {}
  const reasoning = entriesWhere(configured, (key) => controlled.has(key))
  const levels = EFFORT_LEVELS.filter((level) => level !== AUTO && byLevel.has(level))
  return {
    spec,
    levels,
    current: levels.find((level) => isDeepStrictEqual(reasoning, byLevel.get(level) ?? {})) ?? AUTO,
    fieldsFor: (effort): ReasoningFields | undefined => {
      if (!byLevel.has(effort))
        throw new ModelEffortUnavailable(
          `${spec} does not support effort "${effort}". It supports ${[AUTO, ...levels].join(', ')}.`
        )
      const merged = { ...entriesWhere(configured, (key) => !controlled.has(key)), ...byLevel.get(effort) }
      return Object.keys(merged).length > 0 ? merged : undefined
    },
  }
}
