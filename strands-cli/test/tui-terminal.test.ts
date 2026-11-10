import { ChildProcess, spawn } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { copyTerminalText, enterAlternateScreen, setTerminalMouseMotion } from '../src/tui/terminal/terminal.js'

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}))

const platform = process.platform

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform })
  vi.mocked(spawn).mockReset()
  vi.restoreAllMocks()
})

describe('terminal lifecycle', () => {
  it('enters and leaves the alternate screen with one mouse-reporting lifecycle', () => {
    const writes: string[] = []
    const leave = enterAlternateScreen({ write: (value) => writes.push(value) })
    leave()
    leave()
    expect(writes).toHaveLength(2)
    expect(writes[0]).toContain('?1049h')
    expect(writes[0]).toContain('?1002h')
    expect(writes[0]).not.toContain('?1003h')
    expect(writes[0]).toContain('?1006h')
    expect(writes[1]).toContain('?1049l')
    expect(writes[1]).toContain('?1002l')
    expect(writes[1]).toContain('?1003l')
    expect(writes[1]).toContain('?1006l')
    expect(writes[1]).toContain('?25h')
  })

  it('enables all-motion reporting only for hoverable surfaces', () => {
    const writes: string[] = []
    const output = { write: (value: string) => writes.push(value) }

    setTerminalMouseMotion(true, output)
    setTerminalMouseMotion(false, output)

    expect(writes).toEqual(['\u001b[?1002l\u001b[?1003h', '\u001b[?1003l\u001b[?1002h'])
  })
})

describe('terminal clipboard', () => {
  it('copies text through OSC 52', async () => {
    const writes: string[] = []

    await expect(copyTerminalText('hello\nworld', { write: (value) => writes.push(value) })).resolves.toBe(true)

    expect(writes).toEqual([`\u001b]52;c;${Buffer.from('hello\nworld').toString('base64')}\u001b\\`])
    expect(spawn).not.toHaveBeenCalled()
  })

  it('does not copy empty text', async () => {
    const write = vi.fn()

    await expect(copyTerminalText('', { write })).resolves.toBe(false)

    expect(write).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('returns false when terminal output fails', async () => {
    const write = (): never => {
      throw new Error('Output closed')
    }

    await expect(copyTerminalText('hello', { write })).resolves.toBe(false)
  })

  describe('macOS clipboard', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
    })

    // A denied copy must not reject: https://github.com/strands-agents/harness-sdk/issues/4958
    it('returns false when spawning pbcopy throws', async () => {
      vi.mocked(spawn).mockImplementationOnce(() => {
        throw Object.assign(new Error('spawn EPERM'), { code: 'EPERM' })
      })

      await expect(copyTerminalText('hello', { isTTY: true, write: vi.fn() })).resolves.toBe(false)
    })

    it.each([
      ['successful copy', 'close', 0, true],
      ['failed copy', 'close', 1, false],
      ['spawn error', 'error', new Error('spawn EACCES'), false],
      ['stdin error', 'stdin', new Error('write EPIPE'), false],
    ])('handles %s', async (_name, event, value, expected) => {
      const stdin = new PassThrough()
      const clipboard = Object.assign(new ChildProcess(), { stdin })
      vi.mocked(spawn).mockReturnValueOnce(clipboard)

      const result = copyTerminalText('hello', { isTTY: true, write: vi.fn() })
      if (event === 'stdin') {
        stdin.emit('error', value)
      } else {
        clipboard.emit(event, value)
      }

      await expect(result).resolves.toBe(expected)
      expect(spawn).toHaveBeenCalledWith('pbcopy', { stdio: ['pipe', 'ignore', 'ignore'] })
      expect(stdin.read()?.toString()).toBe('hello')
    })

    it('returns false when writing to pbcopy throws', async () => {
      const stdin = new PassThrough()
      const clipboard = Object.assign(new ChildProcess(), { stdin })
      vi.mocked(spawn).mockReturnValueOnce(clipboard)
      vi.spyOn(stdin, 'end').mockImplementationOnce(() => {
        throw new Error('stdin closed')
      })

      await expect(copyTerminalText('hello', { isTTY: true, write: vi.fn() })).resolves.toBe(false)
    })
  })
})
