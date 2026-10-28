import { createElement } from 'react'
import { renderToString } from 'ink'
import stringWidth from 'string-width'
import { describe, expect, it } from 'vitest'

import { sanitizeTerminalText } from '../src/tui/terminal/sanitize.js'
import { renderFrogStartupLockup } from '../src/tui/view/frog-intro-renderer.js'
import { setupBrandFrame } from '../src/tui/view/setup-wizard/brand.js'
import { SetupProgress } from '../src/tui/view/setup-wizard/progress.js'

function brandRows(width: number, terminalHeight: number): string[] {
  const frame = setupBrandFrame(width, terminalHeight)
  return renderFrogStartupLockup(frame.width, false, 0, 'green', false, {}, frame.height)
    .split('\n')
    .map((row) => row.trimEnd())
}

describe('setup resize layout', () => {
  it('retains the exact six-row wordmark when widening from 92 to 93 columns at height 37', () => {
    expect(setupBrandFrame(90, 37).height).toBe(6)
    expect(setupBrandFrame(91, 37).height).toBe(8)
    const before = brandRows(90, 37).filter(Boolean)
    const after = brandRows(91, 37).filter(Boolean)
    expect(before).toHaveLength(6)
    expect(after).toEqual(before)
  })

  it.each([
    [90, 31, 2],
    [90, 32, 6],
    [91, 27, 1],
    [91, 28, 2],
    [91, 33, 2],
    [91, 34, 8],
    [91, 37, 8],
    [91, 38, 12],
    [120, 37, 8],
    [120, 38, 12],
  ])('uses only the available art rows at %s×%s', (width, terminalHeight, expectedHeight) => {
    const frame = setupBrandFrame(width, terminalHeight)
    expect(frame.height).toBe(expectedHeight)
    if (frame.height > 1) {
      expect(frame.height + 2 + 24).toBeLessThanOrEqual(terminalHeight)
    }
    expect(frame.left + frame.width).toBe(width)
    expect(brandRows(width, terminalHeight)).toHaveLength(expectedHeight)
  })

  it.each([
    [48, `${'█'.repeat(20)}${'░'.repeat(20)}  3 of 6`],
    [10, '█░  3 of 6'],
    [9, '▌  3 of 6'],
    [8, '▌ 3 of 6'],
    [7, ' 3 of 6'],
    [6, '3 of 6'],
    [5, '3 of…'],
    [1, '…'],
  ])('keeps progress and its label within %s columns', (width, expected) => {
    const frame = sanitizeTerminalText(
      renderToString(createElement(SetupProgress, { current: 3, total: 6, width, animate: false }), {
        columns: width,
      })
    )
    expect(frame).toBe(expected)
    expect(stringWidth(frame)).toBeLessThanOrEqual(width)
  })

  it.each([
    [0, '░ 0 of 6'],
    [1, '▏ 1 of 6'],
    [6, '█ 6 of 6'],
  ])('retains the progress endpoint for step %s in eight columns', (current, expected) => {
    expect(
      sanitizeTerminalText(
        renderToString(createElement(SetupProgress, { current, total: 6, width: 8, animate: false }), {
          columns: 8,
        })
      )
    ).toBe(expected)
  })

  it('measures progress labels in terminal cells', () => {
    const frame = sanitizeTerminalText(
      renderToString(createElement(SetupProgress, { current: 1, total: 2, label: '確認', width: 6, animate: false }), {
        columns: 6,
      })
    )
    expect(frame).toBe('▌ 確認')
    expect(stringWidth(frame)).toBe(6)
  })
})
