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
import type { VoiceSessionSnapshot } from '../src/tui/voice/session.js'

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

  it('routes repository voice input into the active coding conversation', async () => {
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
        expect.objectContaining({ label: 'Start Voice', description: 'off', value: 'voice:start' }),
      ]),
    })

    await manager.submit('/voice on')
    expect(voice.start).toHaveBeenCalledOnce()
    expect(manager.getSnapshot().voice).toMatchObject({
      status: 'listening',
      model: 'test-sonic',
    })
    expect(manager.getSnapshot().panel).toBeUndefined()

    voice.emitTranscript('inspect the parser')
    await vi.waitFor(() => expect(manager.getSnapshot().completedTurns).toHaveLength(1))
    expect(prompts).toEqual(['inspect the parser'])
    expect(manager.getSnapshot().completedTurns.at(-1)).toMatchObject({
      prompt: 'inspect the parser',
      entries: [{ type: 'assistant', text: 'coding:inspect the parser' }],
    })
    expect(voice.speak).not.toHaveBeenCalled()

    expect(manager.toggleVoiceMute()).toBe(true)
    expect(manager.getSnapshot().voice?.status).toBe('muted')
    await manager.submit('/voice status')
    expect(manager.getSnapshot().panel).toMatchObject({
      kind: 'voice',
      title: 'voice',
      rows: expect.arrayContaining([
        expect.objectContaining({ label: 'Stop Voice', description: 'muted', value: 'voice:stop' }),
        expect.objectContaining({ label: 'model', description: 'test-sonic' }),
        expect.objectContaining({
          label: 'spoken replies',
          control: expect.objectContaining({ kind: 'toggle', checked: false }),
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

  it('queues spoken replies while the coding response is still streaming', async () => {
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
    await vi.waitFor(() => expect(voice.speak).toHaveBeenCalledWith('First sentence.'))
    expect(manager.getSnapshot().status).toBe('running')

    release()
    await running
    expect(voice.speak.mock.calls.map(([text]) => text)).toEqual([
      'First sentence.',
      'Second sentence without punctuation',
    ])

    await manager.dispose()
  })

  it('interrupts an active coding turn as soon as voice speech begins', async () => {
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
    voice.emitSpeechStart()
    expect(target.cancel).toHaveBeenCalledOnce()

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
    expect(main).toBeDefined()
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

  it.each(['/goal Keep it concise', '/loop Finish the tests', '/loop --background --for 30m Finish the tests'])(
    'rejects %s without starting or forking an agent',
    async (command) => {
      const stream = vi.fn(emptyRun)
      const primary = new ChatController(backend('primary', stream))
      const fork = vi.fn(async () => primary)
      const manager = new ConversationManager(primary, { fork })

      try {
        await manager.submit(command)

        expect(manager.getSnapshot().panel).toMatchObject({ kind: 'error', title: 'unknown command' })
        expect(manager.getSnapshot().completedTurns).toEqual([])
        expect(stream).not.toHaveBeenCalled()
        expect(fork).not.toHaveBeenCalled()
      } finally {
        await manager.dispose()
      }
    }
  )

  it('renames the currently viewed agent and updates peer discovery', async () => {
    const agentMessaging = new AgentMessaging()
    const rename = vi.spyOn(agentMessaging, 'rename')
    const primary = new ChatController(backend('primary', emptyRun))
    const manager = new ConversationManager(primary, {
      fork: async () => primary,
      agentMessaging,
    })

    await manager.submit('/rename "Lead Reviewer"')
    await manager.submit('/agents')

    expect(rename).toHaveBeenLastCalledWith('agent-1', 'Lead Reviewer')
    expect(manager.getSnapshot().panel?.rows[0]).toMatchObject({
      label: 'Lead Reviewer',
      current: true,
      badge: { text: 'idle' },
    })
    expect(manager.getSnapshot().runtime.configuration).toContainEqual({
      label: 'agent',
      value: 'Lead Reviewer (1 total)',
    })
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

  it('disposes a fork that finishes after the manager shuts down', async () => {
    let finishFork!: (controller: ChatController) => void
    const forkReady = new Promise<ChatController>((resolve) => {
      finishFork = resolve
    })
    const primary = new ChatController(backend('primary', emptyRun))
    const forkDispose = vi.fn()
    const fork = new ChatController({ ...backend('fork', emptyRun), dispose: forkDispose })
    const manager = new ConversationManager(primary, { fork: () => forkReady })

    const pending = manager.submit('/fork')
    manager.close()
    await manager.dispose()
    finishFork(fork)
    await pending

    expect(fork.getSnapshot().status).toBe('closed')
    expect(forkDispose).toHaveBeenCalledOnce()
  })
})

async function* emptyRun(): AsyncGenerator<ChatEvent, ChatRunResult, undefined> {
  yield { type: 'textDelta', text: '' }
  return { stopReason: 'endTurn' }
}

function fakeVoiceInput() {
  let snapshot: VoiceSessionSnapshot = {
    status: 'off',
    muted: false,
    inputLevel: 0,
    inputLevelDb: -60,
    spokenReplies: false,
    endpointingSensitivity: 'LOW',
    voice: 'tiffany',
  }
  const listeners = new Set<() => void>()
  const transcriptListeners = new Set<(transcript: string) => void>()
  const speechListeners = new Set<() => void>()
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
      voice: snapshot.voice,
    }
    emit()
  }
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onTranscript: (listener: (transcript: string) => void) => {
      transcriptListeners.add(listener)
      return () => transcriptListeners.delete(listener)
    },
    onSpeechStart: (listener: () => void) => {
      speechListeners.add(listener)
      return () => speechListeners.delete(listener)
    },
    getSnapshot: () => ({ ...snapshot }),
    start: vi.fn(async () => {
      snapshot = { ...snapshot, status: 'listening', muted: false, model: 'test-sonic' }
      emit()
    }),
    stop: vi.fn(reset),
    speak: vi.fn((_text: string) => snapshot.status !== 'off' && snapshot.spokenReplies),
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
    emitTranscript: (transcript: string) => {
      for (const listener of transcriptListeners) {
        listener(transcript)
      }
    },
    emitSpeechStart: () => {
      for (const listener of speechListeners) {
        listener()
      }
    },
  }
}
