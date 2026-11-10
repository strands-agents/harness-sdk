/**
 * Integration tests for multi-agent interrupt round-trip through a SessionManager:
 * a fresh orchestrator instance picks up where the previous one paused, with state
 * restored from `FileStorage`.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import { Agent } from '$/sdk/agent/agent.js'
import { tool } from '$/sdk/tools/tool-factory.js'
import { TextBlock } from '$/sdk/types/messages.js'
import { Graph, Status } from '$/sdk/multiagent/index.js'
import { bedrock } from '../__fixtures__/model-providers.js'
import { makeSessionManager } from './_interrupt-helpers.js'

const interruptingWeatherTool = tool({
  name: 'weather_tool',
  description: 'Returns the current weather.',
  inputSchema: z.object({}),
  callback: async (_input, context) =>
    context!.interrupt({ name: 'weather_interrupt', reason: 'need weather' }) as string,
})

describe.skipIf(bedrock.skip)('Multi-agent interrupt session round-trip', () => {
  const createModel = (maxTokens = 1024) => bedrock.createModel({ maxTokens })

  let storageDir: string
  beforeAll(async () => {
    storageDir = join(tmpdir(), `strands-multiagent-interrupt-session-${uuidv7()}`)
    await fs.mkdir(storageDir, { recursive: true })
  })
  afterAll(async () => {
    await fs.rm(storageDir, { recursive: true, force: true })
  })

  it('Graph: tool-interrupt persists and resumes with fresh orchestrator', async () => {
    const sessionId = `graph-tool-${uuidv7()}`
    const buildGraph = (): Graph => {
      const agent = new Agent({
        model: createModel(),
        printer: false,
        id: 'weather',
        tools: [interruptingWeatherTool],
        systemPrompt: 'Use the weather tool then answer.',
      })
      return new Graph({
        nodes: [agent],
        edges: [],
        sessionManager: makeSessionManager(sessionId, storageDir),
      })
    }

    // Pass a ContentBlock[] so the invocation input round-trips through
    // FileStorage JSON as block data and rehydrates into a valid agent message
    // when the node runs on resume.
    const firstResult = await buildGraph().invoke([new TextBlock('What is the weather?')])
    expect(firstResult.status).toBe(Status.INTERRUPTED)
    expect(firstResult.interrupts![0]!.source).toBe('tool')

    const interrupt = firstResult.interrupts![0]!
    const finalResult = await buildGraph().invoke([
      { interruptResponse: { interruptId: interrupt.id, response: 'cloudy' } },
    ])
    expect(finalResult.status).toBe(Status.COMPLETED)
  })
})
