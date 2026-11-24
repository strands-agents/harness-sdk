import { setImmediate } from 'node:timers'
import { createElement } from 'react'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineHarnessAgentConfig } from '@strands-agents/harness'

import type { SetupChange } from '../../src/agent/configuration.js'
import { CliConfigStore } from '../../src/config/store.js'
import * as agentOptions from '../../src/dev/agent-options.js'
import * as fix from '../../src/dev/fix-in-new-tab.js'
import { openDevChat, ProjectSetupPanel, projectSetupSession } from '../../src/dev/project-setup.js'
import * as workspaces from '../../src/dev/workspace.js'
import type { DevWorkspace } from '../../src/dev/workspace.js'
import { discoverProviderModels } from '../../src/model/discovery.js'
import * as preparation from '../../src/project/preparation.js'
import * as terminal from '../../src/terminal/terminal.js'
import { ChatController } from '../../src/ui/chat/controller.js'
import { runInkChat } from '../../src/ui/run.js'
import * as providers from '../../src/ui/setup/providers.js'
import { StartupContentRows } from '../../src/ui/startup.js'
import { idleBackend } from '../fixtures/chat-backend.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'
import { captureFrame, mouseInputSequence, render, ttyInput, ttyOutput } from '../fixtures/terminal.js'

vi.mock('../../src/model/discovery.js', async (original) => ({
  ...(await original<typeof import('../../src/model/discovery.js')>()),
  discoverAwsConfiguration: vi.fn(() => ({ profiles: [], regions: [] })),
  discoverAwsCredentials: vi.fn(async () => 'valid'),
  discoverOllama: async () => ({ installed: false, running: false, models: [] }),
  discoverLiteLlm: vi.fn(async () => ({ reachable: false, authenticationRequired: false, models: [] })),
  discoverProviderModels: vi.fn(async () => ({ available: true, models: [] })),
}))

afterEach(() => vi.restoreAllMocks())

type RunOptions = NonNullable<Parameters<typeof runInkChat>[1]>
type PanelProps = Parameters<typeof ProjectSetupPanel>[0]

const MISSING_KEY =
  'Anthropic API key is required. Provide it via the apiKey option or set the ANTHROPIC_API_KEY environment variable.'

const plan: NonNullable<PanelProps['plan']> = {
  project: { root: '/project', entrypoint: '/project/agent.ts', language: 'typescript' },
  runtime: 'Node 22',
  manager: 'npm',
  fingerprint: 'x',
  commands: [],
}
const failure: PanelProps['failure'] = {
  stage: 'build',
  summary: 'Project build failed',
  action: 'Fix the project, then Retry.',
  details: 'Build failed',
}
const failedCommand = { command: 'npm run build', logPath: '/tmp/setup.log' }

const mountPanel = (
  props: Partial<PanelProps>,
  { columns = 140, cardRows }: { columns?: number; cardRows?: number } = {}
) => {
  const input = ttyInput()
  const output = ttyOutput(columns, 40)
  const frame = captureFrame(output)
  const action = vi.fn()
  const panel = createElement(ProjectSetupPanel, { plan, failure, directory: '/project', onAction: action, ...props })
  render(cardRows === undefined ? panel : createElement(StartupContentRows, { value: cardRows }, panel), {
    stdin: input,
    stdout: output,
  })
  return { input, frame, text: () => frame().join('\n'), action }
}

const startup = (factory: Parameters<typeof runInkChat>[0], options: Partial<RunOptions>, columns = 140, rows = 40) => {
  const input = ttyInput()
  const output = ttyOutput(columns, rows)
  const frame = captureFrame(output)
  const running = runInkChat(factory, {
    input,
    output,
    errorOutput: output,
    config: CliConfigStore.memory({}, { animations: false }),
    intro: false,
    renderApp: render as NonNullable<RunOptions['renderApp']>,
    ...options,
  })
  return { input, frame, text: () => frame().join('\n'), running }
}

/** Starts a project whose entrypoint fails with `message` once and then loads. */
const startFailingProject = async (
  message: string,
  entry: 'agent.py' | 'agent.ts' = 'agent.py',
  options: Partial<RunOptions> = {},
  ...size: [columns?: number, rows?: number]
) => {
  const root = await temporaryDirectory()
  await writeFile(join(root, entry), 'invalid source fixture')
  const language = entry === 'agent.py' ? ('python' as const) : ('typescript' as const)
  const project = { root, entrypoint: join(root, entry), language }
  const setup = projectSetupSession()
  vi.spyOn(preparation, 'executePreparation').mockResolvedValue('/tmp/setup.log')
  const controller = new ChatController(idleBackend())
  const factory = vi.fn().mockRejectedValueOnce(new Error(message)).mockResolvedValueOnce(controller)
  const run = startup(
    factory,
    {
      prepare: async (screen) => (await setup.prepare(project, screen)) === 'ready',
      recoverStartup: setup.recover,
      ...options,
    },
    ...size
  )
  return { ...run, root, factory, controller }
}

describe('project setup guidance', () => {
  it('shouldPrepareAutomaticallyWithoutAskingForConfirmation', async () => {
    const root = await temporaryDirectory()
    const entrypoint = join(root, 'agent.ts')
    await writeFile(entrypoint, 'export const agent = {}')
    await writeFile(join(root, 'package.json'), '{}')
    const execute = vi.spyOn(preparation, 'executePreparation').mockResolvedValue('/tmp/setup.log')
    const screen = { signal: new AbortController().signal, show: vi.fn() }

    expect(await projectSetupSession().prepare({ root, entrypoint, language: 'typescript' }, screen)).toBe('ready')

    expect(execute).toHaveBeenCalledOnce()
    expect(screen.show.mock.calls.every(([content]) => content === undefined)).toBe(true)
  })

  it('shouldShowActionableDetailsOnlyWhenSetupFails', async () => {
    const { input, text, action } = mountPanel({ failure: { ...failure, ...failedCommand } })
    await vi.waitFor(() => expect(text()).toContain('Project build failed'))
    expect(text()).toContain('Root: /project')
    expect(text()).toContain('Runtime: Node 22')
    expect(text()).toContain('Log: /tmp/setup.log')
    input.write('v')
    await vi.waitFor(() => expect(action).toHaveBeenCalledWith('validate'))
  })

  it('shouldCopyTheFullSetupReportWhenControlYIsPressed', async () => {
    const copy = vi.spyOn(terminal, 'copyTerminalText').mockResolvedValue(true)
    const details = `error TS2307: ${'Cannot find module ./missing-dependency. '.repeat(10)}\nsecond log line`
    const command = `npm run build -- ${'--flag '.repeat(30)}`
    const { input, text } = mountPanel(
      { failure: { ...failure, command, logPath: '/tmp/setup.log', details } },
      { columns: 100 }
    )
    await vi.waitFor(() => expect(text()).toContain('Ctrl+Y copy error'))

    input.write('\u0019')

    await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce())
    expect(copy.mock.calls[0]![0]).toBe(
      [
        'Project build failed',
        'Root: /project',
        'Entrypoint: /project/agent.ts',
        'Runtime: Node 22',
        details,
        'Fix the project, then Retry.',
        `Failed command: ${command}`,
        'Log: /tmp/setup.log',
      ].join('\n')
    )
  })

  it.each([12, 14, 20])('shouldFitOpenDetailsInTheStartupCardWhenItHas%sRows', async (cardRows) => {
    const details = Array.from({ length: 30 }, (_, line) => `log line ${line}`).join('\n')
    const { input, frame, text } = mountPanel({ failure: { ...failure, ...failedCommand, details } }, { cardRows })
    await vi.waitFor(() => expect(text()).toContain('d details'))

    input.write('d')

    await vi.waitFor(() => expect(text()).toContain('hide details'))
    expect(text()).toContain('log line 1')
    expect(frame().filter((line) => line.trim()).length).toBeLessThanOrEqual(cardRows)
  })

  it('shouldOpenStrandsInANewTabWithTheSetupReportWhenFIsPressed', async () => {
    const open = vi.spyOn(fix, 'fixInNewTab').mockResolvedValue({
      status: 'success',
      text: 'Opened Strands in a new tmux window. Press r here when it is done.',
    })
    const { input, text } = mountPanel({
      plan: { ...plan, guidance: 'Prepare dependencies with pnpm, then choose Validate existing environment.' },
    })
    await vi.waitFor(() => expect(text()).toContain('f fix with Strands'))

    input.write('f')

    await vi.waitFor(() => expect(text()).toContain('Opened Strands in a new tmux window.'))
    expect(open).toHaveBeenCalledOnce()
    expect(open.mock.calls[0]![0]).toEqual({
      report: [
        'Project build failed',
        'Root: /project',
        'Entrypoint: /project/agent.ts',
        'Runtime: Node 22',
        'Build failed',
        'Fix the project, then Retry.',
        'Setup guidance: Prepare dependencies with pnpm, then choose Validate existing environment.',
      ].join('\n'),
      directory: '/project',
      retry: 'setup',
    })
  })

  it('shouldFixTheSelectedProjectWhenItsEntrypointFailsAfterSetup', async () => {
    const open = vi.spyOn(fix, 'fixInNewTab').mockResolvedValue({ status: 'success', text: 'Opened Strands' })
    const { input, text, root, factory, controller, running } = await startFailingProject(
      "No module named 'refund_desk'"
    )
    try {
      await vi.waitFor(() => expect(text()).toContain('refund_desk'))

      input.write('f')

      await vi.waitFor(() => expect(open).toHaveBeenCalledOnce())
      expect(open.mock.calls[0]![0]).toMatchObject({ directory: root, retry: 'setup' })
      expect(open.mock.calls[0]![0].report).toContain("No module named 'refund_desk'")
      input.write('v')
      await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2))
      controller.close()
      expect(await running).toBe(0)
    } finally {
      input.write('b')
      controller.close()
      await controller.dispose()
    }
  })

  it('shouldKeepImportFailuresInTheTuiAndAllowValidationRetry', async () => {
    const { input, text, factory, controller, running } = await startFailingProject("No module named 'refund_desk'")
    try {
      await vi.waitFor(() => expect(text()).toContain('refund_desk'))
      expect(text()).toContain('editable install')
      input.write('d')
      await vi.waitFor(() => expect(text()).toContain('hide details'))
      input.write('v')
      await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2))
      controller.close()
      expect(await running).toBe(0)
    } finally {
      input.write('b')
      controller.close()
      await controller.dispose()
    }
  })

  it('shouldRetryWithUpdatedCommandsWithoutAnotherConfirmation', async () => {
    const root = await temporaryDirectory()
    const entrypoint = join(root, 'agent.ts')
    const manifest = join(root, 'package.json')
    await writeFile(entrypoint, 'export const agent = {}')
    await writeFile(manifest, '{}')
    const setup = projectSetupSession()
    const execute = vi
      .spyOn(preparation, 'executePreparation')
      .mockRejectedValueOnce(new Error('Install failed'))
      .mockResolvedValue('/tmp/setup.log')
    const { input, text, running } = startup(
      async (): Promise<never> => {
        throw new Error('must not start')
      },
      {
        prepare: async (screen) => {
          await setup.prepare({ root, entrypoint, language: 'typescript' }, screen)
          return false
        },
      }
    )
    try {
      await vi.waitFor(() => expect(text()).toContain('Install failed'))
      await writeFile(manifest, '{"scripts":{"build":"echo changed"}}')
      input.write('r')
      await running
      expect(execute).toHaveBeenCalledTimes(2)
      expect(execute.mock.calls[1]?.[0].commands).toContainEqual({
        stage: 'build',
        command: 'npm',
        args: ['--global=false', 'run', 'build'],
      })
    } finally {
      input.write('b')
      await running
    }
  })

  it('shouldReturnToSelectionWhenBackIsChosenAfterFailure', async () => {
    const prepare = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const { input, text, running } = startup(
      async (): Promise<never> => {
        throw new Error('Build failed')
      },
      { prepare, recoverStartup: projectSetupSession().recover }
    )
    await vi.waitFor(() => expect(text()).toContain('Project entrypoint failed'))
    input.write('b')
    expect(await running).toBe(0)
    expect(prepare).toHaveBeenCalledTimes(2)
  })
})

describe('model provider recovery at startup', () => {
  const startWithMissingKey = async () => {
    const run = await startFailingProject(
      MISSING_KEY,
      'agent.ts',
      { providerSetup: { model: () => 'bedrock/model-alpha' } },
      180,
      44
    )
    const click = (label: string): void => {
      const lines = run.frame()
      const row = lines.findIndex((line) => line.includes(label))
      expect(row).toBeGreaterThanOrEqual(0)
      const column = lines[row]!.indexOf(label)
      run.input.write(mouseInputSequence(0, column, row, 'M'))
      run.input.write(mouseInputSequence(3, column, row, 'm'))
    }
    return { ...run, click }
  }

  it('shouldRetryWithTheChosenModelWhenSetupSavesFromAMissingKeyFailure', async () => {
    vi.mocked(discoverProviderModels).mockResolvedValue({
      available: true,
      models: [
        { id: 'model-alpha', name: 'Model Alpha' },
        { id: 'model-beta', name: 'Model Beta' },
      ],
    })
    const { input, text, click, factory, controller, running } = await startWithMissingKey()
    try {
      await vi.waitFor(() => expect(text()).toContain('s set up a model'))
      expect(text()).not.toContain('f fix with Strands')

      input.write('s')
      await vi.waitFor(() => expect(text()).toContain('Model Beta'))
      click('Model Beta')
      await vi.waitFor(() => expect(text()).toContain('✓ Model Beta'))
      click('Save and Launch')

      await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2))
      expect(factory.mock.calls[1]![3]).toMatchObject({ configuration: { profile: { model: 'bedrock/model-beta' } } })
      controller.close()
      expect(await running).toBe(0)
    } finally {
      controller.close()
      await controller.dispose()
      vi.mocked(discoverProviderModels).mockResolvedValue({ available: true, models: [] })
    }
  })

  it('shouldReturnToTheStartupErrorWithoutAChosenModelWhenSetupIsCancelled', async () => {
    const { input, text, factory, controller, running } = await startWithMissingKey()
    try {
      await vi.waitFor(() => expect(text()).toContain('s set up a model'))
      input.write('s')
      await vi.waitFor(() => expect(text()).toContain('Pick a model for your agent'))

      input.write('\u001b')

      await vi.waitFor(() => expect(text()).toContain('s set up a model'))
      expect(factory).toHaveBeenCalledOnce()
      input.write('r')
      await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2))
      expect(factory.mock.calls[1]![3]).toBeUndefined()
      controller.close()
      expect(await running).toBe(0)
    } finally {
      controller.close()
      await controller.dispose()
    }
  })
})

const WORKSPACE_PATH = '/project/strands-dev'
const AGENT_MODEL = 'anthropic/claude-sonnet-4-5'
const CHOSEN_MODEL = 'bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0'

const workspace = {
  root: WORKSPACE_PATH,
  entrypoint: `${WORKSPACE_PATH}/agent/agent/agent.ts`,
  config: { language: 'typescript' },
} as unknown as DevWorkspace

const savedSetup: SetupChange = {
  configuration: {
    providers: ['bedrock'],
    profile: defineHarnessAgentConfig({ model: CHOSEN_MODEL }),
    permissionMode: 'default',
    providerEnvironment: {},
  },
}

const open = (launch: SetupChange | undefined) => {
  const chat = { showError: vi.fn() }
  const requestSetup = vi.fn()
  const onAgentModel = vi.fn()
  const create = vi.fn(async () => chat)
  const opened = openDevChat(
    { workspace: WORKSPACE_PATH, config: CliConfigStore.memory(), launch, requestSetup, onAgentModel },
    create
  )
  return { opened, chat, create, requestSetup, onAgentModel }
}

describe('dev chat model provider', () => {
  beforeEach(() => {
    vi.spyOn(workspaces, 'readDevWorkspace').mockResolvedValue(workspace)
  })

  it('shouldWriteTheChosenModelIntoTheAgentFileBeforeTheChatOpensWhenSetupSaves', async () => {
    const save = vi.spyOn(agentOptions, 'saveAgentOptions').mockResolvedValue(true)
    vi.spyOn(agentOptions, 'readAgentModel').mockResolvedValue(CHOSEN_MODEL)
    const check = vi.spyOn(providers, 'modelProviderNeedsSetup')

    const { opened, chat, create, onAgentModel } = open(savedSetup)
    await opened

    expect(save).toHaveBeenCalledWith(workspace, { model: CHOSEN_MODEL })
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0]!)
    expect(onAgentModel).toHaveBeenCalledWith(CHOSEN_MODEL)
    expect(chat.showError).not.toHaveBeenCalled()
    expect(check).not.toHaveBeenCalled()
  })

  it('shouldExplainWhyTheModelIsUnchangedWhenTheAgentFileSetsTheModelInCode', async () => {
    vi.spyOn(agentOptions, 'saveAgentOptions').mockRejectedValue(
      new agentOptions.AgentOptionsNotEditable('agent/agent.ts sets model in code. Set it to "x" there yourself.')
    )
    vi.spyOn(agentOptions, 'readAgentModel').mockResolvedValue(undefined)

    const { opened, chat } = open(savedSetup)
    await opened

    expect(chat.showError).toHaveBeenCalledWith(
      'Model unchanged',
      expect.stringContaining(`Set the model to ${CHOSEN_MODEL} in the agent file`)
    )
  })

  it('shouldOpenProviderSetupForTheAgentFileModelWhenItsProviderNeedsSetupAtStart', async () => {
    vi.spyOn(agentOptions, 'readAgentModel').mockResolvedValue(AGENT_MODEL)
    const check = vi.spyOn(providers, 'modelProviderNeedsSetup').mockResolvedValue(true)

    const { opened, requestSetup, onAgentModel } = open(undefined)
    await opened

    await vi.waitFor(() => expect(requestSetup).toHaveBeenCalledOnce())
    expect(check).toHaveBeenCalledWith(expect.any(CliConfigStore), AGENT_MODEL)
    expect(onAgentModel).toHaveBeenCalledWith(AGENT_MODEL)
  })

  it('shouldKeepTheChatOpenWhenTheModelProviderIsReadyAtStart', async () => {
    vi.spyOn(agentOptions, 'readAgentModel').mockResolvedValue(AGENT_MODEL)
    const check = vi.spyOn(providers, 'modelProviderNeedsSetup').mockResolvedValue(false)

    const { opened, requestSetup } = open(undefined)
    await opened
    await vi.waitFor(() => expect(check).toHaveBeenCalledOnce())
    await new Promise((resolve) => setImmediate(resolve))

    expect(requestSetup).not.toHaveBeenCalled()
  })

  it('shouldSkipTheProviderCheckWhenTheAgentFileSetsTheModelInCode', async () => {
    vi.spyOn(agentOptions, 'readAgentModel').mockResolvedValue(undefined)
    const check = vi.spyOn(providers, 'modelProviderNeedsSetup')

    const { opened, chat, onAgentModel } = open(undefined)
    await opened

    expect(check).not.toHaveBeenCalled()
    expect(onAgentModel).toHaveBeenCalledWith(undefined)
    expect(chat.showError).not.toHaveBeenCalled()
  })

  it('shouldShowWhyTheProviderCheckWasSkippedWhenTheAgentFileCannotBeRead', async () => {
    vi.spyOn(agentOptions, 'readAgentModel').mockRejectedValue(new Error('EACCES: permission denied'))
    const check = vi.spyOn(providers, 'modelProviderNeedsSetup')

    const { opened, chat } = open(undefined)
    await opened

    expect(chat.showError).toHaveBeenCalledWith('Model provider check skipped', 'EACCES: permission denied')
    expect(check).not.toHaveBeenCalled()
  })

  it('shouldNotCheckTheProviderOrWriteTheModelWhenTheChatReloadsAfterAFileChange', async () => {
    vi.spyOn(agentOptions, 'readAgentModel').mockResolvedValue(AGENT_MODEL)
    const check = vi.spyOn(providers, 'modelProviderNeedsSetup')
    const save = vi.spyOn(agentOptions, 'saveAgentOptions')

    const { opened, requestSetup } = open({ agentProject: workspace.entrypoint, reloadedFiles: ['agent/agent.ts'] })
    await opened

    expect(check).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    expect(requestSetup).not.toHaveBeenCalled()
  })

  it('shouldShowAFailedProviderCheckInTheChatWhenTheCheckRejects', async () => {
    vi.spyOn(agentOptions, 'readAgentModel').mockResolvedValue(AGENT_MODEL)
    vi.spyOn(providers, 'modelProviderNeedsSetup').mockRejectedValue(new Error('provider check exploded'))

    const { opened, chat, requestSetup } = open(undefined)
    await opened

    await vi.waitFor(() =>
      expect(chat.showError).toHaveBeenCalledWith('Model provider check failed', 'provider check exploded')
    )
    expect(requestSetup).not.toHaveBeenCalled()
  })
})
