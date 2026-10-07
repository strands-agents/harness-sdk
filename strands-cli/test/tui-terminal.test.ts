import { afterEach, describe, expect, it, vi } from 'vitest'

const childProcess = vi.hoisted(() => ({ spawn: vi.fn() }))

vi.mock('node:child_process', () => ({ spawn: childProcess.spawn }))

import { copyTerminalText, enterAlternateScreen, setTerminalMouseMotion } from '../src/tui/terminal/terminal.js'

afterEach(() => {
  childProcess.spawn.mockReset()
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

  it('copies text through OSC 52', () => {
    const writes: string[] = []

    copyTerminalText('hello\nworld', { write: (value) => writes.push(value) })

    expect(writes).toEqual([`\u001b]52;c;${Buffer.from('hello\nworld').toString('base64')}\u001b\\`])
  })

  it('keeps the session alive when the native clipboard cannot start', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    childProcess.spawn.mockImplementation(() => {
      throw Object.assign(new Error('spawn EPERM'), { code: 'EPERM' })
    })

    await expect(copyTerminalText('selected text', { isTTY: true, write: () => {} })).resolves.toBe(false)
  })
})
