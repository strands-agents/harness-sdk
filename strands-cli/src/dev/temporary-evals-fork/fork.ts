export const TEMPORARY_EVALS_FORK = {
  repository: 'https://github.com/arielnabavian/evals',
  commit: 'e7bfdad0ea30c5e183294412ad466969a9c4d743',
} as const

export const TEMPORARY_EVALS_FORK_REQUIREMENT = `strands-agents-evals[optimization] @ git+${TEMPORARY_EVALS_FORK.repository}@${TEMPORARY_EVALS_FORK.commit}`
