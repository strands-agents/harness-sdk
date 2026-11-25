import { existsSync, watch, type FSWatcher } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { errorMessage } from '../../../terminal/text.js'
import type { DevChatJob, DevChatNotice } from '../../../ui/chat/types.js'
import { recordDevEvent } from '../../telemetry.js'
import { isRecord } from '../../../values.js'
import { editAgentOptions } from '../../agent-options.js'
import { baseCliEditProblem, editBaseCliProfile, isProfileBaseCli } from '../../base-cli.js'
import type { DevWorkspace } from '../../workspace.js'
import { userConfigPath } from '../../../config/store.js'
import {
  type ExperimentSummary,
  type DecisionSetting,
  type KnobKey,
  type OptimizeDecision,
  type OptimizeObjective,
  type OptimizePage,
  type OptimizePlan,
  type OptimizeProgress,
  type OptimizeReview,
  type OptimizeRunState,
  type OptimizeState,
  type ProposedEdit,
  type TestCheck,
} from '../model.js'
import { locateEvalsEdit, type EvalsEditLocation, type EvalsEditTarget } from '../tuning/apply.js'
import {
  dropEvalsOptimizeRecord,
  isEvalsOptimizeAlive,
  readEvalsOptimizeRecords,
  saveEvalsOptimizeRecord,
  waitForEvalsOptimize,
  type EvalsOptimizeRecord,
} from '../runs/background-runs.js'
import { evalsWorkspaceDirectory } from '../runs/evals-process.js'
import {
  evalsExperimentHome,
  evalsOptimizationFiles,
  evalsOptimizationOf,
  evalsOptimizationRunName,
  evalsRunStamp,
} from '../layout.js'
import { evalsWorkspaceReady } from '../runs/layout-migration.js'
import { readEvalsExperimentFile, evalsCaseCount, evalsJudgeEvaluatorCount } from '../runs/experiment.js'
import { EvalsExperiments } from './experiments-session.js'
import { announce, plural, evalsLinkText, type EvalsHost } from '../host.js'
import { Store, type EvalsTail } from '../jobs.js'
import {
  readEvalsKnobs,
  evalsKnobChanges,
  evalsSpaceVariables,
  type EvalsKnob,
  type EvalsKnobChange,
  type EvalsSpaceVariable,
} from '../tuning/knobs.js'
import { checkEvalsObjective, isEvalsPareto, evalsObjectivePresets, EVALS_USAGE_METRICS } from '../tuning/objective.js'
import { runEvalsOptimization } from '../runs/optimize.js'
import {
  EVALS_DECISION_CHOICES,
  EVALS_DECISION_DEFAULTS,
  isEvalsBudgetValue,
  evalsRolloutCapProblem,
  EVALS_TEST_SHARES,
  EVALS_OPTIMIZE_DEFAULTS,
  evalsCaseSplit,
  evalsOptimizeWarning,
  evalsRolloutEstimate,
  evalsRolloutPhases,
  evalsSplitChoices,
  evalsSplitShares,
} from '../tuning/plan.js'
import {
  hasEvalsRunResult,
  readEvalsStudy,
  readEvalsUsageProfile,
  tailEvalsRun,
  evalsRunFolder,
  evalsStudyReader,
  type EvalsUsageProfile,
  type EvalsMeasurement,
  type EvalsRolloutPhases,
  type EvalsStudyOutcome,
  type EvalsTestDifference,
} from '../tuning/study.js'

export interface EvalsAppliedChange {
  readonly run: string
  readonly experiment: string
  readonly appliedAt: number
  readonly baseline: number
  readonly best: number
  readonly measuredOn: string
  readonly testCheck?: TestCheck
  readonly edits: readonly ProposedEdit[]
  readonly error?: string
  /** Auto-accept wrote these edits as the run ended: the developer did not see them first. */
  readonly auto?: boolean
}

const DEFAULT_ITERATIONS = 4

const SOURCE_SETTLE_MS = 300

const RELOAD_WINDOW_MS = 15_000

// Auto-accept writes as the agent starts reporting the run, and the reload waits for that turn to end.
const AUTO_RELOAD_WINDOW_MS = 120_000

const WIDTH = 4

const REPETITIONS = 1

const WORKERS = 4

type RunPlan = Pick<
  OptimizePlan,
  'experiment' | 'iterations' | 'width' | 'repetitions' | 'workers' | 'split' | 'decision'
> & {
  readonly objective?: OptimizeObjective
}

const NO_OBJECTIVE: OptimizeObjective = { expression: '', constraints: '' }

const objectiveFields = (
  objective: OptimizeObjective,
  evaluators: readonly string[]
): Pick<OptimizePlan, 'objective' | 'objectiveProblem' | 'objectiveWarning'> => {
  const { problem, warning } = checkEvalsObjective(objective, evaluators)
  return {
    objective,
    ...(problem ? { objectiveProblem: problem } : {}),
    ...(warning ? { objectiveWarning: warning } : {}),
  }
}

const MEASURED_ON: Record<EvalsMeasurement, string> = {
  search: 'training cases',
  validation: 'validation cases',
  test: 'test cases',
}

/** The writable edits of a finished run that still wait for the developer's yes or no. */
export const evalsEditsAwaitingAnswer = ({ reviewed, edits = [] }: OptimizeReview): number =>
  reviewed ? 0 : edits.filter(({ unavailable, decided }) => unavailable === undefined && !decided).length

const editsToReview = (state: OptimizeRunState): number =>
  state.step === 'review' ? evalsEditsAwaitingAnswer(state.review) : 0

const BEST_DIFF = 'best.diff'

const unwritableEdits = (state: OptimizeRunState, folder: string | undefined): string | undefined => {
  const edits = state.step === 'review' ? state.review.edits.filter(({ unavailable }) => unavailable !== undefined) : []
  if (edits.length === 0) return undefined
  const reasons = edits.map(({ label, unavailable }) => `${label}: ${unavailable}`).join(' · ')
  const diff = folder === undefined ? undefined : join(folder, BEST_DIFF)
  const text = diff !== undefined && existsSync(diff) ? ` · its text is in ${diff}` : ''
  return `strands dev cannot write ${plural(edits.length, 'edit')} (${reasons})${text}`
}

/** Whether the run has an edit waiting for the developer's answer. */
export const evalsRunAwaitsReview = ({ runs = [] }: OptimizeState, id: string): boolean =>
  runs.some((run) => run.id === id && editsToReview(run.state) > 0)

/** A finished run stays listed while an edit of it waits for an answer on screen; with nothing waiting, it goes. */
export const evalsOptimizeJobs = ({ runs = [] }: OptimizeState): DevChatJob[] =>
  runs.flatMap(({ id, state }) => {
    if (state.step === 'running') {
      // The whole run in rollouts, so the count is full only when the finalists and the test have run too.
      const { done, total } = state.progress.rollouts
      return [{ id, label: state.progress.run, done, total }]
    }
    const edits = editsToReview(state)
    return edits > 0 && state.step === 'review'
      ? [{ id, label: `${state.review.run} · ${edits} to review`, done: 1, total: 1, waiting: true }]
      : []
  })

/** Every edit the screen would have offered, answered with apply: what auto-accept does in the developer's place. */
const autoAnswered = (review: OptimizeReview): OptimizeReview => ({
  ...review,
  auto: true,
  edits: review.edits.map((edit) =>
    edit.unavailable === undefined ? { ...edit, accepted: true, decided: true } : edit
  ),
})

interface RunEntry {
  readonly id: string
  readonly experiment: string
  readonly startedAt: number
  state: OptimizeRunState
  record?: string
  abort: AbortController | undefined
  stopping: boolean
  writers: Map<number, EvalsEditTarget['write']>
  changes: readonly EvalsKnobChange[]
  sources: FSWatcher | undefined
  /** The notice that a review came back with strands dev, kept so it stops asking once the review is over. */
  reminder?: DevChatNotice | undefined
}

/** The rollouts the plan allows in each part of the run: the same numbers its estimate adds up. */
const plannedRollouts = (plan: RunPlan): EvalsRolloutPhases =>
  evalsRolloutPhases({
    split: plan.split,
    repetitions: plan.repetitions,
    iterations: plan.iterations,
    width: plan.width,
    finalists: plan.decision.finalists,
    pareto: isEvalsPareto(plan.objective ?? NO_OBJECTIVE),
  })

const startingProgress = (plan: RunPlan): OptimizeProgress => {
  const { search, validation, test } = plannedRollouts(plan)
  return {
    run: 'starting',
    record: '',
    planned: 1 + plan.iterations * plan.width,
    tried: 0,
    rollouts: { done: 0, total: search + validation + test },
  }
}

const sentence = (text: string): string => (/[.!?]$/u.test(text.trim()) ? text.trim() : `${text.trim()}.`)

const testCheck = (test: EvalsTestDifference | undefined): TestCheck | undefined =>
  test && {
    difference: test.difference,
    cases: test.cases,
    confidence: test.confidence,
    ...(test.ci ? { range: test.ci } : {}),
  }

const locateBaseCliEdit = (workspace: DevWorkspace, change: EvalsKnobChange): EvalsEditLocation => {
  const edit =
    change.knob.key === 'instructions'
      ? { option: 'instructions', value: change.after, expected: change.before }
      : (change.edit ?? { option: change.knob.option, value: change.after, expected: change.before })
  const problem = baseCliEditProblem(edit)
  if (problem) return { unavailable: problem }
  return {
    target: userConfigPath(),
    write: async (): Promise<void> => {
      await editBaseCliProfile(workspace, [edit])
    },
  }
}

export class EvalsOptimize extends Store<OptimizeState> {
  private evaluators = 1
  private usageProfile: EvalsUsageProfile | undefined
  private evaluatorNames: readonly string[] = []
  private resumed: Promise<void> | undefined
  private carried: { status: 'success' | 'error'; text: string; at: number; lasts: number } | undefined
  private catalog: readonly EvalsKnob[] = []
  private page: OptimizePage = { step: 'pick' }
  private shown: string | undefined
  private readonly entries = new Map<string, RunEntry>()
  private runCount = 0
  private readonly changes: EvalsAppliedChange[] = []

  constructor(
    private readonly host: EvalsHost,
    readonly experiments: EvalsExperiments
  ) {
    super({ step: 'pick', runs: [] })
  }

  plan(experiment: ExperimentSummary): void {
    void this.planFor(experiment)
  }

  reset(): void {
    this.showPage({ step: 'pick' })
    this.experiments.refresh()
  }

  toggleKnob(key: KnobKey): void {
    this.updatePlan((plan) => ({
      ...plan,
      knobs: plan.knobs.map((knob) => {
        if (knob.key !== key || knob.unavailable) return knob
        if (knob.kind === 'models' && !knob.enabled && (plan.models?.picked.length ?? 0) === 0) return knob
        return { ...knob, enabled: !knob.enabled }
      }),
    }))
  }

  pickModel(id: string, picked: boolean): void {
    this.updatePlan((plan) => {
      if (!plan.models || id === plan.models.current) return plan
      const others = picked
        ? [...new Set([...plan.models.picked, id])]
        : plan.models.picked.filter((model) => model !== id)
      return {
        ...plan,
        models: { ...plan.models, picked: others },
        knobs: plan.knobs.map((knob) =>
          knob.kind === 'models'
            ? {
                ...knob,
                enabled: others.length > 0,
                detail: others.length > 0 ? `${plural(others.length, 'other model')} to try` : 'choose models to try',
              }
            : knob
        ),
      }
    })
  }

  setIterations(iterations: number): void {
    this.updatePlan((plan) =>
      isEvalsBudgetValue('iterations', iterations) ? this.estimate({ ...plan, iterations }) : plan
    )
  }

  setRepetitions(repetitions: number): void {
    this.updatePlan((plan) =>
      isEvalsBudgetValue('repetitions', repetitions) ? this.estimate({ ...plan, repetitions }) : plan
    )
  }

  setWidth(width: number): void {
    this.updatePlan((plan) => (isEvalsBudgetValue('width', width) ? this.estimate({ ...plan, width }) : plan))
  }

  setWorkers(workers: number): void {
    this.updatePlan((plan) => (isEvalsBudgetValue('workers', workers) ? { ...plan, workers } : plan))
  }

  setObjective(objective: OptimizeObjective): void {
    this.updatePlan(({ objectiveProblem: _problem, objectiveWarning: _warning, ...plan }) =>
      this.estimate({ ...plan, ...objectiveFields(objective, this.evaluatorNames) })
    )
  }

  setDecision<Setting extends keyof OptimizeDecision>(setting: Setting, value: OptimizeDecision[Setting]): void {
    this.updatePlan((plan) =>
      (
        setting === 'finalists'
          ? isEvalsBudgetValue('finalists', value as number)
          : (plan.decisionChoices[setting as DecisionSetting] as readonly unknown[]).includes(value)
      )
        ? this.estimate({ ...plan, decision: { ...plan.decision, [setting]: value } })
        : plan
    )
  }

  start(): string | undefined {
    const page = this.page
    if (page.step !== 'setup' || page.plan.objectiveProblem || page.plan.budgetProblem) return undefined
    const knobs = this.catalog.map((knob) => ({
      ...knob,
      enabled: page.plan.knobs.find(({ key }) => key === knob.key)?.enabled ?? false,
    }))
    const variables = evalsSpaceVariables(knobs, page.plan.models?.picked ?? [])
    if (variables.length === 0) return undefined
    const startedAt = Date.now()
    const entry = this.addRun(page.plan.experiment.name, startedAt, {
      step: 'running',
      progress: startingProgress(page.plan),
    })
    this.showPage(entry.state, entry.id)
    recordDevEvent('optimize_run_started')
    void this.run(entry, page.plan, knobs, variables)
    return entry.id
  }

  stop(id?: string): void {
    const entry = this.entries.get(id ?? this.shown ?? '')
    if (entry?.state.step !== 'running' || !entry.abort || entry.stopping) return
    entry.stopping = true
    entry.abort.abort()
  }

  accept(index: number, accepted: boolean, run?: string): void {
    const entry = this.reviewedEntry(run)
    if (entry?.state.step !== 'review' || entry.state.review.applied) return
    if (entry.state.review.edits[index]?.unavailable) {
      if (accepted) void this.recheck(entry, true, index)
      return
    }
    if (!entry.writers.has(index)) return
    const { review } = entry.state
    this.updateRun(entry, {
      step: 'review',
      review: {
        ...review,
        edits: review.edits.map((edit, position) => (position === index ? { ...edit, accepted, decided: true } : edit)),
      },
    })
  }

  apply(run?: string): void {
    const entry = this.reviewedEntry(run)
    if (entry) void this.applyAccepted(entry)
  }

  autoApplies(): boolean {
    return this.host().settings?.().autoAcceptOptimizationResults ?? false
  }

  finishReview(id: string): void {
    const entry = this.entries.get(id)
    if (entry?.state.step !== 'review') return
    this.updateRun(entry, { step: 'review', review: { ...entry.state.review, reviewed: true } })
    this.settleReview(entry)
  }

  leaveReview(id: string): void {
    const entry = this.entries.get(id)
    if (entry?.state.step !== 'review' || entry.state.review.reviewed) return
    const offered = entry.state.review.edits.filter(({ unavailable }) => unavailable === undefined)
    const answered = offered.filter(({ decided }) => decided).length
    // With one edit the status line says it all. With several, say where the answers given so far went.
    if (answered === 0 || answered === offered.length) return
    announce(
      this.host(),
      'success',
      `optimize · run ${entry.state.review.run} · ${answered} of ${offered.length} edits answered · nothing is written until all are · ↓ Enter`
    )
  }

  /** Called with a run whose review is over, however it ended, so a question still on screen about it can go. */
  onSettled: ((id: string) => void) | undefined

  /** Nothing of the run waits on the developer any more: its record goes, and so does a question still asking. */
  private settleReview(entry: RunEntry): void {
    if (entry.record) void dropEvalsOptimizeRecord({ record: entry.record }).catch(() => undefined)
    if (entry.record)
      entry.reminder?.update('success', `optimize · run ${evalsOptimizationRunName(entry.record)} · reviewed`)
    entry.reminder = undefined
    this.onSettled?.(entry.id)
  }

  resume(): Promise<void> {
    this.resumed ??= this.resumeRecords()
    return this.resumed
  }

  /** Says the last applied notice once to the chat that the write's reload opens, and to no later one. */
  reannounce(): void {
    const notice = this.carried
    this.carried = undefined
    if (notice && Date.now() - notice.at < notice.lasts) announce(this.host(), notice.status, notice.text)
  }

  /** Called with a run that has edits to read, so a finished run shows them rather than waiting to be found. */
  onReview: ((id: string) => void) | undefined

  /** Points accept and apply at one run without moving the panel to it. */
  focusRun(id: string): boolean {
    if (this.entries.get(id)?.state.step !== 'review') return false
    this.shown = id
    return true
  }

  appliedChanges(): readonly EvalsAppliedChange[] {
    return [...this.changes]
  }

  /** Several runs can wait for review at once, and the shown one moves as each finishes, so a walk names its own. */
  private reviewedEntry(run: string | undefined): RunEntry | undefined {
    return this.entries.get(run ?? this.shown ?? '')
  }

  private addRun(experiment: string, startedAt: number, state: OptimizeRunState): RunEntry {
    this.runCount += 1
    const entry: RunEntry = {
      id: `run-${this.runCount}`,
      experiment,
      startedAt,
      state,
      abort: undefined,
      stopping: false,
      writers: new Map(),
      changes: [],
      sources: undefined,
    }
    this.entries.set(entry.id, entry)
    return entry
  }

  private showPage(page: OptimizePage, shown?: string): void {
    this.page = page
    this.shown = shown
    this.publish()
  }

  private updateRun(entry: RunEntry, state: OptimizeRunState): void {
    entry.state = state
    if (this.shown === entry.id) this.page = state
    this.publish()
  }

  private publish(): void {
    const runs = [...this.entries.values()]
      .sort((left, right) => right.startedAt - left.startedAt)
      .map(({ id, experiment, record, state }) => ({
        id,
        experiment,
        ...(record ? { record } : {}),
        state,
      }))
    this.set({ ...this.page, runs })
  }

  private watchSources(entry: RunEntry): void {
    if (entry.sources || entry.state.step !== 'review' || !entry.state.review.edits.some((edit) => edit.unavailable))
      return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      entry.sources = watch(dirname(this.host().workspace.entrypoint), { persistent: false }, () => {
        clearTimeout(timer)
        timer = setTimeout(() => void this.recheck(entry, false), SOURCE_SETTLE_MS)
      })
      entry.sources.on('error', () => entry.sources?.close())
    } catch {
      entry.sources = undefined
    }
  }

  private async recheck(entry: RunEntry, accept: boolean, only?: number): Promise<void> {
    if (entry.state.step !== 'review' || entry.state.review.applied) return
    const indexes = entry.state.review.edits.flatMap((edit, index) =>
      edit.unavailable && (only === undefined || only === index) ? [index] : []
    )
    const located = await Promise.all(
      indexes.map(async (index) => {
        const change = entry.changes[index]
        const location = change
          ? await this.locate(change).catch((error: unknown) => ({ unavailable: errorMessage(error) }))
          : undefined
        return { index, location }
      })
    )
    if (entry.state.step !== 'review') return
    const { review } = entry.state
    const edits = review.edits.map((edit, index): ProposedEdit => {
      const location = located.find((found) => found.index === index)?.location
      if (!location || !edit.unavailable) return edit
      if (!('write' in location)) return { ...edit, unavailable: location.unavailable }
      entry.writers.set(index, location.write)
      const { unavailable: _stale, ...rest } = edit
      return { ...rest, target: location.target, accepted: accept }
    })
    if (!edits.some((edit) => edit.unavailable)) {
      entry.sources?.close()
      entry.sources = undefined
    }
    this.updateRun(entry, { step: 'review', review: { ...review, edits } })
  }

  private updatePlan(change: (plan: OptimizePlan) => OptimizePlan): void {
    if (this.page.step === 'setup') this.showPage({ step: 'setup', plan: change(this.page.plan) })
  }

  private estimate({ usage: _earlier, budgetProblem: _over, ...plan }: OptimizePlan): OptimizePlan {
    const pareto = isEvalsPareto(plan.objective)
    const { rollouts, judgeCalls, usage } = evalsRolloutEstimate({
      split: plan.split,
      repetitions: plan.repetitions,
      iterations: plan.iterations,
      width: plan.width,
      evaluators: this.evaluators,
      finalists: plan.decision.finalists,
      pareto,
      ...(this.usageProfile ? { profile: this.usageProfile } : {}),
    })
    const budgetProblem = evalsRolloutCapProblem(rollouts)
    return {
      ...plan,
      rollouts,
      judgeCalls,
      ...(usage ? { usage } : {}),
      ...(budgetProblem ? { budgetProblem } : {}),
    }
  }

  private async planFor(summary: ExperimentSummary): Promise<void> {
    try {
      const { experiment, raw } = await readEvalsExperimentFile(summary.path)
      this.catalog = await readEvalsKnobs(this.host().workspace, this.host().dependencies?.harnessDefaults)
      this.usageProfile = await readEvalsUsageProfile(this.workspaceDirectory(), summary.name).catch(() => undefined)
      const model = this.catalog.find((knob) => knob.kind === 'models' && !knob.unavailable)
      const caseCount = experiment.cases.length
      const split = evalsCaseSplit(caseCount)
      const splitChoices = evalsSplitChoices(caseCount)
      const objectivePresets = evalsObjectivePresets(experiment.evaluators)
      const warning = evalsOptimizeWarning(caseCount)
      this.evaluators = evalsJudgeEvaluatorCount(raw.evaluators)
      this.evaluatorNames = experiment.evaluators
      this.showPage({
        step: 'setup',
        plan: this.estimate({
          experiment: { ...summary, caseCount },
          knobs: this.catalog,
          ...(typeof model?.current === 'string' ? { models: { current: model.current, picked: [] } } : {}),
          ...objectiveFields(objectivePresets[0]?.objective ?? NO_OBJECTIVE, experiment.evaluators),
          objectivePresets,
          metrics: [...experiment.evaluators, ...EVALS_USAGE_METRICS],
          split,
          splitChoices,
          testShare: EVALS_TEST_SHARES[0]!,
          decision: EVALS_DECISION_DEFAULTS,
          decisionChoices: EVALS_DECISION_CHOICES,
          repetitions: REPETITIONS,
          width: WIDTH,
          workers: WORKERS,
          iterations: DEFAULT_ITERATIONS,
          rollouts: 0,
          judgeCalls: 0,
          ...(warning ? { warning } : {}),
        }),
      })
    } catch (error) {
      this.showPage({ step: 'failed', message: errorMessage(error) })
    }
  }

  private workspaceDirectory(): string {
    return evalsWorkspaceDirectory(this.host().workspace)
  }

  private async resumeRecords(): Promise<void> {
    let records: EvalsOptimizeRecord[]
    try {
      await evalsWorkspaceReady(this.workspaceDirectory())
      records = await readEvalsOptimizeRecords(this.workspaceDirectory())
    } catch (error) {
      announce(this.host(), 'error', `optimize · an unfinished run cannot be read: ${errorMessage(error)}`)
      return
    }
    const known = new Set([...this.entries.values()].map(({ record }) => record))
    await Promise.all(records.filter(({ record }) => !known.has(record)).map((saved) => this.continueRun(saved)))
  }

  private async continueRun(saved: EvalsOptimizeRecord): Promise<void> {
    let entry: RunEntry | undefined
    try {
      const plan = await this.recordedPlan(saved)
      const knobs = await this.recordedKnobs(saved)
      entry = this.addRun(plan.experiment.name, saved.startedAt, {
        step: 'running',
        progress: startingProgress(plan),
      })
      entry.record = saved.record
      this.publish()
      if (saved.awaitsReview) return await this.restoreReview(entry, saved, knobs)
      if (await isEvalsOptimizeAlive(saved)) return await this.follow(entry, plan, knobs, saved)
      if (await hasEvalsRunResult(saved.record)) {
        await this.finish(entry, saved.record, plan, knobs, false)
        return await this.keepForReview(entry, saved.record, saved)
      }
      announce(
        this.host(),
        'success',
        `optimize · ${plan.experiment.name} · resumed the run that stopped when strands dev closed`
      )
      await this.run(entry, plan, knobs, [], saved)
    } catch (error) {
      const failed: OptimizeRunState = { step: 'failed', message: errorMessage(error), record: saved.record }
      entry ??= this.addRun(basename(saved.experiment, '.json'), saved.startedAt, failed)
      entry.record = saved.record
      this.updateRun(entry, failed)
      announce(
        this.host(),
        'error',
        `optimize · ${basename(saved.experiment, '.json')} could not resume · ask the chat why`
      )
      await dropEvalsOptimizeRecord(saved)
    }
  }

  private async recordedPlan(saved: EvalsOptimizeRecord): Promise<RunPlan> {
    const caseCount = await evalsCaseCount(saved.experiment).catch(() => 0)
    return {
      experiment: { name: basename(saved.experiment, '.json'), path: saved.experiment, caseCount },
      iterations: saved.iterations,
      width: saved.width ?? WIDTH,
      repetitions: saved.repetitions ?? REPETITIONS,
      workers: saved.workers ?? WORKERS,
      split: evalsCaseSplit(caseCount, saved.split ?? EVALS_OPTIMIZE_DEFAULTS.split),
      decision: saved.decision ?? EVALS_DECISION_DEFAULTS,
      ...(saved.objective ? { objective: saved.objective } : {}),
    }
  }

  private async recordedKnobs(saved: EvalsOptimizeRecord): Promise<EvalsKnob[]> {
    const knobs = await readEvalsKnobs(this.host().workspace, this.host().dependencies?.harnessDefaults)
    const space: unknown = JSON.parse(await readFile(saved.space, 'utf8'))
    const variables = isRecord(space) && Array.isArray(space.variables) ? space.variables : []
    const options = new Set(variables.filter(isRecord).map(({ option }) => option))
    return knobs.map((knob) => ({ ...knob, enabled: options.has(knob.option) }))
  }

  private async follow(
    entry: RunEntry,
    plan: RunPlan,
    knobs: readonly EvalsKnob[],
    saved: EvalsOptimizeRecord
  ): Promise<void> {
    const abort = new AbortController()
    entry.abort = abort
    entry.stopping = false
    const tail = this.track(entry, plan, saved.record)
    try {
      await waitForEvalsOptimize(saved, abort.signal)
    } finally {
      await tail.stop()
      entry.abort = undefined
    }
    await this.finish(entry, saved.record, plan, knobs, abort.signal.aborted)
    await this.keepForReview(entry, saved.record, saved)
  }

  /** Shows the progress of the run as its record grows, until the tail is stopped. */
  private track(entry: RunEntry, plan: RunPlan, record: string): EvalsTail {
    const reader = evalsStudyReader({
      run: evalsOptimizationRunName(record),
      record,
      planned: plannedRollouts(plan),
    })
    const show = (): void =>
      this.updateRun(entry, {
        step: 'running',
        progress: { ...reader.progress(), planned: 1 + plan.iterations * plan.width },
      })
    const tail = tailEvalsRun(record, (line) => {
      reader.push(line)
      show()
    })
    show()
    return tail
  }

  private async run(
    entry: RunEntry,
    plan: RunPlan,
    knobs: readonly EvalsKnob[],
    variables: readonly EvalsSpaceVariable[],
    continuing?: EvalsOptimizeRecord
  ): Promise<void> {
    const abort = new AbortController()
    const startedAt = continuing?.startedAt ?? entry.startedAt
    const now = new Date(startedAt)
    const shares = continuing ? continuing.split : evalsSplitShares(plan.split)
    entry.abort = abort
    entry.stopping = false
    let record: string | undefined
    let cancelled = false
    let saving: Promise<void> = Promise.resolve()
    let saved: EvalsOptimizeRecord | undefined
    const remember = (next: EvalsOptimizeRecord): void => {
      saved = next
      saving = saving
        .then(() => saveEvalsOptimizeRecord(next))
        .catch((error: unknown) =>
          announce(
            this.host(),
            'error',
            `optimize · ${plan.experiment.name} · this run cannot continue after a restart: ${errorMessage(error)}`
          )
        )
    }
    let tail: EvalsTail | undefined
    this.updateRun(entry, { step: 'running', progress: startingProgress(plan) })
    try {
      const space = continuing?.space ?? (await this.writeSpace(plan, now, variables))
      await runEvalsOptimization(
        {
          workspace: this.host().workspace,
          experiment: plan.experiment.path,
          settings: {
            iterations: plan.iterations,
            width: plan.width,
            repetitions: plan.repetitions,
            concurrency: plan.workers,
            decision: plan.decision,
            ...(shares ? { split: shares } : {}),
          },
          ...(plan.objective ? { objective: plan.objective } : {}),
          space,
          now: () => now,
          background: true,
          detached: true,
          ...(continuing ? { continuing: continuing.record } : {}),
          signal: abort.signal,
          onSpawn: (pid) => {
            if (saved) remember({ ...saved, pid })
          },
          onStart: (path) => {
            record = path
            entry.record = path
            remember({
              version: 1,
              experiment: plan.experiment.path,
              record: path,
              space,
              iterations: plan.iterations,
              width: plan.width,
              repetitions: plan.repetitions,
              workers: plan.workers,
              ...(shares ? { split: shares } : {}),
              ...(plan.objective ? { objective: plan.objective } : {}),
              decision: plan.decision,
              startedAt,
            })
            tail = this.track(entry, plan, path)
          },
        },
        this.host().dependencies
      )
      await tail?.stop()
    } catch (error) {
      await tail?.stop()
      if (!entry.stopping) {
        await saving
        if (record) await dropEvalsOptimizeRecord({ record })
        this.updateRun(entry, { step: 'failed', message: errorMessage(error), ...(record ? { record } : {}) })
        announce(this.host(), 'error', `optimize · ${plan.experiment.name} stopped · ask the chat why`)
        return
      }
      cancelled = true
    } finally {
      entry.abort = undefined
    }
    await saving
    if (cancelled && !record) return this.reportCancelled(entry, plan)
    await this.finish(entry, record!, plan, knobs, cancelled)
    await this.keepForReview(entry, record!, saved)
  }

  private async writeSpace(plan: RunPlan, now: Date, variables: readonly EvalsSpaceVariable[]): Promise<string> {
    const home = evalsExperimentHome(this.workspaceDirectory(), plan.experiment.path)
    const path = evalsOptimizationFiles(home, evalsRunStamp(now)).space
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify({ variables }, null, 2)}\n`)
    return path
  }

  private async finish(
    entry: RunEntry,
    record: string,
    plan: RunPlan,
    knobs: readonly EvalsKnob[],
    cancelled: boolean
  ): Promise<void> {
    const name = evalsOptimizationRunName(record)
    let outcome: EvalsStudyOutcome
    try {
      outcome = await readEvalsStudy(record)
    } catch (error) {
      if (cancelled) return this.reportCancelled(entry, plan, record)
      this.updateRun(entry, { step: 'failed', message: errorMessage(error), record })
      announce(this.host(), 'error', `optimize · run ${name} could not be read · ask the chat why`)
      return
    }
    if (outcome.ended === 'stopped' && outcome.error && !cancelled) {
      const log = evalsOptimizationOf(record).log
      this.updateRun(entry, {
        step: 'failed',
        message: `${sentence(outcome.error)} The full optimizer output is in ${log}.`,
        record,
      })
      announce(this.host(), 'error', `optimize · run ${name} failed · ask the chat why`)
      return
    }
    // Read as the run ends; a stopped run's best version was never validated, so it is never applied unasked.
    const auto = !cancelled && outcome.ended === 'finished' && this.autoApplies()
    let ready: number
    try {
      // Only a run that produced an edit worth applying opens the review; the rest just say they finished.
      ready = await this.enterReview(entry, outcome, record, knobs, auto)
      const folder = await evalsRunFolder(record).catch(() => undefined)
      const unwritten = unwritableEdits(entry.state, folder)
      const ending =
        ready === 0
          ? unwritten === undefined
            ? 'no edits to apply'
            : undefined
          : auto
            ? `auto-accept is on · applying ${plural(ready, 'edit')}`
            : `showing ${plural(ready, 'edit')}`
      const told = [ending, unwritten].filter((part) => part !== undefined).join(' · ')
      const link = evalsLinkText(this.host(), { view: 'optimization', record }, folder)
      announce(this.host(), 'success', `optimize · run ${name} finished · ${told}${link}`)
    } catch (error) {
      if (cancelled) return this.reportCancelled(entry, plan, record)
      this.updateRun(entry, { step: 'failed', message: errorMessage(error), record })
      announce(this.host(), 'error', `optimize · run ${name} could not be read · ask the chat why`)
      return
    }
    if (ready === 0) return
    // With auto-accept the edits are answered already, so there is nothing to show: they are written here.
    if (auto) await this.applyAccepted(entry)
    else this.onReview?.(entry.id)
  }

  /** Puts a finished run in review and counts its writable edits; `auto` answers each with apply. */
  private async enterReview(
    entry: RunEntry,
    outcome: EvalsStudyOutcome,
    record: string,
    knobs: readonly EvalsKnob[],
    auto = false
  ): Promise<number> {
    const writers: RunEntry['writers'] = new Map()
    const edits: ProposedEdit[] = []
    const changes = evalsKnobChanges(knobs, outcome.baseline.params, outcome.best?.params ?? {})
    for (const change of changes) {
      const located = await this.locate(change)
      const writable = 'write' in located
      if (writable) writers.set(edits.length, located.write)
      edits.push({
        knob: change.knob.key,
        kind: change.kind,
        label: change.knob.label,
        before: change.before,
        after: change.after,
        accepted: writable,
        ...(writable ? { target: located.target } : { unavailable: located.unavailable }),
        ...(change.added ? { added: change.added } : {}),
      })
    }
    const baseline = outcome.baseline.score ?? 0
    const check = testCheck(outcome.test)
    const review: OptimizeReview = {
      run: evalsOptimizationRunName(record),
      record,
      baseline,
      best: outcome.best?.score ?? baseline,
      measuredOn: MEASURED_ON[outcome.measuredOn],
      edits,
      ...(check ? { testCheck: check } : {}),
    }
    entry.writers = writers
    entry.changes = changes
    const ready = edits.filter(({ unavailable }) => unavailable === undefined).length
    recordDevEvent('optimize_run_finished')
    this.updateRun(entry, { step: 'review', review: auto && ready > 0 ? autoAnswered(review) : review })
    this.watchSources(entry)
    return ready
  }

  /** Keeps the record of a run with an edit still to answer, so its review comes back when strands dev opens again. */
  private async keepForReview(entry: RunEntry, record: string, saved: EvalsOptimizeRecord | undefined): Promise<void> {
    if (!saved || editsToReview(entry.state) === 0) return dropEvalsOptimizeRecord({ record })
    const { pid: _ended, ...finished } = saved
    // An unmarked record reads as a run that ended while strands dev was closed, which brings its review back too.
    await saveEvalsOptimizeRecord({ ...finished, awaitsReview: true }).catch(() => undefined)
    if (editsToReview(entry.state) === 0) await dropEvalsOptimizeRecord({ record })
  }

  /** Brings back a review strands dev closed on, on the status line rather than over the new chat. */
  private async restoreReview(entry: RunEntry, saved: EvalsOptimizeRecord, knobs: readonly EvalsKnob[]): Promise<void> {
    const name = evalsOptimizationRunName(saved.record)
    const ready = await this.enterReview(entry, await readEvalsStudy(saved.record), saved.record, knobs)
    if (ready === 0) {
      announce(this.host(), 'success', `optimize · run ${name} · its edits no longer fit the agent as it is now`)
      return dropEvalsOptimizeRecord(saved)
    }
    entry.reminder = this.host().context?.report(
      'success',
      `optimize · run ${name} · ${plural(ready, 'edit')} still to review · ↓ Enter`
    )
  }

  private reportCancelled(entry: RunEntry, plan: RunPlan, record?: string): void {
    this.updateRun(entry, {
      step: 'cancelled',
      experiment: plan.experiment.name,
      ...(record ? { run: evalsOptimizationRunName(record) } : {}),
    })
    announce(this.host(), 'success', `optimize · ${plan.experiment.name} cancelled · the agent source is unchanged`)
  }

  private async locate(change: EvalsKnobChange): Promise<EvalsEditLocation> {
    const { workspace } = this.host()
    if (await isProfileBaseCli(workspace)) return locateBaseCliEdit(workspace, change)
    if (change.knob.key === 'instructions')
      return locateEvalsEdit({
        root: workspace.root,
        entrypoint: workspace.entrypoint,
        before: change.before,
        after: change.after,
      })
    const edit = change.edit ?? { option: change.knob.option, value: change.after, expected: change.before }
    return {
      target: relative(workspace.root, workspace.entrypoint) || workspace.entrypoint,
      write: async (): Promise<void> => {
        await editAgentOptions(workspace, [edit])
      },
    }
  }

  private async applyAccepted(entry: RunEntry): Promise<void> {
    // A run's edits are written once: the walk on screen and the agent's apply tool can both reach here for one run.
    if (entry.state.step !== 'review' || entry.state.review.applied) return
    const { review } = entry.state
    const accepted = review.edits.flatMap((edit, index) => {
      const write = entry.writers.get(index)
      return edit.accepted && write ? [{ edit, write }] : []
    })
    const change: EvalsAppliedChange = {
      run: review.run,
      experiment: entry.experiment,
      appliedAt: Date.now(),
      baseline: review.baseline,
      best: review.best,
      measuredOn: review.measuredOn,
      ...(review.testCheck ? { testCheck: review.testCheck } : {}),
      edits: accepted.map(({ edit }) => edit),
      ...(review.auto ? { auto: true } : {}),
    }
    const recorded = accepted.length > 0 ? this.changes.push(change) - 1 : undefined
    const applied: string[] = []
    const written: ProposedEdit[] = []
    let applyError: string | undefined
    for (const { edit, write } of accepted) {
      const target = edit.target ?? edit.label
      try {
        await write(edit.after)
        applied.push(target)
        written.push(edit)
      } catch (error) {
        applyError = `Could not change ${target}: ${errorMessage(error)} Change it by hand, then run the experiment again from /experiment.`
        break
      }
    }
    if (written.length > 0) recordDevEvent('optimize_edits_applied')
    if (recorded !== undefined)
      this.changes[recorded] = { ...change, edits: written, ...(applyError ? { error: applyError } : {}) }
    // The writes are awaited, and the review moves on meanwhile (the walk marks it reviewed), so add to what it is now.
    const current = entry.state.step === 'review' ? entry.state.review : review
    // Writing ends the review, whoever asked for it: the walk on screen, or the agent's apply tool.
    this.updateRun(entry, {
      step: 'review',
      review: { ...current, applied, reviewed: true, ...(applyError ? { applyError } : {}) },
    })
    this.settleReview(entry)
    const did = applied.length > 0 ? `applied ${applied.join(', ')}` : 'changed nothing'
    // Nobody saw these edits before they were written, so the notice says who applied them.
    const changed = review.auto ? `auto-accept ${did}` : did
    const notice = {
      status: applyError ? ('error' as const) : ('success' as const),
      text: applyError
        ? `optimize · ${changed} · ${applyError}`
        : `optimize · ${changed} · run the experiment again from /experiment to check your agent`,
    }
    if (applied.length > 0)
      this.carried = { ...notice, at: Date.now(), lasts: review.auto ? AUTO_RELOAD_WINDOW_MS : RELOAD_WINDOW_MS }
    announce(this.host(), notice.status, notice.text)
  }
}
