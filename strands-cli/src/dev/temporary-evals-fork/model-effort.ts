import type { Agent } from '@strands-agents/sdk'

import {
  effortFieldsKey,
  isEffortModelClass,
  ModelEffortUnavailable,
  modelEffort,
  type ModelEffort,
} from '../../model/effort-fields.js'
import { isRecord } from '../../values.js'

const AS_CONFIGURED = 'auto'
const TUNE_INSTRUCTIONS = 'Tune instructions instead (the default).'

export type TemporaryModelEffort =
  | { readonly kind: 'option' }
  | { readonly kind: 'model'; readonly key: string; readonly effort: ModelEffort }
  | { readonly kind: 'unavailable'; readonly reason: string }

const classNames = (model: object): string[] => {
  const names: string[] = []
  for (
    let prototype: unknown = Object.getPrototypeOf(model);
    isRecord(prototype) && prototype !== Object.prototype;
    prototype = Object.getPrototypeOf(prototype)
  )
    names.push((prototype.constructor as { name?: string } | undefined)?.name ?? '')
  return names
}

const configOf = (model: object): Record<string, unknown> => {
  const read = (model as { getConfig?: () => unknown }).getConfig
  const config = typeof read === 'function' ? read.call(model) : undefined
  return isRecord(config) ? config : {}
}

export const temporaryModelEffort = async (model: unknown): Promise<TemporaryModelEffort> => {
  if (model === undefined || model === null || typeof model === 'string') return { kind: 'option' }
  if (typeof model !== 'object')
    return { kind: 'unavailable', reason: `the agent's model is not a model object. ${TUNE_INSTRUCTIONS}` }
  const names = classNames(model)
  const className = names.find((name) => isEffortModelClass(name, false)) ?? names[0] ?? model.constructor.name
  try {
    const key = effortFieldsKey(className, false)
    const config = configOf(model)
    const effort = await modelEffort({
      className,
      python: false,
      modelId: config.modelId,
      fields: config[key],
      maxTokens: config.maxTokens,
      api: config.api,
    })
    return { kind: 'model', key, effort }
  } catch (error) {
    if (!(error instanceof ModelEffortUnavailable)) throw error
    return { kind: 'unavailable', reason: `${error.message} ${TUNE_INSTRUCTIONS}` }
  }
}

export const temporaryEffortDescription = (state: TemporaryModelEffort): Record<string, unknown> =>
  state.kind === 'option'
    ? { effort_unavailable: null }
    : state.kind === 'model'
      ? { effort: state.effort.current, effort_unavailable: null }
      : { effort_unavailable: state.reason }

export const temporaryEffortProblem = (state: TemporaryModelEffort, effort: unknown): string | undefined => {
  if (state.kind !== 'model' || effort === AS_CONFIGURED) return undefined
  try {
    state.effort.fieldsFor(String(effort))
    return undefined
  } catch (error) {
    if (error instanceof ModelEffortUnavailable) return error.message
    throw error
  }
}

export const applyTemporaryModelEffort = (state: TemporaryModelEffort, agent: Agent, effort: unknown): void => {
  if (state.kind !== 'model' || effort === AS_CONFIGURED) return
  const model = agent.model as unknown as { updateConfig(config: Record<string, unknown>): void }
  model.updateConfig({ [state.key]: state.effort.fieldsFor(String(effort)) })
}
