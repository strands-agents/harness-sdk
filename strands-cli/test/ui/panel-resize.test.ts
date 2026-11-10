import { createElement } from 'react'
import type { Instance } from 'ink'
import stringWidth from 'string-width'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChatController, type ChatControllerApi, type ChatPanel } from '../../src/ui/chat/controller.js'
import type { ChatControllerOptions } from '../../src/ui/chat/types.js'
import { type ChatBackend } from '../../src/agent/types.js'
import { ConversationManager } from '../../src/ui/chat/conversations.js'
import { sanitizeTerminalText } from '../../src/terminal/text.js'
import { ChatApp } from '../../src/ui/chat/screen.js'
import type { SettingsUpdateStatus } from '../../src/ui/chat/panel-state.js'
import { render, ttyInput, ttyOutput } from '../fixtures/terminal.js'

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

function createController(options: Pick<ChatControllerOptions, 'requestSetup' | 'awsProfile'> = {}) {
  const switchModel = vi.fn(async (_model: string) => {})
  const backend: ChatBackend = {
    id: 'panel-resize-test',
    name: 'Strands harness',
    protocol: 'strands',
    async *stream() {
      yield* []
      return { stopReason: 'endTurn', context: {} }
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
    modelChangeMode: () => 'live',
    switchModel,
  }
  const controller = new ChatController(backend, {
    settings: { animations: false },
    runtime: { model: 'model-00', cwd: '/work' },
    ...options,
  })
  return { controller, switchModel }
}

async function mount(
  controller: ChatControllerApi,
  options: {
    availableUpdate?: string
    updateStatus?: SettingsUpdateStatus
    developmentCheckout?: boolean
    onRequestUpdate?: () => void
  } = {}
) {
  const input = ttyInput()
  const output = ttyOutput(120, 40)
  let frame = ''
  output.on('data', (chunk: Buffer) => {
    if (chunk.toString().includes('\n')) frame = sanitizeTerminalText(chunk.toString())
  })
  const instance = render(createElement(ChatApp, { controller, ...options }), {
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
  it('keeps voice controls focused across clicks, sections, scrolling, and resize', async () => {
    const { controller } = createController()
    const panel: ChatPanel = {
      id: 'voice',
      kind: 'voice',
      title: 'Voice',
      rows: [
        {
          label: 'Voice',
          description: 'off',
          value: 'voice:enabled',
          control: {
            kind: 'segmented',
            options: [
              { label: 'Off', value: 'off', active: true },
              { label: 'On', value: 'on', active: false },
            ],
          },
        },
        {
          label: 'provider',
          description: 'Nova',
          value: 'voice:provider',
          section: 'Voice',
          control: {
            kind: 'segmented',
            options: [
              { label: 'Nova', value: 'bedrock', active: true },
              { label: 'OpenAI', value: 'openai' },
            ],
          },
        },
        {
          label: 'Nova 2.5 Sonic',
          description: 'amazon.nova-2-5-sonic',
          value: 'voice:model=amazon.nova-2-5-sonic',
          section: 'Model',
        },
        ...[
          ['English (US)', 'tiffany', 'matthew'],
          ['French', 'ambre', 'florian'],
          ['Italian', 'beatrice', 'lorenzo'],
          ['German', 'greta', 'lennart'],
        ].map(([label, first, second]) => ({
          label: label!,
          description: `${first} / ${second}`,
          value: 'voice:voice',
          section: 'Voice',
          control: {
            kind: 'segmented' as const,
            options: [
              { label: first!, value: first! },
              { label: second!, value: second! },
            ],
          },
        })),
        {
          label: 'end of turn',
          description: 'patient',
          value: 'voice:endpointing',
          section: 'Listening',
          control: {
            kind: 'segmented',
            options: [
              { label: 'Fast', value: 'HIGH' },
              { label: 'Balanced', value: 'MEDIUM' },
              { label: 'Patient', value: 'LOW', active: true },
            ],
          },
        },
      ],
    }
    let current = { ...controller.getSnapshot(), panel }
    const listeners = new Set<() => void>()
    vi.spyOn(controller, 'getSnapshot').mockImplementation(() => current)
    vi.spyOn(controller, 'subscribe').mockImplementation((listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    })
    const activate = vi.spyOn(controller, 'activatePanelRow').mockImplementation(async (selected) => {
      const [action, value] = selected.value!.split('=')
      const rows = current.panel.rows.map((row) => {
        if (row.value !== action || row.control?.kind !== 'segmented') return row
        const control = {
          ...row.control,
          options: row.control.options.map((option) => ({ ...option, active: option.value === value })),
        }
        return { ...row, control }
      })
      current = { ...current, panel: { ...current.panel, rows } }
      for (const listener of listeners) listener()
      return true
    })
    const view = await mount(controller)
    await view.click(view.point('On'))
    expect(activate).toHaveBeenLastCalledWith(expect.objectContaining({ value: 'voice:enabled=on' }))
    const enabledCalls = activate.mock.calls.length
    await view.click(view.point('On'))
    expect(activate).toHaveBeenCalledTimes(enabledCalls)
    await view.press('\u001b[D')
    expect(activate).toHaveBeenLastCalledWith(expect.objectContaining({ value: 'voice:enabled=off' }))
    const disabledCalls = activate.mock.calls.length
    await view.press('\u001b[D')
    expect(activate).toHaveBeenCalledTimes(disabledCalls)

    await view.click(view.pointOnRow('Provider', 'Nova'))
    await view.press('\u001b[C')
    expect(activate).toHaveBeenLastCalledWith(expect.objectContaining({ value: 'voice:provider=openai' }))

    const providerCalls = activate.mock.calls.length
    await view.click(view.point('Off'))
    expect(activate).toHaveBeenCalledTimes(providerCalls)
    await view.press('\u001b[C')
    expect(activate).toHaveBeenLastCalledWith(expect.objectContaining({ value: 'voice:enabled=on' }))
    await view.press('\u001b[D')

    await view.press('\t')
    await view.press('\u001b[B')
    await view.press('\r')
    expect(activate).toHaveBeenLastCalledWith(expect.objectContaining({ value: 'voice:model=amazon.nova-2-5-sonic' }))
    await view.press('\u001b[Z')
    const provider = view.point('Provider')
    await view.press(`\u001b[<65;${provider.column};${provider.row}M`)
    await view.press('\r')
    expect(activate).toHaveBeenLastCalledWith(expect.objectContaining({ value: 'voice:model=amazon.nova-2-5-sonic' }))

    await view.press('\u001b[F')
    expect(view.screen()).toContain('German')
    await view.click(view.point('lennart'))
    expect(activate).toHaveBeenLastCalledWith(expect.objectContaining({ value: 'voice:voice=lennart' }))
    await view.click(view.point('greta'))
    expect(activate).toHaveBeenLastCalledWith(expect.objectContaining({ value: 'voice:voice=greta' }))
    await view.resize(40, 14)
    await vi.waitFor(() => {
      view.fits()
      expect(view.screen()).toContain('DE')
      expect(view.screen()).toContain('greta')
    })
    const german = view.point('DE')
    await view.press(`\u001b[<64;${german.column};${german.row}M`)
    await view.press('\u001b[C')
    expect(activate).toHaveBeenLastCalledWith(expect.objectContaining({ value: 'voice:voice=lorenzo' }))
    expect(view.screen()).toContain('IT')
    view.fits()
  })

  it('updates Strands CLI from Settings', async () => {
    const onRequestUpdate = vi.fn()
    const { controller } = createController()
    const view = await mount(controller, {
      availableUpdate: '0.2.1',
      updateStatus: 'available',
      developmentCheckout: false,
      onRequestUpdate,
    })

    await controller.submit('/settings')
    await vi.waitFor(() => expect(view.screen()).toContain('› Appearance'))
    for (let index = 0; index < 3; index++) await view.press('\u001b[B')
    await vi.waitFor(() => expect(view.screen()).toContain('0.0.1-development (update available!)'))
    await view.click(view.pointOnRow('CLI version', '0.0.1-development (update available!)'))
    await vi.waitFor(() => expect(view.screen()).toContain('Update available'))
    await view.press('\r')

    expect(onRequestUpdate).toHaveBeenCalledOnce()
  })

  it('keeps development update checks inside Settings', async () => {
    const onRequestUpdate = vi.fn()
    const { controller } = createController()
    const view = await mount(controller, {
      availableUpdate: '9.9.9',
      updateStatus: 'development',
      developmentCheckout: true,
      onRequestUpdate,
    })

    await controller.submit('/settings')
    for (let index = 0; index < 3; index++) await view.press('\u001b[B')
    await vi.waitFor(() => expect(view.screen()).toContain('Development Checkout'))
    expect(controller.getSnapshot().panel?.kind).toBe('settings')
    expect(view.screen()).not.toContain('↑ Update')
    expect(onRequestUpdate).not.toHaveBeenCalled()
  })

  it('reports a current installation without closing Settings', async () => {
    const onRequestUpdate = vi.fn()
    const { controller } = createController()
    const view = await mount(controller, {
      updateStatus: 'current',
      developmentCheckout: false,
      onRequestUpdate,
    })

    await controller.submit('/settings')
    for (let index = 0; index < 3; index++) await view.press('\u001b[B')
    await view.click(view.pointOnRow('CLI version', '0.0.1-development (latest)'))

    await vi.waitFor(() => expect(view.screen()).toContain('0.0.1-development (latest)'))
    expect(controller.getSnapshot().panel?.kind).toBe('settings')
    expect(onRequestUpdate).not.toHaveBeenCalled()
  })

  it('opens setup from the Agent settings action', async () => {
    const requestSetup = vi.fn()
    const { controller } = createController({ requestSetup })
    const view = await mount(controller)

    await controller.submit('/settings')
    await view.press('\u001b[B')
    await vi.waitFor(() => expect(view.screen()).toContain('Open setup'))
    await view.click(view.pointOnRow('Providers & default agent', 'Open setup'))

    expect(requestSetup).toHaveBeenCalledOnce()
  })

  it('keeps the selected setting visible and preserves the composer draft', async () => {
    const { controller } = createController()
    const view = await mount(controller)
    await view.press('keep this draft')
    await controller.submit('/settings')
    await vi.waitFor(() => expect(view.screen()).toContain('Auto-Discovery'))
    for (let index = 0; index < 4; index++) await view.press('\u001b[B')
    await vi.waitFor(() => expect(view.screen()).toContain('Send anonymous usage data'))
    await view.press('\t')
    await view.press('\u001b[B')

    for (const [width, height] of terminalSizes) {
      await view.resize(width, height)
      await vi.waitFor(() => {
        view.fits()
        // Narrow terminals truncate the label beside its control.
        expect(view.screen()).toContain(width >= 80 ? '› Send anonymous usage data' : '› Send')
        expect(view.screen()).toContain('━━● On')
        expect(view.screen()).toContain('Esc back')
        expect(view.screen()).not.toContain('/help')
      })
    }
    await view.press('\r')
    await vi.waitFor(() => expect(controller.getSnapshot().settings.telemetry).toBe(false))
    await view.press('\u001b')
    await vi.waitFor(() => expect(controller.getSnapshot().panel).toBeUndefined())
    await controller.submit('/settings')
    await view.press('\u001b[B')
    await view.press('\u001b[B')
    await vi.waitFor(() => expect(view.screen()).toContain('Skills'))
    await view.click(view.pointOnRow('Skills', 'Off'))
    await vi.waitFor(() => expect(controller.getSnapshot().settings.skillDiscovery).toBe(true))
    await view.press('\u001b')
    await vi.waitFor(() => expect(controller.getSnapshot().panel).toBeUndefined())
    await vi.waitFor(() => expect(view.screen()).toContain('keep this draft'))
  })

  it('keeps the selected model and panel footer visible after shrinking and expanding', async () => {
    const { controller, switchModel } = createController()
    const view = await mount(controller)
    await controller.submit('/model')
    await vi.waitFor(() => expect(view.screen()).toContain('› OpenAI'))
    await view.press('\t')
    for (let index = 0; index < 8; index++) await view.press('\u001b[B')

    for (const [width, height] of terminalSizes) {
      await view.resize(width, height)
      await vi.waitFor(() => {
        view.fits()
        expect(view.screen()).toContain('Model 08')
        expect(view.screen()).toMatch(/Enter(?: choose)? · Esc(?: back)?/)
        expect(view.screen()).not.toContain('/help')
        if (width >= 80) {
          for (const provider of ['All', 'Amazon Bedrock', 'Anthropic', 'OpenAI', 'Google', 'Ollama', 'LiteLLM']) {
            expect(view.screen()).toContain(provider)
          }
        }
      })
    }
    await view.click(view.point('Model 08'))
    await vi.waitFor(() => expect(switchModel).toHaveBeenCalledWith('model-08'))
  })

  it.each(['bedrock', 'bedrock-mantle'])(
    'chooses AWS profiles in the %s sidebar while preserving the model list and search',
    async (catalog) => {
      const select = vi.fn()
      const { controller, switchModel } = createController({
        awsProfile: {
          get: () => ({
            value: '',
            options: [
              { value: '', label: 'Environment/default' },
              { value: 'team/a b', label: 'team/a b' },
            ],
          }),
          select,
        },
      })
      controller.backend.listModels = () => [
        { id: `${catalog}/model`, name: 'Current Model', description: '', catalog, active: true },
      ]
      const view = await mount(controller)
      await view.resize(80, 24)
      await controller.openModelPanel()
      await vi.waitFor(() => expect(view.screen()).toContain('Environment'))
      for (const provider of ['Anthropic', 'OpenAI', 'Google', 'Ollama', 'LiteLLM']) {
        expect(view.screen()).toContain(provider)
      }
      const modelColumn = view.point('Current Model').column
      expect(view.point('Environment').column).toBeGreaterThan(view.point('LiteLLM').column)
      expect(view.point('Environment').column).toBeLessThan(modelColumn)
      expect(view.point('Environment').row).toBeLessThan(view.point('LiteLLM').row)
      await view.press('\t')
      await view.press('\r')
      await vi.waitFor(() => expect(view.screen()).toContain('team/a b'))
      expect(view.screen()).toContain('Current Mod')
      expect(view.screen()).toContain('Search models')
      for (const provider of ['Anthropic', 'OpenAI', 'Google', 'Ollama', 'LiteLLM']) {
        expect(view.screen()).toContain(provider)
      }
      expect(view.point('team/a b').column).toBeLessThan(modelColumn)
      expect(view.point('Current Model').column).toBe(modelColumn)
      expect(
        view
          .screen()
          .split('\n')
          .find((line) => line.includes('team/a b'))
          ?.match(/│/g)
      ).toHaveLength(4)
      await view.press('\u001b[B')
      await view.press('\u001b[B')
      await view.press('\r')
      await vi.waitFor(() => expect(select).toHaveBeenCalledExactlyOnceWith('team/a b'))
      expect(controller.getSnapshot().panel).toMatchObject({ kind: 'models', awsProfile: { open: false } })
      expect(switchModel).not.toHaveBeenCalled()

      await view.click(view.point('Environment'))
      await vi.waitFor(() => expect(view.screen()).toContain('team/a b'))
      for (const [width, height] of terminalSizes) {
        await view.resize(width, height)
        view.fits()
        expect(view.screen()).toContain(width >= 80 ? 'team/a b' : 'team')
        if (width >= 80) expect(view.screen()).toContain(width === 80 ? 'Current Mod' : 'Current Model')
        if (width >= 120) expect(view.screen()).toContain('Environment/default')
      }
      await view.click(view.point('team/a b'))
      await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(2))
      await view.resize(40, 24)
      for (const key of ['\t', '/']) {
        await view.click(view.point('Env'))
        await vi.waitFor(() => expect(view.screen()).toContain('team'))
        expect(view.screen()).toContain('current')
        await view.press(key)
        await vi.waitFor(() =>
          expect(controller.getSnapshot().panel).toMatchObject({ kind: 'models', awsProfile: { open: false } })
        )
        expect(view.screen()).toContain('current')
        expect(switchModel).not.toHaveBeenCalled()
      }
      await view.resize(120, 40)
      await view.press('unmatched model')
      expect(view.screen()).toContain('AWS profile')
      expect(view.screen()).toContain('No matching models')
      await view.click(view.point('Environment'))
      await vi.waitFor(() => expect(view.screen()).toContain('team/a b'))
      expect(view.screen()).toContain('No matching models')
      await view.press('\u001b')
      await vi.waitFor(() =>
        expect(controller.getSnapshot().panel).toMatchObject({ kind: 'models', awsProfile: { open: false } })
      )
      expect(view.screen()).toContain('No matching models')
      await view.press('/')
      await view.press('\u001b')
      await vi.waitFor(() => expect(view.screen()).toContain('Current Model'))
      await view.press('/')
      await view.press(`${catalog}/new-model`)
      expect(view.screen()).toContain('AWS profile')
      await view.press('\r')
      await view.press('\r')
      await vi.waitFor(() => expect(switchModel, view.screen()).toHaveBeenCalledExactlyOnceWith(`${catalog}/new-model`))
      expect(controller.getSnapshot().panel).toBeUndefined()
      await controller.openModelPanel()
      await vi.waitFor(() => expect(view.screen()).toContain('AWS profile'))
      await view.click(view.point('Environment'))
      await view.press('\u001b[Z')
      for (let index = 0; index < (catalog === 'bedrock' ? 3 : 2); index++) await view.press('\u001b[B')
      expect(view.screen()).toContain('› OpenAI')
      expect(view.screen()).not.toContain('AWS profile')
      expect(controller.getSnapshot().panel).toMatchObject({ awsProfile: { open: false } })
    }
  )

  it('keeps the selected agent visible as grid dimensions change', async () => {
    const manager = new ConversationManager(createController().controller, {
      fork: async () => createController().controller,
    })
    const view = await mount(manager)
    for (let index = 0; index < 8; index++) await manager.submit('/fork')
    await manager.submit('/agents')
    const selected = manager.getSnapshot().panel!.rows.at(-1)!
    await vi.waitFor(() => expect(view.screen()).toContain('Agents'))
    await view.press('\u001b[C')
    await vi.waitFor(() => expect(view.screen()).toContain('2/9'))
    await view.press('\u001b[B')
    await vi.waitFor(() => expect(view.screen()).toContain('6/9'))
    await view.press('\u001b[F')

    for (const [width, height] of terminalSizes) {
      await view.resize(width, height)
      await vi.waitFor(() => {
        view.fits()
        expect(view.screen()).toContain('9/9')
        expect(view.screen()).toContain(selected.label)
        expect(view.screen()).not.toContain('Viewing Agents')
        expect(view.screen()).not.toContain('model-00')
        expect(view.screen()).not.toContain('/settings')
      })
    }
    const activeAgent = manager.getSnapshot().runtime.agent
    await view.press('r')
    await vi.waitFor(() => {
      expect(view.screen()).toContain('Rename agent')
      expect(view.screen()).toContain(selected.label)
      expect(view.screen()).toContain('Save')
    })
    await view.press('\u0015')
    await view.press('Lead reviewer')
    for (const [width, height] of terminalSizes) {
      await view.resize(width, height)
      await vi.waitFor(() => {
        view.fits()
        expect(view.screen()).toContain('Lead reviewer')
        expect(view.screen()).toContain('Save')
        expect(view.screen()).toContain('Cancel')
      })
    }
    await view.press('\r')
    await vi.waitFor(() => expect(manager.getSnapshot().panel).not.toHaveProperty('renameInput'))
    expect(manager.getSnapshot().runtime.agent).toBe(activeAgent)
    expect(manager.getSnapshot().panel?.rows.find((row) => row.value === selected.value)?.label).toBe('Lead reviewer')
    await view.press('\r')
    await vi.waitFor(() => expect(manager.getSnapshot().panel).toBeUndefined())
    await manager.submit('/agents')
    expect(manager.getSnapshot().panel?.rows.find((row) => row.current)?.value).toBe(selected.value)
  })

  it('preserves the conversation and draft when cancelling or saving an agent name', async () => {
    const manager = new ConversationManager(createController().controller, {
      fork: async () => createController().controller,
    })
    const view = await mount(manager)
    await manager.submit('Remember this conversation')
    await view.press('Keep this draft')
    await vi.waitFor(() => expect(view.screen()).toContain('Keep this draft'))
    await manager.submit('/agents')
    await vi.waitFor(() => {
      expect(view.screen()).toContain('Agents')
      expect(view.screen()).not.toContain('Remember this conversation')
      expect(view.screen()).not.toContain('Keep this draft')
      expect(view.screen()).not.toContain('model-00')
    })

    await manager.submit('/rename')
    await vi.waitFor(() => expect(view.screen()).toContain('Rename agent'))
    await view.press('\u0015')
    await view.press('Discarded name')
    await view.click(view.point('Cancel'))
    expect(manager.getSnapshot().runtime.agent).toBe('Strands harness')
    await view.click(view.point('Rename'))
    await view.press('\u0015')
    await view.press('Reviewr')
    await view.press('\u001b[D')
    await view.press('e')
    await view.press('\r')
    await vi.waitFor(() => expect(manager.getSnapshot().runtime.agent).toBe('Reviewer'))
    await view.press('\u001b')
    await vi.waitFor(() => {
      expect(manager.getSnapshot().panel).toBeUndefined()
      expect(view.screen()).toContain('Remember this conversation')
      expect(view.screen()).toContain('Keep this draft')
      expect(view.screen()).toContain('model-00')
      expect(manager.getSnapshot().completedTurns[0]?.agentName).toBe('Reviewer')
    })
  })

  it('keeps the transcript and exit command available while a fork starts', async () => {
    let finishFork!: (controller: ChatController) => void
    const ready = new Promise<ChatController>((resolve) => {
      finishFork = resolve
    })
    const manager = new ConversationManager(createController().controller, { fork: () => ready })
    const view = await mount(manager)
    await manager.submit('Keep this conversation visible')
    const pending = manager.submit('/fork')

    await vi.waitFor(() => {
      expect(manager.getSnapshot().panel).toBeUndefined()
      expect(view.screen()).toContain('Keep this conversation visible')
      expect(view.screen()).toContain('Forking agent…')
      expect(view.screen()).toContain('model-00')
    })
    await view.press('/exit')
    await vi.waitFor(() => expect(view.screen()).toContain('/exit'))
    await view.press('\r')
    await vi.waitFor(() => expect(manager.getSnapshot().status).toBe('closed'))
    expect(manager.getSnapshot().notices).toEqual([])

    const fork = createController().controller
    finishFork(fork)
    await pending
    expect(fork.getSnapshot().status).toBe('closed')
  })

  it('keeps metadata below panels and leaves Settings actionable', async () => {
    const { controller } = createController()
    const view = await mount(controller)
    await view.resize(40, 14)
    await vi.waitFor(() => view.fits())
    const modelTarget = view.point('model-00')
    controller.openContextPanel()
    await vi.waitFor(() => expect(view.screen()).toContain('Context usage'))
    expect(view.screen().split('\n')[modelTarget.row - 1]).toContain('model-00')
    await view.click(modelTarget)
    await vi.waitFor(() => expect(controller.getSnapshot().panel?.kind).toBe('models'))

    await view.resize(160, 40)
    await vi.waitFor(() => expect(view.screen()).toContain('model-00'))
    await view.click(view.point('model-00'))
    await vi.waitFor(() => expect(controller.getSnapshot().panel?.kind).toBe('models'))
    await controller.submit('measure context')
    await vi.waitFor(() => expect(view.screen()).toContain('/settings'))
    const settingsTarget = view.point('/settings')
    await controller.submit('/context')
    await vi.waitFor(() => expect(controller.getSnapshot().panel?.kind).toBe('context'))
    await view.click(settingsTarget)
    await vi.waitFor(() => expect(controller.getSnapshot().panel?.kind).toBe('settings'))
  })
})
