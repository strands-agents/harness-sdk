import { PassThrough } from 'node:stream'
import headless from '@xterm/headless'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createInkOutputs, enterAlternateScreen } from '../src/tui/terminal/terminal.js'

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
})
