import { createElement, useRef, useState, type ReactElement } from 'react'
import { Box, useInput } from 'ink'
import { Text } from '../ui/theme.js'
import { errorMessage, sanitizeTerminalText } from '../terminal/text.js'
import { expandHome } from '../paths.js'
import type { StartupScreen } from '../ui/run.js'
import type { WorkspaceReplacementRequest } from './replace.js'

export type WorkspaceSettingsAction = 'edit' | 'import' | 'create'

interface WorkspaceFormProps {
  directory: string
  action: Exclude<WorkspaceSettingsAction, 'edit'>
  onSubmit(request: WorkspaceReplacementRequest): Promise<void>
  onCancel(): void
}

export const WorkspaceReplacementForm = ({
  directory,
  action,
  onSubmit,
  onCancel,
}: WorkspaceFormProps): ReactElement => {
  const [value, setValue] = useState(action === 'create' ? 'new-agent' : '')
  const [language, setLanguage] = useState<'typescript' | 'python'>('typescript')
  const [confirm, setConfirm] = useState(false)
  const [approval, setApproval] = useState('')
  const [error, setError] = useState<string>()
  const pending = useRef(false)
  useInput((input, key) => {
    if (pending.current) return
    if (key.escape || (key.ctrl && input === 'c')) return onCancel()
    if (key.tab && action === 'create' && !confirm)
      return setLanguage((current) => (current === 'typescript' ? 'python' : 'typescript'))
    if (key.return) {
      if (!confirm) {
        if (!value.trim())
          return setError(action === 'create' ? 'Enter an agent name.' : 'Enter an agent project or source path.')
        setError(undefined)
        setConfirm(true)
        return
      }
      if (approval !== 'DELETE') return setError('Type DELETE exactly to confirm, or press Esc to cancel.')
      pending.current = true
      const request: WorkspaceReplacementRequest =
        action === 'import'
          ? { kind: 'import', path: expandHome(value.trim()) }
          : { kind: 'create', language, name: value.trim() }
      void onSubmit(request).catch((cause: unknown) => {
        setError(sanitizeTerminalText(errorMessage(cause)))
        pending.current = false
      })
      return
    }
    if (key.backspace || key.delete) {
      if (confirm) setApproval((current) => current.slice(0, -1))
      else setValue((current) => current.slice(0, -1))
    } else if (
      !key.ctrl &&
      !key.meta &&
      ![...input].some((character) => (character.codePointAt(0) ?? 0) < 32 || character === '\u007f')
    ) {
      if (confirm) setApproval((current) => `${current}${input}`.slice(0, 32))
      else setValue((current) => `${current}${input}`.slice(0, 4096))
    }
  })
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>
        {confirm
          ? 'DELETE workspace and replace?'
          : action === 'import'
            ? 'Import a different agent'
            : 'Create a new agent'}
      </Text>
      {confirm ? (
        <>
          <Text color="red">This is a DELETE operation.</Text>
          <Text>Workspace folder: {sanitizeTerminalText(directory)}</Text>
          <Text>
            All files in this folder will be replaced, including tmp agents, reports, state, and agents stored inside
            it.
          </Text>
          <Text>Agent projects outside this folder will not be deleted. A new chat starts after replacement.</Text>
          <Text>
            Replacement: {sanitizeTerminalText(value)}
            {action === 'create' ? ` (${language})` : ''}
          </Text>
          <Text>Type DELETE to confirm: {approval}▏</Text>
        </>
      ) : (
        <>
          <Text>
            {action === 'import' ? 'Agent project or source path' : 'Agent name'}: {sanitizeTerminalText(value)}▏
          </Text>
          {action === 'create' ? <Text>Language: {language} · Tab to change</Text> : null}
          <Text dimColor>The next screen requires explicit confirmation before anything is deleted.</Text>
        </>
      )}
      {error ? <Text color="red">{error}</Text> : null}
      <Text dimColor>Enter continue · Esc cancel</Text>
    </Box>
  )
}

export const chooseWorkspaceReplacement = async (
  directory: string,
  action: Exclude<WorkspaceSettingsAction, 'edit'>,
  screen: StartupScreen
): Promise<WorkspaceReplacementRequest | undefined> => {
  screen.signal.throwIfAborted()
  let complete: (request: WorkspaceReplacementRequest | undefined) => void = () => undefined
  const result = new Promise<WorkspaceReplacementRequest | undefined>((resolve) => {
    complete = resolve
  })
  const cancel = (): void => complete(undefined)
  screen.signal.addEventListener('abort', cancel, { once: true })
  screen.show(
    createElement(WorkspaceReplacementForm, {
      directory,
      action,
      onSubmit: async (request) => complete(request),
      onCancel: cancel,
    }),
    'Strands dev workspace'
  )
  try {
    return await result
  } finally {
    screen.signal.removeEventListener('abort', cancel)
    screen.show(undefined)
  }
}
