import { describe, expect, it, vi } from 'vitest'

import { ChatController, type ChatBackend, type ChatEvent, type ChatRunResult } from '../src/tui/chat/controller.js'

function shellBurstBackend(): ChatBackend {
  return {
    id: 'test',
    name: 'Test',
    protocol: 'strands',
    cancel: vi.fn(),
    async *stream(): AsyncGenerator<ChatEvent, ChatRunResult, undefined> {
      yield {
        type: 'toolStart',
        toolUseId: 'shell-1',
        name: 'shell',
        input: { command: 'printf output' },
      }
      for (let index = 0; index < 100; index += 1) {
        yield {
          type: 'toolOutputDelta',
          toolUseId: 'shell-1',
          stream: 'stdout',
          text: 'x',
        }
      }
      yield {
        type: 'toolResult',
        toolUseId: 'shell-1',
        status: 'success',
        content: [{ type: 'text', text: 'x'.repeat(100) }],
      }
      return { stopReason: 'endTurn' }
    },
  }
}

describe('TUI update batching', () => {
  it('coalesces bursty shell output without losing streamed content', async () => {
    const controller = new ChatController(shellBurstBackend())
    const listener = vi.fn()
    controller.subscribe(listener)

    const turn = await controller.submit('run it')

    expect(listener.mock.calls.length).toBeLessThan(10)
    expect(turn?.entries).toContainEqual(
      expect.objectContaining({
        type: 'tool',
        toolUseId: 'shell-1',
        status: 'success',
        result: [{ type: 'text', text: 'x'.repeat(100) }],
      })
    )
  })
})
