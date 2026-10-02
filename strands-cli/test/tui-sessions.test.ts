import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { FileSessionRuntime, SessionRootCatalog } from '../src/tui/session/sessions.js'

describe('session catalog', () => {
  it('lists and resolves sessions across registered workspaces', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-session-catalog-'))
    const firstWorkspace = join(directory, 'first-worktree')
    const secondWorkspace = join(directory, 'second-worktree')
    const firstSessions = join(firstWorkspace, '.agent', 'sessions')
    const secondSessions = join(secondWorkspace, '.agent', 'sessions')
    const catalogPath = join(directory, 'config', 'session-roots.json')
    const catalog = await SessionRootCatalog.load(catalogPath)
    await mkdir(join(firstSessions, 'shared-name'), { recursive: true })
    await mkdir(join(secondSessions, 'shared-name'), { recursive: true })
    await catalog.register(firstSessions, firstWorkspace)
    const externalCatalog = await SessionRootCatalog.load(catalogPath)
    const sessions = new FileSessionRuntime(
      {
        sessionId: undefined,
        sessionDirectory: firstSessions,
      },
      firstSessions,
      { catalog }
    )

    try {
      await externalCatalog.register(secondSessions, secondWorkspace)
      const listed = await sessions.list()
      expect(listed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'shared-name', workspace: firstWorkspace, reference: 'shared-name' }),
          expect.objectContaining({
            id: 'shared-name',
            workspace: secondWorkspace,
            reference: expect.not.stringMatching(/^shared-name$/),
          }),
        ])
      )

      const remote = listed.find((session) => session.workspace === secondWorkspace)!
      const updatedWorkspace = join(directory, 'updated-second-worktree')
      await externalCatalog.register(secondSessions, updatedWorkspace)
      await expect(sessions.resolve(remote.reference!)).resolves.toMatchObject({
        sessionDirectory: secondSessions,
        workspace: updatedWorkspace,
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reads saved-session previews and skips roots that cannot be listed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-session-metadata-'))
    const workspace = join(directory, 'workspace')
    const sessionsDirectory = join(workspace, '.agent', 'sessions')
    const snapshotDirectory = join(sessionsDirectory, 'saved-one', 'scopes', 'agent', 'agent-one', 'snapshots')
    const brokenRoot = join(directory, 'not-a-directory')
    const catalog = await SessionRootCatalog.load(join(directory, 'config', 'session-roots.json'))
    await mkdir(snapshotDirectory, { recursive: true })
    await writeFile(
      join(snapshotDirectory, 'snapshot_latest.json'),
      JSON.stringify({
        scope: 'agent',
        schemaVersion: '1.0',
        createdAt: '2026-08-15T00:00:00.000Z',
        data: {
          messages: [
            { role: 'user', content: [{ text: 'Please inspect the parser\nand keep the fix small.' }] },
            { role: 'assistant', content: [{ text: 'Understood.' }] },
          ],
        },
        appData: {},
      })
    )
    await writeFile(brokenRoot, 'not a directory')
    await catalog.register(sessionsDirectory, workspace)
    await catalog.register(brokenRoot, join(directory, 'broken-workspace'))
    const sessions = new FileSessionRuntime(
      {
        sessionId: undefined,
        sessionDirectory: sessionsDirectory,
      },
      sessionsDirectory,
      { catalog, workspace }
    )

    try {
      await expect(sessions.list()).resolves.toEqual([
        expect.objectContaining({
          id: 'saved-one',
          messageCount: 2,
          preview: 'Please inspect the parser and keep the fix small.',
          workspace,
        }),
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('names and renames the current session without changing its storage ID', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-session-name-'))
    const workspace = join(directory, 'workspace')
    const sessionsDirectory = join(workspace, '.agent', 'sessions')
    const sessionId = '20260817t120000z-session'
    const sessions = new FileSessionRuntime(
      {
        sessionId,
        sessionDirectory: sessionsDirectory,
      },
      sessionsDirectory,
      { workspace }
    )

    try {
      await expect(sessions.renameCurrent('  Release\nplanning\u001b[2J  ')).resolves.toEqual({
        sessionId,
        name: 'Release planning',
      })
      await expect(sessions.list()).resolves.toEqual([
        expect.objectContaining({
          id: sessionId,
          name: 'Release planning',
          active: true,
        }),
      ])
      await expect(sessions.resolve(sessionId)).resolves.toMatchObject({
        sessionId,
        name: 'Release planning',
      })

      await sessions.renameCurrent('Ship checklist')
      const metadata = JSON.parse(await readFile(join(sessionsDirectory, sessionId, 'cli-session.json'), 'utf8')) as {
        version: number
        name: string
      }
      expect(metadata).toEqual({ version: 1, name: 'Ship checklist' })
      await expect(sessions.list()).resolves.toEqual([
        expect.objectContaining({
          id: sessionId,
          name: 'Ship checklist',
          active: true,
        }),
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('recovers a malformed catalog and merges concurrent registrations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-session-catalog-race-'))
    const catalogPath = join(directory, 'config', 'session-roots.json')
    const firstWorkspace = join(directory, 'first')
    const secondWorkspace = join(directory, 'second')
    const firstSessions = join(firstWorkspace, '.agent', 'sessions')
    const secondSessions = join(secondWorkspace, '.agent', 'sessions')
    await mkdir(join(directory, 'config'), { recursive: true })
    await writeFile(catalogPath, '{ invalid json')
    const [first, second] = await Promise.all([
      SessionRootCatalog.load(catalogPath),
      SessionRootCatalog.load(catalogPath),
    ])

    try {
      await Promise.all([
        first.register(firstSessions, firstWorkspace),
        second.register(secondSessions, secondWorkspace),
      ])
      const document = JSON.parse(await readFile(catalogPath, 'utf8')) as {
        roots: Array<{ directory: string; workspace: string }>
      }
      expect(document.roots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ directory: firstSessions, workspace: firstWorkspace }),
          expect.objectContaining({ directory: secondSessions, workspace: secondWorkspace }),
        ])
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
