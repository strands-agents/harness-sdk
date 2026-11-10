import { createElement, useRef, useState, type ReactElement } from 'react'
import { Box, useInput } from 'ink'
import { Text, useTheme } from '../ui/theme.js'
import type { StartupScreen } from '../ui/run.js'
import { sanitizeTerminalText, wrapLines } from '../terminal/text.js'
import type { DiscoveredHarness } from './search.js'
import { useTerminalSize } from '../ui/terminal-size.js'
import { userConfigPath } from '../config/store.js'
import { devFailure } from './errors.js'

export type HarnessChoice =
  | { kind: 'cli' }
  | { kind: 'discovered'; harness: DiscoveredHarness }
  | { kind: 'create'; language: 'typescript' | 'python'; name: string }

export interface BaseCliOption {
  name: string
  path?: string
  workspace?: string
}

interface PickerProps {
  cli?: BaseCliOption
  harnesses: readonly DiscoveredHarness[]
  warning?: string
  onSelect: (selection: HarnessChoice | undefined) => void | Promise<void>
}

interface PickerRow {
  label: string
  detail: string
  group: string
  language: string
  choice?: HarnessChoice
}

export const HarnessPicker = ({ cli, harnesses, warning, onSelect }: PickerProps): ReactElement => {
  const [selection, setSelection] = useState(0)
  const [creating, setCreating] = useState(false)
  const [language, setLanguage] = useState<'typescript' | 'python'>('typescript')
  const [name, setName] = useState('new-harness')
  const [failure, setFailure] = useState<string>()
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const { accent, error: errorColor, warning: warningColor, selection: selectionColor, border } = useTheme()
  const { rows: height, columns } = useTerminalSize()
  const rows: PickerRow[] = [
    ...(cli
      ? [
          {
            label: `Base CLI · ${sanitizeTerminalText(cli.name)}`,
            detail: sanitizeTerminalText(cli.path ?? userConfigPath()),
            group: 'CLI DEFAULT',
            language: '',
            choice: { kind: 'cli' } as const,
          },
        ]
      : []),
    ...harnesses.map((harness) => ({
      label: sanitizeTerminalText(harness.name),
      detail: sanitizeTerminalText(harness.entrypoint),
      group: `LOCAL PROJECTS (${harnesses.length})`,
      language: [harness.language, harness.preparationStatus].filter(Boolean).join(' · '),
      choice: { kind: 'discovered', harness } as const,
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
    const choice = rows[selection]?.choice
    if (choice) return submit(choice)
    setCreating(true)
  })
  const detailWidth = Math.max(1, columns - 12)
  const lineCount = (text: string): number => wrapLines(text, detailWidth).length
  const notice = warning ? sanitizeTerminalText(warning) : undefined
  const capacity = Math.max(1, Math.min(7, height - 26 - (notice ? lineCount(notice) + 1 : 0)))
  const start = Math.min(Math.max(0, selection - capacity + 1), Math.max(0, rows.length - capacity))
  const visible = rows.slice(start, start + capacity)
  const selected = rows[selection]!
  const globalNotice = 'Manual import applies these changes globally to plain strands.'
  const localNotice = 'Until then, development changes stay in this local workspace.'
  const projectNotice = 'Local project only. Your CLI default stays unchanged.'
  const detailHeight =
    3 +
    (cli
      ? Number(Boolean(cli.workspace && height >= 30)) + lineCount(globalNotice) + lineCount(localNotice)
      : lineCount(projectNotice))
  return (
    <Box flexDirection="column">
      <Box marginBottom={1} justifyContent="space-between">
        <Text bold color={accent}>
          {creating ? 'Create a harness' : 'Select a harness'}
        </Text>
        <Text dimColor>{creating ? 'New project' : `${selection + 1} / ${rows.length}`}</Text>
      </Box>
      {notice ? (
        <Box marginBottom={1}>
          <Text color={warningColor}>{notice}</Text>
        </Box>
      ) : null}
      {creating ? (
        <Box flexDirection="column" gap={1}>
          <Text>Name: {name}▏</Text>
          <Text>Language: {language}</Text>
          <Text dimColor>A new local project. Your CLI default stays unchanged.</Text>
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
              {selected.choice ? `Source: ${selected.detail}` : selected.detail}
            </Text>
            {selected.choice?.kind === 'cli' ? (
              <>
                {cli?.workspace && height >= 30 ? (
                  <Text dimColor wrap="truncate-middle">
                    Workspace: {sanitizeTerminalText(cli.workspace)}
                  </Text>
                ) : null}
                <Text>{globalNotice}</Text>
                <Text dimColor>{localNotice}</Text>
              </>
            ) : selected.choice ? (
              <Text dimColor>{projectNotice}</Text>
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

export const chooseHarness = async <Opened,>(
  options: Omit<PickerProps, 'onSelect'>,
  screen: StartupScreen,
  open: (choice: HarnessChoice, signal: AbortSignal) => Promise<Opened>
): Promise<Opened | undefined> => {
  screen.signal.throwIfAborted()
  const operation = new AbortController()
  const signal = AbortSignal.any([screen.signal, operation.signal])
  let complete: (opened: Opened | undefined) => void = () => undefined
  let settled = false
  const result = new Promise<Opened | undefined>((resolve) => {
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
        let opened: Opened
        try {
          opened = await open(choice, signal)
        } catch (error) {
          throw devFailure(error, {
            operation: 'open',
            path:
              choice.kind === 'discovered' ? choice.harness.entrypoint : (options.cli?.workspace ?? options.cli?.path),
          })
        }
        if (!settled && !signal.aborted) {
          settled = true
          complete(opened)
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
