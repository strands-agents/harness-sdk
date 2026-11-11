import { createElement, useRef, useState, type ReactElement } from 'react'
import { Box, useInput, type Key } from 'ink'
import { Text, useTheme } from '../ui/theme.js'
import type { StartupScreen } from '../ui/run.js'
import { emptyEditor, reduceInputSequence } from '../terminal/composer.js'
import { errorMessage, graphemes, sanitizeTerminalText, wrapLines } from '../terminal/text.js'
import { EditableText } from '../ui/text-input.js'
import type { DiscoveredHarness } from './search.js'
import { useTerminalSize } from '../ui/terminal-size.js'
import { useCopyableError } from '../ui/clipboard.js'
import { useStartupContentRows } from '../ui/startup.js'
import { useSpinner } from '../ui/animation.js'
import { userConfigPath } from '../config/store.js'
import { devFailure } from './errors.js'
import { basename, dirname } from 'node:path'
import { WORKSPACE_FOLDER } from './workspace.js'

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
  discovery?: HarnessDiscoveryState
  warning?: string
  folderFor?: (choice: HarnessChoice) => string | undefined
  newProject?: string
  onSelect: (selection: HarnessChoice | undefined, workspace?: string) => void | Promise<void>
}

export type HarnessDiscoveryState = 'running' | 'done' | { failed: string }

interface PickerRow {
  key: string
  selectable?: false
  label: string
  detail: string
  group: string
  language: string
  choice?: HarnessChoice
}

const FOLDER_LABEL = 'Workspace folder: '
const folderNotes = (name: string): readonly string[] => [
  `A ${name} folder will be created in this path for .config, tmp/, reports, and state.`,
  'If this agent already has that folder here, strands dev uses it.',
]
const MAX_VISIBLE_ROWS = 7
const SOURCE_DETAIL_HEIGHT = 3
const SELECTED_AGENT_HEIGHT = 3

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

const CLI_ROW = 'cli'
const CREATE_ROW = 'create'
const DISCOVERY_ROW = 'discovery'
const harnessRow = (harness: DiscoveredHarness): string => `harness:${harness.entrypoint}`

const SearchStatus = ({ count }: { count: number }): ReactElement => {
  const spinner = useSpinner(true, true)
  return (
    <Text dimColor wrap="truncate-end">
      {spinner} Searching for local harnesses…{count ? ` ${count} found` : ''}
    </Text>
  )
}

const DiscoveryStatus = ({
  discovery,
  count,
  warningColor,
}: {
  discovery: HarnessDiscoveryState
  count: number
  warningColor: string
}): ReactElement =>
  discovery === 'running' ? (
    <SearchStatus count={count} />
  ) : discovery === 'done' ? (
    <Text dimColor>No local harnesses found.</Text>
  ) : (
    <Text color={warningColor} wrap="truncate-end">
      Search stopped: {sanitizeTerminalText(discovery.failed)}
    </Text>
  )

export const HarnessPicker = ({
  cli,
  harnesses,
  discovery,
  warning,
  folderFor,
  newProject,
  onSelect,
}: PickerProps): ReactElement => {
  const [selectedRow, setSelectedRow] = useState(() =>
    cli ? CLI_ROW : harnesses[0] ? harnessRow(harnesses[0]) : CREATE_ROW
  )
  const [creating, setCreating] = useState(false)
  const [placing, setPlacing] = useState<HarnessChoice>()
  const [language, setLanguage] = useState<'typescript' | 'python'>('typescript')
  const [field, setField] = useState<FormField>('name')
  const [name, setName] = useState('new-harness')
  const [folder, setFolder] = useState({ value: '', cursor: 0, suggested: '' })
  const [failure, setFailure] = useState<string>()
  const failureCopyHint = useCopyableError(failure)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const folderOf = (choice?: HarnessChoice): string | undefined => (choice ? folderFor?.(choice) : undefined)
  const { accent, success, error: errorColor, warning: warningColor, selection: selectionColor, border } = useTheme()
  const { columns } = useTerminalSize()
  const availableRows = useStartupContentRows()
  const discoveredGroup = `DISCOVERED PROJECTS${harnesses.length ? ` (${harnesses.length})` : ''}`
  const discoveryNote = discovery !== undefined && (discovery !== 'done' || harnesses.length === 0)
  const rows: PickerRow[] = [
    ...(cli
      ? [
          {
            key: CLI_ROW,
            label: `Base CLI · ${sanitizeTerminalText(cli.name)}`,
            detail: sanitizeTerminalText(cli.path ?? userConfigPath()),
            group: 'CLI DEFAULT',
            language: '',
            choice: { kind: 'cli' } as const,
          },
        ]
      : []),
    ...harnesses.map((harness) => ({
      key: harnessRow(harness),
      label: sanitizeTerminalText(harness.name),
      detail: sanitizeTerminalText(harness.entrypoint),
      group: discoveredGroup,
      language: [harness.language, harness.preparationStatus].filter(Boolean).join(' · '),
      choice: { kind: 'discovered', harness } as const,
    })),
    ...(discoveryNote
      ? [
          {
            key: DISCOVERY_ROW,
            selectable: false as const,
            label: '',
            detail: '',
            group: discoveredGroup,
            language: '',
          },
        ]
      : []),
    {
      key: CREATE_ROW,
      label: 'Create a new harness',
      detail: newProject
        ? `Creates ${sanitizeTerminalText(newProject)} from your saved profile.`
        : 'Start a separate project from your saved profile.',
      group: 'NEW PROJECT',
      language: '',
    },
  ]
  const selection = Math.max(
    0,
    rows.findIndex(({ key }) => key === selectedRow)
  )
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
    const place = dirname(suggested)
    setFolder({ value: place, cursor: graphemes(place).length, suggested })
    setPlacing(choice)
  }
  const leaveFolder = (): void => {
    setFailure(undefined)
    setPlacing(undefined)
    setCreating(false)
  }
  const editFolder = (input: string, key: Key): void => {
    if (key.return)
      return folder.value.trim() ? submit(placing, chosenFolder()) : setFailure('Enter a workspace folder.')
    if (key.tab || (key.ctrl && input === 'j')) return
    setFolder((current) => {
      const { state } = reduceInputSequence(
        { ...emptyEditor(), input: current.value, cursor: current.cursor },
        input.replace(/[\r\n]/g, ''),
        key,
        'idle'
      )
      return { ...current, value: state.input, cursor: state.cursor }
    })
  }
  const unchangedFolder = (): boolean => folder.value.trim() === dirname(folder.suggested)
  const chosenFolder = (): string => (unchangedFolder() ? folder.suggested : folder.value.trim())
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
  const choices = rows.filter(({ selectable }) => selectable !== false)
  const moveSelection = (step: number): void =>
    setSelectedRow((current) => {
      const index = Math.max(
        0,
        choices.findIndex(({ key }) => key === current)
      )
      return choices[(index + step + choices.length) % choices.length]!.key
    })
  const browse = (key: Key): void => {
    if (key.upArrow) moveSelection(-1)
    if (key.downArrow) moveSelection(1)
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
      context: `${choices.indexOf(rows[selection]!) + 1} / ${choices.length}`,
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
  const notes = folderNotes(unchangedFolder() ? basename(folder.suggested) : WORKSPACE_FOLDER)
  const folderHeight =
    2 +
    (notice ? lineCount(notice) + 1 : 0) +
    1 +
    notes.reduce((total, note) => total + 1 + lineCount(note), 0) +
    (failure ? lineCount(failure) : 0) +
    1 +
    lineCount(hint)
  const selectedAgent =
    placing && placing.kind !== 'create' && availableRows - folderHeight >= SELECTED_AGENT_HEIGHT
      ? selected.detail
      : undefined
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
      {selectedAgent ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={success}>
            Selected a project
          </Text>
          <Text bold wrap="truncate-middle">
            Harness path: {selectedAgent}
          </Text>
        </Box>
      ) : null}
      <Box marginBottom={1} justifyContent="space-between">
        <Text bold color={step === 'folder' ? success : accent}>
          {heading}
        </Text>
        <Text {...(step === 'folder' ? { color: success } : { dimColor: true })}>{context}</Text>
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
          {notes.map((note) => (
            <Text key={note} dimColor>
              {note}
            </Text>
          ))}
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
                {row.key === DISCOVERY_ROW && discovery !== undefined ? (
                  <Box paddingX={1} paddingLeft={3}>
                    <DiscoveryStatus discovery={discovery} count={harnesses.length} warningColor={warningColor} />
                  </Box>
                ) : (
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
                )}
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

export type HarnessSource = (
  found: (harness: DiscoveredHarness) => void,
  signal: AbortSignal
) => Promise<readonly DiscoveredHarness[]>

const SEARCH_FLUSH_MS = 100

export const chooseHarness = async <Opened,>(
  { search, ...options }: Omit<PickerProps, 'onSelect' | 'discovery'> & { search?: HarnessSource },
  screen: StartupScreen,
  open: (choice: HarnessChoice, signal: AbortSignal, workspace?: string) => Promise<Opened>
): Promise<Opened | undefined> => {
  screen.signal.throwIfAborted()
  const operation = new AbortController()
  const signal = AbortSignal.any([screen.signal, operation.signal])
  const searchAbort = new AbortController()
  let complete: (opened: Opened | undefined) => void = () => undefined
  let settled = false
  let opening = false
  let harnesses = options.harnesses
  let discovery: HarnessDiscoveryState | undefined = search ? 'running' : undefined
  const result = new Promise<Opened | undefined>((resolve) => {
    complete = resolve
  })
  const cancel = (): void => {
    settled = true
    operation.abort(new Error('Workspace selection cancelled.'))
    complete(undefined)
  }
  const onSelect = async (choice: HarnessChoice | undefined, workspace?: string): Promise<void> => {
    if (!choice) return cancel()
    let opened: Opened
    opening = true
    try {
      opened = await open(choice, signal, workspace)
    } catch (error) {
      opening = false
      throw devFailure(error, {
        operation: 'open',
        path: choice.kind === 'discovered' ? choice.harness.entrypoint : (workspace ?? options.cli?.path),
      })
    }
    if (!settled && !signal.aborted) {
      settled = true
      complete(opened)
    }
  }
  const show = (): void => {
    if (settled || opening) return
    screen.show(
      createElement(HarnessPicker, {
        ...options,
        harnesses,
        ...(discovery === undefined ? {} : { discovery }),
        onSelect,
      }),
      'Select a local harness'
    )
  }
  screen.signal.addEventListener('abort', cancel, { once: true })
  show()
  let flush: ReturnType<typeof setTimeout> | undefined
  if (search) {
    const add = (harness: DiscoveredHarness): void => {
      const index = harnesses.findIndex(({ entrypoint }) => entrypoint === harness.entrypoint)
      harnesses = index < 0 ? [...harnesses, harness] : harnesses.map((known, at) => (at === index ? harness : known))
    }
    void search(
      (harness) => {
        add(harness)
        flush ??= setTimeout(() => {
          flush = undefined
          show()
        }, SEARCH_FLUSH_MS)
      },
      AbortSignal.any([signal, searchAbort.signal])
    )
      .then((found) => {
        found.forEach(add)
        discovery = 'done'
      })
      .catch((error: unknown) => {
        discovery = signal.aborted || searchAbort.signal.aborted ? 'done' : { failed: errorMessage(error) }
      })
      .finally(() => {
        clearTimeout(flush)
        flush = undefined
        show()
      })
  }
  try {
    return await result
  } finally {
    searchAbort.abort(new Error('Harness selection closed.'))
    clearTimeout(flush)
    screen.signal.removeEventListener('abort', cancel)
    screen.show(undefined, 'Preparing workspace…')
  }
}
