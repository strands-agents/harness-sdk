import type { HarnessAgentOptions } from '@strands-agents/harness'
import type { Agent, ToolResultContent } from '@strands-agents/sdk'
import type { AgentSkills, SkillSource } from '@strands-agents/sdk/vended-plugins/skills'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { strandsUserPath } from '../paths.js'
import { sanitizeTerminalText } from '../terminal/text.js'

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

export interface SkillActivation {
  skill: SkillInfo
  content: string
}

export interface ChatSkillsRuntime {
  list(): Promise<readonly SkillInfo[]>
  activate(name: string): Promise<SkillActivation | undefined>
}

export class AgentSkillsRuntime implements ChatSkillsRuntime {
  constructor(
    private readonly _getAgent: () => Agent,
    private readonly _getSkills: (agent: Agent) => AgentSkills | undefined
  ) {}

  list(): Promise<readonly SkillInfo[]> {
    return this._list(this._getAgent())
  }

  private async _list(agent: Agent): Promise<readonly SkillInfo[]> {
    const plugin = this._getSkills(agent)
    if (!plugin) return []
    const active = new Set(plugin.getActivatedSkills(agent))
    return [...(await plugin.getAvailableSkills(agent))]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((skill) => ({
        name: skill.name,
        description: sanitizeTerminalText(skill.description),
        instructions: sanitizeTerminalText(skill.instructions),
        active: active.has(skill.name),
        ...(skill.path ? { path: sanitizeTerminalText(skill.path) } : {}),
        ...(skill.allowedTools ? { allowedTools: skill.allowedTools.map(sanitizeTerminalText) } : {}),
        ...(skill.license ? { license: sanitizeTerminalText(skill.license) } : {}),
        ...(skill.compatibility ? { compatibility: sanitizeTerminalText(skill.compatibility) } : {}),
      }))
  }

  async activate(name: string): Promise<SkillActivation | undefined> {
    const agent = this._getAgent()
    const skills = await this._list(agent)
    const skill =
      skills.find((candidate) => candidate.name === name) ??
      skills.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase())
    if (!skill) {
      return undefined
    }
    const result = await agent.tool.skills!.invoke({ skill_name: skill.name }, { recordDirectToolCall: false })
    if (result.status === 'error' || !this._getSkills(agent)?.getActivatedSkills(agent).includes(skill.name)) {
      throw result.error ?? new Error(toolResultText(result.content) || `Failed to activate skill ${skill.name}.`)
    }
    return {
      skill: { ...skill, active: true },
      content: toolResultText(result.content) || skill.instructions,
    }
  }
}

export function defaultSkillPaths(cwd = process.cwd(), home = homedir()): string[] {
  const userPaths = [
    ...['.agents', '.claude', '.codex'].map((directory) => join(home, directory, 'skills')),
    process.env.STRANDS_CLI_HOME ? strandsUserPath('skills') : join(home, '.strands', 'skills'),
  ]
  const projectPaths = workspaceAncestors(cwd).flatMap((directory) =>
    ['.agents', '.claude', '.codex', '.agent', '.strands'].map((name) => join(directory, name, 'skills'))
  )
  return [...new Set([...userPaths, ...projectPaths])]
}

/** Sources for the default skills plugin; a configured plugin is handled directly by the runtime. */
export type SkillPathsOption = Exclude<HarnessAgentOptions['skills'], AgentSkills>

function skillsDisabled(value: SkillPathsOption): boolean {
  return value === false || value === null || (Array.isArray(value) && value.length === 0)
}

/** Resolve local sources while preserving SDK Skill instances and HTTPS URLs. */
export function configuredSkillSources(value: SkillPathsOption, cwd = process.cwd()): SkillSource[] {
  if (value == null || typeof value === 'boolean') {
    return []
  }
  const sources = Array.isArray(value) ? value : [value]
  return sources.map((source) =>
    typeof source === 'string' && !source.startsWith('https://') ? resolve(cwd, source) : source
  )
}

/**
 * Discovered conventional skill directories followed by the configured ones, so a configured skill
 * replaces a same-named discovered skill. A configured directory that is also a discovered location
 * keeps its place at the end, so no later discovered directory can override it. With discovery off
 * (the setting, or `STRANDS_CLI_SKILL_DISCOVERY=off`) only the configured directories load, falling back to
 * the library's `./.agent/skills` default; `skills: false` or an empty list turns skills off entirely.
 */
export function resolveSkillSources(value: SkillPathsOption, cwd = process.cwd(), discovery = true): SkillSource[] {
  if (skillsDisabled(value)) {
    return []
  }
  const configured = [...new Set(configuredSkillSources(value, cwd))]
  if (!discovery || process.env.STRANDS_CLI_SKILL_DISCOVERY === 'off') {
    return value === undefined || value === true ? [join(cwd, '.agent', 'skills')] : configured
  }
  const discovered = defaultSkillPaths(cwd).filter((path) => !configured.includes(path))
  return [...discovered, ...configured]
}

export function resolveSkillPaths(value: SkillPathsOption, cwd = process.cwd(), discovery = true): string[] {
  return resolveSkillSources(value, cwd, discovery).filter((source): source is string => typeof source === 'string')
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
