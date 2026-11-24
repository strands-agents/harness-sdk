import { generatorModelId } from './generator-model.js'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { errorMessage } from '../../terminal/text.js'
import type { GenerationError, GenerationSettings } from '../panels/model.js'
import type { DevWorkspace } from '../workspace.js'
import { temporaryDropIncompleteCases } from './experiment-files.js'
import { ignoreProgress, prepareTemporaryOptimizerEnvironment, type TemporaryCommandRunner } from './environment.js'
import {
  spawnTemporaryEvals,
  temporaryEvalsEnvironment,
  temporaryEvalsFailure,
  temporaryWorkspaceDirectory,
  type TemporaryEvalsSpawner,
} from './evals-process.js'
import { temporaryDraftsFolder, temporaryRunStamp } from './layout.js'

export interface TemporaryGenerationFiles {
  readonly draft: string
  readonly log: string
}

export interface TemporaryGenerationRequest {
  readonly workspace: DevWorkspace
  readonly settings: GenerationSettings
  readonly context: string
  readonly files: TemporaryGenerationFiles
  readonly environment?: NodeJS.ProcessEnv
  readonly signal?: AbortSignal
  readonly background?: boolean
  readonly onGenerating?: () => void
  readonly onStatus?: (line: string) => void
}

export interface TemporaryGenerationOutcome {
  readonly path: string
  readonly cases: number
  readonly dropped: number
}

export interface TemporaryExperimentDependencies {
  run?: TemporaryCommandRunner
  spawnGenerator?: TemporaryEvalsSpawner
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const GENERATED_EVALUATOR = 'OutputEvaluator'
const SUMMARY_LIMIT = 140

export const isTemporaryExperimentName = (name: string): boolean => NAME.test(name)

export const temporaryGenerationFiles = (
  workspaceDirectory: string,
  name: string,
  now: Date
): TemporaryGenerationFiles => {
  const stem = join(temporaryDraftsFolder(workspaceDirectory), `${temporaryRunStamp(now)}-${name}`)
  return { draft: `${stem}.json`, log: `${stem}.log` }
}

export const temporaryGenerateArguments = (
  settings: GenerationSettings,
  context: string,
  files: TemporaryGenerationFiles
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
  '--evaluator',
  GENERATED_EVALUATOR,
  ...(settings.model.trim() ? ['--model', generatorModelId(settings.model)] : []),
  '--output',
  files.draft,
]

const EXCEPTION_LINE = /\b\w*(?:Error|Exception)\b/u

const lastException = (lines: readonly string[]): string | undefined =>
  [...lines]
    .reverse()
    .find((line) => EXCEPTION_LINE.test(line))
    ?.trim()

const generatorNextStep = (code: number): string =>
  code === 2
    ? 'Change the setting that the error names, then try again.'
    : 'Check that your AWS credentials can call the generator model, then try again.'

export const generateTemporaryExperiment = async (
  request: TemporaryGenerationRequest,
  dependencies: TemporaryExperimentDependencies = {}
): Promise<TemporaryGenerationOutcome> => {
  const { workspace, settings, context, files, environment = process.env, signal } = request
  generatorModelId(settings.model) // Validate before installing dependencies or starting a paid job.
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
  request.onGenerating?.()
  const exit = await (dependencies.spawnGenerator ?? spawnTemporaryEvals)({
    command: python,
    args: temporaryGenerateArguments(settings, context, files),
    cwd: workspace.root,
    env: temporaryEvalsEnvironment(python, environment),
    ...(signal ? { signal } : {}),
    ...(request.background ? { background: true } : {}),
    log: files.log,
    onLine: ignoreProgress,
  })
  if (exit.code !== 0)
    throw temporaryEvalsFailure('strands-evals generate', exit, environment, generatorNextStep(exit.code))
  if (!existsSync(files.draft)) throw new Error(`strands-evals generate finished without writing ${files.draft}.`)
  const { complete, dropped } = await temporaryDropIncompleteCases(files.draft)
  if (complete === 0) {
    await rm(files.draft, { force: true })
    const cause = lastException(exit.stderrTail)
    throw new Error(
      dropped > 0
        ? 'strands-evals generate wrote no case with both an input and an expected answer.'
        : `strands-evals generate wrote no cases, because every case failed${cause ? `: ${cause}` : '.'}`
    )
  }
  return { path: files.draft, cases: complete, dropped }
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
    next: 'Change the setting that the error below names in the chat, then generate again.',
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
    next: 'Press r to retry in a few minutes.',
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
  { settings, log }: { settings: GenerationSettings; log: string }
): GenerationError => {
  const cause = errorMessage(error)
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
