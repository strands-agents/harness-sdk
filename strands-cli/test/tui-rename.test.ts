import { createElement } from 'react'
import { render } from 'ink'
import { describe, expect, it, vi } from 'vitest'

import { ChatController, type ChatBackend } from '../src/tui/chat/controller.js'
import { ConversationManager } from '../src/tui/session/conversations.js'
import { sanitizeTerminalText } from '../src/tui/terminal/sanitize.js'
import { ChatApp } from '../src/tui/view/app.js'
import { ttyInput, ttyOutput } from './fixtures/terminal.js'

describe('rename panel', () => {
  it('renames the active agent from an inline text field', async () => {
    const input = ttyInput()
    const output = ttyOutput(80, 24)
    let frame = ''
    output.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('\n')) {
        frame = sanitizeTerminalText(chunk.toString())
      }
    })
    const primary = new ChatController(backend())
    const manager = new ConversationManager(primary, { fork: async () => primary })
    const instance = render(createElement(ChatApp, { controller: manager }), {
      stdin: input,
      stdout: output,
      stderr: output,
      interactive: true,
      debug: true,
      incrementalRendering: false,
      patchConsole: false,
      exitOnCtrlC: false,
    })

    try {
      await manager.submit('/rename')
      await instance.waitUntilRenderFlush()
      expect(frame).toContain('Rename agent')
      expect(frame).toContain('Current name: Strands harness')
      expect(frame).toContain('New name')

      input.write('Lead Reviewer')
      await instance.waitUntilRenderFlush()
      expect(frame).toContain('Lead Reviewer')

      input.write('\r')
      await vi.waitFor(() => expect(manager.getSnapshot().panel).toBeUndefined())
      await manager.submit('/agents')
      expect(manager.getSnapshot().panel?.rows[0]?.label).toBe('Lead Reviewer')
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
      await manager.dispose()
    }
  })

  it('cancels without renaming when Escape is pressed', async () => {
    const input = ttyInput()
    const output = ttyOutput(80, 24)
    const primary = new ChatController(backend())
    const manager = new ConversationManager(primary, { fork: async () => primary })
    const instance = render(createElement(ChatApp, { controller: manager }), {
      stdin: input,
      stdout: output,
      stderr: output,
      interactive: true,
      patchConsole: false,
      exitOnCtrlC: false,
    })

    try {
      await manager.submit('/rename')
      await instance.waitUntilRenderFlush()
      input.write('Temporary')
      input.write('\u001b')
      await vi.waitFor(() => expect(manager.getSnapshot().panel).toBeUndefined())

      await manager.submit('/agents')
      expect(manager.getSnapshot().panel?.rows[0]?.label).toBe('Strands harness')
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
      await manager.dispose()
    }
  })
})

function backend(): ChatBackend {
  return {
    id: 'primary',
    name: 'Strands harness',
    protocol: 'strands',
    stream: async function* () {
      yield { type: 'textDelta', text: '' }
      return { stopReason: 'endTurn' }
    },
    cancel: vi.fn(),
    dispose: vi.fn(),
  }
}
