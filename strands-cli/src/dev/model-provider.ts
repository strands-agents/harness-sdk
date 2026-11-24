import { setImmediate } from 'node:timers'

import type { RequestSetup, SetupChange } from '../agent/configuration.js'
import type { CliConfigStore } from '../config/store.js'
import { errorMessage } from '../terminal/text.js'
import { modelProviderNeedsSetup } from '../ui/setup/providers.js'
import { AgentOptionsNotEditable, readAgentModel, saveAgentOptions } from './agent-options.js'
import { readDevWorkspace, type DevWorkspace } from './workspace.js'

export interface DevChat {
  showError?(title: string, message: string): void
}

export interface DevChatOpening {
  readonly workspace: string
  readonly config: CliConfigStore
  readonly launch: SetupChange | undefined
  readonly requestSetup: RequestSetup
  readonly onAgentModel: (model: string | undefined) => void
}

export const openDevChat = async <Chat extends DevChat>(
  { workspace: path, config, launch, requestSetup, onAgentModel }: DevChatOpening,
  create: () => Promise<Chat>
): Promise<Chat> => {
  const workspace = await readDevWorkspace(path)
  if (!workspace) throw new Error(`No strands dev workspace is at ${path}.`)
  const notices: { title: string; message: string }[] = []
  if (launch?.configuration) {
    const unsaved = await saveChosenModel(workspace, launch.configuration.profile.model)
    if (unsaved) notices.push({ title: 'Model unchanged', message: unsaved })
  }
  const model = await readAgentModel(workspace).catch((error: unknown) => {
    notices.push({ title: 'Model provider check skipped', message: errorMessage(error) })
    return undefined
  })
  onAgentModel(model)
  const chat = await create()
  for (const { title, message } of notices) chat.showError?.(title, message)
  if (!launch && model) offerProviderSetup(chat, config, model, requestSetup)
  return chat
}

const saveChosenModel = async (workspace: DevWorkspace, model: string): Promise<string | undefined> => {
  try {
    await saveAgentOptions(workspace, { model })
    return undefined
  } catch (error) {
    if (!(error instanceof AgentOptionsNotEditable)) throw error
    return `${errorMessage(error)} Set the model to ${model} in the agent file, and the agent reloads.`
  }
}

const offerProviderSetup = (chat: DevChat, config: CliConfigStore, model: string, requestSetup: RequestSetup): void => {
  void modelProviderNeedsSetup(config, model).then(
    (needed) => {
      if (needed) setImmediate(() => requestSetup())
    },
    (error: unknown) => chat.showError?.('Model provider check failed', errorMessage(error))
  )
}
