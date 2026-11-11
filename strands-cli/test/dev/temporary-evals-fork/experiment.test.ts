import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { temporaryVenvPython, type TemporaryCommandRequest } from '../../../src/dev/temporary-evals-fork/environment.js'
import type { TemporaryEvalsProcess } from '../../../src/dev/temporary-evals-fork/evals-process.js'
import { createTemporaryExperiment } from '../../../src/dev/temporary-evals-fork/experiment.js'
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

describe('TEMPORARY /experiment generation', () => {
  it('shouldGenerateCasesIntoTheExperimentsFolderWhenANameAndDescriptionAreGiven', async () => {
    const workspace = await workspaceFixture()
    const spawnGenerator = generating(3)

    const outcome = await createTemporaryExperiment(
      { workspace, name: 'refunds', description: 'Answers refund questions', forkArguments: ['--num-cases', '3'] },
      { run: environmentRunner(workspace), spawnGenerator }
    )

    const path = join(workspace.directory!, 'tmp/experiments/refunds.json')
    expect(outcome).toEqual({ path, cases: 3 })
    expect(spawnGenerator.mock.calls[0]![0].args).toEqual([
      '-m',
      'strands_evals.cli',
      'generate',
      '--context',
      'Answers refund questions',
      '--evaluator',
      'OutputEvaluator',
      '--num-cases',
      '3',
      '--output',
      path,
    ])
  })

  it.each([
    { name: 'refunds', description: '', experiments: [], message: 'say what the agent does. Usage: /experiment' },
    { name: '../refunds', description: 'Answers refunds', experiments: [], message: 'is not a usable experiment name' },
    {
      name: 'refunds',
      description: 'Answers refunds',
      experiments: ['refunds.json'],
      message: 'Pick another name, or delete that file to replace it',
    },
  ])('shouldExplainWhatToChangeWhen$message', async ({ name, description, experiments, message }) => {
    const workspace = await workspaceFixture(experiments)
    const spawnGenerator = generating()

    await expect(
      createTemporaryExperiment({ workspace, name, description }, { run: environmentRunner(workspace), spawnGenerator })
    ).rejects.toThrow(message)
    expect(spawnGenerator).not.toHaveBeenCalled()
  })

  it('shouldRejectFlagsThatExperimentSetsItselfWhenTheyArePassed', async () => {
    const workspace = await workspaceFixture()

    await expect(
      createTemporaryExperiment({
        workspace,
        name: 'refunds',
        description: 'Answers refunds',
        forkArguments: ['--output', 'x'],
      })
    ).rejects.toThrow('/experiment sets --output itself')
  })

  it('shouldReportTheGeneratorErrorAndTheNextStepWhenGenerationFails', async () => {
    const workspace = await workspaceFixture()
    const spawnGenerator = vi.fn(async () => ({
      code: 3,
      stdout: '',
      stderrTail: ['strands-evals: error: Unable to locate credentials'],
    }))

    await expect(
      createTemporaryExperiment(
        { workspace, name: 'refunds', description: 'Answers refunds' },
        { run: environmentRunner(workspace), spawnGenerator }
      )
    ).rejects.toThrow(
      /strands-evals generate stopped with exit code 3: Unable to locate credentials\nCheck that your AWS credentials/u
    )
  })

  it('shouldPointToTheFlagsWhenTheGeneratorRejectsThem', async () => {
    const workspace = await workspaceFixture()
    const spawnGenerator = vi.fn(async () => ({
      code: 2,
      stdout: '',
      stderrTail: ["strands-evals generate: error: argument --num-cases: invalid int value: 'abc'"],
    }))

    await expect(
      createTemporaryExperiment(
        { workspace, name: 'refunds', description: 'Answers refunds', forkArguments: ['--num-cases', 'abc'] },
        { run: environmentRunner(workspace), spawnGenerator }
      )
    ).rejects.toThrow(/exit code 2: argument --num-cases: invalid int value: 'abc'\nFix the flags after --/u)
  })

  it('shouldRemoveTheFileAndSayWhatToTryWhenTheGeneratorWritesNoCases', async () => {
    const workspace = await workspaceFixture()
    const spawnGenerator = vi.fn(async (process: TemporaryEvalsProcess) => {
      await generating(0)(process)
      return { code: 0, stdout: '', stderrTail: ['case 1 failed: the model refused'] }
    })

    await expect(
      createTemporaryExperiment(
        { workspace, name: 'refunds', description: 'Answers refunds' },
        { run: environmentRunner(workspace), spawnGenerator }
      )
    ).rejects.toThrow(/wrote no cases for refunds[\s\S]+the model refused\nDescribe the agent in more detail/u)
    expect(existsSync(join(workspace.directory!, 'tmp/experiments/refunds.json'))).toBe(false)
  })

  it('shouldRefuseTheSameNameWhileItIsBeingGenerated', async () => {
    const workspace = await workspaceFixture()
    let release: () => void = () => {}
    const spawnGenerator = vi.fn(async (process: TemporaryEvalsProcess) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return generating(1)(process)
    })
    const dependencies = { run: environmentRunner(workspace), spawnGenerator }
    const request = { workspace, name: 'refunds', description: 'Answers refunds' }

    const first = createTemporaryExperiment(request, dependencies)
    await vi.waitFor(() => expect(spawnGenerator).toHaveBeenCalled())

    await expect(createTemporaryExperiment(request, dependencies)).rejects.toThrow('or is being generated')
    release()
    await expect(first).resolves.toMatchObject({ cases: 1 })
  })
})
