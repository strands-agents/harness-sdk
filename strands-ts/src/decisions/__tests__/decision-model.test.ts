import { describe, expect, it } from 'vitest'

import { Agent } from '../../agent/agent.js'
import { createAuxiliaryInvocationContext, InvocationContextImpl } from '../../agent/invocation-context.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { tool } from '../../tools/tool-factory.js'
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../../tools/structured-output-tool.js'
import { DecisionModel } from '../decision-model.js'
import { LLMDecisionModel } from '../llm-decision-model.js'
import { defineQuestions } from '../types.js'
import type { InvocationContext } from '../../agent/invocation-context.js'
import type { ToolContext } from '../../tools/tool.js'
import type { DecisionResult, Question } from '../types.js'

const QUESTIONS = defineQuestions({ isSafe: { question: 'Is the command safe to run?', choices: 'boolean' } })

const DECISION_USAGE = { inputTokens: 3, outputTokens: 2, totalTokens: 5 }

/** Decision model whose `_ask` returns a fixed result or throws a fixed error. */
class StubDecisionModel extends DecisionModel {
  calls = 0

  constructor(private readonly _outcome: Omit<DecisionResult, 'answers'> | Error) {
    super()
  }

  protected async _ask<const Q extends Record<string, Question>>(): Promise<DecisionResult<Q>> {
    this.calls += 1
    if (this._outcome instanceof Error) throw this._outcome
    return { answers: { isSafe: true }, ...this._outcome } as DecisionResult<Q>
  }
}

describe('DecisionModel', () => {
  describe('ask', () => {
    describe('when given an invocation context', () => {
      it('adds the reported usage to the context', async () => {
        const decision = new StubDecisionModel({ usage: DECISION_USAGE, metadata: { latencyMs: 1 } })
        const invocationContext = new InvocationContextImpl()

        await decision.ask('ls', QUESTIONS, { invocationContext })

        expect(invocationContext.usage).toEqual({ turnsTaken: 0, ...DECISION_USAGE })
      })

      it('adds the reported usage through to the parent request', async () => {
        const decision = new StubDecisionModel({ usage: DECISION_USAGE, metadata: { latencyMs: 1 } })
        const parent = new InvocationContextImpl()

        await decision.ask('ls', QUESTIONS, { invocationContext: createAuxiliaryInvocationContext(parent)! })

        expect(parent.usage).toEqual({ turnsTaken: 0, ...DECISION_USAGE })
      })

      it('still runs and records usage when the request has reached its limit', async () => {
        const decision = new StubDecisionModel({ usage: DECISION_USAGE, metadata: { latencyMs: 1 } })
        const invocationContext = new InvocationContextImpl({ totalTokens: 1 })
        invocationContext.recordUsage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 })

        const result = await decision.ask('ls', QUESTIONS, { invocationContext })

        expect(result.answers).toEqual({ isSafe: true })
        expect(invocationContext.usage).toEqual({ turnsTaken: 0, inputTokens: 4, outputTokens: 3, totalTokens: 7 })
      })

      it('leaves the context unchanged when no usage is reported', async () => {
        const decision = new StubDecisionModel({ metadata: { latencyMs: 1 } })
        const invocationContext = new InvocationContextImpl()

        await decision.ask('ls', QUESTIONS, { invocationContext })

        expect(invocationContext.usage).toEqual({ turnsTaken: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 })
      })

      it('leaves the context unchanged and rethrows when the decision fails', async () => {
        const decision = new StubDecisionModel(new Error('provider down'))
        const invocationContext = new InvocationContextImpl()

        await expect(decision.ask('ls', QUESTIONS, { invocationContext })).rejects.toThrow('provider down')

        expect(invocationContext.usage).toEqual({ turnsTaken: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 })
      })

      it('rejects a context the SDK did not create before deciding', async () => {
        const decision = new StubDecisionModel({ usage: DECISION_USAGE, metadata: { latencyMs: 1 } })

        await expect(decision.ask('ls', QUESTIONS, { invocationContext: {} as InvocationContext })).rejects.toThrow(
          new TypeError('invocationContext was not created by the SDK')
        )

        expect(decision.calls).toBe(0)
      })
    })

    describe('when called from a tool inside a request', () => {
      it("counts the decision's tokens toward the request's usage and limits", async () => {
        const decision = new LLMDecisionModel({
          model: new MockMessageModel().addTurn(
            {
              type: 'toolUseBlock',
              name: STRUCTURED_OUTPUT_TOOL_NAME,
              toolUseId: 'decision-1',
              input: { isSafe: { answer: 'true' } },
            },
            { usage: DECISION_USAGE }
          ),
        })
        const checkCommand = tool({
          name: 'checkCommand',
          description: 'asks whether a command is safe',
          callback: async (_input: unknown, context: ToolContext) => {
            const decisionResult = await decision.ask('ls', QUESTIONS, {
              ...(context.invocationContext && { invocationContext: context.invocationContext }),
            })
            return String(decisionResult.answers.isSafe)
          },
        })
        const agentModel = new MockMessageModel()
          .addTurn([{ type: 'toolUseBlock', name: 'checkCommand', toolUseId: 'tool-1', input: {} }], {
            usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
          })
          .addTurn({ type: 'textBlock', text: 'done' })
        const agent = new Agent({ model: agentModel, tools: [checkCommand], printer: false })

        const result = await agent.invoke('go', { limits: { totalTokens: 15 } })

        expect(result.stopReason).toBe('limitTotalTokens')
        expect(agentModel.callCount).toBe(1)
        expect(result.invocationContext!.usage).toEqual({
          turnsTaken: 1,
          inputTokens: 13,
          outputTokens: 4,
          totalTokens: 17,
        })
      })
    })
  })
})
