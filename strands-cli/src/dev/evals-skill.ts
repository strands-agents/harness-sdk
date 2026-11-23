import type { AgentExtensionUrlSkill } from '../agent/extension.js'
import { strandsEvalsSkillUrl } from './evals-package.js'

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
