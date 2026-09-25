import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { render, type Instance } from 'ink'
import chalk from 'chalk'
import stringWidth from 'string-width'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatController, type ChatBackend, type ChatSettings } from '../src/tui/chat/controller.js'
import { CliConfigStore } from '../src/tui/config.js'
import { sanitizeTerminalText } from '../src/tui/terminal/sanitize.js'
import { ChatApp } from '../src/tui/view/app.js'
import { ttyInput, ttyOutput } from './fixtures/terminal.js'

const mounted: { instance: Instance; controller: ChatController }[] = []
const directories: string[] = []
const colorLevel = chalk.level

beforeEach(() => {
  chalk.level = 3
  vi.stubEnv('COLORFGBG', '15;0')
})

afterEach(async () => {
  for (const { instance, controller } of mounted.splice(0)) {
    instance.unmount()
    await instance.waitUntilExit()
    await controller.dispose()
  }
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  chalk.level = colorLevel
  vi.unstubAllEnvs()
})

async function openPicker(
  columns: number,
  config = CliConfigStore.memory({}, { animations: false, colorMode: 'auto' })
) {
  const backend: ChatBackend = {
    id: 'appearance-picker-test',
    name: 'Strands harness',
    protocol: 'strands',
    async *stream() {
      yield* []
      return { stopReason: 'endTurn' }
    },
    cancel() {},
  }
  const setSettings = vi.fn((settings: Partial<ChatSettings>) => config.setSettings(settings))
  const controller = new ChatController(backend, { settings: config.snapshot().settings, setSettings })
  await controller.submit('/settings')
  const input = ttyInput()
  const output = ttyOutput(columns, 24)
  let frame = ''
  output.on('data', (chunk: Buffer) => {
    if (chunk.toString().includes('\n')) frame = chunk.toString()
  })
  const instance = render(createElement(ChatApp, { controller }), {
    stdin: input,
    stdout: output,
    stderr: output,
    interactive: true,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  })
  mounted.push({ instance, controller })
  const screen = (): string => sanitizeTerminalText(frame)
  const point = (label: string): { column: number; row: number } => {
    const lines = screen().split('\n')
    const row = lines.findIndex((line) => line.includes(label))
    expect(row, `Visible target: ${label}`).toBeGreaterThanOrEqual(0)
    return { column: stringWidth(lines[row]!.slice(0, lines[row]!.indexOf(label))) + 1, row: row + 1 }
  }
  const palettePoint = (): { column: number; row: number } => {
    const lines = screen().split('\n')
    let row = -1
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index]!.includes('◆')) {
        row = index
        break
      }
    }
    expect(row, 'Selected palette swatch').toBeGreaterThanOrEqual(0)
    const column = stringWidth(lines[row]!.slice(0, lines[row]!.indexOf('◆'))) + 1
    return { column, row: row + 1 }
  }
  const press = async (key: string): Promise<void> => {
    input.write(key)
    await instance.waitUntilRenderFlush()
  }
  const click = async ({ column, row }: { column: number; row: number }): Promise<void> => {
    await press(`\u001b[<0;${column};${row}M`)
    await press(`\u001b[<0;${column};${row}m`)
  }
  const hover = async ({ column, row }: { column: number; row: number }): Promise<void> => {
    await press(`\u001b[<32;${column};${row}M`)
  }
  const layout = (): void => {
    const lines = screen().split('\n')
    expect(lines).toHaveLength(24)
    expect(lines.every((line) => stringWidth(line) <= columns)).toBe(true)
  }
  await instance.waitUntilRenderFlush()
  await click(point('Appearance'))
  await vi.waitFor(() => expect(screen()).toContain('Custom'))
  await click(point('Custom'))
  await vi.waitFor(() => expect(screen()).toContain('Customize theme'))
  return { controller, setSettings, screen, point, palettePoint, press, click, hover, layout }
}

describe('mounted custom theme editor', () => {
  it('navigates roles and swatches by keyboard and preserves Auto mode on apply', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-picker-'))
    directories.push(directory)
    const path = join(directory, 'config.json')
    const config = await CliConfigStore.load(path)
    await config.setSettings({
      animations: false,
      colorMode: 'auto',
      frogTheme: 'custom',
      customTheme: { base: 'homeland', light: { frog: '#246810' }, dark: { frog: '#345678' } },
    })
    const initial = globalThis.structuredClone(config.snapshot().settings)
    const picker = await openPicker(40, config)
    await picker.press('\u001b[Z')
    await picker.press('\u001b[Z')
    await picker.press('\u001b[Z')
    await picker.press('\u001b[Z')
    await picker.press('\u001b[C')
    expect(picker.screen()).toContain('Merlin')
    await picker.press('\t')
    await picker.press('\u001b[D')
    expect(picker.screen()).toContain('Editing light colors')
    await picker.press('\t')
    await picker.press('\u001b[C')
    expect(picker.screen()).toContain('Hover')
    await picker.press('\t')
    await picker.press('\u001b[C')
    await picker.press('\t')
    await picker.press('\u001b[C')
    expect(config.snapshot().settings).toEqual(initial)
    expect(picker.setSettings).not.toHaveBeenCalled()
    await picker.press('\t')
    await picker.press('\t')
    await picker.press('\t')
    picker.layout()
    await picker.press('\r')
    await vi.waitFor(() => expect(picker.screen()).not.toContain('Customize theme'))
    expect(picker.setSettings).toHaveBeenCalledTimes(1)

    const reloaded = await CliConfigStore.load(path)
    expect(reloaded.snapshot().settings).toEqual({
      ...initial,
      customTheme: {
        base: 'merlin',
        dark: { frog: '#345678' },
        light: { frog: '#246810', hover: expect.stringMatching(/^#[\da-f]{6}$/u) },
      },
    })
  })

  it.each([40, 80])('supports hover and click across the responsive %s×24 layout', async (columns) => {
    const config = CliConfigStore.memory({}, { animations: false, frogTheme: 'custom', colorMode: 'dark' })
    const picker = await openPicker(columns, config)
    picker.layout()
    const selected = picker.palettePoint()
    await picker.hover({ column: selected.column + 3, row: selected.row })
    expect(picker.screen()).toContain('◇')
    await picker.click({ column: selected.column + 3, row: selected.row })
    await picker.click(picker.point('Light'))
    expect(picker.screen()).toContain('Editing light colors')
    await picker.click(picker.point('Apply theme'))
    await vi.waitFor(() => expect(picker.screen()).not.toContain('Customize theme'))
    expect(config.snapshot().settings.colorMode).toBe('dark')
    expect(config.snapshot().settings.customTheme.dark.accent).toMatch(/^#[\da-f]{6}$/u)
  })
})
