import { createElement } from 'react'
import { render, type Instance } from 'ink'
import stringWidth from 'string-width'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChatController, type ChatBackend, type ChatControllerApi } from '../src/tui/chat/controller.js'
import { ConversationManager } from '../src/tui/session/conversations.js'
import { sanitizeTerminalText } from '../src/tui/terminal/sanitize.js'
import { ChatApp } from '../src/tui/view/app.js'
import { ttyInput, ttyOutput } from './fixtures/terminal.js'

const mounted: { instance: Instance; controller: ChatControllerApi }[] = []
const terminalSizes = [
  [120, 40],
  [40, 16],
  [80, 24],
] as const

afterEach(async () => {
  for (const { instance, controller } of mounted.splice(0)) {
    instance.unmount()
    await instance.waitUntilExit()
    await controller.dispose()
  }
})

function createController() {
  const switchModel = vi.fn(async (_model: string) => {})
  const setEffort = vi.fn(async (_effort: string) => {})
  const backend: ChatBackend = {
    id: 'panel-resize-test',
    name: 'Strands harness',
    protocol: 'strands',
    async *stream() {
      yield* []
      return { stopReason: 'endTurn' }
    },
    cancel() {},
    info: () => ({ model: 'model-00' }),
    listModels: () =>
      Array.from({ length: 20 }, (_, index) => ({
        id: `model-${String(index).padStart(2, '0')}`,
        name: `Model ${String(index).padStart(2, '0')}`,
        description: '',
        catalog: 'openai',
        active: index === 0,
      })),
    listEfforts: () => ['low', 'medium', 'high'].map((id) => ({ id, label: id, active: id === 'medium' })),
    modelChangeMode: () => 'live',
    switchModel,
    setEffort,
  }
  const controller = new ChatController(backend, {
    settings: { animations: false, colorMode: 'light' },
    runtime: { model: 'model-00', cwd: '/work' },
  })
  return { controller, switchModel, setEffort }
}

async function mount(controller: ChatControllerApi) {
  const input = ttyInput()
  const output = ttyOutput(120, 40)
  let frame = ''
  output.on('data', (chunk: Buffer) => {
    if (chunk.toString().includes('\n')) frame = sanitizeTerminalText(chunk.toString())
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
  await instance.waitUntilRenderFlush()
  const press = async (key: string): Promise<void> => {
    input.write(key)
    await instance.waitUntilRenderFlush()
  }
  return {
    screen: (): string => frame,
    point: (text: string): { column: number; row: number } => {
      const lines = frame.split('\n')
      const row = lines.findIndex((line) => line.includes(text))
      expect(row, `Visible target: ${text}`).toBeGreaterThanOrEqual(0)
      return { column: stringWidth(lines[row]!.slice(0, lines[row]!.indexOf(text))) + 1, row: row + 1 }
    },
    pointOnRow: (rowText: string, targetText: string): { column: number; row: number } => {
      const lines = frame.split('\n')
      const row = lines.findIndex((line) => line.includes(rowText))
      expect(row, `Visible row: ${rowText}`).toBeGreaterThanOrEqual(0)
      const column = lines[row]!.indexOf(targetText, lines[row]!.indexOf(rowText) + rowText.length)
      expect(column, `Visible target on ${rowText}: ${targetText}`).toBeGreaterThanOrEqual(0)
      return { column: stringWidth(lines[row]!.slice(0, column)) + 1, row: row + 1 }
    },
    press,
    click: async ({ column, row }: { column: number; row: number }): Promise<void> => {
      await press(`\u001b[<0;${column};${row}M`)
      await press(`\u001b[<0;${column};${row}m`)
    },
    resize: async (columns: number, rows: number): Promise<void> => {
      output.columns = columns
      output.rows = rows
      output.emit('resize')
      await instance.waitUntilRenderFlush()
    },
    fits: (): void => {
      const lines = frame.trimEnd().split('\n')
      expect(lines.length).toBeLessThanOrEqual(output.rows)
      expect(lines.every((line) => stringWidth(line) <= output.columns)).toBe(true)
    },
  }
}

describe('mounted panel resizing', () => {
  it('keeps the selected setting visible and preserves the composer draft', async () => {
    const { controller } = createController()
    const view = await mount(controller)
    await view.press('keep this draft')
    await controller.submit('/settings')
    await vi.waitFor(() => expect(view.screen()).toContain('Auto-Discovery'))
    for (let index = 0; index < 2; index++) await view.press('\t')
    await vi.waitFor(() => expect(view.screen()).toContain('Usage ping (telemetry)'))
    await view.press('\u001b[B')

    for (const [width, height] of terminalSizes) {
      await view.resize(width, height)
      await vi.waitFor(() => {
        view.fits()
        expect(view.screen()).toContain('Usage ping')
        expect(view.screen()).toContain('(telemetry)')
        expect(view.screen()).toContain('Esc back')
        expect(view.screen()).toContain('/help')
      })
    }
    await view.press('\r')
    await vi.waitFor(() => expect(controller.getSnapshot().settings.telemetry).toBe(false))
    await view.press('\u001b')
    await vi.waitFor(() => expect(controller.getSnapshot().panel).toBeUndefined())
    await controller.submit('/settings')
    await view.press('\t')
    await vi.waitFor(() => expect(view.screen()).toContain('Skills'))
    await view.click(view.pointOnRow('Skills', 'Off'))
    await vi.waitFor(() => expect(controller.getSnapshot().settings.skillDiscovery).toBe(true))
    await view.press('\u001b')
    await vi.waitFor(() => expect(controller.getSnapshot().panel).toBeUndefined())
    await vi.waitFor(() => expect(view.screen()).toContain('keep this draft'))
  })

  it('keeps the selected model, panel footer and composer help visible after shrinking and expanding', async () => {
    const { controller, switchModel, setEffort } = createController()
    const view = await mount(controller)
    await controller.submit('/model')
    await vi.waitFor(() => expect(view.screen()).toContain('Model 00'))
    for (let index = 0; index < 8; index++) await view.press('\u001b[B')

    for (const [width, height] of terminalSizes) {
      await view.resize(width, height)
      await vi.waitFor(() => {
        view.fits()
        expect(view.screen()).toContain('Model 08')
        expect(view.screen()).toContain('Esc back')
        const lines = view.screen().split('\n')
        expect(lines.findIndex((line) => line.includes('Esc back'))).toBeLessThan(
          lines.findIndex((line) => line.includes('/help'))
        )
      })
    }
    const lines = view.screen().split('\n')
    const trackRow = lines.findIndex((line) => line.includes('███'))
    expect(trackRow).toBeGreaterThanOrEqual(0)
    await view.click({ column: lines[trackRow]!.lastIndexOf('─') + 1, row: trackRow + 1 })
    await vi.waitFor(() => expect(setEffort).toHaveBeenCalledWith('high'))
    await view.click(view.point('Model 08'))
    await vi.waitFor(() => expect(switchModel).toHaveBeenCalledWith('model-08'))
  })

  it('reveals the selected agent when the grid column count changes', async () => {
    const manager = new ConversationManager(createController().controller, {
      fork: async () => createController().controller,
    })
    const view = await mount(manager)
    for (let index = 0; index < 8; index++) await manager.submit('/fork')
    await manager.submit('/agents')
    const selected = manager.getSnapshot().panel!.rows.at(-1)!
    await vi.waitFor(() => expect(view.screen()).toContain(selected.label))
    await view.press('\u001b[F')

    for (const [width, height] of terminalSizes) {
      await view.resize(width, height)
      await vi.waitFor(() => {
        view.fits()
        expect(view.screen()).toContain('9/9')
        expect(view.screen()).toContain(selected.label)
        expect(view.screen()).not.toContain('╔')
      })
    }
    await view.press('\r')
    await vi.waitFor(() => expect(manager.getSnapshot().panel).toBeUndefined())
    await manager.submit('/agents')
    expect(manager.getSnapshot().panel?.rows.find((row) => row.current)?.value).toBe(selected.value)
  })

  it('blocks covered metadata while retaining visible metadata and footer actions', async () => {
    const { controller } = createController()
    const view = await mount(controller)
    await view.resize(40, 16)
    await vi.waitFor(() => view.fits())
    const modelTarget = view.point('model-00')
    controller.openContextPanel()
    await vi.waitFor(() => expect(view.screen()).toContain('Context usage'))
    const covered = { column: modelTarget.column + 4, row: modelTarget.row }
    expect(view.screen().split('\n')[covered.row - 1]).not.toContain('model-00')
    const panelId = controller.getSnapshot().panel!.id
    await view.click(covered)
    expect(controller.getSnapshot().panel?.id).toBe(panelId)

    await view.resize(160, 40)
    await vi.waitFor(() => expect(view.screen()).toContain('model-00'))
    await view.click(view.point('model-00'))
    await vi.waitFor(() => expect(controller.getSnapshot().panel?.kind).toBe('models'))
    await view.click(view.point('context ░'))
    await vi.waitFor(() => expect(controller.getSnapshot().panel?.kind).toBe('context'))
    await view.click(view.point('/help'))
    expect(controller.getSnapshot().panel).toBeUndefined()
    await view.click(view.point('/help'))
    await vi.waitFor(() => expect(controller.getSnapshot().panel?.kind).toBe('help'))
  })
})
