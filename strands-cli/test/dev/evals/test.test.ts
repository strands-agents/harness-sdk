import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

import type { EvalsProcess } from '../../../src/dev/evals/evals-process.js'
import {
  readEvalsLatestTestResults,
  readEvalsTestResults,
  rememberEvalsTestResults,
  runEvalsTest,
} from '../../../src/dev/evals/test.js'
import type { DevWorkspace } from '../../../src/dev/workspace.js'
import {
  environmentRunner,
  EXPERIMENT,
  experimentFile,
  workspaceFixture,
  writeFileAt,
} from '../../fixtures/optimizer-run.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const NOW = new Date('2026-11-11T15:04:05Z')
const STAMP = '20261111-150405'
const EVALS_AGENT_FOLDER = fileURLToPath(new URL('../../../src/dev/evals/python', import.meta.url))

const supportHome = (workspace: DevWorkspace): string => join(workspace.directory!, 'experiments/support')

const runFile = (workspace: DevWorkspace, file: string, stamp = STAMP): string =>
  join(supportHome(workspace), 'runs', stamp, file)

const reporting = (passes: boolean[], overall: number) =>
  vi.fn(async ({ args }: EvalsProcess) => {
    await writeFileAt(
      args[args.indexOf('--output') + 1]!,
      JSON.stringify({ overall_score: overall, test_passes: passes })
    )
    return { code: 0, stdout: '', stderrTail: ['strands-evals run | Contains: 1/2 passed (0.50) | overall: 0.50'] }
  })

describe('/evaluate', () => {
  it('shouldRunTheExperimentAndSaveTheReportInItsRunFolder', async () => {
    const workspace = await workspaceFixture()
    const spawnTests = reporting([true, false], 0.5)
    const progress: string[] = []
    const onStart = vi.fn()

    const outcome = await runEvalsTest(
      {
        workspace,
        evalsArguments: ['--max-workers', '2'],
        now: () => NOW,
        onProgress: (line) => progress.push(line),
        onStart,
      },
      { run: environmentRunner(), spawnTests }
    )

    const experiment = experimentFile(workspace.directory!, 'support')
    const report = runFile(workspace, 'report.json')
    expect(outcome).toEqual({
      experiment,
      name: 'support',
      home: supportHome(workspace),
      report,
      seconds: expect.any(Number),
      passed: 1,
      checks: 2,
      overall: 0.5,
    })
    const [{ args, log }] = spawnTests.mock.calls[0]!
    expect(args).toEqual([
      '-m',
      'strands_evals.cli',
      'run',
      experiment,
      '--task',
      `${runFile(workspace, '.state/task.py')}:task`,
      '--output',
      report,
      '--fail-on',
      'none',
      '--data-store',
      runFile(workspace, '.state/cases'),
      '--max-workers',
      '4',
      '--max-workers',
      '2',
    ])
    expect(onStart).toHaveBeenCalledWith({
      cases: experiment,
      report,
      log: runFile(workspace, 'run.log'),
      store: runFile(workspace, '.state/cases'),
    })
    expect(log).toBe(runFile(workspace, 'run.log'))
    expect(progress).toContain(`Testing ${workspace.entrypoint} on the 2 cases of ${outcome.experiment}`)
  })

  it('shouldWriteAnEntryFileThatRunsTheAgentFromTheShippedPackageWhenATestStarts', async () => {
    const workspace = await workspaceFixture()

    await runEvalsTest(
      { workspace, now: () => NOW },
      { run: environmentRunner(), spawnTests: reporting([true, true], 1) }
    )

    expect(await readFile(runFile(workspace, '.state/task.py'), 'utf8')).toBe(
      [
        'import sys',
        '',
        `sys.path.insert(0, ${JSON.stringify(EVALS_AGENT_FOLDER)})`,
        '',
        'from strands_dev_evals.run import run_task',
        '',
        'task = run_task(',
        `    ${JSON.stringify(workspace.entrypoint)},`,
        `    experiment_file=${JSON.stringify(experimentFile(workspace.directory!, 'support'))},`,
        ')',
        '',
      ].join('\n')
    )
  })

  it.each([{ given: ['--custom-evaluator', 'evals.py:Tone'] }, { given: ['--custom-evaluator=evals.py:Tone'] }])(
    'shouldGiveTheEntryFileTheCustomEvaluatorsWhenTestGets$given',
    async ({ given }) => {
      const workspace = await workspaceFixture()
      const spawnTests = reporting([true, true], 1)

      await runEvalsTest({ workspace, evalsArguments: given, now: () => NOW }, { run: environmentRunner(), spawnTests })

      expect(await readFile(runFile(workspace, '.state/task.py'), 'utf8')).toContain(
        '    custom_evaluators=("evals.py:Tone",),\n'
      )
      expect(spawnTests.mock.calls[0]![0].args.slice(-given.length)).toEqual(given)
    }
  )

  it('shouldWriteTheEntryFileInTheRunFolderWhenAStoppedRunResumes', async () => {
    const workspace = await workspaceFixture()
    const spawnTests = reporting([true, true], 1)
    const resume = {
      cases: experimentFile(workspace.directory!, 'support'),
      report: runFile(workspace, 'report.json', `${STAMP}-3`),
      log: runFile(workspace, 'run.log', `${STAMP}-3`),
      store: runFile(workspace, '.state/cases', `${STAMP}-3`),
    }

    await runEvalsTest({ workspace, resume }, { run: environmentRunner(), spawnTests })

    const task = runFile(workspace, '.state/task.py', `${STAMP}-3`)
    const { args } = spawnTests.mock.calls[0]![0]
    expect(args.slice(args.indexOf('--task'), args.indexOf('--task') + 2)).toEqual(['--task', `${task}:task`])
    expect(await readFile(task, 'utf8')).toContain(`    experiment_file=${JSON.stringify(resume.cases)},\n`)
  })

  it('shouldRunFourCasesAtOnceWhenNoWorkerCountIsGiven', async () => {
    const workspace = await workspaceFixture()
    const spawnTests = reporting([true, false], 0.5)

    await runEvalsTest({ workspace, now: () => NOW }, { run: environmentRunner(), spawnTests })

    const [{ args }] = spawnTests.mock.calls[0]!
    expect(args.slice(args.indexOf('--max-workers'))).toEqual(['--max-workers', '4'])
  })

  it('shouldStartANewRunFolderWhenAnotherRunStartedInTheSameSecond', async () => {
    const workspace = await workspaceFixture()
    const run = environmentRunner()
    const spawnTests = reporting([true, false], 0.5)

    const first = await runEvalsTest({ workspace, now: () => NOW }, { run, spawnTests })
    const second = await runEvalsTest({ workspace, now: () => NOW }, { run, spawnTests })

    expect(first.report).toBe(runFile(workspace, 'report.json'))
    expect(second.report).toBe(runFile(workspace, 'report.json', `${STAMP}-2`))
  })

  it('shouldCountTheSecondsFromTheGivenStartWhenTheRunStartedEarlier', async () => {
    const workspace = await workspaceFixture()

    const outcome = await runEvalsTest(
      { workspace, startedAt: Date.now() - 90_000 },
      { run: environmentRunner(), spawnTests: reporting([true], 1) }
    )

    expect(outcome.seconds).toBeGreaterThanOrEqual(90)
    expect(outcome.seconds).toBeLessThan(120)
  })

  it('shouldRunACopyWithUniqueCaseNamesWhenTheExperimentRepeatsAName', async () => {
    const workspace = await workspaceFixture([])
    const experiment = experimentFile(workspace.directory!, 'support')
    const document = JSON.stringify({ cases: [{ name: 'refund' }, { name: 'refund' }, {}], evaluators: [] })
    await writeFileAt(experiment, document)
    const spawnTests = reporting([true, true, true], 1)

    const outcome = await runEvalsTest({ workspace, now: () => NOW }, { run: environmentRunner(), spawnTests })

    const copy = runFile(workspace, '.state/experiment.json')
    expect(spawnTests.mock.calls[0]![0].args[3]).toBe(copy)
    expect(JSON.parse(await readFile(copy, 'utf8'))).toEqual({
      cases: [{ name: 'refund' }, { name: 'refund-2' }, { name: 'case_2' }],
      evaluators: [],
    })
    expect(await readFile(experiment, 'utf8')).toBe(document)
    expect(outcome).toMatchObject({ experiment, name: 'support' })
  })

  it('shouldRunACopyWithOnlyTheNamedCasesWhenSomeCasesRunAgain', async () => {
    const workspace = await workspaceFixture()
    const spawnTests = reporting([true], 1)

    await runEvalsTest({ workspace, now: () => NOW, only: ['b'] }, { run: environmentRunner(), spawnTests })

    const copy = runFile(workspace, '.state/experiment.json')
    expect(spawnTests.mock.calls[0]![0].args[3]).toBe(copy)
    expect(JSON.parse(await readFile(copy, 'utf8'))).toEqual({ cases: [{ name: 'b' }], evaluators: [] })
    expect(await readFile(experimentFile(workspace.directory!, 'support'), 'utf8')).toBe(EXPERIMENT)
  })

  it('shouldKeepTheRunInAnOutsideHomeWhenTheExperimentIsOutsideTheFolder', async () => {
    const workspace = await workspaceFixture([])
    const experiment = join(workspace.root, 'cases', 'refunds.json')
    await writeFileAt(experiment, EXPERIMENT)
    const spawnTests = reporting([true, true], 1)

    const outcome = await runEvalsTest(
      { workspace, experiment, now: () => NOW },
      { run: environmentRunner(), spawnTests }
    )

    const home = join(workspace.directory!, 'tmp/.state/outside-experiments/refunds')
    expect(outcome).toMatchObject({
      experiment,
      name: experiment,
      home,
      report: join(home, 'runs', STAMP, 'report.json'),
    })
  })

  it('shouldWriteTheTemporaryTypescriptRunnerIntoTheEntryFileWhenTheAgentIsTypeScript', async () => {
    const workspace = await workspaceFixture(['support'], 'typescript')
    const spawnTests = reporting([true], 1)

    await runEvalsTest({ workspace, now: () => NOW }, { run: environmentRunner(), spawnTests })

    const entry = await readFile(runFile(workspace, '.state/task.py'), 'utf8')
    const runner = JSON.parse(/^ {4}temporary_typescript_runner=(".*"),$/mu.exec(entry)![1]!) as string
    expect(runner).toMatch(/^'.+' '.+typescript-runner-main\.js'$/u)
    expect(entry).toContain(`    ${JSON.stringify(workspace.entrypoint)},\n`)
    expect(spawnTests.mock.calls[0]![0].args).not.toContain('--typescript-runner')
  })

  it.each([
    { experiments: [], requested: undefined, message: 'There is no experiment to evaluate yet' },
    { experiments: [], requested: 'refunds', message: 'then run strands dev evaluate again' },
    { experiments: ['a', 'b'], requested: undefined, message: 'for example strands dev evaluate a' },
  ])('shouldGuideTheUserToAnExperimentWhen$message', async ({ experiments, requested, message }) => {
    const workspace = await workspaceFixture(experiments)
    const spawnTests = reporting([true], 1)

    await expect(
      runEvalsTest(
        { workspace, ...(requested ? { experiment: requested } : {}) },
        { run: environmentRunner(), spawnTests }
      )
    ).rejects.toThrow(message)
    expect(spawnTests).not.toHaveBeenCalled()
  })

  it.each([
    ['--output', 'x.json'],
    ['--fail-on', 'any'],
    ['--agent', 'other.py'],
    ['--task', 'other.py:task'],
  ])('shouldRejectFlagsThatTestSetsItselfWhen%sIsPassed', async (...evalsArguments) => {
    const workspace = await workspaceFixture()

    await expect(runEvalsTest({ workspace, evalsArguments })).rejects.toThrow('strands dev sets')
  })

  it.each([
    { code: 2, step: 'Fix the cause above \\(it is in the agent file, the experiment file, or the flags after --\\)' },
    { code: 3, step: 'Fix the error above, then run the evaluation again' },
  ])('shouldReportTheRunErrorAndTheNextStepWhenRunExitsWith$code', async ({ code, step }) => {
    const workspace = await workspaceFixture()
    const spawnTests = vi.fn(async () => ({
      code,
      stdout: '',
      stderrTail: ['strands-evals: error: Unable to locate credentials'],
    }))

    await expect(runEvalsTest({ workspace }, { run: environmentRunner(), spawnTests })).rejects.toThrow(
      new RegExp(`exit code ${code}: Unable to locate credentials\\n${step}`, 'u')
    )
  })

  it.each([
    {
      content: '{"cases": [',
      message: /is not a usable Experiment file \(.+\)\. Fix the file, or draft new cases with \/experiment/u,
    },
    {
      content: JSON.stringify({ cases: [], evaluators: [] }),
      message: /has no cases, so there is nothing to evaluate/u,
    },
  ])('shouldExplainWhatToFixWhenTheExperimentFileCannotBeTested', async ({ content, message }) => {
    const workspace = await workspaceFixture([])
    await writeFileAt(experimentFile(workspace.directory!, 'support'), content)
    const spawnTests = reporting([true], 1)

    await expect(runEvalsTest({ workspace }, { run: environmentRunner(), spawnTests })).rejects.toThrow(message)
    expect(spawnTests).not.toHaveBeenCalled()
  })

  it('shouldSayTheExperimentNeedsEvaluatorsWhenTheReportHasNoChecks', async () => {
    const workspace = await workspaceFixture()

    await expect(
      runEvalsTest({ workspace }, { run: environmentRunner(), spawnTests: reporting([], 0) })
    ).rejects.toThrow(/has no results\. Check that .+support\.json lists evaluators/u)
  })
})

const RUN = { experiment: 'refunds', seconds: 12.5 }
const REPORT_STAMP = '20261111-205909'
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

const writeRunReport = async (home: string, content: unknown, stamp = REPORT_STAMP): Promise<string> => {
  const path = join(home, 'runs', stamp, 'report.json')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content))
  return path
}

const writeReport = async (content: unknown): Promise<string> => writeRunReport(await experimentHome(), content)

describe('evaluation report', () => {
  it('shouldGroupTheVerdictsByCaseWhenTheReportHasSeveralEvaluators', async () => {
    const path = await writeReport(report(ROWS, 0.375))

    const results = await readEvalsTestResults(path, RUN)

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

    const { cases } = await readEvalsTestResults(path, RUN)

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

    const [result] = (await readEvalsTestResults(path, RUN)).cases

    expect(result).toMatchObject({ input: '{"order":7,"items":["shoe"]}', actual: '{"refund":true}' })
  })

  it('shouldShowTheAssertionAsTheExpectedAnswerWhenACaseHasNoExpectedOutput', async () => {
    const graded = row({ name: 'c0', evaluator: 'Correctness', score: 1, passed: true, reason: 'ok', actual: 'done' })
    const testCase = { ...graded.testCase, expected_output: null, expected_assertion: 'The agent refunds order 7.' }
    const path = await writeReport({ ...report([graded]), cases: [testCase] })

    const [result] = (await readEvalsTestResults(path, RUN)).cases

    expect(result).toMatchObject({ expected: 'The agent refunds order 7.', actual: 'done' })
  })

  it('shouldNameCasesLikeStrandsEvalsWhenACaseHasNoName', async () => {
    const path = await writeReport(
      report([
        row({ name: null, evaluator: 'Equals', score: 1, passed: true, reason: 'ok', actual: 'a' }),
        row({ name: null, evaluator: 'Equals', score: 0, passed: false, reason: 'no', actual: 'b' }),
        row({ name: null, evaluator: 'judge', score: 1, passed: true, reason: 'ok', actual: 'a' }),
        row({ name: null, evaluator: 'judge', score: 1, passed: true, reason: 'ok', actual: 'b' }),
      ])
    )

    const { cases } = await readEvalsTestResults(path, RUN)

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

    await expect(readEvalsTestResults(path, RUN)).rejects.toThrow(
      new RegExp(
        `^${literal(path)} is not a usable evaluation report \\(.*${detail}.*\\)\\. Run the evaluation again\\.$`,
        'u'
      )
    )
  })
})

const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

const latestReport = (home: string): string => join(home, 'refunds.report.json')

const latestRecord = (home: string): string => join(home, '.state/latest.json')

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'))

const rememberRun = async (home: string, content: unknown, stamp: string, only?: string[]) => {
  const path = await writeRunReport(home, content, stamp)
  return rememberEvalsTestResults(home, await readEvalsTestResults(path, RUN), only)
}

describe('last evaluation run', () => {
  it('shouldReadTheRememberedResultsWhenTheExperimentRanBefore', async () => {
    const home = await experimentHome()
    const results = await readEvalsTestResults(await writeRunReport(home, report(ROWS)), RUN)

    const remembered = await rememberEvalsTestResults(home, results)

    expect(remembered).toEqual({ ...results, report: latestReport(home) })
    expect(await readEvalsLatestTestResults(home)).toEqual(remembered)
  })

  it('shouldReplaceTheLatestReportAndRecordTheRunWhenAFullRunFollowsAnother', async () => {
    const home = await experimentHome()
    await rememberRun(home, report(ROWS, 0.375), REPORT_STAMP)
    const second = report([ROWS[0]!], 1)

    await rememberRun(home, second, RERUN_STAMP)

    expect(await readJson(latestReport(home))).toEqual(second)
    expect(await readJson(latestRecord(home))).toEqual({ run: join('runs', RERUN_STAMP), seconds: 12.5 })
  })

  it('shouldReplaceTheRerunRowsAndKeepTheOtherCasesWhenFailedCasesRunAgain', async () => {
    const home = await experimentHome()
    await rememberRun(home, report(ROWS, 0.375), REPORT_STAMP)
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
    await rememberRun(home, report(ROWS, 0.375), REPORT_STAMP)
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
    { label: 'AllNotApplicableAndPassed', outputs: [{ label: 'not_applicable', test_pass: true }], overall: 1 },
    { label: 'NotApplicableButFailed', outputs: [{ label: 'not_applicable', test_pass: false }], overall: 0.5 },
    {
      label: 'NotEvaluated',
      outputs: [{ label: 'not_applicable', test_pass: false, metadata: { could_not_evaluate: true } }],
      overall: 1,
    },
    { label: 'Empty', outputs: [], overall: 0.5 },
    {
      label: 'PartlyNotApplicable',
      outputs: [
        { label: 'not_applicable', test_pass: true },
        { label: null, test_pass: true },
      ],
      overall: 0.5,
    },
  ])('shouldRecomputeTheOverallScoreWhenTheRerunOutputsAre$label', async ({ outputs, overall }) => {
    const home = await experimentHome()
    const previous = [
      row({ name: 'c0', evaluator: 'Equals', score: 1, passed: true, reason: 'matches' }),
      row({ name: 'c1', evaluator: 'Equals', score: 0, passed: false, reason: 'differs' }),
    ]
    await rememberRun(home, report(previous, 0.5), REPORT_STAMP)

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

    await rememberRun(home, report(ROWS, 0.375), REPORT_STAMP)

    expect((await readdir(join(home, 'runs'))).sort()).toEqual([...old.slice(2), REPORT_STAMP])
  })

  it('shouldReturnNothingWhenTheExperimentNeverRan', async () => {
    expect(await readEvalsLatestTestResults(await experimentHome())).toBeUndefined()
  })

  it.each([
    { record: '{"run": ', detail: 'JSON' },
    { record: JSON.stringify({ run: join('runs', REPORT_STAMP) }), detail: 'it has no run time' },
  ])('shouldAskForANewTestRunWhenTheLastRunRecordHas$detail', async ({ record, detail }) => {
    const home = await experimentHome()
    await mkdir(dirname(latestRecord(home)), { recursive: true })
    await writeFile(latestRecord(home), record)

    await expect(readEvalsLatestTestResults(home)).rejects.toThrow(
      new RegExp(
        `^${literal(latestRecord(home))} is not a usable record of the last evaluation run \\(.*${detail}.*\\)\\. Run the evaluation again\\.$`,
        'u'
      )
    )
  })

  it('shouldAskForANewTestRunWhenTheRememberedReportIsGone', async () => {
    const home = await experimentHome()
    await rememberRun(home, report(ROWS), REPORT_STAMP)
    await rm(latestReport(home))

    await expect(readEvalsLatestTestResults(home)).rejects.toThrow(
      `${latestReport(home)} is not a usable evaluation report`
    )
  })
})
