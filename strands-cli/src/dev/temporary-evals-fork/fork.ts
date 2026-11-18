export const TEMPORARY_EVALS_FORK = {
  repository: 'https://github.com/arielnabavian/evals',
  commit: '4eafc16a250e54aa33b6a496098f78c2c37010a5',
} as const

export const TEMPORARY_EVALS_FORK_REQUIREMENT = `strands-agents-evals[optimization] @ git+${TEMPORARY_EVALS_FORK.repository}@${TEMPORARY_EVALS_FORK.commit}`
