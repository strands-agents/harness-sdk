export const STRANDS_EVALS_VERSION = '1.12.0'

export const STRANDS_EVALS_REQUIREMENT = `strands-agents-evals[optimization]==${STRANDS_EVALS_VERSION}`

export const STRANDS_EVALS_LABEL = `strands-agents-evals ${STRANDS_EVALS_VERSION}`

export const strandsEvalsSkillUrl = (name: string): string =>
  `https://raw.githubusercontent.com/strands-agents/evals/v${STRANDS_EVALS_VERSION}/.agents/skills/${name}/SKILL.md`
