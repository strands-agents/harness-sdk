import { lstat, mkdir, rm } from 'node:fs/promises'
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
}

const ensureNewDestination = async (path: string): Promise<void> => {
  try {
    await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  throw new Error(
    `The destination already exists: ${path}. Choose a new workspace path or open the existing workspace.`
  )
}

export const createDevWorkspace = async (options: CreateDevWorkspaceOptions): Promise<DevWorkspace> => {
  options.signal?.throwIfAborted()
  const destination = resolve(options.cwd, options.destination)
  const existing = await readDevWorkspace(destination)
  if (existing) return existing
  await ensureNewDestination(destination)
  await mkdir(dirname(destination), { recursive: true })
  await mkdir(destination, { mode: 0o700 })
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
    await rm(destination, { recursive: true, force: true })
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
