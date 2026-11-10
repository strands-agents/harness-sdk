import { lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

import { resolveSkillPaths } from '../agent/skills.js'
import type { CliConfigSnapshot } from '../config/store.js'
import { importAgentProject } from '../project/import.js'
import { installAgentProject } from '../project/install.js'
import { withDevModuleFiles } from './module-files.js'
import { bindWorkspace } from './binding.js'
import { boundDevWorkspace, readDevWorkspace, type DevWorkspace } from './workspace.js'

export interface CreateDevWorkspaceOptions {
  destination: string
  kind: 'cli' | 'typescript' | 'python'
  snapshot: CliConfigSnapshot
  cwd: string
  signal?: AbortSignal
  deferDependencies?: boolean
}

type DestinationClaim = 'created' | 'empty'

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
          entrypoint: relative(project.root, project.entrypoint).split(sep).join('/'),
          language: project.language,
        },
        origin,
      })
    } else {
      const language = options.kind === 'python' ? 'python' : 'typescript'
      const baseDir = options.snapshot.profileBaseDir ?? options.cwd
      const profile = await withDevModuleFiles(options.snapshot.profile, baseDir, language)
      const skills = resolveSkillPaths(
        typeof profile.skills === 'object' ? [...profile.skills] : profile.skills,
        baseDir,
        options.snapshot.settings.skillDiscovery
      )
      const project = await installAgentProject({
        destination: join(destination, 'agent'),
        ...(options.deferDependencies ? { deferDependencies: true } : {}),
        profile,
        language,
        skills,
        baseDir,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      await bindWorkspace(destination, {
        version: 1,
        name: options.snapshot.profile.name,
        agent: { path: 'agent', entrypoint: relative(project.root, project.entrypoint).split(sep).join('/'), language },
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
        entrypoint: relative(project.root, project.entrypoint).split(sep).join('/'),
        language: project.language,
      },
      origin: { kind: 'discovered', source: project.entrypoint },
      ...(legacy?.config.harness ? { harness: legacy.config.harness } : {}),
    })
  )
}
