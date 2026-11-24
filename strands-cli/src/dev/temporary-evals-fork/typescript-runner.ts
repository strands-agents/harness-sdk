import { DEFAULT_HARNESS_AGENT_CONFIG, type HarnessAgentOptions } from '@strands-agents/harness'
import type { Agent } from '@strands-agents/sdk'

import {
  effortFieldsKey,
  isEffortModelClass,
  ModelEffortUnavailable,
  modelEffort,
  type ModelEffort,
} from '../../model/effort-fields.js'
import { errorMessage } from '../../terminal/text.js'
import { isRecord } from '../../values.js'

interface TemporaryRunnerProject {
  options: HarnessAgentOptions
  createAgent: (options: HarnessAgentOptions) => Promise<Agent>
}

export interface TemporaryRunnerRequest {
  id: number
  type: 'describe' | 'probe' | 'run' | 'cancel'
  values?: Record<string, unknown>
  input?: unknown
  target?: number
}

export type TemporaryRunnerReply = Record<string, unknown>

const SHARED_STATE_OPTIONS = ['sessionManager', 'memoryManager', 'storage']
const RETRYABLE_ERRORS = new Set(['ModelThrottledError', 'ModelNetworkError'])
const MAX_CAUSE_DEPTH = 3
const TRIAL_OPTIONS = { session: false, memory: false, printer: false }

export const describeTemporaryProject = (options: HarnessAgentOptions): TemporaryRunnerReply => {
  const authored = options as Record<string, unknown>
  return {
    instructions: typeof options.instructions === 'string' ? options.instructions : null,
    effort: typeof options.effort === 'string' ? options.effort : 'auto',
    model: typeof options.model === 'string' ? options.model : null,
    model_is_instance: options.model !== undefined && typeof options.model !== 'string',
    system_prompt: authored.systemPrompt !== undefined,
    shared_state: SHARED_STATE_OPTIONS.filter((key) => authored[key] !== undefined),
  }
}

const WITHOUT = '$without'

const itemName = (entry: unknown): string | undefined =>
  typeof entry === 'string' ? entry : isRecord(entry) && typeof entry.name === 'string' ? entry.name : undefined

const removes = (item: unknown, entry: unknown, position: number | string): boolean =>
  isRecord(item) &&
  ((typeof position === 'number' && item.index === position) ||
    (typeof position === 'string' && item.key === position) ||
    (typeof item.name === 'string' && itemName(entry) === item.name))

const withoutItems = (option: string, current: unknown, items: unknown): unknown => {
  const removed = Array.isArray(items) ? items : []
  // A map edits the harness's own default set, which also keeps web_search off on a model without native search.
  if (current === undefined && option === 'builtinTools')
    return Object.fromEntries(
      removed.flatMap((item) => (isRecord(item) && typeof item.name === 'string' ? [[item.name, false]] : []))
    )
  const base = current ?? (DEFAULT_HARNESS_AGENT_CONFIG as unknown as Record<string, unknown>)[option]
  if (Array.isArray(base)) return base.filter((entry, index) => !removed.some((item) => removes(item, entry, index)))
  if (isRecord(base))
    return Object.fromEntries(
      Object.entries(base).filter(([key, entry]) => !removed.some((item) => removes(item, entry, key)))
    )
  throw new Error(
    `createHarness option ${option} is not a list or a set of named entries, so no item can be turned off`
  )
}

const trialOptions = (project: TemporaryRunnerProject, values: Record<string, unknown>): HarnessAgentOptions => {
  const { [WITHOUT]: without, ...scalars } = values
  const authored = project.options as Record<string, unknown>
  const reduced = Object.fromEntries(
    Object.entries(isRecord(without) ? without : {}).map(([option, items]) => [
      option,
      withoutItems(option, authored[option], items),
    ])
  )
  const tuned = Object.fromEntries(Object.entries(scalars).map(([key, value]) => [key, value ?? undefined]))
  return { ...project.options, ...reduced, ...tuned, ...TRIAL_OPTIONS } as HarnessAgentOptions
}

const textOf = (input: unknown): string => (typeof input === 'string' ? input : JSON.stringify(input))

const release = async (agent: Agent): Promise<void> => {
  try {
    agent.cancel()
  } finally {
    await agent.shutdown()
  }
}

const transcript = (agent: Agent): unknown[] => agent.messages.map((message) => message.toJSON())

const spent = (agent: Agent): TemporaryRunnerReply => ({
  usage: { ...agent.metrics.accumulatedUsage },
  cycles: agent.metrics.cycleCount,
})

const isRetryable = (error: unknown, depth = 0): boolean =>
  error instanceof Error &&
  (RETRYABLE_ERRORS.has(error.name) ||
    RETRYABLE_ERRORS.has(error.constructor.name) ||
    (depth < MAX_CAUSE_DEPTH && isRetryable(error.cause, depth + 1)))

const AS_CONFIGURED = 'auto'
const TUNE_INSTRUCTIONS = 'Tune instructions instead (the default).'

type TemporaryModelEffort =
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

const temporaryModelEffort = async (model: unknown): Promise<TemporaryModelEffort> => {
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

const temporaryEffortDescription = (state: TemporaryModelEffort): Record<string, unknown> =>
  state.kind === 'option'
    ? { effort_unavailable: null }
    : state.kind === 'model'
      ? { effort: state.effort.current, effort_unavailable: null }
      : { effort_unavailable: state.reason }

const temporaryEffortProblem = (state: TemporaryModelEffort, effort: unknown): string | undefined => {
  if (state.kind !== 'model' || effort === AS_CONFIGURED) return undefined
  try {
    state.effort.fieldsFor(String(effort))
    return undefined
  } catch (error) {
    if (error instanceof ModelEffortUnavailable) return error.message
    throw error
  }
}

const applyTemporaryModelEffort = (state: TemporaryModelEffort, agent: Agent, effort: unknown): void => {
  if (state.kind !== 'model' || effort === AS_CONFIGURED) return
  const model = agent.model as unknown as { updateConfig(config: Record<string, unknown>): void }
  model.updateConfig({ [state.key]: state.effort.fieldsFor(String(effort)) })
}

export const createTemporaryTypescriptRunner = (
  project: TemporaryRunnerProject
): ((request: TemporaryRunnerRequest) => Promise<TemporaryRunnerReply | undefined>) => {
  const running = new Map<number, AbortController>()
  let modelEffort: Promise<TemporaryModelEffort> | undefined
  const effortTarget = (): Promise<TemporaryModelEffort> =>
    (modelEffort ??= temporaryModelEffort(project.options.model))
  const splitEffort = async (
    values: Record<string, unknown>
  ): Promise<{ state: TemporaryModelEffort; effort: unknown; options: Record<string, unknown> }> => {
    const state = await effortTarget()
    if (state.kind !== 'model' || !('effort' in values)) return { state, effort: undefined, options: values }
    const { effort, ...options } = values
    return { state, effort, options }
  }

  const probe = async ({ values = {} }: TemporaryRunnerRequest): Promise<TemporaryRunnerReply> => {
    try {
      const { state, effort, options } = await splitEffort(values)
      const problem = temporaryEffortProblem(state, effort)
      if (problem) return { ok: false, error: problem }
      await release(await project.createAgent(trialOptions(project, options)))
      return { ok: true }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  }

  const run = async ({ id, values = {}, input }: TemporaryRunnerRequest): Promise<TemporaryRunnerReply> => {
    const controller = new AbortController()
    running.set(id, controller)
    let agent: Agent | undefined
    try {
      const { state, effort, options } = await splitEffort(values)
      agent = await project.createAgent(trialOptions(project, options))
      applyTemporaryModelEffort(state, agent, effort)
      const result = await agent.invoke(textOf(input), { cancelSignal: controller.signal })
      return { output: result.toString(), messages: transcript(agent), ...spent(agent) }
    } catch (error) {
      return {
        error: errorMessage(error),
        ...(isRetryable(error) ? { retryable: true } : {}),
        messages: agent ? transcript(agent) : [],
        ...(agent ? spent(agent) : {}),
      }
    } finally {
      running.delete(id)
      if (agent) await release(agent)
    }
  }

  return async (request) => {
    switch (request.type) {
      case 'describe':
        return { ...describeTemporaryProject(project.options), ...temporaryEffortDescription(await effortTarget()) }
      case 'probe':
        return probe(request)
      case 'run':
        return run(request)
      case 'cancel':
        running.get(request.target ?? -1)?.abort()
        return undefined
    }
  }
}
