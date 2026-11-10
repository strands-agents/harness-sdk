/**
 * AgentSkills.io integration for Strands Agents.
 *
 * This module provides the AgentSkills plugin and Skill data model for
 * loading and managing AgentSkills.io skills. Skills enable progressive
 * disclosure of instructions: metadata is injected into the system prompt
 * upfront, and full instructions are loaded on demand via a tool.
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

export { Skill } from './skill.js'
export type { SkillConfig } from './skill.js'

export { AgentSkills } from './agent-skills.js'
export type { AgentSkillsConfig, SkillSource } from './agent-skills.js'
