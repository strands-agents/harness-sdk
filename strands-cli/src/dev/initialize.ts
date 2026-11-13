import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

import { bindWorkspace } from './binding.js'
import { createCandidate, type Candidate } from './candidates.js'
import { boundDevWorkspace, type DevWorkspace } from './workspace.js'
import { isRecord } from '../values.js'
import type { ImportedAgentProject } from '../project/import.js'

export const initializeWorkspaceBinding = async (workspace: DevWorkspace, directory: string): Promise<DevWorkspace> => {
  const target = resolve(workspace.directory ?? directory)
  await mkdir(target, { recursive: true })
  return boundDevWorkspace(
    await bindWorkspace(target, {
      version: 1,
      name: workspace.config.name,
      agent: {
        path: workspace.root,
        entrypoint: relative(workspace.root, workspace.entrypoint).split(sep).join('/'),
        language: workspace.config.language,
      },
      origin: workspace.config.origin,
      ...(workspace.config.harness ? { harness: workspace.config.harness } : {}),
    })
  )
}

const initialCandidate = async (workspace: DevWorkspace): Promise<string | undefined> => {
  const directory = workspace.directory!
  const marker = join(directory, 'tmp', 'initial.json')
  try {
    const details = await lstat(marker)
    if (!details.isFile() || details.isSymbolicLink() || details.size > 65536)
      throw new Error(`Invalid initial candidate record: ${marker}`)
    const value: unknown = JSON.parse(await readFile(marker, 'utf8'))
    if (!isRecord(value) || value.version !== 1 || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/u.test(value.id))
      throw new Error(`Invalid initial candidate record: ${marker}`)
    const candidateRoot = join(directory, 'tmp', value.id)
    const directoryDetails = await lstat(candidateRoot)
    if (!directoryDetails.isDirectory() || directoryDetails.isSymbolicLink())
      throw new Error(`Initial candidate must not be a symbolic link: ${candidateRoot}`)
    const recordPath = join(candidateRoot, 'candidate.json')
    const recordDetails = await lstat(recordPath)
    if (!recordDetails.isFile() || recordDetails.isSymbolicLink() || recordDetails.size > 65536)
      throw new Error(`Invalid candidate record: ${recordPath}`)
    const record: unknown = JSON.parse(await readFile(recordPath, 'utf8'))
    if (
      !isRecord(record) ||
      record.version !== 1 ||
      record.id !== value.id ||
      !isRecord(record.source) ||
      record.source.root !== workspace.root ||
      record.source.entrypoint !== workspace.entrypoint
    ) {
      throw new Error(`Initial candidate belongs to a different agent: ${marker}`)
    }
    const agentDetails = await lstat(join(candidateRoot, 'agent'))
    if (!agentDetails.isDirectory() || agentDetails.isSymbolicLink())
      throw new Error(`Invalid initial candidate project: ${candidateRoot}`)
    return candidateRoot
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export const ensureInitialCandidate = async (
  workspace: DevWorkspace,
  signal?: AbortSignal,
  prepare?: (project: ImportedAgentProject) => Promise<void>
): Promise<string> => {
  if (!workspace.directory) throw new Error('Initialize the workspace binding before creating its initial copy.')
  signal?.throwIfAborted()
  const existing = await initialCandidate(workspace)
  if (existing) return existing
  const lock = join(workspace.directory, 'tmp', '.initializing')
  try {
    await mkdir(lock, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(
        `Initial workspace copy is already being prepared. If no dev process is running, remove ${lock} and retry.`,
        { cause: error }
      )
    throw error
  }
  let candidate: Candidate | undefined
  try {
    const ready = await initialCandidate(workspace)
    if (ready) return ready
    candidate = await createCandidate(workspace, signal, prepare)
    signal?.throwIfAborted()
    const marker = join(workspace.directory, 'tmp', 'initial.json')
    const staged = join(lock, 'initial.json')
    await writeFile(staged, `${JSON.stringify({ version: 1, id: candidate.id }, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    })
    await rename(staged, marker)
    return candidate.directory
  } catch (error) {
    if (candidate) await rm(candidate.directory, { recursive: true, force: true })
    throw error
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}
