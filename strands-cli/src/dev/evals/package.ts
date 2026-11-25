import type { AgentExtensionUrlSkill } from '../../agent/extension.js'

export const STRANDS_EVALS_VERSION = '1.13.0'

export const STRANDS_EVALS_REQUIREMENT = `strands-agents-evals[optimization]==${STRANDS_EVALS_VERSION}`

export const STRANDS_EVALS_LABEL = `strands-agents-evals ${STRANDS_EVALS_VERSION}`

const strandsEvalsSkillUrl = (name: string): string =>
  `https://raw.githubusercontent.com/strands-agents/evals/v${STRANDS_EVALS_VERSION}/.agents/skills/${name}/SKILL.md`

export const STRANDS_EVALS_SKILL: AgentExtensionUrlSkill = {
  name: 'strands-evals',
  url: strandsEvalsSkillUrl('strands-evals'),
}

export const STRANDS_EVALS_OPTIMIZE_SKILL: AgentExtensionUrlSkill = {
  name: 'optimize',
  url: strandsEvalsSkillUrl('optimize'),
}

export const evalsSkillUnavailable = ({ name, url }: AgentExtensionUrlSkill): string =>
  `strands dev could not load the ${name} skill from ${url}. Check your network connection, then restart strands dev.`
