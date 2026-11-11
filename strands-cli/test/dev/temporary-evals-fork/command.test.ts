import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { temporaryOptimizeCommand } from '../../../src/dev/temporary-evals-fork/command.js'
import { temporaryVenvPython, type TemporaryCommandRequest } from '../../../src/dev/temporary-evals-fork/environment.js'
import type { TemporaryOptimizerProcess } from '../../../src/dev/temporary-evals-fork/optimize.js'
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
  await writeFileAt(join(directory, 'tmp/experiments/support.json'))
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
  return vi.fn(async ({ onLine }: TemporaryOptimizerProcess) => {
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

  it('shouldRefuseASecondOptimizationWhileOneRuns', async () => {
    const workspace = await workspaceFixture()
    const first = contextFixture()
    const second = contextFixture()
    const command = temporaryOptimizeCommand(workspace, projectOf(workspace), dependenciesFor(workspace))

    command.run('', first.context)
    command.run('', second.context)
    await finished(first.updates)

    expect(second.failures).toEqual(['Optimization running: Wait for the current optimization to finish.'])
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

  it('shouldReportTheFailureWhenTheWorkspaceAgentIsTypeScript', async () => {
    const workspace = await workspaceFixture('typescript')
    const { context, updates } = contextFixture()

    temporaryOptimizeCommand(workspace, projectOf(workspace), dependenciesFor(workspace)).run('', context)

    expect(await finished(updates)).toEqual({
      status: 'error',
      text: expect.stringContaining('Optimization supports Python agents only'),
    })
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

  it('shouldKeepRunningAndShowItInTheNewChatWhenTheFirstChatCloses', async () => {
    const workspace = await workspaceFixture()
    const firstChat = new AbortController()
    const first = contextFixture(firstChat.signal)
    const second = contextFixture()
    let release: () => void = () => {}
    const spawnOptimizer = vi.fn(async ({ onLine }: TemporaryOptimizerProcess) => {
      onLine('candidate  0 baseline complete n=4 Contains 0.5')
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { code: 0, stdout: 'ships candidate 0: {}\n', stderrTail: [] }
    })
    const command = temporaryOptimizeCommand(
      workspace,
      projectOf(workspace),
      dependenciesFor(workspace, spawnOptimizer)
    )
    command.run('', first.context)
    await vi.waitFor(() => expect(spawnOptimizer).toHaveBeenCalled())

    firstChat.abort()
    const seenByFirst = first.updates.length
    command.attach!(second.context)
    release()

    expect(second.updates[0]?.text).toContain('candidate  0 baseline complete')
    expect(await finished(second.updates)).toEqual({
      status: 'success',
      text: expect.stringContaining('ships candidate 0'),
    })
    expect(first.updates).toHaveLength(seenByFirst)
  })
})
