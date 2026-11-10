import { createElement, useState, type ReactElement } from 'react'
import { Box, useInput } from 'ink'

import { Text, useTheme } from '../ui/theme.js'
import type { StartupScreen } from '../ui/run.js'
import { useTerminalSize } from '../ui/terminal-size.js'
import {
  describePreparationCommand,
  planProjectPreparation,
  type ProjectPreparationPlan,
} from '../project/preparation-plan.js'
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

export type SetupAction = 'prepare' | 'validate' | 'back' | 'cancel' | 'retry'

interface ProjectSetupPanelProps {
  plan?: ProjectPreparationPlan
  failure?: PreparationFailure
  onAction(action: SetupAction): void
}

export const ProjectSetupPanel = ({ plan, failure, onAction }: ProjectSetupPanelProps): ReactElement => {
  const { accent, error } = useTheme()
  const { rows } = useTerminalSize()
  const [details, setDetails] = useState(false)
  useInput((input, key) => {
    if (key.ctrl && input === 'c') return onAction('cancel')
    if (key.escape || input.toLowerCase() === 'b') return onAction('back')
    if (input.toLowerCase() === 'd') return setDetails((visible) => !visible)
    if (input.toLowerCase() === 'v') return onAction('validate')
    if (key.return || input.toLowerCase() === 'r')
      return onAction(failure ? 'retry' : plan?.manager === 'manual' ? 'validate' : 'prepare')
  })
  return (
    <Box flexDirection="column">
      <Text bold color={failure ? error : accent}>
        {failure ? failure.summary : 'Prepare selected project'}
      </Text>
      {plan ? (
        <>
          <Text wrap="truncate-middle">Root: {sanitizeTerminalText(plan.project.root)}</Text>
          <Text wrap="truncate-middle">Entrypoint: {sanitizeTerminalText(plan.project.entrypoint)}</Text>
          <Text wrap="truncate-middle">Runtime: {sanitizeTerminalText(plan.runtime)}</Text>
        </>
      ) : null}
      {failure ? (
        <>
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
        </>
      ) : (
        <>
          {plan?.commands.map((step, index) => (
            <Text key={index} wrap="truncate-middle">
              {index + 1}. {redactPreparationOutput(describePreparationCommand(step))}
            </Text>
          ))}
          {plan?.guidance ? <Text>{plan.guidance}</Text> : null}
          <Text dimColor>
            Install and build commands can execute project code. The initial candidate copy uses the same setup. Source
            and lockfiles will not be reset.
          </Text>
        </>
      )}
      {details && failure ? (
        <Box height={Math.max(2, Math.min(8, rows - 20))} overflow="hidden">
          <Text>{failure.details}</Text>
        </Box>
      ) : null}
      <Text dimColor>
        {failure
          ? `Enter / r retry · v validate after manual setup · d ${details ? 'hide details' : 'details'} · b back`
          : 'Enter prepare · v validate existing environment · b back'}
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
  let validateOnly = false
  const run = async (screen: StartupScreen): Promise<void> => {
    if (!plan) throw new Error('No project is selected.')
    if (!validateOnly) {
      const logPath = await executePreparation(plan, {
        signal: screen.signal,
        progress: (value) => {
          progress = value
          screen.show(
            undefined,
            `${value.stage === 'build' ? 'Building project' : value.stage === 'runtime' ? 'Preparing runtime' : 'Installing dependencies'}…`
          )
        },
      })
      progress = { stage: 'entrypoint', command: `Load ${plan.project.entrypoint}`, logPath }
    }
    screen.show(undefined, 'Checking entrypoint in the selected runtime…')
  }
  const failure = (error: unknown): PreparationFailure =>
    error instanceof ProjectPreparationError ? error.failure : preparationFailure(error, progress)
  return {
    prepare: async (project, screen, afterPreparation): Promise<'ready' | 'back' | 'cancel'> => {
      progress = undefined
      let lastError: unknown
      for (;;) {
        try {
          const updated = await planProjectPreparation(project)
          if (!plan || plan.fingerprint !== updated.fingerprint) lastError = undefined
          plan = updated
        } catch (error) {
          plan = undefined
          lastError = error
        }
        const action = await ask(screen, {
          ...(plan ? { plan } : {}),
          ...(lastError ? { failure: failure(lastError) } : {}),
        })
        if (action === 'back' || action === 'cancel') return action
        if (!plan) continue
        validateOnly = action === 'validate' || plan.manager === 'manual'
        try {
          const current = await planProjectPreparation(project)
          if (current.fingerprint !== plan.fingerprint) {
            plan = current
            lastError = undefined
            continue
          }
          await run(screen)
          await afterPreparation?.(!validateOnly)
          screen.show(undefined, 'Checking entrypoint in the selected runtime…')
          return 'ready'
        } catch (error) {
          if (screen.signal.aborted) return 'cancel'
          lastError = error
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
        validateOnly = action === 'validate' || plan?.manager === 'manual'
        try {
          if (plan) {
            const current = await planProjectPreparation(plan.project)
            if (current.fingerprint !== plan.fingerprint) {
              plan = current
              const approved = await ask(screen, { plan })
              if (approved === 'back') return 'back'
              if (approved === 'cancel') return 'exit'
              validateOnly = approved === 'validate' || plan.manager === 'manual'
            }
          }
          await run(screen)
          return 'retry'
        } catch (next) {
          if (screen.signal.aborted) return 'exit'
          failureRecord = failure(next)
        }
      }
    },
  }
}
