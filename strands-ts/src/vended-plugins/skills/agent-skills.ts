/**
 * AgentSkills plugin for integrating Agent Skills into Strands agents.
 *
 * This module provides the AgentSkills class that implements the Plugin
 * interface to add Agent Skills support. The plugin registers a tool for
 * activating skills and injects skill metadata into the system prompt.
 */

import { z } from 'zod'
import { tool } from '../../tools/tool-factory.js'
import { BeforeInvocationEvent } from '../../hooks/events.js'
import { TextBlock, type SystemContentBlock } from '../../types/messages.js'
import { logger } from '../../logging/logger.js'
import { Skill } from './skill.js'
import type { Plugin } from '../../plugins/plugin.js'
import type { LocalAgent } from '../../types/agent.js'
import type { Sandbox } from '../../sandbox/base.js'
import type { FileInfo } from '../../sandbox/types.js'
import type { Tool, ToolContext } from '../../tools/tool.js'

/** A single skill source: filesystem path string, HTTPS URL string, or Skill instance. */
export type SkillSource = string | Skill

/** Configuration for the AgentSkills plugin. */
export interface AgentSkillsConfig {
  /**
   * One or more skill sources. Each element can be:
   * - A `Skill` instance
   * - A path to a skill directory (containing SKILL.md)
   * - A path to a parent directory (containing skill subdirectories)
   * - An `https://` URL pointing directly to raw SKILL.md content
   */
  skills: SkillSource[]

  /** Maximum number of resource files to list in skill responses. Defaults to 20. */
  maxResourceFiles?: number | undefined

  /** If true, throw on skill validation issues. If false (default), warn and load anyway. */
  strict?: boolean | undefined

  /** Custom key for storing plugin state in `agent.appState`. Defaults to `'agent_skills'`. */
  stateKey?: string | undefined
}

const DEFAULT_STATE_KEY = 'agent_skills'
const RESOURCE_DIRS = ['scripts', 'references', 'assets']
const DEFAULT_MAX_RESOURCE_FILES = 20

/**
 * Escape XML special characters in text content.
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Find the SKILL.md filename among directory entries, preferring `SKILL.md` over `skill.md`
 * (matching `Skill.fromFile`'s precedence). Returns `undefined` if neither is present.
 */
function findSkillMdName(entries: FileInfo[]): string | undefined {
  for (const name of ['SKILL.md', 'skill.md']) {
    if (entries.some((e) => !e.isDir && e.name === name)) return name
  }
  return undefined
}

/**
 * Plugin that integrates Agent Skills into a Strands agent.
 *
 * Provides:
 * 1. A `skills` tool that allows the agent to activate skills on demand
 * 2. System prompt injection of available skill metadata before each invocation
 * 3. Session persistence of activated skill state via `agent.appState`
 *
 * Skills can be provided as filesystem paths (to individual skill directories or
 * parent directories containing multiple skills), HTTPS URLs pointing to raw
 * SKILL.md content, or as pre-built `Skill` instances.
 *
 * @example
 * ```typescript
 * import { Agent } from '@strands-agents/sdk'
 * import { Skill, AgentSkills } from '@strands-agents/sdk/vended-plugins/skills'
 *
 * // Load from filesystem
 * const plugin = new AgentSkills({
 *   skills: ['./skills/pdf-processing', './skills/'],
 * })
 *
 * // Or provide Skill instances directly
 * const skill = new Skill({ name: 'my-skill', description: 'A custom skill', instructions: 'Do the thing' })
 * const plugin = new AgentSkills({ skills: [skill] })
 *
 * const agent = new Agent({ model, plugins: [plugin] })
 * ```
 */
export class AgentSkills implements Plugin {
  readonly name = 'strands:agent-skills'

  private _skills: Map<string, Skill>
  /**
   * Filesystem path sources. Loaded at initAgent (not construction) so they read from
   * the agent's sandbox — host or container — exactly once, from the correct filesystem.
   */
  private _skillPaths: string[]
  private readonly _maxResourceFiles: number
  /** When true, skill validation errors throw instead of logging warnings. */
  private readonly _strict: boolean
  private readonly _stateKey: string
  /** Resolves when all async skill sources (URLs) have been loaded. */
  private _ready: Promise<void>
  private _agentSkills = new WeakMap<LocalAgent, Map<string, Skill>>()

  constructor(config: AgentSkillsConfig) {
    this._strict = config.strict ?? false
    this._maxResourceFiles = config.maxResourceFiles ?? DEFAULT_MAX_RESOURCE_FILES
    this._stateKey = config.stateKey ?? DEFAULT_STATE_KEY
    // Resolve sandbox-independent sources (Skill instances, URLs) now. Path sources are
    // collected and deferred to initAgent, where the agent's sandbox is available.
    const { skills, ready, skillPaths } = this._resolveSkills(config.skills)
    this._skills = skills
    this._ready = ready
    this._skillPaths = skillPaths
  }

  /**
   * Initialize the plugin with the agent instance.
   *
   * Waits for any async skill sources (e.g. URLs) to finish loading, then
   * registers a BeforeInvocationEvent hook that injects skill metadata
   * into the system prompt before each invocation.
   */
  async initAgent(agent: LocalAgent): Promise<void> {
    await this._ready
    await this._loadSkillPaths(agent)

    const agentSkills = this._agentSkills.get(agent)!
    if (agentSkills.size === 0) {
      logger.warn('no skills were loaded, the agent will have no skills available')
    }
    logger.debug(`skill_count=<${agentSkills.size}> | skills plugin initialized`)

    agent.addHook(BeforeInvocationEvent, async (event) => {
      await this._ready
      if (!this._agentSkills.has(event.agent)) {
        await this._loadSkillPaths(event.agent)
      }
      this._injectSkillsXml(event.agent)
    })
  }

  /**
   * Returns the skills activation tool for auto-registration with the agent.
   */
  getTools(): Tool[] {
    return [this._createSkillsTool()]
  }

  /**
   * Get the list of available skills. When called with an agent, returns that agent's
   * full skill set (base + path-loaded from its sandbox). Without an agent, returns
   * the base skills only (Skill instances and URLs).
   */
  async getAvailableSkills(agent?: LocalAgent): Promise<readonly Skill[]> {
    await this._ready
    const skills = agent ? (this._agentSkills.get(agent) ?? this._skills) : this._skills
    return [...skills.values()]
  }

  /**
   * Replace all available skills.
   *
   * Each element can be a `Skill` instance, a path to a skill directory
   * (containing SKILL.md), a path to a parent directory containing skill
   * subdirectories, or an `https://` URL pointing directly to raw SKILL.md
   * content.
   *
   * Note: this does not persist state or deactivate skills on any agent.
   * Active skill state is managed per-agent and will be reconciled on the
   * next tool call or invocation.
   */
  setAvailableSkills(skills: SkillSource[]): void {
    const { skills: resolved, ready, skillPaths } = this._resolveSkills(skills)
    this._skills = resolved
    this._skillPaths = skillPaths
    this._ready = ready
    this._agentSkills = new WeakMap()
  }

  /**
   * Get the list of skills activated by the given agent.
   * Returns skill names in activation order (most recent last).
   */
  getActivatedSkills(agent: LocalAgent): readonly string[] {
    return (this._getStateField(agent, 'activatedSkills') as string[] | undefined) ?? []
  }

  /**
   * Resolve a list of skill sources into Skill instances.
   *
   * Each source can be a Skill instance, a path to a skill directory,
   * a path to a parent directory containing multiple skills, or an
   * HTTPS URL pointing to a SKILL.md file.
   *
   * Skill instances are resolved immediately into the returned map. Async sources
   * (URLs) are resolved in the background; the returned `ready` promise resolves when
   * all URL fetches have completed. Filesystem paths are returned in `skillPaths` to be
   * loaded at initAgent, where they read from the agent's sandbox.
   */
  private _resolveSkills(sources: SkillSource[]): {
    skills: Map<string, Skill>
    ready: Promise<void>
    skillPaths: string[]
  } {
    const resolved = new Map<string, Skill>()
    const skillPaths: string[] = []
    const asyncTasks: Promise<void>[] = []

    for (const source of sources) {
      if (source instanceof Skill) {
        if (resolved.has(source.name)) {
          logger.warn(`name=<${source.name}> | duplicate skill name, overwriting previous skill`)
        }
        resolved.set(source.name, source)
      } else if (source.startsWith('https://')) {
        asyncTasks.push(
          Skill.fromUrl(source, { strict: this._strict }).then(
            (skill) => {
              if (resolved.has(skill.name)) {
                logger.warn(`name=<${skill.name}> | duplicate skill name, overwriting previous skill`)
              }
              resolved.set(skill.name, skill)
            },
            (error) => {
              logger.warn(`url=<${source}> | failed to load skill from URL: ${error}`)
            }
          )
        )
      } else {
        skillPaths.push(source)
      }
    }

    let ready: Promise<void>
    if (asyncTasks.length > 0) {
      ready = Promise.all(asyncTasks).then(() => {
        logger.debug(
          `source_count=<${sources.length}>, resolved_count=<${resolved.size}> | skills resolved (including async)`
        )
      })
    } else {
      logger.debug(`source_count=<${sources.length}>, resolved_count=<${resolved.size}> | skills resolved`)
      ready = Promise.resolve()
    }

    return { skills: resolved, ready, skillPaths }
  }

  /**
   * Load the deferred path sources through the sandbox, mirroring `Skill.fromFile`/
   * `Skill.fromDirectory`: a path may be a SKILL.md file, a skill directory, or a parent
   * directory of skill subdirectories. Per-path failures are logged and skipped.
   */
  private async _loadSkillPaths(agent: LocalAgent): Promise<void> {
    const skills = new Map(this._skills)
    if (this._skillPaths.length === 0) {
      this._agentSkills.set(agent, skills)
      return
    }

    // Falls back to the default NotASandboxLocalEnvironment when the agent has no explicit sandbox
    const sandbox = agent.sandbox

    // A failure (e.g. malformed SKILL.md) is logged and skipped so it does
    // not abort sibling skills, matching Skill.fromDirectory's per-skill resilience.
    const loadSkill = async (skillDir: string, mdPath: string): Promise<void> => {
      try {
        const skill = Skill.fromContent(await sandbox.readText(mdPath), { strict: this._strict, path: skillDir })
        if (skills.has(skill.name)) {
          logger.warn(`name=<${skill.name}> | duplicate skill name, overwriting previous skill`)
        }
        skills.set(skill.name, skill)
      } catch (error) {
        logger.warn(`path=<${skillDir}> | failed to load skill: ${error}`)
      }
    }

    for (const skillPath of this._skillPaths) {
      const entries = await sandbox.listFiles(skillPath).catch(async () => {
        // Not a directory: accept a direct path to a SKILL.md file, as Skill.fromFile does.
        if (skillPath.toLowerCase().endsWith('skill.md')) {
          const slashIndex = skillPath.lastIndexOf('/')
          await loadSkill(slashIndex === -1 ? '.' : skillPath.slice(0, slashIndex), skillPath)
        } else {
          logger.warn(`path=<${skillPath}> | skill source does not exist or is not a valid path`)
        }
        return undefined
      })

      if (!entries) continue

      const mdName = findSkillMdName(entries)
      if (mdName) {
        await loadSkill(skillPath, `${skillPath}/${mdName}`)
        continue
      }

      // Parent directory: load each subdirectory that contains a skill.
      for (const entry of entries.filter((e) => e.isDir).sort((a, b) => a.name.localeCompare(b.name))) {
        const childDir = `${skillPath}/${entry.name}`
        const childEntries = await sandbox.listFiles(childDir).catch((error) => {
          logger.warn(`path=<${childDir}> | failed to load skill from sandbox: ${error}`)
          return undefined
        })
        if (!childEntries) continue

        const childMd = findSkillMdName(childEntries)
        if (childMd) await loadSkill(childDir, `${childDir}/${childMd}`)
      }
    }
    this._agentSkills.set(agent, skills)
  }

  /**
   * Create the skills activation tool using the tool() factory with Zod schema.
   */
  private _createSkillsTool(): Tool {
    return tool({
      name: 'skills',
      description:
        'Activate a skill to load its full instructions. ' +
        'Use this tool to load the complete instructions for a skill listed in ' +
        'the available_skills section of your system prompt.',
      inputSchema: z.object({
        skill_name: z.string().min(1).describe('Name of the skill to activate'),
      }),
      callback: async (input: { skill_name: string }, context?: ToolContext): Promise<string> => {
        if (context == null) {
          throw new Error('skills tool requires a ToolContext with an agent reference')
        }
        await this._ready
        return this._activateSkill(input.skill_name, context)
      },
    })
  }

  /**
   * Handle skill activation from the tool callback.
   */
  private async _activateSkill(skillName: string, context: ToolContext): Promise<string> {
    const skills = this._agentSkills.get(context.agent) ?? this._skills
    const found = skills.get(skillName)
    if (found == null) {
      const available = [...skills.keys()].join(', ')
      return `Skill '${skillName}' not found. Available skills: ${available}`
    }

    logger.debug(`skill_name=<${skillName}> | skill activated`)
    this._trackActivatedSkill(context.agent, skillName)
    return this._formatSkillResponse(found, context.agent.sandbox)
  }

  /**
   * Record a skill activation in agent state.
   * Maintains an ordered list of activated skill names (most recent last), without duplicates.
   */
  private _trackActivatedSkill(agent: LocalAgent, skillName: string): void {
    const activated = (this._getStateField(agent, 'activatedSkills') as string[] | undefined) ?? []
    this._setStateField(agent, 'activatedSkills', [...activated.filter((n) => n !== skillName), skillName])
  }

  /**
   * Get a field from the plugin's per-agent state dict.
   */
  private _getStateField(agent: LocalAgent, key: string): unknown {
    const data = agent.appState.get(this._stateKey)
    if (data != null && typeof data === 'object' && !Array.isArray(data)) {
      return (data as Record<string, unknown>)[key]
    }
    return undefined
  }

  /**
   * Set a single field in the plugin's per-agent state dict.
   */
  private _setStateField(agent: LocalAgent, key: string, value: unknown): void {
    const data = agent.appState.get(this._stateKey)
    if (data != null && (typeof data !== 'object' || Array.isArray(data))) {
      throw new TypeError(`expected object for state key '${this._stateKey}', got ${typeof data}`)
    }
    const record = (data ?? {}) as Record<string, unknown>
    record[key] = value
    agent.appState.set(this._stateKey, record)
  }

  /**
   * Inject skill metadata into the agent's system prompt.
   *
   * Removes the previously injected XML block (if any) via exact string
   * replacement, then appends a fresh one. Uses agent state to track the
   * injected XML per-agent, so a single plugin instance can be shared
   * across multiple agents safely.
   */
  private _injectSkillsXml(agent: LocalAgent): void {
    const skillsXml = this._generateSkillsXml(agent)
    const systemPrompt = agent.systemPrompt

    if (systemPrompt == null || typeof systemPrompt === 'string') {
      let currentPrompt = systemPrompt ?? ''

      // Remove previously injected XML by exact match
      const lastInjectedXml = this._getStateField(agent, 'lastInjectedXml') as string | undefined
      if (lastInjectedXml != null) {
        if (currentPrompt.includes(lastInjectedXml)) {
          currentPrompt = currentPrompt.replace(lastInjectedXml, '')
        } else {
          logger.warn('unable to find previously injected skills XML in system prompt, re-appending')
        }
      }

      const injection = `\n\n${skillsXml}`
      const newPrompt = currentPrompt ? `${currentPrompt}${injection}` : skillsXml
      const newInjectedXml = currentPrompt ? injection : skillsXml

      this._setStateField(agent, 'lastInjectedXml', newInjectedXml)
      agent.systemPrompt = newPrompt
    } else {
      // SystemContentBlock[] — remove previous block by exact text match, append new one
      const lastInjectedXml = this._getStateField(agent, 'lastInjectedXml') as string | undefined
      let filtered: SystemContentBlock[]
      if (lastInjectedXml != null) {
        filtered = systemPrompt.filter((block) => !(block.type === 'textBlock' && block.text === lastInjectedXml))
        if (filtered.length === systemPrompt.length) {
          logger.warn('unable to find previously injected skills XML in system prompt, re-appending')
        }
      } else {
        filtered = [...systemPrompt]
      }

      this._setStateField(agent, 'lastInjectedXml', skillsXml)
      filtered.push(new TextBlock(skillsXml))
      agent.systemPrompt = filtered
    }
  }

  /**
   * Generate the XML block listing available skills for the system prompt.
   *
   * @example Output with skills:
   * ```xml
   * <available_skills>
   * <skill>
   * <name>pdf-processing</name>
   * <description>Extract text and tables from PDF files</description>
   * <location>/path/to/pdf-processing/SKILL.md</location>
   * </skill>
   * </available_skills>
   * ```
   */
  private _generateSkillsXml(agent: LocalAgent): string {
    const skills = this._agentSkills.get(agent) ?? this._skills
    if (skills.size === 0) {
      return '<available_skills>\nNo skills are currently available.\n</available_skills>'
    }

    const lines: string[] = ['<available_skills>']

    for (const skill of skills.values()) {
      lines.push('<skill>')
      lines.push(`<name>${escapeXml(skill.name)}</name>`)
      lines.push(`<description>${escapeXml(skill.description)}</description>`)
      if (skill.path != null) {
        lines.push(`<location>${escapeXml(`${skill.path}/SKILL.md`)}</location>`)
      }
      lines.push('</skill>')
    }

    lines.push('</available_skills>')
    return lines.join('\n')
  }

  /**
   * Format the tool response when a skill is activated.
   *
   * Includes the full instructions along with relevant metadata fields
   * and a listing of available resource files.
   */
  private async _formatSkillResponse(skill: Skill, sandbox: Sandbox): Promise<string> {
    if (!skill.instructions) {
      return `Skill '${skill.name}' activated (no instructions available).`
    }

    const parts: string[] = [skill.instructions]

    const metadataLines: string[] = []
    if (skill.allowedTools != null && skill.allowedTools.length > 0) {
      metadataLines.push(`Allowed tools: ${skill.allowedTools.join(', ')}`)
    }
    if (skill.compatibility != null) {
      metadataLines.push(`Compatibility: ${skill.compatibility}`)
    }
    if (skill.path != null) {
      metadataLines.push(`Location: ${skill.path}/SKILL.md`)
    }

    if (metadataLines.length > 0) {
      parts.push('\n---\n' + metadataLines.join('\n'))
    }

    if (skill.path != null) {
      const resources = await this._listSkillResources(sandbox, skill.path)
      if (resources.length > 0) {
        parts.push('\nAvailable resources:\n' + resources.map((r) => `  ${r}`).join('\n'))
      }
    }

    return parts.join('\n')
  }

  /**
   * List resource files in a skill's optional directories.
   *
   * Scans `scripts/`, `references/`, and `assets/` subdirectories for files,
   * returning relative paths. Results are capped at maxResourceFiles.
   */
  private async _listSkillResources(sandbox: Sandbox, skillPath: string): Promise<string[]> {
    const files: string[] = []

    // List a directory recursively through the sandbox, returning paths relative to its root.
    // Replaces readdirSync(dir, { recursive: true }), which has no sandbox equivalent.
    const listFilesRecursive = async (dir: string, depth = 0): Promise<string[]> => {
      if (depth >= 3) return []
      const result: string[] = []
      for (const entry of await sandbox.listFiles(dir)) {
        if (entry.isDir)
          result.push(...(await listFilesRecursive(`${dir}/${entry.name}`, depth + 1)).map((p) => `${entry.name}/${p}`))
        else result.push(entry.name)
      }
      return result
    }

    for (const dirName of RESOURCE_DIRS) {
      const resourceDir = `${skillPath}/${dirName}`
      let entries: string[]
      try {
        entries = await listFilesRecursive(resourceDir)
      } catch {
        continue
      }

      for (const entry of entries.sort()) {
        files.push(`${dirName}/${entry}`)
        if (files.length >= this._maxResourceFiles) {
          files.push(`... (truncated at ${this._maxResourceFiles} files)`)
          return files
        }
      }
    }

    return files
  }
}
