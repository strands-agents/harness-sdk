import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { sessionRows } from '../src/tui/chat/panels.js'
import {
  FileSessionRuntime,
  sessionRootDirectory,
  SessionRootCatalog,
  withWorkspaceSessionDirectory,
  workspaceSessionDirectory,
} from '../src/tui/session/sessions.js'

describe('session catalog', () => {
  it('only exposes resumable file-backed identities and follows the current session after clear', () => {
    const workspace = process.cwd()
    const host = { sessionId: 'first-session', sessionDirectory: join(workspace, 'sessions') }
    const sessions = new FileSessionRuntime(host, host.sessionDirectory, { workspace })
    expect(sessions.currentTarget).toEqual({
      sessionId: 'first-session',
      sessionDirectory: host.sessionDirectory,
      workspace,
      active: true,
    })
    host.sessionId = 'next-session'
    expect(sessions.currentTarget?.sessionId).toBe('next-session')
    const disabled = new FileSessionRuntime(host, host.sessionDirectory, {
      workspace,
      currentSessionResumable: false,
    })
    expect(disabled.currentTarget).toBeUndefined()
  })

  it('lists and resolves sessions across registered workspaces', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-session-catalog-'))
    const root = join(directory, 'cli', 'sessions')
    const firstWorkspace = join(directory, 'first-worktree')
    const secondWorkspace = join(directory, 'second-worktree')
    const firstSessions = workspaceSessionDirectory(firstWorkspace, root)
    const secondSessions = workspaceSessionDirectory(secondWorkspace, root)
    const catalog = await SessionRootCatalog.load(root)
    await mkdir(join(firstSessions, 'shared-name'), { recursive: true })
    await mkdir(join(secondSessions, 'shared-name'), { recursive: true })
    await catalog.register(firstSessions, firstWorkspace)
    const externalCatalog = await SessionRootCatalog.load(root)
    const sessions = new FileSessionRuntime(
      {
        sessionId: undefined,
        sessionDirectory: firstSessions,
      },
      firstSessions,
      { catalog, workspace: firstWorkspace }
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

  it('reads workspace-local roots from the legacy catalog and skips roots that cannot be listed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-session-metadata-'))
    const root = join(directory, 'cli', 'sessions')
    const workspace = join(directory, 'workspace')
    const sessionsDirectory = join(workspace, '.agent', 'sessions')
    const snapshotDirectory = join(sessionsDirectory, 'saved-one', 'scopes', 'agent', 'agent-one', 'snapshots')
    const brokenRoot = join(directory, 'not-a-directory')
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
    const legacyRoots = [
      { directory: sessionsDirectory, workspace, lastSeenAt: '2026-08-15T00:00:00.000Z' },
      { directory: brokenRoot, workspace: join(directory, 'broken-workspace'), lastSeenAt: '2026-08-15T00:00:00.000Z' },
    ]
    await mkdir(join(directory, 'cli'), { recursive: true })
    await writeFile(join(directory, 'cli', 'session-roots.json'), JSON.stringify({ version: 1, roots: legacyRoots }))
    const catalog = await SessionRootCatalog.load(root)
    const currentDirectory = workspaceSessionDirectory(join(directory, 'current'), root)
    const sessions = new FileSessionRuntime(
      {
        sessionId: undefined,
        sessionDirectory: currentDirectory,
      },
      currentDirectory,
      { catalog, workspace: join(directory, 'current') }
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

  it('writes to the current root while discovering sessions from the previous root', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-session-root-migration-'))
    const root = join(directory, '.strands', 'sessions')
    const previousRoot = join(directory, '.strands', 'cli', 'sessions')
    const previousWorkspace = join(directory, 'previous-workspace')
    const currentWorkspace = join(directory, 'current-workspace')
    const previousSessions = workspaceSessionDirectory(previousWorkspace, previousRoot)
    const currentSessions = workspaceSessionDirectory(currentWorkspace, root)
    const previousCatalog = await SessionRootCatalog.load(previousRoot)

    try {
      await previousCatalog.register(previousSessions, previousWorkspace)
      const catalog = await SessionRootCatalog.load(root, previousRoot)
      await catalog.register(currentSessions, currentWorkspace)

      expect(catalog.roots()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ directory: previousSessions, workspace: previousWorkspace }),
          expect.objectContaining({ directory: currentSessions, workspace: currentWorkspace }),
        ])
      )
      await expect(readFile(join(currentSessions, 'workspace.json'), 'utf8')).resolves.toContain(currentWorkspace)
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

  it('ignores a malformed legacy catalog and registers only central directories', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-session-catalog-race-'))
    const root = join(directory, 'cli', 'sessions')
    const legacyPath = join(directory, 'cli', 'session-roots.json')
    const firstWorkspace = join(directory, 'first')
    const secondWorkspace = join(directory, 'second')
    const firstSessions = workspaceSessionDirectory(firstWorkspace, root)
    const secondSessions = workspaceSessionDirectory(secondWorkspace, root)
    await mkdir(join(directory, 'cli'), { recursive: true })
    await writeFile(legacyPath, '{ invalid json')
    const [first, second] = await Promise.all([SessionRootCatalog.load(root), SessionRootCatalog.load(root)])

    try {
      await Promise.all([
        first.register(firstSessions, firstWorkspace),
        second.register(secondSessions, secondWorkspace),
        first.register(join(firstWorkspace, '.agent', 'sessions'), firstWorkspace),
      ])
      const reloaded = await SessionRootCatalog.load(root)
      expect(reloaded.roots()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ directory: firstSessions, workspace: firstWorkspace }),
          expect.objectContaining({ directory: secondSessions, workspace: secondWorkspace }),
        ])
      )
      expect(reloaded.roots()).toHaveLength(2)
      await expect(readdir(firstWorkspace)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(legacyPath, 'utf8')).resolves.toBe('{ invalid json')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('points default sessions at the central workspace directory and keeps a configured one', () => {
    const workspace = join(tmpdir(), 'workspace')
    const central = { session: { dir: workspaceSessionDirectory(workspace) } }
    expect(sessionRootDirectory()).toBe(join(homedir(), '.strands', 'sessions'))
    expect(central.session.dir.startsWith(sessionRootDirectory())).toBe(true)
    expect(
      withWorkspaceSessionDirectory({ session: { dir: '/w/.agent/sessions' } }, { session: true }, workspace)
    ).toEqual(central)
    expect(
      withWorkspaceSessionDirectory(
        { session: { id: 'u1', dir: '/w/.agent/sessions' } },
        { session: { id: 'u1' } },
        workspace
      )
    ).toEqual({ session: { id: 'u1', dir: central.session.dir } })
    expect(
      withWorkspaceSessionDirectory({ session: { dir: '/w/custom' } }, { session: { dir: 'custom' } }, workspace)
    ).toEqual({ session: { dir: '/w/custom' } })
    expect(withWorkspaceSessionDirectory({ session: false }, { session: false }, workspace)).toEqual({ session: false })
  })

  it('names a workspace directory after the workspace and a hash of its path', () => {
    const root = join(tmpdir(), 'sessions')
    const first = workspaceSessionDirectory(join(tmpdir(), 'a', 'my project'), root)
    const second = workspaceSessionDirectory(join(tmpdir(), 'b', 'my project'), root)
    expect(first).toMatch(/[/\\]my-project-[0-9a-f]{12}$/)
    expect(first.startsWith(root)).toBe(true)
    expect(second).not.toBe(first)
    expect(workspaceSessionDirectory(join(tmpdir(), 'a', 'my project'), root)).toBe(first)
  })
})

describe('session timestamps', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.each([
    ['America/New_York', '2026-01-01T02:30:00Z', '12/31 21:30 EST'],
    ['America/New_York', '2026-07-01T02:30:00Z', '06/30 22:30 EDT'],
    ['Asia/Kathmandu', '2026-01-01T02:30:00Z', '01/01 08:15 GMT+5:45'],
    ['UTC', '2026-01-01T00:00:00Z', '01/01 00:00 UTC'],
  ])('shows local time in %s for %s', (timeZone, updatedAt, expected) => {
    vi.stubEnv('TZ', timeZone)
    const [row] = sessionRows([{ id: 'saved-session', active: false, updatedAt }])
    expect(row?.columns?.[2]).toBe(expected)
  })
})
