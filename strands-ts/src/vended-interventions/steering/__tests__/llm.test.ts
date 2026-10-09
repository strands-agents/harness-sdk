import { describe, expect, it, vi } from 'vitest'
import { Agent } from '../../../agent/agent.js'
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

  it('uses agent.auxModel when none is configured', async () => {
    const agentModel = new MockMessageModel().addTurn({ type: 'textBlock', text: 'unused' })
    const auxModel = structuredOutputModel({ type: 'proceed', reason: 'ok' })
    const agentStreamSpy = vi.spyOn(agentModel, 'stream')
    const auxStreamSpy = vi.spyOn(auxModel, 'stream')

    const handler = new LLMSteeringHandler({
      systemPrompt: 'You are a steering agent.',
      contextProviders: [],
    })
    const agent = new Agent({ model: agentModel, auxModel, interventions: [handler] })
    await agent.initialize()

    const event = new BeforeToolCallEvent({ agent, toolUse, tool: undefined, invocationState: {} })
    await getHookRegistry(agent).invokeCallbacks(event)

    expect(auxStreamSpy).toHaveBeenCalledTimes(1)
    expect(agentStreamSpy).not.toHaveBeenCalled()
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

  it('resolves agent.auxModel at tool-call time, so reassignment takes effect', async () => {
    const agentModel = new MockMessageModel().addTurn({ type: 'textBlock', text: 'unused' })
    const firstAux = structuredOutputModel({ type: 'proceed', reason: 'ok' })
    const secondAux = structuredOutputModel({ type: 'proceed', reason: 'ok' })
    const firstSpy = vi.spyOn(firstAux, 'stream')
    const secondSpy = vi.spyOn(secondAux, 'stream')

    const handler = new LLMSteeringHandler({
      systemPrompt: 'You are a steering agent.',
      contextProviders: [],
    })
    const agent = new Agent({ model: agentModel, auxModel: firstAux, interventions: [handler] })
    await agent.initialize()
    agent.auxModel = secondAux

    const event = new BeforeToolCallEvent({ agent, toolUse, tool: undefined, invocationState: {} })
    await getHookRegistry(agent).invokeCallbacks(event)

    expect(secondSpy).toHaveBeenCalledTimes(1)
    expect(firstSpy).not.toHaveBeenCalled()
  })
})
