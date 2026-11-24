import { setImmediate } from 'node:timers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineHarnessAgentConfig } from '@strands-agents/harness'

import type { SetupChange } from '../../src/agent/configuration.js'
import { CliConfigStore } from '../../src/config/store.js'
import * as agentOptions from '../../src/dev/agent-options.js'
import { openDevChat } from '../../src/dev/model-provider.js'
import * as workspaces from '../../src/dev/workspace.js'
import type { DevWorkspace } from '../../src/dev/workspace.js'
import * as providers from '../../src/ui/setup/providers.js'

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

beforeEach(() => {
  vi.spyOn(workspaces, 'readDevWorkspace').mockResolvedValue(workspace)
})

afterEach(() => vi.restoreAllMocks())

describe('dev chat model provider', () => {
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
