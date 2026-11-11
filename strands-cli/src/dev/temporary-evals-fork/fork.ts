export const TEMPORARY_EVALS_FORK = {
  repository: 'https://github.com/arielnabavian/evals',
  commit: '6c580e279b3e1abe3125afa7f9b6bde52807a34e',
} as const

export const TEMPORARY_EVALS_FORK_REQUIREMENT = `strands-agents-evals[optimization] @ git+${TEMPORARY_EVALS_FORK.repository}@${TEMPORARY_EVALS_FORK.commit}`
