import {
  sameCaseSplit,
  type CaseSplit,
  type DecisionChoices,
  type OptimizeDecision,
  type PickRule,
  type UsageEstimate,
  type UsageRange,
} from '../model.js'
import { plural } from '../host.js'
import type { EvalsRolloutPhases, EvalsUsageProfile } from './study.js'

export type EvalsSplitShares = readonly [train: number, validation: number, test: number]

export interface EvalsOptimizeSettings {
  readonly split: EvalsSplitShares
  readonly repetitions: number
  readonly width: number
  readonly iterations: number
  readonly concurrency: number
  readonly maxRollouts: number
  readonly rerunPasses: number
  readonly seed: number
  readonly decision: OptimizeDecision
}

interface EvalsRolloutPlan {
  readonly split: CaseSplit
  readonly repetitions: number
  readonly iterations: number
  readonly width: number
  readonly evaluators: number
  readonly finalists?: number
  readonly pareto?: boolean
  readonly rerunPasses?: number
  readonly profile?: EvalsUsageProfile
}

interface EvalsRolloutEstimate {
  readonly rollouts: number
  readonly judgeCalls: number
  readonly usage?: UsageEstimate
}

export const EVALS_DECISION_DEFAULTS: OptimizeDecision = {
  feasibility: 0.9,
  crashScore: 'worst',
  pickRule: 'mean',
  finalists: 3,
}

export const EVALS_DECISION_CHOICES: DecisionChoices = {
  feasibility: [0.8, 0.9, 0.95, 0.99],
  crashScore: ['worst', 'none'],
  pickRule: ['mean', 'lower-bound-25', 'lower-bound-10'],
}

export const EVALS_PICK_QUANTILES: Readonly<Record<Exclude<PickRule, 'mean'>, number>> = {
  'lower-bound-25': 0.25,
  'lower-bound-10': 0.1,
}

export const EVALS_OPTIMIZE_DEFAULTS: EvalsOptimizeSettings = {
  split: [0.5, 0.25, 0.25],
  repetitions: 1,
  width: 4,
  iterations: 4,
  concurrency: 4,
  maxRollouts: 500,
  rerunPasses: 2,
  seed: 0,
  decision: EVALS_DECISION_DEFAULTS,
}

// The optimizer takes any whole number from these: 0 steps measures only the baseline (optimizer.py, budget.py).
export const EVALS_BUDGET_MINIMUMS = {
  iterations: 0,
  width: 1,
  repetitions: 1,
  workers: 1,
  finalists: 1,
  maxRollouts: 1,
  rerunPasses: 0,
} as const

export type EvalsBudgetSetting = keyof typeof EVALS_BUDGET_MINIMUMS

export const isEvalsBudgetValue = (setting: EvalsBudgetSetting, value: number): boolean =>
  Number.isSafeInteger(value) && value >= EVALS_BUDGET_MINIMUMS[setting]

export const evalsRolloutCapProblem = (
  rollouts: number,
  cap: number = EVALS_OPTIMIZE_DEFAULTS.maxRollouts
): string | undefined =>
  rollouts > cap
    ? `Needs about ${rollouts} rollouts with re-run headroom, but this run can use ${cap}. Lower the steps, candidates, or runs, or raise --max-rollouts.`
    : undefined

const EVALS_TRAIN_SHARES: readonly number[] = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]

export const EVALS_TEST_SHARES: readonly number[] = [1 / 2, 1 / 3, 0]

const PARETO_MIN_FINALISTS = 5
const TESTED_WITHOUT_PARETO = 2
const MINIMUM_HELD_OUT_CASES = 2
const MAXIMUM_WIDE_TEST_CASES = 4
const SHARE_TOLERANCE = 1e-9
const CASE_SEARCH_LIMIT = 1000

export const evalsCaseSplit = (
  caseCount: number,
  split: EvalsSplitShares = EVALS_OPTIMIZE_DEFAULTS.split
): CaseSplit => {
  const exact = split.map((share) => share * caseCount)
  const floors = exact.map((value) => Math.floor(value))
  const remainder = (index: number): number => exact[index]! - floors[index]!
  const short = caseCount - floors.reduce((sum, count) => sum + count, 0)
  const topped = new Set([0, 1, 2].sort((a, b) => remainder(b) - remainder(a)).slice(0, short))
  const [train = 0, validation = 0, test = 0] = floors.map((count, index) => (topped.has(index) ? count + 1 : count))
  return { train, validation, test }
}

export const evalsSplitChoices = (caseCount: number, testShare = EVALS_TEST_SHARES[0]!): CaseSplit[] =>
  EVALS_TRAIN_SHARES.map((train) =>
    evalsCaseSplit(caseCount, [train, (1 - train) * (1 - testShare), (1 - train) * testShare])
  )
    .filter(({ train, validation }) => train > 0 && validation > 0)
    .filter((split, index, choices) => choices.findIndex((choice) => sameCaseSplit(choice, split)) === index)

export const evalsValidatedFinalists = (finalists: number, pareto: boolean): number =>
  pareto ? Math.max(finalists, PARETO_MIN_FINALISTS) : finalists

export const evalsSplitShares = (split: CaseSplit): EvalsSplitShares => {
  const total = split.train + split.validation + split.test
  if (total === 0) return EVALS_OPTIMIZE_DEFAULTS.split
  return [split.train / total, split.validation / total, split.test / total]
}

const rangeOf = (values: readonly number[]): UsageRange => ({ low: Math.min(...values), high: Math.max(...values) })

const usageEstimate = (rollouts: number, { experiment, runs }: EvalsUsageProfile): UsageEstimate => ({
  tokens: rangeOf(runs.map((run) => (run.tokens / run.rollouts) * rollouts)),
  seconds: rangeOf(runs.map((run) => (run.seconds / run.rollouts) * rollouts)),
  basedOn: { experiment, runs: runs.length },
})

// Each end-phase arm also holds back rerunPasses x ceil(5% of its trials) for re-runs (optimization/setup/budget.py).
const RERUN_PERCENT = 5

const endPhaseReserve = (arms: number, trials: number, rerunPasses: number): number =>
  arms * (trials + rerunPasses * Math.ceil((trials * RERUN_PERCENT) / 100))

// The candidates each check scores: the finalists and your agent on validation, and two on test unless it is a Pareto front.
const endPhaseArms = (
  finalists: number = EVALS_DECISION_DEFAULTS.finalists,
  pareto = false
): { validated: number; tested: number } => {
  const validated = evalsValidatedFinalists(finalists, pareto) + 1
  return { validated, tested: pareto ? validated : TESTED_WITHOUT_PARETO }
}

type EvalsRolloutShape = Omit<EvalsRolloutPlan, 'evaluators' | 'profile'>

/** The rollouts of each part of a run: your agent and every candidate on the train cases, then the two checks. */
export const evalsRolloutPhases = ({
  split: { train, validation, test },
  repetitions,
  iterations,
  width,
  finalists,
  pareto,
}: EvalsRolloutShape): EvalsRolloutPhases => {
  const { validated, tested } = endPhaseArms(finalists, pareto)
  return {
    search: repetitions * (train + iterations * width * train),
    validation: repetitions * validated * validation,
    test: repetitions * tested * test,
  }
}

/** The rollouts the optimizer checks --max-rollouts against: the run plus each end-phase arm's re-run headroom. */
export const evalsRolloutReserve = ({
  rerunPasses = EVALS_OPTIMIZE_DEFAULTS.rerunPasses,
  ...plan
}: EvalsRolloutShape): number => {
  const { validated, tested } = endPhaseArms(plan.finalists, plan.pareto)
  return (
    evalsRolloutPhases(plan).search +
    endPhaseReserve(validated, plan.repetitions * plan.split.validation, rerunPasses) +
    endPhaseReserve(tested, plan.repetitions * plan.split.test, rerunPasses)
  )
}

/** Why the optimizer would refuse the split's case counts, before the run starts. */
export const evalsSplitProblem = ({ train, validation, test }: CaseSplit): string | undefined =>
  train < 1 || validation < 1
    ? `The split leaves ${plural(train, 'train case')} and ${plural(validation, 'validation case')} of ${train + validation + test}; the optimizer needs at least 1 of each. Raise the train or validation share, or add cases.`
    : undefined

export const evalsRolloutEstimate = ({ evaluators, profile, ...plan }: EvalsRolloutPlan): EvalsRolloutEstimate => {
  const { search, validation, test } = evalsRolloutPhases(plan)
  const rollouts = search + validation + test
  return {
    rollouts,
    judgeCalls: rollouts * evaluators,
    ...(profile && profile.runs.length > 0 ? { usage: usageEstimate(rollouts, profile) } : {}),
  }
}

export const evalsSharesProblem = ([train, validation, test]: EvalsSplitShares): string | undefined => {
  if ([train, validation, test].some((share) => !(share >= 0 && share <= 1)) || train <= 0 || validation <= 0)
    return 'Each split share must be from 0 to 1, and the train and validation shares must be more than 0.'
  if (Math.abs(train + validation + test - 1) > SHARE_TOLERANCE) return 'The three split shares must add up to 1.'
  return undefined
}

const hasTest = ([, , test]: EvalsSplitShares): boolean => test > 0

const isHealthy = ({ train, validation, test }: CaseSplit, shares: EvalsSplitShares): boolean =>
  train > 0 && validation >= MINIMUM_HELD_OUT_CASES && (!hasTest(shares) || test >= MINIMUM_HELD_OUT_CASES)

const heldOutText = ({ validation, test }: CaseSplit, shares: EvalsSplitShares): string =>
  hasTest(shares)
    ? `${plural(validation, 'validation case')} and ${plural(test, 'test case')}`
    : plural(validation, 'validation case')

const casesUntil = (
  caseCount: number,
  split: EvalsSplitShares,
  enough: (parts: CaseSplit) => boolean
): number | undefined =>
  Array.from({ length: CASE_SEARCH_LIMIT }, (_, extra) => caseCount + extra + 1).find((count) =>
    enough(evalsCaseSplit(count, split))
  )

const casesToAdd = (caseCount: number, split: EvalsSplitShares): string => {
  const needed = casesUntil(caseCount, split, (parts) => isHealthy(parts, split))
  return needed === undefined
    ? 'Give the validation and test shares more of the cases.'
    : `Add ${plural(needed - caseCount, 'more case')}.`
}

const wideTestNote = (caseCount: number, { test }: CaseSplit, split: EvalsSplitShares): string | undefined => {
  if (!hasTest(split) || test > MAXIMUM_WIDE_TEST_CASES) return undefined
  const needed = casesUntil(caseCount, split, (parts) => parts.test > MAXIMUM_WIDE_TEST_CASES)
  const narrower = needed === undefined ? '' : ` Add ${plural(needed - caseCount, 'more case')} to narrow it.`
  return `The split leaves ${plural(test, 'test case')}, so the interval of the test check will be wide.${narrower}`
}

const singleTrainNote = ({ train }: CaseSplit): string | undefined =>
  train === 1
    ? 'The split leaves 1 train case, so the score model cannot tell the cases apart, and the effects are less certain.'
    : undefined

export const evalsOptimizeWarning = (
  caseCount: number,
  split: EvalsSplitShares = EVALS_OPTIMIZE_DEFAULTS.split
): string | undefined => {
  const problem = evalsSharesProblem(split)
  if (problem) return `${problem} The optimizer refuses other shares.`
  const parts = evalsCaseSplit(caseCount, split)
  if (caseCount === 0) return `The experiment has no cases, so the optimizer refuses to run. ${casesToAdd(0, split)}`
  if (parts.train === 0)
    return `This split leaves no train cases, so the optimizer refuses to run. ${casesToAdd(caseCount, split)}`
  if (!isHealthy(parts, split))
    return `The split leaves ${heldOutText(parts, split)}, so the scores can be luck. ${casesToAdd(caseCount, split)}`
  const notes = [singleTrainNote(parts), wideTestNote(caseCount, parts, split)].filter((note) => note !== undefined)
  return notes.length > 0 ? notes.join(' ') : undefined
}
