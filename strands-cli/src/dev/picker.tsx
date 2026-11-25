import { createElement, useRef, useState, type ReactElement } from 'react'
import { Box, type Key } from 'ink'
import { useInput } from '../ui/input.js'
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
}

interface BaseCliOption {
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
  onRefresh?: () => void
  onSelect: (selection: HarnessChoice | undefined, workspace?: string, replace?: boolean) => void | Promise<void>
}

interface Replacement {
  choice: HarnessChoice
  workspace?: string
  folder: string
  holder: string
}

type HarnessDiscoveryState = 'running' | 'done' | { failed: string }

interface PickerRow {
  key: string
  selectable?: false
  label: string
  detail: string
  group: string
  language: string
  choice?: HarnessChoice
}

interface HarnessNameField {
  readonly value: string
  readonly cursor: number
  readonly notice?: string
}

const NAME_LIMIT = 64
const ALLOWED = 'letters, digits, ".", "_", and "-"'
const NAME_CHARACTER = /^[a-zA-Z0-9._-]$/u
const EDITING_CONTROL = /^[\b\u007f]$/u
const LIMIT_NOTICE = `A name can have at most ${NAME_LIMIT} characters.`
const RESERVED_NAMES = new Set(['.', '..'])
const removedList = new Intl.ListFormat('en', { type: 'conjunction' })

export const HARNESS_NAME_RULE = `Use ${ALLOWED}. Up to ${NAME_LIMIT} characters.`

const characterName = (character: string): string =>
  character === ' '
    ? 'space'
    : character === '\t'
      ? 'tab'
      : /^[\r\n]+$/u.test(character)
        ? 'line break'
        : /\p{Cc}/u.test(character)
          ? 'control character'
          : /^\p{Cf}+$/u.test(character)
            ? 'invisible character'
            : `"${character}"`

const removedNotice = (removed: readonly string[]): string =>
  `Removed ${removedList.format([...new Set(removed.map(characterName))])}. Use ${ALLOWED}.`

export const editHarnessName = (field: HarnessNameField, input: string, key: Partial<Key>): HarnessNameField => {
  const command = key.ctrl === true || key.meta === true
  const characters = graphemes(input)
  const allowed = (character: string): boolean =>
    command || NAME_CHARACTER.test(character) || EDITING_CONTROL.test(character)
  const kept = characters.filter(allowed)
  const removed = characters.filter((character) => !allowed(character))
  const room = Math.max(0, NAME_LIMIT - graphemes(field.value).length)
  const typed = kept.some((character) => EDITING_CONTROL.test(character)) ? kept : kept.slice(0, room)
  const { state } = reduceInputSequence(
    { ...emptyEditor(), input: field.value, cursor: field.cursor },
    typed.join(''),
    key,
    'idle'
  )
  if (graphemes(state.input).length > NAME_LIMIT)
    return { value: field.value, cursor: field.cursor, notice: LIMIT_NOTICE }
  const notice = removed.length ? removedNotice(removed) : typed.length < kept.length ? LIMIT_NOTICE : undefined
  return { value: state.input, cursor: state.cursor, ...(notice ? { notice } : {}) }
}

export const harnessNameProblem = (name: string): string | undefined =>
  !name ? 'Enter a name.' : RESERVED_NAMES.has(name) ? 'Enter a name other than "." or "..".' : undefined

const APPROVAL = 'DELETE'

interface ConfirmationProps {
  directory: string
  replacement: string
  current?: string
  onConfirm(): void
  onCancel(): void
}

const isPrintable = (input: string): boolean =>
  ![...input].some((character) => (character.codePointAt(0) ?? 0) < 32 || character === '\u007f')

export const WorkspaceReplacementConfirmation = ({
  directory,
  replacement,
  current,
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
      {current ? <Text>Current workspace: {sanitizeTerminalText(current)}</Text> : null}
      <Text>
        All files in this folder will be replaced, including tmp agents, reports, state, and agents stored inside it.
      </Text>
      <Text>Agent projects outside this folder will not be deleted. A new chat starts after replacement.</Text>
      <Text>Replacement: {sanitizeTerminalText(replacement)}</Text>
      <Text>Type DELETE to confirm: {approval}▏</Text>
      {error ? <Text color="red">{error}</Text> : null}
      <Text dimColor>{['Enter confirm', errorCopyHint, 'Esc back'].filter(Boolean).join(' · ')}</Text>
    </Box>
  )
}

const FOLDER_LABEL = 'Workspace folder: '
const DEFAULT_NAME = 'new-harness'
const prefilledFolder = ({ path }: FolderSuggestion): string => dirname(path)
const opensAtOnce = (
  suggested: FolderSuggestion | undefined
): suggested is undefined | (FolderSuggestion & { detected: true }) => suggested === undefined || suggested.detected
const createdNote = (name: string, place: 'in' | 'at'): string =>
  `A ${name} folder will be created ${place} this path for .config, tmp/, reports, and state.`
const folderNote = (typed: string, suggested: FolderSuggestion): string => {
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
const SELECTED_AGENT_HEIGHT = 3

interface Browsing {
  readonly selected: string
  readonly offset: number
}

const firstShownProject = (
  projectKeys: readonly string[],
  { selected, offset }: Browsing,
  capacity: number
): number => {
  const index = projectKeys.indexOf(selected)
  const kept = index < 0 ? offset : Math.min(Math.max(offset, index - capacity + 1), index)
  return Math.min(Math.max(0, kept), Math.max(0, projectKeys.length - capacity))
}

// The three sections stay visible; only the discovered harnesses scroll.
const pickerWindow = (
  rows: readonly PickerRow[],
  browsing: Browsing,
  listRows: number
): {
  visible: PickerRow[]
  height: number
  capacity: number
  chromeSavings: number
  sectionGap: number
  projectRange: string | undefined
} => {
  const projects = rows.filter((row) => row.choice?.kind === 'discovered')
  const pinned = rows.length - projects.length
  const groups = new Set(rows.map(({ group }) => group)).size
  const fullHeight = pinned + projects.length + 2 * groups - 1
  // Reclaim decorative gaps before sacrificing space between the sections.
  const chromeSavings = Math.min(3, Math.max(0, fullHeight - listRows))
  const budget = listRows + chromeSavings
  const sectionGap = fullHeight <= budget ? 1 : 0
  const overhead = groups + sectionGap * (groups - 1)
  const capacity = Math.min(projects.length, Math.max(1, budget - pinned - overhead))
  const start = firstShownProject(
    projects.map(({ key }) => key),
    browsing,
    capacity
  )
  const visibleProjects = projects.slice(start, start + capacity)
  const visible = rows.filter((row) => row.choice?.kind !== 'discovered' || visibleProjects.includes(row))
  return {
    visible,
    capacity,
    chromeSavings,
    sectionGap,
    height: visible.length + overhead,
    projectRange: projects.length > capacity ? `${start + 1}–${start + capacity} of ${projects.length}` : undefined,
  }
}

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
  modelNotice,
  onRefresh,
  onSelect,
}: PickerProps): ReactElement => {
  const [browsing, setBrowsing] = useState<Browsing>(() => ({
    selected: cli ? CLI_ROW : harnesses[0] ? harnessRow(harnesses[0]) : CREATE_ROW,
    offset: 0,
  }))
  const selectedRow = browsing.selected
  const [creating, setCreating] = useState(false)
  const [placing, setPlacing] = useState<HarnessChoice>()
  const [language, setLanguage] = useState<'typescript' | 'python'>('python')
  const [field, setField] = useState<'name' | 'language'>('name')
  const [nameField, setNameField] = useState<HarnessNameField>({ value: DEFAULT_NAME, cursor: DEFAULT_NAME.length })
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
        ? `Creates ${sanitizeTerminalText(newProject)}: a general-purpose agent with your saved model.`
        : 'Start a separate project: a general-purpose agent with your saved model.',
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
    if (key.return) {
      const problem = harnessNameProblem(name)
      if (!problem) return choose({ kind: 'create', name, language })
      return setNameField((current) => ({ ...current, notice: problem }))
    }
    if (key.upArrow || key.downArrow) return setField(key.downArrow ? 'language' : 'name')
    if (field === 'language') {
      if (key.leftArrow || key.rightArrow) setLanguage(otherLanguage)
      return
    }
    setNameField((current) => editHarnessName(current, input, key))
  }
  const harnessRows = harnesses.map(harnessRow)
  const choices = rows.filter(({ selectable }) => selectable !== false)
  const move = (step: number): void =>
    setBrowsing((current) => {
      const index = Math.max(
        0,
        choices.findIndex(({ key }) => key === current.selected)
      )
      const selected = choices[(index + step + choices.length) % choices.length]!.key
      return { selected, offset: firstShownProject(harnessRows, { ...current, selected }, capacity) }
    })
  const browse = (key: Key): void => {
    if (key.upArrow) return move(-1)
    if (key.downArrow) return move(1)
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
      if (onRefresh && input === 'r' && !key.ctrl && !key.meta) return onRefresh()
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
  const projectFolder = !createsInPlace
    ? 'chosen in the next step'
    : newProject
      ? sanitizeTerminalText(newProject)
      : undefined
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
  const note = folderNote(folder.value.trim(), folder.suggested)
  const folderHeight =
    2 +
    (notice ? lineCount(notice) + 1 : 0) +
    2 +
    lineCount(note) +
    (failure ? lineCount(failure) : 0) +
    1 +
    lineCount(hint)
  const selectedAgent =
    placing && placing.kind !== 'create' && availableRows - folderHeight >= SELECTED_AGENT_HEIGHT
      ? selected.detail
      : undefined
  const {
    visible,
    capacity,
    chromeSavings,
    sectionGap,
    height: listHeight,
    projectRange,
  } = pickerWindow(rows, browsing, listRows)
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
          <Text dimColor>{note}</Text>
        </Box>
      ) : creating ? (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
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
            <Box paddingLeft={2}>
              {nameField.notice ? (
                <Text color={warningColor}>{sanitizeTerminalText(nameField.notice)}</Text>
              ) : (
                <Text dimColor>{HARNESS_NAME_RULE}</Text>
              )}
            </Box>
          </Box>
          <Box flexDirection="column">
            <Text {...(field === 'language' ? { color: accent, bold: true } : {})}>
              {field === 'language' ? '›' : ' '} Language: {language}
            </Text>
            {projectFolder ? (
              <Box paddingLeft={2}>
                <Text dimColor wrap="truncate-middle">
                  Folder: {projectFolder}
                </Text>
              </Box>
            ) : null}
          </Box>
          <Text dimColor>A new local project. Your CLI default stays unchanged.</Text>
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
                  <Box justifyContent="space-between" paddingRight={1}>
                    <Text bold wrap="truncate-end">
                      {row.group}
                      {row.group === discoveredGroup && projectRange ? ` · ${projectRange}` : ''}
                    </Text>
                    {row.group === discoveredGroup && onRefresh ? <Text dimColor> r refresh</Text> : null}
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

type HarnessSource = (
  found: (harness: DiscoveredHarness) => void,
  signal: AbortSignal
) => Promise<{ harnesses: DiscoveredHarness[] }>

const SEARCH_FLUSH_MS = 100

export const chooseHarness = async <Opened,>(
  { search, ...options }: Omit<PickerProps, 'onSelect' | 'discovery'> & { search?: HarnessSource },
  screen: StartupScreen,
  open: (choice: HarnessChoice, signal: AbortSignal, workspace?: string, replace?: boolean) => Promise<Opened>
): Promise<Opened | undefined> => {
  screen.signal.throwIfAborted()
  const operation = new AbortController()
  const signal = AbortSignal.any([screen.signal, operation.signal])
  let searchRun: AbortController | undefined
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
  let flush: ReturnType<typeof setTimeout> | undefined
  const add = (harness: DiscoveredHarness): void => {
    const index = harnesses.findIndex(({ entrypoint }) => entrypoint === harness.entrypoint)
    harnesses = index < 0 ? [...harnesses, harness] : harnesses.map((known, at) => (at === index ? harness : known))
  }
  const discover = (find: HarnessSource): void => {
    searchRun?.abort(new Error('Harness search restarted.'))
    const run = new AbortController()
    searchRun = run
    const current = (): boolean => searchRun === run
    clearTimeout(flush)
    flush = undefined
    harnesses = options.harnesses
    discovery = 'running'
    void find(
      (harness) => {
        if (!current()) return
        add(harness)
        flush ??= setTimeout(() => {
          flush = undefined
          show()
        }, SEARCH_FLUSH_MS)
      },
      AbortSignal.any([signal, run.signal])
    )
      .then((found) => {
        if (!current()) return
        found.harnesses.forEach(add)
        discovery = 'done'
      })
      .catch((error: unknown) => {
        if (!current()) return
        discovery = signal.aborted || run.signal.aborted ? 'done' : { failed: errorMessage(error) }
      })
      .finally(() => {
        if (!current()) return
        clearTimeout(flush)
        flush = undefined
        show()
      })
  }
  const refresh = search
    ? (): void => {
        discover(search)
        show()
      }
    : undefined
  const show = (): void => {
    if (settled || opening) return
    screen.show(
      createElement(HarnessPicker, {
        ...options,
        harnesses,
        ...(discovery === undefined ? {} : { discovery }),
        ...(refresh ? { onRefresh: refresh } : {}),
        onSelect,
      }),
      'Select a local harness'
    )
  }
  screen.signal.addEventListener('abort', cancel, { once: true })
  if (search) discover(search)
  show()
  try {
    return await result
  } finally {
    searchRun?.abort(new Error('Harness selection closed.'))
    clearTimeout(flush)
    screen.signal.removeEventListener('abort', cancel)
    screen.show(undefined, 'Preparing workspace…')
  }
}
