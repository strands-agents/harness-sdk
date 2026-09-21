/**
 * Default configuration for the harness.
 */

export const DEFAULT_MODEL = 'bedrock/global.anthropic.claude-opus-4-8'

export const DEFAULT_EFFORT = 'auto'

export const DEFAULT_CONTEXT_MANAGER = 'auto'

export const DEFAULT_CACHING = 'auto'

export const DEFAULT_BUILTIN_TOOLS = [
  'shell',
  'read',
  'write',
  'edit',
  'web_fetch',
  'web_search',
  'programmatic_tool_caller',
  'subagent',
] as const

export const DEFAULT_BUILTIN_PLUGINS = ['todos', 'environment'] as const

export const DEFAULT_SUBAGENT_MAX_DEPTH = 2

export const DEFAULT_SESSION = true

export const DEFAULT_SESSION_DIR = './.agent/sessions'

export const DEFAULT_SKILLS = true

export const DEFAULT_SKILLS_DIR = './.agent/skills'

export const DEFAULT_MEMORY = true

export const DEFAULT_MEMORY_DIR = './.agent/memory'
