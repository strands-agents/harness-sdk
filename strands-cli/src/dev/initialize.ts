import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

import { containsPath } from '../paths.js'
import { exportSourceProject } from '../project/export.js'
import { importAgentProject, type ImportedAgentProject } from '../project/import.js'
import { installAgentProject } from '../project/install.js'
import { isRecord } from '../values.js'
import { bindWorkspace, boundDevWorkspace, readWorkspaceBinding, type DevWorkspace } from './workspace.js'

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

interface Candidate {
  version: 1
  id: string
  directory: string
  entrypoint: string
  baselineDigest: string
  source: { root: string; entrypoint: string }
}

const exclusions = (workspace: DevWorkspace): string[] => {
  const control = workspace.directory ?? workspace.root
  return [
    '.agent/sessions',
    '.agent/memory',
    '.strands/state',
    '.strands/reports',
    '.config',
    ...(control === workspace.root
      ? ['tmp']
      : containsPath(workspace.root, control)
        ? [relative(workspace.root, control)]
        : []),
  ]
}

const digestTree = async (root: string): Promise<string> => {
  const hash = createHash('sha256')
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Candidate source must not contain symbolic links: ${path}`)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile())
        hash
          .update(relative(root, path).split(sep).join('/'))
          .update('\0')
          .update(await readFile(path))
          .update('\0')
      else throw new Error(`Unsupported candidate source: ${path}`)
    }
  }
  await visit(root)
  return hash.digest('hex')
}

export const createCandidate = async (
  workspace: DevWorkspace,
  signal?: AbortSignal,
  prepare?: (project: ImportedAgentProject) => Promise<void>
): Promise<Candidate> => {
  signal?.throwIfAborted()
  const control = resolve(workspace.directory ?? workspace.root)
  const temporary = join(control, 'tmp')
  await mkdir(temporary, { recursive: true, mode: 0o700 })
  if ((await lstat(temporary)).isSymbolicLink() || (await realpath(temporary)) !== temporary)
    throw new Error('Candidate directory must not be a symbolic link.')
  const id = randomUUID()
  const destination = join(temporary, id)
  await mkdir(destination, { mode: 0o700 })
  try {
    const baseline = join(destination, 'baseline')
    await exportSourceProject(
      { root: workspace.root, entrypoint: workspace.entrypoint, language: workspace.config.language },
      workspace.config.name,
      workspace.config.language,
      exclusions(workspace),
      baseline,
      'directory'
    )
    const baselineDigest = await digestTree(baseline)
    signal?.throwIfAborted()
    const project = await installAgentProject({
      source: importAgentProject(baseline),
      destination: join(destination, 'agent'),
      name: workspace.config.name,
      privatePaths: [],
      ...(prepare ? { prepare } : {}),
      ...(signal ? { signal } : {}),
    })
    const entrypoint = relative(project.root, project.entrypoint).split(sep).join('/')
    const candidate: Candidate = {
      version: 1,
      id,
      directory: destination,
      entrypoint: join(destination, 'agent', entrypoint),
      baselineDigest,
      source: { root: workspace.root, entrypoint: workspace.entrypoint },
    }
    await mkdir(join(destination, 'reports'))
    await writeFile(join(destination, 'candidate.json'), `${JSON.stringify(candidate, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    })
    signal?.throwIfAborted()
    return candidate
  } catch (error) {
    await rm(destination, { recursive: true, force: true })
    throw error
  }
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
  const binding = await readWorkspaceBinding(workspace.directory)
  const bound = binding ? { ...boundDevWorkspace(binding), directory: workspace.directory } : workspace
  const existing = await initialCandidate(bound)
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
    const ready = await initialCandidate(bound)
    if (ready) return ready
    candidate = await createCandidate(bound, signal, prepare)
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

export const ensureInitialCopy = (workspace: DevWorkspace, signal?: AbortSignal): Promise<string> =>
  ensureInitialCandidate(workspace, signal, async (candidate): Promise<void> => {
    const { planProjectPreparation } = await import('../project/preparation-plan.js')
    const { executePreparation } = await import('../project/preparation.js')
    await executePreparation(await planProjectPreparation(candidate), signal ? { signal } : {})
  })
