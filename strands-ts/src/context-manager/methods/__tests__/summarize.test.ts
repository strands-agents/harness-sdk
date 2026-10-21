import { describe, it, expect, vi } from 'vitest'
import { SUMMARIZE_CONVERSATION_INSTRUCTION, summarizeConversation } from '../summarize.js'
import { createMockAgent } from '../../../__fixtures__/agent-helpers.js'
import { createMockTool } from '../../../__fixtures__/tool-helpers.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { ToolRegistry } from '../../../registry/tool-registry.js'
import { Message, TextBlock, ToolResultBlock, ToolUseBlock } from '../../../types/messages.js'

function makeAgent() {
  const toolRegistry = new ToolRegistry()
  toolRegistry.add(createMockTool('calc', () => '42'))
  return createMockAgent({ toolRegistry, extra: { systemPrompt: 'You are the agent.' } })
}

describe('summarizeConversation', () => {
  it('replays the agent request with its system prompt and tools plus the instruction', async () => {
    const model = new MockMessageModel().addTurn(new TextBlock('summary'))
    const streamSpy = vi.spyOn(model, 'stream')
    const history = [
      new Message({ role: 'user', content: [new TextBlock('task')] }),
      new Message({ role: 'assistant', content: [new TextBlock('working')] }),
    ]

    const result = await summarizeConversation(history, makeAgent(), model)

    expect(result).toBe('summary')
    expect(streamSpy).toHaveBeenCalledTimes(1)
    const [request, options] = streamSpy.mock.calls[0]!
    expect(request.slice(0, 2)).toEqual(history)
    expect(request[2]!.role).toBe('user')
    expect(request[2]!.content).toEqual([new TextBlock(SUMMARIZE_CONVERSATION_INSTRUCTION)])
    expect(options?.systemPrompt).toBe('You are the agent.')
    expect(options?.toolSpecs?.map((spec) => spec.name)).toEqual(['calc'])
    expect(history[1]!.content).toEqual([new TextBlock('working')])
  })

  it('appends the instruction to a trailing user message so alternation holds', async () => {
    const model = new MockMessageModel().addTurn(new TextBlock('summary'))
    const streamSpy = vi.spyOn(model, 'stream')
    const toolResult = new ToolResultBlock({ toolUseId: 't1', status: 'success', content: [new TextBlock('42')] })
    const history = [
      new Message({ role: 'user', content: [new TextBlock('task')] }),
      new Message({ role: 'assistant', content: [new ToolUseBlock({ toolUseId: 't1', name: 'calc', input: {} })] }),
      new Message({ role: 'user', content: [toolResult] }),
    ]

    await summarizeConversation(history, makeAgent(), model)

    const request = streamSpy.mock.calls[0]![0]
    expect(request).toHaveLength(3)
    expect(request[2]!.content).toEqual([toolResult, new TextBlock(SUMMARIZE_CONVERSATION_INSTRUCTION)])
    expect(history[2]!.content).toEqual([toolResult])
  })

  it('uses a custom system prompt instead of the agent prompt when configured', async () => {
    const model = new MockMessageModel().addTurn(new TextBlock('summary'))
    const streamSpy = vi.spyOn(model, 'stream')
    const history = [new Message({ role: 'user', content: [new TextBlock('task')] })]

    await summarizeConversation(history, makeAgent(), model, { systemPrompt: 'Be brief.' })

    expect(streamSpy.mock.calls[0]![1]?.systemPrompt).toBe('Be brief.')
  })

  it('falls back to a self-contained request when the replay returns no text', async () => {
    const model = new MockMessageModel()
      .addTurn(new ToolUseBlock({ toolUseId: 't9', name: 'calc', input: {} }), { stopReason: 'toolUse' })
      .addTurn(new TextBlock('fallback summary'))
    const streamSpy = vi.spyOn(model, 'stream')
    const history = [
      new Message({ role: 'user', content: [new TextBlock('task')] }),
      new Message({ role: 'assistant', content: [new TextBlock('done')] }),
      new Message({ role: 'user', content: [new TextBlock('now look up ORD-2')] }),
    ]

    expect(await summarizeConversation(history, makeAgent(), model)).toBe('fallback summary')

    expect(streamSpy).toHaveBeenCalledTimes(2)
    const [request, options] = streamSpy.mock.calls[1]!
    expect(options?.toolSpecs).toBeUndefined()
    expect(options?.systemPrompt).not.toBe('You are the agent.')
    expect(request[0]!.content[0]).toEqual(new TextBlock('<content>'))
    expect(request[0]!.content).toContainEqual(new TextBlock('now look up ORD-2'))
  })

  it('returns null when both requests fail', async () => {
    const model = new MockMessageModel().addTurn(new Error('boom')).addTurn(new Error('boom again'))
    const history = [new Message({ role: 'user', content: [new TextBlock('task')] })]

    expect(await summarizeConversation(history, makeAgent(), model)).toBeNull()
    expect(model.callCount).toBe(2)
  })
})
