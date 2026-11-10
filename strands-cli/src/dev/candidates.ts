import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'

import { containsPath } from '../paths.js'
import { exportSourceProject } from '../project/export.js'
import { importAgentProject, type ImportedAgentProject } from '../project/import.js'
import { installAgentProject } from '../project/install.js'
import type { DevWorkspace } from './workspace.js'

export interface Candidate {
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

const exportBaseline = async (workspace: DevWorkspace, destination: string): Promise<void> => {
  await exportSourceProject(
    { root: workspace.root, entrypoint: workspace.entrypoint, language: workspace.config.language },
    workspace.config.name,
    workspace.config.language,
    exclusions(workspace),
    destination,
    'directory'
  )
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
    await exportBaseline(workspace, baseline)
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

export const assertCandidateCurrent = async (workspace: DevWorkspace, candidate: Candidate): Promise<void> => {
  if (candidate.source.root !== workspace.root || candidate.source.entrypoint !== workspace.entrypoint)
    throw new Error('Candidate belongs to a different agent.')
  const directory = await mkdtemp(join(tmpdir(), 'strands-candidate-check-'))
  try {
    const baseline = join(directory, 'baseline')
    await exportBaseline(workspace, baseline)
    if ((await digestTree(baseline)) !== candidate.baselineDigest)
      throw new Error(
        'The main agent changed after this candidate was created. Create a new candidate before applying changes.'
      )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
