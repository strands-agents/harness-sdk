import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { CliConfigSnapshot } from '../config/store.js'
import { containsPath } from '../paths.js'
import { importAgentProject, type ImportedAgentProject } from '../project/import.js'
import { readWorkspaceBinding } from './binding.js'
import { bindExistingAgent, createDevWorkspace } from './create.js'
import { ensureInitialCandidate } from './initialize.js'
import type { DevWorkspace } from './workspace.js'

export type WorkspaceReplacementRequest =
  { kind: 'import'; path: string } | { kind: 'create'; language: 'typescript' | 'python'; name: string }

export interface WorkspaceReplacement {
  apply(): Promise<DevWorkspace>
  rollback(): Promise<void>
  finish(): Promise<void>
}

export const createWorkspaceReplacement = async (options: {
  workspace: DevWorkspace
  snapshot: CliConfigSnapshot
  request: WorkspaceReplacementRequest
  signal?: AbortSignal
  prepare?: (project: ImportedAgentProject) => Promise<void>
}): Promise<WorkspaceReplacement> => {
  const { workspace, request, signal } = options
  if (!workspace.directory) throw new Error('This legacy workspace must have a .config binding before replacement.')
  const directory = resolve(workspace.directory)
  if (
    dirname(directory) === directory ||
    containsPath(directory, homedir()) ||
    (await realpath(directory)) !== directory ||
    (await lstat(directory)).isSymbolicLink()
  )
    throw new Error('Select a regular workspace directory before replacement.')
  signal?.throwIfAborted()
  if (request.kind === 'create' && (!request.name.trim() || /\p{Cc}/u.test(request.name)))
    throw new Error('Enter a valid nonempty agent name.')
  const binding = await readWorkspaceBinding(directory)
  if (!binding || binding.entrypoint !== workspace.entrypoint)
    throw new Error('The workspace binding changed. Reopen Settings before replacement.')
  const expected = await readFile(join(directory, '.config'), 'utf8')
  const originalDirectory = await lstat(directory)
  const imported = request.kind === 'import' ? importAgentProject(request.path) : undefined
  if (imported && (containsPath(directory, imported.root) || containsPath(imported.root, directory)))
    throw new Error('The imported agent must be outside the workspace folder and cannot contain it.')
  const backup = join(dirname(directory), `.${randomUUID()}.workspace-backup`)
  const lock = `${directory}.replace-lock`
  let moved = false
  let owned: { dev: number; ino: number } | undefined
  let locked = false
  let completed = false
  const release = async (): Promise<void> => {
    if (locked) {
      await rm(lock, { recursive: true })
      locked = false
    }
  }
  const unchanged = async (): Promise<void> => {
    const current = await lstat(directory)
    if (
      current.dev !== originalDirectory.dev ||
      current.ino !== originalDirectory.ino ||
      (await realpath(directory)) !== directory ||
      (await readFile(join(directory, '.config'), 'utf8')) !== expected
    )
      throw new Error('The workspace changed after confirmation. Reopen Settings and try again.')
  }
  const rollback = async (): Promise<void> => {
    if (completed) return
    if (moved) {
      try {
        const current = await lstat(directory)
        if (!owned || current.dev !== owned.dev || current.ino !== owned.ino || current.isSymbolicLink())
          throw new Error(`Workspace replacement changed unexpectedly. The original remains at ${backup}.`)
        await rm(directory, { recursive: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await rename(backup, directory)
      moved = false
    }
    await release()
  }
  return {
    apply: async (): Promise<DevWorkspace> => {
      if (completed || moved) throw new Error('This workspace replacement has already started.')
      signal?.throwIfAborted()
      await mkdir(lock, { mode: 0o700 })
      locked = true
      try {
        await unchanged()
        await rename(directory, backup)
        moved = true
        let replacement: DevWorkspace
        if (imported) {
          await mkdir(directory, { mode: 0o700 })
          owned = await lstat(directory)
          replacement = await bindExistingAgent(directory, imported.entrypoint)
        } else {
          const create = request as Extract<WorkspaceReplacementRequest, { kind: 'create' }>
          const { agentProject: _agentProject, ...saved } = options.snapshot
          const snapshot = { ...saved, profile: { ...saved.profile, name: create.name } }
          replacement = await createDevWorkspace({
            destination: directory,
            kind: create.language,
            snapshot,
            cwd: dirname(directory),
            ...(signal ? { signal } : {}),
            ...(options.prepare ? { deferDependencies: true } : {}),
          })
          owned = await lstat(directory)
        }
        if (options.prepare)
          await options.prepare({
            root: replacement.root,
            entrypoint: replacement.entrypoint,
            language: replacement.config.language,
          })
        await ensureInitialCandidate(replacement, signal, options.prepare)
        signal?.throwIfAborted()
        return replacement
      } catch (error) {
        await rollback()
        throw error
      }
    },
    rollback,
    finish: async (): Promise<void> => {
      if (!moved || completed) return
      const saved = await lstat(backup)
      const current = await lstat(directory)
      if (
        saved.dev !== originalDirectory.dev ||
        saved.ino !== originalDirectory.ino ||
        saved.isSymbolicLink() ||
        !owned ||
        current.dev !== owned.dev ||
        current.ino !== owned.ino ||
        current.isSymbolicLink()
      ) {
        throw new Error(`Workspace changed before finalization. Backup retained at ${backup}.`)
      }
      await rm(backup, { recursive: true })
      moved = false
      completed = true
      await release()
    },
  }
}
