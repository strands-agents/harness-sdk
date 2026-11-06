import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { ChatController } from '../../src/ui/chat/controller.js'
import { CliConfigStore } from '../../src/config/store.js'
import { PythonBackend } from '../../src/project/python.js'
import { createPythonChat } from '../../src/ui/chat/runtime.js'
import { ConversationManager } from '../../src/ui/chat/conversations.js'
import { FileSessionRuntime } from '../../src/session/sessions.js'
import { idleBackend } from '../fixtures/chat-backend.js'

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
      privatePaths: [],
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
})
