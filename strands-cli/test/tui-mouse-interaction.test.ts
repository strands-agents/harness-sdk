import { createElement } from 'react'
import { render } from 'ink'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ttyInput, ttyOutput } from './fixtures/terminal.js'

import { ChatApp } from '../src/tui/view/app.js'
import { ChatController, type ChatBackend } from '../src/tui/chat/controller.js'
import { sanitizeTerminalText } from '../src/tui/terminal/sanitize.js'

const instances: { unmount(): void }[] = []

afterEach(() => {
  for (const instance of instances.splice(0)) {
    instance.unmount()
  }
})

describe('TUI mouse input', () => {
  it.each([80, 60])('traverses Color mode and inline Theme segments at %i columns', async (width) => {
    const input = ttyInput()
    const output = ttyOutput(width, 30)
    const frame = captureFrame(output)
    const controller = new ChatController(backend(), {
      runtime: { version: '1.2.3', model: 'model-00', cwd: '/work' },
    })
    const instance = render(createElement(ChatApp, { controller }), {
      stdin: input,
      stdout: output,
      stderr: ttyOutput(width, 30),
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    })
    instances.push(instance)
    await controller.submit('/settings')
    await instance.waitUntilRenderFlush()
    await vi.waitFor(() => expect(controller.getSnapshot().panel?.settingsCategory).toBe('Appearance'))

    input.write('\u001b[C')
    await vi.waitFor(() => expect(controller.getSnapshot().settings.colorMode).toBe('light'))
    input.write('\u001b[B')
    await instance.waitUntilRenderFlush()
    input.write('\u001b[C')
    if (width === 80) {
      await vi.waitFor(() => expect(controller.getSnapshot().settings.frogTheme).toBe('minimal'))
      input.write('\u001b[B')
      await vi.waitFor(() => expect(controller.getSnapshot().settings.frogTheme).toBe('kikker'))
    } else {
      await vi.waitFor(() => expect(controller.getSnapshot().settings.colorMode).toBe('dark'))
      input.write('\u001b[B')
      await instance.waitUntilRenderFlush()
      input.write('\u001b[C')
      await vi.waitFor(() => expect(controller.getSnapshot().settings.frogTheme).toBe('minimal'))
    }
    expect(frame().join('\n')).not.toContain('Choose a theme')
  })

  it('activates model and context metadata from direct clicks', async () => {
    const input = ttyInput()
    const output = ttyOutput(80, 16)
    const frame = captureFrame(output)
    const target = backend()
    target.info = () => ({ model: 'bedrock/test' })
    target.listModels = () => [{ id: 'bedrock/test', name: 'bedrock/test', description: '', active: true }]
    const controller = new ChatController(target, {
      runtime: { version: '1.2.3', model: 'bedrock/test', cwd: '/work' },
    })
    const instance = render(createElement(ChatApp, { controller }), {
      stdin: input,
      stdout: output,
      stderr: ttyOutput(80, 16),
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    })
    instances.push(instance)
    await instance.waitUntilRenderFlush()

    const contextTarget = findText(frame(), 'context ░')
    const modelTarget = findText(frame(), 'bedrock/test')

    input.write(mouseInputSequence(0, contextTarget.column, contextTarget.row, 'M'))
    input.write(mouseInputSequence(3, contextTarget.column, contextTarget.row, 'm'))

    await vi.waitFor(() => expect(controller.getSnapshot().panel?.kind).toBe('context'))

    controller.dismissPanel()
    await instance.waitUntilRenderFlush()
    input.write(mouseInputSequence(0, modelTarget.column, modelTarget.row, 'M'))
    input.write(mouseInputSequence(3, modelTarget.column, modelTarget.row, 'm'))

    await vi.waitFor(() => expect(controller.getSnapshot().panel?.kind).toBe('models'))
  })

  it('highlights hover without changing keyboard selection and activates rows on click', async () => {
    const input = ttyInput()
    const output = ttyOutput(80, 20)
    const frame = captureFrame(output)
    let rendered = ''
    output.on('data', (chunk) => {
      rendered += chunk.toString()
    })
    const target = backend()
    target.info = () => ({ model: 'model-00' })
    target.listModels = () => [
      { id: 'model-00', name: 'Model 00', description: '', active: true },
      { id: 'model-01', name: 'Model 01', description: '', active: false },
    ]
    target.modelChangeMode = () => 'live'
    target.switchModel = vi.fn()
    const controller = new ChatController(target, {
      runtime: { version: '1.2.3', model: 'model-00', cwd: '/work' },
    })
    const instance = render(createElement(ChatApp, { controller }), {
      stdin: input,
      stdout: output,
      stderr: ttyOutput(80, 20),
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    })
    instances.push(instance)
    await instance.waitUntilRenderFlush()

    await controller.submit('/model')
    await instance.waitUntilRenderFlush()
    expect(rendered).toContain('\u001b[?1003h')
    const row = findText(frame(), 'Model 01')

    rendered = ''
    input.write(mouseInputSequence(35, row.column, row.row, 'M'))
    await vi.waitFor(() => expect(sanitizeTerminalText(rendered)).toMatch(/Model 01[^\n]*☆/))
    rendered = ''
    input.write(mouseInputSequence(35, 0, 0, 'M'))
    await vi.waitFor(() => {
      expect(sanitizeTerminalText(rendered)).toContain('Model 01')
      expect(sanitizeTerminalText(rendered)).not.toMatch(/Model 01[^\n]*☆/)
    })
    input.write(mouseInputSequence(35, row.column, row.row, 'M'))
    await instance.waitUntilRenderFlush()
    input.write('\r')
    await vi.waitFor(() => expect(target.switchModel).toHaveBeenCalledWith('model-00'))
    vi.mocked(target.switchModel).mockClear()

    input.write(mouseInputSequence(0, row.column, row.row, 'M'))
    input.write(mouseInputSequence(3, row.column, row.row, 'm'))
    await vi.waitFor(() => expect(target.switchModel).toHaveBeenCalledWith('model-01'))
  })

  it('scrolls through a long model list without changing the selected model', async () => {
    const input = ttyInput()
    const output = ttyOutput(80, 20)
    const frame = captureFrame(output)
    const target = backend()
    target.info = () => ({ model: 'model-00' })
    target.listModels = () =>
      Array.from({ length: 12 }, (_, index) => ({
        id: `model-${String(index).padStart(2, '0')}`,
        name: `Model ${String(index).padStart(2, '0')}`,
        description: '',
        active: index === 0,
      }))
    target.modelChangeMode = () => 'live'
    target.switchModel = vi.fn()
    const controller = new ChatController(target, {
      runtime: { version: '1.2.3', model: 'model-00', cwd: '/work' },
    })
    const instance = render(createElement(ChatApp, { controller }), {
      stdin: input,
      stdout: output,
      stderr: ttyOutput(80, 20),
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    })
    instances.push(instance)
    await controller.submit('/model')
    await instance.waitUntilRenderFlush()

    const initialLastModel = lastVisibleModel(frame())

    for (let index = 0; index < 8; index++) {
      input.write(mouseInputSequence(65, initialLastModel.column, initialLastModel.row, 'M'))
    }
    await instance.waitUntilRenderFlush()
    expect(target.switchModel).not.toHaveBeenCalled()
    const scrolledLastModel = lastVisibleModel(frame())
    expect(scrolledLastModel.id).not.toBe(initialLastModel.id)

    input.write(mouseInputSequence(0, scrolledLastModel.column, scrolledLastModel.row, 'M'))
    input.write(mouseInputSequence(3, scrolledLastModel.column, scrolledLastModel.row, 'm'))

    await vi.waitFor(() => expect(target.switchModel).toHaveBeenCalledWith(scrolledLastModel.id))
  })

  it('drags the effort slider without rebuilding the model panel', async () => {
    const input = ttyInput()
    const output = ttyOutput(80, 20)
    const frame = captureFrame(output)
    const target = backend()
    target.info = () => ({ model: 'model-00', effort: 'Medium' })
    target.listModels = vi.fn(() => [{ id: 'model-00', name: 'Model 00', description: '', active: true }])
    target.listEfforts = () => [
      { id: 'off', label: 'Model default' },
      { id: 'low', label: 'Low' },
      { id: 'medium', label: 'Medium', active: true },
      { id: 'high', label: 'High' },
      { id: 'max', label: 'Max' },
    ]
    target.setEffort = vi.fn(async (effort) => effort)
    const controller = new ChatController(target, {
      runtime: { version: '1.2.3', model: 'model-00', cwd: '/work' },
    })
    const instance = render(createElement(ChatApp, { controller }), {
      stdin: input,
      stdout: output,
      stderr: ttyOutput(80, 20),
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    })
    instances.push(instance)
    await controller.submit('/model')
    await instance.waitUntilRenderFlush()

    const panelId = controller.getSnapshot().panel?.id
    const trackRow = frame().findIndex((line) => /─+███─+/.test(line))
    const track = /─+███─+/.exec(frame()[trackRow]!)
    expect(trackRow).toBeGreaterThanOrEqual(0)
    expect(track).toBeDefined()
    const start = track!.index
    const end = start + track![0].length - 1

    input.write(mouseInputSequence(0, start, trackRow, 'M'))
    await instance.waitUntilRenderFlush()
    input.write(mouseInputSequence(32, end, trackRow, 'M'))
    input.write(mouseInputSequence(3, end, trackRow, 'm'))

    await vi.waitFor(() => expect(target.setEffort).toHaveBeenLastCalledWith('max'))
    expect(target.listModels).toHaveBeenCalledOnce()
    expect(controller.getSnapshot().panel).toMatchObject({
      id: panelId,
      slider: { options: expect.arrayContaining([expect.objectContaining({ id: 'max', active: true })]) },
    })
  })

  it.each([80, 60])('clicks live theme settings and opens the custom editor at %i columns', async (width) => {
    const input = ttyInput()
    const output = ttyOutput(width, 30)
    const frame = captureFrame(output)
    const controller = new ChatController(backend(), {
      runtime: { version: '1.2.3', model: 'model-00', cwd: '/work' },
    })
    const instance = render(createElement(ChatApp, { controller }), {
      stdin: input,
      stdout: output,
      stderr: ttyOutput(width, 30),
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    })
    instances.push(instance)
    await controller.submit('/settings')
    await instance.waitUntilRenderFlush()
    await vi.waitFor(() => expect(controller.getSnapshot().panel?.settingsCategory).toBe('Appearance'))
    await instance.waitUntilRenderFlush()

    for (const theme of ['Classic', 'Minimal', 'Homeland', 'Merlin', 'Kikker', 'Cyborg', 'Spectre', 'Custom']) {
      expect(frame().join('\n')).toContain(theme)
    }

    const panelId = controller.getSnapshot().panel?.id
    const light = findText(frame(), 'Light')
    input.write(mouseInputSequence(0, light.column, light.row, 'M'))
    input.write(mouseInputSequence(3, light.column, light.row, 'm'))
    await vi.waitFor(() => expect(controller.getSnapshot().settings.colorMode).toBe('light'))
    expect(controller.getSnapshot().panel?.id).toBe(panelId)

    const kikker = findText(frame(), 'Kikker')
    input.write(mouseInputSequence(0, kikker.column, kikker.row, 'M'))
    input.write(mouseInputSequence(3, kikker.column, kikker.row, 'm'))
    await vi.waitFor(() => expect(controller.getSnapshot().settings.frogTheme).toBe('kikker'))
    expect(controller.getSnapshot().settings.colorMode).toBe('light')
    expect(controller.getSnapshot().panel?.id).toBe(panelId)

    const custom = findText(frame(), 'Custom')
    input.write(mouseInputSequence(0, custom.column, custom.row, 'M'))
    input.write(mouseInputSequence(3, custom.column, custom.row, 'm'))
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Customize theme'))
    input.write('\u001b')
    await vi.waitFor(() => expect(frame().join('\n')).not.toContain('Customize theme'))
    expect(controller.getSnapshot().settings.frogTheme).toBe('kikker')
    expect(controller.getSnapshot().panel?.id).toBe(panelId)
  })

  it('dismisses a non-permission panel only when clicking outside its bounds', async () => {
    const input = ttyInput()
    const output = ttyOutput(80, 20)
    const frame = captureFrame(output)
    const controller = new ChatController(backend(), {
      runtime: { version: '1.2.3', model: 'bedrock/test', cwd: '/work' },
    })
    const instance = render(createElement(ChatApp, { controller }), {
      stdin: input,
      stdout: output,
      stderr: ttyOutput(80, 20),
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    })
    instances.push(instance)
    controller.openContextPanel()
    await instance.waitUntilRenderFlush()

    const title = findText(frame(), 'Context usage')
    input.write(mouseInputSequence(0, title.column, title.row, 'M'))
    input.write(mouseInputSequence(0, title.column, title.row, 'm'))
    await instance.waitUntilRenderFlush()
    expect(controller.getSnapshot().panel?.kind).toBe('context')

    input.write(mouseInputSequence(0, 0, 0, 'M'))
    input.write(mouseInputSequence(0, 0, 0, 'm'))
    await vi.waitFor(() => expect(controller.getSnapshot().panel).toBeUndefined())
  })
})

function findText(lines: readonly string[], text: string): { column: number; row: number } {
  const row = lines.findIndex((line) => line.includes(text))
  expect(row).toBeGreaterThanOrEqual(0)
  return { column: lines[row]!.indexOf(text), row }
}

function captureFrame(output: NodeJS.WriteStream): () => string[] {
  let frame: string[] = []
  output.on('data', (chunk: Buffer) => {
    const text = sanitizeTerminalText(chunk.toString())
    if (text.includes('\n') && text.trim()) {
      frame = text.split('\n')
    }
  })
  return () => frame
}

function lastVisibleModel(lines: readonly string[]): { column: number; row: number; id: string } {
  for (let row = lines.length - 1; row >= 0; row--) {
    const match = /Model (\d{2})/.exec(lines[row]!)
    if (match) {
      return { column: match.index, row, id: `model-${match[1]}` }
    }
  }
  throw new Error('No model row is visible')
}

function mouseInputSequence(button: number, column: number, row: number, suffix: 'M' | 'm'): string {
  return `\u001b[<${button};${column + 1};${row + 1}${suffix}`
}

function backend(): ChatBackend {
  return {
    id: 'selection-test',
    name: 'Strands harness',
    protocol: 'strands',
    async *stream() {
      yield { type: 'textDelta', text: '' }
      return { stopReason: 'endTurn' }
    },
    cancel() {},
  }
}
