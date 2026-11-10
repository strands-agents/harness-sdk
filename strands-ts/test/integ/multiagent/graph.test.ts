import { describe, expect, it } from 'vitest'
import { Agent } from '$/sdk/agent/agent.js'
import { Graph, Swarm, Status } from '$/sdk/multiagent/index.js'
import { collectGenerator } from '$/sdk/__fixtures__/model-test-helpers.js'
import { bedrock } from '../__fixtures__/model-providers.js'

describe.skipIf(bedrock.skip)('Graph', () => {
  const createModel = (maxTokens = 1024) => bedrock.createModel({ maxTokens })

  it('completes single-node execution with lifecycle events', async () => {
    const agent = new Agent({
      model: createModel(),
      printer: false,
      id: 'assistant',
      systemPrompt: 'Answer in one word only.',
    })

    const graph = new Graph({
      nodes: [agent],
      edges: [],
    })

    const { items, result } = await collectGenerator(graph.stream('What is the capital of France?'))

    expect(result).toEqual(
      expect.objectContaining({
        status: Status.COMPLETED,
        duration: expect.any(Number),
      })
    )
    expect(result.results).toHaveLength(1)
    expect(result.results[0]!.nodeId).toBe('assistant')

    const text = result.content.find((b) => b.type === 'textBlock')
    expect(text?.text).toMatch(/Paris/i)

    const eventTypes = items.map((e) => e.type)
    expect(eventTypes[0]).toBe('beforeMultiAgentInvocationEvent')
    expect(eventTypes).toContain('beforeNodeCallEvent')
    expect(eventTypes).toContain('nodeStreamUpdateEvent')
    expect(eventTypes).toContain('nodeResultEvent')
    expect(eventTypes).toContain('afterNodeCallEvent')
    expect(eventTypes).toContain('afterMultiAgentInvocationEvent')
    expect(eventTypes).toContain('multiAgentResultEvent')
  })

  it('executes linear graph with handoff events', async () => {
    const researcher = new Agent({
      model: createModel(),
      printer: false,
      id: 'researcher',
      systemPrompt: 'Research the topic and provide key facts in 1-2 sentences.',
    })

    const writer = new Agent({
      model: createModel(),
      printer: false,
      id: 'writer',
      systemPrompt: 'Rewrite the input as a single polished sentence.',
    })

    const graph = new Graph({
      nodes: [researcher, writer],
      edges: [['researcher', 'writer']],
    })

    const { items, result } = await collectGenerator(graph.stream('What is the largest ocean?'))

    expect(result).toEqual(
      expect.objectContaining({
        status: Status.COMPLETED,
        duration: expect.any(Number),
      })
    )
    expect(result.results.map((r) => r.nodeId)).toStrictEqual(['researcher', 'writer'])

    const text = result.content.find((b) => b.type === 'textBlock')
    expect(text?.text).toMatch(/Pacific/i)

    const handoff = items.find((e) => e.type === 'multiAgentHandoffEvent')
    expect(handoff).toEqual(
      expect.objectContaining({
        source: 'researcher',
        targets: ['writer'],
      })
    )
  })

  it('executes parallel fan-out graph', async () => {
    const router = new Agent({
      model: createModel(),
      printer: false,
      id: 'router',
      systemPrompt: 'Repeat the user input exactly.',
    })

    const capitals = new Agent({
      model: createModel(),
      printer: false,
      id: 'capitals',
      systemPrompt: 'Answer with only the capital of France in one word.',
    })

    const oceans = new Agent({
      model: createModel(),
      printer: false,
      id: 'oceans',
      systemPrompt: 'Answer with only the largest ocean in one word.',
    })

    const graph = new Graph({
      nodes: [router, capitals, oceans],
      edges: [
        ['router', 'capitals'],
        ['router', 'oceans'],
      ],
    })

    const result = await graph.invoke('Go')

    expect(result).toEqual(
      expect.objectContaining({
        status: Status.COMPLETED,
        duration: expect.any(Number),
      })
    )
    expect(result.results).toHaveLength(3)
    expect(result.results.map((r) => r.nodeId).sort()).toStrictEqual(['capitals', 'oceans', 'router'])

    const text = result.content.map((b) => (b.type === 'textBlock' ? b.text : '')).join(' ')
    expect(text).toMatch(/Paris/i)
    expect(text).toMatch(/Pacific/i)
  })

  it('executes nested graph through MultiAgentNode', async () => {
    const inner = new Swarm({
      id: 'inner-swarm',
      nodes: [
        new Agent({
          model: createModel(),
          printer: false,
          id: 'answerer',
          description: 'Answers questions in one word.',
          systemPrompt: 'Answer in one word only.',
        }),
      ],
      start: 'answerer',
    })

    const summarizer = new Agent({
      model: createModel(),
      printer: false,
      id: 'summarizer',
      systemPrompt: 'Repeat the input exactly as given.',
    })

    const graph = new Graph({
      nodes: [inner, summarizer],
      edges: [['inner-swarm', 'summarizer']],
    })

    const result = await graph.invoke('What is the capital of Japan?')

    expect(result).toEqual(
      expect.objectContaining({
        status: Status.COMPLETED,
        duration: expect.any(Number),
      })
    )
    expect(result.results.map((r) => r.nodeId)).toStrictEqual(['inner-swarm', 'summarizer'])

    const text = result.content.find((b) => b.type === 'textBlock')
    expect(text?.text).toMatch(/Tokyo/i)
  })

  it('executes cycle with conditional edge that breaks after one iteration', async () => {
    let visits = 0

    const agent = new Agent({
      model: createModel(),
      printer: false,
      id: 'counter',
      systemPrompt: 'Reply with the single word "counted".',
    })

    const graph = new Graph({
      nodes: [agent],
      edges: [
        {
          source: 'counter',
          target: 'counter',
          handler: () => {
            visits++
            return visits < 2
          },
        },
      ],
      sources: ['counter'],
    })

    const result = await graph.invoke('Go')

    expect(result).toEqual(
      expect.objectContaining({
        status: Status.COMPLETED,
        duration: expect.any(Number),
      })
    )
    expect(result.results).toHaveLength(2)
    expect(result.results.map((r) => r.nodeId)).toStrictEqual(['counter', 'counter'])
    expect(visits).toBe(2)
  })
})
