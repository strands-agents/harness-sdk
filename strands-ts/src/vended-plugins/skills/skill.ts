/**
 * Skill data model and loading utilities for AgentSkills.io skills.
 *
 * This module defines the Skill class and provides static methods for
 * discovering, parsing, and loading skills from the filesystem, raw content,
 * or HTTPS URLs. Skills are directories containing a SKILL.md file with YAML
 * frontmatter metadata and markdown instructions.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { resolve, join, basename } from 'path'
import { parse as parseYaml } from 'yaml'
import { logger } from '../../logging/logger.js'

const SKILL_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
const MAX_SKILL_NAME_LENGTH = 64
const SKILL_HTTPS_FETCH_TIMEOUT_MS = 30_000

/**
 * Configuration for creating a Skill instance.
 */
export interface SkillConfig {
  /** Unique identifier for the skill (1-64 chars, lowercase alphanumeric + hyphens). */
  name: string
  /** Human-readable description of what the skill does. */
  description: string
  /** Full markdown instructions from the SKILL.md body. */
  instructions?: string | undefined
  /** Filesystem path to the skill directory, if loaded from disk. */
  path?: string | undefined
  /** List of tool names the skill is allowed to use. (Experimental: not yet enforced) */
  allowedTools?: string[] | undefined
  /** Additional key-value metadata from the SKILL.md frontmatter. */
  metadata?: Record<string, unknown> | undefined
  /** License identifier (e.g., "Apache-2.0"). */
  license?: string | undefined
  /** Compatibility information string. */
  compatibility?: string | undefined
}

/**
 * Find the SKILL.md file in a skill directory.
 *
 * Searches for SKILL.md (case-sensitive preferred) or skill.md as a fallback.
 */
function findSkillMd(skillDir: string): string {
  for (const name of ['SKILL.md', 'skill.md']) {
    const candidate = join(skillDir, name)
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate
    }
  }
  throw new Error(`path=<${skillDir}> | no SKILL.md found in skill directory`)
}

/**
 * Parse YAML frontmatter and body from SKILL.md content.
 *
 * Extracts the YAML frontmatter between `---` delimiters and returns
 * parsed key-value pairs along with the remaining markdown body.
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const stripped = content.trim()
  if (!stripped.startsWith('---')) {
    throw new Error('SKILL.md must start with --- frontmatter delimiter')
  }

  // Find the closing --- delimiter (first line after the opener that is only dashes)
  const match = stripped.substring(3).match(/\n^---\s*$/m)
  if (match == null || match.index == null) {
    throw new Error('SKILL.md frontmatter missing closing --- delimiter')
  }

  const frontmatterStr = stripped.substring(3, match.index + 3).trim()
  const body = stripped.substring(match.index + 3 + match[0].length).trim()

  let result: unknown
  try {
    result = parseYaml(frontmatterStr)
  } catch {
    // AgentSkills spec recommends handling malformed YAML (e.g. unquoted colons in values)
    // to improve cross-client compatibility.
    logger.warn('YAML parse failed, retrying with colon-quoting fallback')
    const fixed = fixYamlColons(frontmatterStr)
    result = parseYaml(fixed)
  }

  const frontmatter: Record<string, unknown> =
    typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {}
  return { frontmatter, body }
}

/**
 * Attempt to fix common YAML issues like unquoted colons in values.
 *
 * Wraps values containing colons in double quotes to handle cases like:
 * `description: Use this skill when: the user asks about PDFs`
 */
function fixYamlColons(yamlStr: string): string {
  return yamlStr
    .split('\n')
    .map((line) => {
      const match = line.match(/^(\s*\w[\w-]*):\s+(.+)$/)
      if (match) {
        const [, key, value] = match
        if (value && value.includes(':') && !value.startsWith('"') && !value.startsWith("'")) {
          // Escape backslashes and double-quotes inside the value before wrapping,
          // otherwise values like `Use when: user says "hello"` produce broken YAML.
          const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
          return `${key}: "${escaped}"`
        }
      }
      return line
    })
    .join('\n')
}

/**
 * Validate a skill name per the AgentSkills.io specification.
 *
 * In lenient mode (default), logs warnings for cosmetic issues but does not throw.
 * In strict mode, throws Error for any validation failure.
 *
 * Rules checked:
 * - 1-64 characters long
 * - Lowercase alphanumeric characters and hyphens only
 * - Cannot start or end with a hyphen
 * - No consecutive hyphens
 * - Must match parent directory name (if loaded from disk)
 */
function validateSkillName(name: string, dirPath?: string, options?: { strict?: boolean }): void {
  const strict = options?.strict ?? false

  if (!name) {
    throw new Error('Skill name cannot be empty')
  }

  if (name.length > MAX_SKILL_NAME_LENGTH) {
    const msg = `name=<${name}> | skill name exceeds ${MAX_SKILL_NAME_LENGTH} character limit`
    if (strict) throw new Error(msg)
    logger.warn(msg)
  }

  if (!SKILL_NAME_PATTERN.test(name)) {
    const msg = `name=<${name}> | skill name should be 1-64 lowercase alphanumeric characters or hyphens, should not start/end with hyphen`
    if (strict) throw new Error(msg)
    logger.warn(msg)
  }

  if (name.includes('--')) {
    const msg = `name=<${name}> | skill name contains consecutive hyphens`
    if (strict) throw new Error(msg)
    logger.warn(msg)
  }

  if (dirPath != null && basename(dirPath) !== name) {
    const msg = `name=<${name}>, directory=<${basename(dirPath)}> | skill name does not match parent directory name`
    if (strict) throw new Error(msg)
    logger.warn(msg)
  }
}

/**
 * Build a Skill instance from parsed frontmatter and body.
 */
function buildSkillFromFrontmatter(
  frontmatter: Record<string, unknown>,
  body: string,
  path?: string | undefined
): Skill {
  // Parse allowed-tools (space-delimited string or YAML list)
  const allowedToolsRaw = (frontmatter['allowed-tools'] ?? frontmatter['allowed_tools']) as
    string | unknown[] | undefined
  let allowedTools: string[] | undefined
  if (typeof allowedToolsRaw === 'string' && allowedToolsRaw.trim()) {
    allowedTools = allowedToolsRaw.trim().split(/\s+/)
  } else if (Array.isArray(allowedToolsRaw)) {
    allowedTools = allowedToolsRaw.filter((item) => item != null).map(String)
  }

  // Parse metadata (nested mapping)
  const metadataRaw = frontmatter['metadata']
  const metadata: Record<string, unknown> = {}
  if (typeof metadataRaw === 'object' && metadataRaw !== null && !Array.isArray(metadataRaw)) {
    for (const [k, v] of Object.entries(metadataRaw)) {
      metadata[String(k)] = v
    }
  }

  const skillLicense = frontmatter['license']
  const compatibility = frontmatter['compatibility']

  return new Skill({
    name: frontmatter['name'] as string,
    description: frontmatter['description'] as string,
    instructions: body,
    path,
    allowedTools,
    metadata,
    license: skillLicense != null ? String(skillLicense) : undefined,
    compatibility: compatibility != null ? String(compatibility) : undefined,
  })
}

/**
 * Represents an agent skill with metadata and instructions.
 *
 * A skill encapsulates a set of instructions and metadata that can be
 * dynamically loaded by an agent at runtime. Skills support progressive
 * disclosure: metadata is shown upfront in the system prompt, and full
 * instructions are loaded on demand via a tool.
 *
 * Skills can be created directly or via convenience static methods:
 *
 * @example
 * ```typescript
 * // From a skill directory on disk
 * const skill = Skill.fromFile('./skills/my-skill')
 *
 * // From raw SKILL.md content
 * const skill = Skill.fromContent('---\nname: my-skill\n...')
 *
 * // Load all skills from a parent directory
 * const skills = Skill.fromDirectory('./skills/')
 *
 * // From an HTTPS URL
 * const skill = await Skill.fromUrl('https://example.com/SKILL.md')
 * ```
 */
export class Skill {
  /** Unique identifier for the skill (1-64 chars, lowercase alphanumeric + hyphens). */
  readonly name: string

  /** Human-readable description of what the skill does. */
  readonly description: string

  /** Full markdown instructions from the SKILL.md body. */
  readonly instructions: string

  /** Filesystem path to the skill directory, if loaded from disk. */
  readonly path: string | undefined

  /** List of tool names the skill is allowed to use. (Experimental: not yet enforced) */
  readonly allowedTools: string[] | undefined

  /** Additional key-value metadata from the SKILL.md frontmatter. */
  readonly metadata: Record<string, unknown>

  /** License identifier (e.g., "Apache-2.0"). */
  readonly license: string | undefined

  /** Compatibility information string. */
  readonly compatibility: string | undefined

  constructor(config: SkillConfig) {
    this.name = config.name
    this.description = config.description
    this.instructions = config.instructions ?? ''
    this.path = config.path
    this.allowedTools = config.allowedTools
    this.metadata = config.metadata ?? {}
    this.license = config.license
    this.compatibility = config.compatibility
  }

  /**
   * Load a single skill from a directory containing SKILL.md.
   *
   * Resolves the filesystem path, reads the file content, and delegates
   * to {@link fromContent} for parsing. After loading, sets the skill's
   * `path` and validates the skill name against the parent directory.
   *
   * @param skillPath - Path to the skill directory or the SKILL.md file itself.
   * @param options - Optional settings. When `strict` is true, throws on any validation issue; otherwise warns and loads anyway.
   * @returns A Skill instance populated from the SKILL.md file.
   */
  static fromFile(skillPath: string, options?: { strict?: boolean }): Skill {
    const resolvedPath = resolve(skillPath)

    let skillMdPath: string
    let skillDir: string

    if (
      existsSync(resolvedPath) &&
      statSync(resolvedPath).isFile() &&
      basename(resolvedPath).toLowerCase() === 'skill.md'
    ) {
      skillMdPath = resolvedPath
      skillDir = resolve(resolvedPath, '..')
    } else if (existsSync(resolvedPath) && statSync(resolvedPath).isDirectory()) {
      skillDir = resolvedPath
      skillMdPath = findSkillMd(skillDir)
    } else {
      throw new Error(`path=<${resolvedPath}> | skill path does not exist or is not a valid skill directory`)
    }

    logger.debug(`path=<${skillMdPath}> | loading skill`)

    const content = readFileSync(skillMdPath, 'utf-8')
    const skill = Skill.fromContent(content, { ...options, path: skillDir })

    logger.debug(`name=<${skill.name}>, path=<${skill.path}> | skill loaded successfully`)
    return skill
  }

  /**
   * Parse SKILL.md content into a Skill instance.
   *
   * Creates a Skill from raw SKILL.md content (YAML frontmatter + markdown body)
   * without requiring a file on disk.
   *
   * @example
   * ```typescript
   * const content = `---
   * name: my-skill
   * description: Does something useful
   * ---
   * # Instructions
   * Follow these steps...`
   *
   * const skill = Skill.fromContent(content)
   * ```
   *
   * @param content - Raw SKILL.md content with YAML frontmatter and markdown body.
   * @param options - Optional settings. When `strict` is true, throws on any validation issue; otherwise warns and loads anyway.
   * @returns A Skill instance populated from the parsed content.
   */
  static fromContent(content: string, options?: { strict?: boolean; path?: string | undefined }): Skill {
    const strict = options?.strict ?? false
    const { frontmatter, body } = parseFrontmatter(content)

    const name = frontmatter['name']
    if (typeof name !== 'string' || !name) {
      throw new Error("SKILL.md content must have a 'name' field in frontmatter")
    }

    const description = frontmatter['description']
    if (typeof description !== 'string' || !description) {
      throw new Error("SKILL.md content must have a 'description' field in frontmatter")
    }

    validateSkillName(name, options?.path, { strict })

    return buildSkillFromFrontmatter(frontmatter, body, options?.path)
  }

  /**
   * Load a skill by fetching its SKILL.md content from an HTTPS URL.
   *
   * Fetches the raw SKILL.md content over HTTPS and parses it using
   * {@link fromContent}. The URL must point directly to the raw file
   * content (not an HTML page).
   *
   * @example
   * ```typescript
   * const skill = await Skill.fromUrl(
   *   'https://raw.githubusercontent.com/org/repo/main/SKILL.md'
   * )
   * ```
   *
   * @param url - An `https://` URL pointing directly to raw SKILL.md content.
   * @param options - Optional settings. When `strict` is true, throws on any validation issue; otherwise warns and loads anyway.
   * @returns A Promise resolving to a Skill instance populated from the fetched SKILL.md content.
   * @throws If `url` is not an `https://` URL.
   * @throws If the SKILL.md content cannot be fetched.
   */
  static async fromUrl(url: string, options?: { strict?: boolean }): Promise<Skill> {
    if (!url.startsWith('https://')) {
      throw new Error(`url=<${url}> | not a valid HTTPS URL`)
    }

    logger.info(`url=<${url}> | fetching skill content`)

    let content: string
    try {
      const response = await globalThis.fetch(url, {
        headers: { 'User-Agent': 'strands-agents-sdk' },
        signal: AbortSignal.timeout(SKILL_HTTPS_FETCH_TIMEOUT_MS),
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
      content = await response.text()
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('HTTP ')) {
        throw new Error(`url=<${url}> | ${error.message}`, { cause: error })
      }
      throw new Error(`url=<${url}> | failed to fetch skill: ${error instanceof Error ? error.message : error}`, {
        cause: error,
      })
    }

    return Skill.fromContent(content, options)
  }

  /**
   * Load all skills from a parent directory containing skill subdirectories.
   *
   * Each subdirectory containing a SKILL.md file is treated as a skill.
   * Subdirectories without SKILL.md are silently skipped.
   *
   * @param skillsDir - Path to the parent directory containing skill subdirectories.
   * @param options - Optional settings. When `strict` is true, throws on any validation issue; otherwise warns and loads anyway.
   * @returns List of Skill instances loaded from the directory.
   */
  static fromDirectory(skillsDir: string, options?: { strict?: boolean }): Skill[] {
    const resolvedDir = resolve(skillsDir)

    if (!existsSync(resolvedDir) || !statSync(resolvedDir).isDirectory()) {
      throw new Error(`path=<${resolvedDir}> | skills directory does not exist`)
    }

    const skills: Skill[] = []
    const children = readdirSync(resolvedDir).sort()

    for (const child of children) {
      const childPath = join(resolvedDir, child)
      if (!existsSync(childPath) || !statSync(childPath).isDirectory()) continue

      try {
        findSkillMd(childPath)
      } catch {
        logger.debug(`path=<${childPath}> | skipping directory without SKILL.md`)
        continue
      }

      try {
        const skill = Skill.fromFile(childPath, options)
        skills.push(skill)
      } catch (error) {
        logger.warn(`path=<${childPath}> | skipping skill due to error: ${error}`)
      }
    }

    logger.debug(`path=<${resolvedDir}>, count=<${skills.length}> | loaded skills from directory`)
    return skills
  }
}
