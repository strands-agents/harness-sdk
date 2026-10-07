import { describe, expect, it, vi } from 'vitest'
import { ChatController, DEFAULT_CHAT_SETTINGS, type ChatBackend } from '../src/tui/chat/controller.js'
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
  it('places all theme buttons first', () => {
    const [theme] = settingsRows(DEFAULT_CHAT_SETTINGS)
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
        ],
      },
    })
  })

  it('applies a theme selection', async () => {
    const setSettings = vi.fn(async () => {})
    const controller = new ChatController(backend, { setSettings })
    await controller.submit('/settings')
    expect(await setting(controller, 'frogTheme=solar')).toBe(true)
    expect(setSettings).toHaveBeenCalledWith({ frogTheme: 'solar' })
    expect(controller.getSnapshot().settings.frogTheme).toBe('solar')
    await controller.dispose()
  })

  it.each(['frogTheme=custom', 'frogTheme=%', `customTheme=${encodeURIComponent(JSON.stringify({ base: 'green' }))}`])(
    'rejects unknown appearance input: %s',
    async (value) => {
      const setSettings = vi.fn()
      const controller = new ChatController(backend, { setSettings })
      await controller.submit('/settings')
      const before = globalThis.structuredClone(controller.getSnapshot().settings)
      expect(await setting(controller, value)).toBe(false)
      expect(setSettings).not.toHaveBeenCalled()
      expect(controller.getSnapshot().settings).toEqual(before)
      await controller.dispose()
    }
  )

  it('retains the old settings if persistence fails', async () => {
    const controller = new ChatController(backend, {
      setSettings: async () => {
        throw new Error('Read only')
      },
    })
    await controller.submit('/settings')
    expect(await setting(controller, 'frogTheme=solar')).toBe(false)
    expect(controller.getSnapshot().settings.frogTheme).toBe('green')
    expect(controller.getSnapshot().panel?.kind).toBe('error')
    await controller.dispose()
  })
})
