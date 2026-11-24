import { setImmediate } from 'node:timers'
import { createElement, useState, type ReactElement } from 'react'
import { Box, useStdout } from 'ink'
import { useInput } from '../ui/input.js'

import type { RequestSetup, SetupChange } from '../agent/configuration.js'
import type { CliConfigStore } from '../config/store.js'
import { modelProviderNeedsSetup } from '../ui/setup/providers.js'
import { Text, useTheme } from '../ui/theme.js'
import type { StartupScreen } from '../ui/run.js'
import { useStartupContentRows } from '../ui/startup.js'
import { useCopyableError } from '../ui/clipboard.js'
import { planProjectPreparation, type ProjectPreparationPlan } from '../project/preparation-plan.js'
import {
  executePreparation,
  redactPreparationOutput,
  recordEntrypointFailure,
  preparationFailure,
  ProjectPreparationError,
  type PreparationFailure,
  type PreparationProgress,
} from '../project/preparation.js'
import type { ImportedAgentProject } from '../project/import.js'
import { errorMessage, sanitizeTerminalText } from '../terminal/text.js'
import { isModelCredentialFailure } from '../model/credential-failure.js'
import { AgentOptionsNotEditable, readAgentModel, saveAgentOptions } from './agent-options.js'
import { fixInNewTab, type FixOutcome } from './fix-in-new-tab.js'
import { readDevWorkspace, type DevWorkspace } from './workspace.js'

const PANEL_FIXED_ROWS = 10
const DETAILS_MIN_ROWS = 2
const DETAILS_MAX_ROWS = 8

type SetupAction = 'validate' | 'back' | 'cancel' | 'retry' | 'model'

const MODEL_SETUP_ACTION = "The agent's model provider has no working credentials. Press s to set up a model."

interface ProjectSetupPanelProps {
  plan?: ProjectPreparationPlan
  failure: PreparationFailure
  directory: string
  modelSetup?: boolean
  onAction(action: SetupAction): void
}

const failureReport = (plan: ProjectPreparationPlan | undefined, failure: PreparationFailure): string =>
  [
    failure.summary,
    ...(plan
      ? [`Root: ${plan.project.root}`, `Entrypoint: ${plan.project.entrypoint}`, `Runtime: ${plan.runtime}`]
      : []),
    failure.details,
    failure.action,
    ...(failure.command ? [`Failed command: ${redactPreparationOutput(failure.command)}`] : []),
    ...(failure.logPath ? [`Log: ${failure.logPath}`] : []),
  ]
    .filter((line) => line.trim())
    .join('\n')

export const ProjectSetupPanel = ({
  plan,
  failure,
  directory,
  modelSetup = false,
  onAction,
}: ProjectSetupPanelProps): ReactElement => {
  const { error } = useTheme()
  const detailRows = Math.max(DETAILS_MIN_ROWS, Math.min(DETAILS_MAX_ROWS, useStartupContentRows() - PANEL_FIXED_ROWS))
  const { stdout } = useStdout()
  const [details, setDetails] = useState(false)
  const [fix, setFix] = useState<FixOutcome>()
  const report = failureReport(plan, failure)
  const copyHint = useCopyableError(report)
  const fixInTab = (): void => {
    setFix({ status: 'delivered', text: 'Opening Strands in a new tab…' })
    const guidance = plan?.guidance ? `\nSetup guidance: ${plan.guidance}` : ''
    void fixInNewTab({ report: `${report}${guidance}`, directory, retry: 'setup' }, stdout).then(setFix)
  }
  useInput((input, key) => {
    if (key.ctrl && input === 'c') return onAction('cancel')
    if (key.escape || input.toLowerCase() === 'b') return onAction('back')
    if (input.toLowerCase() === 'd') return setDetails((visible) => !visible)
    if (modelSetup && input.toLowerCase() === 's') return onAction('model')
    if (!modelSetup && input.toLowerCase() === 'f') return fixInTab()
    if (input.toLowerCase() === 'v') return onAction('validate')
    if (key.return || input.toLowerCase() === 'r') return onAction('retry')
  })
  return (
    <Box flexDirection="column">
      <Text bold color={error}>
        {failure.summary}
      </Text>
      {plan ? (
        <>
          <Text wrap="truncate-middle">Root: {sanitizeTerminalText(plan.project.root)}</Text>
          <Text wrap="truncate-middle">Entrypoint: {sanitizeTerminalText(plan.project.entrypoint)}</Text>
          <Text wrap="truncate-middle">Runtime: {sanitizeTerminalText(plan.runtime)}</Text>
        </>
      ) : null}
      <Text color={error}>
        {failure.details
          .split('\n')
          .find((line) => line.trim())
          ?.slice(0, 240)}
      </Text>
      <Text>{modelSetup ? MODEL_SETUP_ACTION : failure.action}</Text>
      {failure.command ? (
        <Text wrap="truncate-middle">Failed command: {redactPreparationOutput(failure.command)}</Text>
      ) : null}
      {failure.logPath ? <Text wrap="truncate-middle">Log: {failure.logPath}</Text> : null}
      {details ? (
        <Box height={detailRows} overflow="hidden">
          <Text>{failure.details}</Text>
        </Box>
      ) : null}
      {fix ? <Text {...(fix.status === 'error' ? { color: error } : {})}>{fix.text}</Text> : null}
      <Text dimColor>
        {`${modelSetup ? 's set up a model · Enter / r retry' : 'Enter / r retry · v validate after manual setup · f fix with Strands'} · d ${details ? 'hide details' : 'details'} · ${copyHint} · b back`}
      </Text>
    </Box>
  )
}

const ask = async (screen: StartupScreen, props: Omit<ProjectSetupPanelProps, 'onAction'>): Promise<SetupAction> => {
  screen.signal.throwIfAborted()
  let finish: (action: SetupAction) => void = () => undefined
  const answer = new Promise<SetupAction>((resolve) => {
    finish = resolve
  })
  const cancel = (): void => finish('cancel')
  screen.signal.addEventListener('abort', cancel, { once: true })
  screen.show(createElement(ProjectSetupPanel, { ...props, onAction: finish }), 'Project setup needs attention')
  try {
    return await answer
  } finally {
    screen.signal.removeEventListener('abort', cancel)
  }
}

export interface ProjectSetupSession {
  prepare(project: ImportedAgentProject, screen: StartupScreen): Promise<'ready' | 'back' | 'cancel'>
  recover(error: unknown, screen: StartupScreen): Promise<'retry' | 'back' | 'exit'>
}

export const projectSetupSession = (): ProjectSetupSession => {
  let plan: ProjectPreparationPlan | undefined
  let progress: PreparationProgress | undefined
  const failure = (error: unknown): PreparationFailure =>
    error instanceof ProjectPreparationError ? error.failure : preparationFailure(error, progress)
  const run = async (screen: StartupScreen, force = false): Promise<void> => {
    if (!plan) throw new Error('No project is selected.')
    const logPath = await executePreparation(plan, {
      signal: screen.signal,
      force,
      progress: (value) => {
        progress = value
        screen.show(
          undefined,
          `${value.stage === 'build' ? 'Building project' : value.stage === 'runtime' ? 'Preparing runtime' : 'Installing dependencies'}…`
        )
      },
    })
    progress = { stage: 'entrypoint', command: `Load ${plan.project.entrypoint}`, logPath }
    screen.show(undefined, 'Checking entrypoint in the selected runtime…')
  }
  return {
    prepare: async (project, screen): Promise<'ready' | 'back' | 'cancel'> => {
      progress = undefined
      let force = false
      let validateOnly = false
      for (;;) {
        try {
          plan = await planProjectPreparation(project)
          if (!validateOnly) await run(screen, force)
          else screen.show(undefined, 'Checking entrypoint in the selected runtime…')
          return 'ready'
        } catch (error) {
          if (screen.signal.aborted) return 'cancel'
          const action = await ask(screen, {
            ...(plan ? { plan } : {}),
            failure: failure(error),
            directory: project.root,
          })
          if (action === 'back' || action === 'cancel') return action
          validateOnly = action === 'validate'
          force = true
        }
      }
    },
    recover: async (error, screen): Promise<'retry' | 'back' | 'exit'> => {
      let failureRecord = failure(error)
      if (plan) {
        try {
          failureRecord = await recordEntrypointFailure(plan.project, error)
        } catch (logError) {
          failureRecord = {
            ...failureRecord,
            details: `${failureRecord.details}\nCould not save the setup log: ${errorMessage(logError)}`,
          }
        }
      }
      for (;;) {
        const chooseModelProvider = screen.chooseModelProvider
        const modelSetup =
          chooseModelProvider !== undefined &&
          isModelCredentialFailure(`${failureRecord.summary}\n${failureRecord.details}`)
        const action = await ask(screen, {
          ...(plan ? { plan } : {}),
          failure: failureRecord,
          directory: plan?.project.root ?? process.cwd(),
          modelSetup,
        })
        if (action === 'cancel') return 'exit'
        if (action === 'back') return 'back'
        if (action === 'model') {
          if (await chooseModelProvider?.()) return 'retry'
          continue
        }
        try {
          if (plan) plan = await planProjectPreparation(plan.project)
          if (action !== 'validate') await run(screen, true)
          else screen.show(undefined, 'Checking entrypoint in the selected runtime…')
          return 'retry'
        } catch (next) {
          if (screen.signal.aborted) return 'exit'
          failureRecord = failure(next)
        }
      }
    },
  }
}

export interface DevChat {
  showError?(title: string, message: string): void
}

interface DevChatOpening {
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
