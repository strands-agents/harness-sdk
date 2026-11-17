import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  readTemporaryLatestTestResults,
  readTemporaryTestResults,
  rememberTemporaryTestResults,
} from '../../../src/dev/temporary-evals-fork/report.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const RUN = { experiment: 'refunds', seconds: 12.5 }
const STAMP = '20261111-205909'
const RERUN_STAMP = '20261111-210000'

interface Row {
  name: string | null
  evaluator: string
  score: number
  passed: boolean
  reason: string
  input?: unknown
  actual?: unknown
}

const row = ({ name, evaluator, score, passed, reason, input = `question for ${name}`, actual }: Row) => ({
  testCase: {
    name,
    session_id: `session-${name}`,
    input,
    expected_output: `answer for ${name}`,
    ...(actual === undefined ? {} : { actual_output: actual, actual_trajectory: { traces: [] } }),
    expected_trajectory: null,
    metadata: null,
    evaluator,
    evaluator_type: evaluator === 'judge' ? 'OutputEvaluator' : evaluator,
  },
  score,
  passed,
  reason,
})

const report = (rows: ReturnType<typeof row>[], overall = 0.5) => ({
  overall_score: overall,
  scores: rows.map(({ score }) => score),
  cases: rows.map(({ testCase }) => testCase),
  test_passes: rows.map(({ passed }) => passed),
  reasons: rows.map(({ reason }) => reason),
  detailed_results: rows.map(({ score, passed, reason }) => [{ score, test_pass: passed, reason, label: null }]),
  diagnoses: rows.map(() => null),
  recommendations: rows.map(() => null),
})

const ROWS = [
  row({ name: 'c0', evaluator: 'Equals', score: 1, passed: true, reason: 'matches', actual: 'answer for c0' }),
  row({ name: 'c1', evaluator: 'Equals', score: 0, passed: false, reason: 'An error occurred: boom' }),
  row({ name: 'c0', evaluator: 'judge', score: 0.5, passed: false, reason: 'too short', actual: 'answer for c0' }),
  row({ name: 'c1', evaluator: 'judge', score: 0, passed: false, reason: 'An error occurred: boom' }),
]

const experimentHome = async (): Promise<string> => join(await temporaryDirectory(), 'strands-dev/experiments/refunds')

const writeRunReport = async (home: string, content: unknown, stamp = STAMP): Promise<string> => {
  const path = join(home, 'runs', stamp, 'report.json')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content))
  return path
}

const writeReport = async (content: unknown): Promise<string> => writeRunReport(await experimentHome(), content)

describe('TEMPORARY test report', () => {
  it('shouldGroupTheVerdictsByCaseWhenTheReportHasSeveralEvaluators', async () => {
    const path = await writeReport(report(ROWS, 0.375))

    const results = await readTemporaryTestResults(path, RUN)

    expect(results).toEqual({
      experiment: 'refunds',
      cases: [
        {
          name: 'c0',
          input: 'question for c0',
          expected: 'answer for c0',
          actual: 'answer for c0',
          passed: false,
          verdicts: [
            { evaluator: 'Equals', score: 1, passed: true, reason: 'matches' },
            { evaluator: 'judge', score: 0.5, passed: false, reason: 'too short' },
          ],
        },
        {
          name: 'c1',
          input: 'question for c1',
          expected: 'answer for c1',
          passed: false,
          verdicts: [
            { evaluator: 'Equals', score: 0, passed: false, reason: 'An error occurred: boom' },
            { evaluator: 'judge', score: 0, passed: false, reason: 'An error occurred: boom' },
          ],
        },
      ],
      evaluators: ['Equals', 'judge'],
      overall: 0.375,
      report: path,
      seconds: 12.5,
    })
  })

  it('shouldPassACaseWhenEveryEvaluatorPassesIt', async () => {
    const path = await writeReport(
      report([
        row({ name: 'c0', evaluator: 'Equals', score: 1, passed: true, reason: 'matches', actual: 'paris' }),
        row({ name: 'c0', evaluator: 'judge', score: 1, passed: true, reason: 'right', actual: 'paris' }),
      ])
    )

    const { cases } = await readTemporaryTestResults(path, RUN)

    expect(cases.map(({ name, passed }) => ({ name, passed }))).toEqual([{ name: 'c0', passed: true }])
  })

  it('shouldShowInputsAndOutputsAsCompactJsonWhenTheyAreNotText', async () => {
    const path = await writeReport(
      report([
        row({
          name: 'c0',
          evaluator: 'Equals',
          score: 0,
          passed: false,
          reason: 'differs',
          input: { order: 7, items: ['shoe'] },
          actual: { refund: true },
        }),
      ])
    )

    const [result] = (await readTemporaryTestResults(path, RUN)).cases

    expect(result).toMatchObject({ input: '{"order":7,"items":["shoe"]}', actual: '{"refund":true}' })
  })

  it('shouldShowTheAssertionAsTheExpectedAnswerWhenACaseHasNoExpectedOutput', async () => {
    const graded = row({ name: 'c0', evaluator: 'Correctness', score: 1, passed: true, reason: 'ok', actual: 'done' })
    const testCase = { ...graded.testCase, expected_output: null, expected_assertion: 'The agent refunds order 7.' }
    const path = await writeReport({ ...report([graded]), cases: [testCase] })

    const [result] = (await readTemporaryTestResults(path, RUN)).cases

    expect(result).toMatchObject({ expected: 'The agent refunds order 7.', actual: 'done' })
  })

  it('shouldNameCasesLikeTheForkWhenACaseHasNoName', async () => {
    const path = await writeReport(
      report([
        row({ name: null, evaluator: 'Equals', score: 1, passed: true, reason: 'ok', actual: 'a' }),
        row({ name: null, evaluator: 'Equals', score: 0, passed: false, reason: 'no', actual: 'b' }),
        row({ name: null, evaluator: 'judge', score: 1, passed: true, reason: 'ok', actual: 'a' }),
        row({ name: null, evaluator: 'judge', score: 1, passed: true, reason: 'ok', actual: 'b' }),
      ])
    )

    const { cases } = await readTemporaryTestResults(path, RUN)

    expect(cases.map(({ name, verdicts }) => [name, verdicts.length])).toEqual([
      ['case_0', 2],
      ['case_1', 2],
    ])
  })

  it.each([
    { content: undefined, detail: 'ENOENT' },
    { content: '{"overall_score": 0.5, "scores": [', detail: 'JSON' },
    { content: [], detail: 'it is not a JSON object' },
    { content: { scores: [], cases: [], test_passes: [] }, detail: 'it has no overall_score' },
    {
      content: { overall_score: 1, scores: [1], test_passes: [true] },
      detail: 'it has no cases, scores, or test_passes',
    },
    {
      content: { overall_score: 1, scores: [1, 0], cases: [{ name: 'c0' }], test_passes: [true] },
      detail: 'its cases, scores, and test_passes lists have different lengths',
    },
    {
      content: { overall_score: 1, scores: [1], cases: ['c0'], test_passes: [true] },
      detail: 'case row 1 is not an object',
    },
  ])('shouldAskForANewTestRunWhenTheReportHas$detail', async ({ content, detail }) => {
    const path = content === undefined ? join(await temporaryDirectory(), 'missing.json') : await writeReport(content)

    await expect(readTemporaryTestResults(path, RUN)).rejects.toThrow(
      new RegExp(`^${literal(path)} is not a usable test report \\(.*${detail}.*\\)\\. Run the test again\\.$`, 'u')
    )
  })
})

const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

const latestReport = (home: string): string => join(home, 'refunds.report.json')

const latestRecord = (home: string): string => join(home, '.state/latest.json')

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'))

const rememberRun = async (home: string, content: unknown, stamp: string, only?: string[]) => {
  const path = await writeRunReport(home, content, stamp)
  return rememberTemporaryTestResults(home, await readTemporaryTestResults(path, RUN), only)
}

describe('TEMPORARY last test run', () => {
  it('shouldReadTheRememberedResultsWhenTheExperimentRanBefore', async () => {
    const home = await experimentHome()
    const results = await readTemporaryTestResults(await writeRunReport(home, report(ROWS)), RUN)

    const remembered = await rememberTemporaryTestResults(home, results)

    expect(remembered).toEqual({ ...results, report: latestReport(home) })
    expect(await readTemporaryLatestTestResults(home)).toEqual(remembered)
  })

  it('shouldReplaceTheLatestReportAndRecordTheRunWhenAFullRunFollowsAnother', async () => {
    const home = await experimentHome()
    await rememberRun(home, report(ROWS, 0.375), STAMP)
    const second = report([ROWS[0]!], 1)

    await rememberRun(home, second, RERUN_STAMP)

    expect(await readJson(latestReport(home))).toEqual(second)
    expect(await readJson(latestRecord(home))).toEqual({ run: join('runs', RERUN_STAMP), seconds: 12.5 })
  })

  it('shouldReplaceTheRerunRowsAndKeepTheOtherCasesWhenFailedCasesRunAgain', async () => {
    const home = await experimentHome()
    await rememberRun(home, report(ROWS, 0.375), STAMP)
    const rerun = [
      row({ name: 'c1', evaluator: 'Equals', score: 1, passed: true, reason: 'matches', actual: 'answer for c1' }),
      row({ name: 'c1', evaluator: 'judge', score: 1, passed: true, reason: 'complete', actual: 'answer for c1' }),
    ]

    const results = await rememberRun(home, report(rerun, 1), RERUN_STAMP, ['c1'])

    expect(await readJson(latestReport(home))).toEqual(report([ROWS[0]!, rerun[0]!, ROWS[2]!, rerun[1]!], 0.875))
    expect(results).toMatchObject({ overall: 0.875, report: latestReport(home) })
    expect(results.cases.map(({ name, passed }) => ({ name, passed }))).toEqual([
      { name: 'c0', passed: false },
      { name: 'c1', passed: true },
    ])
  })

  it('shouldAppendTheCaseWhenTheRerunHasACaseTheLatestReportLacks', async () => {
    const home = await experimentHome()
    await rememberRun(home, report(ROWS, 0.375), STAMP)
    const added = row({
      name: 'c2',
      evaluator: 'Equals',
      score: 1,
      passed: true,
      reason: 'ok',
      actual: 'answer for c2',
    })

    const results = await rememberRun(home, report([added], 1), RERUN_STAMP, ['c2'])

    expect(await readJson(latestReport(home))).toEqual(report([...ROWS, added], 0.5))
    expect(results.cases.map(({ name }) => name)).toEqual(['c0', 'c1', 'c2'])
  })

  it.each([
    { label: 'AllNotApplicableAndPassed', outputs: [{ not_applicable: true, test_pass: true }], overall: 1 },
    { label: 'NotApplicableButFailed', outputs: [{ not_applicable: true, test_pass: false }], overall: 0.5 },
    { label: 'Empty', outputs: [], overall: 0.5 },
    {
      label: 'PartlyNotApplicable',
      outputs: [
        { not_applicable: true, test_pass: true },
        { not_applicable: false, test_pass: true },
      ],
      overall: 0.5,
    },
  ])('shouldRecomputeTheOverallScoreWhenTheRerunOutputsAre$label', async ({ outputs, overall }) => {
    const home = await experimentHome()
    const previous = [
      row({ name: 'c0', evaluator: 'Equals', score: 1, passed: true, reason: 'matches' }),
      row({ name: 'c1', evaluator: 'Equals', score: 0, passed: false, reason: 'differs' }),
    ]
    await rememberRun(home, report(previous, 0.5), STAMP)

    const results = await rememberRun(
      home,
      { ...report([previous[1]!], 0), detailed_results: [outputs] },
      RERUN_STAMP,
      ['c1']
    )

    expect(results.overall).toBe(overall)
  })

  it('shouldPruneTheOldestTestRunsWhenItRemembersAResult', async () => {
    const home = await experimentHome()
    const old = Array.from({ length: 21 }, (_, index) => `20261111-2000${String(index).padStart(2, '0')}`)
    await Promise.all(old.map((stamp) => mkdir(join(home, 'runs', stamp), { recursive: true })))

    await rememberRun(home, report(ROWS, 0.375), STAMP)

    expect((await readdir(join(home, 'runs'))).sort()).toEqual([...old.slice(2), STAMP])
  })

  it('shouldReturnNothingWhenTheExperimentNeverRan', async () => {
    expect(await readTemporaryLatestTestResults(await experimentHome())).toBeUndefined()
  })

  it.each([
    { record: '{"run": ', detail: 'JSON' },
    { record: JSON.stringify({ run: join('runs', STAMP) }), detail: 'it has no run time' },
  ])('shouldAskForANewTestRunWhenTheLastRunRecordHas$detail', async ({ record, detail }) => {
    const home = await experimentHome()
    await mkdir(dirname(latestRecord(home)), { recursive: true })
    await writeFile(latestRecord(home), record)

    await expect(readTemporaryLatestTestResults(home)).rejects.toThrow(
      new RegExp(
        `^${literal(latestRecord(home))} is not a usable record of the last test run \\(.*${detail}.*\\)\\. Run the test again\\.$`,
        'u'
      )
    )
  })

  it('shouldAskForANewTestRunWhenTheRememberedReportIsGone', async () => {
    const home = await experimentHome()
    await rememberRun(home, report(ROWS), STAMP)
    await rm(latestReport(home))

    await expect(readTemporaryLatestTestResults(home)).rejects.toThrow(
      `${latestReport(home)} is not a usable test report`
    )
  })
})
