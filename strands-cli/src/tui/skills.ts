import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { HarnessAgentOptions } from '@strands-agents/harness'
import type { Agent, ToolResultContent } from '@strands-agents/sdk'
import { Skill, type AgentSkills } from '@strands-agents/sdk/vended-plugins/skills'

import { sanitizeTerminalText } from './terminal/sanitize.js'

export interface SkillInfo {
  name: string
  description: string
  instructions: string
  active: boolean
  path?: string
  allowedTools?: readonly string[]
  license?: string
  compatibility?: string
}

export interface ChatSkillsRuntime {
  readonly paths?: readonly string[]
  list(): Promise<readonly SkillInfo[]>
  activate(name: string): Promise<SkillInfo | undefined>
}

export class FileSkillsRuntime implements ChatSkillsRuntime {
  readonly paths: readonly string[]

  constructor(
    private readonly _paths: readonly string[],
    private readonly _getAgent: () => Agent
  ) {
    this.paths = _paths.map(sanitizeTerminalText)
  }

  async list(): Promise<readonly SkillInfo[]> {
    const active = activatedSkills(this._getAgent())
    return discoverSkills(this._paths).map((skill) => ({
      name: sanitizeTerminalText(skill.name),
      description: sanitizeTerminalText(skill.description),
      instructions: sanitizeTerminalText(skill.instructions),
      active: active.has(skill.name),
      ...(skill.path ? { path: sanitizeTerminalText(skill.path) } : {}),
      ...(skill.allowedTools ? { allowedTools: skill.allowedTools.map(sanitizeTerminalText) } : {}),
      ...(skill.license ? { license: sanitizeTerminalText(skill.license) } : {}),
      ...(skill.compatibility ? { compatibility: sanitizeTerminalText(skill.compatibility) } : {}),
    }))
  }

  async activate(name: string): Promise<SkillInfo | undefined> {
    const skill = (await this.list()).find((candidate) => candidate.name.toLowerCase() === name.toLowerCase())
    if (!skill) {
      return undefined
    }
    const result = await this._getAgent().tool.skills!.invoke(
      { skill_name: skill.name },
      { recordDirectToolCall: false }
    )
    if (result.status === 'error') {
      throw result.error ?? new Error(toolResultText(result.content) || `Failed to activate skill ${skill.name}.`)
    }
    return { ...skill, active: true }
  }
}

export function defaultSkillPaths(cwd = process.cwd(), home = homedir()): string[] {
  const userPaths = ['.agents', '.claude', '.codex', '.strands/cli'].map((directory) => join(home, directory, 'skills'))
  const projectPaths = workspaceAncestors(cwd).flatMap((directory) =>
    ['.agents', '.claude', '.codex', '.agent', '.strands'].map((name) => join(directory, name, 'skills'))
  )
  return [...new Set([...userPaths, ...projectPaths])]
}

/** The CLI's view of the `skills` option: paths and URLs (an `AgentSkills` instance is passed through). */
export type SkillPathsOption = Exclude<HarnessAgentOptions['skills'], AgentSkills>

function skillsDisabled(value: SkillPathsOption): boolean {
  return value === false || value === null || (Array.isArray(value) && value.length === 0)
}

/** Absolute paths or HTTPS URLs for configured skills; off or the default (`true`) yields none. */
export function configuredSkillPaths(value: SkillPathsOption, cwd = process.cwd()): string[] {
  if (value === undefined || value === true || skillsDisabled(value)) {
    return []
  }
  const sources = Array.isArray(value) ? value : [value as string | Skill]
  return sources.flatMap((source) =>
    typeof source === 'string' ? [source.startsWith('https://') ? source : resolve(cwd, source)] : []
  )
}

/**
 * Discovered conventional skill directories followed by the configured ones, so a configured skill
 * replaces a same-named discovered skill. A configured directory that is also a discovered location
 * keeps its place at the end, so no later discovered directory can override it. With discovery off
 * (the setting, or `STRANDS_CLI_SKILL_DISCOVERY=off`) only the configured directories load, falling back to
 * the library's `./.agent/skills` default; `skills: false` or an empty list turns skills off entirely.
 */
export function resolveSkillPaths(value: SkillPathsOption, cwd = process.cwd(), discovery = true): string[] {
  if (skillsDisabled(value)) {
    return []
  }
  const configured = [...new Set(configuredSkillPaths(value, cwd))]
  if (!discovery || process.env.STRANDS_CLI_SKILL_DISCOVERY === 'off') {
    return value === undefined || value === true ? [join(cwd, '.agent', 'skills')] : configured
  }
  const discovered = defaultSkillPaths(cwd).filter((path) => !configured.includes(path))
  return [...discovered, ...configured]
}

export function discoverSkills(paths: readonly string[]): Skill[] {
  const skills = new Map<string, Skill>()
  for (const path of paths) {
    let loaded: Skill[]
    try {
      const stat = statSync(path)
      if (stat.isFile() || existsSync(join(path, 'SKILL.md')) || existsSync(join(path, 'skill.md'))) {
        loaded = [Skill.fromFile(path)]
      } else if (stat.isDirectory()) {
        loaded = Skill.fromDirectory(path)
      } else {
        continue
      }
    } catch {
      continue
    }
    for (const skill of loaded) {
      skills.set(skill.name, skill)
    }
  }
  return [...skills.values()].sort((left, right) => left.name.localeCompare(right.name))
}

function workspaceAncestors(cwd: string): string[] {
  const ancestors: string[] = []
  let current = resolve(cwd)
  while (true) {
    ancestors.push(current)
    if (existsSync(join(current, '.git'))) {
      return ancestors.reverse()
    }
    const parent = dirname(current)
    if (parent === current) {
      return [resolve(cwd)]
    }
    current = parent
  }
}

function activatedSkills(agent: Agent): Set<string> {
  const state = agent.appState.get('agent_skills')
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return new Set()
  }
  const names = state.activatedSkills
  return new Set(Array.isArray(names) ? names.filter((name) => typeof name === 'string') : [])
}

function toolResultText(content: readonly ToolResultContent[]): string {
  return content
    .flatMap((block) => {
      if (block.type === 'textBlock') {
        return [block.text]
      }
      if (block.type === 'jsonBlock') {
        return [JSON.stringify(block.json)]
      }
      return []
    })
    .join('\n')
}
