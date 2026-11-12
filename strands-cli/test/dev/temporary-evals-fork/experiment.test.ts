import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { temporaryVenvPython, type TemporaryCommandRequest } from '../../../src/dev/temporary-evals-fork/environment.js'
import type { TemporaryEvalsProcess } from '../../../src/dev/temporary-evals-fork/evals-process.js'
import { draftTemporaryExperiment } from '../../../src/dev/temporary-evals-fork/experiment.js'
import type { DevWorkspace } from '../../../src/dev/workspace.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const writeFileAt = async (path: string, text = '{}'): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

const workspaceFixture = async (experiments: string[] = []): Promise<DevWorkspace> => {
  const root = await temporaryDirectory()
  const directory = join(root, 'strands-dev')
  await writeFileAt(temporaryVenvPython(join(root, '.venv')), 'fixture interpreter')
  await Promise.all(experiments.map((name) => writeFileAt(join(directory, 'tmp/experiments', name))))
  return {
    directory,
    root,
    entrypoint: join(root, 'agent.py'),
    config: { version: 1, name: 'desk', language: 'python', entrypoint: 'agent.py', origin: { kind: 'discovered' } },
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

const generating = (cases = 3) =>
  vi.fn(async ({ args }: TemporaryEvalsProcess) => {
    const output = args[args.indexOf('--output') + 1]!
    await writeFileAt(
      output,
      JSON.stringify({ cases: Array.from({ length: cases }, (_, index) => ({ name: `c${index}` })) })
    )
    return { code: 0, stdout: '', stderrTail: [] }
  })

describe('TEMPORARY starter set drafting', () => {
  const now = (): Date => new Date('2026-11-12T15:30:12Z')

  it('shouldDraftTheRequestedCasesIntoTheDraftsFolderFromTheAgentContext', async () => {
    const workspace = await workspaceFixture()
    const spawnGenerator = generating(3)

    const outcome = await draftTemporaryExperiment(
      { workspace, context: 'An agent that answers refund questions', count: 20, now },
      { run: environmentRunner(workspace), spawnGenerator }
    )

    const path = join(workspace.directory!, 'tmp/experiments/drafts/20261112-153012-draft.json')
    expect(outcome).toEqual({ path, cases: 3 })
    expect(spawnGenerator.mock.calls[0]![0].args).toEqual([
      '-m',
      'strands_evals.cli',
      'generate',
      '--context',
      'An agent that answers refund questions',
      '--num-cases',
      '20',
      '--evaluator',
      'OutputEvaluator',
      '--output',
      path,
    ])
  })

  it('shouldReportTheGeneratorErrorAndTheNextStepWhenDraftingFails', async () => {
    const workspace = await workspaceFixture()
    const spawnGenerator = vi.fn(async () => ({
      code: 3,
      stdout: '',
      stderrTail: ['strands-evals: error: Unable to locate credentials'],
    }))

    await expect(
      draftTemporaryExperiment(
        { workspace, context: 'refunds', count: 20 },
        { run: environmentRunner(workspace), spawnGenerator }
      )
    ).rejects.toThrow(
      /strands-evals generate stopped with exit code 3: Unable to locate credentials\nCheck that your AWS credentials/u
    )
  })

  it('shouldRemoveTheDraftAndSayWhatToTryWhenTheGeneratorWritesNoCases', async () => {
    const workspace = await workspaceFixture()
    const spawnGenerator = vi.fn(async (process: TemporaryEvalsProcess) => {
      await generating(0)(process)
      return { code: 0, stdout: '', stderrTail: ['case 1 failed: the model refused'] }
    })

    await expect(
      draftTemporaryExperiment(
        { workspace, context: 'refunds', count: 20, now },
        { run: environmentRunner(workspace), spawnGenerator }
      )
    ).rejects.toThrow(/wrote no cases[\s\S]+the model refused\nGive your agent clearer instructions/u)
    expect(existsSync(join(workspace.directory!, 'tmp/experiments/drafts/20261112-153012-draft.json'))).toBe(false)
  })
})
