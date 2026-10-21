import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { ChatController } from '../src/tui/chat/controller.js'
import { CliConfigStore } from '../src/tui/config.js'
import { PythonBackend } from '../src/tui/project/python.js'
import { createPythonChat } from '../src/tui/project/run.js'
import { ConversationManager } from '../src/tui/session/conversations.js'
import { FileSessionRuntime } from '../src/tui/session/sessions.js'
import { idleBackend } from './fixtures/chat-backend.js'

describe('/rename', () => {
  it('loads the saved name when opening a Python session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-python-rename-'))
    const source = join(directory, 'agent.py')
    const sessionDirectory = join(directory, 'sessions')
    const backend = {
      ...idleBackend(),
      cwd: directory,
      sessionId: 'saved-session',
      sessionDirectory,
      messages: [],
      skills: [],
    } as unknown as PythonBackend
    const open = vi.spyOn(PythonBackend, 'open').mockResolvedValue(backend)
    let manager: ConversationManager | undefined
    try {
      await writeFile(source, '# Test harness\n')
      await mkdir(join(sessionDirectory, 'saved-session'), { recursive: true })
      await writeFile(
        join(sessionDirectory, 'saved-session', 'cli-session.json'),
        JSON.stringify({ version: 1, name: 'Python release planning' })
      )
      manager = await createPythonChat(
        source,
        CliConfigStore.memory(),
        { cwd: directory },
        new AbortController().signal,
        () => {}
      )
      expect(manager.getSnapshot().runtime).toMatchObject({
        session: 'Python release planning',
        sessionName: 'Python release planning',
      })
    } finally {
      await manager?.dispose()
      open.mockRestore()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('persists the same session metadata as /sessions rename', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-rename-'))
    const sessions = new FileSessionRuntime({ sessionId: 'saved-session', sessionDirectory: directory }, directory, {
      workspace: directory,
    })
    const primary = new ChatController(idleBackend(), { sessions })
    const manager = new ConversationManager(primary, { fork: async () => primary })

    try {
      await manager.submit('/rename Release planning')
      expect(JSON.parse(await readFile(join(directory, 'saved-session', 'cli-session.json'), 'utf8'))).toEqual({
        version: 1,
        name: 'Release planning',
      })
      expect(manager.getSnapshot()).toMatchObject({
        runtime: { session: 'Release planning', sessionName: 'Release planning' },
        panel: { kind: 'sessions', rows: [{ label: 'Release planning', current: true }] },
      })
      await manager.submit('/sessions rename Ship checklist')
      expect(manager.getSnapshot().runtime.sessionName).toBe('Ship checklist')
      expect(await sessions.resolve('saved-session')).toMatchObject({ name: 'Ship checklist' })
    } finally {
      await manager.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('generates a name without an argument and allows an explicit rename to cancel it', async () => {
    let finish!: (name: string) => void
    let signal!: AbortSignal
    const backend = {
      ...idleBackend(),
      generateSessionName: vi.fn(
        (request: AbortSignal) =>
          new Promise<string>((resolve) => {
            signal = request
            finish = resolve
          })
      ),
    }
    const renameCurrent = vi.fn(async (name: string) => ({ sessionId: 'saved-session', name }))
    const controller = new ChatController(backend, {
      sessions: {
        current: 'saved-session',
        directory: '/tmp/sessions',
        list: async () => [],
        resolve: async () => {
          throw new Error('No saved session selected')
        },
        renameCurrent,
      },
    })
    try {
      await controller.submit('/rename')
      expect(controller.busy).toBe(false)
      expect(backend.generateSessionName).toHaveBeenCalledOnce()
      await controller.submit('/sessions rename Chosen name')
      finish('Stale generated name')
      await vi.waitFor(() =>
        expect(controller.getSnapshot().notices).toMatchObject([{ text: 'Session naming cancelled' }])
      )
      expect(signal.aborted).toBe(true)
      expect(renameCurrent).toHaveBeenCalledExactlyOnceWith('Chosen name')
      expect(controller.getSnapshot().runtime.sessionName).toBe('Chosen name')
    } finally {
      await controller.dispose()
    }
  })
})
