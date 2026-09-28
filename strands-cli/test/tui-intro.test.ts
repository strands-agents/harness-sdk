import { describe, expect, it } from 'vitest'

import { sanitizeTerminalText } from '../src/tui/terminal/sanitize.js'
import { hasRoomForFrogIntro } from '../src/tui/view/intro.js'
import {
  renderFrogSpiralFrame,
  renderFrogBrandEasterEggFrame,
  renderFrogStartupLockup,
  frogStartupHeight,
} from '../src/tui/view/frog-intro-renderer.js'
import { setupBrandFrame } from '../src/tui/view/setup-wizard/brand.js'

// Colored output paints solid cells as backgrounds, leaving only the half-block glyphs as text.
const STRANDS_WORDMARK = /STRANDS|╔════╝|█▀▀ ▀█▀ █▀█ ▄▀█ █▄ █ █▀▄ █▀▀|▀▀ ▀ ▀ {2}▀ {2}▄▀ {3}▄ {4}▀▄ {2}▀▀/

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
    const wordX = startup.split('\n')[top]!.indexOf('███████╗')

    expect(vortex).toMatch(/[●•◆◇━]/u)
    expect(vortex).not.toContain('███████╗')
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
  })

  it('only runs when the full frog lockup fits', () => {
    expect(hasRoomForFrogIntro(92, 40)).toBe(false)
    expect(hasRoomForFrogIntro(93, 31)).toBe(false)
    expect(hasRoomForFrogIntro(93, 32)).toBe(true)
    expect(hasRoomForFrogIntro(120, 40)).toBe(true)
  })

  it('writes STRANDS with the spiral before the frog enters', () => {
    const writing = renderFrogSpiralFrame(98, 38, 0.14, 588)
    const dissolved = renderFrogSpiralFrame(98, 38, 0.23, 966)
    const impact = renderFrogSpiralFrame(98, 38, 0.5, 2_100)
    const complete = renderFrogSpiralFrame(98, 38, 1, 4_200)

    expect(writing).toMatch(/[●•◆◇━]/u)
    expect(writing).toContain('███████╗')
    expect(writing.split('███████╗').length - 1).toBeLessThan(dissolved.split('███████╗').length - 1)
    expect(writing).not.toMatch(/[▗▖▄▝▐▞▟▘▚▌▙▀▜▛]/u)
    expect(dissolved).not.toMatch(/[●•◆◇━▗▖▄▝▐▞▟▘▚▌▙▀▜▛]/u)
    expect(impact).toMatch(/[▗▖▄▝▐▞▟▘▚▌▙▀▜▛]/u)
    expect(complete).toContain('█████')
    expect(complete).not.toContain('\u001b[')
  })

  it.each([
    [98, 38],
    [78, 40],
    [40, 24],
  ])('hands off to the exact startup artwork at %s by %s', (width, height) => {
    const artHeight = frogStartupHeight(width, height - 6)
    const top = artHeight > 2 ? 2 : 1
    const complete = renderFrogSpiralFrame(width, height, 1, 4_200, true)
      .split('\n')
      .slice(top, top + artHeight)
      .join('\n')
    const held = renderFrogSpiralFrame(width, height, 1, 4_450, true)
      .split('\n')
      .slice(top, top + artHeight)
      .join('\n')
    const startup = renderFrogStartupLockup(width, true, 0, 'green', false, {}, artHeight)
    expect(complete).toBe(startup)
    expect(held).toBe(startup)
  })

  it.each([
    [98, 32],
    [98, 36],
    [98, 40],
    [140, 40],
    [78, 42],
  ])('hands off to the setup wizard brand frame at %s by %s', (width, height) => {
    const frame = setupBrandFrame(width, height)
    const top = frame.height > 2 ? 2 : 1
    const complete = renderFrogSpiralFrame(width, height, 1, 4_200, true, 'green', {}, frame.height, frame.left)
      .split('\n')
      .slice(top, top + frame.height)
      .join('\n')
    const brand = renderFrogStartupLockup(frame.width, true, 0, 'green', false, {}, frame.height)
      .split('\n')
      .map((row) => ' '.repeat(frame.left) + row)
      .join('\n')
    expect(complete).toBe(brand)
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
    const rColumn = startup[2]!.indexOf('████████╗') + 10
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
    const full = renderFrogStartupLockup(91, false, 0, 'green', false, {}, 12)
    const wordOnly = renderFrogStartupLockup(90, false, 0, 'green', false, {}, 19)
    const small = renderFrogStartupLockup(64, false, 0, 'green', false, {}, 19)

    expect(full).toContain('▄▀▀▀▄')
    expect(wordOnly).toContain('███████╗')
    expect(wordOnly).not.toContain('▄▀▀▀▄')
    expect(small).not.toContain('███████╗')
  })

  it.each([
    [48, 20],
    [79, 24],
    [120, 35],
  ])('stays inside a %ix%i terminal', (width, height) => {
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
