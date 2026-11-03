import { describe, expect, it, vi } from 'vitest'
import { ChatController } from '../../src/ui/chat/controller.js'
import { type ChatBackend } from '../../src/agent/types.js'

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
  it('applies a theme selection', async () => {
    const setSettings = vi.fn(async () => {})
    const controller = new ChatController(backend, { setSettings })
    await controller.submit('/settings')
    expect(await setting(controller, 'frogTheme=oak')).toBe(true)
    expect(setSettings).toHaveBeenCalledWith({ frogTheme: 'oak' })
    expect(controller.getSnapshot().settings.frogTheme).toBe('oak')
    await controller.dispose()
  })

  it.each(['frogTheme=missing', 'frogTheme=%', 'frogTheme=oak=extra'])(
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
    expect(await setting(controller, 'frogTheme=scarlet')).toBe(false)
    expect(controller.getSnapshot().settings.frogTheme).toBe('green')
    expect(controller.getSnapshot().panel?.kind).toBe('error')
    await controller.dispose()
  })
})
