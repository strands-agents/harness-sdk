import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { promisify } from 'util'
import ts from 'typescript'
import { FileStorage } from '../file-storage.js'
import { SessionError } from '../../errors.js'
import { logger } from '../../logging/logger.js'
import {
  createTestSnapshot,
  createTestManifest,
  createTestScope,
  createTestSnapshots,
} from '../../__fixtures__/mock-storage-provider.js'
import type { SnapshotLocation } from '../storage.js'
import type { Snapshot } from '../types.js'

const SCOPE_ID = 'test-agent'

describe('FileStorage', () => {
  let storage: FileStorage
  let testDir: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `file-storage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await fs.mkdir(testDir, { recursive: true, mode: 0o700 })
    storage = new FileStorage(testDir)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    try {
      await fs.rm(testDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  // Regression: https://github.com/strands-agents/harness-sdk/issues/5212
  describe('concurrent writes', () => {
    it.each(['snapshot', 'manifest'] as const)('persists complete JSON for overlapping %s saves', async (kind) => {
      const location: SnapshotLocation = { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID }
      const values = [1, 2].map((index) =>
        kind === 'snapshot'
          ? createTestSnapshot({ appData: { value: 'x'.repeat(index * 1000) } })
          : createTestManifest({ updatedAt: `2024-01-0${index}T00:00:00.000Z` })
      )
      const writeFile = fs.writeFile.bind(fs)
      let arrived = 0
      let release!: () => void
      const writesFinished = new Promise<void>((resolve) => {
        release = resolve
      })
      // Both temporary writes finish before either rename commits.
      vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
        await writeFile(...args)
        if (++arrived === values.length) release()
        await writesFinished
      })
      const rename = fs.rename.bind(fs)
      let renaming = false
      vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
        if (renaming) throw Object.assign(new Error('Overlapping rename'), { code: 'EPERM' })
        renaming = true
        try {
          await rename(source, destination)
        } finally {
          renaming = false
        }
      })
      const stores = [storage, new FileStorage(testDir)]

      const results = await Promise.allSettled(
        values.map((value, index) =>
          kind === 'snapshot'
            ? stores[index]!.saveSnapshot({
                location,
                snapshotId: '1',
                isLatest: true,
                snapshot: value as ReturnType<typeof createTestSnapshot>,
              })
            : stores[index]!.saveManifest({ location, manifest: value as ReturnType<typeof createTestManifest> })
        )
      )

      expect(results).toEqual(values.map(() => ({ status: 'fulfilled', value: undefined })))
      const saved =
        kind === 'snapshot' ? await storage.loadSnapshot({ location }) : await storage.loadManifest({ location })
      expect(saved).toEqual(values[1])
      const directory = join(testDir, location.sessionId, 'scopes', location.scope, location.scopeId, 'snapshots')
      expect(await fs.readdir(directory)).toEqual([kind === 'snapshot' ? 'snapshot_latest.json' : 'manifest.json'])
    })

    it('starts a rename only after the previous one to the same file settles, even if it failed', async () => {
      const location: SnapshotLocation = { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID }
      const snapshots = createTestSnapshots(2)
      const error = new Error('Rename failed')
      let failFirstRename!: () => void
      const rename = vi.spyOn(fs, 'rename').mockImplementationOnce(
        () =>
          new Promise<void>((_, reject) => {
            failFirstRename = () => reject(error)
          })
      )
      const writeFile = vi.spyOn(fs, 'writeFile')

      const saves = snapshots.map((snapshot) =>
        storage.saveSnapshot({ location, snapshotId: '1', isLatest: true, snapshot })
      )
      await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(2))
      await Promise.all(writeFile.mock.results.map((result) => result.value))
      await new Promise((resolve) => setTimeout(resolve))
      expect(rename).toHaveBeenCalledTimes(1)

      failFirstRename()
      const results = await Promise.allSettled(saves)
      expect(results).toEqual([
        { status: 'rejected', reason: expect.objectContaining({ name: 'SessionError', cause: error }) },
        { status: 'fulfilled', value: undefined },
      ])
      expect(rename).toHaveBeenCalledTimes(2)
      expect(await storage.loadSnapshot({ location })).toEqual(snapshots[1])
    })

    it('rejects only the save whose write fails while an earlier rename is pending', async () => {
      const location: SnapshotLocation = { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID }
      const snapshots = createTestSnapshots(3)
      const error = new Error('Write failed')
      const renameFile = fs.rename.bind(fs)
      let finishFirstRename!: () => void
      const rename = vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
        await new Promise<void>((resolve) => {
          finishFirstRename = resolve
        })
        await renameFile(...args)
      })
      const save = (snapshot: Snapshot): Promise<void> =>
        storage.saveSnapshot({ location, snapshotId: '1', isLatest: true, snapshot })
      const unhandledRejection = vi.fn()
      process.on('unhandledRejection', unhandledRejection)

      try {
        const first = save(snapshots[0]!)
        await vi.waitFor(() => expect(rename).toHaveBeenCalledTimes(1))
        const writeFile = vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(error)
        const second = save(snapshots[1]!)
        await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1))
        const third = save(snapshots[2]!)
        await new Promise((resolve) => setTimeout(resolve))
        finishFirstRename()

        expect(await Promise.allSettled([first, second, third])).toEqual([
          { status: 'fulfilled', value: undefined },
          { status: 'rejected', reason: expect.objectContaining({ name: 'SessionError', cause: error }) },
          { status: 'fulfilled', value: undefined },
        ])
      } finally {
        process.off('unhandledRejection', unhandledRejection)
      }
      expect(unhandledRejection).not.toHaveBeenCalled()
      expect(await storage.loadSnapshot({ location })).toEqual(snapshots[2])
    })

    it('keeps the save called last when the earlier save has the larger payload', async () => {
      const location: SnapshotLocation = { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID }
      const snapshots = [4_000_000, 1].map((length) => createTestSnapshot({ appData: { value: 'x'.repeat(length) } }))

      await Promise.all(
        snapshots.map((snapshot) => storage.saveSnapshot({ location, snapshotId: '1', isLatest: true, snapshot }))
      )

      expect(await storage.loadSnapshot({ location })).toEqual(snapshots[1])
    })

    it('keeps the save called last when the earlier symbolic link check finishes later', async () => {
      const location: SnapshotLocation = { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID }
      const manifests = [1, 2].map((day) => createTestManifest({ updatedAt: `2024-01-0${day}T00:00:00.000Z` }))
      let finishFirstCheck!: () => void
      vi.spyOn(fs, 'lstat').mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            finishFirstCheck = () => reject(Object.assign(new Error('Not found'), { code: 'ENOENT' }))
          })
      )
      const writeFile = vi.spyOn(fs, 'writeFile')

      const saves = manifests.map((manifest) => storage.saveManifest({ location, manifest }))
      // The later save finishes its write while the earlier one is still on its link check.
      await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1))
      await writeFile.mock.results[0]!.value
      finishFirstCheck()
      await Promise.all(saves)

      expect(await storage.loadManifest({ location })).toEqual(manifests[1])
    })

    // Vitest caches imported modules, so a loader hook only delays `import()` in compiled code run by Node.
    it('keeps call order when a module loader hook delays imports', { timeout: 60_000 }, async () => {
      const source = fileURLToPath(new URL('../..', import.meta.url))
      ts.createProgram([join(source, 'session', 'file-storage.ts')], {
        module: ts.ModuleKind.NodeNext,
        target: ts.ScriptTarget.ES2022,
        rootDir: source,
        outDir: testDir,
        noLib: true,
        types: [],
      }).emit()
      await fs.writeFile(join(testDir, 'package.json'), '{ "type": "module" }')
      const hook = `export async function resolve(specifier, context, next) {
        await new Promise((done) => setTimeout(done, Math.random() * 3))
        return next(specifier, context)
      }`
      await fs.writeFile(
        join(testDir, 'overlapping-saves.js'),
        `import { register } from 'node:module'
        import { FileStorage } from './session/file-storage.js'

        register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(hook)}))
        const location = { sessionId: 'test-session', scope: 'agent', scopeId: 'test-agent' }
        let stale = 0
        for (let round = 0; round < 50; round++) {
          const storage = new FileStorage('round-' + round)
          await Promise.all(
            [1, 2, 3].map((call) => storage.saveSnapshot({ location, snapshotId: '1', isLatest: true, snapshot: { call } }))
          )
          if ((await storage.loadSnapshot({ location })).call !== 3) stale++
        }
        console.log(stale)`
      )

      const { stdout } = await promisify(execFile)(process.execPath, ['overlapping-saves.js'], { cwd: testDir })

      expect(stdout.trim()).toBe('0')
    })

    it('persists complete JSON for many overlapping saves on the real filesystem', async () => {
      const location: SnapshotLocation = { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID }
      const snapshots = Array.from({ length: 20 }, (_, index) =>
        createTestSnapshot({ appData: { value: 'x'.repeat((index + 1) * 1000) } })
      )
      const manifests = Array.from({ length: 20 }, (_, index) =>
        createTestManifest({ updatedAt: new Date(Date.UTC(2024, 0, index + 1)).toISOString() })
      )
      const stores = [storage, new FileStorage(testDir)]

      const results = await Promise.allSettled([
        ...snapshots.map((snapshot, index) =>
          stores[index % 2]!.saveSnapshot({ location, snapshotId: '1', isLatest: true, snapshot })
        ),
        ...manifests.map((manifest, index) => stores[index % 2]!.saveManifest({ location, manifest })),
      ])

      expect(results.filter((result) => result.status === 'rejected')).toEqual([])
      expect(await storage.loadSnapshot({ location })).toEqual(snapshots.at(-1))
      expect(await storage.loadManifest({ location })).toEqual(manifests.at(-1))
      const directory = join(testDir, location.sessionId, 'scopes', location.scope, location.scopeId, 'snapshots')
      expect((await fs.readdir(directory)).sort()).toEqual(['manifest.json', 'snapshot_latest.json'])
    })
  })

  describe('failed writes', () => {
    it.each(['writeFile', 'rename'] as const)('cleans up the temporary file after %s fails', async (operation) => {
      const location: SnapshotLocation = { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID }
      const snapshot = createTestSnapshot()
      await storage.saveSnapshot({ location, snapshotId: '1', isLatest: true, snapshot })
      const error = new Error('Write failed')
      const writeFile = fs.writeFile.bind(fs)
      if (operation === 'writeFile') {
        vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args) => {
          await writeFile(...args)
          throw error
        })
      } else {
        vi.spyOn(fs, 'rename').mockRejectedValueOnce(error)
      }

      const path = join(
        testDir,
        location.sessionId,
        'scopes',
        location.scope,
        location.scopeId,
        'snapshots',
        'snapshot_latest.json'
      )
      await expect(
        storage.saveSnapshot({
          location,
          snapshotId: '2',
          isLatest: true,
          snapshot: createTestSnapshot({ appData: { next: true } }),
        })
      ).rejects.toMatchObject({ name: 'SessionError', message: `Failed to write file ${path}`, cause: error })
      expect(await storage.loadSnapshot({ location })).toEqual(snapshot)
      expect(await fs.readdir(join(path, '..'))).toEqual(['snapshot_latest.json'])
    })

    it('preserves the write error when temporary file cleanup fails', async () => {
      const location: SnapshotLocation = { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID }
      const error = new Error('Rename failed')
      vi.spyOn(fs, 'rename').mockRejectedValueOnce(error)
      vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('Cleanup failed'))
      const path = join(
        testDir,
        location.sessionId,
        'scopes',
        location.scope,
        location.scopeId,
        'snapshots',
        'snapshot_latest.json'
      )

      await expect(
        storage.saveSnapshot({ location, snapshotId: '1', isLatest: true, snapshot: createTestSnapshot() })
      ).rejects.toMatchObject({ name: 'SessionError', message: `Failed to write file ${path}`, cause: error })
      expect(fs.rm).toHaveBeenCalledWith(expect.stringMatching(/snapshot_latest\.json\..+\.tmp$/), { force: true })
    })
  })

  // Regression: https://github.com/strands-agents/harness-sdk/issues/6248
  describe('private storage', () => {
    const location: SnapshotLocation = { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID }
    const snapshot = createTestSnapshot()
    let snapshotsDir: string
    let latestPath: string
    let outsidePath: string

    beforeEach(async () => {
      snapshotsDir = join(testDir, location.sessionId, 'scopes', location.scope, location.scopeId, 'snapshots')
      latestPath = join(snapshotsDir, 'snapshot_latest.json')
      outsidePath = join(testDir, 'outside.json')
      await fs.writeFile(outsidePath, JSON.stringify(createTestSnapshot({ appData: { outside: true } })))
    })

    it('leaves an existing .tmp file next to the target untouched', async () => {
      await fs.mkdir(snapshotsDir, { recursive: true })
      await fs.writeFile(`${latestPath}.tmp`, 'unrelated')

      await storage.saveSnapshot({ location, snapshotId: '1', isLatest: true, snapshot })

      expect(await fs.readFile(`${latestPath}.tmp`, 'utf8')).toBe('unrelated')
      expect(await storage.loadSnapshot({ location })).toEqual(snapshot)
    })

    it('saves when the directory above the storage root cannot be created, as on a Windows drive root', async () => {
      vi.spyOn(fs, 'mkdir').mockRejectedValueOnce(Object.assign(new Error('Not permitted'), { code: 'EPERM' }))

      await storage.saveSnapshot({ location, snapshotId: '1', isLatest: true, snapshot })

      expect(await storage.loadSnapshot({ location })).toEqual(snapshot)
    })

    describe.skipIf(process.platform === 'win32')('on POSIX', () => {
      const mode = async (path: string): Promise<number> => (await fs.stat(path)).mode & 0o777

      it('creates the storage root, its directories and its files accessible to the owner only', async () => {
        const parentDir = join(testDir, 'parent')
        const baseDir = join(parentDir, 'base')
        await new FileStorage(baseDir).saveSnapshot({ location, snapshotId: '1', isLatest: false, snapshot })

        const historyDir = join(
          baseDir,
          location.sessionId,
          'scopes',
          location.scope,
          location.scopeId,
          'snapshots',
          'immutable_history'
        )
        let dir = historyDir
        while (dir !== parentDir) {
          expect({ dir, mode: await mode(dir) }).toEqual({ dir, mode: 0o700 })
          dir = join(dir, '..')
        }
        expect(await mode(join(historyDir, 'snapshot_1.json'))).toBe(0o600)
        const defaultDir = join(testDir, 'default')
        await fs.mkdir(defaultDir)
        expect(await mode(parentDir)).toBe(await mode(defaultDir))
      })

      it('creates the storage root accessible to the owner only when the base directory ends in a dot segment', async () => {
        const baseDir = join(testDir, 'base')
        await new FileStorage(`${baseDir}/.`).saveSnapshot({ location, snapshotId: '1', isLatest: true, snapshot })

        expect(await mode(baseDir)).toBe(0o700)
      })

      it('refuses to load through a symbolic link', async () => {
        await fs.mkdir(snapshotsDir, { recursive: true })
        await fs.symlink(outsidePath, latestPath)

        const error = await storage.loadSnapshot({ location }).catch((caught: unknown) => caught)

        expect(error).toMatchObject({
          name: 'SessionError',
          message: `Refusing to read symbolic link at ${latestPath}`,
        })
        // The check before the read raises without a cause; the O_NOFOLLOW refusal carries ELOOP.
        expect((error as Error).cause).toBeUndefined()
      })

      it('refuses to save over a symbolic link', async () => {
        const outside = await fs.readFile(outsidePath, 'utf8')
        await fs.mkdir(snapshotsDir, { recursive: true })
        await fs.symlink(outsidePath, latestPath)

        await expect(
          storage.saveSnapshot({ location, snapshotId: '1', isLatest: true, snapshot })
        ).rejects.toMatchObject({
          name: 'SessionError',
          message: `Refusing to write to symbolic link at ${latestPath}`,
        })
        expect(await fs.readFile(outsidePath, 'utf8')).toBe(outside)
        expect(await fs.readdir(snapshotsDir)).toEqual(['snapshot_latest.json'])
      })

      it('does not write through a symbolic link planted at the temporary path', async () => {
        const outside = await fs.readFile(outsidePath, 'utf8')
        const writeFile = fs.writeFile.bind(fs)
        vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (path, ...rest) => {
          await fs.symlink(outsidePath, path as string)
          await writeFile(path, ...rest)
        })

        await expect(
          storage.saveSnapshot({ location, snapshotId: '1', isLatest: true, snapshot })
        ).rejects.toMatchObject({ name: 'SessionError', cause: expect.objectContaining({ code: 'EEXIST' }) })
        expect(await fs.readFile(outsidePath, 'utf8')).toBe(outside)
        expect(await fs.readdir(snapshotsDir)).toEqual([expect.stringMatching(/^snapshot_latest\.json\..+\.tmp$/)])
      })

      it('refuses to load through a symbolic link swapped in after the check', async () => {
        await fs.mkdir(snapshotsDir, { recursive: true })
        await fs.symlink(outsidePath, latestPath)
        vi.spyOn(fs, 'lstat').mockRejectedValueOnce(Object.assign(new Error('Not found'), { code: 'ENOENT' }))

        await expect(storage.loadSnapshot({ location })).rejects.toMatchObject({
          name: 'SessionError',
          message: `Refusing to read symbolic link at ${latestPath}`,
          cause: expect.objectContaining({ code: 'ELOOP' }),
        })
      })

      it('warns once when an existing storage root is accessible by group or others', async () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
        await fs.chmod(testDir, 0o755)

        await storage.saveSnapshot({ location, snapshotId: '1', isLatest: true, snapshot })
        await new FileStorage(testDir).saveSnapshot({ location, snapshotId: '1', isLatest: true, snapshot })

        expect(warn.mock.calls).toEqual([
          [
            `path=<${testDir}>, mode=<755> | session storage directory is accessible by group or others | restrict it with chmod 700`,
          ],
        ])
        expect(await mode(testDir)).toBe(0o755)
      })

      it('saves when the storage root cannot be checked and checks again on the next save', async () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
        const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {})
        const error = Object.assign(new Error('Not permitted'), { code: 'EACCES' })
        vi.spyOn(fs, 'stat').mockRejectedValueOnce(error)
        await fs.chmod(testDir, 0o755)

        await storage.saveSnapshot({ location, snapshotId: '1', isLatest: true, snapshot })

        expect(await storage.loadSnapshot({ location })).toEqual(snapshot)
        expect(warn).not.toHaveBeenCalled()
        expect(debug.mock.calls).toEqual([
          [`path=<${testDir}>, error=<${error}> | could not check session storage directory permissions`],
        ])

        await storage.saveSnapshot({ location, snapshotId: '1', isLatest: true, snapshot })

        expect(warn).toHaveBeenCalledTimes(1)
      })

      it('does not warn when the storage root is accessible to the owner only', async () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})

        await storage.saveSnapshot({ location, snapshotId: '1', isLatest: true, snapshot })

        expect(warn).not.toHaveBeenCalled()
      })
    })
  })

  describe('saveSnapshot', () => {
    describe('FileSnapshotStorage_When_saveSnapshot_Then_CreatesFiles', () => {
      it('saves snapshot to history file', async () => {
        const location: SnapshotLocation = { sessionId: 'test-session', scope: createTestScope(), scopeId: SCOPE_ID }
        const snapshot = createTestSnapshot()

        await storage.saveSnapshot({ location, snapshotId: '1', isLatest: false, snapshot })

        const historyPath = join(
          testDir,
          location.sessionId,
          'scopes',
          'agent',
          SCOPE_ID,
          'snapshots',
          'immutable_history',
          'snapshot_1.json'
        )
        const content = await fs.readFile(historyPath, 'utf8')
        expect(JSON.parse(content)).toEqual(snapshot)
      })

      it('saves snapshot as latest when isLatest is true', async () => {
        const location: SnapshotLocation = { sessionId: 'test-session', scope: createTestScope(), scopeId: SCOPE_ID }
        const snapshot = createTestSnapshot()

        await storage.saveSnapshot({ location, snapshotId: '1', isLatest: true, snapshot })

        const latestPath = join(
          testDir,
          location.sessionId,
          'scopes',
          'agent',
          SCOPE_ID,
          'snapshots',
          'snapshot_latest.json'
        )
        const content = await fs.readFile(latestPath, 'utf8')
        expect(JSON.parse(content)).toEqual(snapshot)
      })

      it('creates directories recursively', async () => {
        const location: SnapshotLocation = {
          sessionId: 'new-session',
          scope: createTestScope('agent'),
          scopeId: 'new-agent',
        }
        const snapshot = createTestSnapshot()

        await storage.saveSnapshot({ location, snapshotId: '1', isLatest: true, snapshot })

        const expectedDir = join(testDir, location.sessionId, 'scopes', 'agent', location.scopeId, 'snapshots')
        const stats = await fs.stat(expectedDir)
        expect(stats.isDirectory()).toBe(true)
      })
    })

    describe('FileSnapshotStorage_When_saveSnapshotFails_Then_ThrowsSessionError', () => {
      it('throws SessionError when write fails', async () => {
        const location: SnapshotLocation = { sessionId: 'test-session', scope: createTestScope(), scopeId: SCOPE_ID }
        const snapshot = createTestSnapshot()

        vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('Write failed'))

        await expect(storage.saveSnapshot({ location, snapshotId: '1', isLatest: false, snapshot })).rejects.toThrow(
          SessionError
        )
      })
    })

    describe('FileSnapshotStorage_When_InvalidScope_Then_RejectsPath', () => {
      it('rejects a scope containing path traversal', async () => {
        const location = {
          sessionId: 'test-session',
          scope: '../../../../outside',
          scopeId: SCOPE_ID,
        } as unknown as SnapshotLocation

        await expect(
          storage.saveSnapshot({ location, snapshotId: '1', isLatest: true, snapshot: createTestSnapshot() })
        ).rejects.toThrow("Invalid scope '../../../../outside': must be 'agent' or 'multiAgent'")
        await expect(fs.readdir(testDir)).resolves.toEqual([])
      })
    })

    describe('FileSnapshotStorage_When_MultiAgentScope_Then_SavesCorrectly', () => {
      it('saves multi-agent snapshot to correct path', async () => {
        const location: SnapshotLocation = {
          sessionId: 'multi-session',
          scope: createTestScope('multiAgent'),
          scopeId: 'graph-1',
        }
        const snapshot = createTestSnapshot({ scope: 'multiAgent' })

        await storage.saveSnapshot({ location, snapshotId: '1', isLatest: true, snapshot })

        const expectedPath = join(
          testDir,
          location.sessionId,
          'scopes',
          'multiAgent',
          location.scopeId,
          'snapshots',
          'snapshot_latest.json'
        )
        const content = await fs.readFile(expectedPath, 'utf8')
        expect(JSON.parse(content)).toEqual(snapshot)
      })
    })
  })

  describe('loadSnapshot', () => {
    describe('FileSnapshotStorage_When_LoadLatestSnapshot_Then_ReturnsSnapshot', () => {
      it('loads latest snapshot when snapshotId is undefined', async () => {
        const location: SnapshotLocation = { sessionId: 'test-session', scope: createTestScope(), scopeId: SCOPE_ID }
        const snapshot = createTestSnapshot()
        await storage.saveSnapshot({ location, snapshotId: '1', isLatest: true, snapshot })

        const result = await storage.loadSnapshot({ location })

        expect(result).toEqual(snapshot)
      })
    })

    describe('FileSnapshotStorage_When_LoadSpecificSnapshot_Then_ReturnsSnapshot', () => {
      it('loads specific snapshot by ID', async () => {
        const location: SnapshotLocation = { sessionId: 'test-session', scope: createTestScope(), scopeId: SCOPE_ID }
        const snapshot = createTestSnapshot()
        await storage.saveSnapshot({ location, snapshotId: '5', isLatest: false, snapshot })

        const result = await storage.loadSnapshot({ location, snapshotId: '5' })

        expect(result).toEqual(snapshot)
      })
    })

    describe('FileSnapshotStorage_When_SnapshotNotFound_Then_ReturnsNull', () => {
      it('returns null when snapshot file does not exist', async () => {
        const result = await storage.loadSnapshot({
          location: { sessionId: 'nonexistent', scope: 'agent', scopeId: SCOPE_ID },
        })
        expect(result).toBeNull()
      })
    })

    describe('FileSnapshotStorage_When_InvalidJSON_Then_ThrowsSessionError', () => {
      it('throws SessionError when JSON is invalid', async () => {
        const sessionId = 'test-session'
        const filePath = join(testDir, sessionId, 'scopes', 'agent', SCOPE_ID, 'snapshots', 'snapshot_latest.json')

        await fs.mkdir(join(testDir, sessionId, 'scopes', 'agent', SCOPE_ID, 'snapshots'), { recursive: true })
        await fs.writeFile(filePath, 'invalid json', 'utf8')

        await expect(
          storage.loadSnapshot({ location: { sessionId, scope: 'agent', scopeId: SCOPE_ID } })
        ).rejects.toThrow(SessionError)
      })
    })

    describe('FileSnapshotStorage_When_ReadError_Then_ThrowsSessionError', () => {
      it('throws SessionError when file read fails', async () => {
        vi.spyOn(fs, 'readFile').mockRejectedValueOnce(new Error('Permission denied'))
        await expect(
          storage.loadSnapshot({ location: { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID } })
        ).rejects.toThrow(SessionError)
      })
    })
  })

  describe('listSnapshotIds', () => {
    describe('FileSnapshotStorage_When_listSnapshots_Then_ReturnsOrderedIds', () => {
      it('returns sorted snapshot IDs', async () => {
        const location: SnapshotLocation = { sessionId: 'test-session', scope: createTestScope(), scopeId: SCOPE_ID }
        const snapshots = createTestSnapshots(3)
        const ids = [
          '019c9bf1-14e5-7eef-96fb-cc07ae54210f',
          '019c9bf1-1d34-7eef-96fb-d1be20fd7bbd',
          '019c9bf1-24bb-7eef-96fb-ddcc943cd859',
        ]

        await storage.saveSnapshot({ location, snapshotId: ids[2]!, isLatest: false, snapshot: snapshots[2]! })
        await storage.saveSnapshot({ location, snapshotId: ids[0]!, isLatest: false, snapshot: snapshots[0]! })
        await storage.saveSnapshot({ location, snapshotId: ids[1]!, isLatest: false, snapshot: snapshots[1]! })

        const result = await storage.listSnapshotIds({ location })

        expect(result).toEqual(ids)
      })

      it('ignores non-snapshot files', async () => {
        const location: SnapshotLocation = { sessionId: 'test-session', scope: createTestScope(), scopeId: SCOPE_ID }
        const snapshot = createTestSnapshot()
        const id = '019c9bf1-14e5-7eef-96fb-cc07ae54210f'
        await storage.saveSnapshot({ location, snapshotId: id, isLatest: false, snapshot })

        const historyDir = join(
          testDir,
          location.sessionId,
          'scopes',
          'agent',
          SCOPE_ID,
          'snapshots',
          'immutable_history'
        )
        await fs.writeFile(join(historyDir, 'other-file.txt'), 'not a snapshot', 'utf8')

        const result = await storage.listSnapshotIds({ location })
        expect(result).toEqual([id])
      })

      it('filters by startAfter for pagination', async () => {
        const location: SnapshotLocation = { sessionId: 'test-session', scope: createTestScope(), scopeId: SCOPE_ID }
        const snapshots = createTestSnapshots(3)
        const ids = [
          '019c9bf1-14e5-7eef-96fb-cc07ae54210f',
          '019c9bf1-1d34-7eef-96fb-d1be20fd7bbd',
          '019c9bf1-24bb-7eef-96fb-ddcc943cd859',
        ]
        for (let i = 0; i < ids.length; i++) {
          await storage.saveSnapshot({ location, snapshotId: ids[i]!, isLatest: false, snapshot: snapshots[i]! })
        }

        const result = await storage.listSnapshotIds({ location, startAfter: ids[0]! })

        expect(result).toEqual([ids[1], ids[2]])
      })

      it('limits results when limit is provided', async () => {
        const location: SnapshotLocation = { sessionId: 'test-session', scope: createTestScope(), scopeId: SCOPE_ID }
        const snapshots = createTestSnapshots(3)
        const ids = [
          '019c9bf1-14e5-7eef-96fb-cc07ae54210f',
          '019c9bf1-1d34-7eef-96fb-d1be20fd7bbd',
          '019c9bf1-24bb-7eef-96fb-ddcc943cd859',
        ]
        for (let i = 0; i < ids.length; i++) {
          await storage.saveSnapshot({ location, snapshotId: ids[i]!, isLatest: false, snapshot: snapshots[i]! })
        }

        const result = await storage.listSnapshotIds({ location, limit: 2 })

        expect(result).toEqual([ids[0], ids[1]])
      })

      it('combines startAfter and limit', async () => {
        const location: SnapshotLocation = { sessionId: 'test-session', scope: createTestScope(), scopeId: SCOPE_ID }
        const snapshots = createTestSnapshots(3)
        const ids = [
          '019c9bf1-14e5-7eef-96fb-cc07ae54210f',
          '019c9bf1-1d34-7eef-96fb-d1be20fd7bbd',
          '019c9bf1-24bb-7eef-96fb-ddcc943cd859',
        ]
        for (let i = 0; i < ids.length; i++) {
          await storage.saveSnapshot({ location, snapshotId: ids[i]!, isLatest: false, snapshot: snapshots[i]! })
        }

        const result = await storage.listSnapshotIds({ location, startAfter: ids[0]!, limit: 1 })

        expect(result).toEqual([ids[1]])
      })
    })

    describe('FileSnapshotStorage_When_DirectoryNotFound_Then_ReturnsEmptyArray', () => {
      it('returns empty array when directory does not exist', async () => {
        const result = await storage.listSnapshotIds({
          location: { sessionId: 'nonexistent', scope: 'agent', scopeId: SCOPE_ID },
        })
        expect(result).toEqual([])
      })
    })

    describe('FileSnapshotStorage_When_ReadDirFails_Then_ThrowsSessionError', () => {
      it('throws SessionError when readdir fails with non-ENOENT error', async () => {
        vi.spyOn(fs, 'readdir').mockRejectedValueOnce(new Error('Permission denied'))
        await expect(
          storage.listSnapshotIds({ location: { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID } })
        ).rejects.toThrow(SessionError)
      })
    })
  })

  describe('deleteSession', () => {
    describe('FileSnapshotStorage_When_DeleteSession_Then_RemovesDirectory', () => {
      it('removes the entire session directory', async () => {
        const location: SnapshotLocation = { sessionId: 'test-session', scope: createTestScope(), scopeId: SCOPE_ID }
        await storage.saveSnapshot({ location, snapshotId: '1', isLatest: true, snapshot: createTestSnapshot() })

        await storage.deleteSession({ sessionId: 'test-session' })

        await expect(fs.stat(join(testDir, 'test-session'))).rejects.toMatchObject({ code: 'ENOENT' })
      })

      it('no-ops when session directory does not exist', async () => {
        await expect(storage.deleteSession({ sessionId: 'nonexistent-session' })).resolves.toBeUndefined()
      })
    })

    describe('FileSnapshotStorage_When_DeleteSessionFails_Then_ThrowsSessionError', () => {
      it('throws SessionError when rm fails', async () => {
        vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('Permission denied'))
        await expect(storage.deleteSession({ sessionId: 'test-session' })).rejects.toThrow(SessionError)
      })
    })
  })

  describe('saveManifest', () => {
    describe('FileSnapshotStorage_When_SaveManifest_Then_CreatesFile', () => {
      it('saves manifest to correct path', async () => {
        const location: SnapshotLocation = { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID }
        const manifest = createTestManifest()

        await storage.saveManifest({ location, manifest })

        const manifestPath = join(
          testDir,
          location.sessionId,
          'scopes',
          'agent',
          SCOPE_ID,
          'snapshots',
          'manifest.json'
        )
        const content = await fs.readFile(manifestPath, 'utf8')
        expect(JSON.parse(content)).toEqual(manifest)
      })
    })

    describe('FileSnapshotStorage_When_SaveManifestFails_Then_ThrowsSessionError', () => {
      it('throws SessionError when write fails', async () => {
        vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('Write failed'))
        await expect(
          storage.saveManifest({
            location: { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID },
            manifest: createTestManifest(),
          })
        ).rejects.toThrow(SessionError)
      })
    })
  })

  describe('loadManifest', () => {
    describe('FileSnapshotStorage_When_LoadManifest_Then_ReturnsManifest', () => {
      it('loads manifest from file', async () => {
        const location: SnapshotLocation = { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID }
        const manifest = createTestManifest()
        await storage.saveManifest({ location, manifest })

        const result = await storage.loadManifest({ location })

        expect(result).toEqual(manifest)
      })
    })

    describe('FileSnapshotStorage_When_ManifestNotFound_Then_ReturnsDefault', () => {
      it('returns default manifest when manifest file does not exist', async () => {
        const result = await storage.loadManifest({
          location: { sessionId: 'nonexistent', scope: 'agent', scopeId: SCOPE_ID },
        })
        expect(result).toEqual({
          schemaVersion: '1.0',
          updatedAt: expect.any(String),
        })
      })
    })

    describe('FileSnapshotStorage_When_InvalidManifestJSON_Then_ThrowsSessionError', () => {
      it('throws SessionError when JSON is invalid', async () => {
        const sessionId = 'test-session'
        const filePath = join(testDir, sessionId, 'scopes', 'agent', SCOPE_ID, 'snapshots', 'manifest.json')

        await fs.mkdir(join(testDir, sessionId, 'scopes', 'agent', SCOPE_ID, 'snapshots'), { recursive: true })
        await fs.writeFile(filePath, 'invalid json', 'utf8')

        await expect(
          storage.loadManifest({ location: { sessionId, scope: 'agent', scopeId: SCOPE_ID } })
        ).rejects.toThrow(SessionError)
      })
    })
  })
})
