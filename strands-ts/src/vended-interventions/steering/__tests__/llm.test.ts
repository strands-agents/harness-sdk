import { describe, expect, it, vi } from 'vitest'
import { Agent } from '../../../agent/agent.js'
import { createInvocation } from '../../../agent/invocation.js'
import { BeforeToolCallEvent } from '../../../hooks/events.js'
import { HookRegistryImplementation } from '../../../hooks/registry.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { LLMSteeringHandler } from '../handlers/llm.js'

function getHookRegistry(agent: Agent): HookRegistryImplementation {
  return (agent as unknown as { _hooksRegistry: HookRegistryImplementation })._hooksRegistry
}

function structuredOutputModel(decision: { type: 'proceed' | 'guide' | 'confirm'; reason: string }): MockMessageModel {
  return new MockMessageModel().addTurn({
    type: 'toolUseBlock',
    name: 'strands_structured_output',
    toolUseId: 'inner-1',
    input: decision,
  })
}

describe('LLMSteeringHandler', () => {
  const toolUse = { name: 'searchWeb', toolUseId: 'tu-1', input: { q: 'hi' } }

  it("defaults to the parent agent's model when none is configured", async () => {
    const model = structuredOutputModel({ type: 'proceed', reason: 'no concerning patterns' })
    const streamSpy = vi.spyOn(model, 'stream')

    const handler = new LLMSteeringHandler({
      systemPrompt: 'You are a steering agent.',
      contextProviders: [],
    })
    const agent = new Agent({ model, interventions: [handler] })
    await agent.initialize()

    const event = new BeforeToolCallEvent({ agent, toolUse, tool: undefined, invocationState: {} })
    await getHookRegistry(agent).invokeCallbacks(event)

    expect(streamSpy).toHaveBeenCalledTimes(1)
    expect(event.cancel).toBe(false)
  })

  it('uses the configured model in preference to the agent model', async () => {
    const agentModel = new MockMessageModel().addTurn({ type: 'textBlock', text: 'unused' })
    const configuredModel = structuredOutputModel({ type: 'proceed', reason: 'ok' })
    const agentStreamSpy = vi.spyOn(agentModel, 'stream')
    const configuredStreamSpy = vi.spyOn(configuredModel, 'stream')

    const handler = new LLMSteeringHandler({
      systemPrompt: 'You are a steering agent.',
      model: configuredModel,
      contextProviders: [],
    })
    const agent = new Agent({ model: agentModel, interventions: [handler] })
    await agent.initialize()

    const event = new BeforeToolCallEvent({ agent, toolUse, tool: undefined, invocationState: {} })
    await getHookRegistry(agent).invokeCallbacks(event)

    expect(configuredStreamSpy).toHaveBeenCalledTimes(1)
    expect(agentStreamSpy).not.toHaveBeenCalled()
  })

  it('throws when no model is configured and the handler has no parent agent', async () => {
    const handler = new LLMSteeringHandler({
      systemPrompt: 'You are a steering agent.',
      contextProviders: [],
    })

    // Detached: never attached to an agent, never observed.
    await expect(handler.beforeToolCall({ toolUse } as unknown as BeforeToolCallEvent)).rejects.toThrow(/no model/i)
  })

  describe('request limits', () => {
    it('adds the steering usage to the request total and runs it past a spent limit', async () => {
      const model = new MockMessageModel().addTurn(
        {
          type: 'toolUseBlock',
          name: 'strands_structured_output',
          toolUseId: 'inner-1',
          input: { type: 'guide', reason: 'narrow the query' },
        },
        { usage: { inputTokens: 30, outputTokens: 8, totalTokens: 38 } }
      )
      const handler = new LLMSteeringHandler({
        systemPrompt: 'You are a steering agent.',
        contextProviders: [],
      })
      const agent = new Agent({ model, interventions: [handler] })
      await agent.initialize()
      const parentInvocation = createInvocation({ turns: 1 })
      parentInvocation.turns = 5

      const event = new BeforeToolCallEvent({
        agent,
        toolUse,
        tool: undefined,
        invocationState: {},
        invocation: parentInvocation,
      })
      await getHookRegistry(agent).invokeCallbacks(event)

      expect(event.cancel).toBe('GUIDANCE: [strands:llm-steering-handler] narrow the query')
      expect(parentInvocation.usage).toEqual({ inputTokens: 30, outputTokens: 8, totalTokens: 38 })
      expect(parentInvocation.turns).toBe(5)
    })
  })
})
