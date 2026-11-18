import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, relative } from 'node:path'

import { errorMessage } from '../../terminal/text.js'
import { isRecord } from '../../values.js'
import type { CaseResult, EvaluatorVerdict, TestResults } from '../panels/model.js'
import {
  temporaryCaseExpected,
  temporaryCaseName,
  temporaryCaseText,
  type TemporaryRawCase,
} from './experiment-files.js'
import { pruneTemporaryTestRuns, temporaryLatestRecord, temporaryLatestReport, temporaryTestRunOf } from './layout.js'

export interface TemporaryTestRun {
  readonly experiment: string
  readonly seconds: number
}

interface ReportRow {
  readonly evaluator: string
  readonly testCase: TemporaryRawCase
  readonly score: number
  readonly passed: boolean
  readonly reason: string
}

interface Report {
  readonly overall: number
  readonly rows: readonly ReportRow[]
}

interface CaseGroup {
  readonly testCase: TemporaryRawCase
  readonly verdicts: EvaluatorVerdict[]
}

const unusableReport = (path: string, detail: string, cause?: unknown): Error =>
  new Error(`${path} is not a usable evaluation report (${detail}). Run the evaluation again.`, { cause })

const evaluatorOf = (testCase: TemporaryRawCase): string => {
  const name = [testCase.evaluator, testCase.evaluator_type].find((value) => typeof value === 'string' && value)
  return typeof name === 'string' ? name : 'evaluator'
}

const parseReport = (path: string, document: unknown): Report => {
  if (!isRecord(document)) throw unusableReport(path, 'it is not a JSON object')
  const { overall_score: overall, cases, scores, test_passes: passes, reasons } = document
  if (typeof overall !== 'number') throw unusableReport(path, 'it has no overall_score')
  if (!Array.isArray(cases) || !Array.isArray(scores) || !Array.isArray(passes))
    throw unusableReport(path, 'it has no cases, scores, or test_passes list')
  if (scores.length !== cases.length || passes.length !== cases.length)
    throw unusableReport(path, 'its cases, scores, and test_passes lists have different lengths')
  const rows = cases.map((testCase: unknown, index): ReportRow => {
    if (!isRecord(testCase)) throw unusableReport(path, `case row ${index + 1} is not an object`)
    const score: unknown = scores[index]
    const reason: unknown = Array.isArray(reasons) ? reasons[index] : undefined
    return {
      evaluator: evaluatorOf(testCase),
      testCase,
      score: typeof score === 'number' ? score : 0,
      passed: passes[index] === true,
      reason: typeof reason === 'string' ? reason : '',
    }
  })
  return { overall, rows }
}

const readReport = async (path: string): Promise<Report> => {
  let document: unknown
  try {
    document = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw unusableReport(path, errorMessage(error), error)
  }
  return parseReport(path, document)
}

const groupByCase = (rows: readonly ReportRow[]): Map<string, CaseGroup> => {
  const positions = new Map<string, number>()
  const groups = new Map<string, CaseGroup>()
  rows.forEach(({ evaluator, testCase, score, passed, reason }) => {
    const position = positions.get(evaluator) ?? 0
    positions.set(evaluator, position + 1)
    const name = temporaryCaseName(testCase, position)
    const group = groups.get(name) ?? { testCase, verdicts: [] }
    group.verdicts.push({ evaluator, score, passed, reason })
    groups.set(name, group)
  })
  return groups
}

const caseResult = (name: string, { testCase, verdicts }: CaseGroup): CaseResult => {
  const expected = temporaryCaseExpected(testCase)
  const actual = temporaryCaseText(testCase.actual_output)
  return {
    name,
    input: temporaryCaseText(testCase.input) ?? '',
    ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual }),
    passed: verdicts.every((verdict) => verdict.passed),
    verdicts,
  }
}

export const readTemporaryTestResults = async (
  path: string,
  { experiment, seconds }: TemporaryTestRun
): Promise<TestResults> => {
  const { overall, rows } = await readReport(path)
  return {
    experiment,
    cases: [...groupByCase(rows)].map(([name, group]) => caseResult(name, group)),
    evaluators: [...new Set(rows.map((row) => row.evaluator))],
    overall,
    report: path,
    seconds,
  }
}

const unusableRecord = (path: string, detail: string, cause?: unknown): Error =>
  new Error(`${path} is not a usable record of the last evaluation run (${detail}). Run the evaluation again.`, {
    cause,
  })

const REPORT_ROW_FIELDS = [
  'cases',
  'scores',
  'test_passes',
  'reasons',
  'detailed_results',
  'diagnoses',
  'recommendations',
] as const

type ReportDocument = Record<string, unknown>
type ReportRowFields = Partial<Record<(typeof REPORT_ROW_FIELDS)[number], unknown>>

const readDocument = async (path: string): Promise<ReportDocument> => {
  let document: unknown
  try {
    document = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw unusableReport(path, errorMessage(error), error)
  }
  parseReport(path, document)
  return document as ReportDocument
}

const documentRows = (document: ReportDocument): ReportRowFields[] => {
  const cases = Array.isArray(document.cases) ? document.cases : []
  return cases.map((_case, index) =>
    Object.fromEntries(
      REPORT_ROW_FIELDS.flatMap((field) => {
        const values = document[field]
        return Array.isArray(values) && index < values.length ? [[field, values[index]]] : []
      })
    )
  )
}

const rowKeys = (rows: readonly ReportRowFields[]): string[] => {
  const positions = new Map<string, number>()
  return rows.map(({ cases }) => {
    const testCase = isRecord(cases) ? cases : {}
    const evaluator = evaluatorOf(testCase)
    const position = positions.get(evaluator) ?? 0
    positions.set(evaluator, position + 1)
    return JSON.stringify([evaluator, temporaryCaseName(testCase, position)])
  })
}

const caseOfKey = (key: string): string => (JSON.parse(key) as [string, string])[1]

const isApplicable = (outputs: unknown): boolean =>
  !Array.isArray(outputs) ||
  outputs.length === 0 ||
  outputs.some((output) => !isRecord(output) || output.not_applicable !== true || output.test_pass !== true)

const overallScore = (rows: readonly ReportRowFields[]): number => {
  const applicable = rows
    .filter(({ detailed_results: details }) => details === undefined || isApplicable(details))
    .map(({ scores }) => (typeof scores === 'number' ? scores : 0))
  return applicable.length > 0 ? applicable.reduce((sum, score) => sum + score, 0) / applicable.length : 0
}

const mergedDocument = (
  previous: ReportDocument,
  rerun: ReportDocument,
  names: ReadonlySet<string>
): ReportDocument => {
  const previousRows = documentRows(previous)
  const rerunRows = documentRows(rerun)
  const rerunKeys = rowKeys(rerunRows)
  const replacements = new Map(rerunKeys.map((key, index) => [key, rerunRows[index]!]))
  const previousKeys = rowKeys(previousRows)
  const kept = previousRows.flatMap((row, index) => {
    const key = previousKeys[index]!
    if (!names.has(caseOfKey(key))) return [row]
    const replacement = replacements.get(key)
    return replacement ? [replacement] : []
  })
  const known = new Set(previousKeys)
  const rows = [...kept, ...rerunRows.filter((_row, index) => !known.has(rerunKeys[index]!))]
  const fields = REPORT_ROW_FIELDS.filter((field) => field in previous || field in rerun)
  return {
    ...previous,
    overall_score: overallScore(rows),
    ...Object.fromEntries(fields.map((field) => [field, rows.map((row) => row[field] ?? null)])),
  }
}

const writeLatest = async (
  latest: string,
  results: TestResults,
  only: readonly string[] | undefined
): Promise<void> => {
  const staging = `${latest}.${process.pid}.tmp`
  await mkdir(dirname(latest), { recursive: true })
  if (only && existsSync(latest)) {
    const merged = mergedDocument(await readDocument(latest), await readDocument(results.report), new Set(only))
    await writeFile(staging, `${JSON.stringify(merged, null, 2)}\n`)
  } else await copyFile(results.report, staging)
  await rename(staging, latest)
}

export const rememberTemporaryTestResults = async (
  home: string,
  results: TestResults,
  only?: readonly string[]
): Promise<TestResults> => {
  const latest = temporaryLatestReport(home)
  const record = temporaryLatestRecord(home)
  const run = temporaryTestRunOf(results.report).folder
  await writeLatest(latest, results, only)
  await mkdir(dirname(record), { recursive: true })
  await writeFile(record, `${JSON.stringify({ run: relative(home, run), seconds: results.seconds })}\n`)
  await pruneTemporaryTestRuns(home, [run]).catch(() => 0)
  return readTemporaryTestResults(latest, { experiment: results.experiment, seconds: results.seconds })
}

export const readTemporaryLatestTestResults = async (home: string): Promise<TestResults | undefined> => {
  const path = temporaryLatestRecord(home)
  let record: unknown
  try {
    record = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return undefined
    throw unusableRecord(path, errorMessage(error), error)
  }
  if (!isRecord(record) || typeof record.seconds !== 'number') throw unusableRecord(path, 'it has no run time')
  return readTemporaryTestResults(temporaryLatestReport(home), { experiment: basename(home), seconds: record.seconds })
}
