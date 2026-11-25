import { existsSync } from 'node:fs'
import { readdir, readFile, rm } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'

import type { ChatToolInfo } from '../../agent/types.js'
import { errorMessage } from '../../terminal/text.js'
import type { DevChatJob } from '../../ui/chat/types.js'
import {
  isGenerating,
  type ExperimentsState,
  type ExperimentSummary,
  type Generation,
  type GenerationPhase,
  type GenerationSettings,
} from './model.js'
import { recordDevEvent } from '../telemetry.js'
import type { DevWorkspace } from '../workspace.js'
import {
  createEvalsExperimentCases,
  generateEvalsExperiment,
  generatorModelProblem,
  isEvalsExperimentName,
  listEvalsExperiments,
  readEvalsExperimentFile,
  evalsGenerationError,
  evalsGenerationFiles,
  evalsUniqueCaseNames,
  type EvalsExperimentDocument,
  type EvalsGenerationFiles,
} from './experiment.js'
import { evalsWorkspaceDirectory } from './evals-process.js'
import { evalsExperimentFile, evalsExperimentsFolder, watchEvalsExperiments } from './layout.js'
import { evalsWorkspaceReady } from './layout-migration.js'
import { announce, plural, evalsLinkText, type EvalsAgentFacts, type EvalsHost } from './host.js'
import { Store } from './jobs.js'

const SOURCE_LIMIT = 12_000
const NOTE_LIMIT = 4_000
const NOTE_COUNT = 4
const NOTE_EXTENSIONS = new Set(['.md', '.txt'])

const clip = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit)}\n[cut at ${limit} characters]` : text

const readText = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

const noteFiles = async (folders: readonly string[]): Promise<string[]> => {
  const found = await Promise.all(
    [...new Set(folders)].map(async (folder) => {
      try {
        const entries = await readdir(folder, { withFileTypes: true })
        return entries
          .filter((entry) => entry.isFile() && NOTE_EXTENSIONS.has(extname(entry.name).toLowerCase()))
          .map((entry) => join(folder, entry.name))
      } catch {
        return []
      }
    })
  )
  return found.flat().sort().slice(0, NOTE_COUNT)
}

const toolSection = (tools: readonly ChatToolInfo[]): string | undefined =>
  tools.length > 0
    ? ['Its tools:', ...tools.map(({ name, description }) => `- ${name}: ${description || 'no description'}`)].join(
        '\n'
      )
    : undefined

const summaryOf = (workspace: DevWorkspace, tools: readonly ChatToolInfo[], notes: readonly string[]): string =>
  [
    relative(workspace.root, workspace.entrypoint),
    ...(tools.length > 0 ? [plural(tools.length, 'tool')] : []),
    ...notes.map((path) => relative(workspace.root, path)),
  ].join(' · ')

export const evalsAgentContext = async (
  workspace: DevWorkspace,
  facts: EvalsAgentFacts
): Promise<{ text: string; summary: string }> => {
  const source = await readText(workspace.entrypoint)
  const notes = await noteFiles([dirname(workspace.entrypoint), workspace.root])
  const tools = facts.tools ?? []
  const noteSections = await Promise.all(
    notes.map(async (path) => {
      const text = await readText(path)
      return text?.trim() ? `The file ${relative(workspace.root, path)}:\n${clip(text, NOTE_LIMIT)}` : undefined
    })
  )
  const text = [
    `This is an AI agent named ${workspace.config.name}.`,
    facts.description ? `Its description: ${facts.description}` : undefined,
    toolSection(tools),
    source
      ? `Its source file ${relative(workspace.root, workspace.entrypoint)}:\n${clip(source, SOURCE_LIMIT)}`
      : undefined,
    ...noteSections,
    'Write realistic requests that users send to this agent, and the outcome that a good answer reaches.',
  ]
    .filter((section): section is string => Boolean(section))
    .join('\n\n')
  return { text, summary: summaryOf(workspace, tools, notes) }
}

const DEFAULT_CASES = 20
const NAME_STEM = 'experiment'

const PHASE_LABELS: Record<GenerationPhase, string> = {
  preparing: 'preparing',
  cases: 'writing cases',
  ready: 'ready',
  failed: 'stopped',
}

interface Job {
  generation: Generation
  readonly files: EvalsGenerationFiles
  readonly abort: AbortController
  cause?: string
  draft?: EvalsExperimentDocument
}

export const evalsGenerationJobs = ({ generations }: ExperimentsState): DevChatJob[] =>
  generations
    .filter(isGenerating)
    .map((generation) => ({ id: generation.id, label: `${generation.name} ${PHASE_LABELS[generation.phase]}` }))

export class EvalsExperiments extends Store<ExperimentsState> {
  private readonly jobs = new Map<string, Job>()
  private saved: readonly ExperimentSummary[] = []
  private summary = ''
  private reloading: Promise<readonly ExperimentSummary[]> | undefined
  private stopWatching: (() => void) | undefined
  private nextId = 1

  constructor(private readonly host: EvalsHost) {
    super({ folder: '', generations: [] })
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
      await evalsWorkspaceReady(this.directory())
      const [saved, context] = await Promise.all([
        listEvalsExperiments(folder),
        evalsAgentContext(this.host().workspace, this.host().agent()),
      ])
      this.saved = saved
      this.summary = context.summary
      this.watch(folder)
    } catch {
      // The folder cannot be read now. The last list stays, and the next reload reads again.
    }
    this.publish()
    return this.saved
  }

  agentSummary(): string {
    return this.summary
  }

  /** Starts a generation and saves its cases when it finishes; returns why it cannot start. */
  generateInBackground(settings: GenerationSettings): string | undefined {
    const named = { ...settings, name: settings.name.trim(), task: settings.task.trim() }
    const stopped = [...this.jobs.values()].find(
      ({ generation }) => generation.name === named.name && generation.phase === 'failed'
    )?.generation.id
    const problem = this.problemWith(named, stopped)
    if (problem) return problem
    if (stopped) this.forget(stopped)
    const job = this.start(named)
    void this.draft(job).then(async (drafted) => {
      if (!drafted || !job.draft) return this.announceFailure(job)
      await this.saveDraft(job, job.draft).catch((error: unknown) =>
        announce(this.host(), 'error', `experiment · ${named.name} · ${errorMessage(error)}`)
      )
    })
    return undefined
  }

  cancel(id: string): void {
    const job = this.jobs.get(id)
    if (!job || !isGenerating(job.generation)) return
    job.abort.abort()
    this.jobs.delete(id)
    this.publish()
  }

  private directory(): string {
    return evalsWorkspaceDirectory(this.host().workspace)
  }

  private watch(folder: string): void {
    if (this.stopWatching || !existsSync(folder)) return
    try {
      this.stopWatching = watchEvalsExperiments(
        folder,
        () => void this.reload(),
        () => {
          this.stopWatching = undefined
        }
      )
    } catch {
      // Without a watch, each reload still reads the folder.
    }
  }

  private folder(): string {
    return evalsExperimentsFolder(this.directory())
  }

  private publish(): void {
    this.set({
      folder: resolve(this.folder()),
      generations: [...this.jobs.values()].map(({ generation }) => generation).reverse(),
    })
  }

  suggested(): GenerationSettings {
    const facts = this.host().agent()
    return {
      name: this.freeName(),
      task: facts.description?.trim() || '',
      context: '',
      cases: DEFAULT_CASES,
      topics: 0,
      // A model ID alone does not identify the chat provider or its credentials.
      model: '',
    }
  }

  private isTaken(name: string, except?: string): boolean {
    return (
      this.saved.some((saved) => saved.name === name) ||
      [...this.jobs.values()].some(({ generation }) => generation.id !== except && generation.name === name) ||
      existsSync(join(this.folder(), name))
    )
  }

  private freeName(): string {
    let number = 1
    while (this.isTaken(`${NAME_STEM}-${number}`)) number++
    return `${NAME_STEM}-${number}`
  }

  private problemWith({ name, task, model }: GenerationSettings, replace: string | undefined): string | undefined {
    if (!isEvalsExperimentName(name))
      return 'Name the experiment with letters, numbers, dots, dashes, and underscores, for example refunds-v1.'
    if (this.isTaken(name, replace)) return `An experiment named ${name} exists already. Choose another name.`
    if (!task) return 'Describe the task of the agent, for example "Answer refund questions for an online store".'
    return generatorModelProblem(model)
  }

  private start(settings: GenerationSettings): Job {
    const files = evalsGenerationFiles(this.directory(), settings.name, new Date())
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
        log: resolve(files.log),
      },
      files,
      abort: new AbortController(),
    }
    this.jobs.set(id, job)
    this.publish()
    return job
  }

  private forget(id: string): void {
    const job = this.jobs.get(id)
    if (!job) return
    job.abort.abort()
    this.jobs.delete(id)
    if (!isGenerating(job.generation)) this.discardDraft(job)
  }

  private discardDraft(job: Job): void {
    // A draft that stays is in the drafts folder of the workspace, and nothing reads it again.
    void rm(job.files.draft, { force: true }).catch(() => undefined)
  }

  private update(job: Job, change: Partial<Generation>): void {
    if (this.jobs.get(job.generation.id) !== job) return
    job.generation = { ...job.generation, ...change }
    this.publish()
  }

  private async draft(job: Job): Promise<boolean> {
    const { workspace, agent, dependencies } = this.host()
    const { settings } = job.generation
    try {
      const context = await evalsAgentContext(workspace, agent())
      const extra = settings.context.trim()
      const outcome = await generateEvalsExperiment(
        {
          workspace,
          settings,
          context: extra ? `${context.text}\n\nMore context from the developer:\n${extra}` : context.text,
          files: job.files,
          signal: job.abort.signal,
          background: true,
          onGenerating: () => this.update(job, { phase: 'cases' }),
        },
        dependencies
      )
      if (this.jobs.get(job.generation.id) !== job) {
        this.discardDraft(job)
        return false
      }
      const { raw } = await readEvalsExperimentFile(outcome.path)
      job.draft = raw
      this.update(job, {
        phase: 'ready',
        made: raw.cases.length,
        failed: job.generation.failed + outcome.dropped,
      })
      recordDevEvent('experiment_created')
      return this.jobs.get(job.generation.id) === job
    } catch (error) {
      if (job.abort.signal.aborted || this.jobs.get(job.generation.id) !== job) {
        this.discardDraft(job)
        return false
      }
      job.cause = errorMessage(error)
      this.update(job, { phase: 'failed', error: evalsGenerationError(error, settings) })
      return false
    }
  }

  private announceFailure(job: Job): void {
    if (job.generation.phase !== 'failed' || this.jobs.get(job.generation.id) !== job) return
    const { name, error, log } = job.generation
    const cause = job.cause ? ` · strands-evals said: ${job.cause}` : ''
    announce(
      this.host(),
      'error',
      `experiment · ${name} stopped: ${error?.summary ?? 'generation failed'}${cause} · log in ${log}`
    )
  }

  private async saveDraft(job: Job, draft: EvalsExperimentDocument): Promise<void> {
    const { name } = job.generation
    const path = evalsExperimentFile(this.directory(), name)
    const shown = resolve(path)
    if (existsSync(path)) throw new Error(`${shown} exists already, so the cases stay in ${resolve(job.files.draft)}.`)
    const names = evalsUniqueCaseNames(draft.cases)
    const cases = draft.cases.map((item, index) => ({ ...item, name: names[index]! }))
    await createEvalsExperimentCases(path, draft, cases)
    this.forget(job.generation.id)
    await this.reload()
    const link = evalsLinkText(this.host(), { view: 'experiment', experiment: path })
    announce(this.host(), 'success', `experiment · ${name} · ${plural(cases.length, 'case')} saved to ${shown}${link}`)
  }
}
