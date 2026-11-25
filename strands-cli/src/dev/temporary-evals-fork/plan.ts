import {
  sameCaseSplit,
  type CaseSplit,
  type DecisionChoices,
  type OptimizeDecision,
  type PickRule,
  type UsageEstimate,
  type UsageRange,
} from '../panels/model.js'
import { plural } from './host.js'
import type { TemporaryRolloutPhases, TemporaryUsageProfile } from './study.js'

export type TemporarySplitShares = readonly [train: number, validation: number, test: number]

export interface TemporaryOptimizeSettings {
  readonly split: TemporarySplitShares
  readonly repetitions: number
  readonly width: number
  readonly iterations: number
  readonly concurrency: number
  readonly maxRollouts: number
  readonly seed: number
  readonly decision: OptimizeDecision
}

interface TemporaryRolloutPlan {
  readonly split: CaseSplit
  readonly repetitions: number
  readonly iterations: number
  readonly width: number
  readonly evaluators: number
  readonly finalists?: number
  readonly pareto?: boolean
  readonly profile?: TemporaryUsageProfile
}

interface TemporaryRolloutEstimate {
  readonly rollouts: number
  readonly judgeCalls: number
  readonly usage?: UsageEstimate
}

export const TEMPORARY_DECISION_DEFAULTS: OptimizeDecision = {
  feasibility: 0.9,
  crashScore: 'worst',
  pickRule: 'mean',
  finalists: 3,
}

export const TEMPORARY_DECISION_CHOICES: DecisionChoices = {
  feasibility: [0.8, 0.9, 0.95, 0.99],
  crashScore: ['worst', 'none'],
  pickRule: ['mean', 'lower-bound-25', 'lower-bound-10'],
}

export const TEMPORARY_PICK_QUANTILES: Readonly<Record<Exclude<PickRule, 'mean'>, number>> = {
  'lower-bound-25': 0.25,
  'lower-bound-10': 0.1,
}

export const TEMPORARY_OPTIMIZE_DEFAULTS: TemporaryOptimizeSettings = {
  split: [0.5, 0.25, 0.25],
  repetitions: 1,
  width: 4,
  iterations: 4,
  concurrency: 4,
  maxRollouts: 500,
  seed: 0,
  decision: TEMPORARY_DECISION_DEFAULTS,
}

// The optimizer takes any whole number from these: 0 steps measures only the baseline (optimizer.py, budget.py).
export const TEMPORARY_BUDGET_MINIMUMS = { iterations: 0, width: 1, repetitions: 1, workers: 1, finalists: 1 } as const

export type TemporaryBudgetSetting = keyof typeof TEMPORARY_BUDGET_MINIMUMS

export const isTemporaryBudgetValue = (setting: TemporaryBudgetSetting, value: number): boolean =>
  Number.isSafeInteger(value) && value >= TEMPORARY_BUDGET_MINIMUMS[setting]

const TEMPORARY_ROLLOUT_CAP = 500

export const temporaryRolloutCapProblem = (rollouts: number): string | undefined =>
  rollouts > TEMPORARY_ROLLOUT_CAP
    ? `Needs about ${rollouts} rollouts, but one run can use ${TEMPORARY_ROLLOUT_CAP}. Lower the steps, candidates, or runs.`
    : undefined

const TEMPORARY_TRAIN_SHARES: readonly number[] = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]

export const TEMPORARY_TEST_SHARES: readonly number[] = [1 / 2, 1 / 3, 0]

const PARETO_MIN_FINALISTS = 5
const TESTED_WITHOUT_PARETO = 2
const MINIMUM_HELD_OUT_CASES = 2
const MAXIMUM_WIDE_TEST_CASES = 4
const SHARE_TOLERANCE = 1e-9
const CASE_SEARCH_LIMIT = 1000

export const temporaryCaseSplit = (
  caseCount: number,
  split: TemporarySplitShares = TEMPORARY_OPTIMIZE_DEFAULTS.split
): CaseSplit => {
  const exact = split.map((share) => share * caseCount)
  const floors = exact.map((value) => Math.floor(value))
  const remainder = (index: number): number => exact[index]! - floors[index]!
  const short = caseCount - floors.reduce((sum, count) => sum + count, 0)
  const topped = new Set([0, 1, 2].sort((a, b) => remainder(b) - remainder(a)).slice(0, short))
  const [train = 0, validation = 0, test = 0] = floors.map((count, index) => (topped.has(index) ? count + 1 : count))
  return { train, validation, test }
}

export const temporarySplitChoices = (caseCount: number, testShare = TEMPORARY_TEST_SHARES[0]!): CaseSplit[] =>
  TEMPORARY_TRAIN_SHARES.map((train) =>
    temporaryCaseSplit(caseCount, [train, (1 - train) * (1 - testShare), (1 - train) * testShare])
  )
    .filter(({ train, validation }) => train > 0 && validation > 0)
    .filter((split, index, choices) => choices.findIndex((choice) => sameCaseSplit(choice, split)) === index)

export const temporaryValidatedFinalists = (finalists: number, pareto: boolean): number =>
  pareto ? Math.max(finalists, PARETO_MIN_FINALISTS) : finalists

export const temporarySplitShares = (split: CaseSplit): TemporarySplitShares => {
  const total = split.train + split.validation + split.test
  if (total === 0) return TEMPORARY_OPTIMIZE_DEFAULTS.split
  return [split.train / total, split.validation / total, split.test / total]
}

const rangeOf = (values: readonly number[]): UsageRange => ({ low: Math.min(...values), high: Math.max(...values) })

const usageEstimate = (rollouts: number, { experiment, runs }: TemporaryUsageProfile): UsageEstimate => ({
  tokens: rangeOf(runs.map((run) => (run.tokens / run.rollouts) * rollouts)),
  seconds: rangeOf(runs.map((run) => (run.seconds / run.rollouts) * rollouts)),
  basedOn: { experiment, runs: runs.length },
})

/** The rollouts of each part of a run: your agent and every candidate on the train cases, then the two checks. */
export const temporaryRolloutPhases = ({
  split: { train, validation, test },
  repetitions,
  iterations,
  width,
  finalists = TEMPORARY_DECISION_DEFAULTS.finalists,
  pareto = false,
}: Omit<TemporaryRolloutPlan, 'evaluators' | 'profile'>): TemporaryRolloutPhases => {
  const validated = temporaryValidatedFinalists(finalists, pareto) + 1
  const tested = pareto ? validated : TESTED_WITHOUT_PARETO
  return {
    search: repetitions * (train + iterations * width * train),
    validation: repetitions * validated * validation,
    test: repetitions * tested * test,
  }
}

export const temporaryRolloutEstimate = ({
  evaluators,
  profile,
  ...plan
}: TemporaryRolloutPlan): TemporaryRolloutEstimate => {
  const { search, validation, test } = temporaryRolloutPhases(plan)
  const rollouts = search + validation + test
  return {
    rollouts,
    judgeCalls: rollouts * evaluators,
    ...(profile && profile.runs.length > 0 ? { usage: usageEstimate(rollouts, profile) } : {}),
  }
}

const sharesProblem = ([train, validation, test]: TemporarySplitShares): string | undefined => {
  if ([train, validation, test].some((share) => !(share >= 0 && share <= 1)) || train <= 0)
    return 'Each split share must be from 0 to 1, and the train share must be more than 0.'
  if (Math.abs(train + validation + test - 1) > SHARE_TOLERANCE) return 'The three split shares must add up to 1.'
  return undefined
}

const hasTest = ([, , test]: TemporarySplitShares): boolean => test > 0

const isHealthy = ({ train, validation, test }: CaseSplit, shares: TemporarySplitShares): boolean =>
  train > 0 && validation >= MINIMUM_HELD_OUT_CASES && (!hasTest(shares) || test >= MINIMUM_HELD_OUT_CASES)

const heldOutText = ({ validation, test }: CaseSplit, shares: TemporarySplitShares): string =>
  hasTest(shares)
    ? `${plural(validation, 'validation case')} and ${plural(test, 'test case')}`
    : plural(validation, 'validation case')

const casesUntil = (
  caseCount: number,
  split: TemporarySplitShares,
  enough: (parts: CaseSplit) => boolean
): number | undefined =>
  Array.from({ length: CASE_SEARCH_LIMIT }, (_, extra) => caseCount + extra + 1).find((count) =>
    enough(temporaryCaseSplit(count, split))
  )

const casesToAdd = (caseCount: number, split: TemporarySplitShares): string => {
  const needed = casesUntil(caseCount, split, (parts) => isHealthy(parts, split))
  return needed === undefined
    ? 'Give the validation and test shares more of the cases.'
    : `Add ${plural(needed - caseCount, 'more case')}.`
}

const wideTestNote = (caseCount: number, { test }: CaseSplit, split: TemporarySplitShares): string | undefined => {
  if (!hasTest(split) || test > MAXIMUM_WIDE_TEST_CASES) return undefined
  const needed = casesUntil(caseCount, split, (parts) => parts.test > MAXIMUM_WIDE_TEST_CASES)
  const narrower = needed === undefined ? '' : ` Add ${plural(needed - caseCount, 'more case')} to narrow it.`
  return `The split leaves ${plural(test, 'test case')}, so the interval of the test check will be wide.${narrower}`
}

const singleTrainNote = ({ train }: CaseSplit): string | undefined =>
  train === 1
    ? 'The split leaves 1 train case, so the score model cannot tell the cases apart, and the effects are less certain.'
    : undefined

export const temporaryOptimizeWarning = (
  caseCount: number,
  split: TemporarySplitShares = TEMPORARY_OPTIMIZE_DEFAULTS.split
): string | undefined => {
  const problem = sharesProblem(split)
  if (problem) return `${problem} The optimizer refuses other shares.`
  const parts = temporaryCaseSplit(caseCount, split)
  if (caseCount === 0) return `The experiment has no cases, so the optimizer refuses to run. ${casesToAdd(0, split)}`
  if (parts.train === 0)
    return `This split leaves no train cases, so the optimizer refuses to run. ${casesToAdd(caseCount, split)}`
  if (!isHealthy(parts, split))
    return `The split leaves ${heldOutText(parts, split)}, so the scores can be luck. ${casesToAdd(caseCount, split)}`
  const notes = [singleTrainNote(parts), wideTestNote(caseCount, parts, split)].filter((note) => note !== undefined)
  return notes.length > 0 ? notes.join(' ') : undefined
}
