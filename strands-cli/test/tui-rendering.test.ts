import '../dist/src/tui/terminal/ink.js'

import { PassThrough } from 'node:stream'
import headless from '@xterm/headless'
import { createElement } from 'react'
import { render } from 'ink'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createInkOutputs, enterAlternateScreen } from '../src/tui/terminal/terminal.js'
import { ChatView } from '../src/tui/view/chat-view.js'
import { snapshot } from './fixtures/chat-snapshot.js'
import { DEFAULT_CHAT_SETTINGS } from '../src/tui/chat/types.js'

describe('terminal output cursor', () => {
  afterEach(() => vi.unstubAllEnvs())

  it.each(['ghostty', 'Apple_Terminal'])('preserves relative writes and the primary screen in %s', async (terminal) => {
    vi.stubEnv('TERM_PROGRAM', terminal)
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 20, rows: 5 })
    const screen = new headless.Terminal({ cols: 20, rows: 5, allowProposedApi: true })
    output.on('data', (chunk: Buffer) => screen.write(chunk))
    const flush = (): Promise<void> => new Promise((resolve) => screen.write('', resolve))
    const line = (row: number): string => screen.buffer.active.getLine(row)!.translateToString(true)
    try {
      output.write('\x1b[31mshell> ')
      const leave = enterAlternateScreen(output)
      const { stdout: inkOutput, stderr: inkErrorOutput } = createInkOutputs(
        output as unknown as NodeJS.WriteStream,
        output as unknown as NodeJS.WriteStream,
        true
      )
      expect(inkErrorOutput).toBe(inkOutput)
      const written = vi.fn()
      inkOutput.write('\x1b[32m\x1b[5;1Hlast row', written)
      await flush()
      expect(written).toHaveBeenCalledOnce()
      expect(screen.buffer.active.cursorY).toBe(0)
      inkErrorOutput.write('\x1b[1A\rprevious row')
      await flush()
      expect(line(3)).toBe('previous row')
      expect(line(4)).toBe('last row')
      expect(screen.buffer.active.getLine(3)!.getCell(0)!.getFgColor()).toBe(2)
      expect(screen.buffer.active.cursorY).toBe(0)
      screen.resize(20, 4)
      expect(line(3)).toBe('previous row')
      inkOutput.write('\x1b[3;5H\x1b[?25h')
      await flush()
      expect([screen.buffer.active.cursorX, screen.buffer.active.cursorY]).toEqual([4, 2])
      inkErrorOutput.write('\x1b[1Dvisible')
      await flush()
      expect(line(2)).toBe('   visible')
      inkOutput.write('\x1b[?25l')
      await flush()
      expect([screen.buffer.active.cursorX, screen.buffer.active.cursorY]).toEqual([0, 0])
      leave()
      output.write('ready')
      await flush()
      expect(line(0)).toBe('shell> ready')
      expect(screen.buffer.active.getLine(0)!.getCell(7)!.getFgColor()).toBe(1)
    } finally {
      screen.dispose()
      output.destroy()
    }
  })

  it.each([
    [false, true],
    [true, false],
  ])('leaves ordinary output unchanged (tty=%s, alternateScreen=%s)', (isTTY, alternateScreen) => {
    vi.stubEnv('TERM_PROGRAM', 'ghostty')
    const output = Object.assign(new PassThrough(), { isTTY }) as unknown as NodeJS.WriteStream
    const streams = createInkOutputs(output, output, alternateScreen)
    expect(streams.stdout).toBe(output)
    expect(streams.stderr).toBe(output)
    output.destroy()
  })

  // https://github.com/strands-agents/harness-sdk/issues/4555
  it('keeps the native cursor on the visible prompt caret through editing, layout changes, and focus handoff', async () => {
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 40, rows: 24 })
    const screen = new headless.Terminal({ cols: 40, rows: 24, allowProposedApi: true, convertEol: true })
    let transcript = ''
    output.on('data', (chunk: Buffer) => {
      transcript += chunk.toString()
      screen.write(chunk)
    })
    const streams = createInkOutputs(
      output as unknown as NodeJS.WriteStream,
      output as unknown as NodeJS.WriteStream,
      true
    )
    const view = (
      input: string,
      cursor: number,
      props: Partial<Parameters<typeof ChatView>[0]> = {}
    ): ReturnType<typeof createElement> =>
      createElement(ChatView, {
        snapshot: snapshot({ settings: { ...DEFAULT_CHAT_SETTINGS, animations: false } }),
        input,
        cursor,
        terminalWidth: output.columns,
        terminalHeight: output.rows,
        ...props,
      })
    const leave = enterAlternateScreen(output)
    const instance = render(view('', 0), {
      ...streams,
      interactive: true,
      patchConsole: false,
      exitOnCtrlC: false,
      incrementalRendering: true,
    })
    const flush = async (): Promise<void> => {
      await instance.waitUntilRenderFlush()
      await new Promise<void>((resolve) => screen.write('', resolve))
    }
    // eslint-disable-next-line no-control-regex
    const cursorVisible = (): boolean => [...transcript.matchAll(/\x1b\[\?25([hl])/g)].at(-1)?.[1] === 'h'
    const expectCaret = (marker = 'Enter', character = '▌'): void => {
      let caret: number[] | undefined
      for (let row = 0; row < output.rows; row++) {
        if (!screen.buffer.active.getLine(row)?.translateToString(true).includes(marker)) continue
        for (let column = 0; column < output.columns; column++) {
          const cell = screen.buffer.active.getLine(row)?.getCell(column)
          if (cell?.getChars() === character) caret = [column, row]
        }
      }
      const frame = Array.from({ length: output.rows }, (_, row) =>
        screen.buffer.active.getLine(row)?.translateToString(true)
      ).join('\n')
      expect(caret, `${marker}/${character}\n${frame}`).toBeDefined()
      expect(cursorVisible()).toBe(true)
      expect([screen.buffer.active.cursorX, screen.buffer.active.cursorY], frame).toEqual(caret)
    }
    try {
      await flush()
      expectCaret()
      for (const cursor of [3, 1]) {
        instance.rerender(view('가文각', cursor))
        await flush()
        expectCaret('가文각', cursor === 1 ? '文' : '▌')
      }
      const wrapped = '가문각'.repeat(16)
      instance.rerender(view(wrapped, wrapped.length))
      await flush()
      expectCaret('가문각')
      const input = 'first line\n가文각'.repeat(5)
      instance.rerender(view(input, input.length))
      await flush()
      expectCaret('가文각')
      output.columns = 24
      output.rows = 18
      screen.resize(output.columns, output.rows)
      instance.rerender(view(input, input.length))
      output.emit('resize')
      await flush()
      expectCaret('가文각')
      instance.rerender(view('!가각', 3, { party: true }))
      await flush()
      expectCaret('!가각')
      instance.rerender(view('!가文각가각', 6, { party: true }))
      await flush()
      expectCaret('각')
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      instance.rerender(view('가文각', 3, { snapshot: snapshot() }))
      await flush()
      expectCaret('가文각')
      const beforeBlink = [screen.buffer.active.cursorX, screen.buffer.active.cursorY]
      for (let blink = 0; blink < 2; blink++) {
        vi.advanceTimersByTime(500)
        await flush()
        expect(cursorVisible()).toBe(true)
        expect([screen.buffer.active.cursorX, screen.buffer.active.cursorY]).toEqual(beforeBlink)
      }
      instance.rerender(view('', 0, { snapshot: snapshot({ composerStatus: 'Working' }) }))
      await flush()
      expect(cursorVisible()).toBe(false)
      expect([screen.buffer.active.cursorX, screen.buffer.active.cursorY]).toEqual([0, 0])
      instance.rerender(view('', 0))
      await flush()
      expectCaret()
    } finally {
      instance.unmount()
      instance.cleanup()
      vi.useRealTimers()
      leave()
      screen.dispose()
      output.destroy()
    }
  })
})
