import { stripVTControlCharacters } from 'node:util'
import stringWidth from 'string-width'
import { describe, expect, it } from 'vitest'

import { FROG_THEMES, type FrogTheme } from '../src/tui/chat/types.js'
import {
  renderFrogAnimationRuns,
  renderFrogBrandEasterEggFrame,
  renderFrogSpiralFrame,
  renderFrogStartupLockup,
  type FrogRenderOptions,
} from '../src/tui/view/frog-intro-renderer.js'

const BASES = FROG_THEMES.filter((theme) => theme !== 'custom')
const VARIANTS = ['hop', 'fly', 'peek', 'firefly'] as const

describe('frog themes', () => {
  it.each(FROG_THEMES)('renders %s in startup, intro, click, and all overlay animations', (theme) => {
    const options: FrogRenderOptions = { colorMode: 'dark', customBase: 'merlin', frogColor: '#ac73df' }
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
    ]

    for (const frame of frames) {
      expect(frame).toMatch(/\[(?:38|48);2;\d+;\d+;\d+m/u)
      expect(frame).not.toMatch(/undefined|NaN/u)
      expect(stripVTControlCharacters(frame).trim()).not.toBe('')
      expect(frame.endsWith('\u001b[0m')).toBe(true)
    }
  })

  it('shares Classic artwork with Kikker and keeps other theme shapes distinct', () => {
    const frames = BASES.map((theme) => renderFrogStartupLockup(98, false, 960, theme))

    expect(new Set(frames).size).toBe(BASES.length - 1)
    expect(frames[BASES.indexOf('kikker')]).toBe(frames[BASES.indexOf('green')])
    expect(frames[BASES.indexOf('merlin')]).toContain('★')
    expect(frames[BASES.indexOf('minimal')]).not.toMatch(/[★✦╱╲]/u)
  })

  it('uses the selected artwork and color for Custom in every render path', () => {
    const options: FrogRenderOptions = { customBase: 'merlin', frogColor: '#0cabcd' }

    expect(renderPaths('custom', options)).toEqual(renderPaths('merlin', options))
    expect(renderFrogStartupLockup(98, true, 960, 'custom', false, options)).toContain(';2;12;171;205m')
  })

  it.each(BASES)('keeps %s inside narrow terminals and preserves sparse overlay runs', (theme) => {
    for (const width of [1, 24, 67, 68]) {
      const startup = renderFrogStartupLockup(width, true, 960, theme, false, {}, 12)
      const intro = renderFrogSpiralFrame(width, 14, 0.98, 960, true, theme)
      const click = renderFrogBrandEasterEggFrame(width, 0.3, 960, true, theme, false, 960, {}, 12)
      for (const [frame, height] of [
        [startup, 12],
        [intro, 14],
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

  it.each(BASES)('ends the %s intro on the startup lockup', (theme) => {
    const options: FrogRenderOptions = { frogColor: '#ac73df' }
    const complete = renderFrogSpiralFrame(98, 38, 1, 4_200, true, theme, options).split('\n').slice(2, 14).join('\n')

    expect(complete).toBe(renderFrogStartupLockup(98, true, 0, theme, false, options))
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
    ['merlin', [192, 132, 252]],
    ['kikker', [255, 127, 0]],
    ['circuit', [174, 182, 191]],
    ['spectre', [0, 0, 0]],
    ['solar', [255, 209, 102]],
  ] as const)('retains the fixed %s identity color and adapts to light mode', (theme, rgb) => {
    const dark = renderFrogStartupLockup(98, true, 960, theme, false, { colorMode: 'dark' })
    const light = renderFrogStartupLockup(98, true, 960, theme, false, { colorMode: 'light' })

    expect(dark).toContain(`;2;${rgb.join(';')}m`)
    expect(light).not.toBe(dark)
  })

  it('keeps Cyborg blue and red lights and Spectre red eyes', () => {
    const cyborg = renderFrogStartupLockup(98, true, 960, 'circuit')
    const spectre = renderFrogStartupLockup(98, true, 960, 'spectre')

    expect(cyborg).toContain(';2;92;218;255m')
    expect(cyborg).toContain(';2;255;54;72m')
    expect(spectre).toContain(';2;255;55;76m')
  })

  it('uses Classic for an unspecified Custom base and ignores invalid color strings', () => {
    const classic = renderFrogStartupLockup(98, true)

    expect(renderFrogStartupLockup(98, true, 0, 'custom')).toBe(classic)
    expect(renderFrogStartupLockup(98, true, 0, 'custom', false, { frogColor: 'undefined' })).toBe(classic)
  })

  it('preserves the shared party palette and motion across themes', () => {
    const options: FrogRenderOptions = { colorMode: 'light', customBase: 'spectre', frogColor: '#0cabcd' }
    const party = renderFrogStartupLockup(98, true, 960, 'green', true, { colorMode: 'light' })

    for (const theme of FROG_THEMES) {
      expect(renderFrogStartupLockup(98, true, 960, theme, true, options)).toBe(party)
    }
    expect(renderFrogStartupLockup(98, true, 1_040, 'green', true, options)).not.toBe(party)
  })
})

function renderPaths(theme: FrogTheme, options: FrogRenderOptions) {
  return [
    renderFrogStartupLockup(98, true, 960, theme, false, options),
    renderFrogSpiralFrame(98, 24, 0.98, 960, true, theme, options),
    renderFrogBrandEasterEggFrame(98, 0.3, 960, true, theme, false, 960, options),
    ...VARIANTS.map((variant) => renderFrogAnimationRuns(98, 14, variant, 0.66, 960, true, theme, options)),
  ]
}
