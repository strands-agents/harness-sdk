import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { parseArgs } from '../../../src/cli/arguments.js'
import { runTemporaryDevCommand } from '../../../src/dev/temporary-evals-fork/cli.js'
import { temporaryVenvPython, type TemporaryCommandRequest } from '../../../src/dev/temporary-evals-fork/environment.js'
import type { PreparedDevRun } from '../../../src/dev/prepare.js'
import type { DevWorkspace } from '../../../src/dev/workspace.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const writeFileAt = async (path: string, text = '{}'): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

const workspaceFixture = async (language: 'python' | 'typescript' = 'python'): Promise<DevWorkspace> => {
  const root = await temporaryDirectory()
  const directory = join(root, 'strands-dev')
  await writeFileAt(temporaryVenvPython(join(root, '.venv')), 'fixture interpreter')
  await writeFileAt(join(directory, 'tmp/experiments/support.json'), JSON.stringify({ cases: [{ name: 'a' }] }))
  return {
    directory,
    root,
    entrypoint: join(root, 'agent.py'),
    config: { version: 1, name: 'desk', language, entrypoint: 'agent.py', origin: { kind: 'discovered' } },
  }
}

const run = (workspace: DevWorkspace) =>
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
      { openWorkspace: async () => opened(workspace), prepareProject, run: run(workspace), spawnOptimizer }
    )

    expect(code).toBe(0)
    expect(stdout.text()).toBe('ships candidate 0: {}\n')
    expect(stderr.text()).toContain('candidate  0 baseline complete\n')
    expect(prepareProject).toHaveBeenCalledWith(workspace)
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
    const spawnTests = vi.fn(async ({ args }: { args: string[] }) => {
      const report = args[args.indexOf('--output') + 1]!
      await writeFileAt(report, JSON.stringify({ overall_score: 0.5, test_passes: passes }))
      return { code: 0, stdout: '', stderrTail: [] }
    })

    const exit = await runTemporaryDevCommand(
      parseArgs(['dev', 'test', 'support']),
      { stdout: stdout.stream, stderr: stderr.stream },
      {
        openWorkspace: async () => opened(workspace),
        prepareProject: vi.fn(async () => {}),
        run: run(workspace),
        spawnTests,
      }
    )

    expect(exit).toBe(code)
    const lines = stdout.text().trim().split('\n')
    expect(lines[0]).toBe(`${passes.filter(Boolean).length} of 2 checks passed (overall score 0.50)`)
    expect(lines.at(-1)).toContain(last)
  })

  it('shouldKeepTheWorkspaceInTheNextStepWhenDevTestRunsOnAnotherWorkspace', async () => {
    const workspace = await workspaceFixture()
    const stdout = captured()
    const spawnTests = vi.fn(async ({ args }: { args: string[] }) => {
      await writeFileAt(args[args.indexOf('--output') + 1]!, JSON.stringify({ overall_score: 0, test_passes: [false] }))
      return { code: 0, stdout: '', stderrTail: [] }
    })

    await runTemporaryDevCommand(
      parseArgs(['dev', 'test', 'support', '--workspace', '/work/desk']),
      { stdout: stdout.stream, stderr: captured().stream },
      {
        openWorkspace: async () => opened(workspace),
        prepareProject: vi.fn(async () => {}),
        run: run(workspace),
        spawnTests,
      }
    )

    expect(stdout.text()).toContain('Run strands dev optimize --workspace /work/desk support to improve')
  })
})
