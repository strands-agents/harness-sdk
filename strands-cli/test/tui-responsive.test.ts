import { createElement, type ReactElement } from 'react'
import { render, type Instance } from 'ink'
import stringWidth from 'string-width'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChatController, type ChatBackend } from '../src/tui/chat/controller.js'
import { CliConfigStore } from '../src/tui/config.js'
import { sanitizeTerminalText } from '../src/tui/terminal/sanitize.js'
import { ChatApp } from '../src/tui/view/app.js'
import { DnaVortexIntro } from '../src/tui/view/intro.js'
import { frogStartupHeight, renderFrogStartupLockup } from '../src/tui/view/frog-intro-renderer.js'
import { SetupWizard } from '../src/tui/view/setup-wizard/index.js'
import { ttyInput, ttyOutput } from './fixtures/terminal.js'

// Colored output paints solid cells as backgrounds, leaving only the half-block glyphs as text.
const STRANDS_WORDMARK = /STRANDS|╔════╝|█▀▀ ▀█▀ █▀█ ▄▀█ █▄ █ █▀▄ █▀▀|▀▀ ▀ ▀ {2}▀ {2}▄▀ {3}▄ {4}▀▄ {2}▀▀/

const instances: Instance[] = []
const controllers: ChatController[] = []

afterEach(async () => {
  for (const instance of instances.splice(0)) {
    instance.unmount()
    await instance.waitUntilExit()
  }
  await Promise.all(controllers.splice(0).map((controller) => controller.dispose()))
})

function controller(): ChatController {
  const backend: ChatBackend = {
    id: 'responsive-test',
    name: 'Strands harness',
    protocol: 'strands',
    stream: async function* () {
      yield* []
      return { stopReason: 'endTurn' }
    },
    cancel() {},
  }
  const result = new ChatController(backend, {
    settings: { animations: false },
  })
  controllers.push(result)
  return result
}

async function mount(element: ReactElement, columns: number, rows: number) {
  const input = ttyInput()
  const output = ttyOutput(columns, rows)
  let frame = ''
  output.on('data', (chunk: Buffer) => {
    if (chunk.toString().includes('\n')) frame = sanitizeTerminalText(chunk.toString())
  })
  const instance = render(element, {
    stdin: input,
    stdout: output,
    stderr: output,
    interactive: true,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  })
  instances.push(instance)
  await instance.waitUntilRenderFlush()
  return {
    input,
    instance,
    screen: (): string => frame,
    fits: (): void => {
      const lines = frame.trimEnd().split('\n')
      expect(lines.length).toBeLessThanOrEqual(output.rows)
      expect(lines.every((line) => stringWidth(line) <= output.columns)).toBe(true)
    },
    resize: async (nextColumns: number, nextRows: number): Promise<void> => {
      output.columns = nextColumns
      output.rows = nextRows
      output.emit('resize')
      await instance.waitUntilRenderFlush()
    },
  }
}

describe('responsive welcome art', () => {
  it.each([
    [120, 35, 12],
    [80, 34, 6],
    [73, 34, 6],
    [64, 34, 2],
    [120, 20, 8],
    [80, 19, 6],
    [40, 11, 2],
    [22, 8, 1],
    [80, 4, 1],
  ])('fits %s columns and %s available rows into %s art rows', (width, available, height) => {
    expect(frogStartupHeight(width, available)).toBe(height)
    const art = renderFrogStartupLockup(width, false, 0, 'green', false, {}, height)
    const lines = art.split('\n')
    expect(lines).toHaveLength(height)
    expect(lines.every((line) => stringWidth(line) === width)).toBe(true)
    if (height < 12) {
      expect(art).toMatch(STRANDS_WORDMARK)
    }
  })

  it('shrinks and restores the welcome banner while retaining the composer draft', async () => {
    const view = await mount(createElement(ChatApp, { controller: controller() }), 120, 40)
    expect(view.screen()).toContain('╔')
    view.input.write('keep this draft')
    await view.instance.waitUntilRenderFlush()

    for (const [columns, rows] of [
      [80, 24],
      [40, 16],
      [22, 10],
      [120, 40],
    ] as const) {
      await view.resize(columns, rows)
      await vi.waitFor(() => {
        view.fits()
        expect(view.screen().replace(/\s/g, '')).toContain('keepthisdraft')
        expect(view.screen()).toContain('/help')
        if (rows < 30) {
          expect(view.screen()).toMatch(STRANDS_WORDMARK)
        } else {
          expect(view.screen()).toContain('╔')
        }
      })
    }
  })

  it('skips the intro when the full frog does not fit', async () => {
    const complete = vi.fn()
    const view = await mount(createElement(DnaVortexIntro, { ready: false, onComplete: complete }), 40, 16)

    await vi.waitFor(() => expect(complete).toHaveBeenCalledWith(0))
    expect(view.screen()).toBe('')
  })

  it('renders the intro while the full frog fits and skips it after a compact resize', async () => {
    const complete = vi.fn()
    const view = await mount(createElement(DnaVortexIntro, { ready: false, onComplete: complete }), 120, 40)
    const hint = '[ space to skip ]'
    const rows = view.screen().split('\n')
    const hintRow = rows.findIndex((row) => row.includes(hint))
    const hintColumn = rows[hintRow]!.indexOf(hint)

    expect(hintRow).toBe(rows.length - 1)
    expect(Math.abs(hintColumn + hint.length / 2 - 60)).toBeLessThanOrEqual(1)
    expect(complete).not.toHaveBeenCalled()

    await view.resize(40, 16)
    await vi.waitFor(() => expect(complete).toHaveBeenCalledWith(0))
  })

  it('keeps setup choices visible in a narrow window and after resizing', async () => {
    const view = await mount(
      createElement(SetupWizard, { config: CliConfigStore.memory(), onComplete: () => {}, onCancel: () => {} }),
      40,
      40
    )
    expect(view.screen()).toMatch(STRANDS_WORDMARK)
    for (const [columns, rows] of [
      [40, 16],
      [120, 40],
      [40, 24],
    ] as const) {
      await view.resize(columns, rows)
      await vi.waitFor(() => {
        view.fits()
        for (const choice of ['Quickstart', 'Customize', 'Import']) {
          expect(view.screen()).toContain(choice)
        }
        expect(view.screen()).toContain('Shift+Tab')
        expect(view.screen()).toMatch(/[Cc]lick/)
        expect(view.screen()).toContain('↑↓')
      })
    }
  })
})
