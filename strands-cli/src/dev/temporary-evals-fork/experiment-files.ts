import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { errorMessage } from '../../terminal/text.js'
import { isRecord } from '../../values.js'
import { missingCaseField, type EvalCase, type Experiment, type ExperimentSummary } from '../panels/model.js'
import { isTemporaryExperimentName } from './experiment.js'
import { listTemporaryExperimentFiles } from './layout.js'

export type TemporaryExperimentUse = 'optimize' | 'test'

export type TemporaryRawCase = Readonly<Record<string, unknown>>

export interface TemporaryExperimentDocument {
  readonly cases: readonly TemporaryRawCase[]
  readonly [field: string]: unknown
}

export interface TemporaryExperimentFile {
  readonly experiment: Experiment
  readonly raw: TemporaryExperimentDocument
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
  use: TemporaryExperimentUse
): Error => {
  if (!isTemporaryExperimentName(requested))
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

export const resolveTemporaryExperiment = async (
  folder: string,
  requested?: string,
  use: TemporaryExperimentUse = 'optimize'
): Promise<string> => {
  const names = await listTemporaryExperimentFiles(folder)
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

export const temporaryCaseCount = async (path: string): Promise<number> => {
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

export const temporaryCaseName = (raw: TemporaryRawCase, index: number): string =>
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

export const temporaryUniqueCaseNames = (cases: readonly TemporaryRawCase[]): string[] => {
  const unique = uniqueFileNames()
  return cases.map((rawCase, index) => unique(temporaryCaseName(rawCase, index)))
}

export const temporaryNamedExperiment = (raw: TemporaryExperimentDocument): TemporaryExperimentDocument => {
  const names = temporaryUniqueCaseNames(raw.cases)
  return { ...raw, cases: raw.cases.map((rawCase, index) => ({ ...rawCase, name: names[index] })) }
}

export const temporaryCaseText = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined
  return typeof value === 'string' ? value : JSON.stringify(value)
}

const hasText = (value: unknown): boolean => Boolean(temporaryCaseText(value)?.trim())

const expectedField = (raw: TemporaryRawCase): 'expected_output' | 'expected_assertion' =>
  !hasText(raw.expected_output) && hasText(raw.expected_assertion) ? 'expected_assertion' : 'expected_output'

export const temporaryCaseExpected = (raw: TemporaryRawCase): string | undefined =>
  temporaryCaseText(raw[expectedField(raw)])

export const temporaryCaseWithExpected = (raw: TemporaryRawCase, expected: string): TemporaryRawCase => ({
  ...raw,
  [expectedField(raw)]: expected || null,
})

const unusableExperiment = (path: string, detail: string, cause?: unknown): Error =>
  new Error(`${path} is not a usable Experiment file (${detail}). Fix the file or delete it, then try again.`, {
    cause,
  })

const evalCase = (raw: TemporaryRawCase, index: number): EvalCase => {
  const expected = temporaryCaseExpected(raw)
  return {
    name: temporaryCaseName(raw, index),
    input: temporaryCaseText(raw.input) ?? '',
    ...(expected === undefined ? {} : { expected }),
  }
}

const evaluatorNames = (evaluators: unknown): string[] =>
  (Array.isArray(evaluators) ? evaluators : []).filter(isRecord).flatMap((evaluator) => {
    const name = [evaluator.name, evaluator.evaluator_type].find((value) => typeof value === 'string' && value)
    return typeof name === 'string' ? [name] : []
  })

const countCases = async (path: string): Promise<number> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return isRecord(parsed) && Array.isArray(parsed.cases) ? parsed.cases.length : 0
  } catch {
    return 0
  }
}

export const listTemporaryExperiments = async (folder: string): Promise<ExperimentSummary[]> => {
  const summaries = await Promise.all(
    (await listTemporaryExperimentFiles(folder)).map(async (path) => ({
      name: basename(path, '.json'),
      path,
      caseCount: await countCases(path),
    }))
  )
  return summaries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

export const readTemporaryExperimentFile = async (path: string): Promise<TemporaryExperimentFile> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw unusableExperiment(path, errorMessage(error), error)
  }
  const cases = isRecord(parsed) ? parsed.cases : undefined
  if (!isRecord(parsed) || !Array.isArray(cases) || !cases.every(isRecord))
    throw unusableExperiment(path, 'it has no list of cases')
  const raw: TemporaryExperimentDocument = { ...parsed, cases }
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

const pickCases = (raw: TemporaryExperimentDocument, names: readonly string[]): TemporaryRawCase[] => {
  const byName = new Map<string, TemporaryRawCase[]>()
  raw.cases.forEach((rawCase, index) => {
    const name = temporaryCaseName(rawCase, index)
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
  document: TemporaryExperimentDocument,
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

export const writeTemporaryExperimentFile = async (
  path: string,
  raw: TemporaryExperimentDocument,
  cases: readonly string[]
): Promise<void> => writeDocument(path, { ...raw, cases: pickCases(raw, cases) })

export const readTemporaryRunnableCases = async (path: string): Promise<EvalCase[]> => {
  const { raw } = await readTemporaryExperimentFile(path)
  return temporaryNamedExperiment(raw).cases.map(evalCase)
}

export const temporaryRunnableExperiment = async (path: string, copy: string): Promise<string> => {
  const { raw } = await readTemporaryExperimentFile(path)
  const named = temporaryNamedExperiment(raw)
  if (named.cases.every(({ name }, index) => name === raw.cases[index]?.name)) return path
  await writeDocument(copy, named)
  return copy
}

export const writeTemporaryExperimentCases = async (
  path: string,
  raw: TemporaryExperimentDocument,
  cases: readonly TemporaryRawCase[]
): Promise<void> => writeDocument(path, { ...raw, cases })

export const temporaryDropIncompleteCases = async (
  path: string
): Promise<{ readonly complete: number; readonly dropped: number }> => {
  const { raw } = await readTemporaryExperimentFile(path)
  const complete = raw.cases.filter((rawCase, index) => !missingCaseField(evalCase(rawCase, index)))
  const dropped = raw.cases.length - complete.length
  if (dropped > 0) await writeTemporaryExperimentCases(path, raw, complete)
  return { complete: complete.length, dropped }
}

export const createTemporaryExperimentCases = async (
  path: string,
  raw: TemporaryExperimentDocument,
  cases: readonly TemporaryRawCase[]
): Promise<void> => writeDocument(path, { ...raw, cases }, placeNew)

export const temporaryBlankCase = (name: string, input: string, expected: string): TemporaryRawCase => ({
  name,
  session_id: randomUUID(),
  input,
  expected_output: expected || null,
  expected_assertion: null,
  expected_trajectory: null,
  expected_interactions: null,
  expected_environment_state: null,
  metadata: null,
})
