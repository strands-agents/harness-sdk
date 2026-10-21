import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { PythonVoiceSession, resolveVoiceSidecarPath, type VoiceSessionSnapshot } from '../src/tui/voice/session.js'

const START_TIMEOUT_MS = 5_000

describe('PythonVoiceSession', () => {
  it('tracks microphone activity, toggles mute, and stops cleanly', async () => {
    const statuses: VoiceSessionSnapshot['status'][] = []
    const session = new PythonVoiceSession({
      command: process.execPath,
      args: [resolve(import.meta.dirname, 'fixtures/voice-sidecar.mjs'), '--emit-transcript'],
      startTimeoutMs: START_TIMEOUT_MS,
      stopTimeoutMs: 500,
    })
    session.subscribe(() => statuses.push(session.getSnapshot().status))

    await session.start()
    expect(session.getSnapshot()).toMatchObject({
      status: 'listening',
      muted: false,
      spokenReplies: false,
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

    expect(session.setSpokenReplies(true)).toBe(true)
    expect(session.narrate('Finished the task.')).toBe(true)

    expect(session.setSpokenReplies(false)).toBe(true)
    expect(session.narrate('This should remain silent.')).toBe(false)
    expect(session.getSnapshot().spokenReplies).toBe(false)

    await session.stop()
    expect(session.getSnapshot()).toEqual({
      status: 'off',
      muted: false,
      inputLevel: 0,
      inputLevelDb: -60,
      spokenReplies: false,
      endpointingSensitivity: 'LOW',
      provider: 'bedrock',
      voice: 'tiffany',
      model: 'test-sonic',
    })
  })

  it('forwards grounded narrations and restarts when endpointing or voice changes', async () => {
    const statuses: VoiceSessionSnapshot['status'][] = []
    const session = new PythonVoiceSession({
      command: process.execPath,
      args: [resolve(import.meta.dirname, 'fixtures/voice-sidecar.mjs')],
      startTimeoutMs: START_TIMEOUT_MS,
      stopTimeoutMs: 500,
    })
    session.subscribe(() => statuses.push(session.getSnapshot().status))

    await session.start()
    expect(session.setSpokenReplies(true)).toBe(true)
    expect(session.narrate('The first completed response.')).toBe(true)
    expect(session.narrate('The second completed response.')).toBe(true)
    await vi.waitFor(() => expect(statuses.filter((status) => status === 'speaking')).toHaveLength(2))
    await vi.waitFor(() => expect(session.getSnapshot().status).toBe('listening'))

    expect(await session.setEndpointingSensitivity('MEDIUM')).toBe(true)
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

    await session.dispose()
  })

  it('stays active across SDK connection restarts', async () => {
    const statuses: VoiceSessionSnapshot['status'][] = []
    const session = new PythonVoiceSession({
      command: process.execPath,
      args: [resolve(import.meta.dirname, 'fixtures/voice-sidecar.mjs'), '--emit-restart'],
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
    const session = new PythonVoiceSession({
      command: process.execPath,
      args: [resolve(import.meta.dirname, 'fixtures/voice-sidecar.mjs'), '--interrupt-speech'],
      startTimeoutMs: START_TIMEOUT_MS,
      stopTimeoutMs: 500,
    })
    await session.start()
    session.setSpokenReplies(true)
    expect(session.narrate('A requested spoken reply.')).toBe(true)
    await vi.waitFor(() => expect(session.getSnapshot().status).toBe('speaking'))
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
        resolve(import.meta.dirname, 'fixtures/voice-sidecar.mjs'),
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

  it('resolves the repository sidecar from source and built module layouts', () => {
    expect(resolveVoiceSidecarPath(resolve(import.meta.dirname, '../src/tui/voice'))).toBe(
      resolve(import.meta.dirname, '../src/tui/voice/sidecar.py')
    )
    expect(resolveVoiceSidecarPath(resolve(import.meta.dirname, '../dist/src/tui/voice'))).toBe(
      resolve(import.meta.dirname, '../src/tui/voice/sidecar.py')
    )
  })

  it('does not start a sidecar after disposal wins a pending start', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-voice-dispose-'))
    const started = join(directory, 'started')
    const stopped = join(directory, 'stopped')
    const session = new PythonVoiceSession({
      command: process.execPath,
      args: [
        resolve(import.meta.dirname, 'fixtures/voice-sidecar.mjs'),
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
      args: [resolve(import.meta.dirname, 'fixtures/voice-sidecar.mjs'), '--fatal-error', '--exit-marker', marker],
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
      args: [resolve(import.meta.dirname, 'fixtures/voice-sidecar.mjs'), '--connection-stop'],
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
      args: [resolve(import.meta.dirname, 'fixtures/voice-sidecar.mjs'), '--exit-error'],
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
