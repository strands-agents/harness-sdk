import { describe, expect, it, vi } from 'vitest'
import { Agent } from '../../../agent/agent.js'
import { InvocationContextImpl } from '../../../agent/invocation-context.js'
import { DecisionModel } from '../../../decisions/decision-model.js'
import { Uncertain } from '../../../decisions/types.js'
import { BeforeToolCallEvent } from '../../../hooks/events.js'
import { HookRegistryImplementation } from '../../../hooks/registry.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../../__fixtures__/tool-helpers.js'
import { TextBlock } from '../../../types/messages.js'
import { DecisionModelSteeringHandler } from '../handlers/decision-model.js'
import type { DecisionModelSteeringHandlerConfig } from '../handlers/decision-model.js'
import type { DecisionInput, DecisionResult, Question } from '../../../decisions/types.js'
import type { SteeringContextProvider } from '../providers/context-provider.js'

type SteeringAnswer = 'proceed' | 'guide' | 'confirm' | Uncertain

class StubDecisionModel extends DecisionModel {
  readonly calls: { state: DecisionInput; questions: Record<string, Question> }[] = []

  constructor(private readonly _answer: SteeringAnswer | Error) {
    super()
  }

  protected async _ask<const Q extends Record<string, Question>>(
    state: DecisionInput,
    questions: Q
  ): Promise<DecisionResult<Q>> {
    this.calls.push({ state, questions })
    if (this._answer instanceof Error) throw this._answer
    return {
      answers: { decision: this._answer } as DecisionResult<Q>['answers'],
      usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
      metadata: { latencyMs: 0 },
    }
  }
}

function getHookRegistry(agent: Agent): HookRegistryImplementation {
  return (agent as unknown as { _hooksRegistry: HookRegistryImplementation })._hooksRegistry
}

const SYSTEM_PROMPT = 'Search at most once per request.'
const toolUse = { name: 'searchWeb', toolUseId: 'tu-1', input: { q: 'hi' } }

function createHandler(
  decisionModel: DecisionModel,
  config: Partial<DecisionModelSteeringHandlerConfig> = {}
): DecisionModelSteeringHandler {
  return new DecisionModelSteeringHandler({
    decisionModel,
    systemPrompt: SYSTEM_PROMPT,
    contextProviders: [],
    ...config,
  })
}

async function evaluate(
  handler: DecisionModelSteeringHandler,
  agentConfig: { model?: MockMessageModel; auxModel?: MockMessageModel } = {},
  invocationContext?: InvocationContextImpl
): Promise<BeforeToolCallEvent> {
  const agent = new Agent({ ...agentConfig, interventions: [handler], printer: false })
  await agent.initialize()
  const event = new BeforeToolCallEvent({
    agent,
    toolUse,
    tool: undefined,
    invocationState: {},
    ...(invocationContext && { invocationContext }),
  })
  await getHookRegistry(agent).invokeCallbacks(event)
  return event
}

describe('DecisionModelSteeringHandler', () => {
  describe('decisions', () => {
    async function invokeWithAnswer(answer: SteeringAnswer): Promise<{ stopReason: string; toolExecuted: boolean }> {
      const agentModel = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'searchWeb', toolUseId: 'tool-1', input: { q: 'hi' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('searchWeb', () => {
        toolExecuted = true
        return 'results'
      })

      const agent = new Agent({
        model: agentModel,
        tools: [tool],
        interventions: [createHandler(new StubDecisionModel(answer), { guidance: 'Use the earlier results.' })],
        printer: false,
      })

      const result = await agent.invoke('Search for hi')
      return { stopReason: result.stopReason, toolExecuted }
    }

    it('runs the tool when the decision model answers proceed', async () => {
      expect(await invokeWithAnswer('proceed')).toEqual({ stopReason: 'endTurn', toolExecuted: true })
    })

    it('cancels the tool when the decision model answers guide', async () => {
      expect(await invokeWithAnswer('guide')).toEqual({ stopReason: 'endTurn', toolExecuted: false })
    })

    it('pauses for approval when the decision model answers confirm', async () => {
      expect(await invokeWithAnswer('confirm')).toEqual({ stopReason: 'interrupt', toolExecuted: false })
    })

    it('runs the tool when the decision model is uncertain', async () => {
      expect(await invokeWithAnswer(new Uncertain('no clear pattern'))).toEqual({
        stopReason: 'endTurn',
        toolExecuted: true,
      })
    })
  })

  describe('question', () => {
    it('asks one steering choice question that carries the steering rules', async () => {
      const decisionModel = new StubDecisionModel('proceed')

      await evaluate(createHandler(decisionModel))

      expect(decisionModel.calls).toEqual([
        {
          state: expect.any(String),
          questions: {
            decision: {
              question: expect.stringMatching(/^You are a STEERING AGENT[\s\S]*Search at most once per request\.$/),
              choices: ['proceed', 'guide', 'confirm'],
            },
          },
        },
      ])
    })

    it('replaces the framing with a configured question and keeps the steering rules', async () => {
      const decisionModel = new StubDecisionModel('proceed')

      await evaluate(createHandler(decisionModel, { question: 'Is this search redundant?' }))

      const question = decisionModel.calls[0]!.questions.decision!.question
      expect(question).toMatch(/^Is this search redundant\?/)
      expect(question).toContain('## Steering Rules\n\nSearch at most once per request.')
      expect(question).not.toContain('You are a STEERING AGENT')
    })

    it('explains ledger statuses only when the context includes a ledger', async () => {
      const ledger: SteeringContextProvider = {
        name: 'ledger',
        context: { type: 'toolLedger', data: { tool_calls: [] } },
        observeAgent: async () => {},
      }
      const withLedger = new StubDecisionModel('proceed')
      const withoutLedger = new StubDecisionModel('proceed')

      await evaluate(createHandler(withLedger, { contextProviders: [ledger] }))
      await evaluate(createHandler(withoutLedger))

      expect(withLedger.calls[0]!.questions.decision!.question).toContain('Understanding Ledger Tool States')
      expect(withoutLedger.calls[0]!.questions.decision!.question).not.toContain('Understanding Ledger Tool States')
    })
  })

  describe('state', () => {
    it('describes the steering context and tool call as text', async () => {
      const decisionModel = new StubDecisionModel('proceed')

      await evaluate(createHandler(decisionModel))

      expect(decisionModel.calls[0]!.state).toBe(
        '## Context\n\nNo context available\n\n## Event to Evaluate\n\nTool: searchWeb\nArguments: {\n  "q": "hi"\n}'
      )
    })

    it('uses a configured prompt builder', async () => {
      const decisionModel = new StubDecisionModel('proceed')
      const promptBuilder = vi.fn(() => 'custom state')

      await evaluate(createHandler(decisionModel, { promptBuilder }))

      expect(promptBuilder).toHaveBeenCalledWith([], toolUse)
      expect(decisionModel.calls[0]!.state).toBe('custom state')
    })
  })

  describe('guidance', () => {
    it('cancels with configured string guidance', async () => {
      const event = await evaluate(createHandler(new StubDecisionModel('guide'), { guidance: 'Reuse the results.' }))

      expect(event.cancel).toBe('GUIDANCE: [strands:decision-model-steering-handler] Reuse the results.')
    })

    it('cancels with guidance from a builder that receives the tool call, context, and event', async () => {
      const guidance = vi.fn(async ({ toolUse }: { toolUse: { name: string } }) => `Skip ${toolUse.name}.`)

      const event = await evaluate(createHandler(new StubDecisionModel('guide'), { guidance }))

      expect(guidance).toHaveBeenCalledWith({ toolUse, context: [], event })
      expect(event.cancel).toBe('GUIDANCE: [strands:decision-model-steering-handler] Skip searchWeb.')
    })

    it.each(['proceed', 'confirm'] as const)('does not build guidance when the answer is %s', async (answer) => {
      const guidance = vi.fn(() => 'unused')
      const handler = createHandler(new StubDecisionModel(answer), { guidance })
      const agent = new Agent({ interventions: [handler], printer: false })
      await agent.initialize()

      await handler.beforeToolCall(new BeforeToolCallEvent({ agent, toolUse, tool: undefined, invocationState: {} }))

      expect(guidance).not.toHaveBeenCalled()
    })

    describe('when omitted', () => {
      function guidanceModel(text: string): MockMessageModel {
        return new MockMessageModel().addTurn({ type: 'textBlock', text })
      }

      it('writes guidance with the configured model from the steering rules and tool call', async () => {
        const model = guidanceModel('Use the results you already have.')
        const streamSpy = vi.spyOn(model, 'stream')

        const event = await evaluate(createHandler(new StubDecisionModel('guide'), { model }))

        expect(event.cancel).toBe(
          'GUIDANCE: [strands:decision-model-steering-handler] Use the results you already have.'
        )
        const [messages, options] = streamSpy.mock.calls[0]!
        expect(options?.systemPrompt).toBe(SYSTEM_PROMPT)
        expect(messages[0]!.content).toEqual([
          new TextBlock(expect.stringMatching(/^# Steering Guidance[\s\S]*Tool: searchWeb/)),
        ])
      })

      it('uses agent.auxModel when no model is configured', async () => {
        const agentModel = guidanceModel('unused')
        const auxModel = guidanceModel('From the aux model.')
        const agentStreamSpy = vi.spyOn(agentModel, 'stream')

        const event = await evaluate(createHandler(new StubDecisionModel('guide')), { model: agentModel, auxModel })

        expect(event.cancel).toBe('GUIDANCE: [strands:decision-model-steering-handler] From the aux model.')
        expect(agentStreamSpy).not.toHaveBeenCalled()
      })

      it("falls back to the agent's model", async () => {
        const event = await evaluate(createHandler(new StubDecisionModel('guide')), {
          model: guidanceModel('From the agent model.'),
        })

        expect(event.cancel).toBe('GUIDANCE: [strands:decision-model-steering-handler] From the agent model.')
      })

      it('does not call the model when the answer is proceed', async () => {
        const model = guidanceModel('unused')
        const streamSpy = vi.spyOn(model, 'stream')

        await evaluate(createHandler(new StubDecisionModel('proceed'), { model }))

        expect(streamSpy).not.toHaveBeenCalled()
      })
    })
  })

  describe('request limits', () => {
    it('adds the decision and guidance usage to the request total', async () => {
      const model = new MockMessageModel().addTurn(
        { type: 'textBlock', text: 'Narrow the query.' },
        { usage: { inputTokens: 30, outputTokens: 8, totalTokens: 38 } }
      )
      const parentInvocationContext = new InvocationContextImpl({ turns: 1 })
      parentInvocationContext.usage.turnsTaken = 5

      await evaluate(createHandler(new StubDecisionModel('guide'), { model }), {}, parentInvocationContext)

      expect(parentInvocationContext.usage).toEqual({
        turnsTaken: 5,
        inputTokens: 34,
        outputTokens: 9,
        totalTokens: 43,
      })
    })
  })

  describe('errors', () => {
    it('propagates decision model errors', async () => {
      const handler = createHandler(new StubDecisionModel(new Error('decision failed')))

      await expect(evaluate(handler)).rejects.toThrow('decision failed')
    })
  })

  describe('name', () => {
    it('defaults to strands:decision-model-steering-handler', () => {
      expect(createHandler(new StubDecisionModel('proceed')).name).toBe('strands:decision-model-steering-handler')
    })

    it('accepts an override', () => {
      expect(createHandler(new StubDecisionModel('proceed'), { name: 'redundancy' }).name).toBe('redundancy')
    })
  })
})
