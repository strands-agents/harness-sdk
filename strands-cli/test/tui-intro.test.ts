import { createElement } from 'react'
import { renderToString } from 'ink'
import { describe, expect, it } from 'vitest'

import { DEFAULT_CHAT_SETTINGS } from '../src/tui/chat/types.js'
import { sanitizeTerminalText } from '../src/tui/terminal/sanitize.js'
import {
  renderFrogSpiralFrame,
  renderFrogBrandEasterEggFrame,
  renderFrogStartupLockup,
} from '../src/tui/view/frog-intro-renderer.js'
import { SetupBrand, setupBrandFrame } from '../src/tui/view/setup-wizard/brand.js'
import { StartupView } from '../src/tui/view/startup-view.js'

// Colored output paints solid cells as backgrounds, leaving only the half-block glyphs as text.
const STRANDS_WORDMARK = /STRANDS|╚════╝|█▀▀ ▀█▀ █▀█ ▄▀█ █▄ █ █▀▄ █▀▀|▀▀ ▀ ▀ {2}▀ {2}▄▀ {3}▄ {4}▀▄ {2}▀▀/

describe('Strands intro', () => {
  it('retains Homeland ocean and land colors during the brand animation', () => {
    const frame = renderFrogBrandEasterEggFrame(98, 0.54, 1_728, true, 'homeland')

    expect(frame).toContain(';2;34;125;206m')
    expect(frame).toContain(';2;65;190;105m')
    expect(frame).not.toContain(';2;129;255;157m')
  })

  it.each([98, 120])('swirls STRANDS into a vortex and restores the wordmark on a frog click at width %s', (width) => {
    const startup = renderFrogStartupLockup(width)
    const vortex = renderFrogBrandEasterEggFrame(width, 0.54, 1_728)
    const rotating = renderFrogBrandEasterEggFrame(width, 0.58, 1_856)
    const reformed = renderFrogBrandEasterEggFrame(width, 0.84, 2_688)
    const top = 2
    const wordX = startup.split('\n')[top]!.indexOf('▄▟███▙▄')

    expect(vortex).toMatch(/[●•◆◇━]/u)
    expect(vortex).not.toContain('▄▟███▙▄')
    expect(rotating).not.toBe(vortex)
    expect(
      reformed
        .split('\n')
        .slice(top, top + 6)
        .map((row) => row.slice(wordX))
    ).toEqual(
      startup
        .split('\n')
        .slice(top, top + 6)
        .map((row) => row.slice(wordX))
    )
    expect(renderFrogBrandEasterEggFrame(width, 1, 3_200)).toBe(startup)
    const origin = { x: 14, y: 6 }
    const shiftedVortex = renderFrogBrandEasterEggFrame(width, 0.54, 1_728, false, 'green', false, 0, {}, 12, origin)
    expect(
      shiftedVortex
        .split('\n')
        .slice(origin.y)
        .map((row) => row.slice(origin.x))
        .join('\n')
    ).toBe(vortex)
    const leaving = renderFrogBrandEasterEggFrame(width, 0.12, 384, false, 'green', false, 0, {}, 12, origin)
    expect(
      leaving
        .split('\n')
        .slice(0, origin.y)
        .some((row) => row.slice(0, origin.x).trim())
    ).toBe(true)
  })

  it.each(['chat', 'setup'] as const)('lets the clicked frog leave through the screen edge in %s', (surface) => {
    const frame = (elapsedMs?: number): string[] => {
      const element =
        surface === 'chat'
          ? createElement(StartupView, {
              terminalWidth: 120,
              availableHeight: 36,
              animate: true,
              theme: 'green',
              ...(elapsedMs === undefined ? {} : { frogBrandElapsedMs: elapsedMs }),
            })
          : createElement(SetupBrand, {
              frame: setupBrandFrame(118, 42),
              containerWidth: 118,
              appearance: { ...DEFAULT_CHAT_SETTINGS, animations: true, frogTheme: 'green' },
              animationId: elapsedMs === undefined ? undefined : 1,
              elapsedMs: elapsedMs ?? 0,
              onFrogElement: () => {},
            })
      return sanitizeTerminalText(renderToString(element, { columns: 120 })).split('\n')
    }
    const resting = frame()

    expect(resting.slice(0, 6).every((row) => !row.trim())).toBe(true)
    expect(frame(320)[0]!.trim()).not.toBe('')
    expect(frame(2_848)[0]!.trim()).not.toBe('')
    expect(
      frame(640)
        .slice(0, 6)
        .every((row) => !row.trim())
    ).toBe(true)
    expect(frame(3_200)).toEqual(resting)
  })

  it('writes STRANDS with the spiral before the frog enters', () => {
    const writing = renderFrogSpiralFrame(98, 38, 0.14, 588)
    const dissolved = renderFrogSpiralFrame(98, 38, 0.23, 966)
    const impact = renderFrogSpiralFrame(98, 38, 0.5, 2_100)

    expect(writing).toMatch(/[●•◆◇━]/u)
    expect(writing).toContain('▄▟███▙▄')
    expect(writing.split('▄▟███▙▄').length - 1).toBeLessThan(dissolved.split('▄▟███▙▄').length - 1)
    expect(renderFrogSpiralFrame(98, 38, 0.14, 588, true)).not.toContain('\u001b[48;2;7;28;17m')
    expect(dissolved).not.toMatch(/[●•◆◇━]/u)
    expect(renderFrogSpiralFrame(98, 38, 0.23, 966, true)).not.toContain('\u001b[48;2;7;28;17m')
    expect(impact).not.toBe(dissolved)
    expect(renderFrogSpiralFrame(98, 38, 0.5, 2_100, true)).toContain('\u001b[48;2;7;28;17m')
  })

  it('paints full cells as backgrounds and keeps two-color glyphs on the bottom half', () => {
    const colored = renderFrogStartupLockup(98, true)
    const plain = renderFrogStartupLockup(98)

    expect(colored).toContain('[48;2;129;255;157m ')
    expect(colored).not.toContain('█')
    expect(colored).toContain('[48;2;7;28;17m▄')
    expect(topHeavyGlyphsOverBackground(colored)).toBe(0)
    expect(plain).toContain('█████')
    expect(plain).toContain('▀')
  })

  it('leaves R dangling after the second landing and restores it with the tongue', () => {
    const startup = renderFrogStartupLockup(98).split('\n')
    const rColumn = startup[2]!.indexOf('▄▟███▙▄') + 18
    const hanging = renderFrogSpiralFrame(98, 38, 0.23 + 0.77 * 0.7, 3_230).split('\n')
    const repaired = renderFrogSpiralFrame(98, 38, 0.23 + 0.77 * 0.9, 3_877).split('\n')
    expect(rColumn).toBeGreaterThan(0)
    for (let row = 0; row < 6; row++) {
      expect(hanging[row + 6]!.slice(rColumn, rColumn + 8)).toBe(startup[row + 2]!.slice(rColumn, rColumn + 8))
      expect(repaired[row + 4]!.slice(rColumn, rColumn + 8)).toBe(startup[row + 2]!.slice(rColumn, rColumn + 8))
    }
  })

  it('renders STRANDS in compact layouts', () => {
    for (const width of [22, 40]) {
      const styled = renderFrogStartupLockup(width, true, 0, 'green', false, {}, 2)
      const plain = sanitizeTerminalText(styled)
      expect(plain).toMatch(STRANDS_WORDMARK)
    }
  })

  it('shows the frog only beside the wordmark and keeps the wordmark alone when narrower', () => {
    const full = renderFrogStartupLockup(88, false, 0, 'green', false, {}, 12)
    const wordOnly = renderFrogStartupLockup(87, false, 0, 'green', false, {}, 19)
    const small = renderFrogStartupLockup(56, false, 0, 'green', false, {}, 19)

    expect(full).toContain('▄▀▀▀▄')
    expect(wordOnly).toContain('╚════╝')
    expect(
      wordOnly
        .split('\n')
        .slice(6)
        .every((row) => !row.trim())
    ).toBe(true)
    expect(small).not.toContain('╚════╝')
  })

  it('stays inside a 120x35 terminal', () => {
    const width = 120
    const height = 35
    const rows = renderFrogSpiralFrame(width, height, 0.78, 2_496).split('\n')

    expect(rows).toHaveLength(height)
    expect(rows.every((row) => [...row].length === width)).toBe(true)
  })
})

function topHeavyGlyphsOverBackground(rendered: string): number {
  let hasBackground = false
  let found = 0
  for (const segment of rendered.split('[')) {
    const codeEnd = segment.indexOf('m')
    const code = segment.slice(0, codeEnd)
    if (code === '0' || code === '49') {
      hasBackground = false
    } else if (code.startsWith('48;')) {
      hasBackground = true
    }
    for (const character of segment.slice(codeEnd + 1)) {
      if (hasBackground && '▀▛▜'.includes(character)) {
        found += 1
      }
    }
  }
  return found
}
