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
  it('activates model metadata and the Settings button from direct clicks', async () => {
    const input = ttyInput()
    const output = ttyOutput(80, 16)
    const frame = captureFrame(output)
    const target = backend()
    target.info = () => ({ model: 'bedrock/test' })
    target.listModels = () => [{ id: 'bedrock/test', name: 'bedrock/test', description: '', active: true }]
    target.stream = async function* () {
      yield { type: 'textDelta', text: '' }
      return { stopReason: 'endTurn', context: { projectedTokens: 100, contextWindow: 1_000 } }
    }
    const controller = new ChatController(target, {
      runtime: { version: '1.2.3', model: 'bedrock/test', cwd: '/work' },
    })
    await controller.submit('measure context')
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

    const contextTarget = findText(frame(), '/settings')
    const modelTarget = findText(frame(), 'bedrock/test')

    input.write(mouseInputSequence(0, contextTarget.column, contextTarget.row, 'M'))
    input.write(mouseInputSequence(3, contextTarget.column, contextTarget.row, 'm'))

    await vi.waitFor(() => expect(controller.getSnapshot().panel?.kind).toBe('settings'))

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

    input.write(mouseInputSequence(35, row.column, row.row, 'M'))
    await instance.waitUntilRenderFlush()
    input.write('\r')
    await vi.waitFor(() => expect(target.switchModel).toHaveBeenCalledWith('model-00'))
    await vi.waitFor(() => expect(controller.getSnapshot().panel).toBeUndefined())
    vi.mocked(target.switchModel).mockClear()

    await controller.submit('/model')
    await instance.waitUntilRenderFlush()
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

  it('drags the effort slider without rebuilding the panel', async () => {
    const input = ttyInput()
    const output = ttyOutput(80, 20)
    const frame = captureFrame(output)
    const target = backend()
    target.info = () => ({ model: 'model-00', effort: 'Medium' })
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
    await controller.submit('/effort')
    await instance.waitUntilRenderFlush()

    const panelId = controller.getSnapshot().panel?.id
    const trackRow = frame().findIndex((line) => /[─┬]+███[─┬]+/u.test(line))
    const track = /[─┬]+███[─┬]+/u.exec(frame()[trackRow]!)
    expect(trackRow).toBeGreaterThanOrEqual(0)
    expect(track).toBeDefined()
    const start = track!.index
    const end = start + track![0].length - 1

    input.write(mouseInputSequence(0, start, trackRow, 'M'))
    await instance.waitUntilRenderFlush()
    input.write(mouseInputSequence(32, end, trackRow, 'M'))
    input.write(mouseInputSequence(3, end, trackRow, 'm'))

    await vi.waitFor(() => expect(target.setEffort).toHaveBeenLastCalledWith('max'))
    expect(controller.getSnapshot().panel).toMatchObject({
      id: panelId,
      slider: { options: expect.arrayContaining([expect.objectContaining({ id: 'max', active: true })]) },
    })
  })

  it.each([22, 60, 80])('selects the visible effort label at %i columns', async (width) => {
    const input = ttyInput()
    const output = ttyOutput(width, 20)
    const frame = captureFrame(output)
    const target = backend()
    target.listEfforts = () => [
      { id: 'low', label: 'Low' },
      { id: 'medium', label: 'Medium' },
      { id: 'high', label: 'High', active: true },
      { id: 'xhigh', label: 'Extra high' },
      { id: 'max', label: 'Max' },
    ]
    target.setEffort = vi.fn(async (effort) => effort)
    const controller = new ChatController(target, {
      runtime: { version: '1.2.3', model: 'model-00', cwd: '/work' },
      settings: { animations: false },
    })
    const instance = render(createElement(ChatApp, { controller }), {
      stdin: input,
      stdout: output,
      stderr: ttyOutput(width, 20),
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    })
    instances.push(instance)
    await controller.submit('/effort')
    await instance.waitUntilRenderFlush()

    const trackRow = frame().findIndex((line) => /[─┬]+███[─┬]+/u.test(line))
    expect(trackRow).toBeGreaterThanOrEqual(0)
    const labelRow = trackRow + 1
    const label = /Low|L…/u.exec(frame()[labelRow]!)
    expect(label).not.toBeNull()
    const column = label!.index + label![0].length - 1
    input.write(mouseInputSequence(0, column, labelRow, 'M'))
    input.write(mouseInputSequence(3, column, labelRow, 'm'))

    await vi.waitFor(() => expect(target.setEffort).toHaveBeenLastCalledWith('low'))
  })

  it.each(['\r', '\u001b'])('closes the /effort panel with %j', async (closeKey) => {
    const input = ttyInput()
    const output = ttyOutput(80, 20)
    const target = backend()
    target.info = () => ({ model: 'model-00', effort: 'Medium' })
    target.listEfforts = () => [
      { id: 'low', label: 'Low' },
      { id: 'medium', label: 'Medium', active: true },
      { id: 'high', label: 'High' },
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
    await controller.submit('/effort')
    await instance.waitUntilRenderFlush()

    input.write('\u001b[C')
    await vi.waitFor(() => expect(target.setEffort).toHaveBeenLastCalledWith('high'))
    input.write(closeKey)

    await vi.waitFor(() => expect(controller.getSnapshot().panel).toBeUndefined())
  })

  it('copies a hovered model, then searches and chooses a result', async () => {
    const input = ttyInput()
    const output = ttyOutput(120, 30)
    const frame = captureFrame(output)
    let rawOutput = ''
    output.on('data', (chunk: Buffer) => {
      rawOutput += chunk.toString()
    })
    const target = backend()
    target.listModels = () => [
      { id: 'model-00', name: 'Model 00', description: '', active: true },
      { id: 'model-01', name: 'Model 01', description: '' },
    ]
    target.modelChangeMode = () => 'live'
    target.switchModel = vi.fn()
    const controller = new ChatController(target, {
      runtime: { version: '1.2.3', model: 'model-00', cwd: '/work' },
    })
    const instance = render(createElement(ChatApp, { controller }), {
      stdin: input,
      stdout: output,
      stderr: ttyOutput(80, 30),
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    })
    instances.push(instance)
    await controller.submit('/model')
    await instance.waitUntilRenderFlush()

    const hovered = findText(frame(), 'Model 01')
    input.write(mouseInputSequence(32, hovered.column, hovered.row, 'M'))
    await instance.waitUntilRenderFlush()
    expect(frame().join('\n')).toContain('model-01')
    rawOutput = ''
    input.write('\u0019')
    await vi.waitFor(() => expect(rawOutput).toContain('\u001b]52;c;bW9kZWwtMDE=\u001b\\'))

    input.write('/')
    await instance.waitUntilRenderFlush()
    input.write('1')
    await vi.waitFor(() => expect(frame().join('\n')).not.toContain('Model 00'))
    expect(frame().join('\n')).toContain('Model 01')

    input.write('\r')
    await instance.waitUntilRenderFlush()
    input.write('\r')
    await vi.waitFor(() => expect(target.switchModel).toHaveBeenCalledWith('model-01'))
    await vi.waitFor(() => expect(controller.getSnapshot().panel).toBeUndefined())
    expect(target.switchModel).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(frame().join('\n')).not.toContain('Models'))
  })

  it.each([80, 60])('clicks and steps through live theme settings at %i columns', async (width) => {
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
    await vi.waitFor(() => expect(controller.getSnapshot().panel).toMatchObject({ settingsCategory: 'Appearance' }))
    await instance.waitUntilRenderFlush()

    // Themes share one row that scrolls with the active theme; its overflow marker steps to the next hidden theme.
    expect(frame().join('\n')).toContain('Classic')
    expect(frame().join('\n')).not.toContain('Solar')

    const panelId = controller.getSnapshot().panel?.id
    const lines = frame()
    const themeRow = lines.findIndex((line) => line.includes('› Theme'))
    const next = { column: lines[themeRow]!.lastIndexOf('›'), row: themeRow }
    input.write(mouseInputSequence(0, next.column, next.row, 'M'))
    input.write(mouseInputSequence(3, next.column, next.row, 'm'))
    await vi.waitFor(() => expect(controller.getSnapshot().settings.frogTheme).not.toBe('green'))
    expect(controller.getSnapshot().panel?.id).toBe(panelId)

    while (controller.getSnapshot().settings.frogTheme !== 'solar') {
      const theme = controller.getSnapshot().settings.frogTheme
      input.write('\u001b[C')
      await vi.waitFor(() => expect(controller.getSnapshot().settings.frogTheme).not.toBe(theme))
    }
    await instance.waitUntilRenderFlush()
    const solarLines = frame()
    expect(solarLines[themeRow]).toContain('Solar')
    expect(solarLines[themeRow]).not.toMatch(/Solar.*›/u)
    const previous = { column: solarLines[themeRow]!.indexOf('‹'), row: themeRow }
    input.write(mouseInputSequence(0, previous.column, previous.row, 'M'))
    input.write(mouseInputSequence(3, previous.column, previous.row, 'm'))
    await vi.waitFor(() => expect(controller.getSnapshot().settings.frogTheme).not.toBe('solar'))
    expect(controller.getSnapshot().panel?.id).toBe(panelId)
  })

  it('steers with rewritten queued text without leaving a stale composer draft', async () => {
    const input = ttyInput()
    const output = ttyOutput(100, 30)
    const frame = captureFrame(output)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const target = backend()
    target.stream = async function* (prompt) {
      yield { type: 'textDelta', text: 'Working.' }
      if (prompt === 'first') {
        await gate
      }
      return { stopReason: 'endTurn' }
    }
    target.queueSteering = vi.fn(() => true)
    target.drainSteering = () => []
    const controller = new ChatController(target, {
      runtime: { version: '1.2.3', model: 'model-00', cwd: '/work' },
    })
    const instance = render(createElement(ChatApp, { controller }), {
      stdin: input,
      stdout: output,
      stderr: ttyOutput(100, 30),
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    })
    instances.push(instance)

    const running = controller.submit('first')
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('running'))
    const queued = controller.submit('original guidance')
    await instance.waitUntilRenderFlush()

    const edit = findText(frame(), 'Edit')
    input.write(mouseInputSequence(0, edit.column, edit.row, 'M'))
    input.write(mouseInputSequence(3, edit.column, edit.row, 'm'))
    await vi.waitFor(() => expect(frame().join('\n')).toContain('original guidance · editing'))

    input.write('\u007f'.repeat('original guidance'.length))
    input.write('rewritten guidance')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('rewritten guidance'))
    const steer = findText(frame(), 'Steer')
    input.write(mouseInputSequence(0, steer.column, steer.row, 'M'))
    input.write(mouseInputSequence(3, steer.column, steer.row, 'm'))

    await vi.waitFor(() =>
      expect(target.queueSteering).toHaveBeenCalledWith('rewritten guidance', expect.any(Function))
    )
    await vi.waitFor(() => {
      const visible = frame().join('\n')
      expect(visible.match(/rewritten guidance/gu)).toHaveLength(1)
      expect(visible).toContain('Steering · rewritten guidance')
    })

    release()
    await Promise.all([running, queued])
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
