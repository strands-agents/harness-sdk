import { createElement } from 'react'
import { renderToString } from 'ink'
import { describe, expect, it, vi } from 'vitest'
import { render, ttyInput, ttyOutput } from '../fixtures/terminal.js'
import { commandAssistance } from '../../src/ui/chat/commands.js'
import { ChatController } from '../../src/ui/chat/controller.js'
import { ChatApp } from '../../src/ui/chat/screen.js'
import { ChatView } from '../../src/ui/chat/view.js'
import {
  renderFrogAnimationRuns,
  renderVoiceFrogRuns,
  renderFrogBrandEasterEggFrame,
  renderFrogSpiralFrame,
  renderFrogStartupLockup,
  type FrogRenderOptions,
} from '../../src/ui/frog-renderer.js'
import { idleBackend } from '../fixtures/chat-backend.js'
import { stripVTControlCharacters } from 'node:util'
import stringWidth from 'string-width'
import { FROG_THEMES } from '../../src/ui/chat/types.js'
import { sanitizeTerminalText } from '../../src/terminal/text.js'

describe('/frog', () => {
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

// Colored output paints solid cells as backgrounds, leaving only the half-block glyphs as text.
const STRANDS_WORDMARK = /STRANDS|▄▟[ █]{3}▙▄|█▀▀ ▀█▀ █▀█ ▄▀█ █▄ █ █▀▄ █▀▀|▀▀ ▀ ▀ {2}▀ {2}▄▀ {3}▄ {4}▀▄ {2}▀▀/

describe('Strands intro', () => {
  it('renders STRANDS in compact layouts', () => {
    for (const width of [22, 40]) {
      const styled = renderFrogStartupLockup(width, true, 0, 'green', false, {}, 2)
      const plain = sanitizeTerminalText(styled)
      expect(plain).toMatch(STRANDS_WORDMARK)
    }
  })

  it('shows the frog only beside the wordmark and keeps the wordmark alone when narrower', () => {
    const full = renderFrogStartupLockup(87, false, 0, 'green', false, {}, 12)
    const wordOnly = renderFrogStartupLockup(86, false, 0, 'green', false, {}, 19)
    const small = renderFrogStartupLockup(56, false, 0, 'green', false, {}, 19)

    expect(full).toContain('▄▀▀▀▄')
    expect(wordOnly).toContain('▄▟███▙▄')
    expect(wordOnly).not.toMatch(/[╔╗╚╝║═]/u)
    expect(
      wordOnly
        .split('\n')
        .slice(6)
        .every((row) => !row.trim())
    ).toBe(true)
    expect(small).not.toContain('▄▟███▙▄')
  })

  it('stays inside a 120x35 terminal', () => {
    const width = 120
    const height = 35
    const rows = renderFrogSpiralFrame(width, height, 0.78, 2_496).split('\n')

    expect(rows).toHaveLength(height)
    expect(rows.every((row) => [...row].length === width)).toBe(true)
  })
})
