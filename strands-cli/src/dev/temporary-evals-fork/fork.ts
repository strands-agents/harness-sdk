export const TEMPORARY_EVALS_FORK = {
  repository: 'https://github.com/arielnabavian/evals',
  commit: 'dd073cca0b43265840635430499efb5a1661afc1',
} as const

export const TEMPORARY_EVALS_FORK_REQUIREMENT = `strands-agents-evals[optimization] @ git+${TEMPORARY_EVALS_FORK.repository}@${TEMPORARY_EVALS_FORK.commit}`
