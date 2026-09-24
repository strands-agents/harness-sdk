import { describe, expect, it, vi } from 'vitest'
import {
  ChatController,
  DEFAULT_CHAT_SETTINGS,
  type ChatBackend,
  type CustomTheme,
} from '../src/tui/chat/controller.js'
import { settingsRows } from '../src/tui/chat/panels.js'

const backend: ChatBackend = {
  id: 'appearance-test',
  name: 'Test',
  protocol: 'strands',
  stream: async function* () {
    yield* []
    return { stopReason: 'endTurn' }
  },
  cancel: () => {},
}

function setting(controller: ChatController, value: string): Promise<boolean> {
  return controller.activatePanelRow({ label: '', description: '', value })
}

describe('appearance settings controller', () => {
  it('places color mode and all theme buttons first', () => {
    const [mode, theme] = settingsRows(DEFAULT_CHAT_SETTINGS)
    expect(mode).toMatchObject({
      label: 'Color mode',
      value: 'colorMode',
      section: 'Appearance',
      control: {
        kind: 'segmented',
        options: [
          { label: 'Auto', value: 'auto', active: true },
          { label: 'Light', value: 'light' },
          { label: 'Dark', value: 'dark' },
        ],
      },
    })
    expect(theme).toMatchObject({
      label: 'Theme',
      description: 'Classic',
      value: 'frogTheme',
      section: 'Appearance',
      control: {
        kind: 'segmented',
        options: [
          { label: 'Classic', value: 'green', active: true },
          { label: 'Minimal', value: 'minimal' },
          { label: 'Homeland', value: 'homeland' },
          { label: 'Merlin', value: 'merlin' },
          { label: 'Kikker', value: 'kikker' },
          { label: 'Cyborg', value: 'circuit' },
          { label: 'Spectre', value: 'spectre' },
          { label: 'Solar', value: 'solar' },
          { label: 'Custom', value: 'custom' },
        ],
      },
    })
  })

  it('persists a selected color mode through the existing row flow', async () => {
    const colorMode = 'light'
    const setSettings = vi.fn(async () => {})
    const controller = new ChatController(backend, { setSettings })
    await controller.submit('/settings')
    expect(await setting(controller, `colorMode=${colorMode}`)).toBe(true)
    expect(setSettings).toHaveBeenCalledWith({ colorMode })
    expect(controller.getSnapshot().settings.colorMode).toBe(colorMode)
    await controller.dispose()
  })

  it('atomically selects custom colors and isolates nested state from callers and snapshots', async () => {
    const customTheme: CustomTheme = { base: 'merlin', light: { accent: '#123456' }, dark: { frog: '#abcdef' } }
    const setSettings = vi.fn(async () => {})
    const controller = new ChatController(backend, { settings: { customTheme }, setSettings })
    customTheme.light.accent = '#000000'
    expect(controller.getSnapshot().settings.customTheme.light.accent).toBe('#123456')
    await controller.submit('/settings')
    expect(await setting(controller, `customTheme=${encodeURIComponent(JSON.stringify(customTheme))}`)).toBe(true)
    expect(setSettings).toHaveBeenCalledWith({ frogTheme: 'custom', customTheme })
    controller.getSnapshot().settings.customTheme.dark.frog = '#000000'
    await setting(controller, 'colorMode=dark')
    expect(controller.getSnapshot().settings.customTheme.dark.frog).toBe('#abcdef')
    expect(controller.getSnapshot().settings.frogTheme).toBe('custom')
    expect(DEFAULT_CHAT_SETTINGS.customTheme).toEqual({ base: 'green', light: {}, dark: {} })
    await controller.dispose()
  })

  it.each([
    'colorMode=system',
    'customTheme=%',
    `customTheme=${encodeURIComponent(JSON.stringify({ base: 'green', light: {}, dark: { accent: 'red' } }))}`,
  ])('rejects malformed appearance input: %s', async (value) => {
    const setSettings = vi.fn()
    const controller = new ChatController(backend, { setSettings })
    await controller.submit('/settings')
    const before = globalThis.structuredClone(controller.getSnapshot().settings)
    expect(await setting(controller, value)).toBe(false)
    expect(setSettings).not.toHaveBeenCalled()
    expect(controller.getSnapshot().settings).toEqual(before)
    await controller.dispose()
  })

  it('retains the old settings if persistence fails', async () => {
    const controller = new ChatController(backend, {
      setSettings: async () => {
        throw new Error('Read only')
      },
    })
    await controller.submit('/settings')
    expect(
      await setting(controller, `customTheme=${encodeURIComponent(JSON.stringify(DEFAULT_CHAT_SETTINGS.customTheme))}`)
    ).toBe(false)
    expect(controller.getSnapshot().settings.frogTheme).toBe('green')
    expect(controller.getSnapshot().panel?.kind).toBe('error')
    await controller.dispose()
  })
})
