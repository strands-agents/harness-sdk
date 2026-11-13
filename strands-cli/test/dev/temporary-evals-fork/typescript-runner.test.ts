import type { HarnessAgentOptions } from '@strands-agents/harness'
import type { Agent } from '@strands-agents/sdk'
import { describe, expect, it, vi } from 'vitest'

import {
  createTemporaryTypescriptRunner,
  describeTemporaryProject,
} from '../../../src/dev/temporary-evals-fork/typescript-runner.js'

const OPTIONS = { instructions: 'Answer briefly.', effort: 'low', model: 'bedrock/test' } as HarnessAgentOptions
const RESULT = { toString: () => 'answer' }

class ModelThrottledError extends Error {}

const fakeAgent = (invoke: (input: string, options: { cancelSignal: AbortSignal }) => Promise<unknown>) => {
  const agent = {
    invoke: vi.fn(invoke),
    messages: [{ toJSON: () => ({ role: 'assistant', content: [{ text: 'answer' }] }) }],
    metrics: { accumulatedUsage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 }, cycleCount: 2 },
    cancel: vi.fn(),
    shutdown: vi.fn(async () => {}),
  }
  return agent
}

const projectWith = (agent: ReturnType<typeof fakeAgent>) => {
  const createAgent = vi.fn(async (_options: HarnessAgentOptions) => agent as unknown as Agent)
  return { project: { options: OPTIONS, createAgent }, createAgent }
}

describe('TEMPORARY TypeScript runner', () => {
  it.each([
    {
      options: { ...OPTIONS, systemPrompt: 'You are terse.', sessionManager: {} },
      expected: {
        model: 'bedrock/test',
        model_is_instance: false,
        system_prompt: true,
        shared_state: ['sessionManager'],
      },
    },
    {
      options: { instructions: 'Answer briefly.', model: {} },
      expected: { effort: 'auto', model: null, model_is_instance: true, system_prompt: false, shared_state: [] },
    },
  ])('shouldDescribeTheCreateHarnessOptionsWhenAskedToDescribe', ({ options, expected }) => {
    expect(describeTemporaryProject(options as unknown as HarnessAgentOptions)).toMatchObject({
      instructions: 'Answer briefly.',
      ...expected,
    })
  })

  it('shouldBuildAFreshAgentWithTheCandidateValuesAndTrialOptionsWhenRunning', async () => {
    const agent = fakeAgent(async () => RESULT)
    const { project, createAgent } = projectWith(agent)
    const handle = createTemporaryTypescriptRunner(project)

    const reply = await handle({
      id: 1,
      type: 'run',
      values: { effort: 'high', instructions: null },
      input: 'question',
    })

    expect(createAgent).toHaveBeenCalledWith({
      ...OPTIONS,
      effort: 'high',
      instructions: undefined,
      session: false,
      memory: false,
      printer: false,
    })
    expect(agent.invoke).toHaveBeenCalledWith('question', expect.objectContaining({ cancelSignal: expect.anything() }))
    expect(reply).toEqual({
      output: 'answer',
      messages: [{ role: 'assistant', content: [{ text: 'answer' }] }],
      usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
      cycles: 2,
    })
    expect(agent.shutdown).toHaveBeenCalledTimes(1)
  })

  it('shouldReturnTheErrorAndTheTranscriptWhenTheAgentFails', async () => {
    const agent = fakeAgent(async () => {
      throw new Error('model refused')
    })
    const handle = createTemporaryTypescriptRunner(projectWith(agent).project)

    const reply = await handle({ id: 1, type: 'run', values: {}, input: 'question' })

    expect(reply).toEqual({
      error: 'model refused',
      messages: [{ role: 'assistant', content: [{ text: 'answer' }] }],
      usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
      cycles: 2,
    })
    expect(agent.shutdown).toHaveBeenCalledTimes(1)
  })

  it.each([
    { error: new ModelThrottledError('slow down'), retryable: true },
    { error: new Error('stream failed', { cause: new ModelThrottledError('slow down') }), retryable: true },
    { error: new Error('model refused'), retryable: false },
  ])('shouldMarkTheFailureRetryableOnlyWhenTheModelWasThrottled', async ({ error, retryable }) => {
    const agent = fakeAgent(async () => {
      throw error
    })
    const handle = createTemporaryTypescriptRunner(projectWith(agent).project)

    const reply = await handle({ id: 1, type: 'run', values: {}, input: 'question' })

    expect(reply?.retryable === true).toBe(retryable)
  })

  it('shouldReportWhetherTheAgentBuildsWhenProbing', async () => {
    const agent = fakeAgent(async () => RESULT)
    const { project, createAgent } = projectWith(agent)
    createAgent.mockImplementation(async (options) => {
      if (options.effort === 'max') throw new Error("Effort 'max' is not supported")
      return agent as unknown as Agent
    })
    const handle = createTemporaryTypescriptRunner(project)

    expect(await handle({ id: 1, type: 'probe', values: { effort: 'high' } })).toEqual({ ok: true })
    expect(await handle({ id: 2, type: 'probe', values: { effort: 'max' } })).toEqual({
      ok: false,
      error: "Effort 'max' is not supported",
    })
  })

  it('shouldAbortTheRunWhenTheStudyCancelsIt', async () => {
    const agent = fakeAgent(
      (_input, { cancelSignal }) =>
        new Promise((_resolve, reject) => {
          cancelSignal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        })
    )
    const handle = createTemporaryTypescriptRunner(projectWith(agent).project)

    const running = handle({ id: 7, type: 'run', values: {}, input: 'question' })
    await vi.waitFor(() => expect(agent.invoke).toHaveBeenCalled())
    await handle({ id: 8, type: 'cancel', target: 7 })

    expect(await running).toMatchObject({ error: 'cancelled' })
  })
})
