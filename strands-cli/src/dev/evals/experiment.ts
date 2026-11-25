import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { link, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { errorMessage } from '../../terminal/text.js'
import { isRecord } from '../../values.js'
import {
  missingCaseField,
  type EvalCase,
  type Experiment,
  type ExperimentSummary,
  type GenerationError,
  type GenerationSettings,
} from '../panels/model.js'
import type { DevWorkspace } from '../workspace.js'
import { ignoreProgress, prepareEvalsOptimizerEnvironment, type EvalsCommandRunner } from './environment.js'
import { runEvals, evalsFailure, evalsWorkspaceDirectory, type EvalsSpawner } from './evals-process.js'
import { listEvalsExperimentFiles, evalsDraftsFolder, evalsRunStamp } from './layout.js'

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

export const isEvalsExperimentName = (name: string): boolean => NAME.test(name)

type EvalsExperimentUse = 'optimize' | 'evaluate'

export type EvalsRawCase = Readonly<Record<string, unknown>>

export interface EvalsExperimentDocument {
  readonly cases: readonly EvalsRawCase[]
  readonly [field: string]: unknown
}

interface EvalsExperimentFile {
  readonly experiment: Experiment
  readonly raw: EvalsExperimentDocument
}

const isFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return false
    throw error
  }
}

const listed = (names: readonly string[]): string => names.map((name) => basename(name, '.json')).join(', ')

const missingExperiment = (
  folder: string,
  requested: string,
  names: readonly string[],
  use: EvalsExperimentUse
): Error => {
  if (!isEvalsExperimentName(requested))
    return new Error(
      `No experiment file at ${resolve(requested)}. Check the path, or name an experiment in ${folder}` +
        (names.length > 0 ? `: ${listed(names)}.` : '.')
    )
  return new Error(
    names.length > 0
      ? `No experiment named ${requested} in ${folder}. Use one of ${listed(names)}, or draft cases with ` +
          '/experiment in a strands dev chat.'
      : `No experiment named ${requested} yet. Draft cases with /experiment in a strands dev chat, ` +
          `then run strands dev ${use} again.`
  )
}

export const resolveEvalsExperiment = async (
  folder: string,
  requested?: string,
  use: EvalsExperimentUse = 'optimize'
): Promise<string> => {
  const names = await listEvalsExperimentFiles(folder)
  if (requested) {
    for (const candidate of [resolve(requested), join(folder, requested, `${requested}.json`)]) {
      if (await isFile(candidate)) return candidate
    }
    throw missingExperiment(folder, requested, names, use)
  }
  if (names.length === 1) return names[0]!
  if (names.length === 0)
    throw new Error(
      `There is no experiment to ${use} yet. Draft cases with /experiment in a strands dev chat, ` +
        `or save an Experiment JSON file as ${join(folder, '<name>', '<name>.json')}.`
    )
  const example = basename(names[0]!, '.json')
  throw new Error(
    `${folder} has more than one experiment: ${listed(names)}. Name the one to use, for example ` +
      `strands dev ${use} ${example}, or pick one in the /${use} panel of a strands dev chat.`
  )
}

export const evalsCaseCount = async (path: string): Promise<number> => {
  let experiment: unknown
  try {
    experiment = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(
      `${path} is not a usable Experiment file (${errorMessage(error)}). Fix the file, or draft new cases ` +
        'with /experiment, then try again.',
      { cause: error }
    )
  }
  return isRecord(experiment) && Array.isArray(experiment.cases) ? experiment.cases.length : 0
}

export const evalsCaseName = (raw: EvalsRawCase, index: number): string =>
  typeof raw.name === 'string' && raw.name ? raw.name : `case_${index}`

const UNSAFE_FILE_NAME_CHARACTERS = /[\\/:*?"<>|]/gu

const uniqueFileNames = (): ((name: string) => string) => {
  const taken = new Set<string>()
  return (name) => {
    const safe = name.replace(UNSAFE_FILE_NAME_CHARACTERS, '-')
    let unique = safe
    for (let copy = 2; taken.has(unique.toLowerCase()); copy++) unique = `${safe}-${copy}`
    taken.add(unique.toLowerCase())
    return unique
  }
}

export const evalsUniqueCaseNames = (cases: readonly EvalsRawCase[]): string[] => {
  const unique = uniqueFileNames()
  return cases.map((rawCase, index) => unique(evalsCaseName(rawCase, index)))
}

export const evalsNamedExperiment = (raw: EvalsExperimentDocument): EvalsExperimentDocument => {
  const names = evalsUniqueCaseNames(raw.cases)
  return { ...raw, cases: raw.cases.map((rawCase, index) => ({ ...rawCase, name: names[index] })) }
}

export const evalsCaseText = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined
  return typeof value === 'string' ? value : JSON.stringify(value)
}

const hasText = (value: unknown): boolean => Boolean(evalsCaseText(value)?.trim())

const expectedField = (raw: EvalsRawCase): 'expected_output' | 'expected_assertion' =>
  !hasText(raw.expected_output) && hasText(raw.expected_assertion) ? 'expected_assertion' : 'expected_output'

export const evalsCaseExpected = (raw: EvalsRawCase): string | undefined => evalsCaseText(raw[expectedField(raw)])

const unusableExperiment = (path: string, detail: string, cause?: unknown): Error =>
  new Error(`${path} is not a usable Experiment file (${detail}). Fix the file or delete it, then try again.`, {
    cause,
  })

const evalCase = (raw: EvalsRawCase, index: number): EvalCase => {
  const expected = evalsCaseExpected(raw)
  return {
    name: evalsCaseName(raw, index),
    input: evalsCaseText(raw.input) ?? '',
    ...(expected === undefined ? {} : { expected }),
  }
}

const evaluatorNames = (evaluators: unknown): string[] =>
  (Array.isArray(evaluators) ? evaluators : []).filter(isRecord).flatMap((evaluator) => {
    const name = [evaluator.name, evaluator.evaluator_type].find((value) => typeof value === 'string' && value)
    return typeof name === 'string' ? [name] : []
  })

export const listEvalsExperiments = async (folder: string): Promise<ExperimentSummary[]> => {
  const summaries = await Promise.all(
    (await listEvalsExperimentFiles(folder)).map(async (path) => ({
      name: basename(path, '.json'),
      path,
      caseCount: await evalsCaseCount(path).catch(() => 0),
    }))
  )
  return summaries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

export const readEvalsExperimentFile = async (path: string): Promise<EvalsExperimentFile> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw unusableExperiment(path, errorMessage(error), error)
  }
  const cases = isRecord(parsed) ? parsed.cases : undefined
  if (!isRecord(parsed) || !Array.isArray(cases) || !cases.every(isRecord))
    throw unusableExperiment(path, 'it has no list of cases')
  const raw: EvalsExperimentDocument = { ...parsed, cases }
  return {
    experiment: {
      name: basename(path, '.json'),
      path,
      cases: cases.map(evalCase),
      evaluators: evaluatorNames(parsed.evaluators),
    },
    raw,
  }
}

const pickCases = (raw: EvalsExperimentDocument, names: readonly string[]): EvalsRawCase[] => {
  const byName = new Map<string, EvalsRawCase[]>()
  raw.cases.forEach((rawCase, index) => {
    const name = evalsCaseName(rawCase, index)
    byName.set(name, [...(byName.get(name) ?? []), rawCase])
  })
  return names.map((name) => {
    const picked = byName.get(name)?.shift()
    if (!picked) throw new Error(`The experiment has no case named ${name}, so nothing was written.`)
    return picked
  })
}

const writeDocument = async (
  path: string,
  document: EvalsExperimentDocument,
  place: (staging: string, path: string) => Promise<void> = rename
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  const staging = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(staging, `${JSON.stringify(document, null, 2)}\n`)
    await place(staging, path)
  } finally {
    await rm(staging, { force: true })
  }
}

const placeNew = async (staging: string, path: string): Promise<void> => {
  try {
    await link(staging, path)
  } catch (error) {
    if (isRecord(error) && error.code === 'EEXIST')
      throw new Error(`${path} exists already, so nothing was saved.`, { cause: error })
    throw error
  }
}

export const writeEvalsExperimentFile = async (
  path: string,
  raw: EvalsExperimentDocument,
  cases: readonly string[]
): Promise<void> => writeDocument(path, { ...raw, cases: pickCases(raw, cases) })

export const readEvalsRunnableCases = async (path: string): Promise<EvalCase[]> => {
  const { raw } = await readEvalsExperimentFile(path)
  return evalsNamedExperiment(raw).cases.map(evalCase)
}

export const evalsRunnableExperiment = async (path: string, copy: string): Promise<string> => {
  const { raw } = await readEvalsExperimentFile(path)
  const named = evalsNamedExperiment(raw)
  if (named.cases.every(({ name }, index) => name === raw.cases[index]?.name)) return path
  await writeDocument(copy, named)
  return copy
}

export const evalsDropIncompleteCases = async (
  path: string
): Promise<{ readonly complete: number; readonly dropped: number }> => {
  const { raw } = await readEvalsExperimentFile(path)
  const complete = raw.cases.filter((rawCase, index) => !missingCaseField(evalCase(rawCase, index)))
  const dropped = raw.cases.length - complete.length
  if (dropped > 0) await writeDocument(path, { ...raw, cases: complete })
  return { complete: complete.length, dropped }
}

export const createEvalsExperimentCases = async (
  path: string,
  raw: EvalsExperimentDocument,
  cases: readonly EvalsRawCase[]
): Promise<void> => writeDocument(path, { ...raw, cases }, placeNew)

const CHECK_EVALUATORS: ReadonlySet<string> = new Set([
  'Equals',
  'Contains',
  'StartsWith',
  'ToolCalled',
  'SkillInvoked',
  'StructuredOutputSimilarity',
  'StateEquals',
])

export const evalsJudgeEvaluatorCount = (evaluators: unknown): number =>
  (Array.isArray(evaluators) ? evaluators : [])
    .filter(isRecord)
    .filter(({ evaluator_type: type }) => typeof type !== 'string' || !CHECK_EVALUATORS.has(type)).length

/** The evals CLI takes an SDK model string, not the chat's provider configuration. */
const BEDROCK_ID =
  /^(?:(?:us|eu|apac|global|jp|au|ca|us-gov)\.)?(?:anthropic|amazon|meta|mistral|cohere|ai21|deepseek|qwen|writer)\.[\w.:-]+$/u
const OPENAI_BEDROCK_ID = /^(?:(?:us|eu|apac|global|jp|au|ca|us-gov)\.)?openai\.[\w.:-]+$/u

export const generatorModelProblem = (model: string): string | undefined => {
  if (!model.trim()) return undefined
  const value = model.trim()
  const explicit = value.startsWith('bedrock/')
  const id = explicit ? value.slice('bedrock/'.length) : value
  const arn =
    /^arn:(?:aws|aws-us-gov|aws-cn):bedrock:[a-z0-9-]+:\d*:(?:foundation-model|inference-profile|application-inference-profile)\/[\w./:-]+$/u.test(
      id
    )
  if (arn || BEDROCK_ID.test(id) || (explicit && OPENAI_BEDROCK_ID.test(id))) return undefined
  return (
    'Experiment generation uses a separate AWS Bedrock connection, not the chat provider. ' +
    `Cannot use ${JSON.stringify(value)} as a generator model. Choose a Bedrock model ID, or leave model empty for the evals SDK default. ` +
    'For OpenAI models hosted on Bedrock, use bedrock/<Bedrock model ID> explicitly. This does not change the chat model.'
  )
}

export const generatorModelId = (model: string): string => {
  const problem = generatorModelProblem(model)
  if (problem) throw new Error(problem)
  return model.trim().replace(/^bedrock\//u, '')
}

export interface EvalsGenerationFiles {
  readonly draft: string
  readonly log: string
}

interface EvalsGenerationRequest {
  readonly workspace: DevWorkspace
  readonly settings: GenerationSettings
  readonly context: string
  readonly files: EvalsGenerationFiles
  readonly signal?: AbortSignal
  readonly background?: boolean
  readonly onGenerating?: () => void
  readonly onStatus?: (line: string) => void
}

interface EvalsGenerationOutcome {
  readonly path: string
  readonly cases: number
  readonly dropped: number
}

export interface EvalsExperimentDependencies {
  run?: EvalsCommandRunner
  spawnGenerator?: EvalsSpawner
}

const GENERATED_EVALUATOR = 'OutputEvaluator'
const SUMMARY_LIMIT = 140

export const evalsGenerationFiles = (workspaceDirectory: string, name: string, now: Date): EvalsGenerationFiles => {
  const stem = join(evalsDraftsFolder(workspaceDirectory), `${evalsRunStamp(now)}-${name}`)
  return { draft: `${stem}.json`, log: `${stem}.log` }
}

export const evalsGenerateArguments = (
  settings: GenerationSettings,
  context: string,
  files: EvalsGenerationFiles
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

export const generateEvalsExperiment = async (
  request: EvalsGenerationRequest,
  dependencies: EvalsExperimentDependencies = {}
): Promise<EvalsGenerationOutcome> => {
  const { workspace, settings, context, files, signal } = request
  generatorModelId(settings.model) // Validate before installing dependencies or starting a paid job.
  const directory = evalsWorkspaceDirectory(workspace)
  const python = await prepareEvalsOptimizerEnvironment(
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
  const exit = await runEvals(
    dependencies.spawnGenerator,
    request,
    { python, args: evalsGenerateArguments(settings, context, files), log: files.log },
    ignoreProgress
  )
  if (exit.code !== 0) throw evalsFailure('strands-evals generate', exit, process.env, generatorNextStep(exit.code))
  if (!existsSync(files.draft)) throw new Error(`strands-evals generate finished without writing ${files.draft}.`)
  const { complete, dropped } = await evalsDropIncompleteCases(files.draft)
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

export const evalsGenerationError = (
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
