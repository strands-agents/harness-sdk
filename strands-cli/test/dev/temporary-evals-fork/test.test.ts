import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

import { temporaryVenvPython, type TemporaryCommandRequest } from '../../../src/dev/temporary-evals-fork/environment.js'
import type { TemporaryEvalsProcess } from '../../../src/dev/temporary-evals-fork/evals-process.js'
import { runTemporaryTest } from '../../../src/dev/temporary-evals-fork/test.js'
import type { DevWorkspace } from '../../../src/dev/workspace.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const NOW = new Date('2026-11-11T15:04:05Z')
const STAMP = '20261111-150405'
const EXPERIMENT = JSON.stringify({ cases: [{ name: 'a' }, { name: 'b' }], evaluators: [] })
const EVALS_AGENT_FOLDER = fileURLToPath(new URL('../../../src/dev/evals-agent', import.meta.url))

const writeFileAt = async (path: string, text = EXPERIMENT): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

const experimentFile = (directory: string, name: string): string => join(directory, 'experiments', name, `${name}.json`)

const workspaceFixture = async (
  experiments: string[] = ['support'],
  language: 'python' | 'typescript' = 'python'
): Promise<DevWorkspace> => {
  const root = await temporaryDirectory()
  const directory = join(root, 'strands-dev')
  await writeFileAt(temporaryVenvPython(join(root, '.venv')), 'fixture interpreter')
  await Promise.all(experiments.map((name) => writeFileAt(experimentFile(directory, name))))
  return {
    directory,
    root,
    entrypoint: join(root, language === 'python' ? 'agent.py' : 'agent.ts'),
    config: { version: 1, name: 'desk', language, entrypoint: 'agent.py', origin: { kind: 'discovered' } },
  }
}

const supportHome = (workspace: DevWorkspace): string => join(workspace.directory!, 'experiments/support')

const runFile = (workspace: DevWorkspace, file: string, stamp = STAMP): string =>
  join(supportHome(workspace), 'runs', stamp, file)

const sitePackagesOf = (python: string): string => join(dirname(dirname(python)), 'lib', 'site-packages')

const environmentRunner = () =>
  vi.fn(async ({ command, args }: TemporaryCommandRequest): Promise<string> => {
    if (args[1]?.includes('platform.python_version')) return JSON.stringify({ version: '3.12.4', paths: [] })
    if (args[0] === '-m' && args[1] === 'venv') await writeFileAt(temporaryVenvPython(args[3]!), 'fixture interpreter')
    if (args[1]?.includes('site.getsitepackages()[0]')) {
      const sitePackages = sitePackagesOf(command)
      await mkdir(sitePackages, { recursive: true })
      return sitePackages
    }
    return ''
  })

const reporting = (passes: boolean[], overall: number) =>
  vi.fn(async ({ args }: TemporaryEvalsProcess) => {
    await writeFileAt(
      args[args.indexOf('--output') + 1]!,
      JSON.stringify({ overall_score: overall, test_passes: passes })
    )
    return { code: 0, stdout: '', stderrTail: ['strands-evals run | Contains: 1/2 passed (0.50) | overall: 0.50'] }
  })

describe('TEMPORARY /test', () => {
  it('shouldRunTheExperimentAndSaveTheReportInItsRunFolder', async () => {
    const workspace = await workspaceFixture()
    const spawnTests = reporting([true, false], 0.5)
    const progress: string[] = []
    const onStart = vi.fn()

    const outcome = await runTemporaryTest(
      {
        workspace,
        forkArguments: ['--max-workers', '2'],
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

    await runTemporaryTest(
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

      await runTemporaryTest(
        { workspace, forkArguments: given, now: () => NOW },
        { run: environmentRunner(), spawnTests }
      )

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

    await runTemporaryTest({ workspace, resume }, { run: environmentRunner(), spawnTests })

    const task = runFile(workspace, '.state/task.py', `${STAMP}-3`)
    const { args } = spawnTests.mock.calls[0]![0]
    expect(args.slice(args.indexOf('--task'), args.indexOf('--task') + 2)).toEqual(['--task', `${task}:task`])
    expect(await readFile(task, 'utf8')).toContain(`    experiment_file=${JSON.stringify(resume.cases)},\n`)
  })

  it('shouldRunFourCasesAtOnceWhenNoWorkerCountIsGiven', async () => {
    const workspace = await workspaceFixture()
    const spawnTests = reporting([true, false], 0.5)

    await runTemporaryTest({ workspace, now: () => NOW }, { run: environmentRunner(), spawnTests })

    const [{ args }] = spawnTests.mock.calls[0]!
    expect(args.slice(args.indexOf('--max-workers'))).toEqual(['--max-workers', '4'])
  })

  it('shouldStartANewRunFolderWhenAnotherRunStartedInTheSameSecond', async () => {
    const workspace = await workspaceFixture()
    const run = environmentRunner()
    const spawnTests = reporting([true, false], 0.5)

    const first = await runTemporaryTest({ workspace, now: () => NOW }, { run, spawnTests })
    const second = await runTemporaryTest({ workspace, now: () => NOW }, { run, spawnTests })

    expect(first.report).toBe(runFile(workspace, 'report.json'))
    expect(second.report).toBe(runFile(workspace, 'report.json', `${STAMP}-2`))
  })

  it('shouldCountTheSecondsFromTheGivenStartWhenTheRunStartedEarlier', async () => {
    const workspace = await workspaceFixture()

    const outcome = await runTemporaryTest(
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

    const outcome = await runTemporaryTest({ workspace, now: () => NOW }, { run: environmentRunner(), spawnTests })

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

    await runTemporaryTest({ workspace, now: () => NOW, only: ['b'] }, { run: environmentRunner(), spawnTests })

    const copy = runFile(workspace, '.state/experiment.json')
    expect(spawnTests.mock.calls[0]![0].args[3]).toBe(copy)
    expect(JSON.parse(await readFile(copy, 'utf8'))).toEqual({ cases: [{ name: 'b' }], evaluators: [] })
    expect(await readFile(experimentFile(workspace.directory!, 'support'), 'utf8')).toBe(EXPERIMENT)
  })

  it('shouldKeepTheRunInAnOutsideHomeWhenTheExperimentIsOutsideTheFolder', async () => {
    const workspace = await workspaceFixture([])
    const experiment = join(workspace.root, 'cases', 'refunds.json')
    await writeFileAt(experiment)
    const spawnTests = reporting([true, true], 1)

    const outcome = await runTemporaryTest(
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

    await runTemporaryTest({ workspace, now: () => NOW }, { run: environmentRunner(), spawnTests })

    const entry = await readFile(runFile(workspace, '.state/task.py'), 'utf8')
    const runner = JSON.parse(/^ {4}temporary_typescript_runner=(".*"),$/mu.exec(entry)![1]!) as string
    expect(runner).toMatch(/^'.+' '.+typescript-runner-main\.js'$/u)
    expect(entry).toContain(`    ${JSON.stringify(workspace.entrypoint)},\n`)
    expect(spawnTests.mock.calls[0]![0].args).not.toContain('--typescript-runner')
  })

  it.each([
    { experiments: [], requested: undefined, message: 'There is no experiment to test yet' },
    { experiments: [], requested: 'refunds', message: 'then run strands dev test again' },
    { experiments: ['a', 'b'], requested: undefined, message: 'for example strands dev test a' },
  ])('shouldGuideTheUserToAnExperimentWhen$message', async ({ experiments, requested, message }) => {
    const workspace = await workspaceFixture(experiments)
    const spawnTests = reporting([true], 1)

    await expect(
      runTemporaryTest(
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
  ])('shouldRejectFlagsThatTestSetsItselfWhen%sIsPassed', async (...forkArguments) => {
    const workspace = await workspaceFixture()

    await expect(runTemporaryTest({ workspace, forkArguments })).rejects.toThrow('strands dev sets')
  })

  it.each([
    { code: 2, step: 'Fix the cause above \\(it is in the agent file, the experiment file, or the flags after --\\)' },
    { code: 3, step: 'Fix the error above, then run the test again' },
  ])('shouldReportTheRunErrorAndTheNextStepWhenRunExitsWith$code', async ({ code, step }) => {
    const workspace = await workspaceFixture()
    const spawnTests = vi.fn(async () => ({
      code,
      stdout: '',
      stderrTail: ['strands-evals: error: Unable to locate credentials'],
    }))

    await expect(runTemporaryTest({ workspace }, { run: environmentRunner(), spawnTests })).rejects.toThrow(
      new RegExp(`exit code ${code}: Unable to locate credentials\\n${step}`, 'u')
    )
  })

  it.each([
    {
      content: '{"cases": [',
      message: /is not a usable Experiment file \(.+\)\. Fix the file, or draft new cases with \/experiment/u,
    },
    { content: JSON.stringify({ cases: [], evaluators: [] }), message: /has no cases, so there is nothing to test/u },
  ])('shouldExplainWhatToFixWhenTheExperimentFileCannotBeTested', async ({ content, message }) => {
    const workspace = await workspaceFixture([])
    await writeFileAt(experimentFile(workspace.directory!, 'support'), content)
    const spawnTests = reporting([true], 1)

    await expect(runTemporaryTest({ workspace }, { run: environmentRunner(), spawnTests })).rejects.toThrow(message)
    expect(spawnTests).not.toHaveBeenCalled()
  })

  it('shouldSayTheExperimentNeedsEvaluatorsWhenTheReportHasNoChecks', async () => {
    const workspace = await workspaceFixture()

    await expect(
      runTemporaryTest({ workspace }, { run: environmentRunner(), spawnTests: reporting([], 0) })
    ).rejects.toThrow(/has no results\. Check that .+support\.json lists evaluators/u)
  })
})
