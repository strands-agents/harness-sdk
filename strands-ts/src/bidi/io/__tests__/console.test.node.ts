/**
 * Tests for console input and output streams.
 */

import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ToolUseBlock } from '../../../types/messages.js'
import {
  BidiConnectionStopEvent,
  BidiReasoningDeltaEvent,
  BidiReasoningStartEvent,
  BidiReasoningStopEvent,
  BidiTextBlockEvent,
  BidiTextDeltaEvent,
  BidiTextStartEvent,
  BidiTextStopEvent,
  BidiToolUseBlocksEvent,
  BidiTranscriptDeltaEvent,
  BidiTranscriptStartEvent,
  BidiTranscriptStopEvent,
} from '../../types/events.js'
import { ConsoleIO } from '../console.js'

import type { BidiAgent } from '../../agent/agent.js'
import type { BidiInputStream, BidiOutputStream } from '../../types/io.js'

const agent = {} as BidiAgent

/** Terminal stand-in that feeds keypresses to `process.stdin`. */
class Terminal extends PassThrough {
  /** Send characters as if typed. */
  sendText(text: string): void {
    this.write(text)
  }
}

/** Wait until `condition` holds, failing the test if it never does. */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('condition was not met')
}

describe('ConsoleIO', () => {
  let terminal: Terminal
  let writes: string[]
  let originalStdin: typeof process.stdin
  let originalIsTTY: PropertyDescriptor | undefined

  /** Permanent terminal output, split into nonempty lines. */
  function lines(): string[] {
    return writes
      .join('')
      .split('\n')
      .filter((line) => line)
  }

  beforeEach(() => {
    terminal = new Terminal()
    originalStdin = process.stdin
    Object.defineProperty(process, 'stdin', { value: terminal, configurable: true })
    originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
    writes = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk))
      return true
    })
  })

  afterEach(() => {
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true })
    if (originalIsTTY) {
      Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
    } else {
      delete (process.stdout as { isTTY?: boolean }).isTTY
    }
    vi.restoreAllMocks()
  })

  describe('input', () => {
    let console_: ConsoleIO
    let input: BidiInputStream

    beforeEach(async () => {
      console_ = new ConsoleIO()
      input = console_.input()
      await input.start?.(agent)
    })

    afterEach(async () => {
      await input.stop?.()
    })

    it('preserves draft during output', async () => {
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
      const output = console_.output()
      await output.start?.(agent)
      const reader = input.read()

      terminal.sendText('draft')
      await waitFor(() => writes.join('').includes('> draft'))

      await output.write(new BidiTextStartEvent({ type: 'bidiTextStart', contentId: 'text' }))
      await output.write(new BidiTextDeltaEvent({ type: 'bidiTextDelta', delta: 'Answer', contentId: 'text' }))
      await output.write(
        new BidiToolUseBlocksEvent({
          type: 'bidiToolUseBlocks',
          toolUses: [
            new ToolUseBlock({ name: 'weather', toolUseId: 'weather', input: {} }),
            new ToolUseBlock({ name: 'time', toolUseId: 'time', input: {} }),
          ],
        })
      )

      const frame = writes[writes.length - 1] as string
      expect(frame).toContain('Tools: [weather, time]')
      expect(frame).toContain('> draft')

      terminal.sendText('\x7f!\r')
      await expect(reader).resolves.toEqual({ type: 'textBlock', text: 'draf!' })
      expect(writes[writes.length - 1]).toContain('> \u258f')
    })

    it('forwards ctrl-c', async () => {
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
      let resolved = false
      const reader = input.read().then((value) => {
        resolved = true
        return value
      })

      terminal.sendText('\x03')
      await waitFor(() => kill.mock.calls.length > 0)
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGINT')
      expect(resolved).toBe(false)

      terminal.sendText('still typing\r')
      await expect(reader).resolves.toEqual({ type: 'textBlock', text: 'still typing' })
    })

    it('raises eof when input closes', async () => {
      const reader = input.read()
      terminal.end()

      await expect(reader).rejects.toThrow('terminal input closed')
    })

    it('releases the keyboard on stop', async () => {
      await input.stop?.()

      expect(terminal.listenerCount('keypress')).toBe(0)
    })

    it('prints submitted messages to terminal history', async () => {
      const reader = input.read()

      terminal.sendText('hello\r')
      await reader

      expect(lines()).toEqual(['> hello'])
    })
  })

  describe('output', () => {
    it.each([
      { toolCount: 1, expTools: 'Tools: [weather]' },
      { toolCount: 2, expTools: 'Tools: [weather, time]' },
    ])('completes interleaved content in order ($toolCount tools)', async ({ toolCount, expTools }) => {
      const console_ = new ConsoleIO()
      const output = console_.output()
      await output.start?.(agent)

      const toolUses = [
        new ToolUseBlock({ name: 'weather', toolUseId: 'weather', input: {} }),
        new ToolUseBlock({ name: 'time', toolUseId: 'time', input: {} }),
      ].slice(0, toolCount)

      for (const event of [
        new BidiTranscriptStartEvent({ type: 'bidiTranscriptStart', role: 'user', contentId: 'user' }),
        new BidiTranscriptDeltaEvent({
          type: 'bidiTranscriptDelta',
          delta: 'Question',
          role: 'user',
          contentId: 'user',
        }),
        new BidiReasoningStartEvent({ type: 'bidiReasoningStart', contentId: 'reasoning' }),
        new BidiReasoningDeltaEvent({ type: 'bidiReasoningDelta', delta: 'Thinking', contentId: 'reasoning' }),
        new BidiToolUseBlocksEvent({ type: 'bidiToolUseBlocks', toolUses }),
        new BidiTextStartEvent({ type: 'bidiTextStart', contentId: 'text' }),
        new BidiTextDeltaEvent({ type: 'bidiTextDelta', delta: 'Answer', contentId: 'text' }),
        new BidiTranscriptStartEvent({ type: 'bidiTranscriptStart', role: 'assistant', contentId: 'speech' }),
        new BidiTranscriptDeltaEvent({
          type: 'bidiTranscriptDelta',
          delta: 'Spoken answer',
          role: 'assistant',
          contentId: 'speech',
        }),
        new BidiReasoningStopEvent({ type: 'bidiReasoningStop', contentId: 'reasoning' }),
        new BidiTextStopEvent({ type: 'bidiTextStop', contentId: 'text' }),
        new BidiTextBlockEvent({ type: 'bidiTextBlock', text: 'Answer', contentId: 'text' }),
        new BidiTranscriptStopEvent({ type: 'bidiTranscriptStop', role: 'assistant', contentId: 'speech' }),
      ]) {
        await output.write(event)
      }

      expect(writes.join('')).toBe('')

      await output.write(new BidiTranscriptStopEvent({ type: 'bidiTranscriptStop', role: 'user', contentId: 'user' }))

      expect(lines()).toEqual(['> Question', 'Reasoning: Thinking', expTools, 'Answer', 'Spoken answer'])
    })

    it('preserves partial content on stop', async () => {
      const console_ = new ConsoleIO()
      const input = console_.input()
      const output = console_.output()
      await input.start?.(agent)
      await output.start?.(agent)

      await output.write(new BidiTextStartEvent({ type: 'bidiTextStart', contentId: 'text' }))
      await output.write(new BidiTextDeltaEvent({ type: 'bidiTextDelta', delta: 'Partial', contentId: 'text' }))

      await input.stop?.()
      await output.stop?.()

      expect(writes.join('')).toBe('Partial\n\n')
    })

    it('pads the user block', async () => {
      const console_ = new ConsoleIO()
      const output = console_.output()
      await output.start?.(agent)

      await output.write(new BidiTranscriptStartEvent({ type: 'bidiTranscriptStart', role: 'user', contentId: 'user' }))
      await output.write(
        new BidiTranscriptDeltaEvent({
          type: 'bidiTranscriptDelta',
          delta: 'Question',
          role: 'user',
          contentId: 'user',
        })
      )
      await output.write(new BidiTranscriptStopEvent({ type: 'bidiTranscriptStop', role: 'user', contentId: 'user' }))

      expect(writes.join('')).toBe('> Question\n\n')
    })

    it('flushes partial content on connection stop', async () => {
      const console_ = new ConsoleIO()
      const output = console_.output()
      await output.start?.(agent)

      await output.write(new BidiTextStartEvent({ type: 'bidiTextStart', contentId: 'text' }))
      await output.write(new BidiTextDeltaEvent({ type: 'bidiTextDelta', delta: 'Partial', contentId: 'text' }))
      await output.write(
        new BidiConnectionStopEvent({ type: 'bidiConnectionStop', connectionId: 'connection', reason: 'userRequest' })
      )

      expect(writes.join('').trim()).toBe('Partial')
    })

    it.each([
      { enabled: 'text', expOutput: 'Answer' },
      { enabled: 'reasoning', expOutput: 'Reasoning: Thinking' },
      { enabled: 'transcript', expOutput: 'Spoken' },
      { enabled: 'tools', expOutput: 'Tools: [weather, time]' },
      { enabled: 'none', expOutput: '' },
    ])('filters content to $enabled', async ({ enabled, expOutput }) => {
      const console_ = new ConsoleIO({
        showText: enabled === 'text',
        showReasoning: enabled === 'reasoning',
        showTranscript: enabled === 'transcript',
        showTools: enabled === 'tools',
      })
      const output = console_.output()
      await output.start?.(agent)

      for (const event of [
        new BidiReasoningStartEvent({ type: 'bidiReasoningStart', contentId: 'reasoning' }),
        new BidiReasoningDeltaEvent({ type: 'bidiReasoningDelta', delta: 'Thinking', contentId: 'reasoning' }),
        new BidiTextStartEvent({ type: 'bidiTextStart', contentId: 'text' }),
        new BidiTextDeltaEvent({ type: 'bidiTextDelta', delta: 'Answer', contentId: 'text' }),
        new BidiTranscriptStartEvent({ type: 'bidiTranscriptStart', role: 'assistant', contentId: 'speech' }),
        new BidiTranscriptDeltaEvent({
          type: 'bidiTranscriptDelta',
          delta: 'Spoken',
          role: 'assistant',
          contentId: 'speech',
        }),
        new BidiToolUseBlocksEvent({
          type: 'bidiToolUseBlocks',
          toolUses: [
            new ToolUseBlock({ name: 'weather', toolUseId: 'weather', input: {} }),
            new ToolUseBlock({ name: 'time', toolUseId: 'time', input: {} }),
          ],
        }),
        new BidiReasoningStopEvent({ type: 'bidiReasoningStop', contentId: 'reasoning' }),
        new BidiTextStopEvent({ type: 'bidiTextStop', contentId: 'text' }),
        new BidiTranscriptStopEvent({ type: 'bidiTranscriptStop', role: 'assistant', contentId: 'speech' }),
      ]) {
        await output.write(event)
      }

      expect(writes.join('').trim()).toBe(expOutput)

      await output.stop?.()
    })

    it('ignores tool use events without tool uses', async () => {
      const console_ = new ConsoleIO()
      const output: BidiOutputStream = console_.output()
      await output.start?.(agent)

      await output.write(new BidiToolUseBlocksEvent({ type: 'bidiToolUseBlocks', toolUses: [] }))

      expect(writes.join('')).toBe('')
    })
  })
})
