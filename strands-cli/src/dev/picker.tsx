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
import { useStartupContentRows } from '../ui/startup.js'
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
  folderFor?: (choice: HarnessChoice) => string | undefined
  newProject?: string
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
const MAX_VISIBLE_ROWS = 7
const SOURCE_DETAIL_HEIGHT = 3

const windowHeight = (rows: readonly PickerRow[], count: number): number =>
  Math.max(
    ...Array.from(
      { length: rows.length - count + 1 },
      (_, start) => count + 2 * new Set(rows.slice(start, start + count).map(({ group }) => group)).size - 1
    )
  )

const visibleCapacity = (rows: readonly PickerRow[], listRows: number): number => {
  const most = Math.min(MAX_VISIBLE_ROWS, rows.length)
  return (
    Array.from({ length: most }, (_, index) => most - index).find((count) => windowHeight(rows, count) <= listRows) ?? 1
  )
}

type FormField = 'name' | 'language'

const otherLanguage = (current: 'typescript' | 'python'): 'typescript' | 'python' =>
  current === 'typescript' ? 'python' : 'typescript'

export const HarnessPicker = ({
  cli,
  harnesses,
  warning,
  folderFor,
  newProject,
  onSelect,
}: PickerProps): ReactElement => {
  const [selection, setSelection] = useState(0)
  const [creating, setCreating] = useState(false)
  const [placing, setPlacing] = useState<HarnessChoice>()
  const [language, setLanguage] = useState<'typescript' | 'python'>('typescript')
  const [field, setField] = useState<FormField>('name')
  const [name, setName] = useState('new-harness')
  const [folder, setFolder] = useState({ value: '', cursor: 0 })
  const [failure, setFailure] = useState<string>()
  const failureCopyHint = useCopyableError(failure)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const folderOf = (choice?: HarnessChoice): string | undefined => (choice ? folderFor?.(choice) : undefined)
  const { accent, error: errorColor, warning: warningColor, selection: selectionColor, border } = useTheme()
  const { columns } = useTerminalSize()
  const availableRows = useStartupContentRows()
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
      detail: newProject
        ? `Creates ${sanitizeTerminalText(newProject)} from your saved profile.`
        : 'Start a separate project from your saved profile.',
      group: 'NEW PROJECT',
      language: '',
    },
  ]
  const submit = (choice: HarnessChoice | undefined, workspace?: string): void => {
    if (pending.current && choice) return
    pending.current = true
    setBusy(choice !== undefined)
    setFailure(undefined)
    void Promise.resolve()
      .then(() => (choice && workspace !== undefined ? onSelect(choice, workspace) : onSelect(choice)))
      .catch((error: unknown) => {
        setFailure(devFailure(error, { operation: 'open' }).message)
      })
      .finally(() => {
        pending.current = false
        setBusy(false)
      })
  }
  const choose = (choice: HarnessChoice): void => {
    const suggested = folderOf(choice)
    if (suggested === undefined) return submit(choice)
    setFailure(undefined)
    setFolder({ value: suggested, cursor: graphemes(suggested).length })
    setPlacing(choice)
  }
  const leaveFolder = (): void => {
    setFailure(undefined)
    setPlacing(undefined)
    setCreating(false)
  }
  const editFolder = (input: string, key: Key): void => {
    if (key.return)
      return folder.value.trim() ? submit(placing, folder.value.trim()) : setFailure('Enter a workspace folder.')
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
  const selected = rows[selection]!
  const globalNotice = 'Manual import applies these changes globally to plain strands.'
  const localNotice = 'Until then, development changes stay in this local workspace.'
  const projectNotice = 'Local project only. Your CLI default stays unchanged.'
  const detailNoteRows = (showsFolder: boolean): number =>
    Number(showsFolder) + (cli ? lineCount(globalNotice) + lineCount(localNotice) : lineCount(projectNotice))
  const step = placing ? 'folder' : creating ? 'name' : 'list'
  const createsInPlace = folderOf({ kind: 'create', name, language }) === undefined
  const next = {
    list: folderOf(selected.choice) === undefined ? 'open' : 'continue',
    name: createsInPlace ? 'create' : 'continue',
    folder: 'open',
  }[step]
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
  const listRows =
    availableRows -
    2 -
    (notice ? lineCount(notice) + 1 : 0) -
    (failure ? lineCount(failure) : 0) -
    1 -
    lineCount(hint) -
    1 -
    SOURCE_DETAIL_HEIGHT
  const capacity = visibleCapacity(rows, listRows)
  const listHeight = windowHeight(rows, capacity)
  const start = Math.min(Math.max(0, selection - capacity + 1), Math.max(0, rows.length - capacity))
  const visible = rows.slice(start, start + capacity)
  const detailNotes =
    capacity === Math.min(MAX_VISIBLE_ROWS, rows.length)
      ? (folderFor ? [true, false] : [false])
          .map((showsFolder) => ({ showsFolder, rows: detailNoteRows(showsFolder) }))
          .find(({ rows: needed }) => needed <= listRows - listHeight)
      : undefined
  const detailHeight = SOURCE_DETAIL_HEIGHT + (detailNotes?.rows ?? 0)
  const selectedFolder = folderOf(selected.choice)
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
          <Text dimColor>strands dev makes a strands-dev folder here for .config, tmp/, reports, and state.</Text>
          <Text dimColor>
            strands dev uses a path that ends in strands-dev, or a workspace of this agent, as it is.
          </Text>
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
          {createsInPlace && newProject ? (
            <Text dimColor wrap="truncate-middle">
              Creates {sanitizeTerminalText(newProject)} with the agent and its strands-dev folder.
            </Text>
          ) : null}
        </Box>
      ) : (
        <>
          <Box flexDirection="column" height={listHeight} flexShrink={0}>
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
          </Box>
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
            {detailNotes && selected.choice ? (
              <>
                {detailNotes.showsFolder && selectedFolder !== undefined ? (
                  <Text dimColor wrap="truncate-middle">
                    Workspace: {sanitizeTerminalText(selectedFolder)}
                  </Text>
                ) : null}
                {selected.choice.kind === 'cli' ? (
                  <>
                    <Text>{globalNotice}</Text>
                    <Text dimColor>{localNotice}</Text>
                  </>
                ) : (
                  <Text dimColor>{projectNotice}</Text>
                )}
              </>
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
