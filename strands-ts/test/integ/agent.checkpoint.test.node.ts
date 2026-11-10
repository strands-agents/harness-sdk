/**
 * Integration tests for agent checkpointing with Amazon Bedrock.
 *
 * These exercise the V0 durable-execution contract: an agent with
 * `checkpointing: true` pauses at ReAct cycle boundaries and returns an
 * `AgentResult` with `stopReason: 'checkpoint'` and a populated `checkpoint`.
 * State persistence is the caller's job; these tests pair checkpointing with a
 * file-backed `SessionManager` to demonstrate the recommended pattern —
 * SessionManager for state continuity, Checkpoint for boundary signalling.
 *
 * Requires AWS credentials (skipped otherwise) and may incur Bedrock costs.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import { Agent, tool, SessionManager, FileStorage, type Tool } from '@strands-agents/sdk'
import { type Checkpoint, type CheckpointData } from '@strands-agents/sdk/experimental'
import { bedrock } from './__fixtures__/model-providers.js'

const SYSTEM_PROMPT =
  'You are a helpful assistant. When a user asks a factual question, you MUST call the ' +
  'provided tools to answer. Do not answer from memory.'

/**
 * Build a checkpointing agent backed by a file-based SessionManager. A fresh
 * agent with the same `sessionId` rehydrates messages from the session store,
 * so it can resume at a captured checkpoint position.
 */
function buildAgent(tools: Tool[], sessionId: string, storageDir: string): Agent {
  return new Agent({
    model: bedrock.createModel(),
    tools,
    systemPrompt: SYSTEM_PROMPT,
    sessionManager: new SessionManager({ sessionId, storage: { snapshot: new FileStorage(storageDir) } }),
    checkpointing: true,
    printer: false,
  })
}

/**
 * Drive a checkpointing agent to `endTurn` across fresh Agent instances. Each
 * pause: serialize the checkpoint (round-tripped through JSON to prove it
 * survives persistence), discard the agent, build a fresh one with the same
 * `sessionId`, and pass the checkpoint back as a `checkpointResume` block.
 */
async function driveToCompletion(
  tools: Tool[],
  firstPrompt: string,
  sessionId: string,
  storageDir: string,
  maxResumes = 10
): Promise<{ agent: Agent; checkpoints: Checkpoint[] }> {
  let agent = buildAgent(tools, sessionId, storageDir)
  let result = await agent.invoke(firstPrompt)

  const checkpoints: Checkpoint[] = []
  let resumes = 0
  while (result.stopReason === 'checkpoint') {
    expect(result.checkpoint).toBeDefined()
    checkpoints.push(result.checkpoint!)

    // Round-trip through JSON to prove the checkpoint survives serialization.
    const persisted = JSON.parse(JSON.stringify(result.checkpoint!.toJSON())) as CheckpointData

    // Discard the agent; a fresh one with the same sessionId rehydrates messages
    // from the session store, then resumes at the captured checkpoint position.
    agent = buildAgent(tools, sessionId, storageDir)
    result = await agent.invoke({ checkpointResume: { checkpoint: persisted } })

    resumes++
    if (resumes > maxResumes) {
      throw new Error(`exceeded maxResumes=${maxResumes} without reaching endTurn`)
    }
  }

  expect(result.stopReason).toBe('endTurn')
  return { agent, checkpoints }
}

/** Lower-cased concatenation of all text and tool-result text across the agent's messages. */
function conversationText(agent: Agent): string {
  const parts: string[] = []
  for (const message of agent.messages) {
    for (const block of message.content) {
      if (block.type === 'textBlock') {
        parts.push(block.text)
      } else if (block.type === 'toolResultBlock') {
        for (const c of block.content) {
          if ('text' in c && typeof c.text === 'string') parts.push(c.text)
        }
      }
    }
  }
  return parts.join(' ').toLowerCase()
}

describe.skipIf(bedrock.skip)('Agent checkpointing (integration)', () => {
  let tempDir: string

  beforeAll(async () => {
    tempDir = join(tmpdir(), `strands-checkpoint-integ-${Date.now()}`)
    await fs.mkdir(tempDir, { recursive: true })
  })

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('pauses at a cycle boundary and completes through a fresh agent', async () => {
    const getColorOfSky = tool({
      name: 'get_color_of_sky',
      description: 'Return the color of the sky.',
      inputSchema: z.object({}),
      callback: async () => 'blue',
    })

    const { agent, checkpoints } = await driveToCompletion(
      [getColorOfSky],
      'What color is the sky? Use the get_color_of_sky tool.',
      uuidv7(),
      tempDir
    )

    expect(checkpoints.length).toBeGreaterThanOrEqual(1)
    expect(checkpoints.every((cp) => cp.position === 'afterModel' || cp.position === 'afterTools')).toBe(true)

    // Cycle indices are non-decreasing.
    const cycleIndices = checkpoints.map((cp) => cp.cycleIndex)
    expect(cycleIndices).toEqual([...cycleIndices].sort((a, b) => a - b))

    // The rehydrated history carries the tool result and a final answer that references it.
    expect(conversationText(agent)).toContain('blue')
  })

  it('does not re-run completed tools across a checkpoint resume', async () => {
    const callCounts = { time: 0, day: 0, weather: 0 }

    const getTime = tool({
      name: 'get_time',
      description: 'Return the current time.',
      inputSchema: z.object({}),
      callback: async () => {
        callCounts.time++
        return '12:01'
      },
    })
    const getDay = tool({
      name: 'get_day',
      description: 'Return the current day of the week.',
      inputSchema: z.object({}),
      callback: async () => {
        callCounts.day++
        return 'monday'
      },
    })
    const getWeather = tool({
      name: 'get_weather',
      description: 'Return the current weather.',
      inputSchema: z.object({}),
      callback: async () => {
        callCounts.weather++
        return 'sunny'
      },
    })

    const { agent, checkpoints } = await driveToCompletion(
      [getTime, getDay, getWeather],
      'What is the time, the day, and the weather? Use the get_time, get_day, and get_weather tools.',
      uuidv7(),
      tempDir
    )

    // The core durable guarantee: completed tool calls are not re-invoked on resume.
    expect(callCounts).toEqual({ time: 1, day: 1, weather: 1 })
    expect(checkpoints.some((cp) => cp.position === 'afterTools')).toBe(true)

    const text = conversationText(agent)
    expect(text).toContain('12:01')
    expect(text).toContain('monday')
    expect(text).toContain('sunny')
  })

  it('preserves the original prompt across the checkpoint/resume cycle', async () => {
    const getFavoriteNumber = tool({
      name: 'get_favorite_number',
      description: "Return the user's favorite number.",
      inputSchema: z.object({}),
      callback: async () => 42,
    })

    const { agent } = await driveToCompletion(
      [getFavoriteNumber],
      'What is my favorite number? Use the get_favorite_number tool.',
      uuidv7(),
      tempDir
    )

    const firstUserMessage = agent.messages.find((m) => m.role === 'user')
    expect(firstUserMessage).toBeDefined()
    const firstUserText = JSON.stringify(firstUserMessage).toLowerCase()
    expect(firstUserText).toContain('favorite number')

    const lastMessage = agent.messages.at(-1)!
    expect(lastMessage.role).toBe('assistant')
    expect(JSON.stringify(lastMessage)).toContain('42')
  })
})
