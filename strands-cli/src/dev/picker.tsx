import { createElement, useRef, useState, type ReactElement } from 'react'
import { Box, useInput } from 'ink'
import { Text, useTheme } from '../ui/theme.js'
import type { StartupScreen } from '../ui/run.js'
import { errorMessage, sanitizeTerminalText } from '../terminal/text.js'
import type { DiscoveredHarness } from './search.js'
import type { DevWorkspace } from './workspace.js'
import { useTerminalSize } from '../ui/terminal-size.js'

export type HarnessChoice =
  | { kind: 'cli' }
  | { kind: 'discovered'; harness: DiscoveredHarness }
  | { kind: 'create'; language: 'typescript' | 'python'; name: string }

interface PickerProps {
  cliName: string
  harnesses: readonly DiscoveredHarness[]
  warnings?: readonly string[]
  onSelect: (selection: HarnessChoice | undefined) => void | Promise<void>
}

export const HarnessPicker = ({ cliName, harnesses, warnings = [], onSelect }: PickerProps): ReactElement => {
  const [selection, setSelection] = useState(0)
  const [creating, setCreating] = useState(false)
  const [language, setLanguage] = useState<'typescript' | 'python'>('typescript')
  const [name, setName] = useState('new-harness')
  const [failure, setFailure] = useState<string>()
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const { accent, error: errorColor } = useTheme()
  const { rows: height } = useTerminalSize()
  const rows = [
    { label: `Strands CLI · ${sanitizeTerminalText(cliName)}`, detail: 'Create or open an independent local copy' },
    ...harnesses.map((harness) => ({
      label: `${sanitizeTerminalText(harness.name)} · ${harness.language}`,
      detail: sanitizeTerminalText(harness.entrypoint),
    })),
    { label: 'Create a new harness', detail: 'Start from your saved profile' },
  ]
  const submit = (choice: HarnessChoice | undefined): void => {
    if (pending.current && choice) return
    pending.current = true
    setBusy(choice !== undefined)
    setFailure(undefined)
    void Promise.resolve()
      .then(() => onSelect(choice))
      .catch((error: unknown) => {
        setFailure(sanitizeTerminalText(errorMessage(error)))
      })
      .finally(() => {
        pending.current = false
        setBusy(false)
      })
  }
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) return submit(undefined)
    if (pending.current) return
    if (creating) {
      if (key.tab) return setLanguage((current) => (current === 'typescript' ? 'python' : 'typescript'))
      if (key.return && name && name !== '.' && name !== '..') return submit({ kind: 'create', name, language })
      if (key.backspace || key.delete) return setName((current) => current.slice(0, -1))
      if (!key.ctrl && !key.meta && /^[a-zA-Z0-9._-]+$/.test(input))
        setName((current) => `${current}${input}`.slice(0, 64))
      return
    }
    if (key.upArrow) setSelection((current) => (current + rows.length - 1) % rows.length)
    if (key.downArrow) setSelection((current) => (current + 1) % rows.length)
    if (!key.return) return
    if (selection === 0) return submit({ kind: 'cli' })
    const harness = harnesses[selection - 1]
    if (harness) return submit({ kind: 'discovered', harness })
    setCreating(true)
  })
  const capacity = Math.max(1, Math.min(6, Math.floor((height - 14) / 2)))
  const start = Math.max(0, selection - capacity + 1)
  return (
    <Box flexDirection="column">
      <Text bold color={accent}>
        {creating ? 'Create a harness' : 'strands dev · Select a harness'}
      </Text>
      {creating ? (
        <>
          <Text>Name: {name}▏</Text>
          <Text>Language: {language}</Text>
        </>
      ) : (
        rows.slice(start, start + capacity).map((row, index) => (
          <Box key={start + index} flexDirection="column">
            <Text bold={start + index === selection} {...(start + index === selection ? { color: accent } : {})}>
              {start + index === selection ? '›' : ' '} {row.label}
            </Text>
            <Text dimColor wrap="truncate-middle">
              {' '}
              {row.detail}
            </Text>
          </Box>
        ))
      )}
      {failure ? <Text color={errorColor}>{failure}</Text> : null}
      {!failure && warnings[0] ? (
        <Text dimColor wrap="truncate-end">
          {sanitizeTerminalText(warnings[0])}
        </Text>
      ) : null}
      <Text dimColor>
        {busy
          ? 'Preparing workspace… · Esc cancel'
          : creating
            ? 'Tab language · Enter create · Esc cancel'
            : '↑↓ select · Enter open · Esc cancel'}
      </Text>
    </Box>
  )
}

export const chooseHarness = async (
  options: Omit<PickerProps, 'onSelect'>,
  screen: StartupScreen,
  open: (choice: HarnessChoice, signal: AbortSignal) => Promise<DevWorkspace>
): Promise<DevWorkspace | undefined> => {
  screen.signal.throwIfAborted()
  const operation = new AbortController()
  const signal = AbortSignal.any([screen.signal, operation.signal])
  let complete: (workspace: DevWorkspace | undefined) => void = () => undefined
  let settled = false
  const result = new Promise<DevWorkspace | undefined>((resolve) => {
    complete = resolve
  })
  const cancel = (): void => {
    settled = true
    operation.abort(new Error('Workspace selection cancelled.'))
    complete(undefined)
  }
  screen.signal.addEventListener('abort', cancel, { once: true })
  screen.show(
    createElement(HarnessPicker, {
      ...options,
      onSelect: async (choice): Promise<void> => {
        if (!choice) return cancel()
        const workspace = await open(choice, signal)
        if (!settled && !signal.aborted) {
          settled = true
          complete(workspace)
        }
      },
    }),
    'Select a local harness'
  )
  try {
    return await result
  } finally {
    screen.signal.removeEventListener('abort', cancel)
    screen.show(undefined, 'Preparing workspace…')
  }
}
