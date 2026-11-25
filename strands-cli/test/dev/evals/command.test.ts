import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { STRANDS_EVALS_LABEL } from '../../../src/dev/evals/package.js'
import { evalsDevCommands } from '../../../src/dev/evals/command.js'
import { evalsDevSessions } from '../../../src/dev/evals/sessions.js'
import { uiTools } from '../../../src/dev/evals/ui-tools.js'
import type { DevChatTool } from '../../../src/dev/chat-extension.js'
import { evalsCommandWorkflows } from '../../../src/dev/evals/workflow-skills.js'
import type { DevWorkspace } from '../../../src/dev/workspace.js'
import type { ImportedAgentProject } from '../../../src/project/import.js'
import { ChatController } from '../../../src/ui/chat/controller.js'
import type { DevChatCommandContext } from '../../../src/ui/chat/types.js'
import { idleBackend } from '../../fixtures/chat-backend.js'
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
  report: () => ({ update: vi.fn() }),
  openPanel: vi.fn(() => true),
}

const experimentChat = async (
  stream: (tool: (name: string) => DevChatTool) => Parameters<typeof idleBackend>[0]
): Promise<{ controller: ChatController; broker: ReturnType<typeof evalsDevSessions>['ask'] }> => {
  const { workspace, project } = await fixture()
  const [experiment, , ask] = evalsDevCommands(workspace, project)
  const broker = evalsDevSessions({ workspace, agent: () => ({}) }).ask
  const tools = uiTools(() => broker)
  const tool = (name: string): DevChatTool => tools.find((candidate) => candidate.name === name)!
  const controller = new ChatController(idleBackend(stream(tool)), {
    devCommands: [experiment!, ask!],
    skills: {
      list: async () => [],
      activate: async (name) => ({ skill: { name, description: '', instructions: '', active: true }, content: '' }),
    },
  })
  return { controller, broker }
}

describe('dev commands', () => {
  it('shouldOfferExperimentOptimizeAndAskButNoEvaluateWhenTheChatStarts', async () => {
    const { workspace, project } = await fixture()

    const commands = evalsDevCommands(workspace, project)

    expect(commands.map(({ spec }) => spec.usage)).toEqual(['/experiment', '/optimize', '/ask'])
    expect(commands.every(({ spec }) => spec.replacement === undefined)).toBe(true)
    expect(commands.map(({ spec }) => spec.description)).toEqual([
      'Make, run, and review the test cases of this agent with the strands-evals skill',
      'Tune this agent against an experiment with the optimize skill and review the changes',
      'Answer the setup question that the agent is asking',
    ])
  })

  it('shouldExplainWhereEachCommandSavesItsFilesWhenHelpShowsTheDetails', async () => {
    const { workspace, project } = await fixture()

    const details = evalsDevCommands(workspace, project).map(({ spec }) => spec.details ?? '')

    expect(details.map((text) => text.match(/strands-dev\/experiments\/[\w<>/.]*[\w>/]/u)?.[0])).toEqual([
      'strands-dev/experiments/<name>/<name>.json',
      'strands-dev/experiments/<name>/optimizations/',
      undefined,
    ])
    expect(details[0]).toContain('strands-dev/experiments/<name>/runs/')
    expect(details[0]).toContain('the latest as <name>.report.json')
    expect(details.slice(0, 2).every((text) => text.includes(`Experimental: strands dev`))).toBe(true)
    expect(details.slice(0, 2).every((text) => text.includes(STRANDS_EVALS_LABEL))).toBe(true)
    expect(details.some((text) => text.includes('fork'))).toBe(false)
    expect(details.some((text) => text.includes('TEMPORARY'))).toBe(false)
  })

  it('shouldDescribeTheOnScreenSetupWhenOptimizeHelpShowsTheDetails', async () => {
    const { workspace, project } = await fixture()

    const [, optimize] = evalsDevCommands(workspace, project).map(({ spec }) => spec.details ?? '')

    expect(optimize).toContain('what must stay true')
    expect(optimize).toContain('approve the review to start the run')
    expect(optimize).toContain('The run goes on in the background')
    expect(optimize).toContain('its proposed edits appear on screen as a diff')
    expect(optimize).toContain('Auto-accept optimization results')
    expect(optimize).toContain('with strands-evals optimize run and strands-evals optimize resume')
    expect(optimize).not.toMatch(/five tabs|press o|Esc goes back/u)
  })

  it('shouldNameTheBackgroundToolThatEachJobsLineStandsFor', async () => {
    const { workspace, project } = await fixture()

    const commands = evalsDevCommands(workspace, project)

    expect(commands.map(({ backgroundTools }) => backgroundTools)).toEqual([
      ['strands_dev_run_background'],
      ['strands_dev_run_background'],
      undefined,
    ])
  })

  it('shouldReportNoRunningJobsWhenNothingRuns', async () => {
    const { workspace, project } = await fixture()

    const commands = evalsDevCommands(workspace, project)

    expect(commands.map(({ jobs }) => jobs?.snapshot())).toEqual([[], [], undefined])
  })

  it('shouldResumeTheEvaluationsAndStartTheEvalsUiWhenTheChatAttachesAndKeepTheChatWorkingWhenItCannotStart', async () => {
    const { workspace, project } = await fixture()
    const announced = vi.fn(() => ({ update: vi.fn() }))
    const sessions = evalsDevSessions({ workspace, agent: () => ({}) })
    const resume = vi.spyOn(sessions.test, 'resume')

    evalsDevCommands(workspace, project)[0]!.attach?.({ ...context, report: announced })

    // What a resumed evaluation shows is checked on the session itself, in sessions.test.ts.
    expect(resume).toHaveBeenCalledOnce()
    await vi.waitFor(() =>
      expect(announced).toHaveBeenCalledWith('error', expect.stringContaining('evals UI unavailable · '))
    )
    expect(sessions.ui.snapshot().status).toBe('unavailable')
  })

  it('shouldRunEachEvalsCommandAsItsSkillWithoutAPanel', async () => {
    const { workspace, project } = await fixture()

    const commands = evalsDevCommands(workspace, project).slice(0, 2)

    expect(commands.map(({ open }) => open)).toEqual([undefined, undefined])
    expect(commands.map(({ skill }) => skill?.skill)).toEqual(['strands-evals', 'optimize'])
    expect(commands.map(({ skill }) => skill?.workflow)).toEqual(Object.values(evalsCommandWorkflows))
    expect(commands[1]!.skill?.unavailable).toContain('could not load the optimize skill from https://')
    expect(commands.map(({ skill }) => skill?.job?.('missing'))).toEqual([
      'how is the evaluation of the experiment going?',
      'how is the optimization of the experiment going?',
    ])
  })

  it('shouldPutEachQuestionOnScreenWhenAnExperimentTurnAsksAfterAndWithoutAPermissionPrompt', async () => {
    let allow!: () => void
    const allowed = new Promise<void>((resolve) => {
      allow = resolve
    })
    const answers: string[] = []
    const prompts: unknown[] = []
    const { controller, broker } = await experimentChat((tool) => ({
      async *stream(prompt) {
        prompts.push(prompt)
        yield {
          type: 'permission',
          request: {
            id: 'permission-1',
            toolName: 'strands_dev_single_select',
            input: {},
            options: [{ id: 'allow', label: 'Allow once', kind: 'allow_once' }],
          },
        }
        await allowed
        for (const key of ['experiments', 'cases'])
          answers.push(
            await tool('strands_dev_single_select').run({ question: key, options: [{ value: 'a', label: 'a' }] })
          )
        return { stopReason: 'endTurn' }
      },
      // The worker runs the tool before its answer to the permission reply arrives.
      respondPermission: vi.fn(async () => {
        allow()
        await new Promise((resolve) => setTimeout(resolve, 0))
        return true
      }),
    }))
    const answer = async (): Promise<void> => {
      await vi.waitFor(() => expect(broker.pending()).toBeDefined())
      const panel = controller.getSnapshot().panel
      expect(panel).toMatchObject({ kind: 'dev', command: 'ask' })
      const { id, fields } = broker.pending()!
      broker.respond(id, { [fields[0]!.key]: 'a' })
      // The panel closes itself once its question is answered.
      if (panel?.kind === 'dev') panel.close()
    }

    void controller.submit('/experiment')
    await vi.waitFor(() => expect(controller.getSnapshot().panel?.kind).toBe('permission'))
    await controller.activatePanelRow(controller.getSnapshot().panel!.rows[0]!)
    await answer()
    await answer()
    await vi.waitFor(() => expect(answers).toHaveLength(2))

    expect(String(prompts[0])).toContain('<strands_dev_command name="experiment">')
    expect(answers.map((reply) => JSON.parse(reply) as unknown)).toEqual([
      { status: 'answered', answer: 'a' },
      { status: 'answered', answer: 'a' },
    ])
    controller.close()
  })

  it('shouldCancelTheQuestionAndRunTheNextCommandWhenTheDeveloperClicksOutOfItAndPressesEscape', async () => {
    const answers: string[] = []
    const { controller, broker } = await experimentChat((tool) => ({
      async *stream() {
        yield* []
        answers.push(await tool('strands_dev_confirm').run({ question: 'Run it?' }))
        return { stopReason: 'endTurn' }
      },
    }))
    await controller.start()

    void controller.submit('/experiment')
    await vi.waitFor(() => expect(controller.getSnapshot().panel).toMatchObject({ kind: 'dev', command: 'ask' }))
    // A click outside the panel dismisses it, and Esc in the chat input cancels the turn.
    controller.dismissPanel()
    controller.cancel()
    await vi.waitFor(() => expect(answers).toHaveLength(1))
    void controller.submit('/experiment')
    await vi.waitFor(() => expect(controller.getSnapshot().panel).toMatchObject({ kind: 'dev', command: 'ask' }))
    broker.respond(broker.pending()!.id, { answer: 'yes' })
    await vi.waitFor(() => expect(answers).toHaveLength(2))

    expect(answers.map((reply) => (JSON.parse(reply) as { status: string }).status)).toEqual(['cancelled', 'answered'])
    controller.close()
  })
})
