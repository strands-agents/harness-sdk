import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { parseArgs } from '../../../src/cli/arguments.js'
import { runTemporaryDevCommand } from '../../../src/dev/temporary-evals-fork/cli.js'
import { temporaryVenvPython } from '../../../src/dev/temporary-evals-fork/environment.js'
import type { PreparedDevRun } from '../../../src/dev/prepare.js'
import type { DevWorkspace } from '../../../src/dev/workspace.js'
import {
  environmentRunner,
  optimizerProposerError,
  writeFileAt,
  writeOptimizerRun,
} from '../../fixtures/optimizer-run.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const workspaceFixture = async (language: 'python' | 'typescript' = 'python'): Promise<DevWorkspace> => {
  const root = await temporaryDirectory()
  const directory = join(root, 'strands-dev')
  await writeFileAt(temporaryVenvPython(join(root, '.venv')), 'fixture interpreter')
  await writeFileAt(join(directory, 'experiments/support/support.json'), JSON.stringify({ cases: [{ name: 'a' }] }))
  return {
    directory,
    root,
    entrypoint: join(root, 'agent.py'),
    config: { version: 1, name: 'desk', language, entrypoint: 'agent.py', origin: { kind: 'discovered' } },
  }
}

const reportingTests = (report: unknown) =>
  vi.fn(async ({ args }: { args: string[] }) => {
    await writeFileAt(args[args.indexOf('--output') + 1]!, JSON.stringify(report))
    return { code: 0, stdout: '', stderrTail: [] }
  })

const captured = (): { stream: PassThrough; text: () => string } => {
  const stream = new PassThrough()
  const chunks: string[] = []
  stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString()))
  return { stream, text: () => chunks.join('') }
}

const opened = (workspace: DevWorkspace): PreparedDevRun =>
  ({ workspace, config: { applyProviderEnvironment: vi.fn() } }) as unknown as PreparedDevRun

describe('TEMPORARY strands dev optimize command', () => {
  it('shouldWriteTheSummaryToStdoutAndProgressToStderrWhenTheOptimizationSucceeds', async () => {
    const workspace = await workspaceFixture()
    const stdout = captured()
    const stderr = captured()
    const prepareProject = vi.fn(async () => {})
    const spawnOptimizer = vi.fn(async ({ onLine }: { onLine: (line: string) => void }) => {
      onLine('candidate  0 baseline complete')
      return { code: 0, stdout: 'ships candidate 0: {}\n', stderrTail: [] }
    })

    const code = await runTemporaryDevCommand(
      parseArgs(['dev', 'optimize', 'support']),
      { stdout: stdout.stream, stderr: stderr.stream },
      { openWorkspace: async () => opened(workspace), prepareProject, run: environmentRunner(), spawnOptimizer }
    )

    expect(code).toBe(0)
    expect(stdout.text()).toBe('ships candidate 0: {}\n')
    expect(stderr.text()).toContain('candidate  0 baseline complete\n')
    expect(prepareProject).toHaveBeenCalledWith(workspace)
  })

  it('shouldPrintTheProposerFailureAndExitWithOneWhenTheSearchStoppedOnAProposerError', async () => {
    const workspace = await workspaceFixture()
    const stderr = captured()
    const spawnOptimizer = vi.fn(async ({ args }: { args: string[] }) => {
      await writeOptimizerRun(args[args.indexOf('--base-dir') + 1]!, [
        optimizerProposerError('RuntimeError', 'model down'),
      ])
      return { code: 3, stdout: '', stderrTail: [] }
    })

    const code = await runTemporaryDevCommand(
      parseArgs(['dev', 'optimize', 'support']),
      { stdout: captured().stream, stderr: stderr.stream },
      {
        openWorkspace: async () => opened(workspace),
        prepareProject: vi.fn(async () => {}),
        run: environmentRunner(),
        spawnOptimizer,
      }
    )

    expect(code).toBe(1)
    expect(stderr.text()).toContain('error: The proposer failed with RuntimeError: model down.\n')
  })

  it('shouldFailBeforePreparingTheProjectWhenTheExperimentIsMissing', async () => {
    const workspace = await workspaceFixture('typescript')
    const stdout = captured()
    const stderr = captured()
    const prepareProject = vi.fn(async () => {})

    const code = await runTemporaryDevCommand(
      parseArgs(['dev', 'optimize', 'refunds']),
      { stdout: stdout.stream, stderr: stderr.stream },
      { openWorkspace: async () => opened(workspace), prepareProject }
    )

    expect(code).toBe(1)
    expect(stderr.text()).toContain('error: No experiment named refunds')
    expect(prepareProject).not.toHaveBeenCalled()
    expect(stdout.text()).toBe('')
  })

  it.each([
    { passes: [true, true], code: 0, last: 'Every check passed.' },
    { passes: [true, false], code: 1, last: 'Run strands dev optimize support to improve the agent on them.' },
  ])('shouldExitWith$codeAndPrintTheSummaryWhenDevTestFinishes', async ({ passes, code, last }) => {
    const workspace = await workspaceFixture()
    const stdout = captured()
    const stderr = captured()
    const spawnTests = reportingTests({ overall_score: 0.5, test_passes: passes })

    const exit = await runTemporaryDevCommand(
      parseArgs(['dev', 'evaluate', 'support']),
      { stdout: stdout.stream, stderr: stderr.stream },
      {
        openWorkspace: async () => opened(workspace),
        prepareProject: vi.fn(async () => {}),
        run: environmentRunner(),
        spawnTests,
      }
    )

    expect(exit).toBe(code)
    const lines = stdout.text().trim().split('\n')
    expect(lines[0]).toBe(`${passes.filter(Boolean).length} of 2 checks passed (overall score 0.50)`)
    expect(lines.at(-1)).toContain(last)
    expect(lines[1]).toMatch(/^Report: .+[\\/]report\.json$/u)
    expect(lines[1]!.startsWith(`Report: ${join(workspace.directory!, 'experiments', 'support', 'runs')}`)).toBe(true)
  })

  it('shouldKeepTheWorkspaceInTheNextStepWhenDevTestRunsOnAnotherWorkspace', async () => {
    const workspace = await workspaceFixture()
    const stdout = captured()
    const spawnTests = reportingTests({ overall_score: 0, test_passes: [false] })

    await runTemporaryDevCommand(
      parseArgs(['dev', 'evaluate', 'support', '--workspace', '/work/desk']),
      { stdout: stdout.stream, stderr: captured().stream },
      {
        openWorkspace: async () => opened(workspace),
        prepareProject: vi.fn(async () => {}),
        run: environmentRunner(),
        spawnTests,
      }
    )

    expect(stdout.text()).toContain('Run strands dev optimize --workspace /work/desk support to improve')
  })

  it('shouldWriteTheLatestResultWhenAHeadlessTestFinishes', async () => {
    const workspace = await workspaceFixture()
    const stderr = captured()
    const report = {
      overall_score: 1,
      cases: [{ name: 'a', evaluator: 'Equals' }],
      scores: [1],
      test_passes: [true],
      reasons: ['matches'],
    }

    await runTemporaryDevCommand(
      parseArgs(['dev', 'evaluate', 'support']),
      { stdout: captured().stream, stderr: stderr.stream },
      {
        openWorkspace: async () => opened(workspace),
        prepareProject: vi.fn(async () => {}),
        run: environmentRunner(),
        spawnTests: reportingTests(report),
      }
    )

    const home = join(workspace.directory!, 'experiments/support')
    const latest = JSON.parse(await readFile(join(home, '.state/latest.json'), 'utf8')) as {
      run: string
      seconds: number
    }
    expect(dirname(latest.run)).toBe('runs')
    expect(latest.seconds).toBeGreaterThanOrEqual(0)
    expect(JSON.parse(await readFile(join(home, latest.run, 'report.json'), 'utf8'))).toEqual(report)
    expect(JSON.parse(await readFile(join(home, 'support.report.json'), 'utf8'))).toEqual(report)
    expect(stderr.text()).not.toContain('warning:')
  })

  it('shouldWarnOnStderrWhenAHeadlessTestCannotWriteTheLatestResult', async () => {
    const workspace = await workspaceFixture()
    const stderr = captured()

    const exit = await runTemporaryDevCommand(
      parseArgs(['dev', 'evaluate', 'support']),
      { stdout: captured().stream, stderr: stderr.stream },
      {
        openWorkspace: async () => opened(workspace),
        prepareProject: vi.fn(async () => {}),
        run: environmentRunner(),
        spawnTests: reportingTests({ overall_score: 1, test_passes: [true] }),
      }
    )

    expect(exit).toBe(0)
    expect(stderr.text()).toMatch(
      /warning: this result is not kept as the latest report: .+ is not a usable evaluation report/u
    )
    expect(existsSync(join(workspace.directory!, 'experiments/support/.state/latest.json'))).toBe(false)
  })
})
