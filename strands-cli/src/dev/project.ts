import { readdirSync, realpathSync } from 'node:fs'
import { join, relative } from 'node:path'

import { AGENT_ENTRYPOINT_FILE, AGENT_ENTRYPOINTS, regularFile } from '../tui/project/archive.js'
import { importAgentProject, type ImportedAgentProject } from '../tui/project/import.js'
import { containsPath } from '../tui/project/packaging.js'

const AGENT_FILES = ['agent.ts', 'agent.mts', 'agent.js', 'agent.mjs', 'agent.py'] as const
const IGNORED_DIRECTORIES = new Set(['node_modules', 'venv', '__pycache__', 'dist', 'build'])

/** Dependency, build, and hidden folders. Dev mode never searches or watches them. */
export function isIgnoredDirectory(name: string): boolean {
  return name.startsWith('.') || IGNORED_DIRECTORIES.has(name)
}

/** Find the source agent that `strands dev` runs. It never falls back to the saved default agent. */
export function resolveDevProject(cwd: string, agentPath?: string): ImportedAgentProject {
  if (agentPath !== undefined) {
    if (/\.zip$/iu.test(agentPath)) {
      throw new Error('strands dev cannot load a ZIP archive. Use the project folder or its agent source file.')
    }
    return importAgentProject(agentPath)
  }
  const root = realpathSync(cwd)
  return hasRootEntrypoint(root) ? importAgentProject(root) : nestedProject(root)
}

function hasRootEntrypoint(root: string): boolean {
  return [...AGENT_ENTRYPOINTS, AGENT_ENTRYPOINT_FILE].some((name) => regularFile(join(root, name)))
}

// The launch folder stays the root so that package imports such as `from refund_desk.tools import x` resolve.
function nestedProject(root: string): ImportedAgentProject {
  const matches = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !isIgnoredDirectory(entry.name))
    .flatMap((entry) => AGENT_FILES.map((name) => join(root, entry.name, name)))
    .filter(regularFile)
    .sort()
  const [match, ...others] = matches
  if (!match) {
    throw new Error(`No agent found in ${root}. Add agent.py or agent.ts, or use --agent <path>.`)
  }
  if (others.length > 0) {
    const names = matches.map((path) => relative(root, path)).join(', ')
    throw new Error(`More than one agent found in ${root}: ${names}. Use --agent <path> to select one.`)
  }
  const entrypoint = realpathSync(match)
  if (!containsPath(root, entrypoint)) {
    throw new Error('The agent source file must be inside the project.')
  }
  return { root, entrypoint, language: entrypoint.endsWith('.py') ? 'python' : 'typescript' }
}
