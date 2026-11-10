import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { sessionRows } from '../../src/ui/chat/panel-state.js'
import { ChatController } from '../../src/ui/chat/controller.js'
import { filterPanelRows } from '../../src/ui/interaction.js'
import { idleBackend } from '../fixtures/chat-backend.js'
import { FileSessionRuntime, SessionRootCatalog } from '../../src/session/sessions.js'

describe('session catalog', () => {
  it.skipIf(process.platform === 'win32')(
    'keeps distinct custom directories separate when their labels match',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'strands-session-filter-'))
      const paths = [join(directory, 'custom'), join(directory, 'cu\u001b[31mstom')]
      const workspaces = [join(directory, 'workspace'), join(directory, 'work\u001b[31mspace')]
      const catalog = await SessionRootCatalog.load(join(directory, 'catalog'))
      const sessions = new FileSessionRuntime({ sessionId: undefined, sessionDirectory: paths[0]! }, paths[0]!, {
        workspace: workspaces[0]!,
        catalog,
      })
      const controller = new ChatController(idleBackend(), { sessions })
      try {
        for (let index = 0; index < paths.length; index++) {
          await mkdir(join(paths[index]!, `saved-${index}`), { recursive: true })
          await catalog.register(paths[index]!, workspaces[index]!)
        }
        const listed = await sessions.list()
        expect(listed.map((session) => session.directory)).toEqual(expect.arrayContaining(paths))
        expect(listed.map((session) => session.workspace)).toEqual(expect.arrayContaining(workspaces))
        await controller.submit('/sessions')
        const panel = controller.getSnapshot().panel!
        const filters = panel.filters!.filter((filter) => filter.id !== 'all')
        expect(filters).toHaveLength(2)
        expect(new Set(filters.map((filter) => filter.id)).size).toBe(2)
        expect(filters.map((filter) => filter.label)).toEqual(['workspace', 'workspace'])
        expect(JSON.stringify(panel)).not.toContain('\\u001b')
        for (const filter of filters) {
          const rows = filterPanelRows(panel.rows, '', filter.id)
          expect(rows).toHaveLength(1)
          const index = Number(rows[0]!.label.slice('saved-'.length))
          expect(filter.id).toBe(`directory:${encodeURIComponent(paths[index]!)}`)
          await expect(controller.sessionTarget(rows[0]!.value!)).resolves.toMatchObject({
            sessionDirectory: paths[index],
            workspace: workspaces[index],
            sessionId: `saved-${index}`,
          })
        }
      } finally {
        await controller.dispose()
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

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

  it.each(['workspace', 'custom'])('lists and resolves %s sessions across registered workspaces', async (storage) => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-session-catalog-'))
    const root = join(directory, 'cli', 'sessions')
    const firstWorkspace = join(directory, 'first-worktree')
    const secondWorkspace = join(directory, 'second-worktree')
    const firstSessions = join(firstWorkspace, '.agent', 'sessions')
    const secondSessions =
      storage === 'workspace' ? join(secondWorkspace, '.agent', 'sessions') : join(secondWorkspace, 'private-sessions')
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

  it.each([
    ['Please inspect the parser\nand keep the fix small.', 'Please inspect the parser and keep the fix small.'],
    ['a'.repeat(116) + '👩‍💻' + 'b'.repeat(10), 'a'.repeat(116) + '👩‍💻...'],
  ])('reads legacy roots, skips unreadable roots, and previews the latest prompt (%s)', async (prompt, preview) => {
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
            { role: 'user', content: [{ text: prompt }] },
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
    const currentDirectory = join(directory, 'current', '.agent', 'sessions')
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
          preview,
          workspace,
        }),
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('indexes workspace sessions while discovering sessions stored under both home roots', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-session-root-migration-'))
    const root = join(directory, '.strands', 'sessions')
    const previousRoot = join(directory, '.strands', 'cli', 'sessions')
    const previousWorkspace = join(directory, 'previous-workspace')
    const currentWorkspace = join(directory, 'current-workspace')
    const previousSessions = join(previousRoot, 'previous-workspace-0123456789ab')
    const centralSessions = join(root, 'current-workspace-0123456789ab')
    const currentSessions = join(currentWorkspace, '.agent', 'sessions')
    const previousCatalog = await SessionRootCatalog.load(previousRoot)

    try {
      await previousCatalog.register(previousSessions, previousWorkspace)
      await mkdir(centralSessions, { recursive: true })
      await writeFile(
        join(centralSessions, 'workspace.json'),
        JSON.stringify({ version: 1, workspace: currentWorkspace, lastSeenAt: '2020-01-01T00:00:00.000Z' })
      )
      const catalog = await SessionRootCatalog.load(root, previousRoot)
      await catalog.register(currentSessions, currentWorkspace)

      expect(catalog.roots()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ directory: previousSessions, workspace: previousWorkspace }),
          expect.objectContaining({ directory: centralSessions, workspace: currentWorkspace }),
          expect.objectContaining({ directory: currentSessions, workspace: currentWorkspace }),
        ])
      )
      await expect(readdir(currentSessions)).rejects.toMatchObject({ code: 'ENOENT' })
      const reloaded = await SessionRootCatalog.load(root, previousRoot)
      expect(reloaded.roots()).toContainEqual(
        expect.objectContaining({ directory: currentSessions, workspace: currentWorkspace })
      )
      await writeFile(
        join(previousSessions, 'workspace.json'),
        JSON.stringify({ version: 1, workspace: previousWorkspace, lastSeenAt: '2020-01-01T00:00:00.000Z' })
      )
      await catalog.register(previousSessions, currentWorkspace)
      await catalog.refresh()
      expect(catalog.roots().find((entry) => entry.directory === previousSessions)?.workspace).toBe(currentWorkspace)
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

      const reopened = new FileSessionRuntime({ sessionId, sessionDirectory: sessionsDirectory }, sessionsDirectory, {
        workspace,
      })
      await Promise.all([sessions.renameCurrent('Ship checklist'), reopened.renameAgent('Reviewer')])
      const metadata = JSON.parse(await readFile(join(sessionsDirectory, sessionId, 'cli-session.json'), 'utf8')) as {
        version: number
        name: string
      }
      expect(metadata).toEqual({ version: 1, name: 'Ship checklist', agentName: 'Reviewer' })
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

  it('registers directories concurrently without changing session storage or a malformed legacy catalog', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-session-catalog-race-'))
    const root = join(directory, 'cli', 'sessions')
    const legacyPath = join(directory, 'cli', 'session-roots.json')
    const firstWorkspace = join(directory, 'first')
    const secondWorkspace = join(directory, 'second')
    const firstSessions = join(firstWorkspace, '.agent', 'sessions')
    const secondSessions = join(secondWorkspace, '.agent', 'sessions')
    const customSessions = join(firstWorkspace, 'custom-sessions')
    await mkdir(join(directory, 'cli'), { recursive: true })
    await writeFile(legacyPath, '{ invalid json')
    const [first, second] = await Promise.all([SessionRootCatalog.load(root), SessionRootCatalog.load(root)])

    try {
      await Promise.all([
        first.register(firstSessions, firstWorkspace),
        second.register(secondSessions, secondWorkspace),
        first.register(customSessions, firstWorkspace),
        second.register(customSessions, firstWorkspace),
      ])
      const referenceFiles = (await readdir(root)).filter((name) => /^external-[a-f0-9]{12}\.json$/.test(name))
      expect(referenceFiles).toHaveLength(3)
      const unrelatedDocument = JSON.stringify({
        version: 1,
        directory: join(directory, 'unrelated'),
        workspace: firstWorkspace,
        lastSeenAt: new Date().toISOString(),
      })
      await writeFile(join(root, 'unrelated.json'), unrelatedDocument)
      await writeFile(join(root, 'external-000000000000.json.tmp'), unrelatedDocument)
      await writeFile(join(root, 'external-111111111111.json'), '{}')
      const reloaded = await SessionRootCatalog.load(root)
      expect(reloaded.roots()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ directory: firstSessions, workspace: firstWorkspace }),
          expect.objectContaining({ directory: secondSessions, workspace: secondWorkspace }),
          expect.objectContaining({ directory: customSessions, workspace: firstWorkspace }),
        ])
      )
      expect(reloaded.roots()).toHaveLength(3)
      await expect(readdir(firstWorkspace)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(legacyPath, 'utf8')).resolves.toBe('{ invalid json')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('retries a locked catalog replacement and preserves the last document if the lock persists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-session-catalog-lock-'))
    const root = join(directory, 'catalog')
    const sessions = join(directory, 'sessions')
    const catalog = await SessionRootCatalog.load(root)
    const locked = Object.assign(new Error('File is locked'), { code: 'EPERM' })
    const rename = vi.spyOn(fs, 'rename')
    try {
      rename.mockRejectedValueOnce(locked)
      await catalog.register(sessions, directory)
      expect(rename).toHaveBeenCalledTimes(2)
      const [reference] = await readdir(root)
      const previous = await readFile(join(root, reference!), 'utf8')
      rename.mockRejectedValue(locked)
      await expect(catalog.register(sessions, directory)).rejects.toBe(locked)
      expect(await readdir(root)).toEqual([reference])
      expect(await readFile(join(root, reference!), 'utf8')).toBe(previous)
    } finally {
      rename.mockRestore()
      await rm(directory, { recursive: true, force: true })
    }
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
