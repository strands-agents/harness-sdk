import { describe, expect, it } from 'vitest'

import { copyTerminalText, enterAlternateScreen, setTerminalMouseMotion } from '../src/tui/terminal/terminal.js'

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
})
