import { createElement as h } from 'react'
import { Box, render, renderToString } from 'ink'
import chalk from 'chalk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_CHAT_SETTINGS,
  FROG_THEMES,
  THEME_COLOR_KEYS,
  type ChatSettings,
  type ResolvedColorMode,
} from '../src/tui/chat/types.js'
import { Markdown } from '../src/tui/view/markdown.js'
import { MediaView } from '../src/tui/view/media.js'
import { PanelOverlay } from '../src/tui/view/panel-components.js'
import { contextColor, detailLines, permissionLines } from '../src/tui/view/presentation.js'
import { PromptEditor } from '../src/tui/view/prompt-editor.js'
import { SettingsControl } from '../src/tui/view/settings-panel.js'
import { detectColorMode, getTheme, Text, ThemeProvider } from '../src/tui/view/theme.js'
import { ttyInput, ttyOutput } from './fixtures/terminal.js'

const colorLevel = chalk.level

beforeEach(() => {
  chalk.level = 3
})

afterEach(() => {
  chalk.level = colorLevel
  vi.unstubAllEnvs()
})

function settings(colorMode: ChatSettings['colorMode'], frogTheme: ChatSettings['frogTheme'] = 'green'): ChatSettings {
  return { ...DEFAULT_CHAT_SETTINGS, colorMode, frogTheme }
}

function ansi(hex: string, background = false): string {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16))
  return `\u001b[${background ? 48 : 38};2;${channels.join(';')}m`
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
}

describe('theme resolution', () => {
  it.each(FROG_THEMES.filter((name) => name !== 'custom'))('provides readable light and dark colors for %s', (name) => {
    for (const mode of ['light', 'dark'] as const) {
      const theme = getTheme(settings(mode, name))
      expect(theme.mode).toBe(mode)
      for (const key of name === 'green' ? THEME_COLOR_KEYS : (['accent', 'frog'] as const)) {
        expect(theme[key]).toMatch(/^#[\da-f]{6}$/i)
      }
      const textColors =
        name === 'green'
          ? (['foreground', 'muted', 'accent', 'hover', 'success', 'warning', 'error'] as const)
          : (['accent'] as const)
      for (const foreground of textColors) {
        for (const background of ['background', 'surface', 'panel', 'selection'] as const) {
          const light = Math.max(luminance(theme[foreground]), luminance(theme[background]))
          const dark = Math.min(luminance(theme[foreground]), luminance(theme[background]))
          const description = `${name}/${mode}: ${foreground} on ${background}`
          expect((light + 0.05) / (dark + 0.05), description).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })

  it('resolves explicit mode before detection, and supplied detection before COLORFGBG', () => {
    vi.stubEnv('COLORFGBG', '0;15')
    expect(getTheme(settings('auto')).mode).toBe('light')
    expect(getTheme(settings('auto'), 'dark').mode).toBe('dark')
    expect(getTheme(settings('light'), 'dark').mode).toBe('light')
    expect(getTheme(settings('dark'), 'light').mode).toBe('dark')
  })

  it('merges only the active custom variant over its selected base without modifying settings', () => {
    const custom: ChatSettings = {
      ...settings('light', 'custom'),
      customTheme: {
        base: 'merlin',
        light: { foreground: '#123456', accent: '#654321', frog: '#236741' },
        dark: { surface: '#182028', muted: '#b0c0d0' },
      },
    }
    const before = globalThis.structuredClone(custom)
    expect(getTheme(custom)).toEqual({
      ...getTheme(settings('light', 'merlin')),
      ...custom.customTheme.light,
    })
    expect(getTheme({ ...custom, colorMode: 'dark' })).toEqual({
      ...getTheme(settings('dark', 'merlin')),
      ...custom.customTheme.dark,
    })
    expect(custom).toEqual(before)
    expect(getTheme({ ...custom, frogTheme: 'green' })).toEqual(getTheme(settings('light')))
  })

  it('keeps preset mascot colors independent of their UI accent', () => {
    const cyborg = getTheme(settings('dark', 'circuit'))
    expect(cyborg).toMatchObject({ accent: '#79aaff', frog: '#aeb6bf' })
  })
})

describe('terminal background detection', () => {
  it.each([
    ['15;0', 'dark'],
    ['0;default;7', 'light'],
    ['15;16', 'dark'],
    ['0;231', 'light'],
    ['15;232', 'dark'],
    ['0;255', 'light'],
    ['', 'dark'],
    ['garbage', 'dark'],
  ])('resolves COLORFGBG %s to %s', (COLORFGBG, mode) => {
    expect(detectColorMode({ COLORFGBG })).toBe(mode)
  })
})

describe('themed Ink output', () => {
  it('restores the explicit foreground after composer commands', () => {
    const theme = getTheme(settings('light'))
    const input = '/model improve the response'
    const output = renderToString(
      h(ThemeProvider, {
        settings: settings('light'),
        children: h(PromptEditor, {
          input,
          cursor: input.length,
          actionableCommandToken: '/model',
          agentName: 'Strands harness',
        }),
      })
    )
    expect(output).toContain(`${ansi(theme.hover)}/model${ansi(theme.foreground)} improve the respons`)
  })

  it('preserves an explicit text background through nested styles inside a panel', () => {
    const theme = getTheme(settings('light'))
    const output = renderToString(
      h(ThemeProvider, {
        settings: settings('light'),
        children: h(
          Box,
          { backgroundColor: theme.panel },
          h(Text, { backgroundColor: 'red', color: theme.panel }, 'background ', h(Text, { bold: true }, 'child'))
        ),
      })
    )
    expect(output).toContain(`${ansi(theme.error, true)}${ansi(theme.panel)}background \u001b[1mchild`)
  })

  it('preserves inherited styles and semantic colors', () => {
    const theme = getTheme(settings('light'))
    const output = renderToString(
      h(ThemeProvider, {
        settings: settings('light'),
        children: h(
          Box,
          { flexDirection: 'column' },
          h(Text, null, 'plain'),
          h(Text, { color: 'white' }, 'neutral'),
          h(Text, { color: 'red' }, 'parent ', h(Text, { bold: true }, 'nested')),
          h(Text, { color: 'green' }, 'success'),
          h(Text, { color: 'yellow' }, 'warning'),
          h(Text, { color: 'cyan' }, 'accent'),
          h(Text, { color: 'magenta' }, 'hover'),
          h(Text, { color: 'red', dimColor: true }, 'muted')
        ),
      })
    )
    expect(output).toContain(`${ansi(theme.foreground)}plain`)
    expect(output).toContain(`${ansi(theme.foreground)}neutral`)
    expect(output).toContain(`${ansi(theme.error)}parent \u001b[1mnested\u001b[22m`)
    for (const key of ['success', 'warning', 'accent', 'hover', 'muted'] as const) {
      expect(output).toContain(`${ansi(theme[key])}${key}`)
    }
    expect(output).not.toContain('\u001b[2m')
  })

  it('propagates custom colors through child views', () => {
    const custom: ChatSettings = {
      ...settings('light', 'custom'),
      customTheme: {
        base: 'homeland',
        light: { accent: '#284567', surface: '#ddeeff', panel: '#eeddcc', border: '#554433', hover: '#734268' },
        dark: {},
      },
    }
    const theme = getTheme(custom)
    const output = renderToString(
      h(ThemeProvider, {
        settings: custom,
        children: h(
          Box,
          { width: 80, height: 28, flexDirection: 'column' },
          h(Markdown, {
            children: '# Heading **bold**\n\n`code` and [link](https://example.com)\n\n> Quote\n\n- item',
          }),
          h(PromptEditor, { input: 'draft', cursor: 2, agentName: 'Strands harness', width: 60 }),
          h(MediaView, {
            content: { type: 'document', name: 'Notes', format: 'txt', source: { type: 'text', text: 'preview' } },
          }),
          h(PanelOverlay, {
            width: 40,
            children: h(SettingsControl, {
              rowIndex: 0,
              spacious: true,
              control: { kind: 'segmented', options: [{ label: 'Chosen', value: 'chosen', active: true }] },
            }),
          })
        ),
      })
    )
    expect(output).toContain(ansi(theme.accent))
    expect(output).toContain(ansi(theme.foreground))
    expect(output).toContain(ansi(theme.surface, true))
    expect(output).toContain(ansi(theme.panel, true))
    expect(output).not.toContain(ansi(theme.border))
    expect(output).not.toContain(ansi('#202223', true))
    expect(output).not.toContain(ansi('#181a1b', true))
  })

  it('updates mounted memoized content on mode and custom-color changes without querying stdin', async () => {
    const input = ttyInput()
    const output = ttyOutput(80, 24)
    const writes: string[] = []
    output.on('data', (chunk: Buffer) => writes.push(chunk.toString()))
    const child = h(Markdown, { children: '# Stable **heading**' })
    const tree = (mode: ResolvedColorMode, config = settings('auto')) =>
      h(ThemeProvider, { settings: config, detectedMode: mode, children: child })
    const instance = render(tree('dark'), {
      stdin: input,
      stdout: output,
      stderr: output,
      interactive: true,
      patchConsole: false,
      exitOnCtrlC: false,
    })
    try {
      await instance.waitUntilRenderFlush()
      const listenerCount = input.listenerCount('data') + input.listenerCount('readable')
      writes.length = 0
      instance.rerender(tree('light'))
      await instance.waitUntilRenderFlush()
      expect(writes.join('')).toContain(ansi(getTheme(settings('light')).accent))
      writes.length = 0
      instance.rerender(
        tree('light', {
          ...settings('auto', 'custom'),
          customTheme: { base: 'green', light: { accent: '#123456' }, dark: {} },
        })
      )
      await instance.waitUntilRenderFlush()
      expect(writes.join('')).toContain(ansi('#123456'))
      expect(writes.join('')).not.toContain('\u001b]11;?')
      expect(input.listenerCount('data') + input.listenerCount('readable')).toBe(listenerCount)
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
    }
  })

  it('uses the supplied palette for permission, activity, and context colors', () => {
    const palette = getTheme(settings('light', 'merlin'))
    const diff = permissionLines(
      {
        id: 'permission',
        kind: 'permission',
        title: 'Review',
        rows: [],
        diff: {
          path: 'file.ts',
          lines: [
            { kind: 'add', text: 'added' },
            { kind: 'remove', text: 'removed' },
            { kind: 'header', text: 'header' },
          ],
        },
      },
      80,
      palette
    )
    expect(diff.find((line) => line.text.includes('added'))?.color).toBe(palette.success)
    expect(diff.find((line) => line.text.includes('removed'))?.color).toBe(palette.error)
    expect(diff.find((line) => line.text.includes('header'))?.color).toBe(palette.accent)
    const activity = detailLines(
      {
        id: 'task',
        kind: 'detail',
        title: 'Task',
        rows: [],
        activity: {
          toolUseId: 'tool',
          name: 'Strands harness',
          task: 'Work',
          status: 'working',
          entries: [{ type: 'tool', toolUseId: 'read', name: 'read', input: {}, status: 'running' }],
        },
      },
      80,
      palette
    )
    expect(activity.find((line) => line.text.includes('Read'))).toMatchObject({
      color: palette.warning,
      backgroundColor: palette.surface,
    })
    expect(contextColor({ currentTokens: 80, contextWindow: 100 }, palette)).toBe(palette.warning)
    expect(contextColor({ currentTokens: 95, contextWindow: 100 }, palette)).toBe(palette.error)
    expect(contextColor({}, palette)).toBe(palette.accent)
  })
})
