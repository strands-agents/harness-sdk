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
import { devFailure, WorkspaceFolderInUse } from './errors.js'
import { WorkspaceReplacementConfirmation } from './settings.js'
import { basename, dirname } from 'node:path'
import { isWorkspaceFolderName, WORKSPACE_FOLDER } from './workspace.js'

export type HarnessChoice =
  | { kind: 'cli' }
  | { kind: 'discovered'; harness: DiscoveredHarness }
  | { kind: 'create'; language: 'typescript' | 'python'; name: string }

export interface FolderSuggestion {
  path: string
  detected: boolean
  occupiedBy?: string
  open?: true
}

export interface BaseCliOption {
  name: string
  path?: string
}

interface PickerProps {
  cli?: BaseCliOption
  harnesses: readonly DiscoveredHarness[]
  discovery?: HarnessDiscoveryState
  warning?: string
  folderFor?: (choice: HarnessChoice) => FolderSuggestion | undefined
  newProject?: string
  modelNotice?: (language: 'typescript' | 'python') => string | undefined
  onSelect: (selection: HarnessChoice | undefined, workspace?: string, replace?: boolean) => void | Promise<void>
}

interface Replacement {
  choice: HarnessChoice
  workspace?: string
  folder: string
  holder: string
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
const DEFAULT_NAME = 'new-harness'
const NAME_LIMIT = 64
const NAME_CHARACTERS = /^[a-zA-Z0-9._-]*$/u
const isNameDraft = (value: string): boolean => value.length <= NAME_LIMIT && NAME_CHARACTERS.test(value)
const prefilledFolder = ({ path }: FolderSuggestion): string => dirname(path)
const opensAtOnce = (
  suggested: FolderSuggestion | undefined
): suggested is undefined | (FolderSuggestion & { detected: true }) => suggested === undefined || suggested.detected
const createdNote = (name: string, place: 'in' | 'at'): string =>
  `A ${name} folder will be created ${place} this path for .config, tmp/, reports, and state.`
const folderNote = (typed: string, suggested: FolderSuggestion): string => {
  if (typed === prefilledFolder(suggested) && suggested.open)
    return `${basename(suggested.path)} in this path is the open workspace. Choose another folder, or restart strands dev to replace it.`
  if (typed === prefilledFolder(suggested) && suggested.occupiedBy)
    return `${basename(suggested.path)} in this path holds the workspace of ${sanitizeTerminalText(suggested.occupiedBy)}. Enter asks you to confirm before it is replaced.`
  if (typed === prefilledFolder(suggested)) return createdNote(basename(suggested.path), 'in')
  const name = basename(typed)
  return isWorkspaceFolderName(name) ? createdNote(name, 'at') : createdNote(WORKSPACE_FOLDER, 'in')
}
const choiceLabel = (choice: HarnessChoice, cli?: BaseCliOption): string =>
  choice.kind === 'cli'
    ? `Base CLI · ${cli?.name ?? 'saved profile'}`
    : choice.kind === 'discovered'
      ? `${choice.harness.name} (${choice.harness.entrypoint})`
      : `New ${choice.language} harness ${choice.name}`
const MAX_VISIBLE_ROWS = 7
const SELECTED_AGENT_HEIGHT = 3

// The three sections stay visible; only the discovered harnesses scroll.
const pickerWindow = (
  rows: readonly PickerRow[],
  shownProject: string | undefined,
  listRows: number
): {
  visible: PickerRow[]
  height: number
  chromeSavings: number
  sectionGap: number
  projectRange: string | undefined
} => {
  const projects = rows.filter((row) => row.choice?.kind === 'discovered')
  const pinned = rows.length - projects.length
  const groups = new Set(rows.map(({ group }) => group)).size
  const minimum = pinned + Math.min(1, projects.length) + 2 * groups - 1
  // Reclaim decorative gaps before sacrificing space between the sections.
  const chromeSavings = Math.min(3, Math.max(0, minimum - listRows))
  const budget = listRows + chromeSavings
  const sectionGap = minimum <= budget ? 1 : 0
  const overhead = groups + sectionGap * (groups - 1)
  const capacity = Math.min(
    projects.length,
    Math.max(1, MAX_VISIBLE_ROWS - pinned),
    Math.max(1, budget - pinned - overhead)
  )
  const projectSelection = Math.max(
    0,
    projects.findIndex(({ key }) => key === shownProject)
  )
  const start = Math.min(Math.max(0, projectSelection - capacity + 1), Math.max(0, projects.length - capacity))
  const visibleProjects = projects.slice(start, start + capacity)
  const visible = rows.filter((row) => row.choice?.kind !== 'discovered' || visibleProjects.includes(row))
  return {
    visible,
    chromeSavings,
    sectionGap,
    height: visible.length + overhead,
    projectRange: projects.length > capacity ? `${start + 1}–${start + capacity} of ${projects.length}` : undefined,
  }
}

const harnessHint = (range: string | undefined, count: number): string =>
  range ? ` · ${range} · ←→ scroll` : count > 1 ? ' · ←→ choose' : ''

interface Browsing {
  readonly selected: string
  readonly viewed?: string
}

type FormField = 'name' | 'language'

const otherLanguage = (current: 'typescript' | 'python'): 'typescript' | 'python' =>
  current === 'typescript' ? 'python' : 'typescript'

const CLI_ROW = 'cli'
const CREATE_ROW = 'create'
const DISCOVERY_ROW = 'discovery'
const DISCOVERED_SECTION = 'discovered'
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
  modelNotice,
  onSelect,
}: PickerProps): ReactElement => {
  const [browsing, setBrowsing] = useState<Browsing>(() => ({
    selected: cli ? CLI_ROW : harnesses[0] ? harnessRow(harnesses[0]) : CREATE_ROW,
  }))
  const selectedRow = browsing.selected
  const [creating, setCreating] = useState(false)
  const [placing, setPlacing] = useState<HarnessChoice>()
  const [language, setLanguage] = useState<'typescript' | 'python'>('typescript')
  const [field, setField] = useState<FormField>('name')
  const [nameField, setNameField] = useState({ value: DEFAULT_NAME, cursor: DEFAULT_NAME.length })
  const name = nameField.value
  const [folder, setFolder] = useState({ value: '', cursor: 0, suggested: { path: '', detected: false } })
  const [failure, setFailure] = useState<string>()
  const [replacing, setReplacing] = useState<Replacement>()
  const failureCopyHint = useCopyableError(failure)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const folderOf = (choice?: HarnessChoice): FolderSuggestion | undefined => (choice ? folderFor?.(choice) : undefined)
  const { accent, success, error: errorColor, warning: warningColor, selection: selectionColor } = useTheme()
  const { columns } = useTerminalSize()
  const availableRows = useStartupContentRows()
  const discoveredGroup = `Discovered Harnesses${harnesses.length ? ` (${harnesses.length})` : ''}`
  const discoveryNote = harnesses.length === 0 || (discovery !== undefined && discovery !== 'done')
  const rows: PickerRow[] = [
    ...(cli
      ? [
          {
            key: CLI_ROW,
            label: `Base CLI · ${sanitizeTerminalText(cli.name)}`,
            detail: sanitizeTerminalText(cli.path ?? userConfigPath()),
            group: 'Global Harness',
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
      group: 'New Harness',
      language: '',
    },
  ]
  const selection = Math.max(
    0,
    rows.findIndex(({ key }) => key === selectedRow)
  )
  const select = (choice: HarnessChoice | undefined, workspace?: string, replace = false): void | Promise<void> => {
    if (choice && replace) return onSelect(choice, workspace, true)
    return choice && workspace !== undefined ? onSelect(choice, workspace) : onSelect(choice)
  }
  const submit = (choice: HarnessChoice | undefined, workspace?: string, replace = false): void => {
    if (pending.current && choice) return
    pending.current = true
    setBusy(choice !== undefined)
    setFailure(undefined)
    void Promise.resolve()
      .then(() => select(choice, workspace, replace))
      .catch((error: unknown) => {
        if (error instanceof WorkspaceFolderInUse && choice && !replace)
          return setReplacing({
            choice,
            ...(workspace !== undefined ? { workspace } : {}),
            folder: error.folder,
            holder: error.holder,
          })
        setFailure(devFailure(error, { operation: 'open' }).message)
      })
      .finally(() => {
        pending.current = false
        setBusy(false)
      })
  }
  const choose = (choice: HarnessChoice): void => {
    const suggested = folderOf(choice)
    if (opensAtOnce(suggested)) return submit(choice, suggested?.path)
    setFailure(undefined)
    const value = prefilledFolder(suggested)
    setFolder({ value, cursor: graphemes(value).length, suggested })
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
  const chosenFolder = (): string =>
    folder.value.trim() === prefilledFolder(folder.suggested) ? folder.suggested.path : folder.value.trim()
  const editForm = (input: string, key: Key): void => {
    if (key.tab) return setLanguage(otherLanguage)
    if (key.return)
      return name && name !== '.' && name !== '..' ? choose({ kind: 'create', name, language }) : undefined
    if (key.upArrow || key.downArrow) return setField(key.downArrow ? 'language' : 'name')
    if (field === 'language') {
      if (key.leftArrow || key.rightArrow) setLanguage(otherLanguage)
      return
    }
    setNameField((current) => {
      const { state } = reduceInputSequence(
        { ...emptyEditor(), input: current.value, cursor: current.cursor },
        input,
        key,
        'idle'
      )
      return isNameDraft(state.input) ? { value: state.input, cursor: state.cursor } : current
    })
  }
  const harnessRows = harnesses.map(harnessRow)
  const viewedOf = ({ selected, viewed }: Browsing): string | undefined =>
    harnessRows.includes(selected) ? selected : (harnessRows.find((key) => key === viewed) ?? harnessRows[0])
  const shownHarness = viewedOf(browsing)
  const sectionOf = (key: string): string => (harnessRows.includes(key) ? DISCOVERED_SECTION : key)
  const choices = rows.filter(({ selectable }) => selectable !== false)
  const sections = [...new Set(choices.map(({ key }) => sectionOf(key)))]
  const moveSection = (step: number): void =>
    setBrowsing((current) => {
      const index = Math.max(0, sections.indexOf(sectionOf(current.selected)))
      const next = sections[(index + step + sections.length) % sections.length]!
      const viewed = viewedOf(current)
      return { selected: next === DISCOVERED_SECTION && viewed ? viewed : next, ...(viewed ? { viewed } : {}) }
    })
  const moveHarness = (step: number): void =>
    setBrowsing((current) => {
      const index = harnessRows.indexOf(current.selected)
      if (index < 0) return current
      const next = harnessRows[(index + step + harnessRows.length) % harnessRows.length]!
      return { selected: next, viewed: next }
    })
  const browse = (key: Key): void => {
    if (key.upArrow) moveSection(-1)
    if (key.downArrow) moveSection(1)
    if (key.leftArrow) moveHarness(-1)
    if (key.rightArrow) moveHarness(1)
    if (!key.return) return
    const choice = rows[selection]?.choice
    if (choice) return choose(choice)
    setField('name')
    setCreating(true)
  }
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') return submit(undefined)
      if (key.escape) return placing && !pending.current ? leaveFolder() : submit(undefined)
      if (pending.current) return
      if (placing) return editFolder(input, key)
      if (creating) return editForm(input, key)
      browse(key)
    },
    { isActive: replacing === undefined }
  )
  const detailWidth = Math.max(1, columns - 12)
  const nameLabel = `${field === 'name' ? '›' : ' '} Name: `
  const lineCount = (text: string): number => wrapLines(text, detailWidth).length
  const notice = warning ? sanitizeTerminalText(warning) : undefined
  const selected = rows[selection]!
  const globalNotice = 'Changes here also change plain strands.'
  const localNotice = 'They save into ~/.strands/cli.toml, or into the agent file that it uses.'
  const projectNotice = 'Local project only. Your CLI default stays unchanged.'
  const detailNoteRows = cli ? lineCount(globalNotice) + lineCount(localNotice) : lineCount(projectNotice)
  const step = placing ? 'folder' : creating ? 'name' : 'list'
  const createsInPlace = opensAtOnce(folderOf({ kind: 'create', name, language }))
  const languageModelNotice = modelNotice?.(language)
  const next = {
    list: opensAtOnce(folderOf(selected.choice)) ? 'open' : 'continue',
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
      hint: `↑↓ field · ${field === 'language' ? '←→ or Tab' : 'Tab'} language · Enter ${next}`,
    },
    folder: {
      heading: 'Create a workspace',
      context: placing?.kind === 'create' ? `New project · ${placing.name}` : selected.label,
      hint: 'Enter continue',
    },
  }
  const { heading, context } = screens[step]
  const hint = busy
    ? 'Preparing workspace… · Esc cancel'
    : [screens[step].hint, failureCopyHint, `Esc ${step === 'folder' ? 'back' : 'cancel'}`].filter(Boolean).join(' · ')
  const selectedChoice = selected.choice ?? { kind: 'create' as const, language, name }
  const selectedFolder = folderOf(selectedChoice)?.path
  const hasWorkspace = rows.some((row) => folderOf(row.choice ?? { kind: 'create', language, name }) !== undefined)
  const detailHeight = hasWorkspace ? 2 : 1
  const listRows =
    availableRows -
    2 -
    (notice ? lineCount(notice) + 1 : 0) -
    (failure ? lineCount(failure) : 0) -
    1 -
    lineCount(hint) -
    1 -
    detailHeight
  const notes = [folderNote(folder.value.trim(), folder.suggested)]
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
  const {
    visible,
    chromeSavings,
    sectionGap,
    height: listHeight,
    projectRange,
  } = pickerWindow(rows, shownHarness, listRows)
  const detailNotes = visible.length === rows.length && listRows - listHeight >= detailNoteRows
  const detailSource = selected.choice
    ? selected.detail
    : newProject
      ? sanitizeTerminalText(newProject)
      : selected.detail
  if (replacing)
    return (
      <WorkspaceReplacementConfirmation
        directory={replacing.folder}
        current={replacing.holder}
        replacement={choiceLabel(replacing.choice, cli)}
        onConfirm={() => {
          const { choice, workspace } = replacing
          setReplacing(undefined)
          submit(choice, workspace, true)
        }}
        onCancel={() => setReplacing(undefined)}
      />
    )
  return (
    <Box flexDirection="column">
      {selectedAgent ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={success}>
            Selected project
          </Text>
          <Text bold wrap="truncate-middle">
            Harness path: {selectedAgent}
          </Text>
        </Box>
      ) : null}
      <Box marginBottom={step === 'list' && chromeSavings > 0 ? 0 : 1} justifyContent="space-between">
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
          <Box>
            <Text {...(field === 'name' ? { color: accent, bold: true } : {})}>{nameLabel}</Text>
            <EditableText
              value={name}
              cursor={nameField.cursor}
              width={Math.max(1, detailWidth - nameLabel.length)}
              active={field === 'name' && !busy}
              placeholder=""
            />
          </Box>
          <Text {...(field === 'language' ? { color: accent, bold: true } : {})}>
            {field === 'language' ? '›' : ' '} Language: {language}
          </Text>
          <Text dimColor>A new local project. Your CLI default stays unchanged.</Text>
          {createsInPlace && newProject ? (
            <Text dimColor wrap="truncate-middle">
              Creates {sanitizeTerminalText(newProject)} with the agent and its strands-dev folder.
            </Text>
          ) : null}
          {languageModelNotice ? <Text color={warningColor}>{sanitizeTerminalText(languageModelNotice)}</Text> : null}
        </Box>
      ) : (
        <>
          <Box flexDirection="column" height={listHeight} flexShrink={0}>
            {visible.map((row, index) => (
              <Box
                key={row.key}
                flexDirection="column"
                marginTop={index > 0 && visible[index - 1]?.group !== row.group ? sectionGap : 0}
              >
                {index === 0 || visible[index - 1]?.group !== row.group ? (
                  <Box>
                    <Text bold wrap="truncate-end">
                      {row.group}
                      {row.group === discoveredGroup ? harnessHint(projectRange, harnesses.length) : ''}
                    </Text>
                  </Box>
                ) : null}
                {row.key === DISCOVERY_ROW ? (
                  <Box paddingLeft={3} paddingRight={1}>
                    <DiscoveryStatus
                      discovery={discovery ?? 'done'}
                      count={harnesses.length}
                      warningColor={warningColor}
                    />
                  </Box>
                ) : (
                  <Box
                    paddingX={1}
                    justifyContent="space-between"
                    {...(row.key === selected.key ? { backgroundColor: selectionColor } : {})}
                  >
                    <Text
                      bold={row.key === selected.key}
                      {...(row.key === selected.key ? { color: accent } : {})}
                      wrap="truncate-end"
                    >
                      {row.key === selected.key ? '›' : ' '} {row.label}
                    </Text>
                    {row.language ? <Text dimColor> {row.language}</Text> : null}
                  </Box>
                )}
              </Box>
            ))}
          </Box>
          <Box
            flexDirection="column"
            marginTop={chromeSavings > 2 ? 0 : 1}
            height={detailHeight + (detailNotes ? detailNoteRows : 0)}
            flexShrink={0}
          >
            <Text dimColor wrap="truncate-middle">
              {selected.choice || newProject ? `Source: ${detailSource}` : detailSource}
            </Text>
            {hasWorkspace ? (
              <Text dimColor wrap="truncate-middle">
                Workspace: {selectedFolder ? sanitizeTerminalText(selectedFolder) : 'New project'}
              </Text>
            ) : null}
            {detailNotes && selected.choice ? (
              <>
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
      <Box marginTop={step === 'list' && chromeSavings > 1 ? 0 : 1}>
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
  open: (choice: HarnessChoice, signal: AbortSignal, workspace?: string, replace?: boolean) => Promise<Opened>
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
  const onSelect = async (choice: HarnessChoice | undefined, workspace?: string, replace?: boolean): Promise<void> => {
    if (!choice) return cancel()
    let opened: Opened
    opening = true
    try {
      opened = await (replace ? open(choice, signal, workspace, true) : open(choice, signal, workspace))
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
