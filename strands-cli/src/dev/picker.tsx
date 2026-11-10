import { createElement, useRef, useState, type ReactElement } from 'react'
import { Box, useInput } from 'ink'
import { Text, useTheme } from '../ui/theme.js'
import type { StartupScreen } from '../ui/run.js'
import { sanitizeTerminalText, wrapLines } from '../terminal/text.js'
import type { DiscoveredHarness } from './search.js'
import type { DevWorkspace } from './workspace.js'
import { useTerminalSize } from '../ui/terminal-size.js'
import { userConfigPath } from '../config/store.js'
import { devFailure } from './errors.js'

export type HarnessChoice =
  | { kind: 'cli' }
  | { kind: 'discovered'; harness: DiscoveredHarness }
  | { kind: 'create'; language: 'typescript' | 'python'; name: string }

interface PickerProps {
  cliName: string
  cliPath?: string
  cliWorkspace?: string
  harnesses: readonly DiscoveredHarness[]
  onSelect: (selection: HarnessChoice | undefined) => void | Promise<void>
}

export const HarnessPicker = ({
  cliName,
  cliPath = userConfigPath(),
  cliWorkspace,
  harnesses,
  onSelect,
}: PickerProps): ReactElement => {
  const [selection, setSelection] = useState(0)
  const [creating, setCreating] = useState(false)
  const [language, setLanguage] = useState<'typescript' | 'python'>('typescript')
  const [name, setName] = useState('new-harness')
  const [failure, setFailure] = useState<string>()
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const { accent, error: errorColor, selection: selectionColor, border } = useTheme()
  const { rows: height, columns } = useTerminalSize()
  const rows = [
    {
      label: `Base CLI · ${sanitizeTerminalText(cliName)}`,
      detail: sanitizeTerminalText(cliPath),
      group: 'CLI DEFAULT',
      language: '',
    },
    ...harnesses.map((harness) => ({
      label: sanitizeTerminalText(harness.name),
      detail: sanitizeTerminalText(harness.entrypoint),
      group: `LOCAL PROJECTS (${harnesses.length})`,
      language: [harness.language, harness.preparationStatus].filter(Boolean).join(' · '),
    })),
    {
      label: 'Create a new harness',
      detail: 'Start a separate project from your saved profile.',
      group: 'NEW PROJECT',
      language: '',
    },
  ]
  const submit = (choice: HarnessChoice | undefined): void => {
    if (pending.current && choice) return
    pending.current = true
    setBusy(choice !== undefined)
    setFailure(undefined)
    void Promise.resolve()
      .then(() => onSelect(choice))
      .catch((error: unknown) => {
        setFailure(devFailure(error, { operation: 'open' }).message)
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
  const capacity = Math.max(1, Math.min(7, height - 26))
  const start = Math.min(Math.max(0, selection - capacity + 1), Math.max(0, rows.length - capacity))
  const visible = rows.slice(start, start + capacity)
  const selected = rows[selection]!
  const detailWidth = Math.max(1, columns - 12)
  const globalNotice = 'Manual import applies these changes globally to plain strands.'
  const localNotice = 'Until then, development changes stay in this local workspace.'
  const detailHeight =
    3 +
    Number(Boolean(cliWorkspace && height >= 30)) +
    wrapLines(globalNotice, detailWidth).length +
    wrapLines(localNotice, detailWidth).length
  return (
    <Box flexDirection="column">
      <Box marginBottom={1} justifyContent="space-between">
        <Text bold color={accent}>
          {creating ? 'Create a harness' : 'Select a harness'}
        </Text>
        <Text dimColor>{creating ? 'New project' : `${selection + 1} / ${rows.length}`}</Text>
      </Box>
      {creating ? (
        <Box flexDirection="column" gap={1}>
          <Text>Name: {name}▏</Text>
          <Text>Language: {language}</Text>
          <Text dimColor>A separate local workspace. Your CLI default stays unchanged.</Text>
        </Box>
      ) : (
        <>
          {visible.map((row, index) => (
            <Box key={start + index} flexDirection="column">
              {index === 0 || visible[index - 1]?.group !== row.group ? (
                <Box marginTop={index === 0 ? 0 : 1}>
                  <Text dimColor>{row.group}</Text>
                </Box>
              ) : null}
              <Box
                paddingX={1}
                justifyContent="space-between"
                {...(start + index === selection ? { backgroundColor: selectionColor } : {})}
              >
                <Text
                  bold={start + index === selection}
                  {...(start + index === selection ? { color: accent } : {})}
                  wrap="truncate-end"
                >
                  {start + index === selection ? '›' : ' '} {row.label}
                </Text>
                {row.language ? <Text dimColor> {row.language}</Text> : null}
              </Box>
            </Box>
          ))}
          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor={border}
            borderLeft={false}
            borderRight={false}
            borderBottom={false}
            marginTop={1}
            paddingTop={1}
            height={detailHeight}
            flexShrink={0}
          >
            <Text dimColor wrap="truncate-middle">
              {selection === rows.length - 1 ? selected.detail : `Source: ${selected.detail}`}
            </Text>
            {selection === 0 ? (
              <>
                {cliWorkspace && height >= 30 ? (
                  <Text dimColor wrap="truncate-middle">
                    Workspace: {sanitizeTerminalText(cliWorkspace)}
                  </Text>
                ) : null}
                <Text>{globalNotice}</Text>
                <Text dimColor>{localNotice}</Text>
              </>
            ) : selection < rows.length - 1 ? (
              <Text dimColor>Local project only. Your CLI default stays unchanged.</Text>
            ) : null}
          </Box>
        </>
      )}
      {failure ? <Text color={errorColor}>{failure}</Text> : null}
      <Box marginTop={1}>
        <Text dimColor>
          {busy
            ? 'Preparing workspace… · Esc cancel'
            : creating
              ? 'Tab language · Enter create · Esc cancel'
              : '↑↓ select · Enter open · Esc cancel'}
        </Text>
      </Box>
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
        let workspace: DevWorkspace
        try {
          workspace = await open(choice, signal)
        } catch (error) {
          throw devFailure(error, {
            operation: 'open',
            path: choice.kind === 'discovered' ? choice.harness.entrypoint : (options.cliWorkspace ?? options.cliPath),
          })
        }
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
