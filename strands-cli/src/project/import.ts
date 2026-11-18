import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { containsPath, expandHome } from '../paths.js'
import {
  AGENT_ENTRYPOINT_FILE,
  AGENT_ENTRYPOINTS,
  extractAgentArchive,
  regularFile,
  resolveProjectEntrypoint,
  SOURCE_EXTENSION,
} from './archive.js'

export type AgentProjectLanguage = 'typescript' | 'python'

export interface ImportedAgentProject {
  root: string
  entrypoint: string
  language: AgentProjectLanguage
}

export function agentLaunchCommand(path: string, platform = process.platform): string {
  if (platform === 'win32') {
    return `strands --agent '${path.replaceAll("'", "''")}'`
  }
  return `strands --agent '${path.replaceAll("'", "'\\''")}'`
}

export function importAgentProject(path: string): ImportedAgentProject {
  const expanded = expandHome(path)
  const root = projectRoot(expanded)
  const candidate = regularFile(expanded) && SOURCE_EXTENSION.test(expanded) ? realpathSync(expanded) : undefined
  const entries = AGENT_ENTRYPOINTS.map((name) => join(root, name)).filter(regularFile)
  let entrypoint = candidate
  if (!entrypoint && regularFile(join(root, AGENT_ENTRYPOINT_FILE))) {
    const selected = readFileSync(join(root, AGENT_ENTRYPOINT_FILE), 'utf8').trim()
    entrypoint = resolveProjectEntrypoint(root, selected)
    if (!entrypoint) {
      throw new Error(`Invalid ${AGENT_ENTRYPOINT_FILE}: select an existing supported source file inside the project.`)
    }
  }
  entrypoint ??= entries.length === 1 ? entries[0] : undefined
  if (!entrypoint) {
    throw new Error(
      entries.length === 0
        ? 'No default agent source found. Choose a .ts, .mts, .js, .mjs, or .py file to load, or set .strands-entrypoint.'
        : 'This folder contains multiple agents. Choose the source file to load, or set .strands-entrypoint.'
    )
  }
  if (!containsPath(root, realpathSync(entrypoint))) {
    throw new Error('The agent source file must be inside the project.')
  }
  return { root, entrypoint, language: entrypoint.endsWith('.py') ? 'python' : 'typescript' }
}

function projectRoot(path: string): string {
  const candidate = resolve(path)
  const details = lstatSync(candidate)
  if (details.isSymbolicLink()) {
    throw new Error('Choose a real harness project folder or project file.')
  }
  if (details.isDirectory()) {
    return realpathSync(candidate)
  }
  if (details.isFile() && candidate.toLowerCase().endsWith('.zip')) {
    return realpathSync(extractAgentArchive(candidate))
  }
  if (!details.isFile() || !SOURCE_EXTENSION.test(candidate)) {
    throw new Error('Choose a project folder, ZIP, or .ts, .mts, .js, .mjs, or .py source file.')
  }
  const source = realpathSync(candidate)
  const directory = dirname(source)
  const fallback =
    basename(directory) === 'agent' && AGENT_ENTRYPOINTS.includes(`agent/${basename(source)}`)
      ? dirname(directory)
      : directory
  const boundaries = [homedir(), tmpdir()].filter(existsSync).map((path) => realpathSync(path))
  const workingDirectory = realpathSync(process.cwd())
  for (let current = directory; dirname(current) !== current; current = dirname(current)) {
    if (current !== directory && boundaries.includes(current)) break
    if (regularFile(join(current, AGENT_ENTRYPOINT_FILE))) return current
    const manifest = join(current, 'package.json')
    if (current !== directory && regularFile(manifest)) {
      const document = JSON.parse(readFileSync(manifest, 'utf8').replace(/^\uFEFF/u, '')) as { workspaces?: unknown }
      // An ancestor workspace manifest does not make a loose example its own package.
      if (document.workspaces) break
    }
    if (['package.json', 'pyproject.toml', 'requirements.txt'].some((name) => regularFile(join(current, name)))) {
      return current
    }
    if (current === workingDirectory || boundaries.includes(current) || existsSync(join(current, '.git'))) break
  }
  return fallback
}

const IMPORT_FILE_PATTERN = /\.(?:zip|ts|mts|js|mjs|py)$/iu

export interface ImportPathCompletion {
  value: string
  label: string
  directory: boolean
}

export function importPathCompletions(
  input: string,
  workingDirectory = process.cwd(),
  homeDirectory = homedir()
): ImportPathCompletion[] {
  if (!input) {
    return []
  }
  if (input === '~') {
    return [{ value: `~${sep}`, label: `~${sep}`, directory: true }]
  }

  const separatorIndex = input.lastIndexOf(sep)
  const prefix = separatorIndex < 0 ? '' : input.slice(0, separatorIndex + 1)
  const fragment = separatorIndex < 0 ? input : input.slice(separatorIndex + 1)
  const expandedPrefix =
    prefix === `~${sep}`
      ? `${homeDirectory}${sep}`
      : prefix.startsWith(`~${sep}`)
        ? join(homeDirectory, prefix.slice(2))
        : prefix
  const directory = isAbsolute(expandedPrefix) ? expandedPrefix : resolve(workingDirectory, expandedPrefix || '.')

  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => {
        if (!entry.name.toLocaleLowerCase().startsWith(fragment.toLocaleLowerCase())) {
          return false
        }
        if (!fragment.startsWith('.') && entry.name.startsWith('.')) {
          return false
        }
        return entry.isDirectory() || (entry.isFile() && IMPORT_FILE_PATTERN.test(entry.name))
      })
      .sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) {
          return left.isDirectory() ? -1 : 1
        }
        return left.name.localeCompare(right.name)
      })
      .map((entry) => {
        const suffix = entry.isDirectory() ? sep : ''
        return {
          value: `${prefix}${entry.name}${suffix}`,
          label: `${entry.name}${suffix}`,
          directory: entry.isDirectory(),
        }
      })
      .filter((completion) => completion.value !== input)
      .slice(0, 6)
  } catch {
    return []
  }
}
