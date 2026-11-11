export const TEMPORARY_EVALS_FORK = {
  repository: 'https://github.com/arielnabavian/evals',
  commit: '257726a52c1d544a98700e046a32e736540e7128',
} as const

export const TEMPORARY_EVALS_FORK_REQUIREMENT = `strands-agents-evals[optimization] @ git+${TEMPORARY_EVALS_FORK.repository}@${TEMPORARY_EVALS_FORK.commit}`
