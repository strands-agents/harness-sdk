import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

import { PythonVoiceSession, resolveVoiceSidecarPath, type VoiceSessionSnapshot } from '../../src/agent/voice.js'
import { ChatController } from '../../src/ui/chat/controller.js'
import { ConversationManager } from '../../src/ui/chat/conversations.js'

const START_TIMEOUT_MS = 5_000

describe('PythonVoiceSession', () => {
  it('tracks microphone activity, toggles mute, and stops cleanly', async () => {
    const statuses: VoiceSessionSnapshot['status'][] = []
    const session = new PythonVoiceSession({
      command: process.execPath,
      args: [resolve(import.meta.dirname, '../fixtures/voice-sidecar.mjs'), '--emit-transcript'],
      startTimeoutMs: START_TIMEOUT_MS,
      stopTimeoutMs: 500,
    })
    session.subscribe(() => statuses.push(session.getSnapshot().status))

    expect(session.narrate('Voice is not enabled yet.')).toBe(false)
    await session.start()
    expect(session.getSnapshot()).toMatchObject({
      status: 'listening',
      muted: false,
      endpointingSensitivity: 'LOW',
      provider: 'bedrock',
      voice: 'tiffany',
      model: 'test-sonic',
    })
    await vi.waitFor(() => expect(statuses).toContain('hearing'))
    await vi.waitFor(() =>
      expect(session.getSnapshot()).toMatchObject({
        inputLevel: 0.58,
        inputLevelDb: -25.2,
      })
    )

    expect(session.toggleMuted()).toBe(true)
    await vi.waitFor(() => expect(session.getSnapshot().status).toBe('muted'))
    expect(session.getSnapshot()).toMatchObject({ inputLevel: 0, inputLevelDb: -60 })

    expect(session.narrate('Finished the task.')).toBe(true)

    await session.stop()
    expect(session.getSnapshot()).toEqual({
      status: 'off',
      muted: false,
      inputLevel: 0,
      inputLevelDb: -60,
      endpointingSensitivity: 'LOW',
      provider: 'bedrock',
      voice: 'tiffany',
      model: 'test-sonic',
    })
    expect(session.narrate('Voice is off.')).toBe(false)

    statuses.length = 0
    await session.start()
    expect(session.narrate('Voice replies resume after restarting.')).toBe(true)
    await vi.waitFor(() => expect(statuses).toContain('speaking'))
    await session.stop()
  })

  it('forwards grounded narrations and restarts when endpointing or voice changes', async () => {
    const statuses: VoiceSessionSnapshot['status'][] = []
    const session = new PythonVoiceSession({
      command: process.execPath,
      args: [resolve(import.meta.dirname, '../fixtures/voice-sidecar.mjs')],
      startTimeoutMs: START_TIMEOUT_MS,
      stopTimeoutMs: 500,
    })
    session.subscribe(() => statuses.push(session.getSnapshot().status))

    await session.start()
    expect(session.narrate('The first completed response.')).toBe(true)
    expect(session.narrate('The second completed response.')).toBe(true)
    await vi.waitFor(() => expect(statuses.filter((status) => status === 'speaking')).toHaveLength(2))
    await vi.waitFor(() => expect(session.getSnapshot().status).toBe('listening'))

    const restarted = new Promise<boolean>((resolve, reject) => {
      const unsubscribe = session.subscribe(() => {
        if (session.getSnapshot().status !== 'speaking') return
        unsubscribe()
        session.setEndpointingSensitivity('MEDIUM').then(resolve, reject)
      })
    })
    expect(session.narrate('Stop this reply.')).toBe(true)
    expect(await restarted).toBe(true)
    expect(session.getSnapshot()).toMatchObject({
      status: 'listening',
      endpointingSensitivity: 'MEDIUM',
    })

    expect(await session.setVoice('matthew')).toBe(true)
    expect(session.getSnapshot()).toMatchObject({
      status: 'listening',
      voice: 'matthew',
    })

    expect(await session.setProvider('openai')).toBe(true)
    expect(session.getSnapshot()).toMatchObject({
      status: 'listening',
      provider: 'openai',
      voice: 'coral',
    })
    statuses.length = 0
    expect(session.narrate('A reply from the new voice provider.')).toBe(true)
    await vi.waitFor(() => expect(statuses).toContain('speaking'))

    await session.dispose()
  })

  it('stays active across SDK connection restarts', async () => {
    const statuses: VoiceSessionSnapshot['status'][] = []
    const session = new PythonVoiceSession({
      command: process.execPath,
      args: [resolve(import.meta.dirname, '../fixtures/voice-sidecar.mjs'), '--emit-restart'],
      startTimeoutMs: START_TIMEOUT_MS,
      stopTimeoutMs: 500,
    })
    session.subscribe(() => statuses.push(session.getSnapshot().status))

    await session.start()
    statuses.length = 0
    await vi.waitFor(() => expect(statuses).toContain('connecting'))
    await vi.waitFor(() => expect(session.getSnapshot().status).toBe('listening'))

    await session.dispose()
  })

  it('honors On requested while the prior voice process is stopping', async () => {
    const session = new PythonVoiceSession({
      command: process.execPath,
      args: [resolve(import.meta.dirname, '../fixtures/voice-sidecar.mjs'), '--stop-delay', '50'],
      startTimeoutMs: START_TIMEOUT_MS,
      stopTimeoutMs: 500,
    })
    try {
      await session.start()
      await Promise.all([session.stop(), session.start()])
      expect(session.getSnapshot().status).toBe('listening')
    } finally {
      await session.dispose()
    }
  })

  it.each(['deliver', 'off'] as const)(
    'preserves only current narrations across a process gap with %s',
    async (action) => {
      const directory = await mkdtemp(join(tmpdir(), 'strands-voice-narration-'))
      const eventsPath = join(directory, 'events.jsonl')
      const started = join(directory, 'started')
      const stopped = join(directory, 'stopped')
      const session = new PythonVoiceSession({
        command: process.execPath,
        args: [
          resolve(import.meta.dirname, '../fixtures/voice-sidecar.mjs'),
          '--start-marker',
          started,
          '--stop-marker',
          stopped,
          '--connection-delay',
          '100',
          '--stop-delay',
          '100',
        ],
        env: { STRANDS_VOICE_TEST_EVENTS: eventsPath },
        startTimeoutMs: START_TIMEOUT_MS,
        stopTimeoutMs: 500,
      })
      const narrations = async (): Promise<string[]> =>
        (await readFile(eventsPath, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { type: string; text: string })
          .filter((event) => event.type === 'narration')
          .map((event) => event.text)
      try {
        await session.start()
        await rm(started)
        const restarting = session.setVoice('matthew')
        await vi.waitFor(async () => {
          await expect(access(stopped)).resolves.toBeUndefined()
        })
        expect(session.narrate('First completed task')).toBe(true)
        if (action === 'off') {
          await Promise.all([restarting, session.stop(), session.start()])
        } else {
          await vi.waitFor(async () => {
            await expect(access(started)).resolves.toBeUndefined()
          })
          expect(session.narrate('Second completed task')).toBe(true)
          const setting = session.setEndpointingSensitivity('MEDIUM')
          expect(session.narrate('Third completed task')).toBe(true)
          await Promise.all([restarting, setting])
        }
        expect(session.narrate('Current task')).toBe(true)
        await vi.waitFor(async () => {
          expect(await narrations()).toContain('Current task')
        })
        expect(await narrations()).toEqual(
          action === 'off'
            ? ['Current task']
            : ['First completed task', 'Second completed task', 'Third completed task', 'Current task']
        )
      } finally {
        await session.dispose()
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  it('terminates a stalled voice process and starts a healthy replacement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-voice-stalled-'))
    const eventsPath = join(directory, 'events.jsonl')
    const env = { STRANDS_VOICE_TEST_EVENTS: eventsPath, STRANDS_VOICE_TEST_STALL_INPUT: '1' }
    const session = new PythonVoiceSession({
      command: process.execPath,
      args: [resolve(import.meta.dirname, '../fixtures/voice-sidecar.mjs'), '--ignore-stop'],
      env,
      startTimeoutMs: START_TIMEOUT_MS,
      inputTimeoutMs: 300,
      stopTimeoutMs: 50,
    })
    try {
      await session.start()
      const { pid } = JSON.parse((await readFile(eventsPath, 'utf8')).trim()) as { pid: number }
      await vi.waitFor(() => expect(session.getSnapshot().status).toBe('error'))
      expect(session.getSnapshot().message).toContain('Voice audio stopped making progress')
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow())
      env.STRANDS_VOICE_TEST_STALL_INPUT = '0'
      await session.start()
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 400))
      expect(session.getSnapshot().status).toBe('listening')
    } finally {
      await session.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each([false, true])('keeps quiet audio healthy when muted is %s', async (muted) => {
    const session = new PythonVoiceSession({
      command: process.execPath,
      args: [resolve(import.meta.dirname, '../fixtures/voice-sidecar.mjs')],
      env: { STRANDS_VOICE_TEST_INPUT_LEVEL: '0' },
      startTimeoutMs: START_TIMEOUT_MS,
      inputTimeoutMs: 300,
      stopTimeoutMs: 500,
    })
    try {
      await session.start()
      session.setMuted(muted)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 650))
      expect(session.getSnapshot()).toMatchObject({ status: muted ? 'muted' : 'listening', inputLevel: 0 })
    } finally {
      await session.dispose()
    }
  })

  it('times out a stalled reconnect even while microphone frames continue', async () => {
    const session = new PythonVoiceSession({
      command: process.execPath,
      args: [resolve(import.meta.dirname, '../fixtures/voice-sidecar.mjs'), '--emit-restart', '--stall-reconnect'],
      startTimeoutMs: 300,
      inputTimeoutMs: 300,
      stopTimeoutMs: 500,
    })
    try {
      await session.start()
      await vi.waitFor(() => expect(session.getSnapshot().status).toBe('error'))
      expect(session.getSnapshot().message).toContain('timed out while connecting')
    } finally {
      await session.dispose()
    }
  })

  it.each(['restart', 'startup'] as const)(
    'keeps explicit Off after a pending %s without an error panel',
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), 'strands-voice-intent-'))
      const marker = join(directory, 'ready')
      const session = new PythonVoiceSession({
        command: process.execPath,
        args: [
          resolve(import.meta.dirname, '../fixtures/voice-sidecar.mjs'),
          ...(mode === 'restart'
            ? ['--stop-marker', marker, '--stop-delay', '50']
            : ['--start-marker', marker, '--no-connection']),
        ],
        startTimeoutMs: START_TIMEOUT_MS,
        stopTimeoutMs: 500,
      })
      const controller = new ChatController({
        id: 'voice-test',
        name: 'Voice test',
        protocol: 'strands',
        async *stream() {
          yield { type: 'textDelta', text: 'done' }
          return { stopReason: 'endTurn' }
        },
        cancel() {},
        async dispose() {},
      })
      const manager = new ConversationManager(controller, { fork: async () => controller, voice: session })
      try {
        if (mode === 'restart') await manager.submit('/voice on')
        const pending = mode === 'restart' ? session.setVoice('matthew') : manager.submit('/voice on')
        await vi.waitFor(async () => {
          await expect(access(marker)).resolves.toBeUndefined()
        })
        if (mode === 'startup') {
          session.setMuted(true)
          expect(session.getSnapshot()).toMatchObject({ status: 'connecting', muted: true })
        }
        await manager.submit('/voice off')
        await pending
        expect(session.getSnapshot().status).toBe('off')
        expect(manager.getSnapshot().panel).toBeUndefined()
      } finally {
        await manager.dispose()
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  it('starts replacement voice processes with the microphone still muted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-voice-muted-'))
    const eventsPath = join(directory, 'events.jsonl')
    const fixture = pathToFileURL(resolve(import.meta.dirname, '../fixtures/voice-sidecar.mjs')).href
    await writeFile(join(directory, 'run'), `import ${JSON.stringify(fixture)}\n`)
    const session = new PythonVoiceSession({
      cwd: directory,
      command: process.execPath,
      env: { STRANDS_VOICE_TEST_EVENTS: eventsPath },
      startTimeoutMs: START_TIMEOUT_MS,
      stopTimeoutMs: 500,
    })
    try {
      await session.start()
      session.setMuted(true)
      await session.setVoice('matthew')
      expect(session.getSnapshot()).toMatchObject({ status: 'muted', muted: true })
      const events = (await readFile(eventsPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(events).toMatchObject([
        { type: 'startup', muted: false },
        { type: 'startup', muted: true },
      ])
    } finally {
      await session.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('ignores supervisor and playback events from a stopping voice process', async () => {
    const session = new PythonVoiceSession({
      command: process.execPath,
      args: [resolve(import.meta.dirname, '../fixtures/voice-sidecar.mjs'), '--supervisor-during-stop'],
      startTimeoutMs: START_TIMEOUT_MS,
      stopTimeoutMs: 500,
    })
    const request = vi.fn()
    const statuses: VoiceSessionSnapshot['status'][] = []
    session.onSupervisorRequest(request)
    session.subscribe(() => statuses.push(session.getSnapshot().status))
    try {
      await session.start()
      statuses.length = 0
      await session.stop()
      expect(request).not.toHaveBeenCalled()
      expect(statuses).not.toContain('speaking')
      expect(session.getSnapshot().status).toBe('off')
    } finally {
      await session.dispose()
    }
  })

  it('keeps provider, model, and voice selections compatible before startup', async () => {
    const session = new PythonVoiceSession()

    expect(session.getSnapshot()).toMatchObject({
      provider: 'bedrock',
      model: 'amazon.nova-2-5-sonic',
      voice: 'tiffany',
    })
    expect(await session.setProvider('openai')).toBe(true)
    expect(session.getSnapshot()).toMatchObject({
      provider: 'openai',
      model: 'gpt-realtime-2.1',
      voice: 'coral',
    })
    expect(await session.setModel('amazon.nova-2-5-sonic')).toBe(false)
    expect(await session.setVoice('tiffany')).toBe(false)
    expect(session.getSnapshot().model).toBe('gpt-realtime-2.1')
    expect(session.getSnapshot().voice).toBe('coral')

    await session.dispose()
  })

  it('returns to listening after a playback interruption', async () => {
    const statuses: VoiceSessionSnapshot['status'][] = []
    const session = new PythonVoiceSession({
      command: process.execPath,
      args: [resolve(import.meta.dirname, '../fixtures/voice-sidecar.mjs'), '--interrupt-speech'],
      startTimeoutMs: START_TIMEOUT_MS,
      stopTimeoutMs: 500,
    })
    session.subscribe(() => statuses.push(session.getSnapshot().status))
    await session.start()
    expect(session.narrate('A requested spoken reply.')).toBe(true)
    await vi.waitFor(() => expect(statuses).toContain('speaking'))
    await vi.waitFor(() => expect(session.getSnapshot().status).toBe('listening'))

    await session.dispose()
  })

  it('round-trips correlated supervisor requests', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-voice-supervisor-'))
    const marker = join(directory, 'result.json')
    const request = vi.fn()
    const session = new PythonVoiceSession({
      command: process.execPath,
      args: [
        resolve(import.meta.dirname, '../fixtures/voice-sidecar.mjs'),
        '--emit-supervisor-request',
        '--supervisor-result-marker',
        marker,
      ],
      startTimeoutMs: START_TIMEOUT_MS,
      stopTimeoutMs: 500,
    })
    session.onSupervisorRequest((event) => {
      request(event)
      session.resolveSupervisorRequest(event.requestId, {
        ok: true,
        result: { accepted: true, state: 'started' },
      })
    })

    try {
      await session.start()
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith({
          requestId: 'supervisor-1',
          action: 'send_instruction',
          instruction: 'inspect the parser',
        })
      )
      await vi.waitFor(async () => {
        const result = JSON.parse(await readFile(marker, 'utf8')) as Record<string, unknown>
        expect(result).toMatchObject({
          type: 'supervisor_result',
          request_id: 'supervisor-1',
          ok: true,
          result: { accepted: true, state: 'started' },
        })
      })
    } finally {
      await session.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('resolves the repository sidecar from source modules', () => {
    expect(resolveVoiceSidecarPath(resolve(import.meta.dirname, '../../src/agent'))).toBe(
      resolve(import.meta.dirname, '../../src/agent/voice-sidecar.py')
    )
  })

  it('does not start a sidecar after disposal wins a pending start', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-voice-dispose-'))
    const started = join(directory, 'started')
    const stopped = join(directory, 'stopped')
    const session = new PythonVoiceSession({
      command: process.execPath,
      args: [
        resolve(import.meta.dirname, '../fixtures/voice-sidecar.mjs'),
        '--start-marker',
        started,
        '--exit-marker',
        stopped,
        '--connection-delay',
        '500',
      ],
      startTimeoutMs: START_TIMEOUT_MS,
      stopTimeoutMs: 500,
    })

    try {
      const start = session.start()
      await vi.waitFor(async () => {
        await expect(access(started)).resolves.toBeUndefined()
      })
      await session.dispose()
      await start

      expect(session.getSnapshot().status).toBe('off')
      await expect(access(stopped)).resolves.toBeUndefined()
      await expect(session.start()).rejects.toThrow('disposed')
    } finally {
      await session.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('stops the sidecar automatically after a fatal event', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-voice-'))
    const marker = join(directory, 'stopped')
    const session = new PythonVoiceSession({
      command: process.execPath,
      args: [resolve(import.meta.dirname, '../fixtures/voice-sidecar.mjs'), '--fatal-error', '--exit-marker', marker],
      startTimeoutMs: START_TIMEOUT_MS,
      stopTimeoutMs: 500,
    })

    try {
      await session.start()
      await vi.waitFor(() => expect(session.getSnapshot().status).toBe('error'))
      await vi.waitFor(async () => {
        await expect(access(marker)).resolves.toBeUndefined()
      })
    } finally {
      await session.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('stops the sidecar when the SDK connection ends unexpectedly', async () => {
    const session = new PythonVoiceSession({
      command: process.execPath,
      args: [resolve(import.meta.dirname, '../fixtures/voice-sidecar.mjs'), '--connection-stop'],
      startTimeoutMs: START_TIMEOUT_MS,
      stopTimeoutMs: 500,
    })

    try {
      await session.start()
      await vi.waitFor(() => expect(session.getSnapshot().status).toBe('error'))
      expect(session.getSnapshot().message).toContain('Voice connection closed: user_request')
    } finally {
      await session.dispose()
    }
  })

  it('keeps sidecar exit diagnostics compact and non-duplicated', async () => {
    const session = new PythonVoiceSession({
      command: process.execPath,
      args: [resolve(import.meta.dirname, '../fixtures/voice-sidecar.mjs'), '--exit-error'],
      startTimeoutMs: START_TIMEOUT_MS,
      stopTimeoutMs: 500,
    })

    try {
      await session.start()
      await vi.waitFor(() => expect(session.getSnapshot().status).toBe('error'))

      const message = session.getSnapshot().message ?? ''
      expect(message).toContain('Voice sidecar exited with status 1.')
      expect(message).toContain('sidecar setup failed')
      expect(message).toContain('ImportError: incompatible runtime.')
      expect(message.match(/ImportError/g)).toHaveLength(1)
      expect(message.split('\n')).toHaveLength(3)
    } finally {
      await session.dispose()
    }
  })
})
