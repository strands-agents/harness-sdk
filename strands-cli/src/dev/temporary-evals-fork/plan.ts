import { sameCaseSplit, type CaseSplit, type UsageEstimate, type UsageRange } from '../panels/model.js'
import type { TemporaryUsageProfile } from './study.js'

export type TemporarySplitShares = readonly [train: number, validation: number, test: number]

export interface TemporaryOptimizeSettings {
  readonly split: TemporarySplitShares
  readonly repetitions: number
  readonly width: number
  readonly iterations: number
  readonly concurrency: number
  readonly maxRollouts: number
  readonly seed: number
}

export interface TemporaryRolloutPlan {
  readonly split: CaseSplit
  readonly repetitions: number
  readonly iterations: number
  readonly width: number
  readonly evaluators: number
  readonly profile?: TemporaryUsageProfile
}

export interface TemporaryRolloutEstimate {
  readonly rollouts: number
  readonly judgeCalls: number
  readonly usage?: UsageEstimate
}

export const TEMPORARY_OPTIMIZE_DEFAULTS: TemporaryOptimizeSettings = {
  split: [0.5, 0.25, 0.25],
  repetitions: 1,
  width: 4,
  iterations: 4,
  concurrency: 4,
  maxRollouts: 500,
  seed: 0,
}

export const TEMPORARY_ITERATION_CHOICES: readonly number[] = [1, 2, 4, 6, 8]

export const TEMPORARY_REPETITION_CHOICES: readonly number[] = [1, 2, 3, 5]

export const TEMPORARY_WIDTH_CHOICES: readonly number[] = [2, 4, 6, 8]

export const TEMPORARY_WORKER_CHOICES: readonly number[] = [1, 2, 4, 8, 16]

export const TEMPORARY_ROLLOUT_CAP = 500

export const temporaryRolloutCapProblem = (rollouts: number): string | undefined =>
  rollouts > TEMPORARY_ROLLOUT_CAP
    ? `Needs about ${rollouts} rollouts, but one run can use ${TEMPORARY_ROLLOUT_CAP}. Lower the steps, candidates, or runs.`
    : undefined

export const TEMPORARY_TRAIN_SHARES: readonly number[] = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]

const VALIDATED_CANDIDATES = 4
const TESTED_CANDIDATES = 2
const MINIMUM_HELD_OUT_CASES = 2
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

export const temporarySplitChoices = (caseCount: number): CaseSplit[] =>
  TEMPORARY_TRAIN_SHARES.map((train) => temporaryCaseSplit(caseCount, [train, (1 - train) / 2, (1 - train) / 2]))
    .filter(({ train, validation }) => train > 0 && validation > 0)
    .filter((split, index, choices) => choices.findIndex((choice) => sameCaseSplit(choice, split)) === index)

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

export const temporaryRolloutEstimate = ({
  split: { train, validation, test },
  repetitions,
  iterations,
  width,
  evaluators,
  profile,
}: TemporaryRolloutPlan): TemporaryRolloutEstimate => {
  const rollouts =
    repetitions * (train + iterations * width * train + VALIDATED_CANDIDATES * validation + TESTED_CANDIDATES * test)
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

const isHealthy = ({ train, validation, test }: CaseSplit): boolean =>
  train > 0 && validation >= MINIMUM_HELD_OUT_CASES && test >= MINIMUM_HELD_OUT_CASES

const counted = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

const casesToAdd = (caseCount: number, split: TemporarySplitShares): string => {
  const needed = Array.from({ length: CASE_SEARCH_LIMIT }, (_, extra) => caseCount + extra + 1).find((count) =>
    isHealthy(temporaryCaseSplit(count, split))
  )
  return needed === undefined
    ? 'Give the validation and test shares more of the cases.'
    : `Add ${counted(needed - caseCount, 'more case')}.`
}

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
  if (isHealthy(parts)) return undefined
  return (
    `The split leaves ${counted(parts.validation, 'validation case')} and ${counted(parts.test, 'test case')}, ` +
    `so the scores can be luck. ${casesToAdd(caseCount, split)}`
  )
}
