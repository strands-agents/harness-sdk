import { Agent } from '../../agent/agent.js'
import { AnthropicModel } from '../../models/anthropic.js'
import { Offload } from '../strategies/offload/index.js'
import { Message, TextBlock, ToolResultBlock, ToolUseBlock } from '../../types/messages.js'
import { tool } from '../../tools/tool-factory.js'
import { AnthropicWire } from '../../__fixtures__/anthropic-wire.js'
import { z } from 'zod'

/** The request bodies one deterministic base-path summary pass sends. */
export interface WireCapture {
  /** The summarizer's own stream request. */
  summarizer: string
  /** The conversation request that follows the pass. */
  conversation: string
  /** The agent's stored history after the invocation. */
  stored?: Message[]
}

/** A deterministic history and preserveRecent that force one base summary pass. */
export interface WireScenario {
  name: string
  history: () => Message[]
  preserveRecent: number
}

const text = (role: 'user' | 'assistant', value: string): Message =>
  new Message({ role, content: [new TextBlock(value)] })

/** Scenarios shared by the main baseline capture and the comparison test. */
export const WIRE_SCENARIOS: WireScenario[] = [
  {
    name: 'first kept message is user',
    preserveRecent: 1,
    history: () => [
      text('user', 'TASK: plan the release. Always answer in English.'),
      text('assistant', 'A1 '.repeat(40)),
      text('user', 'U2 '.repeat(40)),
      text('assistant', 'A3 '.repeat(40)),
    ],
  },
  {
    name: 'first kept message is assistant',
    preserveRecent: 2,
    history: () => [
      text('user', 'TASK: plan the release. Always answer in English.'),
      text('assistant', 'A1 '.repeat(40)),
      text('user', 'U2 '.repeat(40)),
      text('assistant', 'A3 '.repeat(40)),
    ],
  },
  {
    name: 'tool pair at the boundary',
    preserveRecent: 3,
    history: () => [
      text('user', 'TASK: plan the release. Always answer in English.'),
      new Message({
        role: 'assistant',
        content: [
          new TextBlock('Looking it up.'),
          new ToolUseBlock({ name: 'lookup', toolUseId: 't1', input: { q: 'x' } }),
        ],
      }),
      new Message({
        role: 'user',
        content: [
          new ToolResultBlock({ toolUseId: 't1', status: 'success', content: [new TextBlock('R '.repeat(40))] }),
        ],
      }),
      text('assistant', 'A3 '.repeat(40)),
    ],
  },
]

const lookup = tool({
  name: 'lookup',
  description: 'Look something up.',
  inputSchema: z.object({ q: z.string() }),
  callback: () => 'unused',
})

/**
 * Runs one invocation whose single model call is preceded by one base summary pass, on a fail-closed wire.
 *
 * @param scenario - The scenario to run
 * @returns The summarizer and conversation request bodies, byte for byte
 */
export async function captureBaseWire(scenario: WireScenario): Promise<WireCapture> {
  const wire = new AnthropicWire().reply(
    { content: [{ type: 'text', text: 'SUMMARY OF EARLIER TURNS' }] },
    { content: [{ type: 'text', text: 'done' }] }
  )
  const client = wire.client()
  const model = new AnthropicModel({ client, modelId: 'claude-sonnet-4-6', maxTokens: 1024, contextWindowLimit: 100 })
  const auxModel = new AnthropicModel({ client, modelId: 'claude-haiku-4-5', maxTokens: 512 })
  const agent = new Agent({
    model,
    auxModel,
    systemPrompt: 'You are a release planner.',
    tools: [lookup],
    messages: scenario.history(),
    printer: false,
    contextManager: {
      strategies: [Offload.summarize('*').when({ utilization: 0.01, preserveRecent: scenario.preserveRecent })],
      stash: false,
    },
  })
  await agent.invoke('Next question: when do we ship?')
  if (wire.requests.length !== 2) throw new Error(`expected 2 requests, saw ${wire.requests.length}`)
  return { summarizer: wire.requests[0]!.body, conversation: wire.requests[1]!.body, stored: agent.messages }
}
