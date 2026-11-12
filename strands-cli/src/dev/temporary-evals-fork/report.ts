import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { errorMessage } from '../../terminal/text.js'
import { isRecord } from '../../values.js'
import type { CaseResult, EvaluatorVerdict, TestResults } from '../panels/model.js'
import { temporaryCaseName, temporaryCaseText, type TemporaryRawCase } from './experiment-files.js'

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
  new Error(`${path} is not a usable test report (${detail}). Run the test again.`, { cause })

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
  const expected = temporaryCaseText(testCase.expected_output)
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

const LATEST_FOLDER = 'latest'

const latestRecord = (reportsFolder: string, experiment: string): string =>
  join(reportsFolder, LATEST_FOLDER, `${experiment}.json`)

const unusableRecord = (path: string, detail: string, cause?: unknown): Error =>
  new Error(`${path} is not a usable record of the last test run (${detail}). Run the test again.`, { cause })

export const rememberTemporaryTestResults = async (
  reportsFolder: string,
  experiment: string,
  { report, seconds }: TestResults
): Promise<void> => {
  const path = latestRecord(reportsFolder, experiment)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify({ report: basename(report), seconds })}\n`)
}

export const readTemporaryLatestTestResults = async (
  reportsFolder: string,
  experiment: string
): Promise<TestResults | undefined> => {
  const path = latestRecord(reportsFolder, experiment)
  let record: unknown
  try {
    record = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return undefined
    throw unusableRecord(path, errorMessage(error), error)
  }
  if (!isRecord(record) || typeof record.report !== 'string' || typeof record.seconds !== 'number')
    throw unusableRecord(path, 'it has no report file or run time')
  return readTemporaryTestResults(join(reportsFolder, basename(record.report)), {
    experiment,
    seconds: record.seconds,
  })
}
