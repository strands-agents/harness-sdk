import { createElement } from 'react'
import { render, type Instance } from 'ink'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureFrame, mouseInputSequence, ttyInput, ttyOutput } from './fixtures/terminal.js'

import { ChatApp } from '../src/tui/view/app.js'
import { ChatController, type ChatPermissionRequest, type ChatTask } from '../src/tui/chat/controller.js'
import { AgentMessaging } from '../src/tui/messaging.js'
import { ConversationManager } from '../src/tui/session/conversations.js'
import { idleBackend } from './fixtures/chat-backend.js'

const instances: { unmount(): void }[] = []

afterEach(() => {
  for (const instance of instances.splice(0)) {
    instance.unmount()
  }
})

describe('TUI mouse input', () => {
  it.each([
    ['Allow forever', 'allow-always'],
    ['Deny forever', 'deny-always'],
  ])('navigates and clicks the %s scope buttons in a short terminal', async (label, optionId) => {
    const input = ttyInput()
    const output = ttyOutput(100, 16)
    const frame = captureFrame(output)
    let permissionListener: ((request: ChatPermissionRequest | undefined) => void) | undefined
    const target = idleBackend()
    target.watchPermissions = (listener) => {
      permissionListener = listener
      return () => {}
    }
    target.respondPermission = vi.fn(() => true)
    const controller = new ChatController(target)
    const instance = render(createElement(ChatApp, { controller }), {
      stdin: input,
      stdout: output,
      stderr: ttyOutput(100, 16),
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    })
    instances.push(instance)
    permissionListener?.({
      id: 'permission-scopes',
      toolName: 'shell',
      input: { command: 'git status --short --branch' },
      action: 'git status --short --branch',
      options: [
        { id: 'allow-once', label: 'Allow once', kind: 'allow_once' },
        { id: 'allow-always', label: 'Allow forever', kind: 'allow_always' },
        { id: 'deny', label: 'Deny once', kind: 'reject_once' },
        { id: 'deny-always', label: 'Deny forever', kind: 'reject_always' },
      ],
      scopes: [
        { rule: 'shell(git status --short --branch)', label: 'git status --short --branch' },
        { rule: 'shell(git status --short *)', label: 'git status --short *' },
        { rule: 'shell(git status *)', label: 'git status *' },
        { rule: 'shell(git *)', label: 'git *' },
        { rule: 'shell', label: '* any command' },
      ],
    })
    await settled(instance)

    const forever = findText(frame(), label)
    input.write(mouseInputSequence(0, forever.column, forever.row, 'M'))
    input.write(mouseInputSequence(3, forever.column, forever.row, 'm'))
    await vi.waitFor(() => expect(controller.getSnapshot().panel).toHaveProperty('stage', optionId))
    expect(target.respondPermission).not.toHaveBeenCalled()
    await settled(instance)
    expect(frame().find((line) => line.includes('Rule'))).toContain('shell(git status --short --branch)')

    for (const key of ['\u001b[C', '\u001b[B', '\u001b[B']) {
      input.write(key)
      await settled(instance)
    }
    expect(frame().find((line) => line.includes('← Back'))).toContain('▸')
    const wholeTool = findText(frame(), '* any command')
    expect(frame()[wholeTool.row - 1]).toContain('┌')
    expect(frame()[wholeTool.row + 1]).toContain('└')
    input.write(mouseInputSequence(0, wholeTool.column, wholeTool.row, 'M'))
    input.write(mouseInputSequence(3, wholeTool.column, wholeTool.row, 'm'))
    await vi.waitFor(() =>
      expect(target.respondPermission).toHaveBeenCalledExactlyOnceWith('permission-scopes', optionId, 'shell')
    )
  })

  it('switches the live configuration language without closing the panel', async () => {
    const input = ttyInput()
    const output = ttyOutput(100, 24)
    const frame = captureFrame(output)
    const project = { root: '/work/agent', entrypoint: '/work/agent/agent.ts' }
    const openProject = vi.fn(async () => {})
    const controller = new ChatController(idleBackend(), {
      configurationSource: () => ({
        preferredLanguage: 'typescript',
        documents: {
          typescript: { source: 'export const agent = await createHarness({})', generated: true },
          python: { source: 'agent = create_harness()', generated: true },
        },
        project,
      }),
    })
    const instance = render(createElement(ChatApp, { controller, openProject }), {
      stdin: input,
      stdout: output,
      stderr: ttyOutput(100, 24),
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    })
    instances.push(instance)

    await controller.submit('/config')
    await settled(instance)
    expect(frame().join('\n')).toContain('createHarness')

    input.write('e')
    await vi.waitFor(() => expect(openProject).toHaveBeenCalledWith(project))
    openProject.mockClear()

    const open = findText(frame(), 'Open')
    input.write(mouseInputSequence(0, open.column, open.row, 'M'))
    input.write(mouseInputSequence(3, open.column, open.row, 'm'))
    await vi.waitFor(() => expect(openProject).toHaveBeenCalledWith(project))

    input.write('\u001b[C')
    await instance.waitUntilRenderFlush()
    expect(frame().join('\n')).toContain('create_harness')
    expect(controller.getSnapshot().panel?.kind).toBe('config')
  })

  it('activates model and permission metadata and the Settings button from direct clicks', async () => {
    const input = ttyInput()
    const output = ttyOutput(80, 16)
    const frame = captureFrame(output)
    const target = idleBackend()
    target.info = () => ({ model: 'bedrock/test' })
    target.listModels = () => [{ id: 'bedrock/test', name: 'bedrock/test', description: '', active: true }]
    target.permissionStatus = () => ({
      mode: 'default',
      allowedTools: [],
      deniedTools: [],
      configPath: '/work/cli.toml',
    })
    target.setPermissionMode = vi.fn(async () => {})
    target.allowPermission = vi.fn(async () => {})
    target.removeAllowedPermission = vi.fn(async () => {})
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
    const permissionTarget = findText(frame(), 'Ask')

    input.write(mouseInputSequence(0, contextTarget.column, contextTarget.row, 'M'))
    input.write(mouseInputSequence(3, contextTarget.column, contextTarget.row, 'm'))

    await vi.waitFor(() => expect(controller.getSnapshot().panel?.kind).toBe('settings'))

    controller.dismissPanel()
    await instance.waitUntilRenderFlush()
    input.write(mouseInputSequence(0, modelTarget.column, modelTarget.row, 'M'))
    input.write(mouseInputSequence(3, modelTarget.column, modelTarget.row, 'm'))

    await vi.waitFor(() => expect(controller.getSnapshot().panel?.kind).toBe('models'))

    controller.dismissPanel()
    await instance.waitUntilRenderFlush()
    input.write(mouseInputSequence(0, permissionTarget.column, permissionTarget.row, 'M'))
    input.write(mouseInputSequence(3, permissionTarget.column, permissionTarget.row, 'm'))

    await vi.waitFor(() => expect(controller.getSnapshot().panel?.kind).toBe('permissions'))
  })

  it('opens and edits settings while preserving a pending tool approval', async () => {
    const input = ttyInput()
    const output = ttyOutput(100, 30)
    const frame = captureFrame(output)
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const target = idleBackend({
      stream: async function* () {
        yield {
          type: 'permission',
          request: {
            id: 'permission-1',
            toolName: 'read',
            input: { path: 'README.md' },
            options: [
              { id: 'allow', label: 'Allow once', kind: 'allow_once' },
              { id: 'deny', label: 'Deny once', kind: 'reject_once' },
            ],
          },
        }
        await pending
        return { stopReason: 'endTurn' }
      },
      respondPermission: vi.fn(() => {
        finish()
        return true
      }),
    })
    const setSettings = vi.fn(async () => {})
    const controller = new ChatController(target, { settings: { animations: false }, setSettings })
    const instance = render(createElement(ChatApp, { controller }), {
      stdin: input,
      stdout: output,
      stderr: ttyOutput(100, 30),
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    })
    instances.push(instance)
    const running = controller.submit('read the README')

    try {
      await vi.waitFor(() => expect(controller.getSnapshot().panel?.kind).toBe('permission'))
      await settled(instance)
      const approval = controller.getSnapshot().panel
      const settings = findText(frame(), '/settings')
      input.write(mouseInputSequence(0, settings.column, settings.row, 'M'))
      input.write(mouseInputSequence(3, settings.column, settings.row, 'm'))

      await vi.waitFor(() => expect(controller.getSnapshot().panel?.kind).toBe('settings'))
      await settled(instance)
      const telemetry = findText(frame(), 'Telemetry')
      input.write(mouseInputSequence(0, telemetry.column, telemetry.row, 'M'))
      input.write(mouseInputSequence(3, telemetry.column, telemetry.row, 'm'))
      await vi.waitFor(() => expect(controller.getSnapshot().panel).toMatchObject({ settingsCategory: 'Telemetry' }))
      await instance.waitUntilRenderFlush()

      const usageLines = frame()
      const usageRow = findText(usageLines, 'Send anonymous usage data').row
      const usageToggleColumn = usageLines[usageRow]!.indexOf('●')
      expect(usageToggleColumn).toBeGreaterThanOrEqual(0)
      input.write(mouseInputSequence(0, usageToggleColumn, usageRow, 'M'))
      input.write(mouseInputSequence(3, usageToggleColumn, usageRow, 'm'))
      await vi.waitFor(() => expect(setSettings).toHaveBeenCalledWith({ telemetry: false }))
      expect(controller.getSnapshot().settings.telemetry).toBe(false)
      expect(target.respondPermission).not.toHaveBeenCalled()
      expect(target.cancel).not.toHaveBeenCalled()

      input.write('\u001b')
      await vi.waitFor(() => expect(controller.getSnapshot().panel).toEqual(approval))
      await settled(instance)
      const allow = findText(frame(), 'Allow once')
      input.write(mouseInputSequence(0, allow.column, allow.row, 'M'))
      input.write(mouseInputSequence(3, allow.column, allow.row, 'm'))
      await vi.waitFor(() =>
        expect(target.respondPermission).toHaveBeenCalledExactlyOnceWith('permission-1', 'allow', undefined)
      )
      await running
      expect(controller.getSnapshot().panel).toBeUndefined()
    } finally {
      finish()
      await running
      await controller.dispose()
    }
  })

  it('keeps keyboard selection on hover and activates rows on click', async () => {
    const input = ttyInput()
    const output = ttyOutput(80, 20)
    const frame = captureFrame(output)
    let rendered = ''
    output.on('data', (chunk) => {
      rendered += chunk.toString()
    })
    const target = idleBackend()
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
    await settled(instance)
    expect(rendered).toContain('\u001b[?1003h')
    input.write('\t')
    await instance.waitUntilRenderFlush()
    const row = findText(frame(), 'Model 01')

    input.write(mouseInputSequence(35, row.column, row.row, 'M'))
    await instance.waitUntilRenderFlush()
    input.write('\r')
    await vi.waitFor(() => expect(target.switchModel).toHaveBeenCalledWith('model-00'))
    await vi.waitFor(() => expect(controller.getSnapshot().panel).toBeUndefined())
    vi.mocked(target.switchModel).mockClear()

    await controller.submit('/model')
    await settled(instance)
    input.write(mouseInputSequence(0, row.column, row.row, 'M'))
    input.write(mouseInputSequence(3, row.column, row.row, 'm'))
    await vi.waitFor(() => expect(target.switchModel).toHaveBeenCalledWith('model-01'))
  })

  it('switches conversations by clicking agent cards while leaving live delegates read-only', async () => {
    const input = ttyInput()
    const output = ttyOutput(100, 24)
    const frame = captureFrame(output)
    const primary = new ChatController(idleBackend({ name: 'Primary' }))
    const fork = new ChatController(idleBackend({ name: 'Reviewer' }))
    const agentMessaging = new AgentMessaging()
    agentMessaging.register({
      id: 'task-1',
      name: 'Build worker',
      status: () => 'working',
      enqueue: () => true,
    })
    const manager = new ConversationManager(primary, { fork: async () => fork, agentMessaging })
    await manager.submit('/fork')
    await manager.submit('/agents')
    await manager.activatePanelRow(manager.getSnapshot().panel!.rows.find((row) => row.label === 'Primary')!)
    await manager.submit('/agents')
    const instance = render(createElement(ChatApp, { controller: manager }), {
      stdin: input,
      stdout: output,
      stderr: ttyOutput(100, 24),
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    })

    try {
      await settled(instance)
      const delegate = manager.getSnapshot().panel!.rows.find((row) => row.label === 'Build worker')!
      expect(delegate.value).toBeUndefined()
      expect(await manager.activatePanelRow(delegate)).toBe(false)
      const delegateTarget = findText(frame(), 'Build worker')
      input.write(mouseInputSequence(0, delegateTarget.column, delegateTarget.row, 'M'))
      input.write(mouseInputSequence(3, delegateTarget.column, delegateTarget.row, 'm'))
      await instance.waitUntilRenderFlush()
      expect(manager.backend).toBe(primary.backend)
      expect(manager.getSnapshot().panel?.kind).toBe('agents')
      input.write('\u001b[F')
      await instance.waitUntilRenderFlush()
      input.write('\r')
      await instance.waitUntilRenderFlush()
      expect(manager.getSnapshot().panel?.kind).toBe('agents')
      expect(manager.backend).toBe(primary.backend)

      const forkTarget = findText(frame(), 'Fork 2')
      input.write(mouseInputSequence(0, forkTarget.column, forkTarget.row, 'M'))
      input.write(mouseInputSequence(3, forkTarget.column, forkTarget.row, 'm'))
      await vi.waitFor(() => expect(manager.getSnapshot().panel).toBeUndefined())
      expect(manager.backend).toBe(fork.backend)
      await manager.submit('/agents')
      expect(manager.getSnapshot().panel!.rows.find((row) => row.current)?.label).toBe('Fork 2')
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
      await manager.dispose()
    }
  })

  it('scrolls through a long model list without changing the selected model', async () => {
    const input = ttyInput()
    const output = ttyOutput(80, 20)
    const frame = captureFrame(output)
    const target = idleBackend()
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
    await settled(instance)

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
    const target = idleBackend()
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
    await settled(instance)

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
    const target = idleBackend()
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
    await settled(instance)

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
    const target = idleBackend()
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
    await settled(instance)

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
    const target = idleBackend()
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
    await settled(instance)
    input.write('\t')
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
    const controller = new ChatController(idleBackend(), {
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
    await settled(instance)
    await vi.waitFor(() => expect(controller.getSnapshot().panel).toMatchObject({ settingsCategory: 'Appearance' }))
    input.write('\t')
    await instance.waitUntilRenderFlush()

    // Themes share one row that scrolls with the active theme; its overflow marker steps to the next hidden theme.
    expect(frame().join('\n')).toContain('Classic')
    expect(frame().join('\n')).not.toContain('Scarlet')

    const panelId = controller.getSnapshot().panel?.id
    const lines = frame()
    const themeRow = lines.findIndex((line) => line.includes('› Theme'))
    const next = { column: lines[themeRow]!.lastIndexOf('›'), row: themeRow }
    input.write(mouseInputSequence(0, next.column, next.row, 'M'))
    input.write(mouseInputSequence(3, next.column, next.row, 'm'))
    await vi.waitFor(() => expect(controller.getSnapshot().settings.frogTheme).not.toBe('green'))
    expect(controller.getSnapshot().panel?.id).toBe(panelId)

    while (controller.getSnapshot().settings.frogTheme !== 'scarlet') {
      const theme = controller.getSnapshot().settings.frogTheme
      input.write('\u001b[C')
      await vi.waitFor(() => expect(controller.getSnapshot().settings.frogTheme).not.toBe(theme))
    }
    await instance.waitUntilRenderFlush()
    const scarletLines = frame()
    expect(scarletLines[themeRow]).toContain('Scarlet')
    expect(scarletLines[themeRow]).not.toMatch(/Scarlet.*›/u)
    const previous = { column: scarletLines[themeRow]!.indexOf('‹'), row: themeRow }
    input.write(mouseInputSequence(0, previous.column, previous.row, 'M'))
    input.write(mouseInputSequence(3, previous.column, previous.row, 'm'))
    await vi.waitFor(() => expect(controller.getSnapshot().settings.frogTheme).not.toBe('scarlet'))
    expect(controller.getSnapshot().panel?.id).toBe(panelId)
  })

  it('updates queued text without leaving a stale composer draft', async () => {
    const input = ttyInput()
    const output = ttyOutput(100, 30)
    const frame = captureFrame(output)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const target = idleBackend()
    target.stream = async function* (prompt) {
      yield { type: 'textDelta', text: 'Working.' }
      if (prompt === 'first') {
        await gate
      }
      return { stopReason: 'endTurn' }
    }
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
    input.write('\r')
    await vi.waitFor(() => {
      const visible = frame().join('\n')
      expect(visible.match(/rewritten guidance/gu)).toHaveLength(1)
      expect(visible).toContain('Queued · rewritten guidance')
      expect(visible).not.toContain('· editing')
    })

    release()
    await Promise.all([running, queued])
  })

  it('dismisses a non-permission panel only when clicking outside its bounds', async () => {
    const input = ttyInput()
    const output = ttyOutput(80, 20)
    const frame = captureFrame(output)
    const controller = new ChatController(idleBackend(), {
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
    await settled(instance)

    const title = findText(frame(), 'Context usage')
    input.write(mouseInputSequence(0, title.column, title.row, 'M'))
    input.write(mouseInputSequence(0, title.column, title.row, 'm'))
    await instance.waitUntilRenderFlush()
    expect(controller.getSnapshot().panel?.kind).toBe('context')

    input.write(mouseInputSequence(0, 0, 0, 'M'))
    input.write(mouseInputSequence(0, 0, 0, 'm'))
    await vi.waitFor(() => expect(controller.getSnapshot().panel).toBeUndefined())
  })

  it('puts a selected skill command in the composer without activating it', async () => {
    const input = ttyInput()
    const output = ttyOutput(80, 20)
    const frame = captureFrame(output)
    const activate = vi.fn()
    const controller = new ChatController(idleBackend(), {
      skills: {
        list: async () => [{ name: 'review', description: 'Review code', instructions: '', active: false }],
        activate,
      },
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

    await controller.submit('/skills')
    await settled(instance)
    input.write('\r')

    await vi.waitFor(() => expect(frame().join('\n')).toContain('/review'))
    expect(controller.getSnapshot().panel).toBeUndefined()
    expect(activate).not.toHaveBeenCalled()
  })

  it('toggles task behavior and searches lifecycle-sorted background tasks', async () => {
    const input = ttyInput()
    const output = ttyOutput(100, 24)
    const frame = captureFrame(output)
    let waitForCompletion = false
    let taskListener: ((tasks: readonly ChatTask[]) => void) | undefined
    const setWaitForCompletion = vi.fn(async (value: boolean) => {
      waitForCompletion = value
    })
    const target = idleBackend()
    target.backgroundTasksWaitForCompletion = () => waitForCompletion
    target.setBackgroundTasksWaitForCompletion = setWaitForCompletion
    target.watchTasks = (listener) => {
      taskListener = listener
      listener([])
      return () => {}
    }
    const controller = new ChatController(target)
    const instance = render(createElement(ChatApp, { controller }), {
      stdin: input,
      stdout: output,
      stderr: ttyOutput(100, 24),
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    })
    instances.push(instance)

    await controller.submit('/tasks')
    await settled(instance)

    input.write('\u001b[C')
    await vi.waitFor(() => expect(setWaitForCompletion).toHaveBeenCalledWith(true))
    await instance.waitUntilRenderFlush()

    taskListener?.([
      { id: 'done', label: 'Archive report', status: 'completed', source: 'background' },
      { id: 'deploy', label: 'Run deployment', status: 'working', source: 'background' },
      { id: 'waiting', label: 'Await approval', status: 'paused', source: 'background' },
    ])
    await instance.waitUntilRenderFlush()
    const initial = frame().join('\n')
    expect(initial).toContain('Search tasks')
    expect(controller.getSnapshot().panel?.rows.map((row) => row.label)).toEqual([
      'Run deployment',
      'Await approval',
      'Archive report',
    ])

    input.write('\t')
    await instance.waitUntilRenderFlush()
    input.write('/')
    await instance.waitUntilRenderFlush()
    input.write('deploy')
    await vi.waitFor(() => {
      const filtered = frame().join('\n')
      expect(filtered).toContain('deploy')
      expect(filtered).toContain('1 / 3')
      expect(filtered).toContain('Run deployment')
    })
  })

  it('changes permission mode, searches tools, and toggles a custom grant', async () => {
    const input = ttyInput()
    const output = ttyOutput(100, 24)
    const frame = captureFrame(output)
    let mode: 'default' | 'bypassPermissions' = 'default'
    let allowedTools = ['bash']
    const target = idleBackend()
    target.info = () => ({
      model: 'model-00',
      tools: [
        { name: 'bash', description: 'Run commands' },
        { name: 'write', description: 'Write files' },
      ],
    })
    target.permissionStatus = () => ({
      mode,
      allowedTools,
      deniedTools: [],
      configPath: '/work/cli.toml',
    })
    target.setPermissionMode = vi.fn(async (nextMode) => {
      mode = nextMode
    })
    target.allowPermission = vi.fn(async (toolName) => {
      allowedTools = [...allowedTools, toolName]
    })
    target.removeAllowedPermission = vi.fn(async (toolName) => {
      allowedTools = allowedTools.filter((candidate) => candidate !== toolName)
    })
    const controller = new ChatController(target)
    const instance = render(createElement(ChatApp, { controller }), {
      stdin: input,
      stdout: output,
      stderr: ttyOutput(100, 24),
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    })
    instances.push(instance)

    await controller.submit('/permissions')
    await settled(instance)
    expect(frame().join('\n')).toContain('Search tools')

    input.write('\u001b[D')
    await vi.waitFor(() => expect(target.setPermissionMode).toHaveBeenCalledWith('bypassPermissions'))
    await instance.waitUntilRenderFlush()

    const modeLines = frame()
    const trackRow = modeLines.findIndex((line) => line.includes('┬') && line.includes('█'))
    const track = /[─┬█]+/u.exec(modeLines[trackRow]!)
    expect(track).toBeDefined()
    const custom = { column: track!.index + track![0].length - 1, row: trackRow }
    input.write(mouseInputSequence(0, custom.column, custom.row, 'M'))
    input.write(mouseInputSequence(3, custom.column, custom.row, 'm'))
    await vi.waitFor(() => expect(target.setPermissionMode).toHaveBeenLastCalledWith('default'))
    await instance.waitUntilRenderFlush()

    const search = findText(frame(), 'Search tools')
    input.write(mouseInputSequence(0, search.column, search.row, 'M'))
    input.write(mouseInputSequence(3, search.column, search.row, 'm'))
    await instance.waitUntilRenderFlush()
    input.write('write')
    await vi.waitFor(() => {
      expect(frame().join('\n')).toContain('write')
      expect(frame().join('\n')).not.toContain('bash')
    })

    const lines = frame()
    const writeRow = lines.findIndex((line) => line.includes('write') && line.includes('●'))
    expect(writeRow).toBeGreaterThanOrEqual(0)
    const writeControl = { column: lines[writeRow]!.indexOf('●'), row: writeRow }
    input.write(mouseInputSequence(0, writeControl.column, writeControl.row, 'M'))
    input.write(mouseInputSequence(3, writeControl.column, writeControl.row, 'm'))
    await vi.waitFor(() => expect(target.allowPermission).toHaveBeenCalledWith('write'))

    input.write(' ')
    await vi.waitFor(() => expect(target.removeAllowedPermission).toHaveBeenCalledWith('write'))
  })

  it('accepts an export folder name before saving to the harness directory', async () => {
    const input = ttyInput()
    const output = ttyOutput(80, 20)
    const exportAgentProject = vi.fn(async (_language: string, destination?: string) => destination)
    const controller = new ChatController(idleBackend(), { exportAgentProject })
    const instance = render(createElement(ChatApp, { controller }), {
      stdin: input,
      stdout: output,
      stderr: ttyOutput(80, 20),
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    })
    instances.push(instance)

    await controller.submit('/export')
    await settled(instance)
    input.write('\r')
    await vi.waitFor(() => expect(controller.getSnapshot().panel?.title).toBe('Name exported folder'))
    input.write('Customer Harness')
    await instance.waitUntilRenderFlush()
    input.write('\r')
    await vi.waitFor(() => expect(controller.getSnapshot().panel?.title).toBe('Save Python copy'))
    input.write('\r')

    await vi.waitFor(() =>
      expect(exportAgentProject).toHaveBeenCalledWith(
        'python',
        join(homedir(), '.strands', 'harnesses', 'customer-harness'),
        'directory'
      )
    )
  })
})

function findText(lines: readonly string[], text: string): { column: number; row: number } {
  const row = lines.findIndex((line) => line.includes(text))
  expect(row).toBeGreaterThanOrEqual(0)
  return { column: lines[row]!.indexOf(text), row }
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

// Composer panels rise over the transcript for a moment after opening; targets are read from the settled frame.
async function settled(instance: Instance): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250))
  await instance.waitUntilRenderFlush()
}
