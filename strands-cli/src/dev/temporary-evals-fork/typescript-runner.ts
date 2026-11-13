import type { HarnessAgentOptions } from '@strands-agents/harness'
import type { Agent } from '@strands-agents/sdk'

import { errorMessage } from '../../terminal/text.js'

export interface TemporaryRunnerProject {
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

const trialOptions = (project: TemporaryRunnerProject, values: Record<string, unknown>): HarnessAgentOptions => {
  const tuned = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value ?? undefined]))
  return { ...project.options, ...tuned, ...TRIAL_OPTIONS } as HarnessAgentOptions
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

export const createTemporaryTypescriptRunner = (
  project: TemporaryRunnerProject
): ((request: TemporaryRunnerRequest) => Promise<TemporaryRunnerReply | undefined>) => {
  const running = new Map<number, AbortController>()

  const probe = async ({ values = {} }: TemporaryRunnerRequest): Promise<TemporaryRunnerReply> => {
    try {
      await release(await project.createAgent(trialOptions(project, values)))
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
      agent = await project.createAgent(trialOptions(project, values))
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
        return describeTemporaryProject(project.options)
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
