import { generatorModelId } from './generator-model.js'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { errorMessage } from '../../terminal/text.js'
import { isRecord } from '../../values.js'
import type { GenerationError, GenerationSettings } from '../panels/model.js'
import type { DevWorkspace, DevWorkspaceConfig } from '../workspace.js'
import { temporaryCaseCount } from './experiment-files.js'
import { ignoreProgress, prepareTemporaryOptimizerEnvironment, type TemporaryCommandRunner } from './environment.js'
import { temporaryEvaluatorArguments } from './evaluators.js'
import {
  spawnTemporaryEvals,
  temporaryEvalsEnvironment,
  temporaryEvalsFailure,
  temporaryExperimentsFolder,
  temporaryRunName,
  temporaryWorkspaceDirectory,
  type TemporaryEvalsSpawner,
} from './evals-process.js'
import { tailTemporaryLines } from './jobs.js'

export type TemporaryGenerationEvent =
  | { readonly event: 'topics' }
  | { readonly event: 'cases'; readonly total: number }
  | {
      readonly event: 'case'
      readonly ok: boolean
      readonly done: number
      readonly failed: number
      readonly total: number
      readonly error?: string
    }
  | { readonly event: 'rubric' }
  | { readonly event: 'failed'; readonly error: string }

export interface TemporaryGenerationFiles {
  readonly draft: string
  readonly log: string
  readonly progress: string
}

export interface TemporaryGenerationRequest {
  readonly workspace: DevWorkspace
  readonly settings: GenerationSettings
  readonly context: string
  readonly files: TemporaryGenerationFiles
  readonly environment?: NodeJS.ProcessEnv
  readonly signal?: AbortSignal
  readonly background?: boolean
  readonly onEvent?: (event: TemporaryGenerationEvent) => void
  readonly onStatus?: (line: string) => void
}

export interface TemporaryGenerationOutcome {
  readonly path: string
  readonly cases: number
}

export interface TemporaryExperimentDependencies {
  run?: TemporaryCommandRunner
  spawnGenerator?: TemporaryEvalsSpawner
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const DRAFTS_FOLDER = 'drafts'
const SUMMARY_LIMIT = 140

export const isTemporaryExperimentName = (name: string): boolean => NAME.test(name)

export const temporaryDraftsFolder = (workspaceDirectory: string): string =>
  join(temporaryExperimentsFolder(workspaceDirectory), DRAFTS_FOLDER)

export const temporaryGenerationFiles = (
  workspaceDirectory: string,
  name: string,
  now: Date
): TemporaryGenerationFiles => {
  const stem = join(temporaryDraftsFolder(workspaceDirectory), temporaryRunName(name, now))
  return { draft: `${stem}.json`, log: `${stem}.log`, progress: `${stem}.progress.jsonl` }
}

export const temporaryGenerateArguments = (
  settings: GenerationSettings,
  context: string,
  files: TemporaryGenerationFiles,
  language: DevWorkspaceConfig['language']
): string[] => [
  '-m',
  'strands_evals.cli',
  'generate',
  '--context',
  context,
  '--task-description',
  settings.task,
  '--num-cases',
  String(settings.cases),
  ...(settings.topics > 0 ? ['--num-topics', String(settings.topics)] : []),
  ...temporaryEvaluatorArguments(settings.evaluators),
  '--temporary-agent-language',
  language,
  ...(settings.model.trim() ? ['--model', generatorModelId(settings.model)] : []),
  '--max-parallel-num-cases',
  String(settings.parallel),
  ...(settings.expectedOutput ? [] : ['--no-expected-output']),
  ...(settings.expectedTrajectory ? ['--expected-trajectory'] : []),
  ...(settings.expectedInteractions ? ['--expected-interactions'] : []),
  ...(settings.metadata ? ['--metadata'] : []),
  '--temporary-progress',
  files.progress,
  '--output',
  files.draft,
]

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

export const parseTemporaryGenerationEvent = (line: string): TemporaryGenerationEvent | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const error = typeof parsed.error === 'string' ? parsed.error : undefined
  switch (parsed.event) {
    case 'topics':
      return { event: 'topics' }
    case 'cases':
      return { event: 'cases', total: count(parsed.total) }
    case 'case':
      return {
        event: 'case',
        ok: parsed.ok === true,
        done: count(parsed.done),
        failed: count(parsed.failed),
        total: count(parsed.total),
        ...(error ? { error } : {}),
      }
    case 'rubric':
      return { event: 'rubric' }
    case 'failed':
      return { event: 'failed', error: error ?? 'strands-evals generate stopped' }
    default:
      return undefined
  }
}

const generatorNextStep = (code: number): string =>
  code === 2
    ? 'Change the evaluator or the setting that the error names, then try again.'
    : 'Check that your AWS credentials can call the generator model, then try again.'

export const generateTemporaryExperiment = async (
  request: TemporaryGenerationRequest,
  dependencies: TemporaryExperimentDependencies = {}
): Promise<TemporaryGenerationOutcome> => {
  const { workspace, settings, context, files, environment = process.env, signal } = request
  generatorModelId(settings.model) // Validate before installing dependencies or starting a paid job.
  const onEvent = request.onEvent ?? ignoreProgress
  const directory = temporaryWorkspaceDirectory(workspace)
  const python = await prepareTemporaryOptimizerEnvironment(
    { workspaceDirectory: directory, projectRoot: workspace.root, language: workspace.config.language },
    {
      ...(dependencies.run ? { run: dependencies.run } : {}),
      ...(signal ? { signal } : {}),
      onProgress: request.onStatus ?? ignoreProgress,
    }
  )
  signal?.throwIfAborted()
  await mkdir(dirname(files.draft), { recursive: true })
  request.onStatus?.('Starting strands-evals generate')
  const tail = tailTemporaryLines(files.progress, (line) => {
    const event = parseTemporaryGenerationEvent(line)
    if (event) onEvent(event)
  })
  let exit
  try {
    exit = await (dependencies.spawnGenerator ?? spawnTemporaryEvals)({
      command: python,
      args: temporaryGenerateArguments(settings, context, files, workspace.config.language),
      cwd: workspace.root,
      env: temporaryEvalsEnvironment(python, environment),
      ...(signal ? { signal } : {}),
      ...(request.background ? { background: true } : {}),
      log: files.log,
      onLine: ignoreProgress,
    })
  } finally {
    await tail.stop()
  }
  if (exit.code !== 0)
    throw temporaryEvalsFailure('strands-evals generate', exit, environment, generatorNextStep(exit.code))
  if (!existsSync(files.draft)) throw new Error(`strands-evals generate finished without writing ${files.draft}.`)
  const cases = await temporaryCaseCount(files.draft)
  if (cases === 0) {
    await rm(files.draft, { force: true })
    throw new Error('strands-evals generate wrote no cases, because every case failed.')
  }
  return { path: files.draft, cases }
}

interface Diagnosis {
  readonly pattern: RegExp
  readonly summary: (model: string, cause: string) => string
  readonly next: string
}

const REJECTED_FLAGS = /strands-evals generate stopped with exit code 2: (?:argument --[\w-]+: )?/u

const DIAGNOSES: readonly Diagnosis[] = [
  {
    pattern: REJECTED_FLAGS,
    summary: (_model, cause) => firstSentence(cause.replace(REJECTED_FLAGS, '')),
    next: 'Press Enter to change the evaluators or their settings in the chat. The error below names the problem.',
  },
  {
    pattern:
      /ExpiredToken|security token included in the request is (?:invalid|expired)|InvalidClientTokenId|UnrecognizedClientException|NoCredentialsError|Unable to locate credentials|CredentialRetrievalError|credentials? (?:have|has) expired/iu,
    summary: () => 'AWS credentials are missing or expired',
    next: 'Refresh your AWS credentials, then press r to retry.',
  },
  {
    pattern: /AccessDeniedException|not authorized to perform|(?:do not|don't) have access to the model/iu,
    summary: (model) => `Bedrock denied access to ${model}`,
    next: 'Press Enter and choose a model that your AWS account can use, then generate again.',
  },
  {
    pattern: /ThrottlingException|Too many requests|ModelThrottledException|Rate exceeded/iu,
    summary: () => 'Bedrock throttled the requests',
    next: 'Press Enter and lower Parallel, or press r to retry in a few minutes.',
  },
  {
    pattern:
      /model identifier is invalid|ResourceNotFoundException|on-demand throughput isn.t supported|ValidationException/iu,
    summary: (model) => `Bedrock cannot use ${model}`,
    next: 'Press Enter and fix the Model, then generate again.',
  },
  {
    pattern:
      /EndpointConnectionError|Could not connect to the endpoint|getaddrinfo|Name or service not known|ReadTimeout/iu,
    summary: () => 'Could not reach Bedrock',
    next: 'Check your network and your AWS region, then press r to retry.',
  },
]

const REFUSED_MODEL = /(?:inference-profile|foundation-model)\/([\w.:-]+)/u

const firstLine = (text: string): string => {
  const line = text.split('\n').find((candidate) => candidate.trim()) ?? text
  return line.length > SUMMARY_LIMIT ? `${line.slice(0, SUMMARY_LIMIT - 1)}…` : line
}

const firstSentence = (text: string): string => firstLine(text.split('. ')[0] ?? text).replace(/\.$/u, '')

export const temporaryGenerationError = (
  error: unknown,
  { settings, reported, log }: { settings: GenerationSettings; reported?: string; log: string }
): GenerationError => {
  const cause = reported ?? errorMessage(error)
  const diagnosis = DIAGNOSES.find(({ pattern }) => pattern.test(cause))
  const model = settings.model || REFUSED_MODEL.exec(cause)?.[1] || 'the default model'
  return {
    summary: diagnosis?.summary(model, cause) ?? firstLine(cause),
    detail: [
      diagnosis?.next ?? 'Read the log for the cause, then press r to retry.',
      `Log: ${log}`,
      '',
      `strands-evals said: ${cause}`,
    ].join('\n'),
  }
}
