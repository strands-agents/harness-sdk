import { lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

import { resolveSkillPaths } from '../agent/skills.js'
import type { CliConfigSnapshot } from '../config/store.js'
import { importAgentProject } from '../project/import.js'
import { installAgentProject, installProjectDependencies, type ProjectInstallation } from '../project/install.js'
import { withDevModuleFiles } from './module-files.js'
import { bindWorkspace } from './binding.js'
import { boundDevWorkspace, readDevWorkspace, WORKSPACE_FOLDER, type DevWorkspace } from './workspace.js'

export interface CreateDevWorkspaceOptions {
  destination: string
  kind: 'cli' | 'typescript' | 'python'
  snapshot: CliConfigSnapshot
  cwd: string
  signal?: AbortSignal
  deferDependencies?: boolean
}

export interface CreateDevProjectOptions {
  parent: string
  language: 'typescript' | 'python'
  snapshot: CliConfigSnapshot
  cwd: string
  signal?: AbortSignal
  deferDependencies?: boolean
}

type DestinationClaim = 'created' | 'empty'

const PROJECT_FOLDER = 'strands-workspace'
const MAX_FOLDER_NUMBER = 100

export const numberedFolder = async (
  base: string,
  accepts: (path: string) => Promise<boolean>
): Promise<string | undefined> => {
  for (let number = 1; number <= MAX_FOLDER_NUMBER; number++) {
    const candidate = number === 1 ? base : `${base}-${number}`
    if (await accepts(candidate)) return candidate
  }
  return undefined
}

const isMissing = async (path: string): Promise<boolean> => {
  try {
    await lstat(path)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
}

export const newProjectFolder = async (parent: string): Promise<string> => {
  const folder = await numberedFolder(join(parent, PROJECT_FOLDER), isMissing)
  if (!folder) throw new Error(`Every ${PROJECT_FOLDER} name in ${parent} is in use. Remove an unused one, then retry.`)
  return folder
}

type ProfileProject = Extract<ProjectInstallation, { profile: unknown }>

const profileProject = async (
  snapshot: CliConfigSnapshot,
  cwd: string,
  language: 'typescript' | 'python'
): Promise<Omit<ProfileProject, 'destination'>> => {
  const baseDir = snapshot.profileBaseDir ?? cwd
  const profile = await withDevModuleFiles(snapshot.profile, baseDir, language)
  const skills = resolveSkillPaths(
    typeof profile.skills === 'object' ? [...profile.skills] : profile.skills,
    baseDir,
    snapshot.settings.skillDiscovery
  )
  return { profile, language, skills, baseDir }
}

const portableEntrypoint = (root: string, entrypoint: string): string => relative(root, entrypoint).split(sep).join('/')

const claimDestination = async (path: string): Promise<DestinationClaim> => {
  const details = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (!details) {
    await mkdir(dirname(path), { recursive: true })
    await mkdir(path, { mode: 0o700 })
    return 'created'
  }
  if (details.isDirectory() && (await readdir(path)).length === 0) return 'empty'
  throw new Error(
    `The destination already exists: ${path}. Choose a new workspace path or open the existing workspace.`
  )
}

const releaseDestination = async (path: string, claim: DestinationClaim): Promise<void> => {
  if (claim === 'created') return rm(path, { recursive: true, force: true })
  const entries = await readdir(path).catch(() => [])
  await Promise.all(entries.map((entry) => rm(join(path, entry), { recursive: true, force: true })))
}

export const createDevWorkspace = async (options: CreateDevWorkspaceOptions): Promise<DevWorkspace> => {
  options.signal?.throwIfAborted()
  const destination = resolve(options.cwd, options.destination)
  const existing = await readDevWorkspace(destination)
  if (existing) return existing
  const claim = await claimDestination(destination)
  try {
    const origin = {
      kind: options.kind === 'cli' ? ('cli' as const) : ('created' as const),
      source: options.snapshot.agentProject ?? options.snapshot.path,
    }
    if (options.kind === 'cli' && options.snapshot.agentProject) {
      const project = importAgentProject(options.snapshot.agentProject)
      await bindWorkspace(destination, {
        version: 1,
        name: options.snapshot.profile.name,
        agent: {
          path: project.root,
          entrypoint: portableEntrypoint(project.root, project.entrypoint),
          language: project.language,
        },
        origin,
      })
    } else {
      const language = options.kind === 'python' ? 'python' : 'typescript'
      const project = await installAgentProject({
        destination: join(destination, 'agent'),
        ...(options.deferDependencies ? { deferDependencies: true } : {}),
        ...(await profileProject(options.snapshot, options.cwd, language)),
        ...(options.signal ? { signal: options.signal } : {}),
      })
      await bindWorkspace(destination, {
        version: 1,
        name: options.snapshot.profile.name,
        agent: { path: 'agent', entrypoint: portableEntrypoint(project.root, project.entrypoint), language },
        origin,
      })
    }
    options.signal?.throwIfAborted()
    const workspace = await readDevWorkspace(destination)
    if (!workspace) throw new Error(`Workspace binding is missing in ${destination}.`)
    return workspace
  } catch (error) {
    await releaseDestination(destination, claim)
    throw error
  }
}

export const createDevProject = async (options: CreateDevProjectOptions): Promise<DevWorkspace> => {
  options.signal?.throwIfAborted()
  const input = await profileProject(options.snapshot, options.cwd, options.language)
  const root = await newProjectFolder(resolve(options.cwd, options.parent))
  const project = await installAgentProject({ destination: root, deferDependencies: true, ...input })
  try {
    options.signal?.throwIfAborted()
    if (!options.deferDependencies) await installProjectDependencies(project)
    const directory = join(root, WORKSPACE_FOLDER)
    await mkdir(directory, { mode: 0o700 })
    await bindWorkspace(directory, {
      version: 1,
      name: options.snapshot.profile.name,
      agent: {
        path: '..',
        entrypoint: portableEntrypoint(project.root, project.entrypoint),
        language: options.language,
      },
      origin: { kind: 'created', source: options.snapshot.agentProject ?? options.snapshot.path },
    })
    options.signal?.throwIfAborted()
    const workspace = await readDevWorkspace(directory)
    if (!workspace) throw new Error(`Workspace binding is missing in ${directory}.`)
    return workspace
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

export const bindExistingAgent = async (destination: string, path: string): Promise<DevWorkspace> => {
  const project = importAgentProject(path)
  await mkdir(destination, { recursive: true })
  const legacy = await readDevWorkspace(project.root)
  return boundDevWorkspace(
    await bindWorkspace(destination, {
      version: 1,
      name: legacy?.config.name ?? basename(project.root),
      agent: {
        path: project.root,
        entrypoint: portableEntrypoint(project.root, project.entrypoint),
        language: project.language,
      },
      origin: { kind: 'discovered', source: project.entrypoint },
      ...(legacy?.config.harness ? { harness: legacy.config.harness } : {}),
    })
  )
}
