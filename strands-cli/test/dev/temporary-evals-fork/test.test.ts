import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { temporaryVenvPython, type TemporaryCommandRequest } from '../../../src/dev/temporary-evals-fork/environment.js'
import type { TemporaryEvalsProcess } from '../../../src/dev/temporary-evals-fork/evals-process.js'
import { runTemporaryTest } from '../../../src/dev/temporary-evals-fork/test.js'
import type { DevWorkspace } from '../../../src/dev/workspace.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const NOW = new Date('2026-11-11T15:04:05Z')
const EXPERIMENT = JSON.stringify({ cases: [{ name: 'a' }, { name: 'b' }], evaluators: [] })

const writeFileAt = async (path: string, text = EXPERIMENT): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

const workspaceFixture = async (
  experiments: string[] = ['support.json'],
  language: 'python' | 'typescript' = 'python'
): Promise<DevWorkspace> => {
  const root = await temporaryDirectory()
  const directory = join(root, 'strands-dev')
  await writeFileAt(temporaryVenvPython(join(root, '.venv')), 'fixture interpreter')
  await Promise.all(experiments.map((name) => writeFileAt(join(directory, 'tmp/experiments', name))))
  return {
    directory,
    root,
    entrypoint: join(root, language === 'python' ? 'agent.py' : 'agent.ts'),
    config: { version: 1, name: 'desk', language, entrypoint: 'agent.py', origin: { kind: 'discovered' } },
  }
}

const environmentRunner = (workspace: DevWorkspace) =>
  vi.fn(async ({ args }: TemporaryCommandRequest): Promise<string> => {
    if (args[1]?.includes('platform.python_version')) return JSON.stringify({ version: '3.12.4', paths: [] })
    if (args[0] === '-m' && args[1] === 'venv') await writeFileAt(temporaryVenvPython(args[3]!), 'fixture interpreter')
    if (args[1]?.includes('site.getsitepackages()[0]')) {
      const sitePackages = join(workspace.directory!, 'tmp/optimization/.venv/lib/site-packages')
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
  it('shouldRunTheExperimentAndSaveTheReportInTheReportsFolder', async () => {
    const workspace = await workspaceFixture()
    const spawnTests = reporting([true, false], 0.5)
    const progress: string[] = []

    const outcome = await runTemporaryTest(
      { workspace, forkArguments: ['--max-workers', '2'], now: () => NOW, onProgress: (line) => progress.push(line) },
      { run: environmentRunner(workspace), spawnTests }
    )

    const report = join(workspace.directory!, 'tmp/reports/20261111-150405-support.json')
    expect(outcome).toEqual({
      experiment: join(workspace.directory!, 'tmp/experiments/support.json'),
      name: 'support',
      report,
      passed: 1,
      checks: 2,
      overall: 0.5,
    })
    const [{ args, log }] = spawnTests.mock.calls[0]!
    expect(args).toEqual([
      '-m',
      'strands_evals.cli',
      'run',
      join(workspace.directory!, 'tmp/experiments/support.json'),
      '--agent',
      workspace.entrypoint,
      '--output',
      report,
      '--fail-on',
      'none',
      '--max-workers',
      '2',
    ])
    expect(log).toBe(join(workspace.directory!, 'tmp/reports/20261111-150405-support.log'))
    expect(progress).toContain(`Testing ${workspace.entrypoint} on the 2 cases of ${outcome.experiment}`)
  })

  it('shouldPassTheTypescriptRunnerWhenTheAgentIsTypeScript', async () => {
    const workspace = await workspaceFixture(['support.json'], 'typescript')
    const spawnTests = reporting([true], 1)

    await runTemporaryTest({ workspace }, { run: environmentRunner(workspace), spawnTests })

    expect(spawnTests.mock.calls[0]![0].args).toContain('--typescript-runner')
  })

  it.each([
    { experiments: [], requested: undefined, message: 'There is no experiment to test yet' },
    { experiments: [], requested: 'refunds', message: 'then run /test refunds' },
    { experiments: ['a.json', 'b.json'], requested: undefined, message: 'for example /test a in a chat' },
  ])('shouldGuideTheUserToAnExperimentWhen$message', async ({ experiments, requested, message }) => {
    const workspace = await workspaceFixture(experiments)
    const spawnTests = reporting([true], 1)

    await expect(
      runTemporaryTest(
        { workspace, ...(requested ? { experiment: requested } : {}) },
        { run: environmentRunner(workspace), spawnTests }
      )
    ).rejects.toThrow(message)
    expect(spawnTests).not.toHaveBeenCalled()
  })

  it.each([
    ['--output', 'x.json'],
    ['--fail-on', 'any'],
    ['--agent', 'other.py'],
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

    await expect(runTemporaryTest({ workspace }, { run: environmentRunner(workspace), spawnTests })).rejects.toThrow(
      new RegExp(`exit code ${code}: Unable to locate credentials\\n${step}`, 'u')
    )
  })

  it.each([
    {
      content: '{"cases": [',
      message: /is not a usable Experiment file \(.+\)\. Fix the file, or make a new one with \/experiment/u,
    },
    { content: JSON.stringify({ cases: [], evaluators: [] }), message: /has no cases, so there is nothing to test/u },
  ])('shouldExplainWhatToFixWhenTheExperimentFileCannotBeTested', async ({ content, message }) => {
    const workspace = await workspaceFixture([])
    await writeFileAt(join(workspace.directory!, 'tmp/experiments/support.json'), content)
    const spawnTests = reporting([true], 1)

    await expect(runTemporaryTest({ workspace }, { run: environmentRunner(workspace), spawnTests })).rejects.toThrow(
      message
    )
    expect(spawnTests).not.toHaveBeenCalled()
  })

  it('shouldSayTheExperimentNeedsEvaluatorsWhenTheReportHasNoChecks', async () => {
    const workspace = await workspaceFixture()

    await expect(
      runTemporaryTest({ workspace }, { run: environmentRunner(workspace), spawnTests: reporting([], 0) })
    ).rejects.toThrow(/has no results\. Check that .+support\.json lists evaluators/u)
  })
})
