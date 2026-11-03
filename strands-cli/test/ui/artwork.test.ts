import { createElement } from 'react'
import { renderToString } from 'ink'
import { describe, expect, it, vi } from 'vitest'
import { render, ttyInput, ttyOutput } from '../fixtures/terminal.js'
import { commandAssistance } from '../../src/ui/chat/commands.js'
import { ChatController } from '../../src/ui/chat/controller.js'
import { ChatApp } from '../../src/ui/chat/screen.js'
import { ChatView } from '../../src/ui/chat/view.js'
import { FROG_ANIMATION_HEIGHT, parseFrogCommand } from '../../src/ui/frog.js'
import {
  renderFrogAnimationRuns,
  renderVoiceFrogRuns,
  type FrogAnimationRun,
  renderFrogBrandEasterEggFrame,
  renderFrogSpiralFrame,
  renderFrogStartupLockup,
  type FrogRenderOptions,
} from '../../src/ui/frog-renderer.js'
import { idleBackend } from '../fixtures/chat-backend.js'
import { stripVTControlCharacters } from 'node:util'
import stringWidth from 'string-width'
import { FROG_THEMES, DEFAULT_CHAT_SETTINGS } from '../../src/ui/chat/types.js'
import { sanitizeTerminalText } from '../../src/terminal/text.js'
import { SetupBrand, setupBrandFrame } from '../../src/ui/startup.js'
import { StartupView } from '../../src/ui/startup.js'

describe('/frog', () => {
  it('supports named and cycling animations without appearing in command suggestions', () => {
    expect(parseFrogCommand('/frog hop')).toBe('hop')
    expect(parseFrogCommand('/FROG fly')).toBe('fly')
    expect(parseFrogCommand('/frog peek')).toBe('peek')
    expect(parseFrogCommand('/frog firefly')).toBe('firefly')
    expect(parseFrogCommand('/frog')).toBe('hop')
    expect(parseFrogCommand('/frog', 'hop')).toBe('fly')
    expect(parseFrogCommand('/frog', 'fly')).toBe('peek')
    expect(parseFrogCommand('/frog', 'peek')).toBe('firefly')
    expect(parseFrogCommand('/frog', 'firefly')).toBe('hop')
    expect(parseFrogCommand('/frog hop', 'hop')).toBe('hop')
    expect(parseFrogCommand('/frog swim')).toBeUndefined()
    expect(commandAssistance('/fro')?.completions ?? []).toEqual([])
  })

  it('renders distinct hop, fly-catching, peek, and firefly frames', () => {
    const frames = [
      renderFrogAnimationRuns(60, FROG_ANIMATION_HEIGHT, 'hop', 0.5, 900),
      renderFrogAnimationRuns(60, FROG_ANIMATION_HEIGHT, 'fly', 0.7, 1_680),
      renderFrogAnimationRuns(60, FROG_ANIMATION_HEIGHT, 'peek', 0.5, 1_100),
      renderFrogAnimationRuns(60, FROG_ANIMATION_HEIGHT, 'firefly', 0.66, 2_500),
    ].map((runs) => runs.map((run) => run.text).join(''))

    for (const frame of frames) {
      expect(frame).toMatch(/[▗▖▄▝▐▞▟▘▚▌▙▀▜▛█]/u)
    }
    expect(new Set(frames)).toHaveLength(4)
  })

  it('moves lateral frog animations from right to left in multiple stages', () => {
    const hopCenters = [0.12, 0.37, 0.62, 0.87].map((progress) =>
      visibleCenter(renderFrogAnimationRuns(80, FROG_ANIMATION_HEIGHT, 'hop', progress, progress * 3_000))
    )
    const flyLead = renderFrogAnimationRuns(80, FROG_ANIMATION_HEIGHT, 'fly', 0.06, 204)
    const flyAhead = renderFrogAnimationRuns(80, FROG_ANIMATION_HEIGHT, 'fly', 0.18, 612)
    const chase = renderFrogAnimationRuns(80, FROG_ANIMATION_HEIGHT, 'fly', 0.4, 1_360)
    const fireflyArrival = renderFrogAnimationRuns(80, FROG_ANIMATION_HEIGHT, 'firefly', 0.34, 1_292)
    const fireflyExit = renderFrogAnimationRuns(80, FROG_ANIMATION_HEIGHT, 'firefly', 0.9, 3_420)

    expect(hopCenters[0]).toBeGreaterThan(hopCenters[1]!)
    expect(hopCenters[1]).toBeGreaterThan(hopCenters[2]!)
    expect(hopCenters[2]).toBeGreaterThan(hopCenters[3]!)
    expect(visibleCenter(flyLead)).toBeGreaterThan(visibleCenter(flyAhead))
    expect(visibleCharacters(chase)).toBeGreaterThan(visibleCharacters(flyAhead))
    expect(visibleCenter(fireflyArrival)).toBeGreaterThan(visibleCenter(fireflyExit))
  })

  it('hops the voice frog in and moves its mouth while speaking', () => {
    const entering = renderVoiceFrogRuns(18, 8, 0.5, 360, false)
    const resting = renderVoiceFrogRuns(18, 8, 1, 720, false)
    const speakingClosed = renderVoiceFrogRuns(18, 8, 1, 400, true, true)
    const speakingOpen = renderVoiceFrogRuns(18, 8, 1, 133, true, true)

    expect(visibleCenter(entering)).toBeGreaterThan(visibleCenter(resting))
    expect(visibleCharacters(resting)).toBeGreaterThan(0)
    expect(speakingClosed).not.toEqual(speakingOpen)
  })

  it('renders the frog over the existing conversation instead of replacing it', async () => {
    const target = idleBackend({ stream: vi.fn() })
    target.stream = async function* () {
      yield { type: 'textDelta', text: 'Conversation stays visible' }
      return { stopReason: 'endTurn' }
    }
    const controller = new ChatController(target, {
      settings: { animations: false },
    })
    await controller.submit('Keep this on screen')

    const output = renderToString(
      createElement(ChatView, {
        snapshot: controller.getSnapshot(),
        input: '',
        cursor: 0,
        terminalWidth: 80,
        terminalHeight: 40,
        frog: { id: 1, variant: 'hop' },
        onFrogComplete: () => {},
      }),
      { columns: 80 }
    )

    expect(output).toContain('Conversation stays visible')
    expect(output).toMatch(/[▗▖▄▝▐▞▟▘▚▌▙▀▜▛█]/u)
  })

  it('handles the command in the TUI without creating a conversation turn', async () => {
    const input = ttyInput()
    const output = ttyOutput(80, 20)
    const target = idleBackend({ stream: vi.fn() })
    const controller = new ChatController(target, {
      settings: { animations: false },
    })
    const instance = render(createElement(ChatApp, { controller }), {
      stdin: input,
      stdout: output,
      stderr: ttyOutput(80, 20),
      exitOnCtrlC: false,
      patchConsole: false,
    })

    input.write('/frog peek')
    await instance.waitUntilRenderFlush()
    input.write('\r')

    await instance.waitUntilRenderFlush()
    expect(controller.getSnapshot().completedTurns).toEqual([])
    expect(controller.getSnapshot().panel).toBeUndefined()
    expect(target.stream).not.toHaveBeenCalled()
  })
})

describe('/strands', () => {
  it('opens the website without appearing in suggestions or creating a turn', async () => {
    const input = ttyInput()
    const target = idleBackend({ stream: vi.fn() })
    const controller = new ChatController(target)
    const openUrl = vi.fn()
    const instance = render(createElement(ChatApp, { controller, openUrl }), {
      stdin: input,
      stdout: ttyOutput(80, 20),
      stderr: ttyOutput(80, 20),
      exitOnCtrlC: false,
      patchConsole: false,
    })

    input.write('/strands')
    await instance.waitUntilRenderFlush()
    input.write('\r')

    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith('https://strandsagents.com'))
    expect(commandAssistance('/stra')?.completions ?? []).toEqual([])
    expect(controller.getSnapshot().completedTurns).toEqual([])
    expect(target.stream).not.toHaveBeenCalled()
  })
})

function visibleCenter(runs: FrogAnimationRun[]): number {
  const columns = runs.flatMap((run) => [run.column, run.column + [...run.text].length - 1])
  return (Math.min(...columns) + Math.max(...columns)) / 2
}

function visibleCharacters(runs: FrogAnimationRun[]): number {
  return runs.reduce((count, run) => count + [...run.text].filter((character) => character !== ' ').length, 0)
}

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
      expect(dark).not.toContain(';2;235;255;241m')
      expect(light).toContain(';2;7;28;17m')
      expect(light).toContain(';2;90;179;110m')
    }
  })

  it('renders Oak with wood grain and keeps Spectre red eyes', () => {
    const oak = renderFrogStartupLockup(98, true, 960, 'oak')
    const wordOnly = renderFrogStartupLockup(63, true, 960, 'oak')
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
    const full = renderFrogStartupLockup(89, false, 0, 'green', false, {}, 12)
    const wordOnly = renderFrogStartupLockup(88, false, 0, 'green', false, {}, 19)
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
