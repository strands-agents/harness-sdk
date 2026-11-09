import { createElement } from 'react'
import { render } from 'ink'
import { marked } from 'marked'
import { describe, expect, it, vi } from 'vitest'
import { ttyInput, ttyOutput } from './fixtures/terminal.js'
import { snapshot as chatSnapshot } from './fixtures/chat-snapshot.js'

import { DEFAULT_CHAT_SETTINGS, type ChatSnapshot, type ChatTurn } from '../src/tui/chat/controller.js'
import { ChatView } from '../src/tui/view/chat-view.js'

describe('transcript rendering', () => {
  it('does not reparse completed Markdown while the active turn streams', async () => {
    const lexer = vi.spyOn(marked, 'lexer')
    const completed = turn('completed', 'Completed **answer**')
    const output = ttyOutput(80, 24).resume()
    const instance = render(
      createElement(ChatView, {
        snapshot: snapshot(completed, turn('active', 'Streaming')),
        input: '',
        cursor: 0,
        terminalWidth: 80,
        terminalHeight: 24,
      }),
      {
        stdin: ttyInput(),
        stdout: output,
        stderr: ttyOutput(80, 24).resume(),
        exitOnCtrlC: false,
        patchConsole: false,
      }
    )
    try {
      await instance.waitUntilRenderFlush()

      instance.rerender(
        createElement(ChatView, {
          snapshot: snapshot(completed, turn('active', 'Streaming update')),
          input: '',
          cursor: 0,
          terminalWidth: 80,
          terminalHeight: 24,
        })
      )
      await instance.waitUntilRenderFlush()

      const parsed = lexer.mock.calls.map(([text]) => text)
      expect(parsed.filter((text) => text === 'Completed **answer**')).toHaveLength(1)
      expect(parsed).toContain('Streaming')
      expect(parsed).toContain('Streaming update')
    } finally {
      instance.unmount()
    }
  })
})

function turn(id: string, text: string): ChatTurn {
  return {
    id,
    prompt: id,
    agentName: 'Strands harness',
    entries: [{ id: `${id}-entry`, type: 'assistant', text }],
    status: id === 'active' ? 'running' : 'complete',
  }
}

function snapshot(completed: ChatTurn, activeTurn: ChatTurn): ChatSnapshot {
  return chatSnapshot({
    completedTurns: [completed],
    activeTurn,
    status: 'running',
    settings: { ...DEFAULT_CHAT_SETTINGS, animations: false },
  })
}
