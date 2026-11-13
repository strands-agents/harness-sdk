import type { HarnessAgentConfig } from '@strands-agents/harness'
import { prepareWorkspaceDependencies } from './archive.js'
import { devFailure } from '../dev/errors.js'
import { exportSourceProject, writeAgentProject, writeRootAgentProject } from './export.js'
import { importAgentProject, type AgentProjectLanguage, type ImportedAgentProject } from './import.js'
import type { AgentEntrypointPlacement } from './source.js'

export type ProjectInstallation = {
  destination: string
  signal?: AbortSignal
  deferDependencies?: boolean
  prepare?: (project: ImportedAgentProject) => Promise<void>
} & (
  | { source: ImportedAgentProject; name: string; privatePaths: readonly string[] }
  | {
      profile: HarnessAgentConfig
      language: AgentProjectLanguage
      skills: readonly string[]
      baseDir: string
      placement?: AgentEntrypointPlacement
    }
)

export const installProjectDependencies = async (project: ImportedAgentProject): Promise<void> => {
  try {
    await prepareWorkspaceDependencies(project.root, project.language)
  } catch (error) {
    throw devFailure(error, { operation: 'install', path: project.root })
  }
}

export const installAgentProject = async (options: ProjectInstallation): Promise<ImportedAgentProject> => {
  options.signal?.throwIfAborted()
  if ('source' in options) {
    await exportSourceProject(
      options.source,
      options.name,
      options.source.language,
      options.privatePaths,
      options.destination,
      'directory'
    )
  } else if (options.placement === 'project-root') {
    await writeRootAgentProject(options.profile, options.language, options.skills, options.destination, options.baseDir)
  } else {
    await writeAgentProject(
      options.profile,
      options.language,
      options.skills,
      options.destination,
      options.baseDir,
      false,
      'directory'
    )
  }
  options.signal?.throwIfAborted()
  const project = importAgentProject(options.destination)
  if (options.prepare) await options.prepare(project)
  else if (!options.deferDependencies) await installProjectDependencies(project)
  options.signal?.throwIfAborted()
  return project
}
