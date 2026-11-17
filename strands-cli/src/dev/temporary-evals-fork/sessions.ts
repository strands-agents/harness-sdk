import { existsSync, watch, type FSWatcher } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'

import { errorMessage } from '../../terminal/text.js'
import type { DevChatJob } from '../../ui/chat/types.js'
import { resolveModelTarget } from '../../model/selection.js'
import { isRecord } from '../../values.js'
import { editAgentOptions } from '../agent-options.js'
import { baseCliEditProblem, editBaseCliProfile, isProfileBaseCli } from '../base-cli.js'
import type { DevWorkspace } from '../workspace.js'
import { ensureInitialCopy } from '../initialize.js'
import { userConfigPath } from '../../config/store.js'
import {
  formatObjective,
  measuredVersions,
  sameCaseSplit,
  type CaseSplit,
  type ExperimentRun,
  type ExperimentSummary,
  type KnobKey,
  type OptimizeObjective,
  type OptimizePage,
  type OptimizePlan,
  type OptimizeProgress,
  type OptimizeReview,
  type OptimizeSession,
  type RunAgent,
  type OptimizeRunState,
  type OptimizeState,
  type PastRun,
  type PastRuns,
  type ProposedEdit,
  type TestCheck,
  type TestResults,
  type TestRun,
  type TestSession,
  type TestState,
} from '../panels/model.js'
import { locateTemporaryEdit } from './apply.js'
import {
  clearUnreadableCaseResults,
  dropTemporaryRunRecord,
  isTemporaryRunAlive,
  readTemporaryRunRecords,
  saveTemporaryRunRecord,
  waitForTemporaryRun,
  type TemporaryTestRecord,
} from './background-runs.js'
import { temporaryWorkspaceDirectory } from './evals-process.js'
import {
  listTemporaryOptimizations,
  temporaryExperimentHome,
  temporaryOptimizationFiles,
  temporaryOptimizationLabel,
  temporaryOptimizationOf,
  temporaryOptimizationRunName,
  temporaryRunStamp,
} from './layout.js'
import { temporaryWorkspaceReady } from './layout-migration.js'
import { TemporaryEvalsUi } from './evals-ui.js'
import { readTemporaryExperimentFile, readTemporaryRunnableCases, temporaryCaseCount } from './experiment-files.js'
import { TemporaryExperiments } from './experiments-session.js'
import { announce, plural, temporaryRunAgent, type TemporaryHost, type TemporarySessionHost } from './host.js'
import { temporaryJudgeEvaluatorCount } from './evaluators.js'
import { Store, watchTemporaryFileCount, type TemporaryTail } from './jobs.js'
import {
  discoverTemporaryModels,
  readTemporaryKnobs,
  temporaryKnobChanges,
  temporaryKnobLabels,
  temporarySpaceVariables,
  type TemporaryKnob,
  type TemporaryKnobChange,
  type TemporarySpaceVariable,
} from './knobs.js'
import {
  checkTemporaryObjective,
  temporaryObjectiveArguments,
  temporaryObjectivePresets,
  TEMPORARY_USAGE_METRICS,
} from './objective.js'
import { runTemporaryOptimization } from './optimize.js'
import {
  dropTemporaryOptimizeRecord,
  isTemporaryOptimizeAlive,
  readTemporaryOptimizeRecords,
  saveTemporaryOptimizeRecord,
  waitForTemporaryOptimize,
  type TemporaryOptimizeRecord,
} from './optimize-runs.js'
import {
  TEMPORARY_ITERATION_CHOICES,
  TEMPORARY_OPTIMIZE_DEFAULTS,
  temporaryCaseSplit,
  temporaryOptimizeWarning,
  temporaryRolloutEstimate,
  temporarySplitChoices,
  temporarySplitShares,
} from './plan.js'
import { readTemporaryLatestTestResults, readTemporaryTestResults, rememberTemporaryTestResults } from './report.js'
import {
  readTemporaryStudy,
  readTemporaryUsageProfile,
  tailTemporaryRun,
  temporaryRunFolder,
  temporaryStudyReader,
  type TemporaryUsageProfile,
  type TemporaryMeasurement,
  type TemporaryStudyOutcome,
  type TemporaryStudyParams,
  type TemporaryTestDifference,
} from './study.js'
import { runTemporaryTest } from './test.js'

export interface TemporaryAppliedChange {
  readonly run: string
  readonly experiment: string
  readonly appliedAt: number
  readonly baseline: number
  readonly best: number
  readonly measuredOn: string
  readonly testCheck?: TestCheck
  readonly edits: readonly ProposedEdit[]
  readonly error?: string
}

export interface TemporaryDevSessions {
  readonly experiments: TemporaryExperiments
  readonly test: TemporaryTest
  readonly optimize: TemporaryOptimize
  readonly ui: TemporaryEvalsUi
}

const DEFAULT_ITERATIONS = 4
const SOURCE_SETTLE_MS = 300
const WIDTH = 4
const REPETITIONS = 1
const MILLISECONDS = 1000

type RunPlan = Pick<OptimizePlan, 'experiment' | 'iterations' | 'width' | 'split'> & {
  readonly objective?: OptimizeObjective
}

const NO_OBJECTIVE: OptimizeObjective = { expression: '', limits: '' }

const objectiveFields = (
  objective: OptimizeObjective,
  evaluators: readonly string[]
): Pick<OptimizePlan, 'objective' | 'objectiveProblem' | 'objectiveWarning'> => {
  const { problem, warning } = checkTemporaryObjective(objective, evaluators)
  return {
    objective,
    ...(problem ? { objectiveProblem: problem } : {}),
    ...(warning ? { objectiveWarning: warning } : {}),
  }
}

const withObjective = (
  plan: OptimizePlan,
  objective: OptimizeObjective,
  evaluators: readonly string[]
): OptimizePlan => {
  const { objectiveProblem: _problem, objectiveWarning: _warning, ...rest } = plan
  return { ...rest, ...objectiveFields(objective, evaluators) }
}

const MEASURED_ON: Record<TemporaryMeasurement, string> = {
  search: 'training cases',
  validation: 'validation cases',
  test: 'test cases',
}

export const temporaryTestJobs = ({ runs }: TestState): DevChatJob[] =>
  runs.flatMap(({ experiment, run }) =>
    run.status === 'running' ? [{ id: experiment.path, label: experiment.name, done: run.done, total: run.cases }] : []
  )

export const temporaryOptimizeJobs = ({ runs = [] }: OptimizeState): DevChatJob[] =>
  runs.flatMap(({ id, state }) =>
    state.step === 'running'
      ? [
          {
            id,
            label: state.progress.run,
            done: measuredVersions(state.progress),
            total: state.progress.planned,
          },
        ]
      : []
  )

type EditWriter = (after: string) => Promise<void>

interface RunEntry {
  readonly id: string
  readonly experiment: string
  readonly startedAt: number
  readonly listed: boolean
  state: OptimizeRunState
  record?: string
  abort: AbortController | undefined
  stopping: boolean
  writers: Map<number, EditWriter>
  changes: readonly TemporaryKnobChange[]
  sources: FSWatcher | undefined
}

const startingProgress = (plan: RunPlan, startedAt: number): OptimizeProgress => ({
  run: 'starting',
  record: '',
  metric: '',
  iterations: plan.iterations,
  planned: 1 + plan.iterations * plan.width,
  trainCases: plan.split.train,
  candidates: [],
  startedAt,
  stopping: false,
})

const sentence = (text: string): string => (/[.!?]$/u.test(text.trim()) ? text.trim() : `${text.trim()}.`)

const STOPPED_BY_USER = 'You stopped the run.'
const OLDER_OPTIMIZER_RECORD = 'study.jsonl'

const tunedIn = (knobs: readonly TemporaryKnob[], params: TemporaryStudyParams): TemporaryKnob[] =>
  knobs.map((knob) => ({ ...knob, enabled: Object.keys(temporaryKnobLabels([knob])).some((key) => key in params) }))

const testCheck = (test: TemporaryTestDifference | undefined): TestCheck | undefined =>
  test && {
    difference: test.difference,
    cases: test.cases,
    confidence: test.confidence,
    ...(test.ci ? { range: test.ci } : {}),
  }

const pastSummary = (outcome: TemporaryStudyOutcome, edits: number): string => {
  if (outcome.error) return `stopped: ${outcome.error}`
  const baseline = outcome.baseline.score
  if (baseline === undefined) return 'stopped before the baseline was measured'
  const early = outcome.ended === 'running' ? 'stopped early · ' : ''
  const best = outcome.best?.score
  const where = MEASURED_ON[outcome.measuredOn]
  const shown = (value: number): string => formatObjective(value, outcome.measure)
  return edits === 0 || best === undefined
    ? `${early}no better candidate · ${shown(baseline)} on ${where}`
    : `${early}${shown(baseline)} → ${shown(best)} on ${where} · ${plural(edits, 'edit')}`
}

const optimizationRecords = async (workspaceDirectory: string): Promise<PastRun[]> =>
  (await listTemporaryOptimizations(workspaceDirectory))
    .map(({ home, name, stamp, startedAt }) => ({
      record: temporaryOptimizationFiles(home, stamp).record,
      experiment: name,
      startedAt,
      summary: '',
      opens: false,
    }))
    .sort((left, right) => right.startedAt - left.startedAt)

const locateBaseCliEdit = (
  workspace: DevWorkspace,
  change: TemporaryKnobChange
): { target: string; write: (after: string) => Promise<void> } | { unavailable: string } => {
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

export class TemporaryTest extends Store<TestState> implements TestSession {
  private readonly runs = new Map<string, ExperimentRun>()
  private readonly stops = new Map<string, AbortController>()
  private resumed: Promise<void> | undefined

  constructor(
    private readonly host: TemporaryHost,
    readonly experiments: TemporaryExperiments
  ) {
    super({ runs: [] })
  }

  agent(): RunAgent {
    return temporaryRunAgent(this.host())
  }

  show(): Promise<void> {
    return this.restore()
  }

  run(experiments: readonly ExperimentSummary[]): void {
    for (const experiment of experiments) {
      if (this.isRunning(experiment.path)) continue
      this.starting(experiment, experiment.caseCount, false)
      void this.execute(experiment, experiment.path, false)
    }
  }

  rerunFailed(path: string): void {
    const entry = this.runs.get(path)
    if (entry?.run.status !== 'done') return
    const failed = entry.run.results.cases.filter((item) => !item.passed).map((item) => item.name)
    if (failed.length === 0) return
    this.starting(entry.experiment, failed.length, true)
    void this.rerun(entry.experiment, failed)
  }

  stop(path: string): void {
    this.stops.get(path)?.abort()
  }

  resume(): Promise<void> {
    this.resumed ??= this.resumeRecords()
    return this.resumed
  }

  private async resumeRecords(): Promise<void> {
    const { problems } = await temporaryWorkspaceReady(this.workspaceDirectory())
    if (problems.length > 0)
      announce(
        this.host(),
        'error',
        `strands dev could not move ${plural(problems.length, 'item')} to the new workspace layout · first: ${problems[0]}`
      )
    let records: TemporaryTestRecord[]
    try {
      records = await readTemporaryRunRecords(this.workspaceDirectory())
    } catch (error) {
      announce(this.host(), 'error', `test · /test cannot read its unfinished runs: ${errorMessage(error)}`)
      return
    }
    await Promise.all(records.map((record) => this.continueRun(record)))
  }

  private async recordedExperiment(record: TemporaryTestRecord): Promise<ExperimentSummary> {
    const caseCount = await temporaryCaseCount(record.experiment).catch(() => temporaryCaseCount(record.cases))
    return { name: basename(record.experiment, '.json'), path: record.experiment, caseCount }
  }

  private async continueRun(record: TemporaryTestRecord): Promise<void> {
    let experiment: ExperimentSummary | undefined
    try {
      experiment = await this.recordedExperiment(record)
      if (this.isRunning(experiment.path)) return
      if (await isTemporaryRunAlive(record)) return await this.follow(experiment, record)
      if (existsSync(record.report)) {
        await this.finish(experiment, record.report, record.startedAt, record.only)
        return await dropTemporaryRunRecord(record)
      }
      await clearUnreadableCaseResults(record.store)
      this.starting(experiment, record.only?.length ?? experiment.caseCount, record.rerun)
      announce(
        this.host(),
        'success',
        `test · ${experiment.name} · resumed the run that stopped when strands dev closed`
      )
      await this.execute(experiment, record.cases, record.rerun, record, record.only)
    } catch (error) {
      if (experiment) this.update(experiment, { status: 'failed', message: errorMessage(error) })
      announce(
        this.host(),
        'error',
        `test · ${basename(record.experiment, '.json')} could not resume · /test shows why`
      )
    }
  }

  private async follow(experiment: ExperimentSummary, record: TemporaryTestRecord): Promise<void> {
    const abort = new AbortController()
    this.stops.set(experiment.path, abort)
    let stopCounting = (): void => undefined
    try {
      const { experiment: loaded } = await readTemporaryExperimentFile(record.cases)
      const running = {
        status: 'running' as const,
        cases: loaded.cases.length,
        evaluators: loaded.evaluators,
        done: 0,
        startedAt: record.startedAt,
        rerun: record.rerun,
      }
      this.update(experiment, running)
      stopCounting = watchTemporaryFileCount(record.store, (done) => {
        if (this.isRunning(experiment.path)) this.update(experiment, { ...running, done })
      })
      await waitForTemporaryRun(record, abort.signal)
      if (abort.signal.aborted) return this.update(experiment, { status: 'failed', message: STOPPED_BY_USER })
      if (!existsSync(record.report))
        throw new Error(
          `strands-evals run ended without writing ${record.report}. The full output is in ${record.log}.`
        )
      await this.finish(experiment, record.report, record.startedAt, record.only)
    } catch (error) {
      this.update(experiment, { status: 'failed', message: errorMessage(error) })
      announce(this.host(), 'error', `test · ${experiment.name} stopped · /test shows why`)
    } finally {
      stopCounting()
      if (this.stops.get(experiment.path) === abort) this.stops.delete(experiment.path)
      await dropTemporaryRunRecord(record)
    }
  }

  private async finish(
    experiment: ExperimentSummary,
    report: string,
    startedAt: number,
    only?: readonly string[]
  ): Promise<void> {
    const run = await readTemporaryTestResults(report, {
      experiment: experiment.name,
      seconds: (Date.now() - startedAt) / MILLISECONDS,
    })
    const results = await this.remember(experiment, run, only)
    this.update(experiment, { status: 'done', results })
    const passed = results.cases.filter((item) => item.passed).length
    const total = `${passed} of ${plural(results.cases.length, 'case')} passed`
    const rerun = only
      ? `${run.cases.filter((item) => item.passed).length} of ${plural(run.cases.length, 'rerun case')} passed · `
      : ''
    announce(this.host(), 'success', `test · ${experiment.name} · ${rerun}${total} · /test shows the results`)
  }

  private isRunning(path: string): boolean {
    return this.runs.get(path)?.run.status === 'running'
  }

  private workspaceDirectory(): string {
    return temporaryWorkspaceDirectory(this.host().workspace)
  }

  private async restore(): Promise<void> {
    const saved = await this.experiments.reload()
    await Promise.all(saved.filter(({ path }) => !this.runs.has(path)).map((experiment) => this.restoreRun(experiment)))
  }

  private home(experiment: ExperimentSummary): string {
    return temporaryExperimentHome(this.workspaceDirectory(), experiment.path)
  }

  private async remember(
    experiment: ExperimentSummary,
    results: TestResults,
    only: readonly string[] | undefined
  ): Promise<TestResults> {
    try {
      return await rememberTemporaryTestResults(this.home(experiment), results, only)
    } catch (error) {
      announce(
        this.host(),
        'error',
        `test · ${experiment.name} · /test cannot show this report after a restart: ${errorMessage(error)}`
      )
      return results
    }
  }

  private async restoreRun(experiment: ExperimentSummary): Promise<void> {
    let run: TestRun | undefined
    try {
      const results = await readTemporaryLatestTestResults(this.home(experiment))
      if (results) run = { status: 'done', results }
    } catch (error) {
      run = { status: 'failed', message: errorMessage(error) }
    }
    if (run && !this.runs.has(experiment.path)) this.update(experiment, run)
  }

  private update(experiment: ExperimentSummary, run: TestRun): void {
    this.runs.set(experiment.path, { experiment, run })
    this.set({ runs: [...this.runs.values()] })
  }

  private starting(experiment: ExperimentSummary, cases: number, rerun: boolean): void {
    this.update(experiment, { status: 'running', cases, evaluators: [], done: 0, startedAt: Date.now(), rerun })
  }

  private async rerun(experiment: ExperimentSummary, names: readonly string[]): Promise<void> {
    await this.execute(experiment, experiment.path, true, undefined, names)
  }

  private async execute(
    experiment: ExperimentSummary,
    cases: string,
    rerun: boolean,
    resumed?: TemporaryTestRecord,
    only?: readonly string[]
  ): Promise<void> {
    const startedAt = resumed?.startedAt ?? Date.now()
    const abort = new AbortController()
    this.stops.set(experiment.path, abort)
    let stopCounting = (): void => undefined
    let record: TemporaryTestRecord | undefined
    let saving: Promise<void> = Promise.resolve()
    const save = (next: TemporaryTestRecord): Promise<void> => {
      record = next
      saving = saving
        .then(() => saveTemporaryRunRecord(next))
        .catch((error: unknown) =>
          announce(
            this.host(),
            'error',
            `test · ${experiment.name} cannot save its run record, so it cannot resume after a restart: ${errorMessage(error)}`
          )
        )
      return saving
    }
    try {
      const { experiment: loaded } = await readTemporaryExperimentFile(cases)
      const running = {
        status: 'running' as const,
        cases: only?.length ?? loaded.cases.length,
        evaluators: loaded.evaluators,
        done: 0,
        startedAt,
        rerun,
      }
      this.update(experiment, running)
      const outcome = await runTemporaryTest(
        {
          workspace: this.host().workspace,
          experiment: cases,
          ...(only ? { only } : {}),
          startedAt,
          background: true,
          detached: true,
          signal: abort.signal,
          ...(resumed ? { resume: resumed } : {}),
          onStart: async (files) => {
            await save({
              version: 1,
              experiment: experiment.path,
              rerun,
              startedAt,
              ...(only ? { only } : {}),
              ...files,
            })
            stopCounting = watchTemporaryFileCount(files.store, (done) => {
              if (this.isRunning(experiment.path)) this.update(experiment, { ...running, done })
            })
          },
          onSpawn: (pid) => {
            if (record) void save({ ...record, pid })
          },
        },
        this.host().dependencies
      )
      stopCounting()
      await this.finish(experiment, outcome.report, startedAt, only)
    } catch (error) {
      if (abort.signal.aborted) return this.update(experiment, { status: 'failed', message: STOPPED_BY_USER })
      this.update(experiment, { status: 'failed', message: errorMessage(error) })
      announce(this.host(), 'error', `test · ${experiment.name} stopped · /test shows why`)
    } finally {
      stopCounting()
      if (this.stops.get(experiment.path) === abort) this.stops.delete(experiment.path)
      await saving
      if (record) await dropTemporaryRunRecord(record)
    }
  }
}

export class TemporaryOptimize extends Store<OptimizeState> implements OptimizeSession {
  private evaluators = 1
  private usageProfile: TemporaryUsageProfile | undefined
  private evaluatorNames: readonly string[] = []
  private resumed: Promise<void> | undefined
  private catalog: readonly TemporaryKnob[] = []
  private page: OptimizePage = { step: 'pick' }
  private shown: string | undefined
  private readonly entries = new Map<string, RunEntry>()
  private runCount = 0
  private pastRuns: PastRuns | undefined
  private pastRunsLoad = 0
  private readonly changes: TemporaryAppliedChange[] = []

  constructor(
    private readonly host: TemporaryHost,
    readonly experiments: TemporaryExperiments
  ) {
    super({ step: 'pick', runs: [] })
  }

  agent(): RunAgent {
    return temporaryRunAgent(this.host())
  }

  plan(experiment: ExperimentSummary): void {
    void this.planFor(experiment)
  }

  show(): void {
    this.reset()
  }

  reset(): void {
    this.showPage({ step: 'pick', ...(this.pastRuns ? { pastRuns: this.pastRuns } : {}) })
    this.experiments.refresh()
    void this.loadPastRuns()
  }

  openRun(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.showPage(entry.state, entry.id)
    void this.recheck(entry, false)
  }

  openPastRun(record: string): void {
    const entry = [...this.entries.values()].find((candidate) => candidate.record === record)
    if (entry) this.openRun(entry.id)
    else void this.openRecord(record)
  }

  discard(id: string): void {
    if (this.entries.get(id)?.state.step !== 'review') return
    this.entries.get(id)?.sources?.close()
    this.entries.delete(id)
    if (this.shown === id) this.reset()
    else this.publish()
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

  loadModels(): void {
    void this.loadModelOptions()
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
      plan.iterationChoices.includes(iterations) ? this.estimate({ ...plan, iterations }) : plan
    )
  }

  setSplit(split: CaseSplit): void {
    this.updatePlan((plan) => {
      if (!plan.splitChoices.some((choice) => sameCaseSplit(choice, split))) return plan
      const { warning: _warning, ...rest } = plan
      const warning = temporaryOptimizeWarning(plan.experiment.caseCount, temporarySplitShares(split))
      return this.estimate({ ...rest, split, ...(warning ? { warning } : {}) })
    })
  }

  setObjective(objective: OptimizeObjective): void {
    this.updatePlan((plan) => withObjective(plan, objective, this.evaluatorNames))
  }

  start(): string | undefined {
    const page = this.page
    if (page.step !== 'setup' || page.plan.objectiveProblem) return undefined
    const knobs = this.catalog.map((knob) => ({
      ...knob,
      enabled: page.plan.knobs.find(({ key }) => key === knob.key)?.enabled ?? false,
    }))
    const variables = temporarySpaceVariables(knobs, page.plan.models?.picked ?? [])
    if (variables.length === 0) return undefined
    const startedAt = Date.now()
    const entry = this.addRun(page.plan.experiment.name, startedAt, {
      step: 'running',
      progress: startingProgress(page.plan, startedAt),
    })
    this.showPage(entry.state, entry.id)
    void this.run(entry, page.plan, knobs, variables)
    return entry.id
  }

  stop(id?: string): void {
    const entry = this.entries.get(id ?? this.shown ?? '')
    if (entry?.state.step !== 'running' || !entry.abort || entry.stopping) return
    entry.stopping = true
    this.updateRun(entry, { step: 'running', progress: { ...entry.state.progress, stopping: true } })
    entry.abort.abort()
  }

  accept(index: number, accepted: boolean): void {
    const entry = this.shownEntry()
    if (entry?.state.step !== 'review') return
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
        edits: review.edits.map((edit, position) => (position === index ? { ...edit, accepted } : edit)),
      },
    })
  }

  apply(): void {
    const entry = this.shownEntry()
    if (entry) void this.applyAccepted(entry)
  }

  resume(): Promise<void> {
    this.resumed ??= this.resumeRecords()
    return this.resumed
  }

  appliedChanges(): readonly TemporaryAppliedChange[] {
    return [...this.changes]
  }

  private shownEntry(): RunEntry | undefined {
    return this.shown === undefined ? undefined : this.entries.get(this.shown)
  }

  private addRun(experiment: string, startedAt: number, state: OptimizeRunState, listed = true): RunEntry {
    this.runCount += 1
    const entry: RunEntry = {
      id: `run-${this.runCount}`,
      experiment,
      startedAt,
      listed,
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
      .filter(({ listed }) => listed)
      .sort((left, right) => right.startedAt - left.startedAt)
      .map(({ id, experiment, startedAt, record, state }) => ({
        id,
        experiment,
        startedAt,
        ...(record ? { record } : {}),
        state,
      }))
    this.set({ ...this.page, runs })
  }

  private showPastRuns(pastRuns: PastRuns): void {
    this.pastRuns = pastRuns
    if (this.page.step !== 'pick') return
    this.page = { step: 'pick', pastRuns }
    this.publish()
  }

  private async loadPastRuns(): Promise<void> {
    const load = ++this.pastRunsLoad
    const latest = (pastRuns: PastRuns): void => {
      if (load === this.pastRunsLoad) this.showPastRuns(pastRuns)
    }
    latest({ loading: true, runs: this.pastRuns?.runs ?? [] })
    try {
      const { workspace } = this.host()
      const records = await optimizationRecords(this.workspaceDirectory())
      const catalog = records.length > 0 ? await readTemporaryKnobs(workspace) : []
      latest({ loading: false, runs: await Promise.all(records.map((run) => this.summarize(run, catalog))) })
    } catch (error) {
      latest({ loading: false, runs: [], error: `Past runs cannot be read: ${errorMessage(error)}` })
    }
  }

  private async summarize(run: PastRun, catalog: readonly TemporaryKnob[]): Promise<PastRun> {
    try {
      const outcome = await readTemporaryStudy(run.record)
      const knobs = tunedIn(catalog, outcome.baseline.params)
      const edits = temporaryKnobChanges(knobs, outcome.baseline.params, outcome.best?.params ?? {}).length
      return { ...run, summary: pastSummary(outcome, edits), opens: true }
    } catch {
      return {
        ...run,
        summary: existsSync(join(run.record, OLDER_OPTIMIZER_RECORD))
          ? 'made by the older optimizer, so it cannot be opened'
          : 'no report, because the run stopped before it started',
      }
    }
  }

  private async openRecord(record: string): Promise<void> {
    try {
      const outcome = await readTemporaryStudy(record)
      const knobs = tunedIn(await readTemporaryKnobs(this.host().workspace), outcome.baseline.params)
      const { review, writers, changes } = await this.review(outcome, record, knobs)
      const label = temporaryOptimizationLabel(record)
      const entry = this.addRun(label.experiment, label.startedAt ?? Date.now(), { step: 'review', review }, false)
      entry.record = record
      entry.writers = writers
      entry.changes = changes
      this.watchSources(entry)
      if (this.page.step === 'pick') this.showPage(entry.state, entry.id)
    } catch (error) {
      if (this.page.step === 'pick') this.showPage({ step: 'failed', message: errorMessage(error), record })
    }
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

  private estimate({ usage: _earlier, ...plan }: OptimizePlan): OptimizePlan {
    const { rollouts, judgeCalls, usage } = temporaryRolloutEstimate({
      split: plan.split,
      repetitions: plan.repetitions,
      iterations: plan.iterations,
      width: plan.width,
      evaluators: this.evaluators,
      ...(this.usageProfile ? { profile: this.usageProfile } : {}),
    })
    return { ...plan, rollouts, judgeCalls, ...(usage ? { usage } : {}) }
  }

  private async loadModelOptions(): Promise<void> {
    const models = this.page.step === 'setup' ? this.page.plan.models : undefined
    if (!models || models.options || models.loading) return
    this.updatePlan((plan) => (plan.models ? { ...plan, models: { ...plan.models, loading: true } } : plan))
    const discover = this.host().dependencies?.discoverModels ?? discoverTemporaryModels
    const found = await discover(resolveModelTarget(models.current).provider).catch((error: unknown) => ({
      error: errorMessage(error),
    }))
    this.updatePlan((plan) => {
      if (!plan.models) return plan
      const { loading: _loading, ...rest } = plan.models
      return {
        ...plan,
        models: {
          ...rest,
          ...('options' in found && found.options
            ? { options: found.options }
            : { error: found.error ?? 'No models were found.' }),
        },
      }
    })
  }

  private async planFor(summary: ExperimentSummary): Promise<void> {
    try {
      const { experiment, raw } = await readTemporaryExperimentFile(summary.path)
      this.catalog = await readTemporaryKnobs(this.host().workspace)
      this.usageProfile = await readTemporaryUsageProfile(this.workspaceDirectory(), summary.name).catch(
        () => undefined
      )
      const model = this.catalog.find((knob) => knob.kind === 'models' && !knob.unavailable)
      const caseCount = experiment.cases.length
      const split = temporaryCaseSplit(caseCount)
      const splitChoices = temporarySplitChoices(caseCount)
      const objectivePresets = temporaryObjectivePresets(experiment.evaluators)
      const warning = temporaryOptimizeWarning(caseCount)
      this.evaluators = temporaryJudgeEvaluatorCount(raw.evaluators)
      this.evaluatorNames = experiment.evaluators
      this.showPage({
        step: 'setup',
        plan: this.estimate({
          experiment: { ...summary, caseCount },
          knobs: this.catalog,
          ...(typeof model?.current === 'string' ? { models: { current: model.current, picked: [] } } : {}),
          ...objectiveFields(objectivePresets[0]?.objective ?? NO_OBJECTIVE, experiment.evaluators),
          objectivePresets,
          metrics: [...experiment.evaluators, ...TEMPORARY_USAGE_METRICS],
          split,
          splitChoices,
          repetitions: REPETITIONS,
          width: WIDTH,
          iterations: DEFAULT_ITERATIONS,
          iterationChoices: TEMPORARY_ITERATION_CHOICES,
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
    return temporaryWorkspaceDirectory(this.host().workspace)
  }

  private async resumeRecords(): Promise<void> {
    let records: TemporaryOptimizeRecord[]
    try {
      await temporaryWorkspaceReady(this.workspaceDirectory())
      records = await readTemporaryOptimizeRecords(this.workspaceDirectory())
    } catch (error) {
      announce(this.host(), 'error', `optimize · /optimize cannot read its unfinished run: ${errorMessage(error)}`)
      return
    }
    const known = new Set([...this.entries.values()].map(({ record }) => record))
    await Promise.all(records.filter(({ record }) => !known.has(record)).map((saved) => this.continueRun(saved)))
  }

  private async continueRun(saved: TemporaryOptimizeRecord): Promise<void> {
    let entry: RunEntry | undefined
    try {
      const plan = await this.recordedPlan(saved)
      const knobs = await this.recordedKnobs(saved)
      entry = this.addRun(plan.experiment.name, saved.startedAt, {
        step: 'running',
        progress: startingProgress(plan, saved.startedAt),
      })
      entry.record = saved.record
      this.publish()
      if (await isTemporaryOptimizeAlive(saved)) return await this.follow(entry, plan, knobs, saved)
      if (await this.hasResult(saved.record)) {
        await this.finish(entry, saved.record, plan, knobs, false)
        return await dropTemporaryOptimizeRecord(saved)
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
        `optimize · ${basename(saved.experiment, '.json')} could not resume · /optimize shows why`
      )
      await dropTemporaryOptimizeRecord(saved)
    }
  }

  private async recordedPlan(saved: TemporaryOptimizeRecord): Promise<RunPlan> {
    const caseCount = await temporaryCaseCount(saved.experiment).catch(() => 0)
    return {
      experiment: { name: basename(saved.experiment, '.json'), path: saved.experiment, caseCount },
      iterations: saved.iterations,
      width: WIDTH,
      split: temporaryCaseSplit(caseCount, saved.split ?? TEMPORARY_OPTIMIZE_DEFAULTS.split),
      ...(saved.objective ? { objective: saved.objective } : {}),
    }
  }

  private async recordedKnobs(saved: TemporaryOptimizeRecord): Promise<TemporaryKnob[]> {
    const knobs = await readTemporaryKnobs(this.host().workspace)
    const space: unknown = JSON.parse(await readFile(saved.space, 'utf8'))
    const variables = isRecord(space) && Array.isArray(space.variables) ? space.variables : []
    const options = new Set(variables.filter(isRecord).map(({ option }) => option))
    return knobs.map((knob) => ({ ...knob, enabled: options.has(knob.option) }))
  }

  private async hasResult(record: string): Promise<boolean> {
    const folder = await temporaryRunFolder(record)
    return folder !== undefined && existsSync(join(folder, 'result.json'))
  }

  private async follow(
    entry: RunEntry,
    plan: RunPlan,
    knobs: readonly TemporaryKnob[],
    saved: TemporaryOptimizeRecord
  ): Promise<void> {
    const abort = new AbortController()
    entry.abort = abort
    entry.stopping = false
    const reader = temporaryStudyReader({
      run: temporaryOptimizationRunName(saved.record),
      record: saved.record,
      startedAt: saved.startedAt,
      labels: temporaryKnobLabels(knobs),
      cases: await readTemporaryRunnableCases(saved.experiment).catch(() => []),
    })
    const show = (): void =>
      this.updateRun(entry, {
        step: 'running',
        progress: {
          ...reader.progress(),
          planned: 1 + plan.iterations * plan.width,
          trainCases: plan.split.train,
          stopping: entry.stopping,
        },
      })
    const tail = tailTemporaryRun(saved.record, (line) => {
      reader.push(line)
      show()
    })
    show()
    try {
      await waitForTemporaryOptimize(saved, abort.signal)
    } finally {
      await tail.stop()
      entry.abort = undefined
    }
    await this.finish(entry, saved.record, plan, knobs, abort.signal.aborted)
    await dropTemporaryOptimizeRecord(saved)
  }

  private async run(
    entry: RunEntry,
    plan: RunPlan,
    knobs: readonly TemporaryKnob[],
    variables: readonly TemporarySpaceVariable[],
    continuing?: TemporaryOptimizeRecord
  ): Promise<void> {
    const abort = new AbortController()
    const startedAt = continuing?.startedAt ?? entry.startedAt
    const now = new Date(startedAt)
    const labels = temporaryKnobLabels(knobs)
    const shares = continuing ? continuing.split : temporarySplitShares(plan.split)
    entry.abort = abort
    entry.stopping = false
    let record: string | undefined
    let cancelled = false
    let saving: Promise<void> = Promise.resolve()
    let saved: TemporaryOptimizeRecord | undefined
    const remember = (next: TemporaryOptimizeRecord): void => {
      saved = next
      saving = saving
        .then(() => saveTemporaryOptimizeRecord(next))
        .catch((error: unknown) =>
          announce(
            this.host(),
            'error',
            `optimize · ${plan.experiment.name} · this run cannot continue after a restart: ${errorMessage(error)}`
          )
        )
    }
    let reader: ReturnType<typeof temporaryStudyReader> | undefined
    let tail: TemporaryTail | undefined
    const progress = (): OptimizeProgress =>
      reader
        ? {
            ...reader.progress(),
            planned: 1 + plan.iterations * plan.width,
            trainCases: plan.split.train,
            stopping: entry.stopping,
          }
        : { ...startingProgress(plan, startedAt), stopping: entry.stopping }
    const show = (): void => this.updateRun(entry, { step: 'running', progress: progress() })
    show()
    try {
      await (this.host().dependencies?.initialCopy ?? ensureInitialCopy)(this.host().workspace, abort.signal)
      const space = continuing?.space ?? (await this.writeSpace(plan, now, variables))
      const cases = await readTemporaryRunnableCases(plan.experiment.path).catch(() => [])
      await runTemporaryOptimization(
        {
          workspace: this.host().workspace,
          experiment: plan.experiment.path,
          forkArguments: [
            '--space',
            space,
            '--iterations',
            String(plan.iterations),
            ...(shares ? ['--split', shares.join(',')] : []),
            ...(plan.objective ? temporaryObjectiveArguments(plan.objective) : []),
          ],
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
              ...(shares ? { split: shares } : {}),
              ...(plan.objective ? { objective: plan.objective } : {}),
              startedAt,
            })
            reader = temporaryStudyReader({
              run: temporaryOptimizationRunName(path),
              record: path,
              startedAt,
              labels,
              cases,
            })
            tail = tailTemporaryRun(path, (line) => {
              reader?.push(line)
              show()
            })
            show()
          },
        },
        this.host().dependencies
      )
      await tail?.stop()
    } catch (error) {
      await tail?.stop()
      if (!entry.stopping) {
        await saving
        if (record) await dropTemporaryOptimizeRecord({ record })
        this.updateRun(entry, { step: 'failed', message: errorMessage(error), ...(record ? { record } : {}) })
        announce(this.host(), 'error', `optimize · ${plan.experiment.name} stopped · /optimize shows why`)
        return
      }
      cancelled = true
    } finally {
      entry.abort = undefined
    }
    await saving
    if (record) await dropTemporaryOptimizeRecord({ record })
    if (cancelled && !record) return this.reportCancelled(entry, plan)
    await this.finish(entry, record!, plan, knobs, cancelled)
  }

  private async writeSpace(plan: RunPlan, now: Date, variables: readonly TemporarySpaceVariable[]): Promise<string> {
    const home = temporaryExperimentHome(this.workspaceDirectory(), plan.experiment.path)
    const path = temporaryOptimizationFiles(home, temporaryRunStamp(now)).space
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify({ variables }, null, 2)}\n`)
    return path
  }

  private async finish(
    entry: RunEntry,
    record: string,
    plan: RunPlan,
    knobs: readonly TemporaryKnob[],
    cancelled: boolean
  ): Promise<void> {
    const name = temporaryOptimizationRunName(record)
    let outcome: TemporaryStudyOutcome
    try {
      outcome = await readTemporaryStudy(record)
    } catch (error) {
      if (cancelled) return this.reportCancelled(entry, plan, record)
      this.updateRun(entry, { step: 'failed', message: errorMessage(error), record })
      announce(this.host(), 'error', `optimize · run ${name} could not be read · /optimize shows why`)
      return
    }
    if (outcome.ended === 'stopped' && outcome.error && !cancelled) {
      const log = temporaryOptimizationOf(record).log
      this.updateRun(entry, {
        step: 'failed',
        message: `${sentence(outcome.error)} The full optimizer output is in ${log}.`,
        record,
      })
      announce(this.host(), 'error', `optimize · run ${name} failed · /optimize shows why`)
      return
    }
    try {
      const { review, writers, changes } = await this.review(outcome, record, knobs)
      entry.writers = writers
      entry.changes = changes
      this.updateRun(entry, { step: 'review', review })
      this.watchSources(entry)
      announce(this.host(), 'success', `optimize · run ${review.run} finished · open it in /optimize`)
    } catch (error) {
      if (cancelled) return this.reportCancelled(entry, plan, record)
      this.updateRun(entry, { step: 'failed', message: errorMessage(error), record })
      announce(this.host(), 'error', `optimize · run ${name} could not be read · /optimize shows why`)
    }
  }

  private reportCancelled(entry: RunEntry, plan: RunPlan, record?: string): void {
    this.updateRun(entry, {
      step: 'cancelled',
      experiment: plan.experiment.name,
      ...(record ? { run: temporaryOptimizationRunName(record) } : {}),
    })
    announce(this.host(), 'success', `optimize · ${plan.experiment.name} cancelled · the agent source is unchanged`)
  }

  private async locate(
    change: TemporaryKnobChange
  ): Promise<{ target: string; write: (after: string) => Promise<void> } | { unavailable: string }> {
    const { workspace } = this.host()
    if (await isProfileBaseCli(workspace)) return locateBaseCliEdit(workspace, change)
    if (change.knob.key === 'instructions')
      return locateTemporaryEdit({
        root: workspace.root,
        entrypoint: workspace.entrypoint,
        knob: 'instructions',
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

  private async review(
    outcome: TemporaryStudyOutcome,
    record: string,
    knobs: readonly TemporaryKnob[]
  ): Promise<{ review: OptimizeReview; writers: Map<number, EditWriter>; changes: TemporaryKnobChange[] }> {
    const writers = new Map<number, EditWriter>()
    const edits: ProposedEdit[] = []
    const changes = temporaryKnobChanges(knobs, outcome.baseline.params, outcome.best?.params ?? {})
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
      })
    }
    const baseline = outcome.baseline.score ?? 0
    const check = testCheck(outcome.test)
    const review: OptimizeReview = {
      run: temporaryOptimizationRunName(record),
      record,
      baseline,
      best: outcome.best?.score ?? baseline,
      ...(outcome.measure ? { measure: outcome.measure } : {}),
      measuredOn: MEASURED_ON[outcome.measuredOn],
      edits,
      ...(check ? { testCheck: check } : {}),
    }
    return { review, writers, changes }
  }

  private async applyAccepted(entry: RunEntry): Promise<void> {
    if (entry.state.step !== 'review') return
    const { review } = entry.state
    const accepted = review.edits.flatMap((edit, index) => {
      const write = entry.writers.get(index)
      return edit.accepted && write ? [{ edit, write }] : []
    })
    const change: TemporaryAppliedChange = {
      run: review.run,
      experiment: entry.experiment,
      appliedAt: Date.now(),
      baseline: review.baseline,
      best: review.best,
      measuredOn: review.measuredOn,
      ...(review.testCheck ? { testCheck: review.testCheck } : {}),
      edits: accepted.map(({ edit }) => edit),
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
        applyError = `Could not change ${target}: ${errorMessage(error)} Change it by hand, then run /test.`
        break
      }
    }
    if (recorded !== undefined)
      this.changes[recorded] = { ...change, edits: written, ...(applyError ? { error: applyError } : {}) }
    this.updateRun(entry, { step: 'review', review: { ...review, applied, ...(applyError ? { applyError } : {}) } })
    const changed = applied.length > 0 ? `applied ${applied.join(', ')}` : 'changed nothing'
    announce(
      this.host(),
      applyError ? 'error' : 'success',
      applyError ? `optimize · ${changed} · ${applyError}` : `optimize · ${changed} · run /test to check your agent`
    )
  }
}

const registry = new Map<string, { use: (host: TemporarySessionHost) => void; sessions: TemporaryDevSessions }>()

export const temporaryDevSessions = (host: TemporarySessionHost): TemporaryDevSessions => {
  const key = temporaryWorkspaceDirectory(host.workspace)
  const existing = registry.get(key)
  if (existing) {
    existing.use(host)
    return existing.sessions
  }
  let latest = host
  const current = (): TemporarySessionHost => latest
  const experiments = new TemporaryExperiments(current)
  const sessions = {
    experiments,
    test: new TemporaryTest(current, experiments),
    optimize: new TemporaryOptimize(current, experiments),
    ui: new TemporaryEvalsUi(current, host.evalsUi),
  }
  registry.set(key, {
    use: (next) => {
      latest = { ...latest, ...next }
    },
    sessions,
  })
  return sessions
}
