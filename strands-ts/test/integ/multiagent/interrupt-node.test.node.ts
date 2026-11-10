/**
 * Integration tests for interrupts raised by tool callbacks inside a node's child
 * agent. Exercises Graph and Swarm routing the interrupt up through the orchestrator
 * result, then resuming with a response.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Agent, tool } from '@strands-agents/sdk'
import { Graph, Swarm, Status } from '$/sdk/multiagent/index.js'
import { bedrock } from '../__fixtures__/model-providers.js'
import { resumeUntilDone } from './_interrupt-helpers.js'

const interruptingWeatherTool = tool({
  name: 'weather_tool',
  description: 'Returns the current weather.',
  inputSchema: z.object({}),
  callback: async (_input, context) =>
    context!.interrupt({ name: 'weather_interrupt', reason: 'need weather' }) as string,
})

describe.skipIf(bedrock.skip)('Multi-agent tool-callback interrupts', () => {
  const createModel = (maxTokens = 1024) => bedrock.createModel({ maxTokens })

  it('Graph: tool inside a node interrupts, resumes', async () => {
    const weatherAgent = new Agent({
      model: createModel(),
      printer: false,
      id: 'weather',
      tools: [interruptingWeatherTool],
      systemPrompt: 'Use the weather tool to answer the user.',
    })

    const graph = new Graph({ nodes: [weatherAgent], edges: [] })

    const result = await graph.invoke('What is the weather?')
    expect(result.status).toBe(Status.INTERRUPTED)
    expect(result.interrupts).toBeDefined()
    expect(result.interrupts![0]!.name).toBe('weather_interrupt')
    expect(result.interrupts![0]!.source).toBe('tool')

    const finalResult = await resumeUntilDone(
      (responses) => graph.invoke(responses),
      result,
      () => 'cloudy'
    )
    expect(finalResult.status).toBe(Status.COMPLETED)

    const text = finalResult.content
      .filter((b) => b.type === 'textBlock')
      .map((b) => b.text)
      .join(' ')
      .toLowerCase()
    expect(text).toMatch(/cloudy/)
  })

  it('Swarm: tool inside the start agent interrupts, resumes', async () => {
    const weatherAgent = new Agent({
      model: createModel(),
      printer: false,
      id: 'weather',
      tools: [interruptingWeatherTool],
      description: 'Fetches weather data.',
      systemPrompt: 'Use the weather tool, then produce a final response with no handoff.',
    })

    const swarm = new Swarm({ nodes: [weatherAgent], start: 'weather' })

    const result = await swarm.invoke('What is the weather?')
    expect(result.status).toBe(Status.INTERRUPTED)
    expect(result.interrupts![0]!.source).toBe('tool')

    const finalResult = await resumeUntilDone(
      (responses) => swarm.invoke(responses),
      result,
      () => 'cloudy'
    )
    expect(finalResult.status).toBe(Status.COMPLETED)
  })
})
