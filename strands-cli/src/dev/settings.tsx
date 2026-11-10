import { createElement, useState, type ReactElement } from 'react'
import { Box, useInput } from 'ink'
import { Text } from '../ui/theme.js'
import { sanitizeTerminalText } from '../terminal/text.js'
import type { StartupScreen } from '../ui/run.js'
import { useCopyableError } from '../ui/clipboard.js'

const APPROVAL = 'DELETE'

interface ConfirmationProps {
  directory: string
  replacement: string
  onConfirm(): void
  onCancel(): void
}

const isPrintable = (input: string): boolean =>
  ![...input].some((character) => (character.codePointAt(0) ?? 0) < 32 || character === '\u007f')

export const WorkspaceReplacementConfirmation = ({
  directory,
  replacement,
  onConfirm,
  onCancel,
}: ConfirmationProps): ReactElement => {
  const [approval, setApproval] = useState('')
  const [error, setError] = useState<string>()
  const errorCopyHint = useCopyableError(error)
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) return onCancel()
    if (key.return) {
      if (approval === APPROVAL) return onConfirm()
      return setError('Type DELETE exactly to confirm, or press Esc to select a different agent.')
    }
    if (key.backspace || key.delete) return setApproval((current) => current.slice(0, -1))
    if (!key.ctrl && !key.meta && isPrintable(input)) setApproval((current) => `${current}${input}`.slice(0, 32))
  })
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>DELETE workspace and replace?</Text>
      <Text color="red">This is a DELETE operation.</Text>
      <Text>Workspace folder: {sanitizeTerminalText(directory)}</Text>
      <Text>
        All files in this folder will be replaced, including tmp agents, reports, state, and agents stored inside it.
      </Text>
      <Text>Agent projects outside this folder will not be deleted. A new chat starts after replacement.</Text>
      <Text>Replacement: {sanitizeTerminalText(replacement)}</Text>
      <Text>Type DELETE to confirm: {approval}▏</Text>
      {error ? (
        <Box flexDirection="column">
          <Text color="red">{error}</Text>
          <Text dimColor>{errorCopyHint}</Text>
        </Box>
      ) : null}
      <Text dimColor>Enter confirm · Esc back</Text>
    </Box>
  )
}

export const confirmWorkspaceReplacement = async (
  directory: string,
  replacement: string,
  screen: StartupScreen
): Promise<boolean> => {
  screen.signal.throwIfAborted()
  let complete: (confirmed: boolean) => void = () => undefined
  const result = new Promise<boolean>((resolve) => {
    complete = resolve
  })
  const cancel = (): void => complete(false)
  screen.signal.addEventListener('abort', cancel, { once: true })
  screen.show(
    createElement(WorkspaceReplacementConfirmation, {
      directory,
      replacement,
      onConfirm: () => complete(true),
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
