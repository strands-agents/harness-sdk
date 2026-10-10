import { createElement } from 'react'
import { measureElement, render, type DOMElement } from 'ink'
import { describe, expect, it } from 'vitest'
import { ttyInput, ttyOutput } from './fixtures/terminal.js'
import { snapshot } from './fixtures/chat-snapshot.js'

import { ChatView } from '../src/tui/view/chat-view.js'

describe('error panel layout', () => {
  it('keeps newline-heavy error output within the terminal viewport', async () => {
    let panelElement: DOMElement | null = null
    const instance = render(
      createElement(ChatView, {
        snapshot: snapshot({
          panel: {
            id: 'voice-error',
            kind: 'error',
            title: 'voice update failed',
            rows: [
              {
                label: 'voice',
                description: `Voice sidecar exited with status 1.\n${'\n'.repeat(120)}ImportError: incompatible runtime.`,
                tone: 'danger',
              },
            ],
          },
        }),
        input: '',
        cursor: 0,
        terminalWidth: 80,
        terminalHeight: 24,
        onPanelElement: (element) => {
          panelElement = element
        },
      }),
      {
        stdin: ttyInput(),
        stdout: ttyOutput(80, 24),
        stderr: ttyOutput(80, 24),
        exitOnCtrlC: false,
        patchConsole: false,
        incrementalRendering: true,
      }
    )
    try {
      await instance.waitUntilRenderFlush()
      expect(panelElement).not.toBeNull()
      expect(measureElement(panelElement!).height).toBeLessThanOrEqual(22)
    } finally {
      instance.unmount()
    }
  })
})
