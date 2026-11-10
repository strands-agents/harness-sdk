import { createElement, useState, type ReactElement } from 'react'
import { Box, useInput } from 'ink'

import { Text, useTheme } from '../ui/theme.js'
import type { StartupScreen } from '../ui/run.js'
import { useTerminalSize } from '../ui/terminal-size.js'
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
import { sanitizeTerminalText } from '../terminal/text.js'

export type SetupAction = 'validate' | 'back' | 'cancel' | 'retry'

interface ProjectSetupPanelProps {
  plan?: ProjectPreparationPlan
  failure: PreparationFailure
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

export const ProjectSetupPanel = ({ plan, failure, onAction }: ProjectSetupPanelProps): ReactElement => {
  const { error } = useTheme()
  const { rows } = useTerminalSize()
  const [details, setDetails] = useState(false)
  const copyHint = useCopyableError(failureReport(plan, failure))
  useInput((input, key) => {
    if (key.ctrl && input === 'c') return onAction('cancel')
    if (key.escape || input.toLowerCase() === 'b') return onAction('back')
    if (input.toLowerCase() === 'd') return setDetails((visible) => !visible)
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
      <Text>{failure.action}</Text>
      {failure.command ? (
        <Text wrap="truncate-middle">Failed command: {redactPreparationOutput(failure.command)}</Text>
      ) : null}
      {failure.logPath ? <Text wrap="truncate-middle">Log: {failure.logPath}</Text> : null}
      <Text dimColor>{copyHint}</Text>
      {details ? (
        <Box height={Math.max(2, Math.min(8, rows - 20))} overflow="hidden">
          <Text>{failure.details}</Text>
        </Box>
      ) : null}
      <Text dimColor>
        {`Enter / r retry · v validate after manual setup · d ${details ? 'hide details' : 'details'} · b back`}
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
  screen.show(
    createElement(ProjectSetupPanel, { ...props, onAction: finish }),
    props.failure ? 'Project setup needs attention' : 'Review project setup'
  )
  try {
    return await answer
  } finally {
    screen.signal.removeEventListener('abort', cancel)
  }
}

export interface ProjectSetupSession {
  prepare(
    project: ImportedAgentProject,
    screen: StartupScreen,
    afterPreparation?: (install: boolean) => Promise<void>
  ): Promise<'ready' | 'back' | 'cancel'>
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
    prepare: async (project, screen, afterPreparation): Promise<'ready' | 'back' | 'cancel'> => {
      progress = undefined
      let force = false
      let validateOnly = false
      for (;;) {
        try {
          plan = await planProjectPreparation(project)
          if (!validateOnly) await run(screen, force)
          else screen.show(undefined, 'Checking entrypoint in the selected runtime…')
          await afterPreparation?.(!validateOnly)
          screen.show(undefined, 'Checking entrypoint in the selected runtime…')
          return 'ready'
        } catch (error) {
          if (screen.signal.aborted) return 'cancel'
          const action = await ask(screen, { ...(plan ? { plan } : {}), failure: failure(error) })
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
            details: `${failureRecord.details}\nCould not save the setup log: ${sanitizeTerminalText(logError instanceof Error ? logError.message : String(logError))}`,
          }
        }
      }
      for (;;) {
        const action = await ask(screen, { ...(plan ? { plan } : {}), failure: failureRecord })
        if (action === 'cancel') return 'exit'
        if (action === 'back') return 'back'
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
