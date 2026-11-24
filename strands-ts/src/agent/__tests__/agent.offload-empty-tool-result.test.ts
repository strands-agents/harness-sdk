import { describe, expect, it, vi } from 'vitest'
import { Agent } from '../agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { Offload } from '../../context-manager/strategies/offload/index.js'
import { Message, SummaryBlock, TextBlock, ToolResultBlock, ToolUseBlock } from '../../types/messages.js'
import type { OffloadStrategy } from '../../context-manager/strategies/offload/index.js'
import type { ToolResultContent } from '../../types/messages.js'

const text = (role: 'user' | 'assistant', value: string): Message =>
  new Message({ role, content: [new TextBlock(value)] })
const call = (id: string): Message =>
  new Message({ role: 'assistant', content: [new ToolUseBlock({ name: 'noop', toolUseId: id, input: {} })] })
const result = (id: string, content: ToolResultContent[]): Message =>
  new Message({ role: 'user', content: [new ToolResultBlock({ toolUseId: id, status: 'success', content })] })

async function run(strategy: OffloadStrategy) {
  const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'ok' })
  const summarize = vi.spyOn(model, 'summarize').mockResolvedValue({ content: [new SummaryBlock({ text: 'SUMMARY' })] })
  const agent = new Agent({
    model,
    printer: false,
    messages: [
      text('user', 'task'),
      call('t1'),
      result('t1', []),
      text('assistant', 'first done'),
      text('user', 'again'),
      call('t2'),
      result('t2', [new TextBlock('ok')]),
      text('assistant', 'second done'),
    ],
    contextManager: { strategies: [strategy] },
  })
  await agent.invoke('next')
  const items = (agent.messages[2]!.content[0] as ToolResultBlock).content
  const keys = await agent.contextManager!.stash!.keysOf('t1')
  return { items, keys, summarizeCalls: summarize.mock.calls.length }
}

describe('empty tool results', () => {
  it.each([
    ['drop', () => Offload.drop('toolResults').when({ preserveRecent: 1 })],
    ['summarize', () => Offload.summarize('toolResults').when({ preserveRecent: 1 })],
  ] as const)('%s leaves an empty result untouched', async (_method, builder) => {
    const { items, keys, summarizeCalls } = await run(builder())

    expect(items).toEqual([])
    expect(keys).toEqual([])
    expect(summarizeCalls).toBe(0)
  })
})
