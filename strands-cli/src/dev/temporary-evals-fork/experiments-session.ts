import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { errorMessage } from '../../terminal/text.js'
import type { DevChatJob } from '../../ui/chat/types.js'
import {
  isGenerating,
  type CaseChange,
  type DraftCase,
  type ExperimentSession,
  type ExperimentsState,
  type ExperimentSummary,
  type Generation,
  type GenerationPhase,
  type GenerationSettings,
  type Notice,
  type Review,
} from '../panels/model.js'
import { temporaryAgentContext } from './agent-context.js'
import { generatorModelProblem } from './generator-model.js'
import { temporaryCreateExperimentPrompt, temporaryRetryExperimentPrompt } from './create-experiment-skill.js'
import { temporaryExperimentsFolder, temporaryWorkspaceDirectory } from './evals-process.js'
import {
  generateTemporaryExperiment,
  isTemporaryExperimentName,
  temporaryDraftsFolder,
  temporaryGenerationError,
  temporaryGenerationFiles,
  type TemporaryGenerationEvent,
  type TemporaryGenerationFiles,
} from './experiment.js'
import {
  createTemporaryExperimentCases,
  listTemporaryExperiments,
  readTemporaryExperimentFile,
  temporaryBlankCase,
  temporaryCaseName,
  temporaryCaseText,
  writeTemporaryExperimentCases,
  type TemporaryExperimentDocument,
  type TemporaryRawCase,
} from './experiment-files.js'
import { announce, plural, shownPath, type TemporaryHost } from './host.js'
import { Store } from './jobs.js'

const DEFAULT_CASES = 10
const DEFAULT_PARALLEL = 4
const NAME_STEM = 'experiment'
const CASE_STEM = 'case'
const DRAFT_FILE = /^\d{8}-\d{6}-(.+)\.json$/u

const PHASE_LABELS: Record<GenerationPhase, string> = {
  preparing: 'preparing',
  planning: 'planning topics',
  cases: 'writing cases',
  rubric: 'writing the rubric',
  ready: 'ready',
  failed: 'stopped',
}

interface ReviewCase {
  readonly draft: DraftCase
  readonly raw: TemporaryRawCase
  readonly change: CaseChange
}

interface Job {
  generation: Generation
  readonly files: TemporaryGenerationFiles
  readonly abort: AbortController
  reported?: string
  cause?: string
  draft?: TemporaryExperimentDocument
  cases?: readonly ReviewCase[]
}

export interface TemporaryCreatedExperiment extends ExperimentSummary {
  readonly failed: number
  readonly cases: readonly DraftCase[]
}

interface OpenReview {
  readonly key: string
  readonly name: string
  readonly path?: string
  readonly raw: TemporaryExperimentDocument
  readonly cases: readonly ReviewCase[]
  readonly notice?: Notice
}

const reviewCases = (raw: TemporaryExperimentDocument, saved: boolean): ReviewCase[] =>
  raw.cases.map((rawCase, index) => {
    const expected = temporaryCaseText(rawCase.expected_output)
    return {
      raw: rawCase,
      change: {},
      draft: {
        name: temporaryCaseName(rawCase, index),
        input: temporaryCaseText(rawCase.input) ?? '',
        ...(expected === undefined ? {} : { expected }),
        kept: saved,
        saved,
      },
    }
  })

const withChange = (reviewCase: ReviewCase, change: CaseChange): ReviewCase => {
  const { expected: _expected, ...draft } = reviewCase.draft
  const expected = change.expected ?? reviewCase.draft.expected
  return {
    raw: reviewCase.raw,
    change: { ...reviewCase.change, ...change },
    draft: {
      ...draft,
      ...(change.input === undefined ? {} : { input: change.input }),
      ...(expected ? { expected } : {}),
      kept: true,
    },
  }
}

const freeCaseName = (cases: readonly ReviewCase[]): string => {
  const taken = new Set(cases.map(({ draft }) => draft.name))
  let number = cases.length + 1
  while (taken.has(`${CASE_STEM}-${number}`)) number++
  return `${CASE_STEM}-${number}`
}

const blankCase = (cases: readonly ReviewCase[], { input = '', expected = '' }: CaseChange): ReviewCase => {
  const name = freeCaseName(cases)
  return {
    raw: temporaryBlankCase(name, input, expected),
    change: {},
    draft: { name, input, ...(expected ? { expected } : {}), kept: true, saved: false },
  }
}

const rawOf = ({ raw, draft, change }: ReviewCase): TemporaryRawCase => ({
  ...raw,
  name: draft.name,
  ...(change.input === undefined ? {} : { input: change.input }),
  ...(change.expected === undefined ? {} : { expected_output: change.expected || null }),
})

const reviewOf = ({ key, name, path, cases, notice }: OpenReview): Review => ({
  key,
  name,
  ...(path ? { path } : {}),
  cases: cases.map(({ draft }) => draft),
  ...(notice ? { notice } : {}),
})

export const temporaryGenerationJobs = ({ generations }: ExperimentsState): DevChatJob[] =>
  generations.filter(isGenerating).map((generation) =>
    generation.phase === 'cases'
      ? {
          id: generation.id,
          label: generation.name,
          done: generation.made + generation.failed,
          total: generation.total,
        }
      : {
          id: generation.id,
          label: `${generation.name} ${PHASE_LABELS[generation.phase]}`,
        }
  )

export class TemporaryExperiments extends Store<ExperimentsState> implements ExperimentSession {
  private readonly jobs = new Map<string, Job>()
  private saved: readonly ExperimentSummary[] = []
  private loaded = false
  private error: string | undefined
  private summary = ''
  private opened: OpenReview | undefined
  private reloading: Promise<readonly ExperimentSummary[]> | undefined
  private nextId = 1

  constructor(private readonly host: TemporaryHost) {
    super({ loaded: false, folder: '', saved: [], generations: [] })
  }

  refresh(): void {
    void this.reload()
  }

  reload(): Promise<readonly ExperimentSummary[]> {
    this.reloading ??= this.readFolder().finally(() => {
      this.reloading = undefined
    })
    return this.reloading
  }

  private async readFolder(): Promise<readonly ExperimentSummary[]> {
    const folder = this.folder()
    try {
      const [saved, context] = await Promise.all([
        listTemporaryExperiments(folder),
        temporaryAgentContext(this.host().workspace, this.host().agent()),
      ])
      this.saved = saved
      this.summary = context.summary
      this.error = undefined
      await this.recoverDrafts()
    } catch (error) {
      this.error = `Could not read the experiments in ${folder}: ${errorMessage(error)}`
    }
    this.loaded = true
    this.publish()
    return this.saved
  }

  suggested(): GenerationSettings {
    return this.defaults()
  }

  agentSummary(): string {
    return this.summary
  }

  startInChat(): void {
    this.host().context?.submit(temporaryCreateExperimentPrompt())
  }

  retryInChat(id: string): void {
    const job = this.jobs.get(id)
    if (!job || isGenerating(job.generation)) return
    const { name, settings, error } = job.generation
    this.forget(id)
    this.publish()
    this.host().context?.submit(temporaryRetryExperimentPrompt(name, settings, error))
  }

  generate(settings: GenerationSettings, replace?: string): string | undefined {
    const named = { ...settings, name: settings.name.trim(), task: settings.task.trim() }
    const problem = this.problemWith(named, replace)
    if (problem) return problem
    if (replace) this.forget(replace)
    const job = this.start(named)
    void this.draft(job).then((drafted) => this.announceDraft(job, drafted))
    return undefined
  }

  async createExperiment(settings: GenerationSettings): Promise<TemporaryCreatedExperiment> {
    await this.reload()
    const named = { ...settings, name: settings.name.trim(), task: settings.task.trim() }
    const stopped = [...this.jobs.values()].find(
      ({ generation }) => generation.name === named.name && generation.phase === 'failed'
    )?.generation.id
    const problem = this.problemWith(named, stopped)
    if (problem) throw new Error(problem)
    if (stopped) this.forget(stopped)
    const job = this.start(named)
    if (!(await this.draft(job)) || !job.draft) {
      this.announceDraft(job, false)
      throw new Error(this.failureText(job))
    }
    return this.saveDraft(job, job.draft)
  }

  cancel(id: string): void {
    const job = this.jobs.get(id)
    if (!job || !isGenerating(job.generation)) return
    job.abort.abort()
    this.jobs.delete(id)
    this.publish()
  }

  dismiss(id: string): void {
    const job = this.jobs.get(id)
    if (!job || isGenerating(job.generation)) return
    this.forget(id)
    this.publish()
  }

  review(id: string): void {
    const job = this.jobs.get(id)
    if (!job?.draft || job.generation.phase !== 'ready') return
    this.opened = {
      key: id,
      name: job.generation.name,
      raw: job.draft,
      cases: job.cases ?? reviewCases(job.draft, false),
    }
    this.publish()
  }

  open(experiment: ExperimentSummary): void {
    void this.openSaved(experiment)
  }

  closeReview(): void {
    if (!this.opened) return
    const job = this.jobs.get(this.opened.key)
    if (job) job.cases = this.opened.cases
    this.opened = undefined
    this.publish()
  }

  toggle(index: number): void {
    this.change((cases) =>
      cases.map((item, position) =>
        position === index ? { ...item, draft: { ...item.draft, kept: !item.draft.kept } } : item
      )
    )
  }

  drop(index: number): void {
    this.change((cases) => cases.filter((_item, position) => position !== index))
  }

  keepAll(): void {
    this.change((cases) => cases.map((item) => ({ ...item, draft: { ...item.draft, kept: true } })))
  }

  edit(index: number, change: CaseChange): void {
    this.change((cases) => cases.map((item, position) => (position === index ? withChange(item, change) : item)))
  }

  add(change: CaseChange): void {
    this.change((cases) => [...cases, blankCase(cases, change)])
  }

  async save(): Promise<ExperimentSummary | undefined> {
    const opened = this.opened
    if (!opened) return undefined
    const kept = opened.cases.filter(({ draft }) => draft.kept)
    if (kept.length === 0)
      return this.note({ tone: 'error', text: 'Keep at least one case with Space or a, then press Enter.' })
    const path = opened.path ?? join(this.folder(), `${opened.name}.json`)
    const shown = shownPath(this.host().workspace, path)
    if (!opened.path && existsSync(path))
      return this.note({
        tone: 'error',
        text: `${shown} exists already, so nothing was saved. Move that file, then save again.`,
      })
    const cases = kept.map(rawOf)
    try {
      await (opened.path ? writeTemporaryExperimentCases : createTemporaryExperimentCases)(path, opened.raw, cases)
    } catch (error) {
      return this.note({ tone: 'error', text: `Could not save the cases to ${shown}: ${errorMessage(error)}` })
    }
    if (!opened.path) this.forget(opened.key)
    await this.reload()
    const raw = { ...opened.raw, cases }
    this.opened = {
      key: path,
      name: opened.name,
      path,
      raw,
      cases: reviewCases(raw, true),
      notice: { tone: 'success', text: `Saved ${plural(cases.length, 'case')} to ${shown}` },
    }
    this.publish()
    return { name: opened.name, path, caseCount: cases.length }
  }

  private directory(): string {
    return temporaryWorkspaceDirectory(this.host().workspace)
  }

  private folder(): string {
    return temporaryExperimentsFolder(this.directory())
  }

  private publish(): void {
    this.set({
      loaded: this.loaded,
      folder: shownPath(this.host().workspace, this.folder()),
      saved: this.saved,
      generations: [...this.jobs.values()].map(({ generation }) => generation).reverse(),
      ...(this.opened ? { review: reviewOf(this.opened) } : {}),
      ...(this.error ? { error: this.error } : {}),
    })
  }

  private note(notice: Notice): undefined {
    if (this.opened) this.opened = { ...this.opened, notice }
    this.publish()
    return undefined
  }

  private change(update: (cases: readonly ReviewCase[]) => readonly ReviewCase[]): void {
    if (!this.opened) return
    const { notice: _notice, ...opened } = this.opened
    this.opened = { ...opened, cases: update(opened.cases) }
    this.publish()
  }

  private defaults(): GenerationSettings {
    const facts = this.host().agent()
    return {
      name: this.freeName(),
      task: facts.description?.trim() || '',
      context: '',
      cases: DEFAULT_CASES,
      topics: 0,
      evaluators: [{ name: 'OutputEvaluator' }],
      // A model ID alone does not identify the chat provider or its credentials.
      model: '',
      parallel: DEFAULT_PARALLEL,
      expectedOutput: true,
      expectedTrajectory: false,
      expectedInteractions: false,
      metadata: false,
    }
  }

  private takenNames(except?: string): Set<string> {
    return new Set([
      ...this.saved.map(({ name }) => name),
      ...[...this.jobs.values()]
        .filter(({ generation }) => generation.id !== except)
        .map(({ generation }) => generation.name),
    ])
  }

  private isTaken(name: string, except?: string): boolean {
    return this.takenNames(except).has(name) || existsSync(join(this.folder(), `${name}.json`))
  }

  private freeName(): string {
    let number = 1
    while (this.isTaken(`${NAME_STEM}-${number}`)) number++
    return `${NAME_STEM}-${number}`
  }

  private problemWith({ name, task, model }: GenerationSettings, replace: string | undefined): string | undefined {
    if (!isTemporaryExperimentName(name))
      return 'Name the experiment with letters, numbers, dots, dashes, and underscores, for example refunds-v1.'
    if (this.isTaken(name, replace)) return `An experiment named ${name} exists already. Choose another name.`
    if (!task) return 'Describe the task of the agent, for example "Answer refund questions for an online store".'
    return generatorModelProblem(model)
  }

  private start(settings: GenerationSettings): Job {
    const job = this.track(settings, temporaryGenerationFiles(this.directory(), settings.name, new Date()))
    this.publish()
    return job
  }

  private track(settings: GenerationSettings, files: TemporaryGenerationFiles): Job {
    const id = `generation-${this.nextId++}`
    const job: Job = {
      generation: {
        id,
        name: settings.name,
        settings,
        phase: 'preparing',
        made: 0,
        failed: 0,
        total: settings.cases,
        startedAt: Date.now(),
        status: 'Preparing the evals environment',
        log: shownPath(this.host().workspace, files.log),
      },
      files,
      abort: new AbortController(),
    }
    this.jobs.set(id, job)
    return job
  }

  private forget(id: string): void {
    const job = this.jobs.get(id)
    if (!job) return
    job.abort.abort()
    this.jobs.delete(id)
    if (this.opened?.key === id) this.opened = undefined
    if (!isGenerating(job.generation)) this.discardDraft(job)
  }

  private discardDraft(job: Job): void {
    void rm(job.files.draft, { force: true }).catch((error: unknown) => {
      this.error = `Could not delete the draft ${job.files.draft}: ${errorMessage(error)}`
      this.publish()
    })
  }

  private update(job: Job, change: Partial<Generation>): void {
    if (this.jobs.get(job.generation.id) !== job) return
    job.generation = { ...job.generation, ...change }
    this.publish()
  }

  private changeFor(job: Job, event: TemporaryGenerationEvent): Partial<Generation> {
    switch (event.event) {
      case 'topics':
        return { phase: 'planning', status: `Planning ${job.generation.settings.topics} topics` }
      case 'cases':
        return { phase: 'cases', total: event.total, status: 'Writing cases' }
      case 'case':
        if (event.error) job.reported = event.error
        return {
          phase: 'cases',
          made: event.done,
          failed: event.failed,
          total: event.total,
          ...(event.error ? { caseError: event.error } : {}),
        }
      case 'rubric':
        return { phase: 'rubric', status: 'Writing the rubric' }
      case 'failed':
        job.reported = event.error
        return {}
    }
  }

  private async draft(job: Job): Promise<boolean> {
    const { workspace, agent, dependencies } = this.host()
    const { settings } = job.generation
    try {
      const context = await temporaryAgentContext(workspace, agent())
      const extra = settings.context.trim()
      const outcome = await generateTemporaryExperiment(
        {
          workspace,
          settings,
          context: extra ? `${context.text}\n\nMore context from the developer:\n${extra}` : context.text,
          files: job.files,
          signal: job.abort.signal,
          background: true,
          onStatus: (status) => this.update(job, { status }),
          onEvent: (event) => this.update(job, this.changeFor(job, event)),
        },
        dependencies
      )
      if (this.jobs.get(job.generation.id) !== job) {
        this.discardDraft(job)
        return false
      }
      const { raw } = await readTemporaryExperimentFile(outcome.path)
      job.draft = raw
      this.update(job, { phase: 'ready', made: raw.cases.length, endedAt: Date.now() })
      return this.jobs.get(job.generation.id) === job
    } catch (error) {
      if (job.abort.signal.aborted || this.jobs.get(job.generation.id) !== job) {
        this.discardDraft(job)
        return false
      }
      job.cause = job.reported ?? errorMessage(error)
      const failure = temporaryGenerationError(error, {
        settings,
        ...(job.reported ? { reported: job.reported } : {}),
        log: job.generation.log,
      })
      this.update(job, { phase: 'failed', error: failure, endedAt: Date.now() })
      return false
    }
  }

  private announceDraft(job: Job, drafted: boolean): void {
    const { name } = job.generation.settings
    if (drafted) {
      const failed = job.generation.failed > 0 ? `, ${job.generation.failed} failed` : ''
      announce(
        this.host(),
        'success',
        `experiment · ${name} · ${plural(job.generation.made, 'case')} drafted${failed} · /experiment to review`
      )
    } else if (job.generation.phase === 'failed' && this.jobs.get(job.generation.id) === job) {
      announce(
        this.host(),
        'error',
        `experiment · ${name} stopped: ${job.generation.error?.summary ?? 'generation failed'} · /experiment shows why`
      )
    }
  }

  private failureText(job: Job): string {
    const { name, phase, error, log } = job.generation
    if (phase !== 'failed') return `The generation of ${name} was cancelled.`
    return [
      `The generation of ${name} stopped: ${error?.summary ?? 'unknown error'}.`,
      ...(job.cause ? [`strands-evals said: ${job.cause}`] : []),
      `Log: ${log}`,
    ].join('\n')
  }

  private async saveDraft(job: Job, draft: TemporaryExperimentDocument): Promise<TemporaryCreatedExperiment> {
    const { name } = job.generation
    const path = join(this.folder(), `${name}.json`)
    const shown = shownPath(this.host().workspace, path)
    if (existsSync(path)) {
      throw new Error(`${shown} exists already, so the cases stay a draft. Open /experiment to review and save them.`)
    }
    const cases = reviewCases(draft, false)
    await createTemporaryExperimentCases(path, draft, cases.map(rawOf))
    this.forget(job.generation.id)
    await this.reload()
    announce(this.host(), 'success', `experiment · ${name} · ${plural(cases.length, 'case')} saved to ${shown}`)
    return {
      name,
      path,
      caseCount: cases.length,
      failed: job.generation.failed,
      cases: cases.map(({ draft: item }) => ({ ...item, kept: true, saved: true })),
    }
  }

  private async openSaved(experiment: ExperimentSummary): Promise<void> {
    try {
      const { raw } = await readTemporaryExperimentFile(experiment.path)
      this.opened = {
        key: experiment.path,
        name: experiment.name,
        path: experiment.path,
        raw,
        cases: reviewCases(raw, true),
      }
    } catch (error) {
      this.error = errorMessage(error)
    }
    this.publish()
  }

  private async recoverDrafts(): Promise<void> {
    const folder = temporaryDraftsFolder(this.directory())
    if (!existsSync(folder)) return
    const known = new Set([...this.jobs.values()].map(({ files }) => files.draft))
    for (const file of (await readdir(folder)).sort()) {
      const name = DRAFT_FILE.exec(file)?.[1]
      const draft = join(folder, file)
      if (!name || known.has(draft)) continue
      const stem = draft.slice(0, -'.json'.length)
      const job = this.track(
        { ...this.defaults(), name },
        { draft, log: `${stem}.log`, progress: `${stem}.progress.jsonl` }
      )
      const recovered = { status: 'Drafted in an earlier strands dev session', endedAt: Date.now() }
      try {
        const { raw } = await readTemporaryExperimentFile(draft)
        job.draft = raw
        job.generation = {
          ...job.generation,
          ...recovered,
          phase: 'ready',
          made: raw.cases.length,
          total: raw.cases.length,
        }
      } catch (error) {
        const detail = `${errorMessage(error)}\nDelete ${shownPath(this.host().workspace, draft)}, or press d to dismiss it.`
        job.generation = {
          ...job.generation,
          ...recovered,
          phase: 'failed',
          error: { summary: 'The draft cannot be read', detail },
        }
      }
    }
  }
}
