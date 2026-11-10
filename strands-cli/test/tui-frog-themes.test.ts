import { stripVTControlCharacters } from 'node:util'
import headless from '@xterm/headless'
import stringWidth from 'string-width'
import { describe, expect, it } from 'vitest'

import { FROG_THEMES, type FrogTheme } from '../src/tui/chat/types.js'
import {
  renderFrogAnimationRuns,
  renderFrogBrandEasterEggFrame,
  renderFrogSpiralFrame,
  renderFrogStartupLockup,
  type FrogAnimationRun,
  type FrogRenderOptions,
} from '../src/tui/view/frog-intro-renderer.js'

const BASES = FROG_THEMES.filter((theme) => theme !== 'custom')
const ORANGE = 0xf58426
const BLUE = 0x006bb6
const INK = 0x041121
const WHITE = 0xf2f6fa
const BALL_HALF_ROWS = 4
const QUADRANT_GLYPHS = ' ▗▖▄▝▐▞▟▘▚▌▙▀▜▛█'
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
    ['knicks', [0, 107, 182]],
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

  it('alternates Knicks orange and blue across the wordmark letters', async () => {
    const wordmarkRow = renderFrogStartupLockup(98, true, 960, 'knicks', false, { colorMode: 'dark' }).split('\n')[3]!

    expect(await wordmarkLetterColors(wordmarkRow)).toEqual([ORANGE, BLUE, ORANGE, BLUE, ORANGE, BLUE, ORANGE])
  })

  it.each([
    ['the startup lockup', renderFrogStartupLockup(98, true, 960, 'knicks', false, { colorMode: 'dark' })],
    ['a hop', positionedRuns(renderFrogAnimationRuns(98, 14, 'hop', 0.66, 960, true, 'knicks', { colorMode: 'dark' }))],
  ])('draws center and side seams across the Knicks basketball in %s', async (_, frame) => {
    const pixels = await renderedPixels(frame)
    const ball = basketballBox(pixels)
    const seamsCrossing = (y: number): number =>
      pixels[y]!.filter(
        (color, x) =>
          x > ball.left &&
          x < ball.right &&
          color === INK &&
          pixels[y]![x - 1] === ORANGE &&
          pixels[y]![x + 1] === ORANGE
      ).length

    expect(ball.seam).toBeGreaterThan(0)
    expect(seamsCrossing(ball.seam - 1)).toBe(3)
    expect(seamsCrossing(ball.seam + 1)).toBe(3)
  })

  it('keeps the Knicks basketball above the feet when the frog lands', async () => {
    const pixels = await renderedPixels(
      positionedRuns(renderFrogAnimationRuns(98, 14, 'hop', 0.745, 960, true, 'knicks', { colorMode: 'dark' }))
    )
    const ball = basketballBox(pixels)
    const footRows = pixels.flatMap((line, y) => (line.some((color, x) => color === INK && x > ball.right) ? [y] : []))

    expect(ball.seam).toBeGreaterThan(0)
    expect(ball.seam + BALL_HALF_ROWS).toBeLessThanOrEqual(Math.max(...footRows))
  })

  it('draws the Knicks frog inner lines in orange and keeps its outline and pupils ink', async () => {
    const pixels = await renderedPixels(renderFrogStartupLockup(98, true, 960, 'knicks', false, { colorMode: 'dark' }))
    const ball = basketballBox(pixels)
    const outline = pixels.flatMap((line, y) => line.flatMap((color, x) => (color === INK ? [{ x, y }] : [])))
    const top = Math.min(...outline.map(({ y }) => y))
    const bottom = Math.max(...outline.map(({ y }) => y))
    const right = Math.max(...outline.map(({ x }) => x))
    const frog = pixels.slice(0, bottom + 1).map((line) => line.slice(0, right + 1))
    const innerOrange = frog.some((line, y) => line.some((color, x) => color === ORANGE && !ball.contains(x, y)))
    const edges = frog.slice(top).flatMap((line, offset) => {
      const filled = line.flatMap((color, x) => (color >= 0 ? [x] : []))
      const leftEdge = ball.coversRow(top + offset) ? [] : [line[filled[0]!]]
      return [...leftEdge, line[filled.at(-1)!]]
    })
    const highlights = frog.flatMap((line, y) => line.flatMap((color, x) => (color === WHITE ? [{ x, y }] : [])))

    expect(innerOrange).toBe(true)
    expect(edges.every((color) => color === INK)).toBe(true)
    expect(highlights.length).toBeGreaterThan(0)
    expect(highlights.every(({ x, y }) => frog[y]![x - 1] === INK || frog[y]![x + 1] === INK)).toBe(true)
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

async function renderedScreen(frame: string): Promise<headless.Terminal> {
  const screen = new headless.Terminal({
    cols: 120,
    rows: frame.split('\n').length,
    allowProposedApi: true,
    convertEol: true,
  })
  await new Promise<void>((resolve) => screen.write(frame, resolve))
  return screen
}

function positionedRuns(runs: readonly FrogAnimationRun[]): string {
  const rows = Math.max(...runs.map(({ row }) => row)) + 1
  return Array.from({ length: rows }, (_, row) =>
    runs
      .filter((run) => run.row === row)
      .map(({ column, text }) => `\u001b[${column + 1}G${text}`)
      .join('')
  ).join('\n')
}

async function renderedPixels(frame: string): Promise<number[][]> {
  const screen = await renderedScreen(frame)
  return Array.from({ length: screen.rows * 2 }, (_, y) =>
    Array.from({ length: screen.cols * 2 }, (_, x) => pixelColor(screen, x, y))
  )
}

function pixelColor(screen: headless.Terminal, x: number, y: number): number {
  const cell = screen.buffer.active.getLine(Math.floor(y / 2))!.getCell(Math.floor(x / 2))!
  const mask = QUADRANT_GLYPHS.indexOf(cell.getChars() || ' ')
  const lit = mask < 0 || (mask & (1 << (3 - (y % 2) * 2 - (x % 2)))) !== 0
  if (lit) {
    return cell.isFgRGB() ? cell.getFgColor() : -1
  }
  return cell.isBgRGB() ? cell.getBgColor() : -1
}

async function wordmarkLetterColors(row: string): Promise<number[]> {
  const screen = await renderedScreen(row)
  const line = screen.buffer.active.getLine(0)!
  const colors: number[] = []
  for (let column = line.translateToString().search(/[\u2550-\u256c]/u); column < screen.cols; column++) {
    const color = pixelColor(screen, column * 2, 0)
    if (color >= 0 && colors.at(-1) !== color) {
      colors.push(color)
    }
  }
  return colors
}

function basketballBox(pixels: readonly number[][]) {
  const crossesSeam = (y: number, x: number): boolean =>
    pixels[y]![x] === INK && pixels[y - 1]?.[x] === ORANGE && pixels[y + 1]?.[x] === ORANGE
  const seam = pixels.findIndex((line, y) => line.filter((_, x) => crossesSeam(y, x)).length >= 8)
  const line = pixels[seam] ?? []
  let left = line.findIndex((_, x) => crossesSeam(seam, x))
  let right = left
  while (line[left - 1] === INK) {
    left--
  }
  while (line[right + 1] === INK) {
    right++
  }
  return {
    seam,
    left,
    right,
    coversRow: (y: number): boolean => Math.abs(y - seam) <= BALL_HALF_ROWS,
    contains: (x: number, y: number): boolean => Math.abs(y - seam) <= BALL_HALF_ROWS && x >= left && x <= right,
  }
}
