import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { vi } from 'vitest'

import { evalsVenvPython, type EvalsCommandRequest } from '../../src/dev/evals/runs/environment.js'
import type { DevWorkspace } from '../../src/dev/workspace.js'
import { temporaryDirectory } from './tempdir.js'

export const writeFileAt = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

export const EXPERIMENT = JSON.stringify({ cases: [{ name: 'a' }, { name: 'b' }], evaluators: [] })

export const experimentFile = (directory: string, name: string): string =>
  join(directory, 'experiments', name, `${name}.json`)

/** A dev workspace with a project interpreter and an experiment file for each name. */
export const workspaceFixture = async (
  experiments: string[] = ['support'],
  language: 'python' | 'typescript' = 'python'
): Promise<DevWorkspace> => {
  const root = await temporaryDirectory()
  const directory = join(root, 'strands-dev')
  await writeFileAt(evalsVenvPython(join(root, '.venv')), 'fixture interpreter')
  await Promise.all(experiments.map((name) => writeFileAt(experimentFile(directory, name), EXPERIMENT)))
  return {
    directory,
    root,
    entrypoint: join(root, language === 'python' ? 'agent.py' : 'agent.ts'),
    config: { version: 1, name: 'desk', language, entrypoint: 'agent.py', origin: { kind: 'discovered' } },
  }
}

/** The commands that prepare the evals environment, answered without a Python. */
export const environmentRunner = () =>
  vi.fn(async ({ command, args }: EvalsCommandRequest): Promise<string> => {
    if (args[1]?.includes('platform.python_version')) return JSON.stringify({ version: '3.12.4', paths: [] })
    if (args[0] === '-m' && args[1] === 'venv') await writeFileAt(evalsVenvPython(args[3]!), 'fixture interpreter')
    if (args[1]?.includes('site.getsitepackages()[0]')) {
      const sitePackages = join(dirname(dirname(command)), 'lib', 'site-packages')
      await mkdir(sitePackages, { recursive: true })
      return sitePackages
    }
    return ''
  })

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
  readonly rationale?: string
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

export interface OptimizerSplitCases {
  readonly train: readonly string[]
  readonly validation: readonly string[]
  readonly test: readonly string[]
}

export const optimizerConfig = (
  options: {
    objective?: string
    iterations?: number
    width?: number
    textKeys?: readonly string[]
    cases?: OptimizerSplitCases
    runs?: number
  } = {}
): string =>
  JSON.stringify({
    event: 'config',
    iteration: 0,
    config: {
      objective: options.objective ?? 'Maximize(OutputEvaluator)',
      space: (options.textKeys ?? ['instructions']).map((key) => ({ key, kind: 'text' })),
      proposals_per_iteration: options.width ?? 4,
      budget: { max_rollouts: 500, max_iterations: options.iterations ?? 1 },
      ...(options.runs === undefined ? {} : { runs_per_candidate: options.runs }),
      ...(options.cases ? { split: { train: 0.5, validation: 0.25, test: 0.25, cases: options.cases } } : {}),
    },
  })

export interface OptimizerTrial {
  readonly candidate: string
  readonly caseName: string
  readonly split?: 'train' | 'validation' | 'test'
  readonly run?: number
  readonly score?: number
  readonly reason?: string
  readonly output?: unknown
  readonly status?: string
  readonly error?: string
  readonly evaluator?: string
  readonly scores?: Readonly<Record<string, number>>
}

export const optimizerTrial = ({
  candidate,
  caseName,
  split = 'train',
  run = 0,
  score: value = 1,
  reason = 'Looks right',
  output = 'the answer',
  status = 'completed',
  error,
  evaluator = 'OutputEvaluator',
  scores = { [evaluator]: value },
}: OptimizerTrial): string =>
  JSON.stringify({
    event: 'trial',
    iteration: 0,
    record: {
      candidate_id: candidate,
      case_name: caseName,
      run_index: run,
      split,
      status,
      error_type: error ? 'AgentError' : null,
      error: error ?? null,
      output: status === 'completed' ? output : null,
      evaluations:
        status === 'completed'
          ? Object.fromEntries(
              Object.entries(scores).map(([name, score]) => [
                name,
                { score, test_pass: score >= 0.5, reason, label: null, metadata: null },
              ])
            )
          : {},
      usage: { tokens: 12, seconds: 0.5, model_calls: 1 },
    },
  })

export const optimizerFinalists = (ids: readonly string[]): string =>
  JSON.stringify({ event: 'finalists', iteration: 1, candidate_ids: ids })

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
    ...(candidate.rationale ? { rationale: candidate.rationale } : {}),
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

export const optimizerProposerError = (type: string, error: string): string =>
  JSON.stringify({ event: 'proposer_error', iteration: 1, block: 'instructions', redraw: 0, error_type: type, error })

export const optimizerResume = (): string =>
  JSON.stringify({ event: 'resume', iteration: 1, spent: 4, budget: { max_rollouts: 100, max_iterations: 4 } })

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
