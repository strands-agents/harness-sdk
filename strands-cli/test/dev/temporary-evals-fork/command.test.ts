import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  temporaryExperimentCommand,
  temporaryOptimizeCommand,
  temporaryTestCommand,
} from '../../../src/dev/temporary-evals-fork/command.js'
import { temporaryVenvPython, type TemporaryCommandRequest } from '../../../src/dev/temporary-evals-fork/environment.js'
import type {
  TemporaryEvalsProcess,
  TemporaryEvalsSpawner,
} from '../../../src/dev/temporary-evals-fork/evals-process.js'
import type { DevWorkspace } from '../../../src/dev/workspace.js'
import type { ImportedAgentProject } from '../../../src/project/import.js'
import type { ChatNotice, DevChatCommandContext } from '../../../src/ui/chat/types.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

interface Recorded {
  status: ChatNotice['status']
  text: string
}

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

const dependenciesFor = (workspace: DevWorkspace, spawnOptimizer = succeeding()) => ({
  run: vi.fn(async ({ args }: TemporaryCommandRequest): Promise<string> => {
    if (args[1]?.includes('platform.python_version')) return JSON.stringify({ version: '3.12.4', paths: [] })
    if (args[0] === '-m' && args[1] === 'venv') await writeFileAt(temporaryVenvPython(args[3]!), 'fixture interpreter')
    if (args[1]?.includes('site.getsitepackages()[0]')) {
      const sitePackages = join(workspace.directory!, 'tmp/optimization/.venv/lib/site-packages')
      await mkdir(sitePackages, { recursive: true })
      return sitePackages
    }
    return ''
  }),
  spawnOptimizer,
})

function succeeding() {
  return vi.fn(async ({ onLine }: TemporaryEvalsProcess) => {
    onLine('candidate  1 text complete n=4 Contains 0.75')
    return { code: 0, stdout: 'ships candidate 1: {}\nrecord: here\n', stderrTail: [] }
  })
}

const projectOf = ({ root, entrypoint, config }: DevWorkspace): ImportedAgentProject => ({
  root,
  entrypoint,
  language: config.language,
})

const contextFixture = (
  signal = new AbortController().signal
): { context: DevChatCommandContext; updates: Recorded[]; failures: string[] } => {
  const updates: Recorded[] = []
  const failures: string[] = []
  const context: DevChatCommandContext = {
    signal,
    report: (status, text) => {
      updates.push({ status, text })
      return { update: (nextStatus, nextText) => void updates.push({ status: nextStatus, text: nextText }) }
    },
    fail: (title, detail) => void failures.push(`${title}: ${detail}`),
  }
  return { context, updates, failures }
}

const finished = async (updates: Recorded[]): Promise<Recorded> => {
  await vi.waitFor(() => expect(updates.at(-1)?.status).not.toBe('running'))
  return updates.at(-1)!
}

const blockingProcess = (write: (args: string[]) => Promise<void>) => {
  let release: () => void = () => {}
  const spawn = vi.fn(async ({ args, onLine }: TemporaryEvalsProcess) => {
    onLine('candidate  0 baseline complete n=4 Contains 0.5')
    await new Promise<void>((resolve) => {
      release = resolve
    })
    await write(args)
    return { code: 0, stdout: 'ships candidate 0: {}\n', stderrTail: [] }
  })
  return { spawn, release: (): void => release() }
}

const outputOf = (args: string[]): string => args[args.indexOf('--output') + 1]!

const COMMANDS = [
  {
    name: 'optimize',
    argument: '',
    write: async (): Promise<void> => {},
    make: (workspace: DevWorkspace, spawn: TemporaryEvalsSpawner) =>
      temporaryOptimizeCommand(workspace, projectOf(workspace), {
        run: dependenciesFor(workspace).run,
        spawnOptimizer: spawn,
      }),
  },
  {
    name: 'test',
    argument: 'support',
    write: (args: string[]) => writeFileAt(outputOf(args), JSON.stringify({ overall_score: 1, test_passes: [true] })),
    make: (workspace: DevWorkspace, spawn: TemporaryEvalsSpawner) =>
      temporaryTestCommand(workspace, projectOf(workspace), { run: dependenciesFor(workspace).run, spawnTests: spawn }),
  },
  {
    name: 'experiment',
    argument: 'refunds Answers refund questions',
    write: (args: string[]) => writeFileAt(outputOf(args), JSON.stringify({ cases: [{ name: 'a' }] })),
    make: (workspace: DevWorkspace, spawn: TemporaryEvalsSpawner) =>
      temporaryExperimentCommand(workspace, projectOf(workspace), {
        run: dependenciesFor(workspace).run,
        spawnGenerator: spawn,
      }),
  },
]

describe('TEMPORARY dev commands', () => {
  it.each(COMMANDS)('shouldCompleteTheTextInsteadOfRunningWhen$nameIsPickedInTheSlashList', async ({ name, make }) => {
    const workspace = await workspaceFixture()

    expect(make(workspace, vi.fn()).spec.replacement).toBe(`/${name} `)
  })

  it.each(COMMANDS)('shouldRefuseASecondRunWhile/$nameRuns', async ({ argument, write, make }) => {
    const workspace = await workspaceFixture()
    const { spawn, release } = blockingProcess(write)
    const command = make(workspace, spawn)
    const first = contextFixture()
    const second = contextFixture()

    command.run(argument, first.context)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    command.run(argument, second.context)
    release()
    await finished(first.updates)

    expect(second.failures).toEqual([expect.stringContaining('Wait for it to finish, then try again.')])
  })

  it.each(COMMANDS)('shouldShowTheRunInTheNewChatWhen/$nameOutlivesTheFirstChat', async ({ argument, write, make }) => {
    const workspace = await workspaceFixture()
    const { spawn, release } = blockingProcess(write)
    const firstChat = new AbortController()
    const first = contextFixture(firstChat.signal)
    const second = contextFixture()
    make(workspace, spawn).run(argument, first.context)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())

    firstChat.abort()
    const seenByFirst = first.updates.length
    make(workspace, spawn).attach!(second.context)
    release()

    expect(second.updates[0]?.text).toContain('candidate  0 baseline complete')
    expect(await finished(second.updates)).toMatchObject({ status: 'success' })
    expect(first.updates).toHaveLength(seenByFirst)
  })
})

describe('TEMPORARY /optimize command', () => {
  it('shouldShowTheLatestProgressAndThenTheSummaryWhenTheOptimizationSucceeds', async () => {
    const workspace = await workspaceFixture()
    const { context, updates } = contextFixture()

    temporaryOptimizeCommand(workspace, projectOf(workspace), dependenciesFor(workspace)).run(
      'support -- --tune effort',
      context
    )

    expect(await finished(updates)).toEqual({
      status: 'success',
      text: 'TEMPORARY optimization finished\nships candidate 1: {}\nrecord: here',
    })
    expect(updates.some(({ text }) => text.endsWith('candidate  1 text complete n=4 Contains 0.75'))).toBe(true)
    expect(updates.some(({ text }) => text.includes('Record: '))).toBe(true)
  })

  it('shouldPassTheExperimentAndForkFlagsToTheOptimizer', async () => {
    const workspace = await workspaceFixture()
    const { context, updates } = contextFixture()
    const spawnOptimizer = succeeding()

    temporaryOptimizeCommand(workspace, projectOf(workspace), dependenciesFor(workspace, spawnOptimizer)).run(
      'support -- --tune effort',
      context
    )
    await finished(updates)

    const { args } = spawnOptimizer.mock.calls[0]![0]
    expect(args[3]).toBe(join(workspace.directory!, 'tmp/experiments/support.json'))
    expect(args.slice(-2)).toEqual(['--tune', 'effort'])
  })

  it('shouldShowTheUsageWhenMoreThanOneExperimentIsGiven', async () => {
    const workspace = await workspaceFixture()
    const { context, updates, failures } = contextFixture()

    temporaryOptimizeCommand(workspace, projectOf(workspace), dependenciesFor(workspace)).run(
      'support billing',
      context
    )

    expect(failures).toEqual([expect.stringContaining('Usage: /optimize [experiment]')])
    expect(updates).toEqual([])
  })

  it('shouldRunTheTypescriptAgentThroughTheRunnerWhenTheChatRunsTypeScript', async () => {
    const workspace = await workspaceFixture('typescript')
    const { context, updates } = contextFixture()
    const spawnOptimizer = succeeding()

    temporaryOptimizeCommand(workspace, projectOf(workspace), dependenciesFor(workspace, spawnOptimizer)).run(
      '',
      context
    )

    expect(await finished(updates)).toEqual(expect.objectContaining({ status: 'success' }))
    expect(spawnOptimizer.mock.calls[0]![0].args).toContain('--typescript-runner')
  })

  it('shouldTuneTheAgentThatTheChatRunsWhenItDiffersFromTheSavedBinding', async () => {
    const workspace = await workspaceFixture()
    const { context, updates } = contextFixture()
    const spawnOptimizer = succeeding()
    const project = { ...projectOf(workspace), entrypoint: join(workspace.root, 'other.py') }

    temporaryOptimizeCommand(workspace, project, dependenciesFor(workspace, spawnOptimizer)).run('', context)
    await finished(updates)

    expect(spawnOptimizer.mock.calls[0]![0].args).toContain(join(workspace.root, 'other.py'))
  })

  it('shouldShowTheCaseCountAndTheNextStepWhenAnExperimentIsSaved', async () => {
    const workspace = await workspaceFixture()
    const { context, updates } = contextFixture()
    const spawnGenerator = vi.fn(async ({ args }: TemporaryEvalsProcess) => {
      const output = args[args.indexOf('--output') + 1]!
      await writeFileAt(output, JSON.stringify({ cases: [{ name: 'a' }, { name: 'b' }] }))
      return { code: 0, stdout: '', stderrTail: [] }
    })

    temporaryExperimentCommand(workspace, projectOf(workspace), {
      run: dependenciesFor(workspace).run,
      spawnGenerator,
    }).run('refunds Answers refund questions', context)

    expect(await finished(updates)).toEqual({
      status: 'success',
      text: expect.stringMatching(
        /saved\n2 cases in .+refunds\.json\nReview or edit the cases there, then run \/test refunds or \/optimize refunds\./u
      ),
    })
  })

  it('shouldShowTheUsageWhenTheExperimentHasNoName', async () => {
    const workspace = await workspaceFixture()
    const { context, updates, failures } = contextFixture()

    temporaryExperimentCommand(workspace, projectOf(workspace)).run('', context)

    expect(failures).toEqual([expect.stringContaining('Example: /experiment refunds Answers refund questions')])
    expect(updates).toEqual([])
  })

  it('shouldShowTheChecksAndTheReportWhenATestFinishes', async () => {
    const workspace = await workspaceFixture()
    const { context, updates } = contextFixture()
    const spawnTests = vi.fn(async ({ args }: TemporaryEvalsProcess) => {
      const report = args[args.indexOf('--output') + 1]!
      await writeFileAt(report, JSON.stringify({ overall_score: 0.75, test_passes: [true, true, true, false] }))
      return { code: 0, stdout: '', stderrTail: [] }
    })

    temporaryTestCommand(workspace, projectOf(workspace), { run: dependenciesFor(workspace).run, spawnTests }).run(
      'support',
      context
    )

    expect(await finished(updates)).toEqual({
      status: 'success',
      text: expect.stringMatching(
        /^TEMPORARY test finished\n3 of 4 checks passed \(overall score 0\.75\)\nReport: .+\.json\n.+Run \/optimize support to improve/u
      ),
    })
  })

  it('shouldNameThePathInTheNextStepWhenTheExperimentIsOutsideTheExperimentsFolder', async () => {
    const workspace = await workspaceFixture()
    const outside = join(workspace.root, 'cases', 'refunds.json')
    await writeFileAt(outside, JSON.stringify({ cases: [{ name: 'a' }] }))
    const { context, updates } = contextFixture()
    const spawnTests = vi.fn(async ({ args }: TemporaryEvalsProcess) => {
      await writeFileAt(outputOf(args), JSON.stringify({ overall_score: 0, test_passes: [false] }))
      return { code: 0, stdout: '', stderrTail: [] }
    })

    temporaryTestCommand(workspace, projectOf(workspace), { run: dependenciesFor(workspace).run, spawnTests }).run(
      outside,
      context
    )

    expect((await finished(updates)).text).toContain(`Run /optimize ${outside} to improve`)
  })
})
