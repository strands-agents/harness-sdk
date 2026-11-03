import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Agent } from '../../agent/agent.js'
import { AnthropicModel } from '../../models/anthropic.js'
import { Offload } from '../strategies/offload/index.js'
import { Message } from '../../types/messages.js'
import type { MessageData } from '../../types/messages.js'
import { tool } from '../../tools/tool-factory.js'
import { AnthropicWire, type CannedReply } from '../../__fixtures__/anthropic-wire.js'

// Offline evidence only: every request goes to a fail-closed in-memory wire, never to Anthropic.

const TASK = 'TASK: read steps 1 to 8 with read_step, then reply DONE followed by the sum of their values.'
const INSTRUCTIONS =
  'Summarize the conversation. Restate the task from the first user message word for word. Do not call tools.'
const THINKING = { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'error' } }
const STEPS = 8
/** Turns whose reply reports a near-full context, so the next model call is preceded by one summary pass. */
const FULL_AFTER = new Set([3, 6])

interface WireBlock {
  type: string
  [key: string]: unknown
}
interface WireMessage {
  role: string
  content: WireBlock[]
}
interface Run {
  wire: AnthropicWire
  agent: Agent
  returned: WireBlock[]
  compactions: Record<string, unknown>[]
  conversations: Record<string, unknown>[]
}

const readStep = tool({
  name: 'read_step',
  description: 'Read the value of one step.',
  inputSchema: z.object({ n: z.number() }),
  callback: ({ n }) => `step ${n} value ${n * 7}`,
})

function canonical(value: unknown): string {
  return JSON.stringify(value, (_, inner: unknown) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([left], [right]) => left.localeCompare(right)))
      : inner
  )
}

/** Replies to the scripted task; `noSummaryAt` makes that compaction request return no summary. */
function scriptedWire(noSummaryAt?: number): { wire: AnthropicWire; returned: WireBlock[] } {
  const returned: WireBlock[] = []
  let turn = 0
  const wire = new AnthropicWire().respond((body): CannedReply | undefined => {
    if (body.compaction) {
      const pass = returned.length + 1
      if (pass === noSummaryAt) {
        returned.push({ type: 'none' })
        return { content: [], stopReason: 'max_tokens', usage: { input_tokens: 0, output_tokens: 0 } }
      }
      const block = {
        type: 'compaction',
        content: `Summary ${pass}. ${TASK}`,
        signature: `compaction-signature-${pass}`,
      }
      returned.push(block)
      return {
        content: [block],
        stopReason: 'compaction',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          iterations: [{ type: 'compaction', input_tokens: 500, output_tokens: 50 }],
        },
      }
    }
    if (body.tools === undefined) return { content: [{ type: 'text', text: 'BASE SUMMARY' }] }
    turn += 1
    const usage = { input_tokens: FULL_AFTER.has(turn) ? 900 : 100, output_tokens: 10 }
    if (turn > STEPS) return { content: [{ type: 'text', text: 'DONE 252' }], usage }
    return {
      content: [
        { type: 'thinking', thinking: `reasoning for step ${turn}`, signature: `thinking-signature-${turn}` },
        { type: 'tool_use', id: `call-${turn}`, name: 'read_step', input: { n: turn } },
      ],
      stopReason: 'tool_use',
      usage,
    }
  })
  return { wire, returned }
}

function agentOn(wire: AnthropicWire, messages?: MessageData[]): Agent {
  const client = wire.client()
  const betas = ['thinking-binding-controls-2026-08-01']
  const model = new AnthropicModel({
    client,
    modelId: 'claude-sonnet-5-5',
    maxTokens: 4096,
    contextWindowLimit: 1000,
    params: { thinking: THINKING },
    betas,
  })
  const auxModel = new AnthropicModel({
    client,
    modelId: 'claude-haiku-5-5',
    maxTokens: 4096,
    params: { thinking: THINKING },
    betas,
    modelInfo: { capabilities: { serverSideCompaction: true } },
  })
  return new Agent({
    model,
    auxModel,
    systemPrompt: 'You are a careful step reader.',
    tools: [readStep],
    printer: false,
    ...(messages && { messages }),
    contextManager: {
      strategies: [
        Offload.summarize('*', { systemPrompt: INSTRUCTIONS }).when({ utilization: 0.7, preserveRecent: 3 }),
      ],
      stash: false,
    },
  })
}

async function run(noSummaryAt?: number): Promise<Run & { result: Awaited<ReturnType<Agent['invoke']>> }> {
  const { wire, returned } = scriptedWire(noSummaryAt)
  const agent = agentOn(wire)
  const result = await agent.invoke(TASK)
  const bodies = wire.bodies
  return {
    wire,
    agent,
    returned,
    result,
    compactions: bodies.filter((body) => body.compaction),
    conversations: bodies.filter((body) => !body.compaction && body.tools !== undefined),
  }
}

const messagesOf = (body: Record<string, unknown>): WireMessage[] => body.messages as WireMessage[]
const blocksOf = (body: Record<string, unknown>): WireBlock[] => messagesOf(body).flatMap((message) => message.content)

describe('native compaction on the wire (offline)', () => {
  it('compacts twice through the summarizer model, and every pass calls native compaction', async () => {
    const { compactions, conversations, wire, result } = await run()
    expect(compactions).toHaveLength(2)
    expect(compactions.every((body) => body.model === 'claude-haiku-5-5')).toBe(true)
    expect(conversations.every((body) => body.model === 'claude-sonnet-5-5')).toBe(true)
    expect(wire.requests.filter((request) => !JSON.parse(request.body).tools)).toHaveLength(0)
    expect(result.toString()).toContain('DONE 252')
  })

  it('sends compaction from message 0 with the live system prompt, tools and thinking, and the instructions', async () => {
    const { compactions, conversations, wire } = await run()
    const first = compactions[0]!
    expect(messagesOf(first)[0]).toStrictEqual({ role: 'user', content: [{ type: 'text', text: TASK }] })
    for (const compaction of compactions) {
      expect(JSON.stringify(compaction.system)).toBe(JSON.stringify(conversations[0]!.system))
      expect(JSON.stringify(compaction.tools)).toBe(JSON.stringify(conversations[0]!.tools))
      expect(compaction.thinking).toStrictEqual(THINKING)
      expect(compaction.compaction).toStrictEqual({ type: 'summarize', instructions: INSTRUCTIONS })
    }
    const compactionHeaders = wire.requests.filter((request) => JSON.parse(request.body).compaction)
    for (const request of compactionHeaders) {
      expect(request.headers['anthropic-beta']).toBe('thinking-binding-controls-2026-08-01,compact-2026-09-04')
    }
  })

  it('does not send the kept turns to compaction', async () => {
    const { compactions, conversations } = await run()
    compactions.forEach((compaction, index) => {
      const next = conversations.find((body) => blocksOf(body)[0]!.signature === `compaction-signature-${index + 1}`)!
      const kept = blocksOf(next)
        .filter((block) => block.type === 'tool_use')
        .map((block) => block.id)
      const compacted = blocksOf(compaction)
        .filter((block) => block.type === 'tool_use')
        .map((block) => block.id)
      expect(kept.length).toBeGreaterThan(0)
      expect(compacted.filter((id) => kept.includes(id))).toStrictEqual([])
    })
  })

  it('sends the returned block first and unchanged on every later request, and compacts over it', async () => {
    const { compactions, conversations, returned, wire } = await run()
    expect(canonical(blocksOf(compactions[1]!)[0])).toBe(canonical(returned[0]))
    for (const [index, block] of returned.entries()) {
      const carrying = conversations.filter((body) =>
        blocksOf(body).some((sent) => sent.type === 'compaction' && sent.signature === block.signature)
      )
      expect(carrying.length).toBeGreaterThan(0)
      for (const body of carrying) {
        const sent = blocksOf(body)
        expect(sent[0]).toStrictEqual(block)
        expect(canonical(sent[0])).toBe(canonical(block))
        expect(sent.filter((candidate) => candidate.type === 'compaction')).toHaveLength(1)
        expect(index).toBe(returned.indexOf(block))
      }
    }
    const carriers = wire.requests.filter((request) => request.body.includes('"type":"compaction"'))
    expect(carriers.every((request) => request.headers['anthropic-beta']!.includes('compact-2026-09-04'))).toBe(true)
  })

  it('keeps the thinking of kept turns in the outgoing request, byte for byte', async () => {
    const { conversations } = await run()
    const afterFirst = conversations.find((body) => blocksOf(body)[0]!.signature === 'compaction-signature-1')!
    const thinking = blocksOf(afterFirst).filter((block) => block.type === 'thinking')
    expect(thinking.length).toBeGreaterThan(0)
    for (const block of thinking) {
      const step = Number(String(block.signature).replace('thinking-signature-', ''))
      expect(block).toStrictEqual({
        type: 'thinking',
        thinking: `reasoning for step ${step}`,
        signature: `thinking-signature-${step}`,
      })
    }
  })

  it('records compaction usage once per pass on the invocation context', async () => {
    const { result } = await run()
    // 9 conversation replies (2 near-full) and 2 compaction iterations.
    expect(result.invocationContext!.usage).toMatchObject({
      inputTokens: 7 * 100 + 2 * 900 + 2 * 500,
      outputTokens: 9 * 10 + 2 * 50,
    })
  })

  it('replays the block unchanged after the session is saved and restored', async () => {
    const { agent, returned } = await run()
    const saved = JSON.parse(JSON.stringify(agent.messages)) as MessageData[]
    const wire = new AnthropicWire().reply({ content: [{ type: 'text', text: 'still DONE 252' }] })
    await agentOn(wire, saved).invoke('Repeat the final answer.')
    const sent = blocksOf(wire.bodies[0]!)
    expect(sent[0]).toStrictEqual(returned[1])
    expect(canonical(sent[0])).toBe(canonical(returned[1]))
    expect(Message.fromMessageData(saved[0]!).content[0]).toStrictEqual(agent.messages[0]!.content[0])
  })

  it('summarizes client-side in the same pass, keeping message 0, when compaction returns no summary', async () => {
    const { wire } = await run(1)
    const bodies = wire.bodies
    const failed = bodies.findIndex((body) => body.compaction)
    const fallback = bodies[failed + 1]!
    expect(fallback.tools).toBeUndefined()
    expect(fallback.model).toBe('claude-haiku-5-5')
    expect(fallback.system).toBe(INSTRUCTIONS)
    expect(JSON.stringify(fallback.messages)).not.toContain('"type":"thinking"')

    const next = bodies[failed + 2]!
    expect(next.tools).toBeDefined()
    expect(messagesOf(next)[0]).toStrictEqual({ role: 'user', content: [{ type: 'text', text: TASK }] })
    const summary = messagesOf(next).findIndex((message) =>
      message.content.some((block) =>
        /^\[Summarized: \d+ messages, ~\d+ tokens\]\n\nBASE SUMMARY$/.test(String(block.text))
      )
    )
    expect(summary).toBeGreaterThan(0)
    const carrier = messagesOf(next)[summary]!
    expect(carrier.content.at(-1)!.text).toMatch(/^\[Summarized:/)
    expect(carrier.content[0]!.type).not.toBe('text')
  })
})
