import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CliConfigStore } from '../../src/config/store.js'
import { PythonBackend } from '../../src/project/python.js'
import { FileSessionRuntime } from '../../src/session/sessions.js'
import { createPythonChat } from '../../src/ui/chat/runtime.js'
import { idleBackend } from '../fixtures/chat-backend.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

const SESSION_ID = 'saved-session'
const EXPIRED = 'The security token included in the request is expired'

const record = async (directory: string): Promise<unknown> =>
  JSON.parse(await readFile(join(directory, SESSION_ID, 'cli-session.json'), 'utf8'))

afterEach(() => vi.restoreAllMocks())

describe('failed turns in the session record', () => {
  it('shouldKeepTheSessionNamesWhenFailedTurnsAreSaved', async () => {
    const directory = await temporaryDirectory()
    const sessions = new FileSessionRuntime({ sessionId: SESSION_ID, sessionDirectory: directory }, directory, {
      workspace: directory,
    })

    await sessions.renameCurrent('Release planning')
    await sessions.saveFailedTurns([{ prompt: 'ship it', error: EXPIRED }])

    expect(await record(directory)).toEqual({
      version: 1,
      name: 'Release planning',
      failedTurns: [{ prompt: 'ship it', error: EXPIRED }],
    })
    expect(await sessions.resolve(SESSION_ID)).toMatchObject({
      name: 'Release planning',
      failedTurns: [{ prompt: 'ship it', error: EXPIRED }],
    })
  })

  it('shouldRemoveTheFailedTurnsWhenTheSavedListIsEmpty', async () => {
    const directory = await temporaryDirectory()
    const sessions = new FileSessionRuntime({ sessionId: SESSION_ID, sessionDirectory: directory }, directory, {
      workspace: directory,
    })
    await sessions.saveFailedTurns([{ prompt: 'ship it', error: EXPIRED }])

    await sessions.saveFailedTurns([])

    expect(await record(directory)).toEqual({ version: 1 })
    expect(await sessions.resolve(SESSION_ID)).not.toHaveProperty('failedTurns')
  })

  it('shouldNotWriteFailedTurnsWhenTheSessionCannotBeResumed', async () => {
    const directory = await temporaryDirectory()
    const sessions = new FileSessionRuntime({ sessionId: SESSION_ID, sessionDirectory: directory }, directory, {
      workspace: directory,
      currentSessionResumable: false,
    })

    await sessions.saveFailedTurns([{ prompt: 'ship it', error: EXPIRED }])

    await expect(readFile(join(directory, SESSION_ID, 'cli-session.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('shouldSkipMalformedFailedTurnsWhenTheRecordIsRead', async () => {
    const directory = await temporaryDirectory()
    await mkdir(join(directory, SESSION_ID), { recursive: true })
    await writeFile(
      join(directory, SESSION_ID, 'cli-session.json'),
      JSON.stringify({
        version: 1,
        failedTurns: [{ prompt: 'ship\u001b[2J it', error: EXPIRED }, { prompt: 3 }, 'broken'],
      })
    )
    const sessions = new FileSessionRuntime({ sessionId: SESSION_ID, sessionDirectory: directory }, directory, {
      workspace: directory,
    })

    const target = await sessions.resolve(SESSION_ID)

    expect(target.failedTurns).toEqual([{ prompt: 'ship it', error: EXPIRED }])
  })

  it('shouldShowTheSavedFailedPromptWhenAPythonSessionResumes', async () => {
    const directory = await temporaryDirectory()
    const source = join(directory, 'agent.py')
    const sessionDirectory = join(directory, 'sessions')
    await writeFile(source, '# Test harness\n')
    await mkdir(join(sessionDirectory, SESSION_ID), { recursive: true })
    await writeFile(
      join(sessionDirectory, SESSION_ID, 'cli-session.json'),
      JSON.stringify({ version: 1, failedTurns: [{ prompt: 'ship it', error: EXPIRED }] })
    )
    const backend = {
      ...idleBackend(),
      cwd: directory,
      sessionId: SESSION_ID,
      sessionDirectory,
      sessionIdentity: {
        sessionId: SESSION_ID,
        sessionDirectory,
        workspace: directory,
        configured: { sessionId: SESSION_ID, sessionDir: sessionDirectory },
      },
      messages: [],
      skills: [],
      privatePaths: [],
    } as unknown as PythonBackend
    vi.spyOn(PythonBackend, 'open').mockResolvedValue(backend)

    const manager = await createPythonChat(
      source,
      CliConfigStore.memory(),
      { cwd: directory },
      new AbortController().signal,
      () => {}
    )

    try {
      expect(manager.getSnapshot().completedTurns).toMatchObject([
        { prompt: 'ship it', status: 'error', error: EXPIRED },
      ])
    } finally {
      await manager.dispose()
    }
  })
})
