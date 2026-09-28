import type { HarnessAgentConfig } from '@strands-agents/harness'
import { DEFAULT_MEMORY_DIR, DEFAULT_SKILLS_DIR } from '@strands-agents/harness/internal'

/** Whether a profile loads skills at all (`skills: false` is the only off switch). */
export function profileSkillsEnabled(profile: Pick<HarnessAgentConfig, 'skills'>): boolean {
  return profile.skills !== false
}

/** The skill directories a profile configures; the `true` default spells the library's default directory. */
export function profileSkillPaths(profile: Pick<HarnessAgentConfig, 'skills'>): string[] {
  const { skills } = profile
  if (skills === false) return []
  if (skills === true) return [DEFAULT_SKILLS_DIR]
  return typeof skills === 'string' ? [skills] : [...skills]
}

export function profileMemoryEnabled(profile: Pick<HarnessAgentConfig, 'memory'>): boolean {
  return profile.memory !== false
}

export function profileMemoryDir(profile: Pick<HarnessAgentConfig, 'memory'>): string {
  const { memory } = profile
  return typeof memory === 'object' ? (memory.dir ?? DEFAULT_MEMORY_DIR) : DEFAULT_MEMORY_DIR
}

/** A `memory` value with the given directory: the default directory keeps the plain `true`. */
export function memoryForDir(dir: string): HarnessAgentConfig['memory'] {
  return dir.trim() === '' || dir.trim() === DEFAULT_MEMORY_DIR ? true : { dir: dir.trim() }
}

export function contextManagerLabel(value: HarnessAgentConfig['contextManager']): string {
  return value === false ? 'off' : value
}
