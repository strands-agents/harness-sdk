import { createElement, useRef, useState, type ReactElement } from 'react'
import { Box, useInput, type Key } from 'ink'
import { Text, useTheme } from '../ui/theme.js'
import type { StartupScreen } from '../ui/run.js'
import { emptyEditor, reduceInputSequence } from '../terminal/composer.js'
import { graphemes, sanitizeTerminalText, wrapLines } from '../terminal/text.js'
import { EditableText } from '../ui/text-input.js'
import type { DiscoveredHarness } from './search.js'
import { useTerminalSize } from '../ui/terminal-size.js'
import { useCopyableError } from '../ui/clipboard.js'
import { userConfigPath } from '../config/store.js'
import { devFailure } from './errors.js'

export type HarnessChoice =
  | { kind: 'cli' }
  | { kind: 'discovered'; harness: DiscoveredHarness }
  | { kind: 'create'; language: 'typescript' | 'python'; name: string }

export interface BaseCliOption {
  name: string
  path?: string
}

interface PickerProps {
  cli?: BaseCliOption
  harnesses: readonly DiscoveredHarness[]
  warning?: string
  workspace?: string
  onSelect: (selection: HarnessChoice | undefined, workspace?: string) => void | Promise<void>
}

interface PickerRow {
  label: string
  detail: string
  group: string
  language: string
  choice?: HarnessChoice
}

const FOLDER_LABEL = 'Workspace folder: '

type FormField = 'name' | 'language'

const otherLanguage = (current: 'typescript' | 'python'): 'typescript' | 'python' =>
  current === 'typescript' ? 'python' : 'typescript'

export const HarnessPicker = ({ cli, harnesses, warning, workspace, onSelect }: PickerProps): ReactElement => {
  const [selection, setSelection] = useState(0)
  const [creating, setCreating] = useState(false)
  const [placing, setPlacing] = useState<HarnessChoice>()
  const [language, setLanguage] = useState<'typescript' | 'python'>('typescript')
  const [field, setField] = useState<FormField>('name')
  const [name, setName] = useState('new-harness')
  const [folder, setFolder] = useState(() => ({ value: workspace ?? '', cursor: graphemes(workspace ?? '').length }))
  const [failure, setFailure] = useState<string>()
  const failureCopyHint = useCopyableError(failure)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const asksFolder = workspace !== undefined
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
      .then(() => (choice && asksFolder ? onSelect(choice, folder.value.trim()) : onSelect(choice)))
      .catch((error: unknown) => {
        setFailure(devFailure(error, { operation: 'open' }).message)
      })
      .finally(() => {
        pending.current = false
        setBusy(false)
      })
  }
  const choose = (choice: HarnessChoice): void => {
    if (!asksFolder) return submit(choice)
    setFailure(undefined)
    setPlacing(choice)
  }
  const leaveFolder = (): void => {
    setFailure(undefined)
    setPlacing(undefined)
    setCreating(false)
  }
  const editFolder = (input: string, key: Key): void => {
    if (key.return) return folder.value.trim() ? submit(placing) : setFailure('Enter a workspace folder.')
    if (key.tab || (key.ctrl && input === 'j')) return
    setFolder((current) => {
      const { state } = reduceInputSequence(
        { ...emptyEditor(), input: current.value, cursor: current.cursor },
        input.replace(/[\r\n]/g, ''),
        key,
        'idle'
      )
      return { value: state.input, cursor: state.cursor }
    })
  }
  const editForm = (input: string, key: Key): void => {
    if (key.tab) return setLanguage(otherLanguage)
    if (key.return && name && name !== '.' && name !== '..') return choose({ kind: 'create', name, language })
    if (key.upArrow || key.downArrow) return setField(key.downArrow ? 'language' : 'name')
    if (field === 'language') {
      if (key.leftArrow || key.rightArrow) setLanguage(otherLanguage)
      return
    }
    if (key.backspace || key.delete) return setName((current) => current.slice(0, -1))
    if (!key.ctrl && !key.meta && /^[a-zA-Z0-9._-]+$/.test(input))
      setName((current) => `${current}${input}`.slice(0, 64))
  }
  const browse = (key: Key): void => {
    if (key.upArrow) setSelection((current) => (current + rows.length - 1) % rows.length)
    if (key.downArrow) setSelection((current) => (current + 1) % rows.length)
    if (!key.return) return
    const choice = rows[selection]?.choice
    if (choice) return choose(choice)
    setField('name')
    setCreating(true)
  }
  useInput((input, key) => {
    if (key.ctrl && input === 'c') return submit(undefined)
    if (key.escape) return placing && !pending.current ? leaveFolder() : submit(undefined)
    if (pending.current) return
    if (placing) return editFolder(input, key)
    if (creating) return editForm(input, key)
    browse(key)
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
  const showsFolder = asksFolder && height >= 30
  const detailHeight =
    3 + (cli ? Number(showsFolder) + lineCount(globalNotice) + lineCount(localNotice) : lineCount(projectNotice))
  const step = placing ? 'folder' : creating ? 'name' : 'list'
  const next = asksFolder ? 'continue' : { list: 'open', name: 'create', folder: 'open' }[step]
  const screens = {
    list: {
      heading: 'Select a harness',
      context: `${selection + 1} / ${rows.length}`,
      hint: `↑↓ select · Enter ${next}`,
    },
    name: {
      heading: 'Create a harness',
      context: 'New project',
      hint: `↑↓ field · ←→ or Tab language · Enter ${next}`,
    },
    folder: {
      heading: 'Choose a workspace folder',
      context: placing?.kind === 'create' ? `New project · ${placing.name}` : selected.label,
      hint: 'Enter continue',
    },
  }
  const { heading, context } = screens[step]
  const hint = busy
    ? 'Preparing workspace… · Esc cancel'
    : [screens[step].hint, failureCopyHint, `Esc ${step === 'folder' ? 'back' : 'cancel'}`].filter(Boolean).join(' · ')
  return (
    <Box flexDirection="column">
      <Box marginBottom={1} justifyContent="space-between">
        <Text bold color={accent}>
          {heading}
        </Text>
        <Text dimColor>{context}</Text>
      </Box>
      {notice ? (
        <Box marginBottom={1}>
          <Text color={warningColor}>{notice}</Text>
        </Box>
      ) : null}
      {placing ? (
        <Box flexDirection="column" gap={1}>
          <Box>
            <Text>{FOLDER_LABEL}</Text>
            <EditableText
              value={folder.value}
              cursor={folder.cursor}
              width={Math.max(1, detailWidth - FOLDER_LABEL.length)}
              active={!busy}
            />
          </Box>
          <Text dimColor>strands dev keeps .config, tmp/, reports, and state in this folder.</Text>
          <Text dimColor>Use a new or empty folder, or the existing workspace of this agent.</Text>
        </Box>
      ) : creating ? (
        <Box flexDirection="column" gap={1}>
          <Text {...(field === 'name' ? { color: accent, bold: true } : {})}>
            {field === 'name' ? '›' : ' '} Name: {name}
            {field === 'name' ? '▏' : ''}
          </Text>
          <Text {...(field === 'language' ? { color: accent, bold: true } : {})}>
            {field === 'language' ? '›' : ' '} Language: {language}
          </Text>
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
                {showsFolder ? (
                  <Text dimColor wrap="truncate-middle">
                    Workspace: {sanitizeTerminalText(folder.value)}
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
        <Text dimColor>{hint}</Text>
      </Box>
    </Box>
  )
}

export const chooseHarness = async <Opened,>(
  options: Omit<PickerProps, 'onSelect'>,
  screen: StartupScreen,
  open: (choice: HarnessChoice, signal: AbortSignal, workspace?: string) => Promise<Opened>
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
      onSelect: async (choice, workspace): Promise<void> => {
        if (!choice) return cancel()
        let opened: Opened
        try {
          opened = await open(choice, signal, workspace)
        } catch (error) {
          throw devFailure(error, {
            operation: 'open',
            path: choice.kind === 'discovered' ? choice.harness.entrypoint : (workspace ?? options.cli?.path),
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
