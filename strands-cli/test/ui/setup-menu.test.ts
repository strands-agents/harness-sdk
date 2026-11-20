import { createElement } from 'react'
import { renderToString } from 'ink'
import { describe, expect, it } from 'vitest'
import { OpeningMenu } from '../../src/ui/setup/menu.js'
import { sanitizeTerminalText } from '../../src/terminal/text.js'

describe('OpeningMenu', () => {
  it('shouldShowTheErrorCopyHintOnTheEscapeRowWithoutAddingARow', () => {
    const menu = (error?: { text: string; copyHint: string }): string[] =>
      sanitizeTerminalText(
        renderToString(
          createElement(OpeningMenu, {
            width: 100,
            buttonHeight: 3,
            selection: 0,
            showSelection: true,
            topGap: 0,
            animate: false,
            escapeHint: 'Esc to exit',
            onRowElement: () => {},
            ...(error ? { error } : {}),
          }),
          { columns: 100 }
        )
      )
        .trimEnd()
        .split('\n')

    const plain = menu()
    const failed = menu({ text: 'Settings could not be saved.', copyHint: 'Ctrl+Y copy error' })

    const escapeRow = failed.findIndex((line) => line.includes('Esc to exit'))
    expect(failed[escapeRow]).toContain('Esc to exit · Ctrl+Y copy error')
    expect(failed.at(-1)?.trim()).toBe('Settings could not be saved.')
    expect(failed).toHaveLength(plain.length + 2)
  })
})
