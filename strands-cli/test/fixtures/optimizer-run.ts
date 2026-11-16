import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const OPTIMIZER_RUN_FOLDER = '20261111-150405-abc123'

type Values = Readonly<Record<string, unknown>>

export interface OptimizerCandidate {
  readonly id: string
  readonly number: number
  readonly iteration?: number
  readonly values: Values
  readonly changed?: readonly string[]
  readonly train?: number
  readonly validation?: number
  readonly test?: number
  readonly failed?: string
}

const score = (candidate: OptimizerCandidate, split: 'train' | 'validation' | 'test', value: number) =>
  JSON.stringify({
    event: 'score',
    iteration: candidate.iteration ?? 0,
    candidate_id: candidate.id,
    split,
    objective_by_run: { first: [value], second: [value] },
    statuses: { completed: 2 },
  })

export const optimizerConfig = (
  options: { objective?: string; iterations?: number; width?: number; textKeys?: readonly string[] } = {}
): string =>
  JSON.stringify({
    event: 'config',
    iteration: 0,
    config: {
      objective: options.objective ?? 'Maximize(OutputEvaluator)',
      space: (options.textKeys ?? ['instructions']).map((key) => ({ key, kind: 'text' })),
      proposals_per_iteration: options.width ?? 4,
      budget: { max_rollouts: 500, max_iterations: options.iterations ?? 1 },
    },
  })

export const optimizerCandidate = (candidate: OptimizerCandidate): string[] => [
  JSON.stringify({
    event: 'propose',
    iteration: candidate.iteration ?? 0,
    candidate_id: candidate.id,
    number: candidate.number,
    parent_id: candidate.number === 0 ? null : 'base',
    origin: candidate.number === 0 ? ['baseline'] : ['text'],
    values: candidate.values,
    changed_keys: candidate.changed ?? [],
  }),
  ...(candidate.failed
    ? [
        JSON.stringify({
          event: 'trial',
          record: {
            candidate_id: candidate.id,
            case_name: 'first',
            split: 'train',
            status: 'failed',
            error: candidate.failed,
          },
        }),
        JSON.stringify({
          event: 'score',
          iteration: candidate.iteration ?? 0,
          candidate_id: candidate.id,
          split: 'train',
          objective_by_run: { first: [0], second: [0] },
          statuses: { failed: 2 },
        }),
      ]
    : []),
  ...(candidate.train === undefined ? [] : [score(candidate, 'train', candidate.train)]),
  ...(candidate.validation === undefined ? [] : [score(candidate, 'validation', candidate.validation)]),
  ...(candidate.test === undefined ? [] : [score(candidate, 'test', candidate.test)]),
]

export const optimizerIterationEnd = (bestAfter: readonly string[]): string =>
  JSON.stringify({ event: 'iteration_end', iteration: 1, best_after: bestAfter, best_objective: 1 })

export const optimizerStop = (reason = 'iterations', message = 'used the iterations'): string =>
  JSON.stringify({ event: 'stop', iteration: 1, reason, message })

export const optimizerPicked = (champion: string): string =>
  JSON.stringify({ event: 'picked', iteration: 1, report: { champion_id: champion } })

export const optimizerTested = (
  champion: string,
  baseline: string,
  difference: number,
  cases: number,
  ci?: readonly [number, number]
): string =>
  JSON.stringify({
    event: 'test',
    iteration: 1,
    report: {
      champion_id: champion,
      baseline_id: baseline,
      objective: { mean_diff: difference, ci_low: ci?.[0] ?? null, ci_high: ci?.[1] ?? null, n_cases: cases },
    },
  })

export const writeOptimizerRun = async (
  record: string,
  lines: readonly string[],
  result?: unknown
): Promise<string> => {
  const folder = join(record, OPTIMIZER_RUN_FOLDER)
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'events.jsonl'), [...lines, ''].join('\n'))
  if (result !== undefined) await writeFile(join(folder, 'result.json'), JSON.stringify(result))
  return folder
}
