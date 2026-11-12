import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  readTemporaryLatestTestResults,
  readTemporaryTestResults,
  rememberTemporaryTestResults,
} from '../../../src/dev/temporary-evals-fork/report.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const RUN = { experiment: 'refunds', seconds: 12.5 }

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

const writeReport = async (content: unknown): Promise<string> => {
  const path = join(await temporaryDirectory(), '20261111-205909-refunds.json')
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content))
  return path
}

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
      new RegExp(`^${path} is not a usable test report \\(.*${detail}.*\\)\\. Run the test again\\.$`, 'u')
    )
  })
})

describe('TEMPORARY last test run', () => {
  it('shouldReadTheRememberedResultsWhenTheExperimentRanBefore', async () => {
    const path = await writeReport(report(ROWS))
    const results = await readTemporaryTestResults(path, RUN)

    await rememberTemporaryTestResults(dirname(path), 'refunds', results)

    expect(await readTemporaryLatestTestResults(dirname(path), 'refunds')).toEqual(results)
  })

  it('shouldReturnNothingWhenTheExperimentNeverRan', async () => {
    expect(await readTemporaryLatestTestResults(await temporaryDirectory(), 'refunds')).toBeUndefined()
  })

  it.each([
    { record: '{"report": ', detail: 'JSON' },
    { record: JSON.stringify({ report: 'r.json' }), detail: 'it has no report file or run time' },
  ])('shouldAskForANewTestRunWhenTheLastRunRecordHas$detail', async ({ record, detail }) => {
    const folder = await temporaryDirectory()
    const path = join(folder, 'latest', 'refunds.json')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, record)

    await expect(readTemporaryLatestTestResults(folder, 'refunds')).rejects.toThrow(
      new RegExp(
        `^${path} is not a usable record of the last test run \\(.*${detail}.*\\)\\. Run the test again\\.$`,
        'u'
      )
    )
  })

  it('shouldAskForANewTestRunWhenTheRememberedReportIsGone', async () => {
    const path = await writeReport(report(ROWS))
    await rememberTemporaryTestResults(dirname(path), 'refunds', await readTemporaryTestResults(path, RUN))
    await rm(path)

    await expect(readTemporaryLatestTestResults(dirname(path), 'refunds')).rejects.toThrow(
      `${path} is not a usable test report`
    )
  })
})
