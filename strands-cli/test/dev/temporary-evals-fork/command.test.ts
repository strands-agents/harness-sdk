import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { saveTemporaryRunRecord } from '../../../src/dev/temporary-evals-fork/background-runs.js'

import { temporaryDevCommands } from '../../../src/dev/temporary-evals-fork/command.js'
import { temporaryDevSessions } from '../../../src/dev/temporary-evals-fork/sessions.js'
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

    expect(commands.map(({ spec }) => spec.usage)).toEqual(['/experiment', '/evaluate', '/optimize'])
    expect(commands.every(({ spec }) => spec.replacement === undefined)).toBe(true)
    expect(commands.map(({ spec }) => spec.description)).toEqual([
      'Generate test cases for this agent with strands-evals, and review them',
      'Run this agent on an experiment and show what failed',
      'Tune this agent against an experiment and review the changes',
    ])
  })

  it('shouldExplainWhereEachCommandSavesItsFilesWhenHelpShowsTheDetails', async () => {
    const { workspace, project } = await fixture()

    const details = temporaryDevCommands(workspace, project).map(({ spec }) => spec.details ?? '')

    expect(details.map((text) => text.match(/strands-dev\/experiments\/[\w<>/.]*[\w>/]/u)?.[0])).toEqual([
      'strands-dev/experiments/<name>/<name>.json',
      'strands-dev/experiments/<name>/runs/',
      'strands-dev/experiments/<name>/optimizations/',
    ])
    expect(details[1]).toContain('the latest one as <name>.report.json')
    expect(details.every((text) => text.includes('Experimental: a fork of strands-evals'))).toBe(true)
    expect(details.some((text) => text.includes('TEMPORARY'))).toBe(false)
  })

  it('shouldExplainTheObjectiveAndItsConstraintsWhenOptimizeHelpShowsTheDetails', async () => {
    const { workspace, project } = await fixture()

    const [, , optimize] = temporaryDevCommands(workspace, project).map(({ spec }) => spec.details ?? '')

    expect(optimize).toContain('The constraints row under it sets what the chosen candidate must meet')
    expect(optimize).not.toContain('limit')
  })

  it('shouldNameTheUpstreamCommandsWhenOptimizeHelpShowsTheDetails', async () => {
    const { workspace, project } = await fixture()

    const [, , optimize] = temporaryDevCommands(workspace, project).map(({ spec }) => spec.details ?? '')

    expect(optimize).toContain('with strands-evals optimize run and strands-evals optimize resume')
  })

  it('shouldReportNoRunningJobsWhenNothingRuns', async () => {
    const { workspace, project } = await fixture()

    const commands = temporaryDevCommands(workspace, project)

    expect(commands.map(({ jobs }) => jobs?.snapshot())).toEqual([[], [], []])
  })

  it('shouldShowATestThatFinishedWhileStrandsDevWasClosedWhenTheChatAttaches', async () => {
    const { workspace, project } = await fixture()
    const experiment = join(workspace.directory!, 'experiments/capital/capital.json')
    const run = join(workspace.directory!, 'experiments/capital/runs/20261116-090000')
    const report = join(run, 'report.json')
    await mkdir(dirname(experiment), { recursive: true })
    await mkdir(run, { recursive: true })
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
      log: join(run, 'run.log'),
      store: join(run, '.state/cases'),
      startedAt: Date.now(),
    })
    const announced = vi.fn(() => ({ update: vi.fn() }))

    temporaryDevCommands(workspace, project)[1]!.attach?.({ ...context, report: announced })

    await vi.waitFor(() =>
      expect(announced).toHaveBeenCalledWith(
        'success',
        'evaluate · capital · 1 of 1 case passed · /evaluate shows the results'
      )
    )
  })

  it('shouldStartTheEvalsUiWhenTheChatAttachesAndKeepTheChatWorkingWhenItCannotStart', async () => {
    const { workspace, project } = await fixture()
    const announced = vi.fn(() => ({ update: vi.fn() }))

    temporaryDevCommands(workspace, project)[0]!.attach?.({ ...context, report: announced })

    await vi.waitFor(() =>
      expect(announced).toHaveBeenCalledWith('error', expect.stringContaining('evals UI unavailable · '))
    )
    expect(temporaryDevSessions({ workspace, agent: () => ({}) }).ui.snapshot().status).toBe('unavailable')
  })

  it('shouldKeepTheOptimizePageWhenAReloadOpensThePanelAgainButNotWhenTheDeveloperOpensIt', async () => {
    const { workspace, project } = await fixture()
    const { optimize } = temporaryDevSessions({ workspace, agent: () => ({}) })
    const command = temporaryDevCommands(workspace, project)[2]!
    optimize.plan({ name: 'missing', path: join(workspace.root, 'missing.json'), caseCount: 0 })
    await vi.waitFor(() => expect(optimize.snapshot().step).toBe('failed'))

    command.open(context, { restore: true })
    const restored = optimize.snapshot().step
    command.open(context)

    expect(restored).toBe('failed')
    expect(optimize.snapshot().step).toBe('pick')
  })

  it('shouldOpenTheRunOfAJobWhenTheJobRowOpensTheOptimizePanel', async () => {
    const { workspace, project } = await fixture()
    const { optimize } = temporaryDevSessions({ workspace, agent: () => ({}) })
    const openRun = vi.spyOn(optimize, 'openRun')
    const command = temporaryDevCommands(workspace, project)[2]!

    command.open(context, { job: 'run-1' })

    expect(openRun).toHaveBeenCalledWith('run-1')
    expect(optimize.snapshot().step).toBe('pick')
  })

  it.each([0, 1, 2])('shouldOpenAPanelViewWhenCommand%iRuns', async (index) => {
    const { workspace, project } = await fixture()

    const view = temporaryDevCommands(workspace, project)[index]!.open(context)

    expect(view).toBeTypeOf('function')
  })
})
