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
        JSON.stringify({ version: 1, name: 'Python release planning', agentName: 'Python reviewer' })
      )
      manager = await createPythonChat(
        source,
        CliConfigStore.memory(),
        { cwd: directory },
        new AbortController().signal,
        () => {}
      )
      expect(manager.getSnapshot().runtime).toMatchObject({
        agent: 'Python reviewer',
        session: 'Python release planning',
        sessionName: 'Python release planning',
      })
    } finally {
      await manager?.dispose()
      open.mockRestore()
      await rm(directory, { recursive: true, force: true })
    }
  })

  // https://github.com/strands-agents/harness-sdk/pull/5194#discussion_r4525136903
  it('persists independent agent and session names and reports metadata write failures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-rename-'))
    const host = { sessionId: 'saved-session', sessionDirectory: directory }
    const sessions = new FileSessionRuntime(host, directory, {
      workspace: directory,
    })
    const backend = idleBackend({
      info: () => ({ sessionId: host.sessionId }),
      async clear() {
        host.sessionId = 'fresh-session'
        await mkdir(join(directory, host.sessionId, 'cli-session.json'), { recursive: true })
      },
    })
    const primary = new ChatController(backend, { sessions })
    const manager = new ConversationManager(primary, { fork: async () => primary })

    try {
      await manager.submit('/sessions rename Release planning')
      await manager.submit('/rename Reviewer')
      expect(JSON.parse(await readFile(join(directory, 'saved-session', 'cli-session.json'), 'utf8'))).toEqual({
        version: 1,
        name: 'Release planning',
        agentName: 'Reviewer',
      })
      expect(manager.getSnapshot()).toMatchObject({
        runtime: { agent: 'Reviewer', session: 'Release planning', sessionName: 'Release planning' },
        panel: { kind: 'sessions', rows: [{ label: 'Release planning', current: true }] },
      })
      await manager.submit('/sessions rename Ship checklist')
      expect(manager.getSnapshot().runtime.sessionName).toBe('Ship checklist')
      expect(await sessions.resolve('saved-session')).toMatchObject({ name: 'Ship checklist', agentName: 'Reviewer' })
      const reopened = new FileSessionRuntime(host, directory, { workspace: directory })
      expect(await reopened.resolve('saved-session')).toMatchObject({ name: 'Ship checklist', agentName: 'Reviewer' })

      await manager.submit('/rename ""')
      expect(manager.getSnapshot().runtime.agent).toBe('Reviewer')
      expect(manager.getSnapshot().panel?.rows[0]?.description).toBe('Agent names cannot be empty.')

      host.sessionId = 'blocked'
      await writeFile(join(directory, 'blocked'), 'not a directory')
      await manager.submit('/rename Unsaved name')
      expect(manager.getSnapshot().runtime.agent).toBe('Reviewer')
      expect(manager.getSnapshot().panel).toMatchObject({ kind: 'error', title: 'agent rename failed' })

      await manager.submit('Previous turn')
      expect(manager.getSnapshot().completedTurns).toHaveLength(1)
      await manager.submit('/clear')
      expect(manager.getSnapshot()).toMatchObject({
        runtime: { agent: 'Reviewer', session: 'fresh-session' },
        completedTurns: [],
        notices: [
          { status: 'error', text: expect.stringContaining('Conversation cleared; agent name could not be saved:') },
        ],
      })
      expect(manager.getSnapshot().runtime.sessionName).toBeUndefined()
      expect(manager.getSnapshot().panel).toBeUndefined()
      expect(manager.getSnapshot().composerStatus).toBeUndefined()
      await manager.submit('New turn')
      expect(manager.getSnapshot().completedTurns).toHaveLength(1)
    } finally {
      await manager.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
