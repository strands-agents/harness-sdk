import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'

import { errorMessage } from '../../../terminal/text.js'
import { isRecord } from '../../../values.js'
import { writeEvalsRunEntry } from '../python/entry-files.js'
import type { CaseResult, EvaluatorVerdict, EvaluationResults } from '../model.js'
import type { DevWorkspace } from '../../workspace.js'
import { ignoreProgress, prepareEvalsOptimizerEnvironment, type EvalsCommandRunner } from './environment.js'
import {
  assertEvalsArguments,
  runEvals,
  evalsFailure,
  evalsFlagValues,
  temporaryTypescriptRunnerOf,
  evalsWorkspaceDirectory,
  type EvalsRequest,
  type EvalsSpawner,
} from './evals-process.js'
import {
  readEvalsExperimentFile,
  resolveEvalsExperiment,
  evalsCaseCount,
  evalsCaseExpected,
  evalsCaseName,
  evalsCaseText,
  evalsNamedExperiment,
  evalsRunnableExperiment,
  writeEvalsExperimentFile,
  type EvalsRawCase,
} from './experiment.js'
import {
  pruneEvaluationRuns,
  evalsExperimentHome,
  evalsExperimentsFolder,
  evalsFreeStamp,
  evalsLatestRecord,
  evalsLatestReport,
  evaluationRunFiles,
  evaluationRunOf,
} from '../layout.js'

interface EvaluationFiles {
  readonly cases: string
  readonly report: string
  readonly log: string
  readonly store: string
}

interface EvaluationRequest extends EvalsRequest {
  onStart?: (files: EvaluationFiles) => void | Promise<void>
  resume?: EvaluationFiles
  only?: readonly string[]
  startedAt?: number
}

interface EvaluationOutcome {
  experiment: string
  name: string
  home: string
  report: string
  seconds: number
  passed: number
  checks: number
  overall: number
}

export interface EvaluationDependencies {
  run?: EvalsCommandRunner
  spawnEvaluation?: EvalsSpawner
}

const EVALUATION_WORKERS = 4
const MILLISECONDS_PER_SECOND = 1000
const CUSTOM_EVALUATOR_FLAG = '--custom-evaluator'

const EVALUATION_OWNED_FLAGS = [
  '--agent',
  '--task',
  '-o',
  '--output',
  '--json',
  '--rich',
  '--fail-on',
  '--exit-zero',
  '--display',
  '--interactive',
  '--data-store',
]

interface ReportScores {
  overall_score?: number
  test_passes?: boolean[]
}

const readScores = async (report: string): Promise<{ passed: number; checks: number; overall: number }> => {
  const { overall_score: overall = 0, test_passes: passes = [] } = JSON.parse(
    await readFile(report, 'utf8')
  ) as ReportScores
  return { passed: passes.filter(Boolean).length, checks: passes.length, overall }
}

const evaluationNextStep = (code: number, log: string): string =>
  code === 2
    ? 'Fix the cause above (it is in the agent file, the experiment file, or the flags after --), then run the ' +
      `evaluation again. The full output is in ${log}.`
    : `Fix the error above, then run the evaluation again. The full output is in ${log}.`

const onlyCases = async (experiment: string, copy: string, names: readonly string[]): Promise<string> => {
  const { raw } = await readEvalsExperimentFile(experiment)
  await writeEvalsExperimentFile(copy, evalsNamedExperiment(raw), names)
  return copy
}

const newEvaluationFiles = async (
  experiment: string,
  home: string,
  now: Date,
  only: readonly string[] | undefined
): Promise<EvaluationFiles> => {
  const stamp = evalsFreeStamp((candidate) => existsSync(evaluationRunFiles(home, candidate).folder), now)
  const { folder, report, log, store, copy } = evaluationRunFiles(home, stamp)
  await mkdir(folder, { recursive: true })
  return {
    cases: only ? await onlyCases(experiment, copy, only) : await evalsRunnableExperiment(experiment, copy),
    report,
    log,
    store,
  }
}

const writeRunEntry = (
  workspace: DevWorkspace,
  { cases, report }: EvaluationFiles,
  evalsArguments: readonly string[]
): Promise<string[]> =>
  writeEvalsRunEntry(evaluationRunOf(report).task, {
    agentFile: resolve(workspace.entrypoint),
    experimentFile: resolve(cases),
    customEvaluators: evalsFlagValues(evalsArguments, CUSTOM_EVALUATOR_FLAG),
    ...temporaryTypescriptRunnerOf(workspace),
  })

export const runEvaluation = async (
  request: EvaluationRequest,
  dependencies: EvaluationDependencies = {}
): Promise<EvaluationOutcome> => {
  const { workspace, evalsArguments = [], signal, onProgress = ignoreProgress } = request
  const directory = evalsWorkspaceDirectory(workspace)
  assertEvalsArguments(evalsArguments, EVALUATION_OWNED_FLAGS, 'strands dev')
  const experiment = await resolveEvalsExperiment(evalsExperimentsFolder(directory), request.experiment, 'evaluate')
  const cases = await evalsCaseCount(experiment)
  if (cases === 0)
    throw new Error(
      `${experiment} has no cases, so there is nothing to evaluate. Add cases to it, or draft cases with ` +
        '/experiment, then run the evaluation again.'
    )
  await request.prepare?.()
  const python = await prepareEvalsOptimizerEnvironment(
    { workspaceDirectory: directory, projectRoot: workspace.root, language: workspace.config.language },
    { ...(dependencies.run ? { run: dependencies.run } : {}), ...(signal ? { signal } : {}), onProgress }
  )
  const home = evalsExperimentHome(directory, experiment)
  const startedAt = request.startedAt ?? Date.now()
  const files =
    request.resume ?? (await newEvaluationFiles(experiment, home, request.now?.() ?? new Date(), request.only))
  const { report, log } = files
  const task = await writeRunEntry(workspace, files, evalsArguments)
  onProgress(`Testing ${workspace.entrypoint} on the ${cases} cases of ${experiment}`)
  onProgress(`Report: ${report}`)
  onProgress('Running the cases. The summary appears when every case has finished.')
  await request.onStart?.(files)
  const exit = await runEvals(
    dependencies.spawnEvaluation,
    request,
    {
      python,
      args: [
        '-m',
        'strands_evals.cli',
        'run',
        files.cases,
        ...task,
        '--output',
        report,
        '--fail-on',
        'none',
        '--data-store',
        files.store,
        '--max-workers',
        String(EVALUATION_WORKERS),
        ...evalsArguments,
      ],
      log,
    },
    onProgress
  )
  if (exit.code !== 0) throw evalsFailure('strands-evals run', exit, process.env, evaluationNextStep(exit.code, log))
  if (!existsSync(report))
    throw new Error(`strands-evals run finished without writing ${report}. The full output is in ${log}.`)
  const scores = await readScores(report)
  if (scores.checks === 0)
    throw new Error(
      `strands-evals run checked nothing: ${report} has no results. Check that ${experiment} lists evaluators, ` +
        'then run the evaluation again.'
    )
  const name = home === dirname(experiment) ? basename(experiment, '.json') : experiment
  return { experiment, name, home, report, seconds: (Date.now() - startedAt) / MILLISECONDS_PER_SECOND, ...scores }
}

interface ReportRow {
  readonly evaluator: string
  readonly testCase: EvalsRawCase
  readonly score: number
  readonly passed: boolean
  readonly reason: string
}

interface Report {
  readonly overall: number
  readonly rows: readonly ReportRow[]
}

interface CaseGroup {
  readonly testCase: EvalsRawCase
  readonly verdicts: EvaluatorVerdict[]
}

const unusableReport = (path: string, detail: string, cause?: unknown): Error =>
  new Error(`${path} is not a usable evaluation report (${detail}). Run the evaluation again.`, { cause })

const evaluatorOf = (testCase: EvalsRawCase): string => {
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

type ReportDocument = Record<string, unknown>

const readDocument = async (path: string): Promise<{ document: ReportDocument; report: Report }> => {
  let document: unknown
  try {
    document = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw unusableReport(path, errorMessage(error), error)
  }
  return { report: parseReport(path, document), document: document as ReportDocument }
}

const groupByCase = (rows: readonly ReportRow[]): Map<string, CaseGroup> => {
  const positions = new Map<string, number>()
  const groups = new Map<string, CaseGroup>()
  rows.forEach(({ evaluator, testCase, score, passed, reason }) => {
    const position = positions.get(evaluator) ?? 0
    positions.set(evaluator, position + 1)
    const name = evalsCaseName(testCase, position)
    const group = groups.get(name) ?? { testCase, verdicts: [] }
    group.verdicts.push({ evaluator, score, passed, reason })
    groups.set(name, group)
  })
  return groups
}

const caseResult = (name: string, { testCase, verdicts }: CaseGroup): CaseResult => {
  const expected = evalsCaseExpected(testCase)
  const actual = evalsCaseText(testCase.actual_output)
  return {
    name,
    input: evalsCaseText(testCase.input) ?? '',
    ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual }),
    passed: verdicts.every((verdict) => verdict.passed),
    verdicts,
  }
}

export const readEvaluationResults = async (
  path: string,
  { experiment, seconds }: Pick<EvaluationResults, 'experiment' | 'seconds'>
): Promise<EvaluationResults> => {
  const { overall, rows } = (await readDocument(path)).report
  return {
    experiment,
    cases: [...groupByCase(rows)].map(([name, group]) => caseResult(name, group)),
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

type ReportRowFields = Partial<Record<(typeof REPORT_ROW_FIELDS)[number], unknown>>

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
    return JSON.stringify([evaluator, evalsCaseName(testCase, position)])
  })
}

const caseOfKey = (key: string): string => (JSON.parse(key) as [string, string])[1]

const NOT_APPLICABLE = 'not_applicable'

const isNotApplicable = (output: unknown): output is Record<string, unknown> =>
  isRecord(output) && output.label === NOT_APPLICABLE

const couldNotEvaluate = (output: unknown): boolean =>
  isNotApplicable(output) && isRecord(output.metadata) && Boolean(output.metadata.could_not_evaluate)

const isApplicable = (outputs: unknown): boolean => {
  if (!Array.isArray(outputs) || outputs.length === 0) return true
  if (outputs.every(couldNotEvaluate)) return false
  return outputs.some((output) => !isNotApplicable(output) || output.test_pass !== true)
}

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
  results: EvaluationResults,
  only: readonly string[] | undefined
): Promise<void> => {
  const staging = `${latest}.${process.pid}.tmp`
  await mkdir(dirname(latest), { recursive: true })
  if (only && existsSync(latest)) {
    const [previous, rerun] = [await readDocument(latest), await readDocument(results.report)]
    const merged = mergedDocument(previous.document, rerun.document, new Set(only))
    await writeFile(staging, `${JSON.stringify(merged, null, 2)}\n`)
  } else await copyFile(results.report, staging)
  await rename(staging, latest)
}

export const rememberEvaluationResults = async (
  home: string,
  results: EvaluationResults,
  only?: readonly string[]
): Promise<EvaluationResults> => {
  const latest = evalsLatestReport(home)
  const record = evalsLatestRecord(home)
  const run = evaluationRunOf(results.report).folder
  await writeLatest(latest, results, only)
  await mkdir(dirname(record), { recursive: true })
  await writeFile(record, `${JSON.stringify({ run: relative(home, run), seconds: results.seconds })}\n`)
  await pruneEvaluationRuns(home, [run]).catch(() => 0)
  return readEvaluationResults(latest, { experiment: results.experiment, seconds: results.seconds })
}

export const readLatestEvaluationResults = async (home: string): Promise<EvaluationResults | undefined> => {
  const path = evalsLatestRecord(home)
  let record: unknown
  try {
    record = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return undefined
    throw unusableRecord(path, errorMessage(error), error)
  }
  if (!isRecord(record) || typeof record.seconds !== 'number') throw unusableRecord(path, 'it has no run time')
  return readEvaluationResults(evalsLatestReport(home), { experiment: basename(home), seconds: record.seconds })
}
