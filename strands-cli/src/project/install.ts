import type { HarnessAgentConfig } from '@strands-agents/harness'
import { prepareWorkspaceDependencies } from './archive.js'
import { devFailure } from '../dev/errors.js'
import { exportSourceProject, writeAgentProject } from './export.js'
import { importAgentProject, type AgentProjectLanguage, type ImportedAgentProject } from './import.js'

export type ProjectInstallation = {
  destination: string
  signal?: AbortSignal
} & (
  | { source: ImportedAgentProject; name: string; privatePaths: readonly string[] }
  | { profile: HarnessAgentConfig; language: AgentProjectLanguage; skills: readonly string[]; baseDir: string }
)

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
  try {
    await prepareWorkspaceDependencies(project.root, project.language)
  } catch (error) {
    throw devFailure(error, { operation: 'install', path: project.root })
  }
  options.signal?.throwIfAborted()
  return project
}
