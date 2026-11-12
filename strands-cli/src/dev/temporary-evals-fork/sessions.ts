import { mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { errorMessage } from '../../terminal/text.js'
import type { DevChatJob } from '../../ui/chat/types.js'
import {
  type ExperimentSummary,
  type Knob,
  type KnobKey,
  type OptimizePlan,
  type OptimizeProgress,
  type OptimizeReview,
  type OptimizeSession,
  type OptimizeState,
  type ProposedEdit,
  type TestResults,
  type TestSession,
  type TestState,
} from '../panels/model.js'
import { locateTemporaryEdit } from './apply.js'
import { temporaryReportsFolder, temporaryRunName, temporaryWorkspaceDirectory } from './evals-process.js'
import { readTemporaryExperimentFile, temporaryCaseName, writeTemporaryExperimentFile } from './experiment-files.js'
import { TemporaryExperiments } from './experiments-session.js'
import { announce, plural, type TemporaryHost, type TemporarySessionHost } from './host.js'
import { Store, tailTemporaryLines, watchTemporaryFileCount, type TemporaryTail } from './jobs.js'
import { runTemporaryOptimization } from './optimize.js'
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
import { runTemporaryTest } from './test.js'

export interface TemporaryDevSessions {
  readonly experiments: TemporaryExperiments
  readonly test: TemporaryTest
  readonly optimize: TemporaryOptimize
}

const DEFAULT_ITERATIONS = 4
const WIDTH = 4
const REPETITIONS = 1
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

const onlyReadyExperiment = (
  experiments: TemporaryExperiments,
  saved: readonly ExperimentSummary[]
): ExperimentSummary | undefined => {
  const [only] = saved
  const waiting = experiments.snapshot().generations.some(({ phase }) => phase !== 'failed')
  return saved.length === 1 && !waiting ? only : undefined
}

export const temporaryTestJobs = (state: TestState): DevChatJob[] =>
  state.step === 'running' ? [{ id: 'test', label: state.experiment, done: state.done, total: state.cases }] : []

export const temporaryOptimizeJobs = (state: OptimizeState): DevChatJob[] =>
  state.step === 'running'
    ? [
        {
          id: 'optimize',
          label: state.progress.run,
          done: state.progress.candidates.length + (state.progress.baseline === undefined ? 0 : 1),
          total: state.progress.planned,
        },
      ]
    : []

export class TemporaryTest extends Store<TestState> implements TestSession {
  private last: { experiment: ExperimentSummary; results: TestResults } | undefined

  constructor(
    private readonly host: TemporaryHost,
    readonly experiments: TemporaryExperiments
  ) {
    super({ step: 'pick' })
  }

  run(experiment: ExperimentSummary): void {
    if (this.snapshot().step === 'running') return
    void this.execute(experiment, experiment.path, false)
  }

  show(): void {
    if (this.snapshot().step !== 'pick') return
    void this.experiments.reload().then((saved) => {
      const only = onlyReadyExperiment(this.experiments, saved)
      if (only && this.snapshot().step === 'pick') this.run(only)
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
    this.set({ step: 'pick' })
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
      const outcome = await runTemporaryTest(
        {
          workspace: this.host().workspace,
          experiment: cases,
          background: true,
          onStart: ({ cases: store }) => {
            stopCounting = watchTemporaryFileCount(store, (done) => {
              const state = this.snapshot()
              if (state.step !== 'running') return
              this.set({ ...state, done })
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
      announce(
        this.host(),
        'success',
        `test · ${experiment.name} · ${passed} of ${plural(results.cases.length, 'case')} passed · /test shows the results`
      )
    } catch (error) {
      this.set({ step: 'failed', message: errorMessage(error) })
      announce(this.host(), 'error', `test · ${experiment.name} stopped · /test shows why`)
    } finally {
      stopCounting()
    }
  }
}

export class TemporaryOptimize extends Store<OptimizeState> implements OptimizeSession {
  private evaluators = 1
  private abort: AbortController | undefined
  private stopping = false
  private readonly writers = new Map<number, (after: string) => Promise<void>>()

  constructor(
    private readonly host: TemporaryHost,
    readonly experiments: TemporaryExperiments
  ) {
    super({ step: 'pick' })
  }

  plan(experiment: ExperimentSummary): void {
    void this.planFor(experiment)
  }

  show(): void {
    if (this.snapshot().step !== 'pick') return
    void this.experiments.reload().then((saved) => {
      const only = onlyReadyExperiment(this.experiments, saved)
      if (only && this.snapshot().step === 'pick') this.plan(only)
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
    this.set({ step: 'pick' })
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
    const show = (): void => this.set({ step: 'running', progress: progress() })
    this.set({ step: 'running', progress: progress() })
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
        announce(this.host(), 'error', `optimize · ${plan.experiment.name} stopped · /optimize shows why`)
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
      announce(this.host(), 'success', `optimize · run ${review.run} finished · /optimize opens the review`)
    } catch (error) {
      this.set({ step: 'failed', message: errorMessage(error), record })
      announce(this.host(), 'error', `optimize · run ${basename(record)} could not be read · /optimize shows why`)
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
  }
  registry.set(key, {
    use: (next) => {
      latest = { ...latest, ...next }
    },
    sessions,
  })
  return sessions
}
