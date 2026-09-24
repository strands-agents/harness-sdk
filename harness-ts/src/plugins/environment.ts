/**
 * EnvironmentContext: surface the working environment and project docs to the model.
 *
 * Before each user turn an internal `ContextInjector` re-surfaces a small block: the platform and
 * current date (the date is why this is injected rather than baked into the system prompt — a value
 * that changes each turn would bust the cached system-prompt prefix, whereas an ephemeral injection
 * lands after it and leaves the cache warm), the working directory, the contents of the project's
 * `AGENTS.md`, and links to other `AGENTS.md` / `README.md` files found a couple of levels down
 * (links, not contents, so the block stays small — the agent reads them on demand).
 *
 * Everything is read through the agent's `sandbox` seam (the same one the file tools use), so it
 * works against a local, Docker, or SSH sandbox. Discovery (the directory walk and cwd) is done once
 * and memoized per agent; only the date is recomputed each turn, so the per-turn cost is negligible.
 *
 * `AGENTS.md` contents are injected verbatim — a prompt-injection surface, but repo docs are treated
 * as trusted, the same files the agent's `read` tool already surfaces, so they aren't escaped.
 */

import { type LocalAgent, type Plugin, type Sandbox } from '@strands-agents/sdk'
import { ContextInjector } from '@strands-agents/sdk/vended-plugins/context-injector'

const DEFAULT_NAME = 'strands:environment'

// How many directory levels below the working directory to scan for nearby AGENTS.md / README.md.
const DISCOVERY_DEPTH = 2

// AGENTS.md is injected in full up to this size; longer files are truncated with a marker so a large
// doc can't dominate every turn's context (the agent can still `read` the whole file).
export const AGENTS_MD_CAP = 16_000

// Directories skipped during discovery: dependency/build/VCS trees that hold no project AGENTS.md and
// would make the walk slow and the link list noisy. Hidden directories (`.` prefix) are skipped too.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'target', '__pycache__', 'venv', 'site-packages', 'vendor'])

// Filenames collected during discovery and surfaced as nearby links.
const DISCOVERED_FILES = ['AGENTS.md', 'README.md']

interface Gathered {
  platform: string | undefined
  cwd: string | undefined
  agentsMd: string | undefined
  otherAgents: string[]
  readmes: string[]
}

/** Per-agent memo: the one-time discovery is cached here so only the date recomputes each turn. */
export interface EnvironmentMemo {
  gathered?: Gathered
}

/** Configuration for the {@link EnvironmentContext} plugin. */
export interface EnvironmentContextConfig {
  /** Plugin name, for logging and duplicate detection. Defaults to `'strands:environment'`. */
  name?: string
}

/**
 * Injects working-environment and project-doc context before each user turn.
 *
 * Reads through the agent's `sandbox`, so it honors whatever sandbox the agent runs against. Sharing
 * one instance across agents is safe: the captured agent and memoized discovery are scoped per
 * `initAgent` call, not stored on the plugin.
 */
export class EnvironmentContext implements Plugin {
  readonly name: string

  constructor(config: EnvironmentContextConfig = {}) {
    this.name = config.name ?? DEFAULT_NAME
  }

  initAgent(agent: LocalAgent): void {
    const memo: EnvironmentMemo = {}
    new ContextInjector({
      name: `${this.name}:injector`,
      trigger: 'userTurn',
      renderContent: async (): Promise<string> => renderEnvironment(agent, memo),
    }).initAgent(agent)
  }
}

/** Render the injected block, gathering (and memoizing) the static parts on first call. */
export async function renderEnvironment(agent: LocalAgent, memo: EnvironmentMemo): Promise<string> {
  memo.gathered ??= await gather(agent)
  return render(memo.gathered)
}

function todayIso(): string {
  // Local calendar date (matches Python's ``date.today()``), not UTC — otherwise an evening turn at
  // a negative offset would report tomorrow.
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function render(g: Gathered): string {
  const env: string[] = []
  if (g.platform) {
    env.push(`Platform: ${g.platform}`)
  }
  env.push(`Date: ${todayIso()}`)
  if (g.cwd) {
    env.push(`Working directory: ${g.cwd}`)
  }
  const sections = [`<environment>\n${env.join('\n')}\n</environment>`]
  if (g.agentsMd) {
    sections.push(`<AGENTS.md>\n${g.agentsMd}\n</AGENTS.md>`)
  }
  if (g.otherAgents.length > 0) {
    sections.push('Other AGENTS.md files nearby (read as needed): ' + g.otherAgents.join(', '))
  }
  if (g.readmes.length > 0) {
    sections.push('README files nearby (read as needed): ' + g.readmes.join(', '))
  }
  return `<system-reminder>\n${sections.join('\n\n')}\n</system-reminder>`
}

async function gather(agent: LocalAgent): Promise<Gathered> {
  let sandbox: Sandbox
  try {
    sandbox = agent.sandbox
  } catch {
    // Defensive: normally a default local sandbox is present, but if the getter has none to fall
    // back to (e.g. a browser build), still surface the date block without probing the environment.
    return { platform: undefined, cwd: undefined, agentsMd: undefined, otherAgents: [], readmes: [] }
  }
  // Platform and cwd are read from the sandbox (via `uname`/`pwd`), not the host process, so they
  // describe where the agent actually runs — a Docker or SSH sandbox, not the machine hosting it.
  const platform = await probe(sandbox, 'uname -s')
  const cwd = await probe(sandbox, 'pwd')
  const agentsMd = await readText(sandbox, 'AGENTS.md')
  const found = await discover(sandbox)
  // The working-directory AGENTS.md is shown in full above; keep only the nested ones as links.
  const otherAgents = (found.get('AGENTS.md') ?? []).filter((p) => p !== 'AGENTS.md')
  return { platform, cwd, agentsMd, otherAgents, readmes: found.get('README.md') ?? [] }
}

async function probe(sandbox: Sandbox, command: string): Promise<string | undefined> {
  try {
    const result = await sandbox.execute(command)
    const out = result.stdout.trim()
    if (result.exitCode === 0 && out) {
      return out.split(/\r?\n/)[0]
    }
  } catch {
    // best-effort — a backend without the probe command just omits the line
  }
  return undefined
}

async function readText(sandbox: Sandbox, path: string): Promise<string | undefined> {
  let text: string
  try {
    text = await sandbox.readText(path)
  } catch {
    return undefined
  }
  if (text.length > AGENTS_MD_CAP) {
    return text.slice(0, AGENTS_MD_CAP) + '\n… (truncated — read the full file if you need the rest)'
  }
  return text
}

async function discover(sandbox: Sandbox): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>(DISCOVERED_FILES.map((name) => [name, []]))

  async function visit(rel: string, depth: number): Promise<void> {
    let entries
    try {
      entries = await sandbox.listFiles(rel || '.')
    } catch {
      return
    }
    for (const entry of entries) {
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDir) {
        if (depth < DISCOVERY_DEPTH && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          await visit(path, depth + 1)
        }
      } else {
        found.get(entry.name)?.push(path)
      }
    }
  }

  await visit('', 0)
  return found
}
