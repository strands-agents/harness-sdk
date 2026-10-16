import { setImmediate } from 'node:timers'

import type { ContentBlockData } from '@strands-agents/sdk'
import { describe, expect, it, vi } from 'vitest'

import {
  ChatController,
  type ChatBackend,
  type ChatConfigurationSource,
  type ChatContextUsage,
  type ChatEvent,
  type ChatPermissionRequest,
  type ChatRunResult,
  type ChatTask,
} from '../src/tui/chat/controller.js'
import type { BackgroundAgentActivity } from '../src/tui/background/activity.js'
import { BACKGROUND_TASK_WAIT_TOGGLE } from '../src/tui/chat/panels.js'
import { ModelControlError, resolveModelTarget } from '../src/tui/model/selection.js'
import { idleBackend } from './fixtures/chat-backend.js'
import type { McpServerInfo } from '../src/tui/mcp.js'

function backend(
  run: (prompt: string) => AsyncGenerator<ChatEvent, ChatRunResult, undefined> = async function* () {
    yield* []
    return { stopReason: 'endTurn' }
  }
): ChatBackend & { cancel: ReturnType<typeof vi.fn<() => void>> } {
  const cancel = vi.fn<() => void>()
  return {
    id: 'test',
    name: 'Test',
    protocol: 'strands',
    stream(prompt) {
      if (typeof prompt !== 'string') {
        throw new Error('This test backend only accepts text prompts.')
      }
      return run(prompt)
    },
    cancel,
  }
}

describe('ChatController', () => {
  it('opens the live configuration source in either language without running a turn', async () => {
    const stream = vi.fn<ChatBackend['stream']>()
    const controller = new ChatController(backend(), {
      configurationSource: () => ({
        preferredLanguage: 'typescript',
        documents: {
          typescript: { source: 'export const agent = await createHarness({})', generated: true },
          python: { source: 'agent = create_harness()', generated: true },
        },
      }),
    })
    Object.assign(controller.backend, { stream })

    await controller.submit('/config python')

    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'config',
      title: 'Configuration',
      language: 'python',
      configuration: {
        documents: { python: { source: 'agent = create_harness()' } },
      },
    })
    expect(stream).not.toHaveBeenCalled()

    await controller.submit('/config rust')
    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'error',
      title: 'unknown configuration language',
    })
  })

  it('refreshes the embedded configuration after strands_config changes it', async () => {
    let revision = 'before'
    let finishTool!: () => void
    let finishTurn!: () => void
    const toolPending = new Promise<void>((resolve) => {
      finishTool = resolve
    })
    const turnPending = new Promise<void>((resolve) => {
      finishTurn = resolve
    })
    const controller = new ChatController(
      backend(async function* () {
        yield { type: 'toolStart', toolUseId: 'config-1', name: 'strands_config', input: { action: 'update' } }
        await toolPending
        revision = 'after'
        yield { type: 'toolResult', toolUseId: 'config-1', status: 'success', content: [] }
        await turnPending
        return { stopReason: 'endTurn' }
      }),
      {
        configurationSource: () => ({
          preferredLanguage: 'typescript',
          documents: {
            typescript: { source: `createHarness({ name: '${revision}' })`, generated: true },
            python: { source: `create_harness(name="${revision}")`, generated: true },
          },
        }),
      }
    )

    const running = controller.submit('Update the config')
    await vi.waitFor(() =>
      expect(controller.getSnapshot().activeTurn?.entries).toContainEqual(
        expect.objectContaining({ type: 'tool', name: 'strands_config', status: 'running' })
      )
    )
    expect(controller.getSnapshot().configuration?.documents.typescript.source).toContain('before')
    await controller.submit('/config')
    expect(controller.getSnapshot().panel?.kind).toBe('config')

    finishTool()
    await vi.waitFor(() =>
      expect(controller.getSnapshot().configuration?.documents.typescript.source).toContain('after')
    )
    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'config',
      configuration: { documents: { typescript: { source: expect.stringContaining('after') } } },
    })
    expect(controller.getSnapshot().configurationDiffs?.typescript?.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'remove', text: expect.stringContaining('before') }),
        expect.objectContaining({ kind: 'add', text: expect.stringContaining('after') }),
      ])
    )
    expect(controller.getSnapshot().activeTurn).toBeDefined()

    finishTurn()
    await running
  })

  it('keeps the configuration diff through apply and into the next session until the next prompt', async () => {
    let revision = 'before'
    let applyStarted = false
    const source = (): ChatConfigurationSource => ({
      preferredLanguage: 'typescript',
      documents: {
        typescript: { source: `createHarness({\n  name: '${revision}',\n})`, generated: true },
        python: { source: `create_harness(name="${revision}")`, generated: true },
      },
    })
    const target = backend(async function* () {
      yield { type: 'toolStart', toolUseId: 'config-1', name: 'strands_config', input: { action: 'update' } }
      revision = 'after'
      yield { type: 'toolResult', toolUseId: 'config-1', status: 'success', content: [] }
      yield { type: 'toolStart', toolUseId: 'config-2', name: 'strands_config', input: { action: 'apply' } }
      applyStarted = true
      await new Promise<void>((resolve) => setImmediate(resolve))
      yield { type: 'toolResult', toolUseId: 'config-2', status: 'success', content: [] }
      return { stopReason: 'endTurn' }
    })
    target.captureConversation = vi.fn(
      async () => ({}) as Awaited<ReturnType<NonNullable<ChatBackend['captureConversation']>>>
    )
    const controller = new ChatController(target, { configurationSource: source })
    const changed = expect.arrayContaining([
      expect.objectContaining({ kind: 'context', text: 'createHarness({' }),
      expect.objectContaining({ kind: 'remove', text: "  name: 'before'," }),
      expect.objectContaining({ kind: 'add', text: "  name: 'after'," }),
    ])

    const running = controller.submit('Update the config')
    await vi.waitFor(() => expect(applyStarted).toBe(true))
    expect(controller.getSnapshot().configurationDiffs?.typescript?.lines).toEqual(changed)
    await running
    expect(controller.getSnapshot().configurationDiffs?.typescript?.lines).toEqual(changed)

    const conversation = await controller.captureConversation()
    const reloaded = new ChatController(backend(), {
      configurationSource: source,
      initialTurns: conversation.completedTurns,
      ...(conversation.configurationBaseline
        ? { initialConfigurationBaseline: conversation.configurationBaseline }
        : {}),
    })
    expect(reloaded.getSnapshot().configurationDiffs?.typescript?.lines).toEqual(changed)
  })

  it('clears a denied draft from an earlier turn without showing a reverse configuration diff', async () => {
    let name = 'Active'
    let finishDenial!: () => void
    const denialPending = new Promise<void>((resolve) => {
      finishDenial = resolve
    })
    const controller = new ChatController(
      backend(async function* (prompt) {
        const applying = prompt === 'apply'
        yield {
          type: 'toolStart',
          toolUseId: 'config',
          name: 'strands_config',
          input: { action: applying ? 'apply' : 'update' },
        }
        if (applying) {
          await denialPending
          yield {
            type: 'toolResult',
            toolUseId: 'config',
            status: 'error',
            content: [{ type: 'text', text: 'DENIED: Tool call denied by the user: strands_config' }],
          }
        } else {
          name = prompt
          yield { type: 'toolResult', toolUseId: 'config', status: 'success', content: [] }
        }
        return { stopReason: 'endTurn' }
      }),
      {
        configurationSource: () => ({
          preferredLanguage: 'typescript',
          documents: {
            typescript: { source: `createHarness({ name: '${name}' })`, generated: true },
            python: { source: `create_harness(name="${name}")`, generated: true },
          },
        }),
      }
    )

    await controller.submit('Rejected')
    expect(controller.getSnapshot().configurationDiffs?.typescript?.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'remove', text: expect.stringContaining('Active') }),
        expect.objectContaining({ kind: 'add', text: expect.stringContaining('Rejected') }),
      ])
    )
    const applying = controller.submit('apply')
    await vi.waitFor(() =>
      expect(controller.getSnapshot().activeTurn?.entries).toContainEqual(
        expect.objectContaining({ type: 'tool', name: 'strands_config', status: 'running' })
      )
    )
    await controller.submit('/config')
    name = 'Active'
    controller.refreshConfiguration(true)

    expect(controller.getSnapshot().configuration?.documents.typescript.source).toContain('Active')
    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'config',
      configuration: { documents: { typescript: { source: expect.stringContaining('Active') } } },
    })
    expect(controller.getSnapshot().configurationDiffs).toBeUndefined()
    finishDenial()
    await applying
    expect(controller.getSnapshot().configurationDiffs).toBeUndefined()

    await controller.submit('Next')
    for (const language of ['typescript', 'python'] as const) {
      const lines = controller.getSnapshot().configurationDiffs?.[language]?.lines
      expect(lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'remove', text: expect.stringContaining('Active') }),
          expect.objectContaining({ kind: 'add', text: expect.stringContaining('Next') }),
        ])
      )
      expect(lines?.some((line) => line.text.includes('Rejected'))).toBe(false)
    }
  })

  it('offers to reload the session from a directory export so source edits hot-reload', async () => {
    const useExportedProject = vi.fn()
    const exportAgentProject = vi.fn(async () => '/tmp/exported-agent')
    const controller = new ChatController(backend(), { exportAgentProject, useExportedProject })

    await controller.submit('/export')
    await controller.activatePanelRow(controller.getSnapshot().panel!.rows.find((row) => row.label === 'TypeScript')!)
    await controller.activatePanelRow({
      label: 'Continue',
      description: 'portable',
      value: 'export:name:typescript:portable',
    })
    await controller.activatePanelRow(
      controller.getSnapshot().panel!.rows.find((row) => row.label === 'Default folder')!
    )
    expect(exportAgentProject).toHaveBeenCalledWith('typescript', expect.any(String), 'directory')
    const panel = controller.getSnapshot().panel!
    expect(panel.title).toBe('Export complete')
    expect(panel.body).toBe('Saved a copy. No automatic updates.')
    expect(panel.rows[0]).toMatchObject({ label: 'Use for this session', value: 'export:use-project' })

    await controller.activatePanelRow(panel.rows[0]!)
    expect(useExportedProject).toHaveBeenCalledExactlyOnceWith('/tmp/exported-agent')
  })

  it('does not offer to reload from a zip export', async () => {
    const useExportedProject = vi.fn()
    const exportAgentProject = vi.fn(async () => '/tmp/exported-agent.zip')
    const controller = new ChatController(backend(), { exportAgentProject, useExportedProject })

    await controller.submit('/export typescript /tmp/exported-agent.zip')
    expect(exportAgentProject).toHaveBeenCalled()
    const panel = controller.getSnapshot().panel!
    expect(panel.title).toBe('Export complete')
    expect(panel.rows.map((row) => row.label)).toEqual(['Copy path', 'Copy launch command'])
    expect(useExportedProject).not.toHaveBeenCalled()
  })

  it('sends attachment content and keeps its display metadata on the turn', async () => {
    const prompts: Array<string | ContentBlockData[]> = []
    const controller = new ChatController(
      idleBackend({
        id: 'attachment-test',
        async *stream(prompt) {
          prompts.push(prompt)
          yield { type: 'textDelta', text: 'I can see it.' }
          return { stopReason: 'endTurn' }
        },
      })
    )
    const bytes = new Uint8Array([1, 2, 3])

    const turn = await controller.submit({
      text: 'Describe this',
      attachments: [
        {
          path: '/tmp/frog.png',
          name: 'frog.png',
          size: bytes.byteLength,
          kind: 'image',
          content: { image: { format: 'png', source: { bytes } } },
        },
      ],
    })

    expect(prompts).toEqual([[{ text: 'Describe this' }, { image: { format: 'png', source: { bytes } } }]])
    expect(turn).toMatchObject({
      prompt: 'Describe this',
      attachments: [{ name: 'frog.png', size: 3, kind: 'image' }],
      entries: [{ type: 'assistant', text: 'I can see it.' }],
    })
  })

  it('sanitizes runtime metadata exposed through snapshots', () => {
    const target = backend()
    Object.assign(target, {
      id: 'test\u0007',
      name: 'Te\u001b[31mst',
      info: () => ({
        model: 'model\u009b31m',
        tools: [{ name: 're\u001b[2Jad', description: 'line\tone\nline\u0007two' }],
      }),
    })
    const controller = new ChatController(target, {
      runtime: {
        session: 'saved\u001b]52;c;x\u0007',
        cwd: '/tmp/\u009b31mproject',
        configuration: [{ label: 'source\u0007', value: 'local\u001b[2J' }],
      },
    })

    expect(controller.getSnapshot().runtime).toMatchObject({
      agent: 'Test',
      backendId: 'test',
      model: 'model',
      session: 'saved',
      cwd: '/tmp/project',
      tools: [{ name: 'read', description: 'line\tone\nlinetwo' }],
      configuration: [{ label: 'source', value: 'local' }],
    })
  })

  it.each(['synchronous', 'late'] as const)(
    'refreshes latest context spend on %s completion without retaining unavailable token splits',
    async (timing) => {
      const occupancy: ChatContextUsage = {
        currentTokens: 5,
        projectedTokens: 8,
        contextWindow: 1000,
        breakdown: {
          categories: [
            { kind: 'userMessages', tokens: 5 },
            { kind: 'assistantMessages', tokens: 3 },
          ],
        },
      }
      const total = { totalTokens: 116, cacheReadInputTokens: 10, cacheWriteInputTokens: 2 }
      let publish!: (usage: ChatRunResult['usage']) => void
      const unsubscribe = vi.fn()
      const controller = new ChatController(
        backend(async function* () {
          yield { type: 'textDelta', text: 'done' }
          return {
            stopReason: 'endTurn',
            context: { ...occupancy, inputTokens: 5, outputTokens: 3, totalTokens: 8 },
            watchUsage: (listener) => {
              publish = listener
              if (timing === 'synchronous') {
                listener(total)
              }
              return unsubscribe
            },
          }
        })
      )
      await controller.submit('work')
      await controller.submit('/context')
      if (timing === 'late') {
        expect(controller.getSnapshot().context.inputTokens).toBe(5)
        publish(total)
      }
      expect(controller.getSnapshot().panel?.kind).toBe('context')
      expect(controller.getSnapshot().context).toEqual({ ...occupancy, ...total })
      expect(controller.getSnapshot().completedTurns[0]?.usage).toEqual(total)
      expect(unsubscribe).toHaveBeenCalledTimes(1)
      await controller.dispose()
    }
  )

  it.each(['active', 'completed'] as const)(
    'preserves a newer %s turn context when an older turn finishes spending',
    async (state) => {
      let publish!: (usage: ChatRunResult['usage']) => void
      let finish!: () => void
      const pending = new Promise<void>((resolve) => {
        finish = resolve
      })
      const context = { currentTokens: 20, projectedTokens: 28, inputTokens: 20, outputTokens: 8, totalTokens: 28 }
      const controller = new ChatController(
        backend(async function* (prompt) {
          if (prompt === 'first') {
            yield { type: 'textDelta', text: 'done' }
            return {
              stopReason: 'endTurn',
              watchUsage: (listener) => {
                publish = listener
                return (): void => {}
              },
            }
          }
          yield { type: 'context', usage: context }
          await pending
          return { stopReason: 'endTurn', context }
        })
      )
      await controller.submit('first')
      const submitting = controller.submit('second')
      await vi.waitFor(() => expect(controller.getSnapshot().context).toEqual(context))
      if (state === 'completed') {
        finish()
        await submitting
      }
      publish({ totalTokens: 116, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 })
      expect(controller.getSnapshot().completedTurns[0]?.usage?.totalTokens).toBe(116)
      expect(controller.getSnapshot().context).toEqual(context)
      finish()
      await submitting
      await controller.dispose()
    }
  )

  it.each(['clear', 'close', 'dispose'] as const)('removes pending usage subscriptions on %s', async (action) => {
    let publish: ((usage: ChatRunResult['usage']) => void) | undefined
    const unsubscribe = vi.fn()
    const target = backend(async function* () {
      yield { type: 'textDelta', text: 'done' }
      return {
        stopReason: 'endTurn',
        watchUsage: (listener) => {
          publish = listener
          return unsubscribe
        },
      }
    })
    target.clear = vi.fn(async () => {})
    const controller = new ChatController(target)
    await controller.submit('work')
    const publishStaleUsage = publish
    expect(unsubscribe).not.toHaveBeenCalled()
    if (action === 'clear') {
      await controller.submit('/clear')
      await controller.submit('new conversation')
    } else {
      await controller[action]()
    }
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    publishStaleUsage?.({ totalTokens: 116, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 })
    expect(controller.getSnapshot().completedTurns[0]?.usage).toBeUndefined()
    await controller.dispose()
  })

  it('does not register late usage subscriptions after disposal during a stream', async () => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const watchUsage = vi.fn()
    const target = backend(async function* () {
      yield { type: 'textDelta', text: 'working' }
      await pending
      return { stopReason: 'endTurn', watchUsage }
    })
    const controller = new ChatController(target)
    const submitting = controller.submit('work')
    await controller.dispose()
    finish()
    await submitting
    expect(watchUsage).not.toHaveBeenCalled()
  })

  it('reports unknown slash commands without starting a turn', async () => {
    const command = 'loop'
    const controller = new ChatController(backend())

    expect(controller.actionableCommandToken(`/${command}`)).toBeUndefined()

    await controller.submit(`/${command}`)

    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'error',
      title: 'unknown command',
      rows: [{ label: `/${command}`, description: 'Type / to browse commands or use /skills to list skills.' }],
    })
    expect(controller.getSnapshot().completedTurns).toEqual([])
  })

  it('toggles MCP and skill discovery from settings and persists them', async () => {
    const setSettings = vi.fn(async () => {})
    const controller = new ChatController(backend(), { setSettings })

    await controller.submit('/settings')
    await controller.activatePanelRow({ label: '', description: '', value: 'settings:Auto-Discovery' })
    const rows = controller.getSnapshot().panel!.rows
    const mcpRow = rows.find((row) => row.value === 'mcpDiscovery')!
    const skillRow = rows.find((row) => row.value === 'skillDiscovery')!
    expect(mcpRow).toMatchObject({
      description: 'off · only explicit --mcp-config sources load · applies at next launch',
      control: { kind: 'toggle', checked: false },
    })
    expect(skillRow).toMatchObject({
      description: 'off · only configured skills directories load · applies at next launch',
      control: { kind: 'toggle', checked: false },
    })

    expect(await controller.activatePanelRow(mcpRow)).toBe(true)
    expect(setSettings).toHaveBeenNthCalledWith(1, { mcpDiscovery: true })
    expect(controller.getSnapshot().settings.mcpDiscovery).toBe(true)
    expect(controller.getSnapshot().panel!.rows.find((row) => row.value === 'mcpDiscovery')).toMatchObject({
      description: 'on · adds conventional Claude, Kiro, Gemini, Codex, and Strands sources · applies at next launch',
      control: { kind: 'toggle', checked: true },
    })

    expect(await controller.activatePanelRow(skillRow)).toBe(true)
    expect(setSettings).toHaveBeenNthCalledWith(2, { skillDiscovery: true })
    expect(controller.getSnapshot().settings.skillDiscovery).toBe(true)
    expect(controller.getSnapshot().panel!.rows.find((row) => row.value === 'skillDiscovery')).toMatchObject({
      description: 'on · adds conventional user and workspace sources · applies at next launch',
      control: { kind: 'toggle', checked: true },
    })
  })

  it('selects a context offload threshold from settings', async () => {
    const setSettings = vi.fn(async () => {})
    const controller = new ChatController(backend(), { setSettings })

    await controller.submit('/settings')
    await controller.activatePanelRow({ label: '', description: '', value: 'settings:Agent' })
    const threshold = controller.getSnapshot().panel!.rows.find((row) => row.value === 'contextOffloadThreshold')!

    expect(threshold).toMatchObject({
      description: 'Default · tool-result tokens · applies at next launch',
      control: {
        kind: 'segmented',
        options: [
          { label: 'Default', value: 'default', active: true },
          { label: '1.5K', value: '1500' },
          { label: '2.5K', value: '2500' },
          { label: '5K', value: '5000' },
          { label: '10K', value: '10000' },
        ],
      },
    })

    expect(await controller.activatePanelRow({ ...threshold, value: 'contextOffloadThreshold=5000' })).toBe(true)
    expect(setSettings).toHaveBeenCalledWith({ contextOffloadThreshold: 5_000 })
    expect(controller.getSnapshot().settings.contextOffloadThreshold).toBe(5_000)
  })

  it('disables startup update prompts outside the settings panel', async () => {
    const setSettings = vi.fn(async () => {})
    const controller = new ChatController(backend(), { setSettings })

    await controller.submit('/settings')
    await controller.activatePanelRow({ label: '', description: '', value: 'settings:Updates' })
    expect(controller.getSnapshot().panel?.rows.find((row) => row.value === 'updatePrompts')).toMatchObject({
      label: 'Startup update prompts',
      control: { kind: 'toggle', checked: true },
    })

    expect(await controller.setSettings({ updatePrompts: false })).toBe(true)
    expect(setSettings).toHaveBeenCalledWith({ updatePrompts: false })
    expect(controller.getSnapshot().settings.updatePrompts).toBe(false)
    expect(controller.getSnapshot().panel?.rows.find((row) => row.value === 'updatePrompts')).toMatchObject({
      description: 'off · available updates remain visible in the footer',
      control: { kind: 'toggle', checked: false },
    })
  })

  it('runs bang commands through the active backend shell stream', async () => {
    const modelPrompts: string[] = []
    const shellCommands: string[] = []
    const target = backend(async function* (prompt) {
      modelPrompts.push(prompt)
      yield { type: 'textDelta', text: 'model response' }
      return { stopReason: 'endTurn' }
    })
    target.streamShell = async function* (command) {
      shellCommands.push(command)
      yield { type: 'toolStart', toolUseId: 'shell-1', name: 'shell', input: { command } }
      yield {
        type: 'toolOutputDelta',
        toolUseId: 'shell-1',
        stream: 'stdout',
        text: '/workspace\n',
      }
      yield {
        type: 'toolResult',
        toolUseId: 'shell-1',
        status: 'success',
        content: [{ type: 'text', text: '/workspace\n' }],
      }
      return { stopReason: 'endTurn' }
    }
    const controller = new ChatController(target)

    expect(controller.actionableCommandToken('!pwd')).toBe('!')
    const turn = await controller.submit('!  pwd ')

    expect(shellCommands).toEqual(['pwd'])
    expect(modelPrompts).toEqual([])
    expect(turn).toMatchObject({
      prompt: '!  pwd',
      status: 'complete',
      entries: [
        {
          type: 'tool',
          name: 'shell',
          input: { command: 'pwd' },
          status: 'success',
          result: [{ type: 'text', text: '/workspace\n' }],
        },
      ],
    })
  })

  it('reports bang commands as unavailable when the backend has no sandbox execution capability', async () => {
    const controller = new ChatController(backend())

    await controller.submit('!pwd')

    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'error',
      title: 'shell unavailable',
      rows: [
        {
          label: '!pwd',
          description: expect.stringContaining('built-in Strands connection'),
        },
      ],
    })
  })

  it('queues a bang command behind a running turn', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const shellCommands: string[] = []
    const target = backend(async function* () {
      yield { type: 'textDelta', text: 'Working.' }
      await gate
      return { stopReason: 'endTurn' }
    })
    target.queueSteering = vi.fn(() => true)
    target.streamShell = async function* (command) {
      shellCommands.push(command)
      yield { type: 'toolStart', toolUseId: 'shell-1', name: 'shell', input: { command } }
      yield { type: 'toolResult', toolUseId: 'shell-1', status: 'success', content: [] }
      return { stopReason: 'endTurn' }
    }
    const controller = new ChatController(target)

    const running = controller.submit('work')
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('running'))
    const queued = controller.steer('!pwd')

    expect(target.queueSteering).not.toHaveBeenCalled()
    expect(controller.getSnapshot().queuedPrompts).toEqual([{ id: 'queued-1', prompt: '!pwd' }])
    expect(target.cancel).not.toHaveBeenCalled()

    release()
    await running
    await queued
    expect(shellCommands).toEqual(['pwd'])
  })

  it('publishes backend-owned tasks and exact context metrics', async () => {
    const controller = new ChatController(
      backend(async function* () {
        yield {
          type: 'tasks',
          tasks: [{ id: 'todo-1', label: 'Do work', status: 'in_progress', source: 'todo' }],
        }
        yield { type: 'context', usage: { currentTokens: 120, projectedTokens: 145, contextWindow: 1_000 } }
        yield { type: 'textDelta', text: 'done' }
        return {
          stopReason: 'endTurn',
          context: { inputTokens: 100, outputTokens: 25 },
        }
      })
    )

    await controller.submit('work')

    expect(controller.getSnapshot()).toMatchObject({
      status: 'idle',
      tasks: [{ id: 'todo-1', label: 'Do work', status: 'in_progress', source: 'todo' }],
      context: {
        currentTokens: 120,
        projectedTokens: 145,
        contextWindow: 1_000,
        inputTokens: 100,
        outputTokens: 25,
      },
      completedTurns: [{ status: 'complete', entries: [{ type: 'assistant', text: 'done' }] }],
    })
  })

  it('keeps an open tasks panel synchronized with idle backend updates', async () => {
    let taskListener: ((tasks: readonly ChatTask[]) => void) | undefined
    const stopWatching = vi.fn()
    const target = backend()
    target.watchTasks = (listener) => {
      taskListener = listener
      listener([])
      return stopWatching
    }
    const controller = new ChatController(target)

    await controller.submit('/tasks')
    taskListener?.([
      {
        id: 'task-completed',
        label: 'Archive report',
        status: 'completed',
        source: 'background',
      },
      {
        id: 'todo-1',
        label: 'Update documentation',
        status: 'in_progress',
        source: 'todo',
      },
      {
        id: 'task-failed',
        label: 'Run deployment',
        status: 'failed',
        source: 'background',
      },
      {
        id: 'task-waiting',
        label: 'Await approval',
        status: 'paused',
        source: 'background',
      },
      {
        id: 'task-1',
        label: 'Review authentication',
        status: 'working',
        source: 'background',
        detail: 'subagent | task-1',
      },
    ])

    expect(controller.getSnapshot()).toMatchObject({
      tasks: [
        { id: 'task-completed' },
        { id: 'todo-1' },
        { id: 'task-failed' },
        { id: 'task-waiting' },
        { id: 'task-1' },
      ],
      panel: {
        kind: 'tasks',
        title: 'Tasks (4)',
        searchable: true,
        rows: [
          {
            label: 'Review authentication',
            description: 'subagent · task-1',
            badge: { text: 'running', tone: 'success' },
          },
          {
            label: 'Await approval',
            badge: { text: 'waiting', tone: 'warning' },
          },
          {
            label: 'Archive report',
            badge: { text: 'completed', tone: 'success' },
          },
          {
            label: 'Run deployment',
            badge: { text: 'failed', tone: 'danger' },
          },
        ],
      },
    })

    await controller.dispose()
    expect(stopWatching).toHaveBeenCalledOnce()
  })

  it('shows and toggles the native wait-for-completion control', async () => {
    let waitForCompletion = false
    const setWaitForCompletion = vi.fn(async (value: boolean) => {
      waitForCompletion = value
    })
    const target = backend(async function* () {
      yield* []
      return { stopReason: 'endTurn', context: { currentTokens: 800, projectedTokens: 850, contextWindow: 200_000 } }
    })
    target.backgroundTasksWaitForCompletion = () => waitForCompletion
    target.setBackgroundTasksWaitForCompletion = setWaitForCompletion
    const controller = new ChatController(target)

    await controller.submit('seed context')
    expect(controller.getSnapshot().context.projectedTokens).toBe(850)
    await controller.submit('/tasks')
    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'tasks',
      waitForCompletion: false,
      rows: [],
    })

    await controller.activatePanelRow({
      label: 'Wait for completion',
      description: 'On',
      value: BACKGROUND_TASK_WAIT_TOGGLE,
    })

    expect(setWaitForCompletion).toHaveBeenCalledWith(true)
    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'tasks',
      waitForCompletion: true,
      rows: [],
    })
    expect(controller.getSnapshot().context).toEqual({})
  })

  it('blocks wait-mode changes while background work is unresolved', async () => {
    let taskListener: ((tasks: readonly ChatTask[]) => void) | undefined
    const setWaitForCompletion = vi.fn(async () => {})
    const target = backend()
    target.backgroundTasksWaitForCompletion = () => false
    target.setBackgroundTasksWaitForCompletion = setWaitForCompletion
    target.watchTasks = (listener) => {
      taskListener = listener
      listener([])
      return () => {}
    }
    const controller = new ChatController(target)
    taskListener?.([
      {
        id: 'task-1',
        label: 'background bash',
        status: 'working',
        source: 'background',
        deliveryState: 'pending',
      },
    ])

    await controller.submit('/tasks')
    await controller.activatePanelRow({
      label: 'Wait for completion',
      description: 'On',
      value: BACKGROUND_TASK_WAIT_TOGGLE,
    })

    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'error',
      title: 'task mode change blocked',
    })
    expect(setWaitForCompletion).not.toHaveBeenCalled()
  })

  it('opens a live background task detail panel and releases its subscription on close', async () => {
    let taskListener: ((tasks: readonly ChatTask[]) => void) | undefined
    let activityListener: ((activity: BackgroundAgentActivity | undefined) => void) | undefined
    const stopActivity = vi.fn()
    let activity: BackgroundAgentActivity = {
      toolUseId: 'dispatch-1',
      taskId: 'task-1',
      name: 'reviewer',
      task: 'Review authentication.',
      status: 'working',
      entries: [{ type: 'reasoning', text: 'Inspecting routes.' }],
    }
    const target = backend()
    target.watchTasks = (listener) => {
      taskListener = listener
      listener([])
      return () => {}
    }
    target.getTaskActivity = () => activity
    target.watchTaskActivity = (_taskId, listener) => {
      activityListener = listener
      listener(activity)
      return stopActivity
    }
    const controller = new ChatController(target)

    taskListener?.([
      {
        id: 'task-1',
        label: 'reviewer: Review authentication.',
        status: 'working',
        source: 'background',
        toolUseId: 'dispatch-1',
      },
    ])
    await controller.submit('/tasks')
    await controller.activatePanelRow(controller.getSnapshot().panel!.rows[0]!)

    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'detail',
      title: 'agent reviewer | working',
      activity: expect.objectContaining({
        name: 'reviewer',
        status: 'working',
        entries: expect.arrayContaining([{ type: 'reasoning', text: 'Inspecting routes.' }]),
      }),
    })

    activity = {
      ...activity,
      status: 'completed',
      entries: [
        ...activity.entries,
        {
          type: 'tool',
          toolUseId: 'child-tool-1',
          name: 'read',
          input: { path: 'auth.ts' },
          status: 'success',
          result: 'source',
        },
        { type: 'assistant', text: 'Authentication is sound.' },
      ],
    }
    const detailUpdates = vi.fn()
    controller.subscribe(detailUpdates)
    activityListener?.(activity)
    activityListener?.(activity)

    await vi.waitFor(() =>
      expect(controller.getSnapshot().panel).toMatchObject({
        title: 'agent reviewer | completed',
        activity: expect.objectContaining({
          status: 'completed',
          entries: expect.arrayContaining([{ type: 'assistant', text: 'Authentication is sound.' }]),
        }),
      })
    )
    expect(detailUpdates).toHaveBeenCalledOnce()
    expect(controller.getSnapshot().panel).toMatchObject({
      activity: {
        entries: expect.arrayContaining([expect.objectContaining({ type: 'tool', name: 'read', status: 'success' })]),
      },
    })

    expect(controller.dismissPanel()).toBe(true)
    expect(stopActivity).toHaveBeenCalledOnce()
  })

  it('shows one completion notice until the result is delivered', () => {
    let taskListener: ((tasks: readonly ChatTask[]) => void) | undefined
    const target = backend()
    target.watchTasks = (listener) => {
      taskListener = listener
      listener([])
      return () => {}
    }
    const controller = new ChatController(target)
    const task = {
      id: 'task-1',
      label: 'reviewer',
      source: 'background' as const,
      toolUseId: 'dispatch-1',
    }

    taskListener?.([{ ...task, status: 'working', deliveryState: 'pending' }])
    taskListener?.([{ ...task, status: 'completed', deliveryState: 'ready', result: 'No issue found.' }])

    expect(controller.getSnapshot().notices).toMatchObject([
      { status: 'success', text: 'Background task completed (reviewer)', taskId: 'task-1' },
    ])

    taskListener?.([])

    expect(controller.getSnapshot().notices).toEqual([])
  })

  it('stays interactive while background work runs and wakes the agent when a result is ready', async () => {
    let taskListener: ((tasks: readonly ChatTask[]) => void) | undefined
    let resultReady = false
    const prompts: string[] = []
    const target = backend(async function* (prompt) {
      prompts.push(prompt)
      yield { type: 'textDelta', text: `reply to ${prompt}` }
      return { stopReason: 'endTurn' }
    })
    target.watchTasks = (listener) => {
      taskListener = listener
      listener([])
      return () => {}
    }
    target.hasReadyBackgroundResults = () => resultReady
    target.streamBackgroundResults = async function* () {
      resultReady = false
      yield { type: 'reasoningDelta', text: 'Considering the completed review.' }
      yield { type: 'textDelta', text: 'The background review found no issues.' }
      return { stopReason: 'endTurn' }
    }
    const controller = new ChatController(target)
    const task = {
      id: 'task-1',
      label: 'reviewer: Review authentication.',
      status: 'working' as const,
      source: 'background' as const,
      deliveryState: 'pending' as const,
    }

    taskListener?.([task])
    expect(controller.getSnapshot().status).toBe('idle')
    await controller.submit('Can we discuss something else?')
    expect(prompts).toEqual(['Can we discuss something else?'])

    resultReady = true
    taskListener?.([{ ...task, status: 'completed', deliveryState: 'ready' }])
    await vi.waitFor(() => expect(controller.getSnapshot().completedTurns).toHaveLength(2))

    expect(controller.getSnapshot().completedTurns[1]).toMatchObject({
      prompt: '',
      source: 'background',
      status: 'complete',
      entries: [
        { type: 'reasoning', text: 'Considering the completed review.' },
        { type: 'assistant', text: 'The background review found no issues.' },
      ],
    })
  })

  it('queues an automatic result continuation behind an active user turn', async () => {
    let taskListener: ((tasks: readonly ChatTask[]) => void) | undefined
    let releaseUserTurn!: () => void
    let resultReady = false
    let backgroundRuns = 0
    const userTurn = new Promise<void>((resolve) => {
      releaseUserTurn = resolve
    })
    const target = backend(async function* () {
      await userTurn
      yield { type: 'textDelta', text: 'Foreground response.' }
      return { stopReason: 'endTurn' }
    })
    target.watchTasks = (listener) => {
      taskListener = listener
      listener([])
      return () => {}
    }
    target.hasReadyBackgroundResults = () => resultReady
    target.streamBackgroundResults = async function* () {
      backgroundRuns += 1
      resultReady = false
      yield { type: 'textDelta', text: 'Background result received.' }
      return { stopReason: 'endTurn' }
    }
    target.streamPeer = async function* () {
      yield { type: 'textDelta', text: 'Peer message received.' }
      return { stopReason: 'endTurn' }
    }
    const controller = new ChatController(target)
    const running = controller.submit('Keep chatting.')
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('running'))

    resultReady = true
    taskListener?.([
      {
        id: 'task-1',
        label: 'reviewer',
        status: 'completed',
        source: 'background',
        deliveryState: 'ready',
      },
    ])
    controller.enqueuePeerMessage({
      from: { id: 'agent-2', name: 'Reviewer' },
      body: 'One more thing.',
    })
    await Promise.resolve()
    expect(backgroundRuns).toBe(0)

    releaseUserTurn()
    await running
    await vi.waitFor(() => expect(controller.getSnapshot().completedTurns).toHaveLength(3))
    expect(backgroundRuns).toBe(1)
    expect(controller.getSnapshot().completedTurns.map((turn) => turn.source ?? 'user')).toEqual([
      'user',
      'background',
      'peer',
    ])
  })

  it('attempts each ready background-task generation only once after delivery failure', async () => {
    let taskListener: ((tasks: readonly ChatTask[]) => void) | undefined
    let attempts = 0
    const target = backend()
    target.watchTasks = (listener) => {
      taskListener = listener
      listener([])
      return () => {}
    }
    target.hasReadyBackgroundResults = () => true
    target.streamBackgroundResults = async function* () {
      attempts += 1
      yield* []
      throw new Error('provider unavailable')
    }
    const controller = new ChatController(target)
    const ready = {
      id: 'task-1',
      label: 'reviewer',
      status: 'completed' as const,
      source: 'background' as const,
      deliveryState: 'ready' as const,
      result: 'done',
    }

    taskListener?.([ready])
    await vi.waitFor(() => expect(controller.getSnapshot().completedTurns).toHaveLength(1))
    taskListener?.([ready])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(attempts).toBe(1)

    taskListener?.([{ ...ready, id: 'task-2' }])
    await vi.waitFor(() => expect(attempts).toBe(2))
  })

  it('shows unknown context values before the first model response', async () => {
    const controller = new ChatController(backend())

    await controller.submit('/context')

    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'context',
      rows: [],
    })
    expect(controller.getSnapshot().context).toEqual({})
  })

  it('replaces final context instead of retaining unavailable fields from the prior turn', async () => {
    let turn = 0
    const controller = new ChatController(
      backend(async function* () {
        yield* []
        turn++
        return turn === 1
          ? {
              stopReason: 'endTurn',
              context: {
                currentTokens: 100,
                projectedTokens: 125,
                contextWindow: 1_000,
                inputTokens: 100,
                outputTokens: 25,
                totalTokens: 125,
              },
            }
          : {
              stopReason: 'endTurn',
              context: {
                projectedTokens: 155,
                contextWindow: 1_000,
                totalTokens: 155,
              },
            }
      })
    )

    await controller.submit('first')
    await controller.submit('second')

    expect(controller.getSnapshot().context).toEqual({
      projectedTokens: 155,
      contextWindow: 1_000,
      totalTokens: 155,
    })
  })

  it('restores the prior context when a turn fails after a partial update', async () => {
    let turn = 0
    const controller = new ChatController(
      backend(async function* () {
        turn++
        if (turn === 1) {
          return {
            stopReason: 'endTurn',
            context: {
              currentTokens: 100,
              projectedTokens: 125,
              contextWindow: 1_000,
            },
          }
        }
        yield { type: 'context', usage: { currentTokens: 200, projectedTokens: 250, contextWindow: 1_000 } }
        throw new Error('model failed')
      })
    )

    await controller.submit('first')
    const expected = { currentTokens: 100, projectedTokens: 125, contextWindow: 1_000 }
    expect(controller.getSnapshot().context).toEqual(expected)

    await controller.submit('second')

    expect(controller.getSnapshot().context).toEqual(expected)
  })

  it('returns control immediately, forwards repeated cancellation, and queues the next turn behind the SDK lock', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const prompts: string[] = []
    const target = backend(async function* (prompt) {
      prompts.push(prompt)
      if (prompt === 'long task') {
        yield { type: 'toolStart', toolUseId: 'tool-1', name: 'bash', input: { command: 'sleep 10' } }
        await gate
        return { stopReason: 'cancelled' }
      }
      yield { type: 'textDelta', text: 'Ready again.' }
      return { stopReason: 'endTurn' }
    })
    const controller = new ChatController(target)
    const running = controller.submit('long task')
    await vi.waitFor(() => expect(controller.getSnapshot().activeTurn?.entries).toHaveLength(1))

    expect(controller.cancel()).toBe(true)
    expect(target.cancel).toHaveBeenCalledOnce()
    expect(controller.getSnapshot()).toMatchObject({
      status: 'interrupting',
      completedTurns: [{ status: 'cancelled' }],
    })
    expect(controller.getSnapshot().activeTurn).toBeUndefined()
    expect(controller.getSnapshot().completedTurns[0]?.entries[0]).toMatchObject({
      type: 'tool',
      status: 'cancelled',
    })
    expect(controller.cancel()).toBe(true)
    expect(target.cancel).toHaveBeenCalledTimes(2)
    const queued = controller.submit('next task')
    await Promise.resolve()
    expect(prompts).toEqual(['long task'])

    release()
    await Promise.all([running, queued])
    expect(prompts).toEqual(['long task', 'next task'])
    expect(controller.getSnapshot().completedTurns.map((turn) => turn.status)).toEqual(['cancelled', 'complete'])
  })

  it('keeps attachment content while a prompt waits in the queue', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const prompts: Array<string | ContentBlockData[]> = []
    const controller = new ChatController(
      idleBackend({
        id: 'attachment-queue-test',
        async *stream(prompt) {
          prompts.push(prompt)
          yield { type: 'textDelta', text: 'Done.' }
          if (typeof prompt === 'string') {
            await gate
          }
          return { stopReason: 'endTurn' }
        },
      })
    )
    const first = controller.submit('first')
    await vi.waitFor(() => expect(prompts).toEqual(['first']))
    const queued = controller.submit({
      text: 'second',
      attachments: [
        {
          path: '/tmp/notes.md',
          name: 'notes.md',
          size: 5,
          kind: 'document',
          content: { document: { name: 'notes md', format: 'md', source: { text: 'hello' } } },
        },
      ],
    })

    expect(controller.getSnapshot().queuedPrompts).toEqual([
      {
        id: 'queued-1',
        prompt: 'second',
        attachments: [{ name: 'notes.md', size: 5, kind: 'document' }],
      },
    ])

    release()
    await Promise.all([first, queued])
    expect(prompts).toEqual([
      'first',
      [{ text: 'second' }, { document: { name: 'notes md', format: 'md', source: { text: 'hello' } } }],
    ])
  })

  it('accepts and runs queued prompts in order while the active turn continues', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const prompts: string[] = []
    const target = backend(async function* (prompt) {
      prompts.push(prompt)
      if (prompt === 'first') {
        yield { type: 'textDelta', text: 'Working.' }
        await gate
      }
      return { stopReason: 'endTurn' }
    })
    const controller = new ChatController(target)
    const idle = vi.fn()
    controller.subscribe(() => {
      if (!controller.busy) idle()
    })

    const first = controller.submit('first')
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('running'))
    const second = controller.submit('second')
    const third = controller.submit('third')

    expect(prompts).toEqual(['first'])
    expect(controller.getSnapshot().queuedPrompts).toEqual([
      { id: 'queued-1', prompt: 'second' },
      { id: 'queued-2', prompt: 'third' },
    ])

    release()
    await Promise.all([first, second, third])

    expect(prompts).toEqual(['first', 'second', 'third'])
    expect(controller.getSnapshot().queuedPrompts).toEqual([])
    expect(controller.getSnapshot().completedTurns.map((turn) => turn.prompt)).toEqual(['first', 'second', 'third'])
    await vi.waitFor(() => expect(idle).toHaveBeenCalledOnce())
  })

  it('queues peer messages at the turn boundary without interpreting them as local commands', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const prompts: string[] = []
    const peerMessages: string[] = []
    const target = backend(async function* (prompt) {
      prompts.push(prompt)
      if (prompt === 'first') {
        yield { type: 'textDelta', text: 'Working.' }
        await gate
      }
      return { stopReason: 'endTurn' }
    })
    target.streamPeer = async function* (message) {
      peerMessages.push(message.body)
      yield { type: 'textDelta', text: 'Peer message handled.' }
      return { stopReason: 'endTurn' }
    }
    const controller = new ChatController(target)
    const message = {
      from: { id: 'agent-2', name: 'Reviewer' },
      body: '/exit',
    }

    const first = controller.submit('first')
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('running'))
    expect(controller.enqueuePeerMessage(message)).toBe(true)
    const human = controller.submit('human follow-up')

    expect(controller.getSnapshot().queuedPrompts).toEqual([
      { id: 'queued-1', prompt: '/exit', source: 'peer', from: 'Reviewer' },
      { id: 'queued-2', prompt: 'human follow-up' },
    ])

    release()
    await Promise.all([first, human])
    await vi.waitFor(() => expect(controller.getSnapshot().completedTurns).toHaveLength(3))

    expect(prompts).toEqual(['first', 'human follow-up'])
    expect(peerMessages).toEqual(['/exit'])
    expect(controller.getSnapshot()).toMatchObject({
      status: 'idle',
      completedTurns: [
        { prompt: 'first' },
        {
          prompt: '/exit',
          source: 'peer',
          peer: { id: 'agent-2', name: 'Reviewer' },
          entries: [{ type: 'assistant', text: 'Peer message handled.' }],
        },
        { prompt: 'human follow-up' },
      ],
    })
  })

  it('caps the pending peer inbox while a turn is running', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const target = backend(async function* () {
      yield { type: 'textDelta', text: 'Working.' }
      await gate
      return { stopReason: 'endTurn' }
    })
    target.streamPeer = async function* () {
      yield* []
      return { stopReason: 'endTurn' }
    }
    const controller = new ChatController(target)
    const running = controller.submit('first')
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('running'))

    for (let index = 0; index < 32; index += 1) {
      expect(
        controller.enqueuePeerMessage({
          from: { id: 'agent-2', name: 'Reviewer' },
          body: `Message ${index}.`,
        })
      ).toBe(true)
    }
    expect(
      controller.enqueuePeerMessage({
        from: { id: 'agent-2', name: 'Reviewer' },
        body: 'Overflow.',
      })
    ).toBe(false)

    controller.close()
    release()
    await running
  })

  it('interrupts for steering and runs that prompt ahead of queued follow-ups', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const prompts: string[] = []
    const target = backend(async function* (prompt) {
      prompts.push(prompt)
      if (prompt === 'first') {
        yield { type: 'textDelta', text: 'Initial direction.' }
        await gate
      }
      return { stopReason: 'endTurn' }
    })
    target.queueSteering = vi.fn(() => true)
    target.drainSteering = vi.fn().mockReturnValueOnce(['change direction now']).mockReturnValue([])
    const controller = new ChatController(target)

    const first = controller.submit('first')
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('running'))
    const queued = controller.submit('ordinary follow-up')
    const steering = controller.steer('change direction now')

    expect(target.cancel).not.toHaveBeenCalled()
    expect(controller.cancel()).toBe(true)
    expect(target.cancel).toHaveBeenCalledOnce()
    expect(controller.getSnapshot().queuedPrompts.map((prompt) => prompt.prompt)).toEqual([
      'change direction now',
      'ordinary follow-up',
    ])

    release()
    await Promise.all([first, steering, queued])

    expect(prompts).toEqual(['first', 'change direction now', 'ordinary follow-up'])
    expect(controller.getSnapshot().completedTurns.map((turn) => turn.status)).toEqual([
      'cancelled',
      'complete',
      'complete',
    ])
  })

  it('injects steering into a running turn without cancelling it', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const target = backend(async function* () {
      yield { type: 'textDelta', text: 'Working.' }
      await gate
      return { stopReason: 'endTurn' }
    })
    let consumeSteering = (): void => {}
    target.queueSteering = vi.fn((_prompt, onConsumed) => {
      consumeSteering = onConsumed
      return true
    })
    target.drainSteering = () => []
    const controller = new ChatController(target)

    const running = controller.submit('first')
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('running'))
    await controller.steer('change direction now')

    expect(target.queueSteering).toHaveBeenCalledWith('change direction now', expect.any(Function))
    expect(target.cancel).not.toHaveBeenCalled()
    expect(controller.getSnapshot()).toMatchObject({
      pendingSteering: ['change direction now'],
      queuedPrompts: [],
    })

    consumeSteering()
    expect(controller.getSnapshot().pendingSteering).toEqual([])
    expect(controller.getSnapshot().activeTurn?.entries).toEqual([
      expect.objectContaining({ type: 'assistant', text: 'Working.' }),
      expect.objectContaining({ type: 'user', text: 'change direction now' }),
    ])
    release()
    await running
  })

  it('closes on exit words and converts backend failures into turn errors', async () => {
    const target = backend(async function* () {
      yield* []
      throw new Error('provider unavailable')
    })
    const controller = new ChatController(target)

    await controller.submit('hello')
    expect(controller.getSnapshot().completedTurns[0]).toMatchObject({
      status: 'error',
      error: 'provider unavailable',
    })

    await controller.submit('QUIT')
    expect(controller.getSnapshot()).toMatchObject({ status: 'closed', exitCode: 0 })
  })

  it.each([false, true])('surfaces a credential failure with session recovery (attachment=%s)', async (attachment) => {
    const target = idleBackend({
      async *stream() {
        yield* []
        throw new Error('The security token included in the request is expired')
      },
    })
    Object.assign(target, {
      sessionIdentity: {
        sessionId: 'saved-session',
        sessionDirectory: '/tmp/saved-sessions',
        workspace: process.cwd(),
        configured: { sessionId: null, sessionDir: '/tmp/saved-sessions' },
      },
    })
    const controller = new ChatController(target, { streamPresentation: {} })

    await controller.submit(
      attachment
        ? {
            text: '!describe this image',
            attachments: [
              {
                path: '/tmp/image.png',
                name: 'image.png',
                size: 1,
                kind: 'image',
                content: { image: { format: 'png', source: { bytes: new Uint8Array([0]) } } },
              },
            ],
          }
        : 'hello'
    )

    expect(controller.getSnapshot()).toMatchObject({
      status: 'idle',
      completedTurns: [
        {
          status: 'error',
          error: 'The security token included in the request is expired',
          recoveryHint: expect.stringContaining('Refresh your credentials, then resend your message.'),
        },
      ],
    })
    expect(controller.getSnapshot().completedTurns[0]?.recoveryHint).toContain('strands --session-id saved-session')
    expect(controller.getSnapshot().activeTurn).toBeUndefined()
    expect(controller.busy).toBe(false)
    await controller.dispose()
  })

  it('marks a silent response as delayed, clears on progress, and allows exit while cancellation is stuck', async () => {
    vi.useFakeTimers()
    let respond!: () => void
    let finish!: () => void
    const response = new Promise<void>((resolve) => {
      respond = resolve
    })
    const completion = new Promise<void>((resolve) => {
      finish = resolve
    })
    const target = backend(async function* () {
      await response
      yield { type: 'textDelta', text: 'Still here' }
      await completion
      return { stopReason: 'cancelled' }
    })
    let permissionChanged!: (request: ChatPermissionRequest | undefined) => void
    target.watchPermissions = (listener) => {
      permissionChanged = listener
      return () => {}
    }
    const controller = new ChatController(target)
    const running = controller.submit('hello')
    try {
      await vi.advanceTimersByTimeAsync(29_999)
      expect(controller.getSnapshot().activeTurn?.responseDelayed).toBeUndefined()
      permissionChanged({ id: 'background-permission', toolName: 'shell', input: {}, options: [] })
      await vi.advanceTimersByTimeAsync(1)
      expect(controller.getSnapshot().panel?.kind).toBe('permission')
      permissionChanged(undefined)
      expect(controller.getSnapshot().panel).toBeUndefined()
      expect(controller.getSnapshot().activeTurn?.responseDelayed).toBe(true)
      respond()
      await vi.advanceTimersByTimeAsync(0)
      expect(controller.getSnapshot().activeTurn?.responseDelayed).toBeUndefined()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(controller.getSnapshot().activeTurn?.responseDelayed).toBe(true)
      controller.cancel()
      expect(controller.getSnapshot().completedTurns[0]).toMatchObject({ status: 'cancelled' })
      expect(controller.getSnapshot().completedTurns[0]?.responseDelayed).toBeUndefined()
      await controller.submit('/exit')
      expect(controller.getSnapshot().status).toBe('closed')
      expect(controller.hardExitCode).toBe(130)
    } finally {
      respond()
      finish()
      await running
      await controller.dispose()
      vi.useRealTimers()
    }
  })

  it.each(['tool', 'permission', 'shell'] as const)(
    'does not label a %s wait as a delayed model response',
    async (kind) => {
      vi.useFakeTimers()
      let finish!: () => void
      const completion = new Promise<void>((resolve) => {
        finish = resolve
      })
      const stream = async function* (): AsyncGenerator<ChatEvent, ChatRunResult, undefined> {
        if (kind === 'tool') {
          yield { type: 'toolStart', toolUseId: 'slow-tool', name: 'shell', input: {} }
        } else if (kind === 'permission') {
          yield {
            type: 'permission',
            request: { id: 'permission', toolName: 'shell', input: {}, options: [] },
          }
        }
        await completion
        return { stopReason: 'endTurn' }
      }
      const target = backend(stream)
      target.streamShell = stream
      const controller = new ChatController(target)
      const running = controller.submit(kind === 'shell' ? '!sleep 60' : 'hello')
      try {
        await vi.advanceTimersByTimeAsync(60_000)
        expect(controller.getSnapshot().activeTurn?.status).toBe('running')
        expect(controller.getSnapshot().activeTurn?.responseDelayed).toBeUndefined()
      } finally {
        finish()
        await running
        await controller.dispose()
        vi.useRealTimers()
      }
    }
  )

  it('shows all built-in provider filters when discovery returns no models', async () => {
    const target = backend()
    target.info = () => ({ model: 'bedrock/current-model' })
    target.listModels = vi.fn(() => [])
    const controller = new ChatController(target)

    await controller.openModelPanel()

    const panel = controller.getSnapshot().panel!
    expect(panel.filters).toEqual([
      { id: 'all', label: 'All' },
      { id: 'bedrock', label: 'Amazon Bedrock' },
      { id: 'bedrock-mantle', label: 'Amazon Bedrock (Mantle)' },
      { id: 'anthropic', label: 'Anthropic' },
      { id: 'openai', label: 'OpenAI' },
      { id: 'google', label: 'Google Gemini' },
      { id: 'ollama', label: 'Ollama' },
      { id: 'litellm', label: 'LiteLLM' },
    ])
    expect(panel.rows).toHaveLength(1)
    expect(panel.rows.flatMap((row) => (row.value ? [row.value] : []))).toEqual([])
    expect(target.listModels).toHaveBeenCalledOnce()
  })

  it.each([undefined, 'openai', 'remote-catalog'])(
    'keeps ACP provider filters limited to its reported catalog: %s',
    async (catalog) => {
      const target = backend()
      target.listModels = () => [
        { id: 'remote-model', name: 'Remote model', description: '', ...(catalog ? { catalog } : {}) },
        { id: 'other-model', name: 'Other model', description: '', ...(catalog ? { catalog } : {}) },
      ]
      const controller = new ChatController({ ...target, protocol: 'acp' })

      await controller.openModelPanel()

      expect(controller.getSnapshot().panel?.filters).toEqual([
        { id: 'all', label: 'All' },
        ...(catalog ? [{ id: catalog, label: catalog === 'openai' ? 'OpenAI' : catalog }] : []),
      ])
      expect(controller.getSnapshot().panel?.rows).toHaveLength(2)
    }
  )

  it('rebuilds immediately for a model change that requires restart', async () => {
    const target = backend(async function* () {
      yield* []
      return {
        stopReason: 'endTurn',
        context: { currentTokens: 800, projectedTokens: 850, contextWindow: 200_000 },
      }
    })
    const currentId = 'bedrock/current-model'
    const nextId = 'bedrock/next-model'
    let currentModel = currentId
    target.info = () => ({ model: currentModel })
    target.listModels = () => [
      { id: currentId, name: 'Current Model', description: 'current', active: true },
      { id: nextId, name: 'Next Model', description: 'other model' },
    ]
    target.modelChangeMode = () => 'restart'
    target.switchModel = vi.fn()
    target.restartModel = vi.fn(async () => {
      currentModel = nextId
      return currentModel
    })
    const controller = new ChatController(target)

    await controller.submit('seed context')
    expect(controller.getSnapshot().context.projectedTokens).toBe(850)
    await controller.submit('/model')
    expect(controller.getSnapshot().panel?.kind).toBe('models')
    expect(controller.getSnapshot().panel?.rows[0]).toMatchObject({
      label: 'Current Model',
      badge: { text: 'current', tone: 'success' },
    })
    expect(controller.getSnapshot().panel?.rows[1]).toMatchObject({
      label: 'Next Model',
    })
    expect(controller.getSnapshot().panel?.rows[1]?.badge).toBeUndefined()
    expect(controller.getSnapshot().panel?.rows[1]?.tone).toBeUndefined()
    expect(controller.getSnapshot().panel?.body).toBe('bedrock/current-model\nbedrock/current-model')
    const nextIndex = controller.getSnapshot().panel?.rows.findIndex((row) => row.value === nextId) ?? -1
    expect(nextIndex).toBeGreaterThanOrEqual(0)
    await controller.activatePanelRow(controller.getSnapshot().panel!.rows[nextIndex]!)
    expect(target.restartModel).toHaveBeenCalledWith(nextId)
    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'models',
      body: `${nextId}\n${nextId}`,
      rows: [{ label: 'Current Model' }, { label: 'Next Model', badge: { text: 'current', tone: 'success' } }],
    })
    expect(controller.getSnapshot().runtime.model).toBe(nextId)
    expect(controller.getSnapshot().context).toEqual({})
  })

  it('continues to effort after selecting a model that supports it', async () => {
    const target = backend()
    let model = 'bedrock/current-model'
    target.info = () => ({ model, effort: 'Low' })
    target.listModels = () => [
      { id: model, name: 'Current Model', description: '', active: true },
      { id: 'bedrock/next-model', name: 'Next Model', description: '' },
    ]
    target.listEfforts = vi.fn(() => [
      { id: 'low', label: 'Low', active: true },
      { id: 'high', label: 'High' },
    ])
    target.switchModel = vi.fn(async (selected) => {
      model = selected
      return selected
    })
    const controller = new ChatController(target)

    await controller.openModelPanel()
    expect(controller.getSnapshot().panel).not.toHaveProperty('slider')
    expect(target.listEfforts).not.toHaveBeenCalled()
    await controller.activatePanelRow(controller.getSnapshot().panel!.rows[1]!)

    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'effort',
      body: 'bedrock/next-model\nbedrock/next-model',
    })
  })

  it('sets effort from /effort and opens an effort-only panel without an argument', async () => {
    const target = backend()
    let effort = 'high'
    target.info = () => ({ model: 'bedrock/current-model', effort: effort === 'low' ? 'Low' : 'High' })
    target.listModels = vi.fn(() => [
      { id: 'bedrock/current-model', name: 'Current Model', description: '', active: true },
    ])
    target.listEfforts = () => [
      { id: 'low', label: 'Low', ...(effort === 'low' ? { active: true } : {}) },
      { id: 'high', label: 'High', ...(effort === 'high' ? { active: true } : {}) },
    ]
    target.setEffort = vi.fn(async (selected) => {
      effort = selected
      return selected
    })
    const controller = new ChatController(target)

    await controller.submit('/effort LOW')
    expect(target.setEffort).toHaveBeenCalledWith('low')
    expect(target.listModels).not.toHaveBeenCalled()
    expect(controller.getSnapshot().panel).toBeUndefined()
    expect(controller.getSnapshot().runtime.effort).toBe('Low')

    await controller.submit('/effort')
    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'effort',
      rows: [],
      slider: { options: [{ id: 'low', active: true }, { id: 'high' }] },
    })
    expect(target.listModels).not.toHaveBeenCalled()

    await controller.activatePanelRow({ label: 'Effort', description: 'High', value: 'effort:high' })
    expect(target.setEffort).toHaveBeenLastCalledWith('high')
    expect(controller.getSnapshot().panel).toHaveProperty('slider.options', [
      { id: 'low', label: 'Low' },
      expect.objectContaining({ id: 'high', active: true }),
    ])

    await controller.submit('/model')
    expect(controller.getSnapshot().panel?.kind).toBe('models')
  })

  it('reports /effort as unavailable when the model has no effort levels', async () => {
    const target = backend()
    target.info = () => ({ model: 'ollama/llama3.2' })
    target.listEfforts = () => []
    const controller = new ChatController(target)

    await controller.submit('/effort')

    expect(controller.getSnapshot().panel).toMatchObject({ kind: 'error', title: 'effort unavailable' })
  })

  it('reports an unsupported /effort level as an error', async () => {
    const target = backend()
    target.info = () => ({ model: 'bedrock/model', effort: 'High' })
    target.setEffort = vi.fn(async () => {
      throw new ModelControlError('Reasoning effort "turbo" is not supported. Choose: low, high, auto.')
    })
    const controller = new ChatController(target)

    await controller.submit('/effort turbo')
    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'error',
      title: 'effort change failed',
      rows: [{ description: 'Reasoning effort "turbo" is not supported. Choose: low, high, auto.' }],
    })
    expect(controller.getSnapshot().runtime).toMatchObject({ model: 'bedrock/model', effort: 'High' })
  })

  it('catches invalid model arguments before backend mode selection can escape the TUI', async () => {
    const target = backend()
    target.info = () => ({ model: 'ollama/test-model', effort: 'Auto' })
    target.modelChangeMode = (model) => {
      resolveModelTarget(model)
      return 'restart'
    }
    target.restartModel = vi.fn()
    const controller = new ChatController(target)

    await expect(controller.submit('/model unknown/invalid-id')).resolves.toBeUndefined()
    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'error',
      rows: [{ description: 'Unsupported model provider "unknown". Use /model to choose a model.' }],
    })
    expect(controller.getSnapshot().runtime).toMatchObject({ model: 'ollama/test-model', effort: 'Auto' })
    expect(target.restartModel).not.toHaveBeenCalled()
  })

  it.each(['model', 'effort'] as const)('keeps raw provider failures out of /%s errors', async (command) => {
    const target = backend()
    target.info = () => ({ model: 'ollama/qwen3:8b', effort: 'Auto' })
    const failure = vi.fn(async () => {
      throw new Error('HTTP 400 {"provider":"raw response"}\n    at provider.request (sdk.js:12)')
    })
    target.restartModel = failure
    target.setEffort = failure
    const controller = new ChatController(target)

    await controller.submit(`/${command} invalid`)
    expect(failure).toHaveBeenCalledOnce()
    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'error',
      rows: [{ description: `Could not change ${command}. Check your provider connection and try again.` }],
    })
    expect(controller.getSnapshot().runtime).toMatchObject({ model: 'ollama/qwen3:8b', effort: 'Auto' })
  })

  it('keeps live controls available and defers the latest model change', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const currentId = 'bedrock/current-model'
    const nextId = 'bedrock/next-model'
    const latestId = 'bedrock/latest-model'
    let currentModel = currentId
    const target = backend(async function* () {
      yield { type: 'textDelta', text: 'Working.' }
      await gate
      return { stopReason: 'endTurn' }
    })
    target.info = () => ({ model: currentModel })
    target.listModels = () => [
      { id: currentId, name: 'Current Model', description: 'current', active: true },
      { id: nextId, name: 'Next Model', description: 'other model' },
      { id: latestId, name: 'Latest Model', description: 'latest choice' },
    ]
    target.modelChangeMode = () => 'restart'
    target.switchModel = vi.fn()
    target.restartModel = vi.fn(async (modelId) => {
      currentModel = modelId
      return currentModel
    })
    const controller = new ChatController(target)

    const running = controller.submit('long task')
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('running'))

    await controller.submit('/settings')
    expect(controller.getSnapshot().panel?.kind).toBe('settings')
    await controller.submit('/context')
    expect(controller.getSnapshot().panel?.kind).toBe('context')
    await controller.submit('/model')
    expect(controller.getSnapshot().panel?.kind).toBe('models')
    expect(controller.getSnapshot().queuedPrompts).toEqual([])
    expect(target.cancel).not.toHaveBeenCalled()

    const nextIndex = controller.getSnapshot().panel?.rows.findIndex((row) => row.value === nextId) ?? -1
    expect(nextIndex).toBeGreaterThanOrEqual(0)
    await controller.activatePanelRow(controller.getSnapshot().panel!.rows[nextIndex]!)
    expect(target.restartModel).not.toHaveBeenCalled()
    expect(controller.getSnapshot().notices).toEqual([
      expect.objectContaining({
        status: 'running',
        text: 'Model change queued for after the current turn: bedrock/next-model',
      }),
    ])

    await controller.openModelPanel()
    const latestIndex = controller.getSnapshot().panel?.rows.findIndex((row) => row.value === latestId) ?? -1
    expect(latestIndex).toBeGreaterThanOrEqual(0)
    await controller.activatePanelRow(controller.getSnapshot().panel!.rows[latestIndex]!)
    expect(controller.getSnapshot().notices).toEqual([
      expect.objectContaining({
        status: 'delivered',
        text: 'Model change to bedrock/next-model superseded by bedrock/latest-model',
      }),
      expect.objectContaining({
        status: 'running',
        text: 'Model change queued for after the current turn: bedrock/latest-model',
      }),
    ])

    release()
    await running

    expect(target.restartModel).toHaveBeenCalledOnce()
    expect(target.restartModel).toHaveBeenCalledWith(latestId)
    expect(controller.getSnapshot().runtime.model).toBe(latestId)
    expect(controller.getSnapshot().notices[1]).toMatchObject({
      status: 'delivered',
      text: 'Model changed to bedrock/latest-model',
    })
  })

  it('blocks agent replacement while background work is unresolved', async () => {
    let taskListener: ((tasks: readonly ChatTask[]) => void) | undefined
    const target = backend()
    target.watchTasks = (listener) => {
      taskListener = listener
      listener([])
      return () => {}
    }
    target.listModels = () => [
      { id: 'old', name: 'old', description: 'current', active: true },
      { id: 'new', name: 'new', description: 'other family' },
    ]
    target.modelChangeMode = () => 'restart'
    target.switchModel = vi.fn()
    target.restartModel = vi.fn()
    const controller = new ChatController(target)
    taskListener?.([
      {
        id: 'task-1',
        label: 'reviewer',
        status: 'working',
        source: 'background',
        deliveryState: 'pending',
      },
    ])

    await controller.submit('/model')
    await controller.activatePanelRow(controller.getSnapshot().panel!.rows[1]!)

    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'error',
      title: 'model change blocked',
    })
    expect(target.restartModel).not.toHaveBeenCalled()
  })

  it('shows cached sessions immediately while refreshing them in the background', async () => {
    let resolveRefresh!: (sessions: { id: string; name?: string; active: boolean }[]) => void
    const refresh = new Promise<{ id: string; name?: string; active: boolean }[]>((resolve) => {
      resolveRefresh = resolve
    })
    let listing = 0
    const list = vi.fn(() => {
      listing++
      return listing === 1 ? Promise.resolve([{ id: 'session-1', name: 'Initial name', active: true }]) : refresh
    })
    const controller = new ChatController(backend(), {
      sessions: {
        current: 'session-1',
        directory: '/tmp/sessions',
        list,
        resolve: async (reference) => ({
          reference,
          sessionId: 'session-1',
          sessionDirectory: '/tmp/sessions',
          workspace: '/tmp',
          active: true,
        }),
      },
    })

    await controller.submit('/sessions')
    controller.dismissPanel()
    await controller.submit('/sessions')

    const cachedPanelId = controller.getSnapshot().panel?.id
    expect(list).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'sessions',
      title: 'Sessions (1)',
      rows: [{ label: 'Initial name' }],
    })

    resolveRefresh([
      { id: 'session-1', name: 'Updated name', active: true },
      { id: 'session-2', active: false },
    ])
    await vi.waitFor(() => expect(controller.getSnapshot().panel?.title).toBe('Sessions (2)'))
    expect(controller.getSnapshot().panel).toMatchObject({
      id: cachedPanelId,
      rows: [{ label: 'Updated name' }, { label: 'session-2' }],
    })
  })

  it('renames the current saved session and refreshes the sessions panel', async () => {
    let name: string | undefined
    const renameCurrent = vi.fn(async (nextName: string) => {
      name = nextName
      return { sessionId: 'session-1', name: nextName }
    })
    const controller = new ChatController(backend(), {
      runtime: { session: 'session-1' },
      sessions: {
        current: 'session-1',
        directory: '/tmp/sessions',
        list: vi.fn(async () => [{ id: 'session-1', ...(name ? { name } : {}), active: true }]),
        resolve: async (reference) => ({
          reference,
          sessionId: 'session-1',
          sessionDirectory: '/tmp/sessions',
          workspace: '/tmp',
          active: true,
        }),
        renameCurrent,
      },
    })

    await controller.submit('/sessions')
    controller.dismissPanel()
    await controller.submit('/sessions rename Release planning')

    expect(renameCurrent).toHaveBeenCalledWith('Release planning')
    expect(controller.getSnapshot()).toMatchObject({
      runtime: { session: 'Release planning' },
      panel: {
        kind: 'sessions',
        rows: [
          {
            label: 'Release planning',
            description: '',
            columns: ['unknown workspace', '—', 'not saved yet'],
            current: true,
          },
        ],
      },
    })
  })

  it('generates a session name in the background without replacing another panel', async () => {
    let resolveName!: (name: string) => void
    const generated = new Promise<string>((resolve) => {
      resolveName = resolve
    })
    const target = backend()
    target.generateSessionName = vi.fn(() => generated)
    const renameCurrent = vi.fn(async (name: string) => ({ sessionId: 'session-1', name }))
    const controller = new ChatController(target, {
      runtime: { session: 'Original name' },
      sessions: {
        current: 'session-1',
        directory: '/tmp/sessions',
        list: vi.fn(async () => [{ id: 'session-1', name: 'Original name', active: true }]),
        resolve: async () => ({
          sessionId: 'session-1',
          sessionDirectory: '/tmp/sessions',
          workspace: '/tmp',
          active: true,
        }),
        renameCurrent,
      },
    })

    await controller.submit('/sessions rename')
    expect(controller.busy).toBe(false)
    expect(controller.getSnapshot().notices).toMatchObject([{ status: 'running', text: 'Generating session name' }])
    await controller.submit('/help')
    const panel = controller.getSnapshot().panel
    resolveName('Generated Session Name')

    await vi.waitFor(() => expect(renameCurrent).toHaveBeenCalledWith('Generated Session Name'))
    expect(controller.getSnapshot()).toMatchObject({
      runtime: { session: 'Generated Session Name' },
      notices: [{ status: 'success', text: 'Session renamed: Generated Session Name' }],
    })
    expect(controller.getSnapshot().panel).toEqual(panel)
  })

  it('cancels a generated session name when an explicit rename supersedes it', async () => {
    let resolveName!: (name: string) => void
    let signal!: AbortSignal
    const target = backend()
    target.generateSessionName = vi.fn(
      (cancelSignal) =>
        new Promise<string>((resolve) => {
          signal = cancelSignal
          resolveName = resolve
        })
    )
    const renameCurrent = vi.fn(async (name: string) => ({ sessionId: 'session-1', name }))
    const controller = new ChatController(target, {
      runtime: { session: 'Original name' },
      sessions: {
        current: 'session-1',
        directory: '/tmp/sessions',
        list: vi.fn(async () => [{ id: 'session-1', name: 'Original name', active: true }]),
        resolve: async () => ({
          sessionId: 'session-1',
          sessionDirectory: '/tmp/sessions',
          workspace: '/tmp',
          active: true,
        }),
        renameCurrent,
      },
    })

    await controller.submit('/sessions rename')
    await controller.submit('/sessions rename Chosen name')
    resolveName('Stale Generated Name')

    await vi.waitFor(() => expect(signal.aborted).toBe(true))
    await vi.waitFor(() =>
      expect(controller.getSnapshot().notices).toMatchObject([
        { status: 'delivered', text: 'Session naming cancelled' },
      ])
    )
    expect(renameCurrent).toHaveBeenCalledExactlyOnceWith('Chosen name')
    expect(controller.getSnapshot().runtime.session).toBe('Chosen name')
  })

  it('does not apply a queued generated name after clearing the conversation', async () => {
    let releaseRename!: () => void
    const renameBlocked = new Promise<void>((resolve) => {
      releaseRename = resolve
    })
    let current = 'session-1'
    const target = backend()
    target.generateSessionName = vi
      .fn()
      .mockResolvedValueOnce('First Generated Name')
      .mockResolvedValueOnce('Second Generated Name')
    target.clear = vi.fn(async () => {
      current = 'session-2'
    })
    target.info = () => ({ sessionId: current })
    const renameCurrent = vi.fn(async (name: string) => {
      await renameBlocked
      return { sessionId: current, name }
    })
    const controller = new ChatController(target, {
      sessions: {
        get current() {
          return current
        },
        directory: '/tmp/sessions',
        list: vi.fn(async () => [{ id: current, active: true }]),
        resolve: async () => ({
          sessionId: current,
          sessionDirectory: '/tmp/sessions',
          workspace: '/tmp',
          active: true,
        }),
        renameCurrent,
      },
    })

    await controller.submit('/sessions rename')
    await vi.waitFor(() => expect(renameCurrent).toHaveBeenCalledExactlyOnceWith('First Generated Name'))
    await controller.submit('/sessions rename')
    await vi.waitFor(() => expect(target.generateSessionName).toHaveBeenCalledTimes(2))
    await controller.submit('/clear')
    releaseRename()

    await vi.waitFor(() => expect(controller.getSnapshot().runtime.session).toBe('session-2'))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(renameCurrent).toHaveBeenCalledTimes(1)
  })

  it('opens settings during a pending permission and restores it without responding', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const target = backend(async function* () {
      yield {
        type: 'permission',
        request: {
          id: 'permission-1',
          toolName: 'bash',
          input: { command: 'rm file' },
          options: [
            { id: 'allow', label: 'Allow once', kind: 'allow_once' },
            { id: 'reject', label: 'Reject', kind: 'reject_once' },
          ],
        },
      }
      await gate
      return { stopReason: 'endTurn' }
    })
    target.respondPermission = vi.fn(() => true)
    const controller = new ChatController(target)
    const running = controller.submit('do it')
    await vi.waitFor(() => expect(controller.getSnapshot().panel?.kind).toBe('permission'))
    expect(controller.getSnapshot().panel?.body).toBe('{\n  "command": "rm file"\n}')
    expect(target.cancel).not.toHaveBeenCalled()
    expect(controller.dismissPanel()).toBe(false)
    const permissionPanel = controller.getSnapshot().panel
    const openingSettings = controller.submit('/settings')
    expect(controller.getSnapshot().panel?.kind).toBe('settings')
    expect(controller.getSnapshot().queuedPrompts).toEqual([])
    expect(target.respondPermission).not.toHaveBeenCalled()
    await openingSettings
    expect(controller.dismissPanel()).toBe(true)
    expect(controller.getSnapshot().panel).toEqual(permissionPanel)
    await controller.activatePanelRow(controller.getSnapshot().panel!.rows[0]!)
    expect(target.respondPermission).toHaveBeenCalledWith('permission-1', 'allow', undefined)
    expect(controller.getSnapshot().panel).toBeUndefined()

    release()
    await running
  })

  it('handles detached permissions while idle and restores the interrupted panel', async () => {
    let permissionListener: ((request: ChatPermissionRequest | undefined) => void) | undefined
    const stopWatching = vi.fn()
    const target = backend()
    target.watchPermissions = (listener) => {
      permissionListener = listener
      return stopWatching
    }
    target.respondPermission = vi.fn((requestId, optionId) => {
      permissionListener?.(undefined)
      return Boolean(requestId && optionId)
    })
    const controller = new ChatController(target)

    await controller.submit('/tasks')
    const request: ChatPermissionRequest = {
      id: 'permission-1',
      toolName: 'bash',
      input: { command: 'git status' },
      action: 'git status',
      options: [
        { id: 'allow-once', label: 'Allow once', kind: 'allow_once' },
        { id: 'allow-always', label: 'Allow forever', kind: 'allow_always' },
        { id: 'deny', label: 'Deny once', kind: 'reject_once' },
        { id: 'deny-always', label: 'Deny forever', kind: 'reject_always' },
      ],
      scopes: [
        { rule: 'bash(git status)', label: 'git status' },
        { rule: 'bash', label: '* any command' },
      ],
    }
    permissionListener?.(request)

    expect(controller.getSnapshot()).toMatchObject({
      status: 'idle',
      panel: {
        kind: 'permission',
        rows: [
          { label: 'Allow once' },
          { label: 'Allow forever…', description: 'Always allow · choose how broadly' },
          { label: 'Deny once', tone: 'danger' },
          { label: 'Deny forever…', tone: 'danger' },
        ],
      },
    })
    await controller.activatePanelRow(controller.getSnapshot().panel!.rows[1]!)
    expect(target.respondPermission).not.toHaveBeenCalled()
    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'permission',
      stage: 'allow-always',
      rows: [
        { label: 'git status', description: 'Always allow bash(git status) · remember in CLI settings' },
        { label: '* any command', description: 'Always allow bash · remember in CLI settings' },
        { label: '← Back' },
      ],
    })
    const scopePanel = controller.getSnapshot().panel
    for (const command of ['/settings', '/help', '/settings', '/settings']) {
      await controller.submit(command)
      expect(controller.getSnapshot().panel?.kind).toBe(command.slice(1))
      expect(target.respondPermission).not.toHaveBeenCalled()
    }
    expect(controller.dismissPanel()).toBe(true)
    expect(controller.getSnapshot().panel).toEqual(scopePanel)
    expect(controller.dismissPanel()).toBe(false)
    await controller.activatePanelRow(controller.getSnapshot().panel!.rows[2]!)
    expect(controller.getSnapshot().panel).toMatchObject({ kind: 'permission', selected: 1 })
    expect(controller.getSnapshot().panel).not.toHaveProperty('stage')
    await controller.activatePanelRow(controller.getSnapshot().panel!.rows[1]!)
    await controller.activatePanelRow(controller.getSnapshot().panel!.rows[1]!)
    expect(target.respondPermission).toHaveBeenCalledWith('permission-1', 'allow-always', 'bash')
    expect(controller.getSnapshot().panel?.kind).toBe('tasks')

    permissionListener?.({
      ...request,
      id: 'permission-2',
      toolName: 'write',
      input: { command: 'replace file' },
    })
    await controller.activatePanelRow(controller.getSnapshot().panel!.rows[2]!)
    expect(target.respondPermission).toHaveBeenCalledWith('permission-2', 'deny', undefined)
    expect(controller.getSnapshot().panel?.kind).toBe('tasks')

    await controller.dispose()
    expect(stopWatching).toHaveBeenCalledOnce()
  })

  it.each(['watcher', 'cancel'] as const)(
    'does not restore a hidden permission after it is cleared by %s',
    async (clear) => {
      let permissionListener: ((request: ChatPermissionRequest | undefined) => void) | undefined
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const target = backend(async function* () {
        yield {
          type: 'permission',
          request: {
            id: 'permission-1',
            toolName: 'bash',
            input: { command: 'git status' },
            options: [{ id: 'allow', label: 'Allow once', kind: 'allow_once' }],
          },
        }
        await gate
        return { stopReason: 'endTurn' }
      })
      target.watchPermissions = (listener) => {
        permissionListener = listener
        return () => {}
      }
      target.cancel.mockImplementation(() => {
        permissionListener?.(undefined)
      })
      target.respondPermission = vi.fn(() => true)
      const controller = new ChatController(target)
      const running = controller.submit('do it')
      try {
        await vi.waitFor(() => expect(controller.getSnapshot().panel?.kind).toBe('permission'))
        const openingSettings = controller.submit('/settings')
        expect(controller.getSnapshot().panel?.kind).toBe('settings')
        await openingSettings

        if (clear === 'watcher') {
          permissionListener?.(undefined)
        } else {
          expect(controller.cancel()).toBe(true)
        }

        expect(controller.getSnapshot().panel?.kind).toBe('settings')
        expect(controller.dismissPanel()).toBe(true)
        expect(controller.getSnapshot().panel).toBeUndefined()
        expect(target.respondPermission).not.toHaveBeenCalled()
      } finally {
        release()
        await running
        await controller.dispose()
      }
    }
  )

  it('persists permission modes and toggles always-allowed tools through /permissions', async () => {
    let mode: 'default' | 'bypassPermissions' = 'default'
    let allowedTools = ['bash']
    const target = backend()
    target.info = () => ({
      model: 'test',
      tools: [
        { name: 'bash', description: 'Run commands' },
        { name: 'write', description: 'Write files' },
      ],
    })
    target.permissionStatus = () => ({
      mode,
      allowedTools: [...allowedTools],
      deniedTools: [],
      configPath: '/Users/test/.strands/cli.toml',
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
    expect(controller.getSnapshot().permissionMode).toBe('default')
    expect(controller.getSnapshot().permissionPreset).toBe('custom')

    await controller.submit('/permissions')
    expect(controller.getSnapshot()).toMatchObject({
      panel: {
        kind: 'permissions',
        title: 'Permissions',
        searchable: true,
        slider: {
          label: 'Permission mode',
          options: [
            { id: 'ask', label: 'Ask' },
            { id: 'bypass', label: 'Bypass' },
            { id: 'custom', label: 'Custom', active: true },
          ],
        },
        rows: [
          { label: 'bash', control: { kind: 'toggle', checked: true } },
          { label: 'write', control: { kind: 'toggle', checked: false } },
        ],
      },
    })
    expect(controller.getSnapshot().panel?.body).toBeUndefined()
    const permissionsPanelId = controller.getSnapshot().panel?.id

    await controller.activatePanelRow({
      label: 'Permission mode',
      description: 'Bypass',
      value: 'permissions:preset:bypass',
    })
    expect(target.setPermissionMode).toHaveBeenCalledWith('bypassPermissions')
    expect(controller.getSnapshot().permissionMode).toBe('bypassPermissions')
    expect(controller.getSnapshot().panel?.id).toBe(permissionsPanelId)
    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'permissions',
      slider: { options: expect.arrayContaining([expect.objectContaining({ id: 'bypass', active: true })]) },
    })
    const bypassedToolRows = controller.getSnapshot().panel?.rows ?? []
    expect(bypassedToolRows).toMatchObject([
      { label: 'bash', control: { kind: 'toggle', checked: true } },
      { label: 'write', control: { kind: 'toggle', checked: true } },
    ])
    expect(bypassedToolRows.every((row) => row.value === undefined)).toBe(true)

    await controller.submit('/permissions default')
    expect(controller.getSnapshot().permissionMode).toBe('default')
    expect(controller.getSnapshot().panel?.id).toBe(permissionsPanelId)
    await controller.activatePanelRow(controller.getSnapshot().panel!.rows[1]!)
    expect(target.allowPermission).toHaveBeenCalledWith('write')
    expect(controller.getSnapshot().panel?.id).toBe(permissionsPanelId)
    expect(controller.getSnapshot().panel?.rows.find((row) => row.label === 'write')?.control).toEqual({
      kind: 'toggle',
      checked: true,
    })

    await controller.activatePanelRow(controller.getSnapshot().panel!.rows[0]!)
    expect(target.removeAllowedPermission).toHaveBeenCalledWith('bash')
    expect(controller.getSnapshot().panel?.rows.find((row) => row.label === 'bash')?.control).toEqual({
      kind: 'toggle',
      checked: false,
    })

    expect(target.setPermissionMode).toHaveBeenLastCalledWith('default')

    await controller.activatePanelRow({
      label: 'Permission mode',
      description: 'Ask',
      value: 'permissions:preset:ask',
    })
    expect(target.removeAllowedPermission).toHaveBeenCalledWith('write')
    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'permissions',
      slider: { options: expect.arrayContaining([expect.objectContaining({ id: 'ask', active: true })]) },
    })
    expect(controller.getSnapshot().permissionPreset).toBe('ask')
    expect(controller.getSnapshot().panel?.rows.every((row) => row.value === undefined)).toBe(true)
  })

  it('toggles built-in tools through /tools and applies the selection on close', async () => {
    const apply = vi.fn()
    const controller = new ChatController(backend(), {
      builtinTools: {
        choices: () => [
          { name: 'shell', description: 'Run shell commands', enabled: true },
          { name: 'web_search', description: 'Search the web', enabled: false, thirdParty: true },
        ],
        apply,
      },
    })

    await controller.submit('/tools')
    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'tools',
      title: 'Tools',
      rows: [
        { label: 'shell', control: { kind: 'toggle', checked: true } },
        { label: 'web_search', tone: 'warning', control: { kind: 'toggle', checked: false } },
      ],
    })
    const panelId = controller.getSnapshot().panel?.id

    await controller.activatePanelRow(controller.getSnapshot().panel!.rows[1]!)
    expect(controller.getSnapshot().panel?.id).toBe(panelId)
    expect(controller.getSnapshot().panel?.rows[1]?.control).toEqual({ kind: 'toggle', checked: true })
    expect(apply).not.toHaveBeenCalled()

    expect(controller.dismissPanel()).toBe(true)
    expect(apply).toHaveBeenCalledWith(['shell', 'web_search'])
    expect(controller.getSnapshot().panel).toBeUndefined()
  })

  it('closes /tools without reloading when nothing changed', async () => {
    const apply = vi.fn()
    const controller = new ChatController(backend(), {
      builtinTools: { choices: () => [{ name: 'shell', description: 'Run shell commands', enabled: true }], apply },
    })

    await controller.submit('/tools')
    controller.dismissPanel()
    expect(apply).not.toHaveBeenCalled()
  })

  it('shows /model as loading until models are discovered', async () => {
    let resolveModels: (models: Awaited<ReturnType<NonNullable<ChatBackend['listModels']>>>) => void = () => {}
    const target = backend()
    target.listModels = () => new Promise((resolve) => (resolveModels = resolve))
    const controller = new ChatController(target)

    const opening = controller.submit('/model')
    await vi.waitFor(() =>
      expect(controller.getSnapshot().panel).toMatchObject({ kind: 'models', loading: true, rows: [] })
    )

    resolveModels([{ id: 'bedrock/test', name: 'Test', description: '', active: true }])
    await opening
    expect(controller.getSnapshot().panel).not.toHaveProperty('loading')
    expect(controller.getSnapshot().panel?.rows).toHaveLength(1)
  })

  it('toggles reasoning visibility through terminal settings', async () => {
    const controller = new ChatController(backend())

    await controller.submit('/settings')
    const reasoningIndex = controller.getSnapshot().panel?.rows.findIndex((row) => row.value === 'showReasoning')
    expect(reasoningIndex).toBeGreaterThanOrEqual(0)
    await controller.activatePanelRow(controller.getSnapshot().panel!.rows[reasoningIndex!]!)

    expect(controller.getSnapshot()).toMatchObject({
      settings: { showReasoning: false },
      panel: {
        kind: 'settings',
        rows: expect.arrayContaining([
          expect.objectContaining({
            value: 'showReasoning',
            control: { kind: 'toggle', checked: false },
          }),
        ]),
      },
    })
  })

  it('keeps /setup available after appearance updates', async () => {
    const requestSetup = vi.fn()
    const controller = new ChatController(backend(), { requestSetup })

    await controller.submit('/setup')

    expect(requestSetup).toHaveBeenCalledOnce()
    expect(controller.getSnapshot().completedTurns).toEqual([])
    requestSetup.mockClear()
    await controller.submit('/settings')
    await controller.activatePanelRow({ label: '', description: '', value: 'frogTheme=minimal' })
    await controller.activatePanelRow({ label: '', description: '', value: 'settings:Agent' })
    const rows = controller.getSnapshot().panel?.rows ?? []
    expect(rows.map(({ value }) => value)).toEqual(['contextOffloadThreshold', 'settings-action:setup'])
    expect(await controller.activatePanelRow(rows[1]!)).toBe(true)
    expect(requestSetup).toHaveBeenCalledOnce()
  })

  it('compacts context, keeps the visible transcript, and shows the measured context', async () => {
    const target = backend(async function* (prompt) {
      yield { type: 'textDelta', text: `reply to ${prompt}` }
      return { stopReason: 'endTurn', context: { currentTokens: 120 } }
    })
    let compacted: ChatContextUsage | undefined
    target.compact = vi.fn(async () => compacted)
    target.clear = vi.fn(async () => {})
    const controller = new ChatController(target, { runtime: { session: 'saved: active' } })

    await controller.submit('Remember this')
    await controller.submit('/compact')

    expect(target.compact).toHaveBeenCalledOnce()
    expect(controller.getSnapshot()).toMatchObject({
      completedTurns: [{ prompt: 'Remember this' }],
      context: { currentTokens: 120 },
      notices: [{ status: 'delivered', text: 'Nothing to compact yet' }],
    })

    compacted = { currentTokens: 40, contextWindow: 1_000 }
    await controller.submit('/compact')

    expect(target.compact).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot().completedTurns).toMatchObject([{ prompt: 'Remember this' }])
    expect(controller.getSnapshot().context).toEqual({ currentTokens: 40, contextWindow: 1_000 })
    expect(controller.getSnapshot().notices.at(-1)).toMatchObject({
      status: 'success',
      text: 'Compacted older conversation context into a summary',
    })
    expect(controller.getSnapshot().composerStatus).toBeUndefined()
    expect(controller.getSnapshot().panel).toBeUndefined()
    await controller.submit('/clear')

    expect(target.clear).toHaveBeenCalledOnce()
    expect(controller.getSnapshot()).toMatchObject({
      completedTurns: [],
      notices: [],
      tasks: [],
      context: {},
      runtime: { session: 'in-memory' },
    })
    expect(controller.getSnapshot().panel).toBeUndefined()
  })

  it('shows compaction in the composer while work is active without opening a panel', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const target = backend()
    target.compact = vi.fn(async () => {
      await gate
      return {}
    })
    const controller = new ChatController(target)

    const compacting = controller.submit('/compact')
    await vi.waitFor(() => expect(controller.getSnapshot().composerStatus).toBe('Compacting context...'))

    expect(controller.getSnapshot().panel).toBeUndefined()
    await expect(controller.submit('do not queue')).resolves.toBeUndefined()
    release()
    await compacting

    expect(controller.getSnapshot().composerStatus).toBeUndefined()
    expect(controller.getSnapshot().queuedPrompts).toEqual([])
  })

  it('shows clearing in the composer while work is active without opening a panel', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const target = backend()
    target.clear = vi.fn(async () => {
      await gate
    })
    const controller = new ChatController(target)

    const clearing = controller.submit('/clear')
    await vi.waitFor(() => expect(controller.getSnapshot().composerStatus).toBe('Starting fresh conversation...'))

    expect(controller.getSnapshot().panel).toBeUndefined()
    await expect(controller.submit('do not queue')).resolves.toBeUndefined()
    release()
    await clearing

    expect(controller.getSnapshot().composerStatus).toBeUndefined()
    expect(controller.getSnapshot().queuedPrompts).toEqual([])
  })

  it('activates slash and dollar skills once while preserving their visible commands', async () => {
    const prompts: string[] = []
    const activate = vi.fn(async (name: string) =>
      name.toLowerCase() === 'review'
        ? {
            skill: {
              name: 'review',
              description: 'Review code',
              instructions: 'Inspect carefully.',
              active: true,
            },
            content: 'Inspect carefully.\nAvailable resources:\n  references/checklist.md',
          }
        : undefined
    )
    const controller = new ChatController(
      backend(async function* (prompt) {
        prompts.push(prompt)
        yield { type: 'textDelta', text: 'done' }
        return { stopReason: 'endTurn' }
      }),
      {
        skills: { list: async () => [], activate },
        skillNames: ['review'],
      }
    )

    expect(controller.actionableCommandToken('/review this change')).toBe('/review')
    expect(controller.actionableCommandToken('$review that change')).toBe('$review')
    expect(controller.actionableCommandToken('/not-a-command')).toBeUndefined()

    await controller.submit('/review this change')
    await controller.submit('$review that change')

    expect(activate).toHaveBeenNthCalledWith(1, 'review')
    expect(activate).toHaveBeenNthCalledWith(2, 'review')
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain('It is already activated; do not call the skills tool again.')
    expect(prompts[0]).toContain('Inspect carefully.\nAvailable resources:\n  references/checklist.md')
    expect(prompts[0]).toContain('</strands_skill_activation>\n\n/review this change')
    expect(prompts[1]).toContain('</strands_skill_activation>\n\n$review that change')
    expect(prompts.join('\n')).not.toContain('Use the review skill.')
    expect(controller.getSnapshot().completedTurns.map((turn) => turn.prompt)).toEqual([
      '/review this change',
      '$review that change',
    ])
  })

  it('runs a skill command and keeps its panel details reachable', async () => {
    const prompts: string[] = []
    const review = { name: 'review', description: 'Review code', instructions: 'Inspect carefully.', active: false }
    const activate = vi.fn(async () => ({
      skill: { ...review, active: true },
      content: review.instructions,
    }))
    const controller = new ChatController(
      backend(async function* (prompt) {
        prompts.push(prompt)
        yield { type: 'textDelta', text: 'done' }
        return { stopReason: 'endTurn' }
      }),
      { skills: { list: async () => [review], activate } }
    )

    await controller.submit('/skills')
    expect(controller.openSkillDetail('review')).toBe(true)
    expect(controller.getSnapshot().panel).toMatchObject({ kind: 'detail', body: 'Inspect carefully.' })
    controller.dismissPanel()

    controller.dismissPanel()
    await controller.submit('/review')

    expect(activate).toHaveBeenCalledWith('review')
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('<skill_instructions>\nInspect carefully.\n</skill_instructions>')
    expect(prompts[0]).toContain('</strands_skill_activation>\n\n/review')
    expect(controller.getSnapshot().completedTurns.at(-1)?.prompt).toBe('/review')
    expect(controller.getSnapshot().panel).toBeUndefined()
  })

  it('discovers skill command names after startup returns', async () => {
    const review = { name: 'review', description: 'Review code', instructions: 'Inspect carefully.', active: false }
    const list = vi.fn(async () => [review])
    const controller = new ChatController(backend(), { skills: { list, activate: async () => undefined } })

    await controller.start()

    expect(list).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(controller.actionableCommandToken('$review')).toBe('$review'))
    expect(controller.commandAssistance('/rev')?.completions).toEqual([
      {
        name: 'review',
        usage: '/review [request]',
        description: 'Review code',
      },
    ])
    expect(controller.commandAssistance('/review ')?.signature).toBe('/review [request]')
    expect(list).toHaveBeenCalledOnce()
  })

  it('represents an empty MCP configuration as zero servers with its checked path', async () => {
    const list = vi.fn(async () => [])
    const controller = new ChatController(backend(), {
      mcp: {
        clients: [],
        paths: ['/Users/test/.strands/mcp.json'],
        list,
        dispose: async () => undefined,
        warnings: [],
      },
    })

    await controller.submit('/mcp')

    expect(list).toHaveBeenCalledWith(true)
    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'mcp',
      title: 'MCP servers (0)',
      rows: [],
      body: expect.stringContaining('Checked: /Users/test/.strands/mcp.json'),
    })
    expect(controller.getSnapshot().panel?.searchable).toBeUndefined()
  })

  it.each([
    ['Environment variable "AIM_CREDS_AGENT_URL" is not set.', 'Missing environment variable: AIM_CREDS_AGENT_URL'],
    ['Version negotiation failed: the server requires authorization (HTTP HTTP 401)', 'Authentication required'],
    ['connect ECONNREFUSED 127.0.0.1:401', 'Server is not accepting connections'],
    ['spawn /tools/403 ENOENT', 'Server command or working directory not found'],
    [
      'Version negotiation failed: the connection closed during the server/discover probe. ' + 'diagnostic '.repeat(30),
      'Server closed the connection',
    ],
  ])('keeps an actionable MCP summary and the complete failure in details: %s', async (error, summary) => {
    const controller = new ChatController(backend(), {
      mcp: {
        clients: [],
        paths: ['/Users/test/.strands/mcp.json'],
        warnings: ['Skipped invalid server in /Users/test/.codex/config.toml'],
        list: async () => [
          {
            name: 'failing/server',
            transport: 'stdio',
            target: 'node',
            state: 'failed',
            source: '/Users/test/.strands/mcp.json',
            error,
            canRetry: false,
          },
        ],
        dispose: async () => undefined,
      },
    })
    await controller.submit('/mcp')
    const panel = controller.getSnapshot().panel!
    expect(panel.rows[0]).toMatchObject({
      value: 'mcp:toggle:failing%2Fserver',
      description: `stdio | ${summary}`,
    })
    expect(panel.rows[0]?.control).toBeUndefined()
    expect(panel).toHaveProperty('canRetry', false)
    expect(controller.openMcpDetail('failing/server')).toBe(true)
    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'detail',
      title: 'MCP: failing/server',
      rows: [
        { label: 'Problem', description: summary },
        { label: 'Next step', description: expect.any(String) },
        { label: 'Source', description: '/Users/test/.strands/mcp.json' },
        { label: 'Transport', description: 'stdio' },
        { label: 'Target', description: 'node' },
      ],
      body: `Full error\n${error}\n\nConfiguration warnings\nSkipped invalid server in /Users/test/.codex/config.toml`,
    })
    controller.dismissPanel()
    expect(controller.getSnapshot().panel?.id).toBe(panel.id)
  })

  it('retries a failed MCP server without changing saved settings or losing the panel', async () => {
    let server: McpServerInfo = {
      name: 'docs/server',
      transport: 'streamable-http',
      target: 'https://example.test/mcp',
      state: 'failed',
      error: 'ECONNREFUSED',
    }
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const setEnabled = vi.fn(async () => {
      await pending
      server = { ...server, state: 'connected', toolCount: 2 }
      return undefined
    })
    const setSettings = vi.fn(async () => {})
    const controller = new ChatController(backend(), {
      setSettings,
      mcp: {
        clients: [],
        paths: [],
        warnings: [],
        list: async () => [server],
        setEnabled,
        dispose: async () => undefined,
      },
    })
    await controller.submit('/mcp')
    const panelId = controller.getSnapshot().panel?.id
    const retry = controller.retryMcpServer('docs/server')
    expect(controller.busy).toBe(true)
    expect(await controller.retryMcpServer('docs/server')).toBe(false)
    expect(controller.dismissPanel()).toBe(false)
    finish()
    expect(await retry).toBe(true)
    expect(setEnabled).toHaveBeenCalledExactlyOnceWith('docs/server', true)
    expect(setSettings).not.toHaveBeenCalled()
    expect(controller.getSnapshot().panel).toMatchObject({
      id: panelId,
      kind: 'mcp',
      canRetry: false,
      rows: [{ badge: { text: 'connected' }, control: { checked: true } }],
    })
    expect(controller.getSnapshot().composerStatus).toBeUndefined()
  })

  it('keeps failed MCP servers toggleable without offering unsupported retry', async () => {
    let state: McpServerInfo['state'] = 'failed'
    const setEnabled = vi.fn(async (_name: string, enabled: boolean) => {
      state = enabled ? 'failed' : 'disabled'
      return enabled ? 'Environment variable "MCP_URL" is not set.' : undefined
    })
    const setSettings = vi.fn(async () => {})
    const controller = new ChatController(backend(), {
      setSettings,
      mcp: {
        clients: [],
        paths: [],
        warnings: [],
        list: async () => [
          { name: 'creds', transport: 'stdio', target: 'creds', state, canRetry: false, error: 'Missing environment' },
        ],
        setEnabled,
        dispose: async () => undefined,
      },
    })
    await controller.submit('/mcp')
    expect(await controller.retryMcpServer('creds')).toBe(false)
    expect(setEnabled).not.toHaveBeenCalled()
    expect(await controller.activatePanelRow(controller.getSnapshot().panel!.rows[0]!)).toBe(true)
    expect(setEnabled).toHaveBeenLastCalledWith('creds', false)
    expect(setSettings).toHaveBeenLastCalledWith({ disabledMcpServers: ['creds'] })
    expect(controller.getSnapshot().panel?.rows[0]?.control).toEqual({ kind: 'toggle', checked: false })
    expect(await controller.retryMcpServer('creds')).toBe(false)
    expect(await controller.activatePanelRow(controller.getSnapshot().panel!.rows[0]!)).toBe(true)
    expect(setSettings).toHaveBeenLastCalledWith({ disabledMcpServers: [] })
    expect(controller.getSnapshot().panel?.rows[0]?.badge?.text).toBe('failed')
  })
})
