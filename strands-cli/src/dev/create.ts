import { randomUUID } from 'node:crypto'
import { renameSync, rmSync } from 'node:fs'
import { lstat, mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

import { resolveSkillPaths } from '../agent/skills.js'
import type { CliConfigSnapshot } from '../config/store.js'
import { containsPath } from '../paths.js'
import { errorMessage } from '../terminal/text.js'
import { importAgentProject, type AgentProjectLanguage } from '../project/import.js'
import { installAgentProject, installProjectDependencies, type ProjectInstallation } from '../project/install.js'
import { moduleLanguage } from '../project/portability.js'
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
  language: 'typescript' | 'python'
  snapshot: CliConfigSnapshot
  cwd: string
  signal?: AbortSignal
  deferDependencies?: boolean
}

type DestinationClaim = 'created' | 'empty'

const PROJECT_FOLDER = 'strands-workspace'

const isMissing = async (path: string): Promise<boolean> => {
  try {
    await lstat(path)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
}

export const projectFolder = (parent: string): string => join(parent, PROJECT_FOLDER)

type ProfileProject = Extract<ProjectInstallation, { profile: unknown }>

const LANGUAGE_NAMES: Record<AgentProjectLanguage, string> = { typescript: 'TypeScript', python: 'Python' }

const foreignModelModule = (snapshot: CliConfigSnapshot, language: AgentProjectLanguage): string | undefined => {
  const reference = snapshot.profile.modelModule
  const written = reference && moduleLanguage(reference)
  return written && written !== language ? reference.module : undefined
}

export const newProjectModelNotice = (
  snapshot: CliConfigSnapshot,
  language: AgentProjectLanguage
): string | undefined => {
  const module = foreignModelModule(snapshot, language)
  return (
    module &&
    `${LANGUAGE_NAMES[language]} cannot load the model module ${basename(module)}. The new harness uses ${snapshot.profile.model}.`
  )
}

const profileProject = async (
  snapshot: CliConfigSnapshot,
  cwd: string,
  language: AgentProjectLanguage
): Promise<Omit<ProfileProject, 'destination'>> => {
  const baseDir = snapshot.profileBaseDir ?? cwd
  const source = foreignModelModule(snapshot, language) ? { ...snapshot.profile, modelModule: null } : snapshot.profile
  const profile = await withDevModuleFiles(source, baseDir, language)
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

export interface FolderClaims {
  claim(path: string): Promise<void>
  claimCreated(path: string): void
  replace(path: string, outside?: string): Promise<void>
  release(): Promise<void>
  commit(): Promise<void>
}

interface Replacement {
  path: string
  backup: string
}

interface FolderClaim {
  path: string
  claim: DestinationClaim
  missingParents: readonly string[]
}

const missingParents = async (path: string): Promise<string[]> => {
  const parents: string[] = []
  for (let parent = dirname(path); parent !== dirname(parent) && (await isMissing(parent)); parent = dirname(parent))
    parents.push(parent)
  return parents
}

const isEmptyFolder = async (path: string): Promise<boolean> =>
  (await lstat(path)).isDirectory() && (await readdir(path)).length === 0

const removeEmptyFolder = async (path: string): Promise<boolean> => {
  try {
    await rmdir(path)
    return true
  } catch (error) {
    if (['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
    throw error
  }
}

const releaseClaim = async ({ path, claim, missingParents }: FolderClaim): Promise<void> => {
  await releaseDestination(path, claim)
  for (const parent of missingParents) if (!(await removeEmptyFolder(parent))) return
}

const restoreReplacement = async ({ path, backup }: Replacement): Promise<void> => {
  await rm(path, { recursive: true, force: true })
  await rename(backup, path)
}

const settle = async <Item>(
  items: Item[],
  action: (item: Item) => Promise<void>,
  failure: (item: Item, error: unknown) => string
): Promise<string[]> => {
  const failures: string[] = []
  for (const item of [...items].reverse()) {
    try {
      await action(item)
      items.splice(items.indexOf(item), 1)
    } catch (error) {
      failures.push(failure(item, error))
    }
  }
  return failures
}

const notDeleted = ({ path }: FolderClaim, error: unknown): string => `Could not delete ${path}: ${errorMessage(error)}`
const notRestored = ({ path, backup }: Replacement, error: unknown): string =>
  `Could not restore ${path}: ${errorMessage(error)}. The old folder is kept at ${backup}`
const backupKept = ({ backup }: Replacement, error: unknown): string =>
  `Could not delete the replaced workspace kept at ${backup}: ${errorMessage(error)}`

const restoreBeforeExit = (replacements: Replacement[]): void => {
  for (const replacement of replacements.splice(0).reverse()) {
    try {
      rmSync(replacement.path, { recursive: true, force: true })
      renameSync(replacement.backup, replacement.path)
    } catch (error) {
      process.stderr.write(`${notRestored(replacement, error)}\n`)
    }
  }
}

const backupPath = (path: string, parent: string): string => join(parent, `.${basename(path)}-${randomUUID()}.replaced`)

const setAside = async (path: string, outside: string | undefined): Promise<string> => {
  if (outside) {
    const backup = backupPath(path, outside)
    const moved = await rename(path, backup).then(
      () => true,
      () => false
    )
    if (moved) return backup
  }
  const backup = backupPath(path, dirname(path))
  await rename(path, backup)
  return backup
}

export const folderClaims = (): FolderClaims => {
  const claims: FolderClaim[] = []
  const replacements: Replacement[] = []
  const record = (claim: FolderClaim): void => {
    if (!claims.some((held) => containsPath(held.path, claim.path))) claims.push(claim)
  }
  const restoreOnExit = (): void => restoreBeforeExit(replacements)
  return {
    claim: async (path): Promise<void> => {
      if (await isMissing(path)) record({ path, claim: 'created', missingParents: await missingParents(path) })
      else if (await isEmptyFolder(path)) record({ path, claim: 'empty', missingParents: [] })
    },
    claimCreated: (path): void => record({ path, claim: 'created', missingParents: [] }),
    replace: async (path, outside): Promise<void> => {
      const backup = await setAside(path, outside)
      if (!replacements.length) process.once('exit', restoreOnExit)
      replacements.push({ path, backup })
    },
    release: async (): Promise<void> => {
      const failures = [
        ...(await settle(claims, releaseClaim, notDeleted)),
        ...(await settle(replacements, restoreReplacement, notRestored)),
      ]
      if (!replacements.length) process.removeListener('exit', restoreOnExit)
      if (failures.length) throw new Error(failures.join('; '))
    },
    commit: async (): Promise<void> => {
      process.removeListener('exit', restoreOnExit)
      claims.splice(0)
      const failures = await settle(
        replacements,
        ({ backup }) => rm(backup, { recursive: true, force: true }),
        backupKept
      )
      replacements.splice(0)
      if (failures.length) throw new Error(failures.join('; '))
    },
  }
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
  const root = projectFolder(resolve(options.cwd))
  const project = await installAgentProject({
    destination: root,
    deferDependencies: true,
    placement: 'project-root',
    ...input,
  })
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
