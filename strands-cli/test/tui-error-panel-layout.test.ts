import { createElement } from 'react'
import { measureElement, render, type DOMElement } from 'ink'
import stringWidth from 'string-width'
import { describe, expect, it } from 'vitest'
import { captureFrame, ttyInput, ttyOutput } from './fixtures/terminal.js'
import { snapshot } from './fixtures/chat-snapshot.js'

import { ChatView } from '../src/tui/view/chat-view.js'

describe('error panel layout', () => {
  it.each([
    { width: 80, separateRows: false },
    { width: 120, separateRows: true },
  ])('bounds and scrolls multiline Unicode errors at $width columns', async ({ width, separateRows }) => {
    const start = 'Voice sidecar exited with status 1.'
    const end = 'ImportError: incompatible runtime.'
    const details = `\n${'\n'.repeat(120)}${Array.from(
      { length: 16 },
      (_, index) => `Trace ${index}: ${'界👩‍💻e\u0301'.repeat(40)}`
    ).join('\n')}`
    const current = snapshot({
      panel: {
        id: 'voice-error',
        kind: 'error',
        title: 'voice update failed',
        ...(separateRows ? { body: start } : {}),
        rows: separateRows
          ? [
              { label: 'voice', description: details, tone: 'danger' },
              { label: end, description: '', tone: 'danger' },
            ]
          : [{ label: 'voice', description: `${start}${details}\n${end}`, tone: 'danger' }],
      },
    })
    let panelElement: DOMElement | null = null
    const output = ttyOutput(width, 24)
    const frame = captureFrame(output)
    const view = (detailScroll = 0) =>
      createElement(ChatView, {
        snapshot: current,
        input: '',
        cursor: 0,
        terminalWidth: width,
        terminalHeight: 24,
        detailScroll,
        onPanelElement: (element) => {
          panelElement = element
        },
      })
    const instance = render(view(), {
      stdin: ttyInput(),
      stdout: output,
      stderr: ttyOutput(width, 24),
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    })
    try {
      await instance.waitUntilRenderFlush()
      expect(panelElement).not.toBeNull()
      expect(measureElement(panelElement!).height).toBeLessThanOrEqual(10)
      expect(measureElement(panelElement!).width).toBe(width - 2)
      const first = frame().join('\n')
      expect(first).toContain(start)
      expect(first).not.toContain(end)
      expect(first).toContain('界👩‍💻e\u0301')
      expect(first).toContain('↑↓ / PgUp / PgDn scroll')

      instance.rerender(view(Number.MAX_SAFE_INTEGER))
      await instance.waitUntilRenderFlush()
      expect(frame().join('\n')).toContain(end)
      expect(frame().join('\n')).not.toContain(start)
      for (const rows of [first.split('\n'), frame()]) {
        expect(rows.length).toBeLessThanOrEqual(24)
        expect(rows.every((line) => stringWidth(line) <= width)).toBe(true)
        expect(rows.filter((line) => line.includes('Esc close'))).toHaveLength(1)
        expect(rows.at(-1)).toContain('/settings')
      }
    } finally {
      instance.unmount()
    }
  })
})
