import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { saveTemporaryRunRecord } from '../../../src/dev/temporary-evals-fork/background-runs.js'

import { temporaryDevCommands } from '../../../src/dev/temporary-evals-fork/command.js'
import type { DevWorkspace } from '../../../src/dev/workspace.js'
import type { ImportedAgentProject } from '../../../src/project/import.js'
import type { DevChatCommandContext } from '../../../src/ui/chat/types.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const fixture = async (): Promise<{ workspace: DevWorkspace; project: ImportedAgentProject }> => {
  const root = await temporaryDirectory()
  return {
    workspace: {
      directory: join(root, 'strands-dev'),
      root,
      entrypoint: join(root, 'agent.py'),
      config: { version: 1, name: 'desk', language: 'python', entrypoint: 'agent.py', origin: { kind: 'discovered' } },
    },
    project: { root, entrypoint: join(root, 'agent.py'), language: 'python' } as ImportedAgentProject,
  }
}

const context: DevChatCommandContext = {
  signal: new AbortController().signal,
  report: () => ({ update: vi.fn() }),
  fail: vi.fn(),
  submit: vi.fn(),
}

describe('TEMPORARY dev commands', () => {
  it('shouldOfferExperimentTestAndOptimizeWithoutArgumentsWhenTheChatStarts', async () => {
    const { workspace, project } = await fixture()

    const commands = temporaryDevCommands(workspace, project)

    expect(commands.map(({ spec }) => spec.usage)).toEqual(['/experiment', '/test', '/optimize'])
    expect(commands.every(({ spec }) => spec.replacement === undefined)).toBe(true)
    expect(commands.every(({ spec }) => spec.description.startsWith('TEMPORARY: '))).toBe(true)
  })

  it('shouldReportNoRunningJobsWhenNothingRuns', async () => {
    const { workspace, project } = await fixture()

    const commands = temporaryDevCommands(workspace, project)

    expect(commands.map(({ jobs }) => jobs?.snapshot())).toEqual([[], [], []])
  })

  it('shouldShowATestThatFinishedWhileStrandsDevWasClosedWhenTheChatAttaches', async () => {
    const { workspace, project } = await fixture()
    const experiment = join(workspace.directory!, 'tmp/experiments/capital.json')
    const reports = join(workspace.directory!, 'tmp/reports')
    const report = join(reports, '20261116-090000-capital.json')
    await mkdir(dirname(experiment), { recursive: true })
    await mkdir(reports, { recursive: true })
    await writeFile(
      experiment,
      JSON.stringify({
        cases: [{ name: 'c0', input: 'question' }],
        evaluators: [{ evaluator_type: 'OutputEvaluator' }],
      })
    )
    await writeFile(
      report,
      JSON.stringify({
        overall_score: 1,
        scores: [1],
        test_passes: [true],
        reasons: ['matches'],
        cases: [{ name: 'c0', input: 'question', actual_output: 'Paris', evaluator: 'OutputEvaluator' }],
        detailed_results: [[{ score: 1, test_pass: true, reason: 'matches', label: null }]],
      })
    )
    await saveTemporaryRunRecord({
      version: 1,
      experiment,
      cases: experiment,
      rerun: false,
      report,
      log: join(reports, '20261116-090000-capital.log'),
      store: join(reports, '20261116-090000-capital.cases'),
      startedAt: Date.now(),
    })
    const announced = vi.fn(() => ({ update: vi.fn() }))

    temporaryDevCommands(workspace, project)[1]!.attach?.({ ...context, report: announced })

    await vi.waitFor(() =>
      expect(announced).toHaveBeenCalledWith('success', 'test · capital · 1 of 1 case passed · /test shows the results')
    )
  })

  it.each([0, 1, 2])('shouldOpenAPanelViewWhenCommand%iRuns', async (index) => {
    const { workspace, project } = await fixture()

    const view = temporaryDevCommands(workspace, project)[index]!.open(context)

    expect(view).toBeTypeOf('function')
  })
})
