import { readFileSync } from 'node:fs'

import type { HarnessAgentConfig } from '@strands-agents/harness'

import type {
  ChatConfigurationDiffs,
  ChatConfigurationDocument,
  ChatConfigurationLanguage,
  ChatConfigurationSource,
} from './chat/types.js'
import { createDiffPreview } from './permissions/file-change-preview.js'
import type { ImportedAgentProject } from './project/import.js'
import { prepareAgentProject } from './project/export.js'
import { agentProjectSource } from './project/source.js'
import { resolveSkillPaths } from './skills.js'
import { errorMessage, sanitizeTerminalText } from './terminal/sanitize.js'

const CONFIGURATION_LANGUAGES = ['typescript', 'python'] as const

export function configurationDiffs(
  previous: ChatConfigurationSource,
  current: ChatConfigurationSource
): ChatConfigurationDiffs | undefined {
  const diffs: ChatConfigurationDiffs = {}
  for (const language of CONFIGURATION_LANGUAGES) {
    const before = previous.documents[language]
    const after = current.documents[language]
    if (before.source !== after.source) {
      diffs[language] = createDiffPreview(
        after.path ?? before.path ?? language,
        before.source,
        after.source,
        Number.POSITIVE_INFINITY
      )
    }
  }
  return Object.keys(diffs).length > 0 ? diffs : undefined
}

export function sanitizeConfigurationSource(configuration: ChatConfigurationSource): ChatConfigurationSource {
  const document = (language: ChatConfigurationLanguage): ChatConfigurationDocument => {
    const source = configuration.documents[language]
    return {
      source: sanitizeTerminalText(source.source),
      generated: source.generated,
      ...(source.path ? { path: sanitizeTerminalText(source.path) } : {}),
      ...(source.error ? { error: sanitizeTerminalText(source.error) } : {}),
    }
  }
  return {
    preferredLanguage: configuration.preferredLanguage,
    documents: {
      typescript: document('typescript'),
      python: document('python'),
    },
    ...(configuration.project
      ? {
          project: {
            root: sanitizeTerminalText(configuration.project.root),
            entrypoint: sanitizeTerminalText(configuration.project.entrypoint),
          },
        }
      : {}),
  }
}

export function configurationSource(
  profile: HarnessAgentConfig,
  project?: ImportedAgentProject,
  baseDir = process.cwd()
): ChatConfigurationSource {
  const documents = Object.fromEntries(
    CONFIGURATION_LANGUAGES.map((language) => [language, configurationDocument(profile, language, project, baseDir)])
  ) as Record<ChatConfigurationLanguage, ChatConfigurationDocument>
  return {
    preferredLanguage: project?.language ?? 'typescript',
    documents,
    ...(project ? { project: { root: project.root, entrypoint: project.entrypoint } } : {}),
  }
}

function configurationDocument(
  profile: HarnessAgentConfig,
  language: ChatConfigurationLanguage,
  project: ImportedAgentProject | undefined,
  baseDir: string
): ChatConfigurationDocument {
  if (project) {
    if (project.language !== language) {
      return {
        source: '',
        generated: false,
        error: `This agent is authored in ${project.language}; export it in the same language to preserve its code.`,
      }
    }
    try {
      return {
        source: readFileSync(project.entrypoint, 'utf8'),
        generated: false,
        path: project.entrypoint,
      }
    } catch (error) {
      return {
        source: '',
        generated: false,
        path: project.entrypoint,
        error: `Could not read ${project.entrypoint}: ${errorMessage(error)}`,
      }
    }
  }
  try {
    const skillPaths = resolveSkillPaths(
      typeof profile.skills === 'object' ? [...profile.skills] : profile.skills,
      baseDir,
      false
    )
    const { config } = prepareAgentProject(profile, language, skillPaths, baseDir)
    return {
      source: agentProjectSource(config, language),
      generated: true,
    }
  } catch (error) {
    return {
      source: language === 'python' ? '# Configuration unavailable' : '// Configuration unavailable',
      generated: true,
      error: errorMessage(error),
    }
  }
}
