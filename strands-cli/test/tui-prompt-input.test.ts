import { createElement } from 'react'
import { render, type Instance } from 'ink'
import { describe, expect, it, vi } from 'vitest'

import { ChatController } from '../src/tui/chat/controller.js'
import { sanitizeTerminalText } from '../src/tui/terminal/sanitize.js'
import { ChatApp } from '../src/tui/view/app.js'
import { ttyInput, ttyOutput } from './fixtures/terminal.js'
import { idleBackend } from './fixtures/chat-backend.js'

const UP = '\u001b[A'
const DOWN = '\u001b[B'

describe('prompt history', () => {
  it('browses past a recalled slash command back to the unsent draft', async () => {
    const controller = new ChatController(idleBackend())
    const { input, frame, instance } = mount(controller)
    const promptRow = (): string | undefined =>
      frame()
        .split('\n')
        .filter((line) => line.includes('▌'))
        .at(-1)

    try {
      input.write('/help')
      await vi.waitFor(() => expect(promptRow()).toContain('/help'))
      input.write('\r')
      await vi.waitFor(() => expect(controller.getSnapshot().panel?.kind).toBe('help'))
      input.write('\u001b')
      await vi.waitFor(() => expect(controller.getSnapshot().panel).toBeUndefined())
      input.write('my draft')
      await vi.waitFor(() => expect(promptRow()).toContain('my draft'))

      input.write(UP)
      await vi.waitFor(() => expect(promptRow()).toContain('/help'))
      expect(frame()).not.toContain('Browse controls, commands')
      input.write(DOWN)
      await vi.waitFor(() => expect(promptRow()).toContain('my draft'))
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
      await controller.dispose()
    }
  })
})

describe('slash palette during a turn', () => {
  it('opens while the agent works, closes on Esc without cancelling, and runs live commands', async () => {
    let finishTurn = (): void => {}
    const backend = idleBackend({
      async *stream() {
        yield { type: 'textDelta', text: 'working' }
        await new Promise<void>((resolve) => {
          finishTurn = resolve
        })
        return { stopReason: 'endTurn' }
      },
    })
    const controller = new ChatController(backend)
    const { input, frame, instance } = mount(controller)

    try {
      void controller.submit('start')
      await vi.waitFor(() => expect(controller.busy).toBe(true))
      input.write('/he')
      await vi.waitFor(() => expect(frame()).toContain('Browse controls, commands'))
      input.write('\u001b')
      await vi.waitFor(() => expect(frame()).not.toContain('Browse controls, commands'))
      expect(backend.cancel).not.toHaveBeenCalled()
      expect(controller.busy).toBe(true)

      input.write('l')
      await vi.waitFor(() => expect(frame()).toContain('Browse controls, commands'))
      input.write('\r')
      await vi.waitFor(() => expect(controller.getSnapshot().panel?.kind).toBe('help'))
      expect(controller.busy).toBe(true)
    } finally {
      finishTurn()
      instance.unmount()
      await instance.waitUntilExit()
      await controller.dispose()
    }
  })
})

function mount(controller: ChatController): {
  input: ReturnType<typeof ttyInput>
  frame: () => string
  instance: Instance
} {
  const input = ttyInput()
  const output = ttyOutput(80, 30)
  let frame = ''
  output.on('data', (chunk: Buffer) => {
    if (chunk.toString().includes('\n')) {
      frame = sanitizeTerminalText(chunk.toString())
    }
  })
  const instance = render(createElement(ChatApp, { controller }), {
    stdin: input,
    stdout: output,
    stderr: output,
    interactive: true,
    debug: true,
    incrementalRendering: false,
    patchConsole: false,
    exitOnCtrlC: false,
  })
  return { input, frame: () => frame, instance }
}
