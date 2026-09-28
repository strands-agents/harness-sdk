import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { PythonVoiceSession, resolveVoiceSidecarPath, type VoiceSessionSnapshot } from '../src/tui/voice/session.js'

describe('PythonVoiceSession', () => {
  it('streams finalized user transcripts, toggles mute, and stops cleanly', async () => {
    const transcript = vi.fn()
    const speechStart = vi.fn()
    const session = new PythonVoiceSession({
      command: process.execPath,
      args: [resolve(import.meta.dirname, 'fixtures/voice-sidecar.mjs'), '--emit-transcript'],
      startTimeoutMs: 2_000,
      stopTimeoutMs: 500,
    })
    session.onTranscript(transcript)
    session.onSpeechStart(speechStart)

    await session.start()
    expect(session.getSnapshot()).toMatchObject({
      status: 'listening',
      muted: false,
      spokenReplies: false,
      endpointingSensitivity: 'LOW',
      voice: 'tiffany',
      model: 'test-sonic',
    })
    await vi.waitFor(() => expect(transcript).toHaveBeenCalledWith('hello from voice'))
    expect(speechStart).toHaveBeenCalledOnce()
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
    expect(session.speak('Finished the task.')).toBe(true)
    await vi.waitFor(() => expect(session.getSnapshot().status).toBe('muted'))

    expect(session.setSpokenReplies(false)).toBe(true)
    expect(session.speak('This should remain silent.')).toBe(false)
    expect(session.getSnapshot().spokenReplies).toBe(false)

    await session.stop()
    expect(session.getSnapshot()).toEqual({
      status: 'off',
      muted: false,
      inputLevel: 0,
      inputLevelDb: -60,
      spokenReplies: false,
      endpointingSensitivity: 'LOW',
      voice: 'tiffany',
    })
  })

  it('plays requested replies and restarts when endpointing or voice changes', async () => {
    const statuses: VoiceSessionSnapshot['status'][] = []
    const session = new PythonVoiceSession({
      command: process.execPath,
      args: [resolve(import.meta.dirname, 'fixtures/voice-sidecar.mjs')],
      startTimeoutMs: 2_000,
      stopTimeoutMs: 500,
    })
    session.subscribe(() => statuses.push(session.getSnapshot().status))

    await session.start()
    expect(session.setSpokenReplies(true)).toBe(true)
    expect(session.speak('The first streamed sentence.')).toBe(true)
    expect(session.speak('The second streamed sentence.')).toBe(true)
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

    await session.dispose()
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
      startTimeoutMs: 2_000,
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
      startTimeoutMs: 2_000,
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

  it('keeps sidecar exit diagnostics compact and non-duplicated', async () => {
    const session = new PythonVoiceSession({
      command: process.execPath,
      args: [resolve(import.meta.dirname, 'fixtures/voice-sidecar.mjs'), '--exit-error'],
      startTimeoutMs: 2_000,
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
