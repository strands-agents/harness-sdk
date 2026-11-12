import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'

import { errorMessage } from '../../terminal/text.js'
import type { DevChatCommandContext } from '../../ui/chat/types.js'
import type {
  DatasetSession,
  DatasetState,
  DraftCase,
  ExperimentSummary,
  Knob,
  KnobKey,
  OptimizePlan,
  OptimizeProgress,
  OptimizeReview,
  OptimizeSession,
  OptimizeState,
  ProposedEdit,
  TestResults,
  TestSession,
  TestState,
} from '../panels/model.js'
import type { DevWorkspace } from '../workspace.js'
import { temporaryAgentContext, type TemporaryAgentFacts } from './agent-context.js'
import { locateTemporaryEdit } from './apply.js'
import {
  temporaryExperimentsFolder,
  temporaryReportsFolder,
  temporaryRunName,
  temporaryWorkspaceDirectory,
} from './evals-process.js'
import { draftTemporaryExperiment, type TemporaryExperimentDependencies } from './experiment.js'
import {
  appendTemporaryCases,
  listTemporaryExperiments,
  readTemporaryExperimentFile,
  temporaryCaseName,
  writeTemporaryExperimentFile,
  type TemporaryExperimentDocument,
} from './experiment-files.js'
import { TemporaryJobNotice, tailTemporaryLines, watchTemporaryFileCount, type TemporaryTail } from './jobs.js'
import { runTemporaryOptimization, type TemporaryOptimizationDependencies } from './optimize.js'
import {
  TEMPORARY_ITERATION_CHOICES,
  temporaryCaseSplit,
  temporaryOptimizeWarning,
  temporaryRolloutEstimate,
} from './plan.js'
import { readTemporaryTestResults } from './report.js'
import {
  readTemporaryStudy,
  temporaryStudyReader,
  type TemporaryMeasurement,
  type TemporaryStudyOutcome,
} from './study.js'
import { runTemporaryTest, type TemporaryTestDependencies } from './test.js'

export interface TemporarySessionHost {
  readonly workspace: DevWorkspace
  readonly agent: () => TemporaryAgentFacts
  readonly context?: DevChatCommandContext
  readonly dependencies?: TemporarySessionDependencies
}

export type TemporarySessionDependencies = TemporaryExperimentDependencies &
  TemporaryTestDependencies &
  TemporaryOptimizationDependencies

export interface TemporaryDevSessions {
  readonly dataset: TemporaryDataset
  readonly test: TemporaryTest
  readonly optimize: TemporaryOptimize
}

type Host = () => TemporarySessionHost

const DRAFT_COUNT = 20
const DEFAULT_ITERATIONS = 4
const WIDTH = 4
const REPETITIONS = 1
const STARTER_NAME = 'starter'
const MILLISECONDS = 1000
const TUNABLE_KNOBS: readonly KnobKey[] = ['instructions', 'effort']

const KNOBS: readonly Knob[] = [
  { key: 'instructions', label: 'instructions', detail: "your agent's instructions (system prompt)", enabled: true },
  {
    key: 'effort',
    label: 'effort',
    detail: 'auto · off · minimal · low · medium · high · xhigh · max',
    enabled: false,
  },
  {
    key: 'tools',
    label: 'tool descriptions',
    detail: '',
    enabled: false,
    unavailable: 'strands-evals optimize cannot tune tool descriptions from an agent file yet',
  },
]

const MEASURED_ON: Record<TemporaryMeasurement, string> = {
  search: 'training cases',
  validation: 'validation cases',
  test: 'test cases',
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

class Store<State> {
  private readonly listeners = new Set<() => void>()

  constructor(private state: State) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly snapshot = (): State => this.state

  protected set(next: State): void {
    this.state = next
    for (const listener of this.listeners) listener()
  }
}

const shownPath = (workspace: DevWorkspace, path: string): string =>
  relative(dirname(temporaryWorkspaceDirectory(workspace)), path)

export class TemporaryDataset extends Store<DatasetState> implements DatasetSession {
  readonly notice = new TemporaryJobNotice()
  private opened: { path: string; raw: TemporaryExperimentDocument } | undefined
  private draft: { path: string; raw: TemporaryExperimentDocument } | undefined

  constructor(private readonly host: Host) {
    super({ step: 'loading' })
  }

  private folder(): string {
    return temporaryExperimentsFolder(temporaryWorkspaceDirectory(this.host().workspace))
  }

  refresh(): Promise<readonly ExperimentSummary[]> {
    if (this.snapshot().step === 'drafting' || this.hasUnsavedCases()) return Promise.resolve([])
    this.set({ step: 'loading' })
    return this.list()
  }

  show(): void {
    void this.refresh().then((experiments) => {
      const [only] = experiments
      if (experiments.length === 1 && only && this.snapshot().step === 'pick') this.open(only)
    })
  }

  private hasUnsavedCases(): boolean {
    const state = this.snapshot()
    return state.step === 'draft' && state.cases.some((item) => !item.saved)
  }

  open(experiment: ExperimentSummary): void {
    void this.load(experiment.path)
  }

  generate(): void {
    const state = this.snapshot()
    if (state.step === 'drafting') return
    const into = state.step === 'draft' && state.path ? state : undefined
    if (state.step === 'draft' && this.hasUnsavedCases()) {
      this.set({
        ...state,
        notice: { tone: 'error', text: 'Save or drop the drafted cases first, then press g again.' },
      })
      return
    }
    this.set({ step: 'drafting', startedAt: Date.now(), count: DRAFT_COUNT, ...(into ? { into: into.name } : {}) })
    this.notice.start(this.host().context, `experiment · drafting ${DRAFT_COUNT} cases with strands-evals`)
    void this.drafting(into)
  }

  toggle(index: number): void {
    this.edit((cases) => cases.map((item, position) => (position === index ? { ...item, kept: !item.kept } : item)))
  }

  drop(index: number): void {
    this.edit((cases) => cases.filter((_item, position) => position !== index))
  }

  keepAll(): void {
    this.edit((cases) => cases.map((item) => ({ ...item, kept: true })))
  }

  async save(): Promise<ExperimentSummary | undefined> {
    const state = this.snapshot()
    if (state.step !== 'draft') return undefined
    const kept = state.cases.filter((item) => item.kept)
    if (kept.length === 0) {
      this.set({
        ...state,
        notice: { tone: 'error', text: 'Keep at least one case with Space or a, then press Enter.' },
      })
      return undefined
    }
    try {
      const path = state.path ?? this.freePath()
      if (state.path && this.opened)
        await writeTemporaryExperimentFile(
          path,
          this.opened.raw,
          kept.filter((item) => item.saved).map((item) => item.name)
        )
      const fresh = kept.filter((item) => !item.saved).map((item) => item.name)
      if (this.draft && fresh.length > 0) {
        if (state.path) await appendTemporaryCases(path, this.draft.raw, fresh)
        else await writeTemporaryExperimentFile(path, this.draft.raw, fresh)
      }
      if (this.draft) await rm(this.draft.path, { force: true })
      return await this.load(path, {
        tone: 'success',
        text: `Saved ${plural(kept.length, 'case')} to ${shownPath(this.host().workspace, path)}`,
      })
    } catch (error) {
      this.set({ ...state, notice: { tone: 'error', text: `Could not save the cases: ${errorMessage(error)}` } })
      return undefined
    }
  }

  private freePath(): string {
    const plain = join(this.folder(), `${STARTER_NAME}.json`)
    return existsSync(plain) ? join(this.folder(), `${temporaryRunName(STARTER_NAME, new Date())}.json`) : plain
  }

  private edit(change: (cases: readonly DraftCase[]) => DraftCase[]): void {
    const state = this.snapshot()
    if (state.step !== 'draft') return
    const { notice: _notice, ...rest } = state
    this.set({ ...rest, cases: change(state.cases) })
  }

  private async list(): Promise<readonly ExperimentSummary[]> {
    const folder = this.folder()
    try {
      const experiments = await listTemporaryExperiments(folder)
      this.set(
        experiments.length === 0
          ? { step: 'empty', folder: shownPath(this.host().workspace, folder) }
          : { step: 'pick', experiments }
      )
      return experiments
    } catch (error) {
      this.set({ step: 'failed', message: `Could not read the experiments in ${folder}: ${errorMessage(error)}` })
      return []
    }
  }

  private async load(
    path: string,
    notice?: Extract<DatasetState, { step: 'draft' }>['notice']
  ): Promise<ExperimentSummary | undefined> {
    try {
      const { experiment, raw } = await readTemporaryExperimentFile(path)
      this.opened = { path, raw }
      this.draft = undefined
      this.set({
        step: 'draft',
        name: experiment.name,
        path,
        cases: experiment.cases.map((item) => ({ ...item, kept: true, saved: true })),
        drafted: 0,
        ...(notice ? { notice } : {}),
      })
      return { name: experiment.name, path, caseCount: experiment.cases.length }
    } catch (error) {
      this.set({ step: 'failed', message: errorMessage(error) })
      return undefined
    }
  }

  private async drafting(into: Extract<DatasetState, { step: 'draft' }> | undefined): Promise<void> {
    const { workspace, agent, dependencies } = this.host()
    try {
      const context = await temporaryAgentContext(workspace, agent())
      const outcome = await draftTemporaryExperiment(
        { workspace, context, count: DRAFT_COUNT, background: true },
        dependencies
      )
      const { experiment, raw } = await readTemporaryExperimentFile(outcome.path)
      if (this.draft) await rm(this.draft.path, { force: true })
      this.draft = { path: outcome.path, raw }
      const fresh = experiment.cases.map((item) => ({ ...item, kept: false, saved: false }))
      this.set({
        step: 'draft',
        name: into?.name ?? STARTER_NAME,
        ...(into?.path ? { path: into.path } : {}),
        cases: [...(into?.cases ?? []), ...fresh],
        drafted: fresh.length,
      })
      this.notice.finish('success', `experiment · drafted ${plural(fresh.length, 'case')} · /experiment reviews them`)
    } catch (error) {
      this.set({ step: 'failed', message: errorMessage(error) })
      this.notice.finish('error', 'experiment · drafting stopped · /experiment shows why')
    }
  }
}

const testProgressText = (state: Extract<TestState, { step: 'running' }>): string =>
  `test · ${state.experiment} · ${state.done}/${plural(state.cases, 'case')} run`

export class TemporaryTest extends Store<TestState> implements TestSession {
  readonly notice = new TemporaryJobNotice()
  private last: { experiment: ExperimentSummary; results: TestResults } | undefined

  constructor(
    private readonly host: Host,
    readonly dataset: TemporaryDataset
  ) {
    super({ step: 'dataset' })
  }

  run(experiment: ExperimentSummary): void {
    if (this.snapshot().step === 'running') return
    void this.execute(experiment, experiment.path, false)
  }

  show(): void {
    if (this.snapshot().step !== 'dataset') return
    void this.dataset.refresh().then((experiments) => {
      const [only] = experiments
      if (experiments.length === 1 && only && this.snapshot().step === 'dataset') this.run(only)
    })
  }

  rerunFailed(): void {
    const state = this.snapshot()
    if (state.step !== 'results' || !this.last) return
    const failed = state.results.cases.filter((item) => !item.passed).map((item) => item.name)
    if (failed.length > 0) void this.rerun(this.last.experiment, failed)
  }

  reset(): void {
    if (this.snapshot().step === 'running') return
    this.set({ step: 'dataset' })
    this.show()
  }

  private async rerun(experiment: ExperimentSummary, names: readonly string[]): Promise<void> {
    try {
      const { raw } = await readTemporaryExperimentFile(experiment.path)
      const named = {
        ...raw,
        cases: raw.cases.map((item, index) => ({ ...item, name: temporaryCaseName(item, index) })),
      }
      const folder = temporaryReportsFolder(temporaryWorkspaceDirectory(this.host().workspace))
      const path = join(folder, `${temporaryRunName(experiment.path, new Date())}-failed.json`)
      await mkdir(folder, { recursive: true })
      await writeTemporaryExperimentFile(path, named, names)
      await this.execute(experiment, path, true)
    } catch (error) {
      this.set({ step: 'failed', message: errorMessage(error) })
    }
  }

  private async execute(experiment: ExperimentSummary, cases: string, rerun: boolean): Promise<void> {
    const startedAt = Date.now()
    let stopCounting = (): void => undefined
    try {
      const { experiment: loaded } = await readTemporaryExperimentFile(cases)
      const running = {
        step: 'running' as const,
        experiment: experiment.name,
        cases: loaded.cases.length,
        evaluators: loaded.evaluators,
        done: 0,
        startedAt,
        rerun,
      }
      this.set(running)
      this.notice.start(this.host().context, testProgressText(running))
      const outcome = await runTemporaryTest(
        {
          workspace: this.host().workspace,
          experiment: cases,
          background: true,
          onStart: ({ cases: store }) => {
            stopCounting = watchTemporaryFileCount(store, (done) => {
              const state = this.snapshot()
              if (state.step !== 'running') return
              const next = { ...state, done }
              this.set(next)
              this.notice.update(testProgressText(next))
            })
          },
        },
        this.host().dependencies
      )
      stopCounting()
      const results = await readTemporaryTestResults(outcome.report, {
        experiment: experiment.name,
        seconds: (Date.now() - startedAt) / MILLISECONDS,
      })
      this.last = { experiment, results }
      this.set({ step: 'results', results })
      const passed = results.cases.filter((item) => item.passed).length
      this.notice.finish(
        'success',
        `test · ${experiment.name} · ${passed} of ${plural(results.cases.length, 'case')} passed · /test shows the results`
      )
    } catch (error) {
      this.set({ step: 'failed', message: errorMessage(error) })
      this.notice.finish('error', `test · ${experiment.name} stopped · /test shows why`)
    } finally {
      stopCounting()
    }
  }
}

const optimizeProgressText = (progress: OptimizeProgress): string => {
  const finished = progress.candidates.length + (progress.baseline === undefined ? 0 : 1)
  const best =
    progress.best && progress.baseline !== undefined
      ? ` · best ${progress.best.score.toFixed(2)} (baseline ${progress.baseline.toFixed(2)})`
      : ''
  return `optimize · run ${progress.run} · ${finished}/${progress.planned} candidates${best}`
}

export class TemporaryOptimize extends Store<OptimizeState> implements OptimizeSession {
  readonly notice = new TemporaryJobNotice()
  private evaluators = 1
  private abort: AbortController | undefined
  private stopping = false
  private readonly writers = new Map<number, (after: string) => Promise<void>>()

  constructor(
    private readonly host: Host,
    readonly dataset: TemporaryDataset
  ) {
    super({ step: 'dataset' })
  }

  plan(experiment: ExperimentSummary): void {
    void this.planFor(experiment)
  }

  show(): void {
    if (this.snapshot().step !== 'dataset') return
    void this.dataset.refresh().then((experiments) => {
      const [only] = experiments
      if (experiments.length === 1 && only && this.snapshot().step === 'dataset') this.plan(only)
    })
  }

  toggleKnob(key: KnobKey): void {
    this.updatePlan((plan) => ({
      ...plan,
      knobs: plan.knobs.map((knob) =>
        knob.key === key && !knob.unavailable ? { ...knob, enabled: !knob.enabled } : knob
      ),
    }))
  }

  setIterations(iterations: number): void {
    this.updatePlan((plan) =>
      plan.iterationChoices.includes(iterations) ? this.estimate({ ...plan, iterations }) : plan
    )
  }

  start(): void {
    const state = this.snapshot()
    if (state.step !== 'setup') return
    const tune = state.plan.knobs.filter((knob) => knob.enabled && !knob.unavailable).map((knob) => knob.key)
    if (tune.length > 0) void this.run(state.plan, tune)
  }

  stop(): void {
    const state = this.snapshot()
    if (state.step !== 'running' || !this.abort || this.stopping) return
    this.stopping = true
    this.set({ step: 'running', progress: { ...state.progress, stopping: true } })
    this.abort.abort()
  }

  accept(index: number, accepted: boolean): void {
    const state = this.snapshot()
    if (state.step !== 'review' || !this.writers.has(index)) return
    this.set({
      step: 'review',
      review: {
        ...state.review,
        edits: state.review.edits.map((edit, position) => (position === index ? { ...edit, accepted } : edit)),
      },
    })
  }

  apply(): void {
    void this.applyAccepted()
  }

  reset(): void {
    if (this.snapshot().step === 'running') return
    this.set({ step: 'dataset' })
    this.show()
  }

  private updatePlan(change: (plan: OptimizePlan) => OptimizePlan): void {
    const state = this.snapshot()
    if (state.step === 'setup') this.set({ step: 'setup', plan: change(state.plan) })
  }

  private estimate(plan: OptimizePlan): OptimizePlan {
    const { rollouts, judgeCalls } = temporaryRolloutEstimate({
      split: plan.split,
      repetitions: plan.repetitions,
      iterations: plan.iterations,
      width: plan.width,
      evaluators: this.evaluators,
    })
    return { ...plan, rollouts, judgeCalls }
  }

  private async planFor(summary: ExperimentSummary): Promise<void> {
    try {
      const { experiment } = await readTemporaryExperimentFile(summary.path)
      const caseCount = experiment.cases.length
      const split = temporaryCaseSplit(caseCount)
      const warning = temporaryOptimizeWarning(caseCount)
      this.evaluators = Math.max(1, experiment.evaluators.length)
      this.set({
        step: 'setup',
        plan: this.estimate({
          experiment: { ...summary, caseCount },
          knobs: KNOBS,
          split,
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
      this.set({ step: 'failed', message: errorMessage(error) })
    }
  }

  private async run(plan: OptimizePlan, tune: readonly KnobKey[]): Promise<void> {
    const abort = new AbortController()
    const startedAt = Date.now()
    this.abort = abort
    this.stopping = false
    let record: string | undefined
    let reader: ReturnType<typeof temporaryStudyReader> | undefined
    let tail: TemporaryTail | undefined
    const progress = (): OptimizeProgress =>
      reader
        ? { ...reader.progress(), planned: 1 + plan.iterations * plan.width, stopping: this.stopping }
        : {
            run: 'starting',
            record: '',
            metric: '',
            iterations: plan.iterations,
            planned: 1 + plan.iterations * plan.width,
            candidates: [],
            startedAt,
            stopping: this.stopping,
          }
    const show = (): void => {
      const current = progress()
      this.set({ step: 'running', progress: current })
      this.notice.update(optimizeProgressText(current))
    }
    this.set({ step: 'running', progress: progress() })
    this.notice.start(this.host().context, `optimize · ${plan.experiment.name} · starting`)
    try {
      await runTemporaryOptimization(
        {
          workspace: this.host().workspace,
          experiment: plan.experiment.path,
          forkArguments: ['--tune', tune.join(','), '--iterations', String(plan.iterations)],
          background: true,
          signal: abort.signal,
          onStart: (path) => {
            record = path
            reader = temporaryStudyReader({ run: basename(path), record: path, startedAt })
            tail = tailTemporaryLines(join(path, 'study.jsonl'), (line) => {
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
      if (!this.stopping || !record) {
        this.set({ step: 'failed', message: errorMessage(error), ...(record ? { record } : {}) })
        this.notice.finish('error', `optimize · ${plan.experiment.name} stopped · /optimize shows why`)
        return
      }
    } finally {
      this.abort = undefined
    }
    await this.finish(record!)
  }

  private async finish(record: string): Promise<void> {
    try {
      const review = await this.review(await readTemporaryStudy(record), record)
      this.set({ step: 'review', review })
      this.notice.finish('success', `optimize · run ${review.run} finished · /optimize opens the review`)
    } catch (error) {
      this.set({ step: 'failed', message: errorMessage(error), record })
      this.notice.finish('error', `optimize · run ${basename(record)} could not be read · /optimize shows why`)
    }
  }

  private async review(outcome: TemporaryStudyOutcome, record: string): Promise<OptimizeReview> {
    const { workspace } = this.host()
    this.writers.clear()
    const edits: ProposedEdit[] = []
    for (const knob of TUNABLE_KNOBS) {
      const before = outcome.baseline.params[knob]
      const after = outcome.best?.params[knob]
      if (before === undefined || after === undefined || String(before) === String(after)) continue
      const located = await locateTemporaryEdit({
        root: workspace.root,
        entrypoint: workspace.entrypoint,
        knob,
        before: String(before),
        after: String(after),
      })
      const writable = 'write' in located
      if (writable) this.writers.set(edits.length, located.write)
      edits.push({
        knob,
        label: knob,
        before: String(before),
        after: String(after),
        accepted: writable,
        ...(writable ? { target: located.target } : { unavailable: located.unavailable }),
      })
    }
    const baseline = outcome.baseline.score ?? 0
    return {
      run: basename(record),
      record,
      baseline,
      best: outcome.best?.score ?? baseline,
      measuredOn: MEASURED_ON[outcome.measuredOn],
      edits,
    }
  }

  private async applyAccepted(): Promise<void> {
    const state = this.snapshot()
    if (state.step !== 'review') return
    const applied: string[] = []
    let applyError: string | undefined
    for (const [index, edit] of state.review.edits.entries()) {
      const write = this.writers.get(index)
      if (!edit.accepted || !write) continue
      const target = edit.target ?? edit.label
      try {
        await write(edit.after)
        applied.push(target)
      } catch (error) {
        applyError = `Could not change ${target}: ${errorMessage(error)} Change it by hand, then run /test.`
        break
      }
    }
    this.set({ step: 'review', review: { ...state.review, applied, ...(applyError ? { applyError } : {}) } })
    const changed = applied.length > 0 ? `applied ${applied.join(', ')}` : 'changed nothing'
    this.host().context?.report(
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
  const dataset = new TemporaryDataset(current)
  const sessions = {
    dataset,
    test: new TemporaryTest(current, dataset),
    optimize: new TemporaryOptimize(current, dataset),
  }
  registry.set(key, {
    use: (next) => {
      latest = next
    },
    sessions,
  })
  return sessions
}
