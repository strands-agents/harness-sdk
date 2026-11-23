import type { AgentExtensionUrlSkill } from '../agent/extension.js'

// Pinned to the strands-agents-evals release on PyPI; load it from the package once the wheel ships it.
export const STRANDS_EVALS_SKILL: AgentExtensionUrlSkill = {
  name: 'strands-evals',
  url: 'https://raw.githubusercontent.com/strands-agents/evals/v1.11.0/SKILL.md',
}

// Pinned to a commit of the evals branch workstream/optimizer-workflow until the optimizer reaches main.
export const STRANDS_EVALS_OPTIMIZE_SKILL: AgentExtensionUrlSkill = {
  name: 'optimize',
  url: 'https://raw.githubusercontent.com/strands-agents/evals/eeee89057596c1f8d3f0e0feb7acfbcfc5733e9d/.agents/skills/optimize/SKILL.md',
}

export const evalsSkillUnavailable = ({ name, url }: AgentExtensionUrlSkill): string =>
  `strands dev could not load the ${name} skill from ${url}. Check your network connection, then restart strands dev.`
