import { stripVTControlCharacters } from 'node:util'
import stringWidth from 'string-width'
import { describe, expect, it } from 'vitest'

import { FROG_THEMES } from '../src/tui/chat/types.js'
import {
  renderFrogAnimationRuns,
  renderFrogBrandEasterEggFrame,
  renderFrogSpiralFrame,
  renderFrogStartupLockup,
  renderVoiceFrogRuns,
  type FrogRenderOptions,
} from '../src/tui/view/frog-intro-renderer.js'

const VARIANTS = ['hop', 'fly', 'peek', 'firefly'] as const

describe('frog themes', () => {
  it.each(FROG_THEMES)('renders %s in startup, intro, click, and all overlay animations', (theme) => {
    const options: FrogRenderOptions = { colorMode: 'dark' }
    const frames = [
      renderFrogStartupLockup(98, true, 960, theme, false, options),
      renderFrogSpiralFrame(98, 24, 0.3, 960, true, theme, options),
      renderFrogSpiralFrame(98, 24, 0.98, 3_136, true, theme, options),
      renderFrogBrandEasterEggFrame(98, 0.3, 960, true, theme, false, 960, options),
      ...VARIANTS.map((variant) =>
        renderFrogAnimationRuns(98, 14, variant, 0.66, 960, true, theme, options)
          .map((run) => run.text)
          .join('\n')
      ),
      renderVoiceFrogRuns(18, 8, 1, 960, true, true, theme, options)
        .map((run) => run.text)
        .join('\n'),
    ]

    for (const frame of frames) {
      expect(frame).toMatch(/\[(?:38|48);2;\d+;\d+;\d+m/u)
      expect(frame).not.toMatch(/undefined|NaN/u)
      expect(stripVTControlCharacters(frame).trim()).not.toBe('')
      expect(frame.endsWith('\u001b[0m')).toBe(true)
    }
  })

  it('shares Classic artwork with Kikker and keeps other theme shapes distinct', () => {
    const frames = FROG_THEMES.map((theme) => renderFrogStartupLockup(98, false, 960, theme))

    expect(new Set(frames).size).toBe(FROG_THEMES.length - 1)
    expect(frames[FROG_THEMES.indexOf('kikker')]).toBe(frames[FROG_THEMES.indexOf('green')])
    expect(frames[FROG_THEMES.indexOf('merlin')]).toContain('★')
    expect(frames[FROG_THEMES.indexOf('minimal')]).not.toMatch(/[★✦╱╲]/u)
  })

  it.each(FROG_THEMES)('keeps %s inside narrow terminals and preserves sparse overlay runs', (theme) => {
    for (const width of [1, 24, 67, 68]) {
      const startup = renderFrogStartupLockup(width, true, 960, theme, false, {}, 12)
      const click = renderFrogBrandEasterEggFrame(width, 0.3, 960, true, theme, false, 960, {}, 12)
      for (const [frame, height] of [
        [startup, 12],
        [click, 12],
      ] as const) {
        const rows = stripVTControlCharacters(frame).split('\n')
        expect(rows).toHaveLength(height)
        expect(rows.every((row) => stringWidth(row) === width)).toBe(true)
      }
      for (const variant of VARIANTS) {
        const runs = renderFrogAnimationRuns(width, 14, variant, 0.66, 960, true, theme)
        for (const run of runs) {
          expect(run.row).toBeGreaterThanOrEqual(0)
          expect(run.row).toBeLessThan(14)
          expect(run.column).toBeGreaterThanOrEqual(0)
          expect(run.column + stringWidth(run.text)).toBeLessThanOrEqual(width)
        }
      }
    }
    const peek = renderFrogAnimationRuns(98, 14, 'peek', 0.5, 960, true, theme)
    expect(peek.every((run) => stringWidth(run.text) < 40)).toBe(true)
  })

  it.each(FROG_THEMES)('ends the %s click animation on the startup lockup', (theme) => {
    const options: FrogRenderOptions = { colorMode: 'dark' }

    expect(renderFrogBrandEasterEggFrame(98, 1, 3_200, true, theme, false, 3_200, options)).toBe(
      renderFrogStartupLockup(98, true, 3_200, theme, false, options)
    )
  })
})

describe('frog palettes', () => {
  it.each([
    ['green', [129, 255, 157]],
    ['minimal', [237, 237, 237]],
    ['homeland', [34, 125, 206]],
    ['merlin', [130, 101, 194]],
    ['kikker', [255, 127, 0]],
    ['oak', [163, 106, 63]],
    ['spectre', [0, 0, 0]],
    ['scarlet', [224, 47, 63]],
  ] as const)('retains the fixed %s identity color and adapts to light mode', (theme, rgb) => {
    const dark = renderFrogStartupLockup(98, true, 960, theme, false, { colorMode: 'dark' })
    const light = renderFrogStartupLockup(98, true, 960, theme, false, { colorMode: 'light' })

    expect(dark).toContain(`;2;${rgb.join(';')}m`)
    expect(light).not.toBe(dark)
    if (theme === 'green') {
      expect(dark).toContain(';2;235;255;241m')
      expect(light).toContain(';2;7;28;17m')
      expect(light).toContain(';2;90;179;110m')
    }
  })

  it('renders Oak with wood grain and keeps Spectre red eyes', () => {
    const oak = renderFrogStartupLockup(98, true, 960, 'oak')
    const wordOnly = renderFrogStartupLockup(62, true, 960, 'oak')
    const spectre = renderFrogStartupLockup(98, true, 960, 'spectre')

    for (const artwork of [oak, wordOnly]) {
      expect(artwork).toContain(';2;107;60;30m')
      expect(artwork).toContain(';2;202;151;99m')
    }
    expect(oak).toContain(';2;39;23;17m')
    expect(oak).toBe(renderFrogStartupLockup(98, true, 0, 'oak'))
    expect(spectre).toContain(';2;255;55;76m')
  })

  it('preserves the shared party palette and motion across themes', () => {
    const options: FrogRenderOptions = { colorMode: 'light' }
    const party = renderFrogStartupLockup(98, true, 960, 'green', true, { colorMode: 'light' })

    for (const theme of FROG_THEMES) {
      expect(renderFrogStartupLockup(98, true, 960, theme, true, options)).toBe(party)
    }
    expect(renderFrogStartupLockup(98, true, 1_040, 'green', true, options)).not.toBe(party)
  })
})
