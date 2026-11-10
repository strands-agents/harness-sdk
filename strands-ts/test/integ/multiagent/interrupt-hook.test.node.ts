/**
 * Integration tests for orchestrator-hook interrupts — interrupts raised from
 * `BeforeNodeCallEvent.interrupt()` to gate a node before it runs.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Agent, tool } from '@strands-agents/sdk'
import { Graph, Swarm, Status, BeforeNodeCallEvent } from '$/sdk/multiagent/index.js'
import { bedrock } from '../__fixtures__/model-providers.js'
import { resumeUntilDone } from './_interrupt-helpers.js'

const weatherTool = tool({
  name: 'weather_tool',
  description: 'Returns the current weather.',
  inputSchema: z.object({}),
  callback: async () => 'sunny',
})

describe.skipIf(bedrock.skip)('Multi-agent orchestrator-hook interrupts', () => {
  const createModel = (maxTokens = 1024) => bedrock.createModel({ maxTokens })

  it('Graph: hook gates a node before it runs, resume approves', async () => {
    const agent = new Agent({
      model: createModel(),
      printer: false,
      id: 'execute',
      tools: [weatherTool],
      systemPrompt: 'Use the tool and briefly answer.',
    })

    const graph = new Graph({ nodes: [agent], edges: [] })
    graph.addHook(BeforeNodeCallEvent, (event) => {
      if (event.nodeId !== 'execute') return
      const response = event.interrupt<string>({ name: 'execute_approval', reason: 'approve?' })
      if (response !== 'APPROVE') event.cancel = 'rejected'
    })

    const result = await graph.invoke('What is the weather?')
    expect(result.status).toBe(Status.INTERRUPTED)
    expect(result.interrupts![0]!.source).toBe('multiagent-hook')
    expect(result.interrupts![0]!.name).toBe('execute_approval')

    const finalResult = await resumeUntilDone(
      (responses) => graph.invoke(responses),
      result,
      () => 'APPROVE'
    )
    expect(finalResult.status).toBe(Status.COMPLETED)
  })

  it('Graph: hook rejection cancels the node', async () => {
    const agent = new Agent({
      model: createModel(),
      printer: false,
      id: 'execute',
      tools: [weatherTool],
    })

    const graph = new Graph({ nodes: [agent], edges: [] })
    graph.addHook(BeforeNodeCallEvent, (event) => {
      if (event.nodeId !== 'execute') return
      const response = event.interrupt<string>({ name: 'execute_approval', reason: 'approve?' })
      if (response !== 'APPROVE') event.cancel = 'rejected'
    })

    const result = await graph.invoke('anything')
    expect(result.status).toBe(Status.INTERRUPTED)

    const finalResult = await resumeUntilDone(
      (responses) => graph.invoke(responses),
      result,
      () => 'REJECT'
    )
    const executeResult = finalResult.results.find((r) => r.nodeId === 'execute')
    expect(executeResult?.status).toBe(Status.CANCELLED)
  })

  it('Swarm: hook gates the start node, resume approves', async () => {
    const agent = new Agent({
      model: createModel(),
      printer: false,
      id: 'assistant',
      description: 'Answers questions briefly.',
      systemPrompt: 'Answer in one word only.',
    })

    const swarm = new Swarm({ nodes: [agent], start: 'assistant' })
    swarm.addHook(BeforeNodeCallEvent, (event) => {
      event.interrupt({ name: 'approval', reason: 'approve?' })
    })

    const result = await swarm.invoke('What is the capital of France?')
    expect(result.status).toBe(Status.INTERRUPTED)
    expect(result.interrupts![0]!.source).toBe('multiagent-hook')

    const finalResult = await resumeUntilDone(
      (responses) => swarm.invoke(responses),
      result,
      () => 'APPROVE'
    )
    expect(finalResult.status).toBe(Status.COMPLETED)

    const text = finalResult.content.find((b) => b.type === 'textBlock')
    expect(text?.text).toMatch(/Paris/i)
  })
})
