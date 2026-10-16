import {
  createElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from 'react'
import { renderToString, useApp, useInput, usePaste, useStdout, type DOMElement, type Key } from 'ink'

import type {
  ChatAttachment,
  ChatConfigurationProject,
  ChatConfigurationLanguage,
  ChatConfigurationSource,
  ChatControllerApi,
  ChatDiffPreview,
  ChatSnapshot,
} from '../chat/controller.js'
import { commandAssistance, parseCommandInvocation } from '../chat/commands.js'
import { isConfigurationTool } from '../chat/controller-helpers.js'
import { filePathsFromPaste, loadAttachments } from '../attachments.js'
import { splitArguments } from '../terminal/arguments.js'
import {
  BACKGROUND_TASK_WAIT_TOGGLE,
  SETTINGS_UPDATE_ACTION,
  permissionEscapeRow,
  settingsUpdateRow,
  type SettingsUpdateStatus,
} from '../chat/panels.js'
import { readCliVersion } from '../package-version.js'
import { errorMessage, sanitizeTerminalText } from '../terminal/sanitize.js'
import { useTerminalSize } from '../terminal/size.js'
import {
  browsingHistory,
  completeSuggestion,
  emptyEditor,
  graphemes,
  reduceInputSequence,
  submitEditor,
  type EditorState,
} from '../terminal/composer.js'
import {
  parseMouseInput,
  selectScreenText,
  shouldProcessMouseInput,
  type MouseInput,
  type MouseMoveState,
  type ScreenSelectionSegment,
} from '../terminal/mouse-input.js'
import { copyTerminalText, setTerminalMouseMotion } from '../terminal/terminal.js'
import { openExternalUrl } from '../terminal/open-url.js'
import { openAgentProject } from '../project/editor.js'
import { canUseNativePicker, chooseFiles } from '../terminal/directory-picker.js'
import { ChatView, type QueuedPromptAction, type QueuedPromptTarget } from './chat-view.js'
import {
  agentGridLayout,
  moveAgentGridSelection,
  revealAgentGridSelection,
  scrollAgentGridViewport,
} from './agent-grid.js'
import { panelModelId, type FooterAction } from './help-footer.js'
import { errorPanelLayout } from './error-panel-layout.js'
import {
  activateMetadataTarget,
  adjacentSliderOption,
  composerPanelContentHeight,
  composerPanelHeight,
  configurationDockCodeSize,
  configurationDockHeight,
  configurationDockWidth,
  cycleModelPanelFocus,
  cycleMultiColumnPanelSelection,
  cyclePanelFilter,
  detailPageSize,
  elementAtMouse,
  elementContainsMouse,
  filterPanelRows,
  initialPanelFilter,
  isComposerPanel,
  mouseScrollDirection,
  moveMultiColumnPanelSelection,
  movePermissionSelection,
  moveSelection,
  panelRowCapacity,
  parsePanelControlTarget,
  permissionPanelLayout,
  registerElement,
  revealPanelSelection,
  scrollDetail,
  scrollPanelViewport,
  scrollTranscript,
  settingArrowValue,
  shouldToggleVoiceMute,
  sliderOptionAtMouse,
  type MetadataTarget,
  type ModelPanelFocus,
  type SettingsPanelFocus,
} from './interaction.js'
import { parseFrogCommand, type FrogVariant } from './frog-easter-egg.js'
import { maxDetailScroll, maxPermissionScroll } from './presentation.js'
import {
  CONFIGURATION_OPEN_CONTROL,
  configurationDocument,
  maxConfigurationScroll,
  passiveConfigurationDockHeight,
} from './configuration-view.js'
import type { ChatPanel, ChatPanelRow, ChatPanelSlider } from '../chat/types.js'
import { ThemeProvider } from './theme.js'
import { UpdatePrompt } from './update-prompt.js'
import { waitForCompletionSlider } from './tasks-panel.js'

export function ChatApp({
  controller,
  introStartedAt,
  entranceFade,
  openUrl = openExternalUrl,
  openProject = openAgentProject,
  availableUpdate,
  updateStatus,
  promptForUpdate = false,
  developmentCheckout = readCliVersion().includes('development'),
  onRequestUpdate = (): void => {},
  onDismissUpdate = (): void => {},
}: {
  controller: ChatControllerApi
  introStartedAt?: number
  entranceFade?: boolean
  openUrl?: (url: string) => void
  openProject?: (project: ChatConfigurationProject) => Promise<void>
  availableUpdate?: string
  updateStatus?: SettingsUpdateStatus
  promptForUpdate?: boolean
  developmentCheckout?: boolean
  onRequestUpdate?: () => void
  onDismissUpdate?: () => void
}): ReactElement {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const cliVersion = readCliVersion()
  const [footerElements, registerFooterElement] = useElementMap<FooterAction>()
  const { exit } = useApp()
  const { stdout } = useStdout()
  const { columns: width, rows: height } = useTerminalSize()
  const [editor, setEditorState] = useState<EditorState>(emptyEditor)
  const [attachments, setAttachmentState] = useState<readonly ChatAttachment[]>([])
  const [suggestionSelection, setSuggestionSelection] = useState(0)
  const [dismissedSuggestions, setDismissedSuggestions] = useState<string>()
  const [panelSelection, setPanelSelection] = useState(0)
  const [panelQuery, setPanelQuery] = useState('')
  const [panelFilter, setPanelFilter] = useState('all')
  const [dockLanguage, setDockLanguage] = useState<ChatConfigurationLanguage | undefined>(undefined)
  const [dockScroll, setDockScroll] = useState<number | undefined>(undefined)
  const [modelPanelFocus, setModelPanelFocus] = useState<ModelPanelFocus>('providers')
  const [settingsPanelFocus, setSettingsPanelFocus] = useState<SettingsPanelFocus>('categories')
  const [panelViewportStart, setPanelViewportStart] = useState(0)
  const [detailScroll, setDetailScroll] = useState(0)
  const [transcriptScroll, setTranscriptScroll] = useState(0)
  // A ref, not state: the maximum changes on every streamed line and only clamps scroll input.
  const maxTranscriptScrollRef = useRef(0)
  const [pressedMetadata, setPressedMetadata] = useState<MetadataTarget>()
  const [hoveredMetadata, setHoveredMetadata] = useState<MetadataTarget>()
  const [pressedPanelFilter, setPressedPanelFilter] = useState<string>()
  const [pressedPanelRow, setPressedPanelRow] = useState<number>()
  const [pressedPanelControl, setPressedPanelControl] = useState<string>()
  const [pressedSuggestion, setPressedSuggestion] = useState<number>()
  const [hoveredPanelRow, setHoveredPanelRow] = useState<number>()
  const [hoveredPanelControl, setHoveredPanelControl] = useState<string>()
  const [hoveredPanelFilter, setHoveredPanelFilter] = useState<string>()
  const [hoveredSuggestion, setHoveredSuggestion] = useState<number>()
  const [hoveredAction, setHoveredAction] = useState<FooterAction>()
  const [hoveredJumpToBottom, setHoveredJumpToBottom] = useState(false)
  const [updatePromptVersion, setUpdatePromptVersion] = useState<string>()
  const [pressedQueuedPrompt, setPressedQueuedPrompt] = useState<QueuedPromptTarget>()
  const [editingQueuedPromptId, setEditingQueuedPromptId] = useState<string>()
  const [screenSelection, setScreenSelection] = useState<readonly ScreenSelectionSegment[]>([])
  const [clipboardNotice, setClipboardNotice] = useState<
    { status: 'success'; characterCount: number } | { status: 'error' }
  >()
  const [frog, setFrog] = useState<{ id: number; variant: FrogVariant }>()
  const [frogBrandAnimationId, setFrogBrandAnimationId] = useState<number>()
  const [party, setParty] = useState(false)
  const [expandedToolGroups, setExpandedToolGroups] = useState<ReadonlySet<string>>(new Set())
  const editorRef = useRef(editor)
  const attachmentsRef = useRef(attachments)
  const queuedPromptDraftRef = useRef<EditorState | undefined>(undefined)
  const nextFrogId = useRef(0)
  const nextFrogBrandAnimationId = useRef(0)
  const previousFrogVariant = useRef<FrogVariant | undefined>(undefined)
  const leftMouseDownRef = useRef(false)
  const copyNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const selectionDragRef = useRef<{ anchor: Pick<MouseInput, 'column' | 'row'>; lines: readonly string[] } | undefined>(
    undefined
  )
  const panelSliderDraggingRef = useRef(false)
  const panelSliderValueRef = useRef<string | undefined>(undefined)
  const mouseMoveStateRef = useRef<MouseMoveState>({
    column: -1,
    row: -1,
    acceptedAt: Number.NEGATIVE_INFINITY,
  })
  const suggestionSelectionRef = useRef(0)
  const panelSelectionRef = useRef(0)
  const panelViewportStartRef = useRef(0)
  const detailReturnRef = useRef<
    | {
        id: string
        query: string
        filter: string
        selection: number
        viewport: number
      }
    | undefined
  >(undefined)
  const [metadataElements, registerMetadataElement] = useElementMap<MetadataTarget>()
  const panelElement = useRef<DOMElement | undefined>(undefined)
  const dockElement = useRef<DOMElement | undefined>(undefined)
  const [panelRowElements, registerPanelRowElement] = useElementMap<number>()
  const [panelControlElements, registerPanelControlElement] = useElementMap<string>()
  const [panelFilterElements, registerPanelFilterElement] = useElementMap<string>()
  const panelSearchElement = useRef<DOMElement | undefined>(undefined)
  const panelSliderElement = useRef<DOMElement | undefined>(undefined)
  const [suggestionElements, registerSuggestionElement] = useElementMap<number>()
  const [queuedPromptElements, registerQueuedPromptElement] = useElementMap<QueuedPromptTarget>()
  const [toolGroupElements, registerToolGroupElement] = useElementMap<string>()
  const frogElement = useRef<DOMElement | undefined>(undefined)
  const jumpToBottomElement = useRef<DOMElement | undefined>(undefined)
  const frogPressRef = useRef<Pick<MouseInput, 'column' | 'row'> | undefined>(undefined)
  const toolGroupPressRef = useRef<string | undefined>(undefined)
  const consideredStartupUpdate = useRef<string | undefined>(undefined)
  const startupUpdatePrompt = useRef(false)
  const restartedIntroAt = useRef<number | undefined>(undefined)
  const installableUpdate = developmentCheckout ? undefined : availableUpdate
  const settingsUpdateStatus: SettingsUpdateStatus =
    updateStatus ?? (developmentCheckout ? 'development' : installableUpdate ? 'available' : 'checking')
  const setEditor = useCallback((next: EditorState): void => {
    editorRef.current = next
    setEditorState(next)
  }, [])
  const setAttachments = useCallback((next: readonly ChatAttachment[]): void => {
    attachmentsRef.current = next
    setAttachmentState(next)
  }, [])
  const rememberDetailParent = useCallback((): void => {
    const current = viewPropsRef.current
    detailReturnRef.current = {
      id: current.snapshot.panel!.id,
      query: current.panelQuery,
      filter: current.panelFilter,
      selection: panelSelectionRef.current,
      viewport: panelViewportStartRef.current,
    }
  }, [])
  const activateRow = useCallback(
    (row: ChatPanelRow): Promise<boolean> => {
      if (row.value === SETTINGS_UPDATE_ACTION) {
        if (installableUpdate) {
          setUpdatePromptVersion(installableUpdate)
        }
        return Promise.resolve(true)
      }
      const panelKind = controller.getSnapshot().panel?.kind
      if (
        (panelKind === 'help' && row.value?.startsWith('help:detail:')) ||
        (panelKind === 'tasks' && row.value?.startsWith('task:'))
      ) {
        rememberDetailParent()
      }
      if (panelKind === 'skills' && row.value) {
        const input = `/${row.value}`
        const current = editorRef.current
        setEditor({
          ...current,
          input,
          cursor: graphemes(input).length,
          historyIndex: current.history.length,
          draft: input,
        })
        controller.dismissPanel()
        return Promise.resolve(true)
      }
      return controller.activatePanelRow(row).then((activated) => {
        if (panelKind === 'models' && activated && controller.getSnapshot().panel?.kind === 'models') {
          controller.dismissPanel()
        }
        return activated
      })
    },
    [controller, installableUpdate, rememberDetailParent, setEditor]
  )
  const finishQueuedPromptEdit = useCallback((): void => {
    const draft = queuedPromptDraftRef.current
    queuedPromptDraftRef.current = undefined
    setEditingQueuedPromptId(undefined)
    if (draft) {
      setEditor(draft)
    }
  }, [setEditor])
  const resetPanelPosition = useCallback((): void => {
    panelSelectionRef.current = 0
    panelViewportStartRef.current = 0
    setPanelSelection(0)
    setPanelViewportStart(0)
  }, [])
  const selectPanelRow = useCallback((selection: number, capacity: number, rowCount: number): void => {
    panelSelectionRef.current = selection
    setPanelSelection(selection)
    const start = revealPanelSelection(selection, panelViewportStartRef.current, capacity, rowCount)
    panelViewportStartRef.current = start
    setPanelViewportStart(start)
  }, [])
  const resetHover = useCallback((): void => {
    setHoveredPanelRow(undefined)
    setHoveredPanelControl(undefined)
    setHoveredPanelFilter(undefined)
    setHoveredSuggestion(undefined)
    setHoveredAction(undefined)
    setHoveredJumpToBottom(false)
    setHoveredMetadata(undefined)
  }, [])
  const resetPressed = useCallback((): void => {
    setPressedMetadata(undefined)
    setPressedPanelFilter(undefined)
    setPressedPanelRow(undefined)
    setPressedPanelControl(undefined)
    setPressedSuggestion(undefined)
    setPressedQueuedPrompt(undefined)
  }, [])
  const actionableCommandToken = controller.actionableCommandToken(editor.input)
  // An unedited recalled `/command` keeps the arrow keys on history instead of opening the palette.
  const recalledEntry = browsingHistory(editor) && editor.input === editor.history[editor.historyIndex]
  const rawAssistance =
    snapshot.panel || dismissedSuggestions === editor.input || recalledEntry
      ? undefined
      : controller.commandAssistance
        ? controller.commandAssistance(editor.input)
        : commandAssistance(editor.input, actionableCommandToken)
  const assistance =
    rawAssistance &&
    (rawAssistance.message !== undefined || rawAssistance.completions.length > 0 || /^\/[^\s]+\s$/.test(editor.input))
      ? rawAssistance
      : undefined
  const suggestions = assistance?.completions ?? []
  const sourcePanelRows =
    snapshot.panel?.kind === 'settings' && snapshot.panel.settingsCategory === 'Updates'
      ? [settingsUpdateRow(cliVersion, settingsUpdateStatus), ...snapshot.panel.rows]
      : snapshot.panel?.rows
  const panelRows = snapshot.panel
    ? filterPanelRows(
        sourcePanelRows ?? [],
        panelQuery,
        snapshot.panel.kind === 'settings' && snapshot.panel.settingsCategory ? 'all' : panelFilter,
        snapshot.panel.kind === 'models'
      )
    : undefined
  const composerHeight = isComposerPanel(snapshot.panel?.kind)
    ? composerPanelHeight(snapshot, height, party, width)
    : undefined
  const viewProps = {
    snapshot,
    input: editor.input,
    cursor: editor.cursor,
    terminalWidth: width,
    terminalHeight: height,
    suggestions,
    ...(panelRows ? { panelRows } : {}),
    panelQuery,
    panelFilter,
    modelPanelFocus,
    settingsPanelFocus,
    panelViewportStart,
    suggestionSelection,
    panelSelection,
    detailScroll,
    ...(dockLanguage ? { dockLanguage } : {}),
    ...(dockScroll !== undefined ? { dockScroll } : {}),
    transcriptScroll,
    ...(actionableCommandToken ? { actionableCommandToken } : {}),
    ...(assistance ? { commandAssistance: assistance } : {}),
    ...(composerHeight !== undefined ? { composerHeight } : {}),
    party,
    expandedToolGroups,
    attachments,
  }
  const viewPropsRef = useRef(viewProps)
  viewPropsRef.current = viewProps
  const registerPanelElement = useCallback((element: DOMElement | null): void => {
    panelElement.current = element ?? undefined
  }, [])
  const registerDockElement = useCallback((element: DOMElement | null): void => {
    dockElement.current = element ?? undefined
  }, [])
  const registerPanelSearchElement = useCallback((element: DOMElement | null): void => {
    panelSearchElement.current = element ?? undefined
  }, [])
  const registerPanelSliderElement = useCallback((element: DOMElement | null): void => {
    panelSliderElement.current = element ?? undefined
  }, [])
  const registerFrogElement = useCallback((element: DOMElement | null): void => {
    frogElement.current = element ?? undefined
  }, [])
  const registerJumpToBottomElement = useCallback((element: DOMElement | null): void => {
    jumpToBottomElement.current = element ?? undefined
  }, [])
  const updateMaxTranscriptScroll = useCallback((maximum: number): void => {
    maxTranscriptScrollRef.current = maximum
    setTranscriptScroll((value) => Math.min(value, maximum))
  }, [])
  const attachPaths = useCallback(
    async (paths: readonly string[]): Promise<void> => {
      try {
        const current = attachmentsRef.current
        const loaded = await loadAttachments(
          [...current.map((attachment) => attachment.path), ...paths],
          controller.getSnapshot().runtime.cwd
        )
        setAttachments(loaded)
      } catch (cause) {
        controller.showError?.('attachment failed', errorMessage(cause))
      }
    },
    [controller, setAttachments]
  )
  const handleFileCommand = useCallback(
    async (argument: string): Promise<void> => {
      if (argument.trim().toLowerCase() === 'clear') {
        setAttachments([])
        return
      }
      if (argument.trim()) {
        try {
          await attachPaths(splitArguments(argument))
        } catch (cause) {
          controller.showError?.('attachment failed', errorMessage(cause))
        }
        return
      }
      if (!canUseNativePicker()) {
        controller.showError?.('file picker unavailable', 'Use /file <path> to attach one or more files.')
        return
      }
      try {
        const paths = await chooseFiles()
        if (paths.length > 0) {
          await attachPaths(paths)
        }
      } catch (cause) {
        controller.showError?.('file picker failed', errorMessage(cause))
      }
    },
    [attachPaths, controller, setAttachments]
  )
  const dispatchPrompt = useCallback(
    (prompt: string): void => {
      const command = prompt.trim().toLowerCase()
      const invocation = parseCommandInvocation(prompt.trim())
      if (invocation?.prefix === '/' && invocation.name.toLowerCase() === 'file') {
        void handleFileCommand(invocation.argument)
        return
      }
      if (command === '/party') {
        setParty((enabled) => !enabled)
        return
      }
      if (command === '/strands') {
        openUrl('https://strandsagents.com')
        return
      }
      const variant = parseFrogCommand(prompt, previousFrogVariant.current)
      if (variant) {
        nextFrogId.current += 1
        previousFrogVariant.current = variant
        setFrog({ id: nextFrogId.current, variant })
        return
      }
      const pendingAttachments = attachmentsRef.current
      if (pendingAttachments.length > 0 && !/^[!/$]/.test(prompt.trimStart())) {
        setAttachments([])
        void controller.submit({ text: prompt, attachments: pendingAttachments })
        return
      }
      void controller.submit(prompt)
    },
    [controller, handleFileCommand, openUrl, setAttachments]
  )
  const finishFrog = useCallback((id: number): void => {
    setFrog((current) => (current?.id === id ? undefined : current))
  }, [])
  const openConfigurationProject = useCallback((): void => {
    const project = controller.getSnapshot().configuration?.project
    if (!project) return
    void openProject(project).catch((cause: unknown) => {
      controller.showError?.('could not open project', `${project.root}\n${errorMessage(cause)}`)
    })
  }, [controller, openProject])

  useLayoutEffect(() => {
    const { snapshot, terminalWidth, terminalHeight, panelRows, composerHeight } = viewPropsRef.current
    if (snapshot.panel && panelRows) {
      if (snapshot.panel.kind === 'agents') {
        const { capacity, columns } = agentGridLayout(terminalWidth, terminalHeight)
        const start = revealAgentGridSelection(
          panelSelectionRef.current,
          panelViewportStartRef.current,
          capacity,
          panelRows.length,
          columns
        )
        panelViewportStartRef.current = start
        setPanelViewportStart(start)
        return
      }
      const capacity = panelRowCapacity(
        snapshot.panel.kind,
        composerHeight === undefined ? terminalHeight : composerPanelContentHeight(snapshot.panel, composerHeight)
      )
      const start = revealPanelSelection(
        panelSelectionRef.current,
        panelViewportStartRef.current,
        capacity,
        panelRows.length
      )
      panelViewportStartRef.current = start
      setPanelViewportStart(start)
    }
  }, [width, height, composerHeight])

  useEffect(() => {
    if (snapshot.status === 'closed') {
      exit()
    }
  }, [exit, snapshot.status])

  useEffect(() => {
    suggestionSelectionRef.current = 0
    setSuggestionSelection(0)
    setDismissedSuggestions(undefined)
  }, [editor.input])

  useLayoutEffect(() => {
    resetPanelPosition()
    if (snapshot.panel?.kind === 'permission' && snapshot.panel.selected !== undefined) {
      panelSelectionRef.current = snapshot.panel.selected
      setPanelSelection(snapshot.panel.selected)
    }
    setPanelQuery('')
    setPanelFilter(initialPanelFilter(snapshot.panel))
    setModelPanelFocus(
      (snapshot.panel?.kind === 'tasks' && snapshot.panel.waitForCompletion !== undefined) ||
        snapshot.panel?.kind === 'permissions'
        ? 'providers'
        : (snapshot.panel?.kind === 'models' ||
              snapshot.panel?.kind === 'sessions' ||
              snapshot.panel?.kind === 'help') &&
            snapshot.panel.filters?.length
          ? 'providers'
          : 'models'
    )
    const detailReturn = detailReturnRef.current
    if (snapshot.panel && snapshot.panel.id === detailReturn?.id) {
      const rows = filterPanelRows(snapshot.panel.rows, detailReturn.query, detailReturn.filter)
      const selected = Math.max(0, Math.min(detailReturn.selection, rows.length - 1))
      const capacity = panelRowCapacity(snapshot.panel.kind, composerPanelHeight(snapshot, height, party, width))
      const start = revealPanelSelection(selected, detailReturn.viewport, capacity, rows.length)
      setPanelQuery(detailReturn.query)
      setPanelFilter(detailReturn.filter)
      setModelPanelFocus('models')
      panelSelectionRef.current = selected
      setPanelSelection(selected)
      panelViewportStartRef.current = start
      setPanelViewportStart(start)
    }
    if (snapshot.panel?.kind !== 'help-detail' && snapshot.panel?.kind !== 'detail') {
      detailReturnRef.current = undefined
    }
    setSettingsPanelFocus('categories')
    setPressedPanelFilter(undefined)
    setPressedPanelRow(undefined)
    setPressedPanelControl(undefined)
    resetHover()
    setPressedQueuedPrompt(undefined)
    setDetailScroll(0)
    panelSliderDraggingRef.current = false
    panelSliderValueRef.current = activeSliderOption(snapshot.panel)
  }, [snapshot.panel?.id, resetPanelPosition, resetHover])

  useEffect(() => {
    if (!snapshot.activeTurn && snapshot.completedTurns.length === 0) {
      setExpandedToolGroups((current) => (current.size > 0 ? new Set() : current))
    }
  }, [snapshot.activeTurn, snapshot.completedTurns.length])

  const activeTurnId = snapshot.activeTurn?.id
  useEffect(() => {
    if (activeTurnId !== undefined) {
      setDockScroll(undefined)
    }
  }, [activeTurnId])

  useEffect(() => {
    if (
      editingQueuedPromptId &&
      !snapshot.queuedPrompts.some((prompt) => prompt.id === editingQueuedPromptId && prompt.source !== 'peer')
    ) {
      finishQueuedPromptEdit()
    }
  }, [editingQueuedPromptId, finishQueuedPromptEdit, snapshot.queuedPrompts])

  const activeSliderValue = activeSliderOption(snapshot.panel)
  useEffect(() => {
    panelSliderValueRef.current = activeSliderValue
  }, [activeSliderValue])

  useEffect(() => {
    setTranscriptScroll(0)
  }, [snapshot.activeTurn?.id])

  useEffect(() => {
    if (!installableUpdate || consideredStartupUpdate.current === installableUpdate) return
    consideredStartupUpdate.current = installableUpdate
    if (
      promptForUpdate &&
      !controller.busy &&
      !snapshot.activeTurn &&
      snapshot.completedTurns.length === 0 &&
      editorRef.current.input.length === 0
    ) {
      startupUpdatePrompt.current = true
      setUpdatePromptVersion(installableUpdate)
    }
  }, [controller.busy, installableUpdate, promptForUpdate, snapshot.activeTurn, snapshot.completedTurns.length])

  const dismissUpdatePrompt = useCallback((): void => {
    setUpdatePromptVersion(undefined)
    if (startupUpdatePrompt.current) {
      restartedIntroAt.current = Date.now()
    }
    startupUpdatePrompt.current = false
    onDismissUpdate()
  }, [onDismissUpdate])

  useEffect(() => {
    setTerminalMouseMotion(true, stdout)
    return (): void => {
      setTerminalMouseMotion(false, stdout)
    }
  }, [stdout])

  useEffect(
    (): (() => void) => () => {
      clearTimeout(copyNoticeTimerRef.current)
    },
    []
  )

  const copyText = useCallback(
    (text: string): void => {
      const characterCount = graphemes(text).length
      void copyTerminalText(text, stdout).then((copied) => {
        clearTimeout(copyNoticeTimerRef.current)
        setClipboardNotice(copied ? { status: 'success', characterCount } : { status: 'error' })
        copyNoticeTimerRef.current = setTimeout(() => {
          setClipboardNotice(undefined)
        }, 2_000)
      })
    },
    [stdout]
  )

  const handleMouse = useCallback(
    (mouse: MouseInput): void => {
      if (!shouldProcessMouseInput(mouse, mouseMoveStateRef.current)) {
        return
      }
      const { snapshot, terminalWidth, terminalHeight, suggestions, panelRows, composerHeight, party, dockLanguage } =
        viewPropsRef.current
      const currentEditor = editorRef.current
      const button = mouse.button & 3
      const scroll = mouseScrollDirection(mouse)
      if (scroll !== undefined) {
        resetHover()
        leftMouseDownRef.current = false
        frogPressRef.current = undefined
        toolGroupPressRef.current = undefined
        selectionDragRef.current = undefined
        setScreenSelection([])
        panelSliderDraggingRef.current = false
        setPressedPanelRow(undefined)
        setPressedPanelControl(undefined)
        setPressedSuggestion(undefined)
        if (
          snapshot.panel?.kind === 'detail' ||
          snapshot.panel?.kind === 'help-detail' ||
          snapshot.panel?.kind === 'error'
        ) {
          const maxScroll =
            snapshot.panel.kind === 'detail' || snapshot.panel.kind === 'help-detail'
              ? maxDetailScroll(snapshot.panel, terminalWidth, composerHeight)
              : errorPanelLayout(snapshot.panel, Math.max(1, terminalWidth - 2), composerHeight).maxScroll
          const followTail = 'followTail' in snapshot.panel && snapshot.panel.followTail === true
          setDetailScroll((value) => scrollDetail(value, scroll, maxScroll, followTail, 3))
        } else if (snapshot.panel?.kind === 'config') {
          const { maxScroll } = configurationScrollBounds(
            snapshot.panel.configuration,
            viewPropsRef.current.panelFilter,
            configurationDockWidth(terminalWidth, true),
            configurationDockHeight(snapshot, terminalHeight, party),
            (language) => activeConfigurationDiff(snapshot, language)
          )
          setDetailScroll((value) => scrollDetail(value, scroll, maxScroll, false, 3))
        } else if (snapshot.panel?.kind === 'permission') {
          const maxScroll = maxPermissionScroll(
            snapshot.panel,
            terminalHeight,
            terminalWidth,
            composerHeight,
            panelSelectionRef.current
          )
          const previewHeight = permissionPanelLayout(
            Math.max(1, terminalWidth - 2),
            composerHeight ?? terminalHeight,
            snapshot.panel.rows.length
          ).previewHeight
          setDetailScroll((value) =>
            scrollDetail(value, scroll, maxScroll, false, Math.min(3, Math.max(1, previewHeight - 1)))
          )
        } else if (snapshot.panel?.kind === 'agents') {
          const { capacity, columns } = agentGridLayout(terminalWidth, terminalHeight)
          const nextStart = scrollAgentGridViewport(
            panelViewportStartRef.current,
            scroll,
            panelRows?.length ?? 0,
            capacity,
            columns
          )
          panelViewportStartRef.current = nextStart
          setPanelViewportStart(nextStart)
        } else if (snapshot.panel?.kind === 'voice') {
          const rows = panelRows ?? []
          const hoveredIndex = elementAtMouse(panelRowElements, mouse)
          const speakerSection = (index: number): boolean =>
            rows[index]?.section === 'Voice' || rows[index]?.section === 'Model'
          const current = panelSelectionRef.current
          const selected =
            hoveredIndex !== undefined && speakerSection(hoveredIndex) !== speakerSection(current)
              ? hoveredIndex
              : current
          const nextSelection = moveMultiColumnPanelSelection(
            'voice',
            rows,
            selected,
            scroll < 0 ? { upArrow: true } : { downArrow: true },
            1
          )
          if (nextSelection !== undefined) {
            panelSelectionRef.current = nextSelection
            setPanelSelection(nextSelection)
          }
        } else if (snapshot.panel) {
          const rows = panelRows ?? []
          const capacity = panelRowCapacity(
            snapshot.panel.kind,
            composerHeight === undefined ? terminalHeight : composerPanelContentHeight(snapshot.panel, composerHeight)
          )
          const nextStart = scrollPanelViewport(panelViewportStartRef.current, scroll, rows.length, capacity)
          panelViewportStartRef.current = nextStart
          setPanelViewportStart(nextStart)
        } else if (snapshot.configuration && dockElement.current && elementContainsMouse(dockElement.current, mouse)) {
          const configuration = snapshot.configuration
          const dockWidth = configurationDockWidth(terminalWidth, false)
          const dockHeight = passiveConfigurationDockHeight(
            configurationDockHeight(snapshot, terminalHeight, party),
            configuration,
            snapshot.configurationDiffs,
            dockLanguage,
            dockWidth
          )
          const { maxScroll } = configurationScrollBounds(
            configuration,
            dockLanguage ?? configuration.preferredLanguage,
            dockWidth,
            dockHeight,
            (language) => snapshot.configurationDiffs?.[language]
          )
          setDockScroll((value) => scrollDetail(value ?? 0, scroll, maxScroll, false, 3))
        } else if (suggestions.length > 0) {
          const nextSelection = moveSelection(
            suggestionSelectionRef.current,
            scroll < 0 ? { upArrow: true } : { downArrow: true },
            suggestions.length,
            suggestions.length
          )
          if (nextSelection !== undefined) {
            suggestionSelectionRef.current = nextSelection
            setSuggestionSelection(nextSelection)
          }
        } else {
          setTranscriptScroll((value) => scrollTranscript(value, scroll, maxTranscriptScrollRef.current))
        }
        return
      }

      const panelHit = panelElement.current ? elementContainsMouse(panelElement.current, mouse) : false
      const metadataTarget = panelHit ? undefined : elementAtMouse(metadataElements, mouse)
      const footerTarget = panelHit ? undefined : elementAtMouse(footerElements, mouse)
      const footerAction = !snapshot.panel || footerTarget === 'settings' ? footerTarget : undefined
      const jumpToBottomHit =
        !snapshot.panel && viewPropsRef.current.transcriptScroll > 0 && jumpToBottomElement.current
          ? elementContainsMouse(jumpToBottomElement.current, mouse)
          : false
      const panelRowIndex = snapshot.panel ? elementAtMouse(panelRowElements, mouse) : undefined
      const panelControlTarget =
        snapshot.panel?.kind === 'settings' ||
        snapshot.panel?.kind === 'voice' ||
        snapshot.panel?.kind === 'config' ||
        snapshot.panel?.kind === 'permissions'
          ? elementAtMouse(panelControlElements, mouse)
          : undefined
      const panelFilterId =
        snapshot.panel || snapshot.configuration ? elementAtMouse(panelFilterElements, mouse) : undefined
      const suggestionIndex =
        !snapshot.panel && suggestions.length > 0 ? elementAtMouse(suggestionElements, mouse) : undefined
      const queuedPromptTarget = !snapshot.panel ? elementAtMouse(queuedPromptElements, mouse) : undefined
      const toolGroupTarget = !snapshot.panel ? elementAtMouse(toolGroupElements, mouse) : undefined
      const sliderElement =
        snapshot.panel?.kind === 'effort' ||
        snapshot.panel?.kind === 'tasks' ||
        snapshot.panel?.kind === 'permissions' ||
        snapshot.panel?.kind === 'voice'
          ? panelSliderElement.current
          : undefined
      const sliderHit = sliderElement ? elementContainsMouse(sliderElement, mouse) : false
      const searchElement =
        snapshot.panel?.kind === 'models' ||
        snapshot.panel?.kind === 'sessions' ||
        snapshot.panel?.kind === 'help' ||
        snapshot.panel?.kind === 'tasks' ||
        snapshot.panel?.kind === 'permissions'
          ? panelSearchElement.current
          : undefined
      const searchHit = searchElement ? elementContainsMouse(searchElement, mouse) : false
      const frogHit =
        !snapshot.panel && suggestions.length === 0 && frogElement.current
          ? elementContainsMouse(frogElement.current, mouse)
          : false
      if (mouse.action === 'move' && !leftMouseDownRef.current) {
        setHoveredPanelRow(panelRowIndex)
        setHoveredPanelControl(panelControlTarget)
        setHoveredPanelFilter(panelFilterId)
        setHoveredSuggestion(suggestionIndex)
        setHoveredAction(footerAction)
        setHoveredJumpToBottom(jumpToBottomHit)
        setHoveredMetadata(metadataTarget)
      }
      if (mouse.action === 'press' && button === 0) {
        resetHover()
        setFrog(undefined)
        leftMouseDownRef.current = true
        frogPressRef.current = frogHit ? { column: mouse.column, row: mouse.row } : undefined
        toolGroupPressRef.current = toolGroupTarget
        setScreenSelection([])
        selectionDragRef.current =
          sliderHit || panelControlTarget || toolGroupTarget || queuedPromptTarget || jumpToBottomHit
            ? undefined
            : {
                anchor: mouse,
                lines: sanitizeTerminalText(
                  renderToString(
                    createElement(ChatView, {
                      ...viewPropsRef.current,
                      input: currentEditor.input,
                      cursor: currentEditor.cursor,
                    }),
                    { columns: terminalWidth }
                  )
                ).split('\n'),
              }
        setPressedMetadata(metadataTarget)
        setPressedPanelFilter(panelFilterId)
        setPressedPanelRow(panelRowIndex)
        setPressedPanelControl(panelControlTarget)
        setPressedSuggestion(suggestionIndex)
        setPressedQueuedPrompt(queuedPromptTarget)
        if (searchHit) {
          setModelPanelFocus('search')
        } else if (sliderHit && (snapshot.panel?.kind === 'tasks' || snapshot.panel?.kind === 'permissions')) {
          setModelPanelFocus('providers')
        } else if (panelFilterId) {
          setModelPanelFocus('providers')
          setSettingsPanelFocus('categories')
        } else if (panelRowIndex !== undefined) {
          setModelPanelFocus('models')
          setSettingsPanelFocus('settings')
        }
      }
      const leftRelease = mouse.action === 'release' && leftMouseDownRef.current
      const frogClicked =
        leftRelease &&
        frogHit &&
        frogPressRef.current?.column === mouse.column &&
        frogPressRef.current?.row === mouse.row
      const toolGroupClicked =
        leftRelease && toolGroupTarget !== undefined && toolGroupPressRef.current === toolGroupTarget
      const completedSelection =
        leftRelease && selectionDragRef.current
          ? selectScreenText(selectionDragRef.current.lines, selectionDragRef.current.anchor, mouse)
          : undefined
      if (mouse.action === 'release') {
        leftMouseDownRef.current = false
        frogPressRef.current = undefined
        toolGroupPressRef.current = undefined
        selectionDragRef.current = undefined
        resetPressed()
      }
      const updateSliderSelection = (): void => {
        const slider = panelSlider(snapshot.panel)
        if (!sliderElement || !slider || slider.disabled) {
          return
        }
        if (snapshot.panel?.kind === 'voice') {
          const index = panelRows?.findIndex((row) => row.value === 'voice:enabled') ?? -1
          if (index >= 0) {
            panelSelectionRef.current = index
            setPanelSelection(index)
          }
        }
        const option = sliderOptionAtMouse(slider, sliderElement, mouse)
        if (!option || option.id === panelSliderValueRef.current) {
          return
        }
        panelSliderValueRef.current = option.id
        void activateRow({
          label: slider.label,
          description: option.label,
          value:
            snapshot.panel?.kind === 'tasks'
              ? BACKGROUND_TASK_WAIT_TOGGLE
              : snapshot.panel?.kind === 'permissions'
                ? `permissions:preset:${option.id}`
                : snapshot.panel?.kind === 'voice'
                  ? `voice:enabled=${option.id}`
                  : `effort:${option.id}`,
        })
      }

      if (mouse.action === 'move' && panelSliderDraggingRef.current) {
        updateSliderSelection()
        return
      }
      if (mouse.action === 'press' && button === 0 && sliderHit) {
        panelSliderDraggingRef.current = true
        updateSliderSelection()
        return
      }
      if (mouse.action === 'release' && panelSliderDraggingRef.current) {
        panelSliderDraggingRef.current = false
        updateSliderSelection()
        return
      }
      if (completedSelection) {
        setScreenSelection(completedSelection.segments)
        copyText(completedSelection.text)
        return
      }
      if (frogClicked) {
        setFrogBrandAnimationId(++nextFrogBrandAnimationId.current)
        return
      }
      if (toolGroupClicked) {
        setExpandedToolGroups((current) => {
          const next = new Set(current)
          if (next.has(toolGroupTarget)) {
            next.delete(toolGroupTarget)
          } else {
            next.add(toolGroupTarget)
          }
          return next
        })
        return
      }
      if (mouse.action === 'move') {
        const selection = selectionDragRef.current
          ? selectScreenText(selectionDragRef.current.lines, selectionDragRef.current.anchor, mouse)
          : undefined
        if (selection) {
          resetPressed()
          setScreenSelection(selection.segments)
        }
        return
      }

      if (mouse.action !== 'release' || (!leftRelease && button !== 0)) {
        return
      }
      if (jumpToBottomHit) {
        setTranscriptScroll(0)
      } else if (panelFilterId) {
        if (snapshot.panel?.kind === 'settings' && snapshot.panel.settingsCategory) {
          void activateRow({ label: '', description: '', value: panelFilterId })
        } else if (!snapshot.panel && (panelFilterId === 'typescript' || panelFilterId === 'python')) {
          setDockLanguage(panelFilterId)
          setDockScroll(undefined)
        } else {
          setPanelFilter(panelFilterId)
          setDetailScroll(0)
          resetPanelPosition()
        }
      } else if (panelControlTarget) {
        if (panelControlTarget === CONFIGURATION_OPEN_CONTROL) {
          openConfigurationProject()
          return
        }
        const target = parsePanelControlTarget(panelControlTarget)
        const row = target ? panelRows?.[target.index] : undefined
        if (!row?.value || !target) {
          return
        }
        if (snapshot.panel?.kind === 'voice') {
          panelSelectionRef.current = target.index
          setPanelSelection(target.index)
        }
        void activateRow({
          ...row,
          value: row.control?.kind === 'toggle' ? row.value : `${row.value}=${target.value}`,
        })
      } else if (panelRowIndex !== undefined) {
        panelSelectionRef.current = panelRowIndex
        setPanelSelection(panelRowIndex)
        const row = panelRows?.[panelRowIndex]
        if (row?.value && (snapshot.panel?.kind !== 'settings' || !row.control)) {
          void activateRow(row)
        }
      } else if (snapshot.panel && !panelHit && !metadataTarget && !footerAction) {
        controller.dismissPanel()
      } else if (suggestionIndex !== undefined) {
        suggestionSelectionRef.current = suggestionIndex
        setSuggestionSelection(suggestionIndex)
        const suggestion = suggestions[suggestionIndex]
        if (suggestion) {
          if (suggestion.replacement) {
            setEditor(completeSuggestion(currentEditor, suggestion))
          } else {
            const result = submitEditor(currentEditor, `/${suggestion.name}`)
            setEditor(result.state)
            if (result.action === 'submit') {
              dispatchPrompt(result.prompt)
            }
          }
        }
      } else if (queuedPromptTarget) {
        const target = parseQueuedPromptTarget(queuedPromptTarget)
        if (!target) {
          return
        }
        if (target.action === 'up' || target.action === 'down') {
          controller.moveQueuedPrompt(target.id, target.action === 'up' ? -1 : 1)
        } else {
          const prompt = snapshot.queuedPrompts.find((candidate) => candidate.id === target.id)
          if (prompt && prompt.source !== 'peer') {
            if (editingQueuedPromptId === prompt.id) {
              finishQueuedPromptEdit()
              return
            }
            queuedPromptDraftRef.current ??= currentEditor
            setEditingQueuedPromptId(prompt.id)
            setEditor({
              ...currentEditor,
              input: prompt.prompt,
              cursor: graphemes(prompt.prompt).length,
              historyIndex: currentEditor.history.length,
              draft: prompt.prompt,
            })
          }
        }
      } else if (footerAction) {
        if (footerAction === 'update' && availableUpdate) {
          startupUpdatePrompt.current = false
          setUpdatePromptVersion(availableUpdate)
        } else {
          void controller.submit(`/${footerAction}`)
        }
      } else if (metadataTarget) {
        void activateMetadataTarget(controller, metadataTarget)
      }
    },
    [
      activateRow,
      availableUpdate,
      copyText,
      controller,
      dispatchPrompt,
      editingQueuedPromptId,
      finishQueuedPromptEdit,
      footerElements,
      metadataElements,
      openConfigurationProject,
      panelControlElements,
      panelFilterElements,
      panelRowElements,
      queuedPromptElements,
      resetHover,
      resetPanelPosition,
      resetPressed,
      setEditor,
      suggestionElements,
      toolGroupElements,
    ]
  )

  const handleInput = useCallback(
    (character: string, key: Key): void => {
      const {
        snapshot,
        terminalWidth,
        terminalHeight,
        suggestions,
        panelRows,
        panelQuery,
        panelFilter,
        modelPanelFocus,
        settingsPanelFocus,
        composerHeight,
        party,
      } = viewPropsRef.current
      const currentEditor = editorRef.current
      const mouse = parseMouseInput(character)
      if (mouse) {
        handleMouse(mouse)
        return
      }
      selectionDragRef.current = undefined
      setScreenSelection([])
      resetHover()
      setPressedPanelRow(undefined)
      setPressedPanelControl(undefined)
      setPressedSuggestion(undefined)
      setPressedQueuedPrompt(undefined)
      if (key.ctrl && (character === 'c' || character === 'd')) {
        if (controller.busy) {
          controller.cancel()
        } else {
          controller.close(character === 'c' ? 130 : 0)
        }
        return
      }
      if (frog && key.escape) {
        setFrog(undefined)
        return
      }

      if (snapshot.composerStatus) {
        return
      }

      if (
        snapshot.panel?.kind === 'voice' &&
        shouldToggleVoiceMute(character, key, currentEditor.input, snapshot.voice?.status)
      ) {
        controller.toggleVoiceMute?.()
        return
      }

      if (snapshot.panel) {
        if (
          snapshot.panel.kind === 'detail' ||
          snapshot.panel.kind === 'help-detail' ||
          snapshot.panel.kind === 'error'
        ) {
          if (key.escape || key.return || key.backspace || key.delete || character === '\u007f') {
            controller.dismissPanel()
            return
          }
          const errorLayout =
            snapshot.panel.kind === 'error'
              ? errorPanelLayout(snapshot.panel, Math.max(1, terminalWidth - 2), composerHeight)
              : undefined
          const page = errorLayout?.contentHeight ?? detailPageSize(composerHeight ?? terminalHeight)
          const maxScroll =
            snapshot.panel.kind === 'detail' || snapshot.panel.kind === 'help-detail'
              ? maxDetailScroll(snapshot.panel, terminalWidth, composerHeight)
              : errorLayout!.maxScroll
          const followTail = 'followTail' in snapshot.panel && snapshot.panel.followTail === true
          if (key.upArrow) {
            setDetailScroll((value) => scrollDetail(value, -1, maxScroll, followTail, 1))
          } else if (key.downArrow) {
            setDetailScroll((value) => scrollDetail(value, 1, maxScroll, followTail, 1))
          } else if (key.pageUp) {
            setDetailScroll((value) => scrollDetail(value, -1, maxScroll, followTail, page))
          } else if (key.pageDown) {
            setDetailScroll((value) => scrollDetail(value, 1, maxScroll, followTail, page))
          } else if (key.home) {
            setDetailScroll(followTail ? maxScroll : 0)
          } else if (key.end) {
            setDetailScroll(followTail ? 0 : maxScroll)
          }
          return
        }

        if (snapshot.panel.kind === 'config') {
          if (key.escape) {
            controller.dismissPanel()
            return
          }
          if (character.toLowerCase() === 'e' && snapshot.panel.configuration.project) {
            openConfigurationProject()
            return
          }
          if (key.leftArrow || key.rightArrow || key.tab) {
            setPanelFilter(
              cyclePanelFilter(
                snapshot.panel.filters ?? [],
                panelFilter,
                key.leftArrow || (key.tab && key.shift) ? -1 : 1
              )
            )
            setDetailScroll(0)
            return
          }
          const { maxScroll, codeSize } = configurationScrollBounds(
            snapshot.panel.configuration,
            panelFilter,
            configurationDockWidth(terminalWidth, true),
            configurationDockHeight(snapshot, terminalHeight, party),
            (language) => activeConfigurationDiff(snapshot, language)
          )
          if (key.upArrow) {
            setDetailScroll((value) => scrollDetail(value, -1, maxScroll, false, 1))
          } else if (key.downArrow) {
            setDetailScroll((value) => scrollDetail(value, 1, maxScroll, false, 1))
          } else if (key.pageUp) {
            setDetailScroll((value) => scrollDetail(value, -1, maxScroll, false, codeSize.height))
          } else if (key.pageDown) {
            setDetailScroll((value) => scrollDetail(value, 1, maxScroll, false, codeSize.height))
          } else if (key.home) {
            setDetailScroll(0)
          } else if (key.end) {
            setDetailScroll(maxScroll)
          }
          return
        }

        if (snapshot.panel.kind === 'export' && snapshot.panel.nameInput) {
          if (key.escape) {
            controller.dismissPanel()
          } else if (key.return) {
            const name = panelQuery.trim() || snapshot.panel.nameInput.defaultName
            void activateRow({
              label: 'Continue',
              description: name,
              value: `export:name:${snapshot.panel.nameInput.language}:${encodeURIComponent(name)}`,
            })
          } else {
            const edit = queryEdit(character, key, ' ')
            if (edit) setPanelQuery(edit)
          }
          return
        }

        const rows = panelRows ?? []
        const rowCapacity =
          snapshot.panel.kind === 'agents'
            ? agentGridLayout(terminalWidth, terminalHeight).capacity
            : panelRowCapacity(
                snapshot.panel.kind,
                composerHeight === undefined
                  ? terminalHeight
                  : composerPanelContentHeight(snapshot.panel, composerHeight)
              )
        if (snapshot.panel.kind === 'permission' && key.escape) {
          const escapeRow = permissionEscapeRow(rows, snapshot.panel.stage)
          if (escapeRow) {
            void activateRow(escapeRow)
          }
          return
        }
        if (snapshot.panel.kind === 'permission' && (key.pageUp || key.pageDown || key.home || key.end)) {
          const maximum = maxPermissionScroll(
            snapshot.panel,
            terminalHeight,
            terminalWidth,
            composerHeight,
            panelSelectionRef.current
          )
          const pageSize = Math.max(
            1,
            permissionPanelLayout(
              Math.max(1, terminalWidth - 2),
              composerHeight ?? terminalHeight,
              snapshot.panel.rows.length
            ).previewHeight - 1
          )
          if (key.home) {
            setDetailScroll(0)
          } else if (key.end) {
            setDetailScroll(maximum)
          } else {
            setDetailScroll((value) => scrollDetail(value, key.pageUp ? -1 : 1, maximum, false, pageSize))
          }
          return
        }
        if (key.escape) {
          if (
            (snapshot.panel.kind === 'models' ||
              snapshot.panel.kind === 'sessions' ||
              snapshot.panel.kind === 'help' ||
              snapshot.panel.kind === 'tasks' ||
              snapshot.panel.kind === 'permissions' ||
              snapshot.panel.kind === 'mcp') &&
            modelPanelFocus === 'search'
          ) {
            setPanelQuery('')
            setModelPanelFocus('models')
            resetPanelPosition()
          } else if (panelQuery) {
            setPanelQuery('')
          } else {
            controller.dismissPanel()
          }
          return
        }
        const copyableModelId = panelModelId(snapshot.panel, rows[hoveredPanelRow ?? panelSelectionRef.current])
        if (copyableModelId && key.ctrl && !key.meta && !key.super && character.toLowerCase() === 'y') {
          copyText(copyableModelId)
          return
        }
        if (snapshot.panel.kind === 'mcp') {
          if (modelPanelFocus === 'search') {
            if (key.return || key.downArrow) {
              setModelPanelFocus('models')
              return
            }
            const edit = queryEdit(character, key)
            if (edit) {
              setPanelQuery(edit)
              resetPanelPosition()
            }
            return
          }
          const selected = rows[Math.min(panelSelectionRef.current, rows.length - 1)]
          const name = selected?.value?.startsWith('mcp:toggle:')
            ? decodeURIComponent(selected.value.slice('mcp:toggle:'.length))
            : undefined
          if (key.rightArrow) {
            if (name) {
              rememberDetailParent()
              controller.openMcpDetail(name)
            }
            return
          }
          if (character === 'R' && !key.ctrl && !key.meta && !key.super) {
            if (name && snapshot.panel.canRetry) {
              void controller.retryMcpServer(name)
            }
            return
          }
          if (key.return) {
            if (selected?.control) void activateRow(selected)
            return
          }
          if (character === '/') {
            setModelPanelFocus('search')
            return
          }
          const nextSelection = moveSelection(panelSelectionRef.current, key, rows.length, rowCapacity)
          if (nextSelection !== undefined) {
            selectPanelRow(nextSelection, rowCapacity, rows.length)
            return
          }
          const edit = snapshot.panel.searchable ? queryEdit(character, key) : undefined
          if (edit) {
            setModelPanelFocus('search')
            setPanelQuery(edit)
            resetPanelPosition()
          }
          return
        }
        if (snapshot.panel.kind === 'effort') {
          const slider = snapshot.panel.slider
          // Arrow keys already apply the effort, so Enter just closes like Escape.
          if (key.return) {
            controller.dismissPanel()
            return
          }
          if (key.leftArrow || key.rightArrow) {
            const option = slider.disabled ? undefined : adjacentSliderOption(slider, key.leftArrow ? -1 : 1)
            if (option) {
              void activateRow({ label: slider.label, description: option.label, value: `effort:${option.id}` })
            }
            return
          }
          return
        }
        if (snapshot.panel.kind === 'tasks' || snapshot.panel.kind === 'permissions') {
          if (key.tab) {
            setModelPanelFocus(modelPanelFocus === 'providers' ? 'models' : 'providers')
            return
          }
          if (modelPanelFocus === 'providers') {
            if (snapshot.panel.kind === 'tasks') {
              const current = snapshot.panel.waitForCompletion
              const requested = key.leftArrow ? false : key.rightArrow ? true : undefined
              if (
                current !== undefined &&
                ((requested !== undefined && requested !== current) || key.return || character === ' ')
              ) {
                void activateRow({
                  label: 'Wait for completion',
                  description: requested === true || (requested === undefined && !current) ? 'On' : 'Off',
                  value: BACKGROUND_TASK_WAIT_TOGGLE,
                })
              }
            } else if (key.leftArrow || key.rightArrow) {
              const option = adjacentSliderOption(snapshot.panel.slider, key.leftArrow ? -1 : 1)
              if (option) {
                void activateRow({
                  label: snapshot.panel.slider.label,
                  description: option.label,
                  value: `permissions:preset:${option.id}`,
                })
              }
            }
            return
          }
          if (modelPanelFocus === 'search' && (key.downArrow || key.return)) {
            setModelPanelFocus('models')
            return
          }
          if (modelPanelFocus === 'models') {
            const selected = rows[Math.min(panelSelectionRef.current, rows.length - 1)]
            const activate = key.return || (snapshot.panel.kind === 'permissions' && character === ' ')
            if (activate && selected?.value) {
              void activateRow(selected)
              return
            }
            const nextSelection = moveSelection(panelSelectionRef.current, key, rows.length, rowCapacity)
            if (nextSelection !== undefined) {
              selectPanelRow(nextSelection, rowCapacity, rows.length)
              return
            }
            if (character === '/') {
              setModelPanelFocus('search')
            }
            return
          }
          const edit = queryEdit(character, key)
          if (edit) {
            setPanelQuery(edit)
            resetPanelPosition()
          }
          return
        }
        if (snapshot.panel.kind === 'models' || snapshot.panel.kind === 'sessions' || snapshot.panel.kind === 'help') {
          if (snapshot.panel.kind === 'help' && character === '/' && modelPanelFocus !== 'search') {
            setModelPanelFocus('search')
            return
          }
          if (key.tab) {
            setModelPanelFocus(
              snapshot.panel.kind === 'models'
                ? cycleModelPanelFocus(modelPanelFocus, snapshot.panel, key.shift ? -1 : 1)
                : modelPanelFocus === 'providers'
                  ? 'models'
                  : modelPanelFocus === 'models'
                    ? 'providers'
                    : 'models'
            )
            return
          }
          if (modelPanelFocus === 'search' && (key.downArrow || key.return)) {
            setModelPanelFocus('models')
            return
          }
          if (snapshot.panel.kind === 'help' && modelPanelFocus === 'providers' && (key.return || key.rightArrow)) {
            setModelPanelFocus('models')
            return
          }
          if (modelPanelFocus === 'providers' && snapshot.panel.filters?.length && (key.upArrow || key.downArrow)) {
            setPanelFilter(cyclePanelFilter(snapshot.panel.filters, panelFilter, key.upArrow ? -1 : 1))
            resetPanelPosition()
            return
          }
          if (modelPanelFocus === 'models') {
            const selected = rows[Math.min(panelSelectionRef.current, rows.length - 1)]
            if (key.return && selected?.value) {
              void activateRow(selected)
              return
            }
            const nextSelection = moveSelection(panelSelectionRef.current, key, rows.length, rowCapacity)
            if (nextSelection !== undefined) {
              selectPanelRow(nextSelection, rowCapacity, rows.length)
              return
            }
          }
          if (modelPanelFocus === 'models' && character === '/') {
            setModelPanelFocus('search')
            return
          }
          const edit =
            modelPanelFocus === 'search' || snapshot.panel.kind === 'help' ? queryEdit(character, key) : undefined
          if (edit) {
            if (snapshot.panel.kind === 'help') setModelPanelFocus('search')
            setPanelQuery(edit)
            resetPanelPosition()
          }
          return
        }
        if (snapshot.panel.kind === 'settings') {
          if (key.tab) {
            setSettingsPanelFocus(settingsPanelFocus === 'categories' ? 'settings' : 'categories')
            return
          }
          if (settingsPanelFocus === 'categories') {
            if ((key.upArrow || key.downArrow) && snapshot.panel.filters?.length) {
              const category = cyclePanelFilter(
                snapshot.panel.filters,
                `settings:${snapshot.panel.settingsCategory}`,
                key.upArrow ? -1 : 1
              )
              void activateRow({ label: '', description: '', value: category })
            } else if (key.return || key.rightArrow) {
              setSettingsPanelFocus('settings')
            }
            return
          }
          const selected = rows[Math.min(panelSelectionRef.current, rows.length - 1)]
          if (key.leftArrow || key.rightArrow) {
            const value = selected && settingArrowValue(selected, key.leftArrow ? -1 : 1)
            if (selected && value) {
              void activateRow({ ...selected, value })
            }
            return
          }
          if ((key.return || character === ' ') && selected?.value) {
            void activateRow(selected)
            return
          }
          const nextSelection = moveSelection(panelSelectionRef.current, key, rows.length, rowCapacity)
          if (nextSelection !== undefined) {
            selectPanelRow(nextSelection, rowCapacity, rows.length)
          }
          return
        }
        if (key.tab) {
          const nextSelection = cycleMultiColumnPanelSelection(
            snapshot.panel.kind,
            rows,
            panelSelectionRef.current,
            key.shift ? -1 : 1
          )
          if (nextSelection !== undefined) {
            selectPanelRow(nextSelection, rowCapacity, rows.length)
            return
          }
        }
        if (key.tab && snapshot.panel.filters?.length) {
          setPanelFilter(cyclePanelFilter(snapshot.panel.filters, panelFilter, key.shift ? -1 : 1))
          resetPanelPosition()
          return
        }
        if (snapshot.panel.kind === 'voice') {
          if (key.leftArrow || key.rightArrow) {
            const selected = rows[Math.min(panelSelectionRef.current, rows.length - 1)]
            const value = selected && settingArrowValue(selected, key.leftArrow ? -1 : 1)
            if (selected && value) {
              void activateRow({ ...selected, value })
            }
            return
          }
          const nextSelection = moveMultiColumnPanelSelection(
            snapshot.panel.kind,
            rows,
            panelSelectionRef.current,
            key,
            Math.max(1, Math.floor(rowCapacity / 2))
          )
          if (nextSelection !== undefined) {
            selectPanelRow(nextSelection, rowCapacity, rows.length)
            return
          }
        }
        if (snapshot.panel.kind === 'export' && (key.leftArrow || key.rightArrow)) {
          const nextSelection = Math.max(
            0,
            Math.min(rows.length - 1, panelSelectionRef.current + (key.leftArrow ? -1 : 1))
          )
          selectPanelRow(nextSelection, rowCapacity, rows.length)
          return
        }
        if ((snapshot.panel.kind === 'voice' || snapshot.panel.kind === 'tools') && character === ' ') {
          const selected = rows[Math.min(panelSelectionRef.current, rows.length - 1)]
          if (selected?.value) {
            void activateRow(selected)
          }
          return
        }
        if (snapshot.panel.kind === 'agents') {
          if (key.return) {
            const selected = rows[Math.min(panelSelectionRef.current, rows.length - 1)]
            if (selected?.value) void activateRow(selected)
            return
          }
          const { columns } = agentGridLayout(terminalWidth, terminalHeight)
          const next = moveAgentGridSelection(panelSelectionRef.current, key, rows.length, columns, rowCapacity)
          if (next !== undefined) {
            panelSelectionRef.current = next
            setPanelSelection(next)
            const start = revealAgentGridSelection(
              next,
              panelViewportStartRef.current,
              rowCapacity,
              rows.length,
              columns
            )
            panelViewportStartRef.current = start
            setPanelViewportStart(start)
            return
          }
        }
        if (snapshot.panel.kind === 'permission' && (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow)) {
          const layout = permissionPanelLayout(
            Math.max(1, terminalWidth - 2),
            composerHeight ?? terminalHeight,
            rows.length
          )
          const next = movePermissionSelection(panelSelectionRef.current, key, rows.length, layout.optionGrid)
          if (next !== undefined) {
            selectPanelRow(next, layout.optionCapacity, rows.length)
          }
          return
        }
        if (key.rightArrow && snapshot.panel.kind === 'skills') {
          const selected = rows[Math.min(panelSelectionRef.current, rows.length - 1)]
          if (selected?.value) {
            rememberDetailParent()
            controller.openSkillDetail(selected.value)
          }
          return
        }
        if (key.return) {
          const selected = rows[Math.min(panelSelectionRef.current, rows.length - 1)]
          if (selected?.value) {
            void activateRow(selected)
          } else if (!snapshot.panel.searchable) {
            controller.dismissPanel()
          }
          return
        }
        const nextSelection = moveSelection(panelSelectionRef.current, key, rows.length, rowCapacity)
        if (nextSelection !== undefined) {
          selectPanelRow(nextSelection, rowCapacity, rows.length)
          return
        }
        const edit = snapshot.panel.searchable ? queryEdit(character, key) : undefined
        if (edit) {
          setPanelQuery(edit)
          resetPanelPosition()
        }
        return
      }

      if (editingQueuedPromptId && key.escape) {
        finishQueuedPromptEdit()
        return
      }

      const phase = editingQueuedPromptId ? 'idle' : controller.busy ? 'running' : 'idle'
      // Esc closes the palette before it can cancel a running turn.
      if (viewPropsRef.current.commandAssistance && key.escape) {
        setDismissedSuggestions(currentEditor.input)
        return
      }
      if (suggestions.length > 0) {
        const current = Math.min(suggestionSelectionRef.current, suggestions.length - 1)
        const next = moveSelection(current, key, suggestions.length, suggestions.length)
        if (next !== undefined) {
          suggestionSelectionRef.current = next
          setSuggestionSelection(next)
          return
        }
        const selected = suggestions[current]!
        if (key.tab) {
          setEditor(completeSuggestion(currentEditor, selected))
          return
        }
        if (key.return) {
          if (selected.replacement && currentEditor.input.trim() !== selected.replacement.trim()) {
            setEditor(completeSuggestion(currentEditor, selected))
            return
          }
          const prompt = selected.replacement ? currentEditor.input : `/${selected.name}`
          const result = submitEditor(currentEditor, prompt)
          setEditor(result.state)
          if (result.action === 'submit') {
            dispatchPrompt(result.prompt)
          }
          return
        }
      }

      if (key.pageUp || key.pageDown || (key.ctrl && (key.upArrow || key.downArrow || key.home || key.end))) {
        if (key.ctrl && key.home) {
          setTranscriptScroll(maxTranscriptScrollRef.current)
          return
        }
        if (key.ctrl && key.end) {
          setTranscriptScroll(0)
          return
        }
        const direction = key.pageUp || key.upArrow ? -1 : 1
        setTranscriptScroll((value) =>
          scrollTranscript(
            value,
            direction,
            maxTranscriptScrollRef.current,
            key.pageUp || key.pageDown ? Math.max(3, terminalHeight - 8) : 3
          )
        )
        return
      }

      if (shouldToggleVoiceMute(character, key, currentEditor.input, snapshot.voice?.status)) {
        controller.toggleVoiceMute?.()
        return
      }

      if (key.return && !currentEditor.input.trim()) {
        if (editingQueuedPromptId && controller.updateQueuedPrompt(editingQueuedPromptId, '')) {
          finishQueuedPromptEdit()
          return
        }
        if (attachmentsRef.current.length > 0) {
          dispatchPrompt('')
          return
        }
      }

      const result = reduceInputSequence(currentEditor, character, key, phase)
      if (result.action === 'submit') {
        if (editingQueuedPromptId && controller.updateQueuedPrompt(editingQueuedPromptId, result.prompt)) {
          finishQueuedPromptEdit()
        } else {
          setEditor(result.state)
          dispatchPrompt(result.prompt)
        }
      } else if (result.action === 'cancel') {
        setEditor(result.state)
        controller.cancel()
      } else {
        setEditor(result.state)
      }
    },
    [
      activateRow,
      controller,
      copyText,
      dispatchPrompt,
      editingQueuedPromptId,
      finishQueuedPromptEdit,
      frog,
      handleMouse,
      openConfigurationProject,
      hoveredPanelRow,
      rememberDetailParent,
      resetHover,
      resetPanelPosition,
      selectPanelRow,
      setEditor,
    ]
  )
  useInput(handleInput, { isActive: updatePromptVersion === undefined })
  usePaste(
    (text) => {
      const currentSnapshot = controller.getSnapshot()
      const insertText = (): void => handleInput(text, {} as Key)
      if (currentSnapshot.panel || editingQueuedPromptId) {
        insertText()
        return
      }
      void filePathsFromPaste(text, currentSnapshot.runtime.cwd)
        .then((paths) => (paths ? attachPaths(paths) : insertText()))
        .catch(insertText)
    },
    { isActive: updatePromptVersion === undefined }
  )

  if (updatePromptVersion) {
    return (
      <ThemeProvider settings={snapshot.settings}>
        <UpdatePrompt
          version={updatePromptVersion}
          width={width}
          height={height}
          onUpdate={onRequestUpdate}
          onLater={dismissUpdatePrompt}
          onDisable={async () => {
            const disabled = (await controller.setSettings?.({ updatePrompts: false })) ?? false
            if (disabled) {
              dismissUpdatePrompt()
            }
            return disabled
          }}
        />
      </ThemeProvider>
    )
  }

  return (
    <ChatView
      {...viewProps}
      {...(entranceFade !== undefined ? { entranceFade } : {})}
      {...(restartedIntroAt.current !== undefined || introStartedAt !== undefined
        ? { introStartedAt: restartedIntroAt.current ?? introStartedAt }
        : {})}
      snapshot={snapshot}
      onActionElement={registerFooterElement}
      {...(hoveredAction !== undefined ? { hoveredAction } : {})}
      {...(installableUpdate ? { availableUpdate: installableUpdate } : {})}
      {...(hoveredMetadata ? { hoveredMetadata } : {})}
      {...(controller.voice ? { voice: controller.voice } : {})}
      onMaxTranscriptScroll={updateMaxTranscriptScroll}
      onMetadataElement={registerMetadataElement}
      onPanelElement={registerPanelElement}
      onDockElement={registerDockElement}
      onPanelRowElement={registerPanelRowElement}
      onPanelControlElement={registerPanelControlElement}
      onPanelFilterElement={registerPanelFilterElement}
      onPanelSearchElement={registerPanelSearchElement}
      onPanelSliderElement={registerPanelSliderElement}
      onSuggestionElement={registerSuggestionElement}
      {...(pressedMetadata ? { pressedMetadata } : {})}
      {...(pressedPanelFilter ? { pressedPanelFilter } : {})}
      {...(pressedPanelRow !== undefined ? { pressedPanelRow } : {})}
      {...(pressedPanelControl ? { pressedPanelControl } : {})}
      {...(hoveredPanelControl ? { hoveredPanelControl } : {})}
      {...(pressedSuggestion !== undefined ? { pressedSuggestion } : {})}
      {...(hoveredPanelRow !== undefined ? { hoveredPanelRow } : {})}
      {...(hoveredPanelFilter ? { hoveredPanelFilter } : {})}
      {...(hoveredSuggestion !== undefined ? { hoveredSuggestion } : {})}
      {...(pressedQueuedPrompt ? { pressedQueuedPrompt } : {})}
      {...(editingQueuedPromptId ? { editingQueuedPromptId } : {})}
      {...(frog ? { frog, onFrogComplete: finishFrog } : {})}
      {...(frogBrandAnimationId !== undefined ? { frogBrandAnimationId } : {})}
      selection={screenSelection}
      {...(clipboardNotice ? { clipboardNotice } : {})}
      onQueuedPromptElement={registerQueuedPromptElement}
      onFrogElement={registerFrogElement}
      onJumpToBottomElement={registerJumpToBottomElement}
      hoveredJumpToBottom={hoveredJumpToBottom}
      onToolGroupElement={registerToolGroupElement}
    />
  )
}

function useElementMap<K>(): [Map<K, DOMElement>, (key: K, element: DOMElement | null) => void] {
  const elements = useRef(new Map<K, DOMElement>()).current
  const register = useCallback(
    (key: K, element: DOMElement | null): void => {
      registerElement(elements, key, element)
    },
    [elements]
  )
  return [elements, register]
}

function configurationScrollBounds(
  configuration: ChatConfigurationSource,
  language: string,
  dockWidth: number,
  dockHeight: number,
  diffFor: (language: ChatConfigurationLanguage) => ChatDiffPreview | undefined
): { maxScroll: number; codeSize: { width: number; height: number } } {
  const selected = configurationDocument(configuration, language)
  const codeSize = configurationDockCodeSize(dockWidth, dockHeight)
  const maxScroll = maxConfigurationScroll(
    selected.document.source,
    codeSize.width,
    codeSize.height,
    diffFor(selected.language)
  )
  return { maxScroll, codeSize }
}

function activeConfigurationDiff(
  snapshot: ChatSnapshot,
  language: ChatConfigurationLanguage
): ChatDiffPreview | undefined {
  const active = (snapshot.activeTurn ?? snapshot.completedTurns.at(-1))?.entries.some(
    (entry) => entry.type === 'tool' && isConfigurationTool(entry.name)
  )
  return active ? snapshot.configurationDiffs?.[language] : undefined
}

function parseQueuedPromptTarget(target: QueuedPromptTarget): { id: string; action: QueuedPromptAction } | undefined {
  const separator = target.lastIndexOf(':')
  const id = target.slice(0, separator)
  const action = target.slice(separator + 1)
  if (!id || (action !== 'edit' && action !== 'up' && action !== 'down')) {
    return undefined
  }
  return { id, action }
}

/** The change a key makes to a single-line panel query, or `undefined` when the key does not edit it. */
function queryEdit(character: string, key: Key, newline = ''): ((query: string) => string) | undefined {
  if (key.backspace || key.delete || character === '\u007f') {
    return (query) => graphemes(query).slice(0, -1).join('')
  }
  if (key.ctrl && character === 'u') return (): string => ''
  if (key.ctrl || key.meta || key.super || !character) return undefined
  const clean = sanitizeTerminalText(character).replaceAll('\n', newline)
  return clean ? (query): string => query + clean : undefined
}

function panelSlider(panel: ChatPanel | undefined): ChatPanelSlider | undefined {
  if (panel?.kind === 'effort' || panel?.kind === 'permissions') return panel.slider
  if (panel?.kind === 'voice') {
    const control = panel.rows.find((row) => row.value === 'voice:enabled')?.control
    return control?.kind === 'segmented'
      ? { label: 'Voice', options: control.options.map(({ value: id, ...option }) => ({ id, ...option })) }
      : undefined
  }
  return panel?.kind === 'tasks' ? waitForCompletionSlider(panel.waitForCompletion) : undefined
}

function activeSliderOption(panel: ChatPanel | undefined): string | undefined {
  return panelSlider(panel)?.options.find((option) => option.active)?.id
}
