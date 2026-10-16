import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  ChatController,
  type ChatBackend,
  type ChatEvent,
  type ChatRunResult,
  type ChatTask,
} from '../src/tui/chat/controller.js'
import { ConversationManager } from '../src/tui/session/conversations.js'
import { AgentMessaging } from '../src/tui/messaging.js'
import type { McpServerInfo } from '../src/tui/mcp.js'
import * as projectWatch from '../src/tui/project/watch.js'
import type { VoiceInput, VoiceSessionSnapshot, VoiceSupervisorRequest } from '../src/tui/voice/session.js'

function backend(
  id: string,
  run: (prompt: string) => AsyncGenerator<ChatEvent, ChatRunResult, undefined>,
  name = 'Strands harness'
): ChatBackend {
  return {
    id,
    name,
    protocol: 'strands',
    stream: run,
    cancel: vi.fn(),
    dispose: vi.fn(),
  }
}

describe('ConversationManager', () => {
  it('opens MCP failure details and retries through the active conversation', async () => {
    let server: McpServerInfo = {
      name: 'docs',
      state: 'failed',
      transport: 'streamable-http',
      target: 'https://example.test/mcp',
      source: '/workspace/.strands/mcp.json',
      canRetry: true,
      error: 'connect ECONNREFUSED',
    }
    const setEnabled = vi.fn(async () => {
      server = { ...server, state: 'connected', toolCount: 2 }
      delete server.error
      return undefined
    })
    const primary = new ChatController(backend('primary', emptyRun), {
      mcp: {
        clients: [],
        paths: [],
        warnings: [],
        list: async () => [server],
        setEnabled,
        dispose: async () => undefined,
      },
    })
    const manager = new ConversationManager(primary, { fork: async () => primary })
    try {
      await manager.submit('/mcp')
      const listId = manager.getSnapshot().panel?.id
      expect(manager.openMcpDetail('docs')).toBe(true)
      expect(manager.getSnapshot().panel).toMatchObject({
        kind: 'detail',
        title: 'MCP: docs',
        body: 'Full error\nconnect ECONNREFUSED',
        rows: expect.arrayContaining([{ label: 'Source', description: '/workspace/.strands/mcp.json' }]),
      })
      expect(manager.dismissPanel()).toBe(true)
      expect(manager.getSnapshot().panel?.id).toBe(listId)
      expect(await manager.retryMcpServer('docs')).toBe(true)
      expect(setEnabled).toHaveBeenCalledExactlyOnceWith('docs', true)
      expect(manager.getSnapshot().panel).toMatchObject({
        id: listId,
        kind: 'mcp',
        rows: [{ label: 'docs', badge: { text: 'connected' } }],
      })
    } finally {
      await manager.dispose()
    }
  })

  it('does not dispatch MCP actions behind a manager panel or after closing', async () => {
    const primary = new ChatController(backend('primary', emptyRun))
    const details = vi.spyOn(primary, 'openMcpDetail').mockReturnValue(true)
    const retry = vi.spyOn(primary, 'retryMcpServer').mockResolvedValue(true)
    const manager = new ConversationManager(primary, { fork: async () => primary })
    try {
      await manager.submit('/agents')
      expect(manager.openMcpDetail('docs')).toBe(false)
      expect(await manager.retryMcpServer('docs')).toBe(false)
      manager.dismissPanel()
      manager.close()
      expect(manager.openMcpDetail('docs')).toBe(false)
      expect(await manager.retryMcpServer('docs')).toBe(false)
      expect(details).not.toHaveBeenCalled()
      expect(retry).not.toHaveBeenCalled()
    } finally {
      await manager.dispose()
    }
  })

  it('refreshes project source immediately and reloads after active work finishes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'strands-live-reload-'))
    const entrypoint = join(root, 'agent.ts')
    const helper = join(root, 'helper.ts')
    await writeFile(entrypoint, "createHarness({ name: 'Before' })\n")
    await writeFile(helper, "export const name = 'Before'\n")
    let finish!: () => void
    const active = new Promise<void>((resolve) => {
      finish = resolve
    })
    const primary = new ChatController(
      backend('primary', async function* () {
        yield { type: 'textDelta', text: 'Working' }
        await active
        return { stopReason: 'endTurn' }
      }),
      {
        configurationSource: () => ({
          preferredLanguage: 'typescript',
          documents: {
            typescript: {
              source: readFileSync(entrypoint, 'utf8'),
              generated: false,
              path: entrypoint,
            },
            python: { source: 'agent = create_harness()', generated: true },
          },
          project: { root, entrypoint },
        }),
      }
    )
    const reloadProject = vi.fn()
    const manager = new ConversationManager(primary, {
      fork: async () => primary,
      project: { root, entrypoint, language: 'typescript' },
      reloadProject,
    })
    try {
      const running = manager.submit('Keep working')
      await vi.waitFor(() => expect(manager.busy).toBe(true))
      await writeFile(entrypoint, "createHarness({ name: 'After' })\n")
      await vi.waitFor(
        () => expect(manager.getSnapshot().configuration?.documents.typescript.source).toContain('After'),
        { timeout: 5_000 }
      )
      expect(reloadProject).not.toHaveBeenCalled()

      finish()
      await running
      await vi.waitFor(() => expect(reloadProject).toHaveBeenCalledWith('agent-1'), { timeout: 5_000 })

      reloadProject.mockClear()
      await writeFile(helper, "export const name = 'After'\n")
      await vi.waitFor(() => expect(reloadProject).toHaveBeenCalledWith('agent-1'), { timeout: 5_000 })
    } finally {
      finish()
      await manager.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a setup capture while another conversation is running', async () => {
    const snapshot = {
      scope: 'agent' as const,
      schemaVersion: '1.0',
      createdAt: new Date().toISOString(),
      data: {},
      appData: {},
    }
    const primary = new ChatController({
      ...backend('primary', emptyRun),
      captureConversation: async () => snapshot,
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fork = new ChatController(
      backend('fork', async function* () {
        yield { type: 'textDelta', text: 'Working' }
        await gate
        return { stopReason: 'endTurn' }
      })
    )
    const manager = new ConversationManager(primary, { fork: async () => fork })
    try {
      await manager.submit('/fork')
      const running = manager.submit('Keep working')
      await vi.waitFor(() => expect(manager.busy).toBe(true))
      await expect(manager.captureConversation('agent-1')).rejects.toThrow('all conversations')
      release()
      await running
      await expect(manager.captureConversation('agent-1')).resolves.toMatchObject({ snapshot })
    } finally {
      release()
      await manager.dispose()
    }
  })

  it('reloads a changed project after fork startup settles', async () => {
    const root = process.cwd()
    const entrypoint = join(root, 'agent.ts')
    const primary = new ChatController(backend('primary', emptyRun))
    const fork = new ChatController(backend('fork', emptyRun))
    let notifyChange!: () => void
    const watch = vi.spyOn(projectWatch, 'watchAgentProject').mockImplementation((_project, onChange) => {
      notifyChange = onChange
      return () => {}
    })
    let finish!: (controller: ChatController) => void
    const pendingFork = new Promise<ChatController>((resolve) => {
      finish = resolve
    })
    const reloadProject = vi.fn()
    const manager = new ConversationManager(primary, {
      fork: () => pendingFork,
      project: { root, entrypoint, language: 'typescript' },
      reloadProject,
    })
    const forking = manager.submit('/fork')
    try {
      notifyChange()
      expect(reloadProject).not.toHaveBeenCalled()
      finish(fork)
      await forking
      expect(reloadProject).toHaveBeenCalledExactlyOnceWith('agent-2')
    } finally {
      finish(fork)
      await forking
      await manager.dispose()
      watch.mockRestore()
    }
  })

  it.each(['off', 'error'] as const)('applies voice On/Off choices idempotently from %s', async (status) => {
    const primary = new ChatController(backend('primary', emptyRun))
    const voice = fakeVoiceInput(status)
    const manager = new ConversationManager(primary, { fork: async () => primary, voice })
    const choose = (choice?: string) =>
      manager.activatePanelRow({
        label: 'Voice',
        description: '',
        value: choice === undefined ? 'voice:enabled' : `voice:enabled=${choice}`,
      })
    try {
      await manager.submit('/voice')
      await choose('off')
      expect(voice.stop).not.toHaveBeenCalled()
      await choose('on')
      await choose('on')
      expect(voice.start).toHaveBeenCalledOnce()
      expect(manager.getSnapshot().panel?.rows[0]?.control).toMatchObject({
        options: [{ value: 'off' }, { value: 'on', active: true }],
      })

      manager.toggleVoiceMute()
      await choose('on')
      expect(voice.start).toHaveBeenCalledOnce()
      expect(manager.getSnapshot().voice?.status).toBe('muted')
      await choose('off')
      await choose('off')
      expect(voice.stop).toHaveBeenCalledOnce()

      await choose()
      expect(voice.start).toHaveBeenCalledTimes(2)
      await choose()
      expect(voice.stop).toHaveBeenCalledTimes(2)
      expect(manager.getSnapshot().voice?.status).toBe('off')
      expect(await choose('invalid')).toBe(false)
    } finally {
      await manager.dispose()
    }
  })

  it('routes only delegated voice turns into the active harness conversation', async () => {
    const prompts: string[] = []
    const target = backend('primary', async function* (prompt) {
      prompts.push(prompt)
      yield { type: 'textDelta', text: `coding:${prompt}` }
      return { stopReason: 'endTurn' }
    })
    const primary = new ChatController(target)
    const voice = fakeVoiceInput()
    const manager = new ConversationManager(primary, { fork: async () => primary, voice })

    expect(manager.actionableCommandToken('/voice')).toBe('/voice')
    await manager.submit('/voice')
    expect(voice.start).not.toHaveBeenCalled()
    expect(manager.getSnapshot().panel).toMatchObject({
      kind: 'voice',
      rows: expect.arrayContaining([
        expect.objectContaining({
          label: 'Voice',
          description: 'off',
          value: 'voice:enabled',
          control: {
            kind: 'segmented',
            options: [
              { label: 'Off', value: 'off', active: true },
              { label: 'On', value: 'on' },
            ],
          },
        }),
      ]),
    })
    await manager.submit('/voice on')
    expect(voice.start).toHaveBeenCalledOnce()
    expect(manager.getSnapshot().voice).toMatchObject({
      status: 'listening',
      model: 'amazon.nova-2-5-sonic',
    })
    expect(manager.getSnapshot().panel).toBeUndefined()

    expect(prompts).toEqual([])

    voice.emitSupervisorRequest({
      requestId: 'supervisor-1',
      action: 'send_instruction',
      instruction: 'inspect the parser',
    })
    await vi.waitFor(() => expect(manager.getSnapshot().completedTurns).toHaveLength(1))
    expect(prompts).toEqual(['inspect the parser'])
    expect(manager.getSnapshot().completedTurns.at(-1)).toMatchObject({
      prompt: 'inspect the parser',
      entries: [{ type: 'assistant', text: 'coding:inspect the parser' }],
    })
    expect(voice.narrate).not.toHaveBeenCalled()
    expect(voice.resolveSupervisorRequest).toHaveBeenCalledWith('supervisor-1', {
      ok: true,
      result: {
        accepted: true,
        state: 'started',
        conversation: 'Strands harness',
      },
    })
    voice.emitSupervisorRequest({
      requestId: 'supervisor-2',
      action: 'get_current_work',
    })
    expect(voice.resolveSupervisorRequest).toHaveBeenLastCalledWith('supervisor-2', {
      ok: true,
      result: expect.objectContaining({
        conversation: 'Strands harness',
        status: 'idle',
        latest_result: 'coding:inspect the parser',
      }),
    })

    expect(manager.toggleVoiceMute()).toBe(true)
    expect(manager.getSnapshot().voice?.status).toBe('muted')
    await manager.submit('/voice status')
    expect(manager.getSnapshot().panel).toMatchObject({
      kind: 'voice',
      title: 'Voice',
      rows: expect.arrayContaining([
        expect.objectContaining({
          label: 'Voice',
          description: 'muted',
          value: 'voice:enabled',
          control: {
            kind: 'segmented',
            options: [
              { label: 'Off', value: 'off' },
              { label: 'On', value: 'on', active: true },
            ],
          },
        }),
        expect.objectContaining({
          label: 'Nova 2.5 Sonic',
          description: 'amazon.nova-2-5-sonic',
          value: 'voice:model=amazon.nova-2-5-sonic',
        }),
        expect.objectContaining({
          label: 'spoken replies',
          control: expect.objectContaining({ kind: 'toggle', checked: false }),
        }),
        expect.objectContaining({
          label: 'provider',
          control: expect.objectContaining({ kind: 'segmented' }),
        }),
        expect.objectContaining({
          label: 'end of turn',
          control: expect.objectContaining({ kind: 'segmented' }),
        }),
      ]),
    })

    const spokenReplies = manager.getSnapshot().panel?.rows.findIndex((row) => row.value === 'voice:spokenReplies')
    await manager.activatePanelRow(manager.getSnapshot().panel!.rows[spokenReplies!]!)
    expect(voice.setSpokenReplies).toHaveBeenCalledWith(true)

    await manager.activatePanelRow({
      label: 'end of turn',
      description: 'balanced',
      value: 'voice:endpointing=MEDIUM',
    })
    expect(voice.setEndpointingSensitivity).toHaveBeenCalledWith('MEDIUM')

    await manager.activatePanelRow({
      label: 'provider',
      description: 'OpenAI',
      value: 'voice:provider=openai',
    })
    expect(voice.setProvider).toHaveBeenCalledWith('openai')
    expect(manager.getSnapshot().panel?.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'GPT Realtime 2.1',
          description: 'gpt-realtime-2.1',
          value: 'voice:model=gpt-realtime-2.1',
        }),
      ])
    )

    await manager.activatePanelRow({
      label: 'GPT Realtime 2.1',
      description: 'gpt-realtime-2.1',
      value: 'voice:model=gpt-realtime-2.1',
    })
    expect(voice.setModel).toHaveBeenCalledWith('gpt-realtime-2.1')

    await manager.activatePanelRow({
      label: 'English (US)',
      description: 'matthew',
      value: 'voice:voice=matthew',
    })
    expect(voice.setVoice).toHaveBeenCalledWith('matthew')

    await manager.submit('/voice off')
    expect(voice.stop).toHaveBeenCalledOnce()
    expect(manager.getSnapshot().voice?.status).toBe('off')
    await manager.dispose()
    expect(voice.dispose).toHaveBeenCalledOnce()
  })

  it('publishes voice meter levels without rebuilding the conversation snapshot', async () => {
    const primary = new ChatController(backend('primary', emptyRun))
    const voice = fakeVoiceInput()
    const manager = new ConversationManager(primary, { fork: async () => primary, voice })
    await manager.submit('/voice on')
    const conversationUpdate = vi.fn()
    const meterUpdate = vi.fn()
    const unsubscribeConversation = manager.subscribe(conversationUpdate)
    const unsubscribeMeter = manager.voice!.subscribe(meterUpdate)
    const snapshot = manager.getSnapshot()

    voice.emitLevel(0.5, -30)

    expect(meterUpdate).toHaveBeenCalledOnce()
    expect(conversationUpdate).not.toHaveBeenCalled()
    expect(manager.getSnapshot()).toBe(snapshot)
    expect(manager.voice?.getSnapshot()).toMatchObject({
      inputLevel: 0.5,
      inputLevelDb: -30,
    })

    voice.toggleMuted()
    expect(conversationUpdate).toHaveBeenCalledOnce()
    expect(manager.getSnapshot().voice?.status).toBe('muted')

    unsubscribeConversation()
    unsubscribeMeter()
    await manager.dispose()
  })

  it('rejects voice actions during a reload and accepts them again after rollback', async () => {
    const stream = vi.fn(emptyRun)
    const primary = new ChatController(backend('primary', stream))
    const voice = fakeVoiceInput()
    const manager = new ConversationManager(primary, { fork: async () => primary, voice })
    try {
      const resume = manager.pauseVoiceInput()
      voice.emitSupervisorRequest({
        requestId: 'during-reload',
        action: 'send_instruction',
        instruction: 'Inspect the parser',
      })
      expect(stream).not.toHaveBeenCalled()
      expect(voice.resolveSupervisorRequest).toHaveBeenLastCalledWith('during-reload', {
        ok: false,
        error: 'The harness agent is reloading. Try again after the reload finishes.',
      })

      resume()
      voice.emitSupervisorRequest({
        requestId: 'after-rollback',
        action: 'send_instruction',
        instruction: 'Inspect the parser',
      })
      await vi.waitFor(() => expect(stream).toHaveBeenCalledOnce())
      expect(voice.resolveSupervisorRequest).toHaveBeenLastCalledWith('after-rollback', {
        ok: true,
        result: { accepted: true, state: 'started', conversation: 'Strands harness' },
      })
    } finally {
      await manager.dispose()
    }
  })

  it('returns one completed harness response to the voice agent as grounded narration', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let markFirstChunk!: () => void
    const firstChunk = new Promise<void>((resolve) => {
      markFirstChunk = resolve
    })
    const target = backend('primary', async function* () {
      yield { type: 'textDelta', text: 'First sentence.' }
      markFirstChunk()
      await gate
      yield { type: 'textDelta', text: ' Second sentence without punctuation' }
      return { stopReason: 'endTurn' }
    })
    const primary = new ChatController(target)
    const voice = fakeVoiceInput()
    const manager = new ConversationManager(primary, { fork: async () => primary, voice })

    await manager.submit('/voice on')
    voice.setSpokenReplies(true)
    const running = manager.submit('explain the change')
    await firstChunk
    expect(voice.narrate).not.toHaveBeenCalled()
    expect(manager.getSnapshot().status).toBe('running')

    release()
    await running
    expect(voice.narrate).toHaveBeenCalledOnce()
    expect(voice.narrate).toHaveBeenCalledWith('First sentence. Second sentence without punctuation')

    await manager.dispose()
  })

  it('keeps harness work running during voice conversation and cancels only through the supervisor', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const target = backend('primary', async function* () {
      await gate
      yield { type: 'textDelta', text: 'finished' }
      return { stopReason: 'endTurn' }
    })
    const primary = new ChatController(target)
    const voice = fakeVoiceInput()
    const manager = new ConversationManager(primary, { fork: async () => primary, voice })

    const running = manager.submit('long task')
    await vi.waitFor(() => expect(manager.getSnapshot().status).toBe('running'))
    expect(target.cancel).not.toHaveBeenCalled()

    voice.emitSupervisorRequest({
      requestId: 'supervisor-1',
      action: 'cancel_current_work',
    })
    expect(target.cancel).toHaveBeenCalledOnce()
    expect(voice.resolveSupervisorRequest).toHaveBeenCalledWith('supervisor-1', {
      ok: true,
      result: {
        cancelled: true,
        state: 'cancelled',
        conversation: 'Strands harness',
      },
    })

    release()
    await running
    await manager.dispose()
  })

  it('forks into an independent conversation and switches between transcripts', async () => {
    const primary = new ChatController(
      backend(
        'primary',
        async function* (prompt) {
          yield { type: 'textDelta', text: `main:${prompt}` }
          return { stopReason: 'endTurn' }
        },
        'Research Strands harness'
      )
    )
    const fork = new ChatController(
      backend('fork', async function* (prompt) {
        yield { type: 'textDelta', text: `fork:${prompt}` }
        return { stopReason: 'endTurn' }
      })
    )
    const factory = vi.fn(async () => fork)
    const manager = new ConversationManager(primary, { fork: factory })

    await manager.submit('baseline')
    await manager.submit('/fork "investigate the parser"')

    expect(factory).toHaveBeenCalledWith(primary)
    expect(manager.getSnapshot().completedTurns.at(-1)).toMatchObject({
      prompt: 'investigate the parser',
      entries: [{ type: 'assistant', text: 'fork:investigate the parser' }],
    })

    await manager.submit('/agents')
    expect(manager.getSnapshot().panel).toMatchObject({
      kind: 'agents',
      title: 'Agents',
    })
    const main = manager.getSnapshot().panel?.rows.find((row) => row.label === 'Research Strands harness')
    await manager.activatePanelRow(main!)
    expect(manager.getSnapshot().completedTurns.at(-1)).toMatchObject({
      prompt: 'baseline',
      entries: [{ type: 'assistant', text: 'main:baseline' }],
    })
  })

  it('keeps one fork working while the user chats in another', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const primary = new ChatController(
      backend('primary', async function* (prompt) {
        yield { type: 'textDelta', text: `main:${prompt}` }
        return { stopReason: 'endTurn' }
      })
    )
    const fork = new ChatController(
      backend('fork', async function* (prompt) {
        await gate
        yield { type: 'textDelta', text: `fork:${prompt}` }
        return { stopReason: 'endTurn' }
      })
    )
    const manager = new ConversationManager(primary, { fork: async () => fork })

    await manager.submit('/fork')
    const running = manager.submit('long task')
    await vi.waitFor(() => expect(manager.getSnapshot().status).toBe('running'))

    await manager.submit('/agents')
    const main = manager.getSnapshot().panel?.rows.find((row) => row.label === 'Strands harness')
    await manager.activatePanelRow(main!)
    expect(manager.busy).toBe(false)
    await manager.submit('keep talking')
    expect(manager.getSnapshot().completedTurns.at(-1)?.prompt).toBe('keep talking')

    release()
    await running
    await manager.submit('/agents')
    expect(manager.getSnapshot().panel?.rows).toEqual([
      expect.objectContaining({
        label: 'Strands harness',
        description: 'Primary agent',
        bold: true,
        current: true,
        badge: { text: 'idle', tone: 'success' },
      }),
      expect.objectContaining({
        label: 'Fork 2',
        description: 'Fork of Strands harness',
        bold: true,
        current: false,
        badge: { text: 'idle', tone: 'success' },
      }),
    ])
    expect(manager.getSnapshot().panel?.searchable).toBeUndefined()
    expect(manager.getSnapshot().panel?.rows.every((row) => row.section === undefined)).toBe(true)
  })

  it.each(['success', 'failure'])('keeps fork progress in the conversation until %s', async (result) => {
    const primary = new ChatController(backend('primary', emptyRun))
    const fork = new ChatController(backend('fork', emptyRun))
    let finishFork!: () => void
    const ready = new Promise<ChatController>((resolve, reject) => {
      finishFork = () => (result === 'success' ? resolve(fork) : reject(new Error('Fork startup failed')))
    })
    const factory = vi.fn(() => ready)
    const manager = new ConversationManager(primary, { fork: factory })

    await manager.submit('Keep this conversation visible')
    const lastTurn = manager.getSnapshot().completedTurns.at(-1)!
    await manager.submit('/agents')
    const pending = manager.submit('/fork')
    expect(manager.getSnapshot()).toMatchObject({
      completedTurns: [lastTurn],
      notices: [
        {
          id: 'manager-fork-progress',
          text: 'Forking agent…',
          status: 'running',
          afterTurnId: lastTurn.id,
        },
      ],
    })
    expect(manager.getSnapshot().panel).toBeUndefined()
    expect(manager.getSnapshot().composerStatus).toBeUndefined()
    await manager.submit('/fork')
    expect(factory).toHaveBeenCalledOnce()

    finishFork()
    await pending
    expect(manager.getSnapshot().notices).toEqual([])
    expect(manager.backend.id).toBe(result === 'success' ? 'fork' : 'primary')
    if (result === 'failure') {
      expect(manager.getSnapshot().panel).toMatchObject({
        kind: 'error',
        title: 'fork failed',
        rows: [{ description: 'Fork startup failed' }],
      })
      await fork.dispose()
    }
    await manager.dispose()
  })

  it('routes /rename to saved sessions without changing peer names', async () => {
    const agentMessaging = new AgentMessaging()
    const rename = vi.spyOn(agentMessaging, 'rename')
    const primary = new ChatController(backend('primary', emptyRun))
    const manager = new ConversationManager(primary, {
      fork: async () => primary,
      agentMessaging,
    })

    await manager.submit('/rename Lead Reviewer')
    expect(manager.getSnapshot().panel).toMatchObject({ kind: 'error', title: 'session rename unavailable' })
    await manager.submit('/agents')

    expect(rename).toHaveBeenCalledExactlyOnceWith('agent-1', 'Strands harness')
    expect(manager.getSnapshot().panel?.rows[0]).toMatchObject({
      label: 'Strands harness',
      current: true,
      badge: { text: 'idle' },
    })
    expect(manager.getSnapshot().runtime.configuration).toContainEqual({
      label: 'agent',
      value: 'Strands harness (1 total)',
    })
    await manager.dispose()
  })

  it('retries failed session lookup and startup before opening a separate workspace conversation', async () => {
    const reference = 'strands-session:remote'
    const target = {
      sessionId: 'saved-two',
      name: 'Parser cleanup',
      sessionDirectory: '/work/two/.agent/sessions',
      workspace: '/work/two',
      active: false,
    }
    const resolveSession = vi.fn(async () => target).mockRejectedValueOnce(new Error('Session lookup failed'))
    const primary = new ChatController(
      backend('primary', async function* (prompt) {
        yield { type: 'textDelta', text: `main:${prompt}` }
        return { stopReason: 'endTurn' }
      }),
      {
        runtime: { cwd: '/work/one' },
        sessions: {
          current: undefined,
          directory: 'all registered workspaces',
          list: async () => [
            {
              id: target.sessionId,
              reference,
              active: false,
              directory: target.sessionDirectory,
              workspace: target.workspace,
            },
          ],
          resolve: resolveSession,
        },
      }
    )
    const resumed = new ChatController(backend('resumed', emptyRun), {
      runtime: { cwd: target.workspace, session: `saved: ${target.sessionId}` },
    })
    const resume = vi.fn(async () => resumed).mockRejectedValueOnce(new Error('Session startup failed'))
    const manager = new ConversationManager(primary, { fork: async () => resumed, resume })

    await manager.submit('keep this conversation')
    for (const message of ['Session lookup failed', 'Session startup failed']) {
      await manager.submit('/sessions')
      await manager.activatePanelRow(manager.getSnapshot().panel!.rows[0]!)
      expect(manager.getSnapshot().panel).toMatchObject({
        kind: 'error',
        title: 'session resume failed',
        rows: [expect.objectContaining({ description: message })],
      })
      expect(manager.getSnapshot().runtime.cwd).toBe('/work/one')
    }
    await manager.submit('/sessions')
    const row = manager.getSnapshot().panel?.rows[0]
    expect(row?.value).toBe(reference)
    await manager.activatePanelRow(row!)

    expect(resume).toHaveBeenCalledWith(primary, target)
    expect(manager.getSnapshot().runtime).toMatchObject({
      cwd: target.workspace,
      session: `saved: ${target.sessionId}`,
    })

    await manager.submit('/agents')
    expect(manager.getSnapshot().panel?.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Parser cleanup · two' }),
        expect.objectContaining({ label: 'Strands harness' }),
      ])
    )
    const main = manager.getSnapshot().panel?.rows.find((candidate) => candidate.label === 'Strands harness')
    await manager.activatePanelRow(main!)
    expect(manager.getSnapshot()).toMatchObject({
      runtime: { cwd: '/work/one' },
      completedTurns: [{ prompt: 'keep this conversation' }],
    })
  })

  it('blocks saved-session activation while a background result awaits delivery', async () => {
    let taskListener: ((tasks: readonly ChatTask[]) => void) | undefined
    const target = backend('primary', emptyRun)
    target.watchTasks = (listener) => {
      taskListener = listener
      listener([])
      return () => {}
    }
    const primary = new ChatController(target, {
      sessions: {
        current: undefined,
        directory: '/tmp/sessions',
        list: async () => [{ id: 'saved-one', active: false }],
        resolve: async (reference) => ({
          reference,
          sessionId: 'saved-one',
          sessionDirectory: '/tmp/sessions',
          workspace: '/tmp',
          active: false,
        }),
      },
    })
    const resume = vi.fn(async () => primary)
    const manager = new ConversationManager(primary, { fork: async () => primary, resume })
    taskListener?.([
      {
        id: 'task-1',
        label: 'reviewer',
        status: 'completed',
        source: 'background',
        deliveryState: 'ready',
      },
    ])

    await manager.submit('/sessions')
    await manager.activatePanelRow(manager.getSnapshot().panel!.rows[0]!)

    expect(manager.getSnapshot().panel).toMatchObject({
      kind: 'error',
      title: 'session resume blocked',
    })
    expect(resume).not.toHaveBeenCalled()
  })

  it('closes and disposes every conversation plus shared resources', async () => {
    const primaryDispose = vi.fn()
    const forkDispose = vi.fn()
    const primary = new ChatController({ ...backend('primary', emptyRun), dispose: primaryDispose })
    const fork = new ChatController({ ...backend('fork', emptyRun), dispose: forkDispose })
    const disposeShared = vi.fn()
    const manager = new ConversationManager(primary, { fork: async () => fork, dispose: disposeShared })

    await manager.submit('/fork')
    manager.close()
    expect(manager.getSnapshot().status).toBe('closed')
    await manager.dispose()

    expect(primaryDispose).toHaveBeenCalledOnce()
    expect(forkDispose).toHaveBeenCalledOnce()
    expect(disposeShared).toHaveBeenCalledOnce()
  })

  it('accepts exit while forking and disposes a fork that finishes after shutdown', async () => {
    let finishFork!: (controller: ChatController) => void
    const forkReady = new Promise<ChatController>((resolve) => {
      finishFork = resolve
    })
    const primary = new ChatController(backend('primary', emptyRun))
    const forkDispose = vi.fn()
    const fork = new ChatController({ ...backend('fork', emptyRun), dispose: forkDispose })
    const manager = new ConversationManager(primary, { fork: () => forkReady })

    const pending = manager.submit('/fork')
    expect(manager.getSnapshot().panel).toBeUndefined()
    expect(manager.getSnapshot().notices).toEqual([
      { id: 'manager-fork-progress', text: 'Forking agent…', status: 'running' },
    ])
    await manager.submit('/exit')
    expect(manager.getSnapshot().status).toBe('closed')
    expect(manager.getSnapshot().notices).toEqual([])
    await manager.dispose()
    finishFork(fork)
    await pending

    expect(fork.getSnapshot().status).toBe('closed')
    expect(forkDispose).toHaveBeenCalledOnce()
    expect(manager.getSnapshot().notices).toEqual([])
  })
})

async function* emptyRun(): AsyncGenerator<ChatEvent, ChatRunResult, undefined> {
  yield { type: 'textDelta', text: '' }
  return { stopReason: 'endTurn' }
}

function fakeVoiceInput(status: VoiceSessionSnapshot['status'] = 'off') {
  let snapshot: VoiceSessionSnapshot = {
    status,
    muted: false,
    inputLevel: 0,
    inputLevelDb: -60,
    spokenReplies: false,
    endpointingSensitivity: 'LOW',
    provider: 'bedrock',
    voice: 'tiffany',
    model: 'amazon.nova-2-5-sonic',
  }
  const listeners = new Set<() => void>()
  const supervisorListeners = new Set<Parameters<VoiceInput['onSupervisorRequest']>[0]>()
  const emit = (): void => {
    for (const listener of listeners) {
      listener()
    }
  }
  const reset = async (): Promise<void> => {
    snapshot = {
      status: 'off',
      muted: false,
      inputLevel: 0,
      inputLevelDb: -60,
      spokenReplies: snapshot.spokenReplies,
      endpointingSensitivity: snapshot.endpointingSensitivity,
      provider: snapshot.provider,
      voice: snapshot.voice,
      model: snapshot.model,
    }
    emit()
  }
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onSupervisorRequest: (listener: Parameters<VoiceInput['onSupervisorRequest']>[0]) => {
      supervisorListeners.add(listener)
      return () => supervisorListeners.delete(listener)
    },
    getSnapshot: () => ({ ...snapshot }),
    start: vi.fn(async () => {
      snapshot = { ...snapshot, status: 'listening', muted: false }
      emit()
    }),
    stop: vi.fn(reset),
    narrate: vi.fn((_text: string) => snapshot.status !== 'off' && snapshot.spokenReplies),
    resolveSupervisorRequest: vi.fn(() => snapshot.status !== 'off'),
    toggleMuted: () => {
      if (snapshot.status === 'off') {
        return false
      }
      const muted = !snapshot.muted
      snapshot = { ...snapshot, muted, status: muted ? 'muted' : 'listening' }
      emit()
      return true
    },
    setMuted: (muted: boolean) => {
      snapshot = { ...snapshot, muted, status: muted ? 'muted' : 'listening' }
      emit()
      return true
    },
    setSpokenReplies: vi.fn((enabled: boolean) => {
      snapshot = { ...snapshot, spokenReplies: enabled }
      emit()
      return true
    }),
    setEndpointingSensitivity: vi.fn(async (sensitivity: VoiceSessionSnapshot['endpointingSensitivity']) => {
      snapshot = { ...snapshot, endpointingSensitivity: sensitivity }
      emit()
      return true
    }),
    setProvider: vi.fn(async (provider: VoiceSessionSnapshot['provider']) => {
      snapshot = {
        ...snapshot,
        provider,
        voice: provider === 'bedrock' ? 'tiffany' : 'coral',
        model: provider === 'bedrock' ? 'amazon.nova-2-5-sonic' : 'gpt-realtime-2.1',
      }
      emit()
      return true
    }),
    setModel: vi.fn(async (model: VoiceSessionSnapshot['model']) => {
      snapshot = { ...snapshot, model }
      emit()
      return true
    }),
    setVoice: vi.fn(async (voice: VoiceSessionSnapshot['voice']) => {
      snapshot = { ...snapshot, voice }
      emit()
      return true
    }),
    dispose: vi.fn(reset),
    emitLevel: (inputLevel: number, inputLevelDb: number) => {
      snapshot = { ...snapshot, inputLevel, inputLevelDb }
      emit()
    },
    emitSupervisorRequest: (request: VoiceSupervisorRequest) => {
      for (const listener of supervisorListeners) {
        listener(request)
      }
    },
  }
}
