import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { errorMessage } from '../../terminal/text.js'
import type { DevChatJob } from '../../ui/chat/types.js'
import { recordDevEvent } from '../telemetry.js'
import {
  type ExperimentRun,
  type ExperimentSummary,
  type EvaluationResults,
  type EvaluationRun,
  type EvaluationState,
} from './model.js'
import {
  clearUnreadableCaseResults,
  dropEvalsRunRecord,
  isEvalsRunAlive,
  readEvalsRunRecords,
  saveEvalsRunRecord,
  waitForEvalsRun,
  type EvaluationRecord,
} from './background-runs.js'
import { evalsWorkspaceDirectory } from './evals-process.js'
import { evalsExperimentHome } from './layout.js'
import { evalsWorkspaceReady } from './layout-migration.js'
import { readEvalsExperimentFile, evalsCaseCount } from './experiment.js'
import { EvalsExperiments } from './experiments-session.js'
import { announce, plural, evalsLinkText, firstLine, type EvalsHost } from './host.js'
import { Store, watchEvalsFileCount } from './jobs.js'
import {
  readLatestEvaluationResults,
  readEvaluationResults,
  rememberEvaluationResults,
  runEvaluation,
} from './evaluate.js'

export const evalsEvaluateJobs = ({ runs }: EvaluationState): DevChatJob[] =>
  runs.flatMap(({ experiment, run }) =>
    run.status === 'running' ? [{ id: experiment.path, label: experiment.name, done: run.done, total: run.cases }] : []
  )

const STOPPED_BY_USER = 'You stopped the run.'

export class EvalsEvaluate extends Store<EvaluationState> {
  private readonly runs = new Map<string, ExperimentRun>()
  private readonly stops = new Map<string, AbortController>()
  private resumed: Promise<void> | undefined

  constructor(
    private readonly host: EvalsHost,
    readonly experiments: EvalsExperiments
  ) {
    super({ runs: [] })
  }

  run(experiments: readonly ExperimentSummary[]): void {
    for (const experiment of experiments) {
      if (this.isRunning(experiment.path)) continue
      this.starting(experiment, experiment.caseCount)
      recordDevEvent('evaluation_started')
      void this.execute(experiment, experiment.path)
    }
  }

  runOnly(experiment: ExperimentSummary, names: readonly string[]): void {
    if (this.isRunning(experiment.path) || names.length === 0) return
    this.starting(experiment, names.length)
    void this.execute(experiment, experiment.path, undefined, names)
  }

  stop(path: string): void {
    this.stops.get(path)?.abort()
  }

  resume(): Promise<void> {
    this.resumed ??= this.resumeRecords()
    return this.resumed
  }

  private async resumeRecords(): Promise<void> {
    const { problems } = await evalsWorkspaceReady(this.workspaceDirectory())
    if (problems.length > 0)
      announce(
        this.host(),
        'error',
        `strands dev could not move ${plural(problems.length, 'item')} to the new workspace layout · first: ${problems[0]}`
      )
    let records: EvaluationRecord[]
    try {
      records = await readEvalsRunRecords(this.workspaceDirectory())
    } catch (error) {
      announce(this.host(), 'error', `evaluate · strands dev cannot read the unfinished runs: ${errorMessage(error)}`)
      return
    }
    await Promise.all(records.map((record) => this.continueRun(record)))
  }

  private async continueRun(record: EvaluationRecord): Promise<void> {
    let experiment: ExperimentSummary | undefined
    try {
      const caseCount = await evalsCaseCount(record.experiment).catch(() => evalsCaseCount(record.cases))
      experiment = { name: basename(record.experiment, '.json'), path: record.experiment, caseCount }
      if (this.isRunning(experiment.path)) return
      if (await isEvalsRunAlive(record)) return await this.follow(experiment, record)
      if (existsSync(record.report)) {
        await this.finish(experiment, record.report, record.startedAt, record.only)
        return await dropEvalsRunRecord(record)
      }
      await clearUnreadableCaseResults(record.store)
      this.starting(experiment, record.only?.length ?? experiment.caseCount)
      announce(
        this.host(),
        'success',
        `evaluate · ${experiment.name} · resumed the run that stopped when strands dev closed`
      )
      await this.execute(experiment, record.cases, record, record.only)
    } catch (error) {
      if (experiment) this.update(experiment, { status: 'failed', message: errorMessage(error) })
      announce(
        this.host(),
        'error',
        `evaluate · ${basename(record.experiment, '.json')} could not resume · ${this.whereWhy(record, error)}`
      )
    }
  }

  private async follow(experiment: ExperimentSummary, record: EvaluationRecord): Promise<void> {
    const abort = new AbortController()
    this.stops.set(experiment.path, abort)
    let stopCounting = (): void => undefined
    try {
      const { experiment: loaded } = await readEvalsExperimentFile(record.cases)
      const running = {
        status: 'running' as const,
        cases: loaded.cases.length,
        done: 0,
      }
      this.update(experiment, running)
      stopCounting = watchEvalsFileCount(record.store, (done) => {
        if (this.isRunning(experiment.path)) this.update(experiment, { ...running, done })
      })
      await waitForEvalsRun(record, abort.signal)
      if (abort.signal.aborted) return this.update(experiment, { status: 'failed', message: STOPPED_BY_USER })
      if (!existsSync(record.report))
        throw new Error(
          `strands-evals run ended without writing ${record.report}. The full output is in ${record.log}.`
        )
      await this.finish(experiment, record.report, record.startedAt, record.only)
    } catch (error) {
      this.update(experiment, { status: 'failed', message: errorMessage(error) })
      announce(this.host(), 'error', `evaluate · ${experiment.name} stopped · ${this.whereWhy(record, error)}`)
    } finally {
      stopCounting()
      if (this.stops.get(experiment.path) === abort) this.stops.delete(experiment.path)
      await dropEvalsRunRecord(record)
    }
  }

  private async finish(
    experiment: ExperimentSummary,
    report: string,
    startedAt: number,
    only?: readonly string[]
  ): Promise<void> {
    const run = await readEvaluationResults(report, {
      experiment: experiment.name,
      seconds: (Date.now() - startedAt) / 1000,
    })
    const results = await this.remember(experiment, run, only)
    this.update(experiment, { status: 'done', results })
    const passed = results.cases.filter((item) => item.passed).length
    const total = `${passed} of ${plural(results.cases.length, 'case')} passed`
    const rerun = only
      ? `${run.cases.filter((item) => item.passed).length} of ${plural(run.cases.length, 'rerun case')} passed · `
      : ''
    const shown = resolve(results.report)
    const link = evalsLinkText(this.host(), { view: 'report', experiment: experiment.path })
    announce(this.host(), 'success', `evaluate · ${experiment.name} · ${rerun}${total} · report in ${shown}${link}`)
  }

  // A run without a report points at its log, or gives the error when it never started one.
  private whereWhy(record: EvaluationRecord | undefined, error: unknown): string {
    return record ? `run log in ${resolve(record.log)}` : firstLine(errorMessage(error))
  }

  private isRunning(path: string): boolean {
    return this.runs.get(path)?.run.status === 'running'
  }

  private workspaceDirectory(): string {
    return evalsWorkspaceDirectory(this.host().workspace)
  }

  async show(): Promise<void> {
    const saved = await this.experiments.reload()
    await Promise.all(saved.filter(({ path }) => !this.runs.has(path)).map((experiment) => this.restoreRun(experiment)))
  }

  private home(experiment: ExperimentSummary): string {
    return evalsExperimentHome(this.workspaceDirectory(), experiment.path)
  }

  private async remember(
    experiment: ExperimentSummary,
    results: EvaluationResults,
    only: readonly string[] | undefined
  ): Promise<EvaluationResults> {
    try {
      return await rememberEvaluationResults(this.home(experiment), results, only)
    } catch (error) {
      announce(
        this.host(),
        'error',
        `evaluate · ${experiment.name} · this report is not kept as the latest after a restart: ${errorMessage(error)}`
      )
      return results
    }
  }

  private async restoreRun(experiment: ExperimentSummary): Promise<void> {
    let run: EvaluationRun | undefined
    try {
      const results = await readLatestEvaluationResults(this.home(experiment))
      if (results) run = { status: 'done', results }
    } catch (error) {
      run = { status: 'failed', message: errorMessage(error) }
    }
    if (run && !this.runs.has(experiment.path)) this.update(experiment, run)
  }

  private update(experiment: ExperimentSummary, run: EvaluationRun): void {
    this.runs.set(experiment.path, { experiment, run })
    this.set({ runs: [...this.runs.values()] })
  }

  private starting(experiment: ExperimentSummary, cases: number): void {
    this.update(experiment, { status: 'running', cases, done: 0 })
  }

  private async execute(
    experiment: ExperimentSummary,
    cases: string,
    resumed?: EvaluationRecord,
    only?: readonly string[]
  ): Promise<void> {
    const startedAt = resumed?.startedAt ?? Date.now()
    const abort = new AbortController()
    this.stops.set(experiment.path, abort)
    let stopCounting = (): void => undefined
    let record: EvaluationRecord | undefined
    let saving: Promise<void> = Promise.resolve()
    const save = (next: EvaluationRecord): Promise<void> => {
      record = next
      saving = saving
        .then(() => saveEvalsRunRecord(next))
        .catch((error: unknown) =>
          announce(
            this.host(),
            'error',
            `evaluate · ${experiment.name} cannot save its run record, so it cannot resume after a restart: ${errorMessage(error)}`
          )
        )
      return saving
    }
    try {
      const { experiment: loaded } = await readEvalsExperimentFile(cases)
      const running = {
        status: 'running' as const,
        cases: only?.length ?? loaded.cases.length,
        done: 0,
      }
      this.update(experiment, running)
      const outcome = await runEvaluation(
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
              startedAt,
              ...(only ? { only } : {}),
              ...files,
            })
            stopCounting = watchEvalsFileCount(files.store, (done) => {
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
      announce(this.host(), 'error', `evaluate · ${experiment.name} stopped · ${this.whereWhy(record, error)}`)
    } finally {
      stopCounting()
      if (this.stops.get(experiment.path) === abort) this.stops.delete(experiment.path)
      await saving
      if (record) await dropEvalsRunRecord(record)
    }
  }
}
