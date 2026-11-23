import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Agent } from '../../../agent/agent.js'
import { AfterToolsEvent, BeforeToolCallEvent } from '../../../hooks/events.js'
import { AnthropicModel } from '../../../models/anthropic.js'
import { tool } from '../../../tools/tool-factory.js'
import { InterruptResponseContent } from '../../../types/interrupt.js'
import { Offload } from '../offload/index.js'

type Block = { type: string; [key: string]: unknown }
type Call = { id: string; name: string; input: unknown }

/** Anthropic stream events for one assistant message made of these blocks. */
function events(blocks: Block[], stopReason: string): unknown[] {
  const out: unknown[] = [{ type: 'message_start', message: { role: 'assistant', usage: { input_tokens: 10 } } }]
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      out.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      out.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })
    } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
      out.push({ type: 'content_block_start', index, content_block: { ...block, input: {} } })
      const partial = JSON.stringify(block.input)
      out.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: partial } })
    } else {
      out.push({ type: 'content_block_start', index, content_block: block })
    }
    out.push({ type: 'content_block_stop', index })
  })
  out.push({ type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } })
  out.push({ type: 'message_stop' })
  return out
}

/** Claude's tool search loads the tools, then the same response calls them. */
function searchThenCall(loaded: string[], calls: Call[]): unknown[] {
  return events(
    [
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_bm25', input: { query: 'fetch a page' } },
      {
        type: 'tool_search_tool_result',
        tool_use_id: 'srvtoolu_1',
        content: {
          type: 'tool_search_tool_search_result',
          tool_references: loaded.map((name) => ({ type: 'tool_reference', tool_name: name })),
        },
      },
      ...calls.map((call) => ({ type: 'tool_use', ...call })),
    ],
    'tool_use'
  )
}

function build(firstResponse: unknown[], maxConcurrency?: number): { agent: Agent; fetched: string[] } {
  const fetched: string[] = []
  const queue = [firstResponse]
  const client = {
    messages: {
      stream: vi.fn(() => {
        const next = queue.shift() ?? events([{ type: 'text', text: 'done' }], 'end_turn')
        return (async function* () {
          yield* next
        })()
      }),
    },
  }
  const fetchPage = tool({
    name: 'fetch_page',
    description: 'Fetches a web page.',
    inputSchema: z.object({ url: z.string() }),
    callback: async ({ url }) => {
      fetched.push(url)
      await new Promise((resolve) => setTimeout(resolve, 10))
      return `fetched ${url}`
    },
  })
  const deploy = tool({
    name: 'deploy',
    description: 'Deploys to a target.',
    inputSchema: z.object({ target: z.string() }),
    callback: ({ target }) => `deployed ${target}`,
  })
  const agent = new Agent({
    model: new AnthropicModel({ client: client as never, modelId: 'claude-haiku-4-5', maxTokens: 1024 }),
    tools: [fetchPage, deploy],
    contextManager: { strategies: [Offload.defer('toolSpecs', { search: 'auto' })] },
    backgroundTasks: { always: ['fetch_page'], ...(maxConcurrency !== undefined && { maxConcurrency }) },
    printer: false,
  })
  return { agent, fetched }
}

const fetchCalls = (count: number): Call[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `toolu_fetch_${index}`,
    name: 'fetch_page',
    input: { url: `https://example.com/${index}` },
  }))

const refusals = (agent: Agent): number =>
  JSON.stringify(agent.messages).split('was called before its parameters were loaded').length - 1

describe("a background call to a tool the same response's provider search loaded", () => {
  it('runs when another call of the response waits for approval and the call starts later', async () => {
    const deployCall = { id: 'toolu_deploy', name: 'deploy', input: { target: 'prod' } }
    const { agent, fetched } = build(searchThenCall(['fetch_page', 'deploy'], [...fetchCalls(5), deployCall]))
    agent.addHook(BeforeToolCallEvent, (event) => {
      if (event.toolUse.name !== 'deploy') return
      if (event.interrupt<string>({ name: 'approve-deploy', reason: 'Deploy to prod?' }) !== 'yes') {
        event.cancel = 'denied'
      }
    })

    const first = await agent.invoke('Fetch the pages, then deploy.')
    expect(first.stopReason).toBe('interrupt')
    // The fifth background call gets its slot while the approval waits.
    await new Promise((resolve) => setTimeout(resolve, 100))
    await agent.invoke([new InterruptResponseContent({ interruptId: first.interrupts![0]!.id, response: 'yes' })])

    expect(refusals(agent)).toBe(0)
    expect(fetched).toHaveLength(5)
  })

  it('runs when queued behind another and an AfterToolsEvent hook awaits', async () => {
    const { agent, fetched } = build(searchThenCall(['fetch_page'], fetchCalls(2)), 1)
    agent.addHook(AfterToolsEvent, async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    await agent.invoke('Fetch the pages.')

    expect(refusals(agent)).toBe(0)
    expect(fetched).toHaveLength(2)
  })

  it('runs when it starts at once', async () => {
    const { agent, fetched } = build(searchThenCall(['fetch_page'], fetchCalls(1)))

    await agent.invoke('Fetch the page.')

    expect(refusals(agent)).toBe(0)
    expect(fetched).toHaveLength(1)
  })
})
