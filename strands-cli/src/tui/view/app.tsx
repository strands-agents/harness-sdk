import { createElement, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import { renderToString, useApp, useInput, useStdout, type DOMElement, type Key } from 'ink'

import type { ChatControllerApi } from '../chat/controller.js'
import { commandAssistance } from '../chat/commands.js'
import { sanitizeTerminalText } from '../terminal/sanitize.js'
import {
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
import { ChatView, type QueuedPromptAction, type QueuedPromptTarget } from './chat-view.js'
import {
  activateMetadataTarget,
  adjacentSettingOption,
  adjacentSliderOption,
  agentGridCapacity,
  agentGridColumns,
  cycleModelPanelFocus,
  cyclePanelFilter,
  detailPageSize,
  elementAtMouse,
  elementContainsMouse,
  filterPanelRows,
  MODEL_COPY_TARGET,
  mouseScrollDirection,
  moveAgentGridSelection,
  moveSelection,
  panelRowCapacity,
  parsePanelControlTarget,
  registerElement,
  revealAgentGridSelection,
  revealPanelSelection,
  scrollAgentGridViewport,
  scrollDetail,
  scrollPanelViewport,
  scrollTranscript,
  shouldToggleVoiceMute,
  settingsLayout,
  settingsThemeLayout,
  sliderOptionAtMouse,
  type MetadataTarget,
  type ModelPanelFocus,
} from './interaction.js'
import { parseFrogCommand, type FrogVariant } from './frog-easter-egg.js'
import { maxDetailScroll, maxPermissionScroll } from './presentation.js'
import { CustomThemeEditor, type Appearance } from './custom-theme-editor.js'
import type { ChatPanelRow } from '../chat/types.js'

export function ChatApp({
  controller,
  openUrl = openExternalUrl,
}: {
  controller: ChatControllerApi
  openUrl?: (url: string) => void
}): ReactElement {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  const [previewAppearance, setPreviewAppearance] = useState<Appearance>()
  const [footerElements, registerFooterElement] = useElementMap<'settings' | 'setup' | 'help'>()
  const activateRow = useCallback(
    (row: ChatPanelRow): Promise<boolean> => {
      if (
        controller.getSnapshot().panel?.kind === 'settings' &&
        (row.value === 'frogTheme=custom' ||
          (row.value === 'frogTheme' && controller.getSnapshot().settings.frogTheme === 'custom'))
      ) {
        setAppearanceOpen(true)
        return Promise.resolve(true)
      }
      return controller.activatePanelRow(row)
    },
    [controller]
  )
  const closeAppearance = useCallback((): void => {
    setAppearanceOpen(false)
    setPreviewAppearance(undefined)
  }, [])
  useEffect(() => {
    if (snapshot.panel?.kind !== 'settings') closeAppearance()
  }, [snapshot.panel?.kind, closeAppearance])
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [terminal, setTerminal] = useState({
    width: stdout.columns || 80,
    height: stdout.rows || 24,
  })
  const [editor, setEditorState] = useState<EditorState>(emptyEditor)
  const [suggestionSelection, setSuggestionSelection] = useState(0)
  const [dismissedSuggestions, setDismissedSuggestions] = useState<string>()
  const [panelSelection, setPanelSelection] = useState(0)
  const [panelQuery, setPanelQuery] = useState('')
  const [panelFilter, setPanelFilter] = useState('all')
  const [modelPanelFocus, setModelPanelFocus] = useState<ModelPanelFocus>('models')
  const [panelViewportStart, setPanelViewportStart] = useState(0)
  const [detailScroll, setDetailScroll] = useState(0)
  const [transcriptScroll, setTranscriptScroll] = useState(0)
  // A ref, not state: the maximum changes on every streamed line and only clamps scroll input.
  const maxTranscriptScrollRef = useRef(0)
  const [pressedMetadata, setPressedMetadata] = useState<MetadataTarget>()
  const [pressedPanelFilter, setPressedPanelFilter] = useState<string>()
  const [pressedPanelRow, setPressedPanelRow] = useState<number>()
  const [pressedPanelControl, setPressedPanelControl] = useState<string>()
  const [pressedPanelSlider, setPressedPanelSlider] = useState(false)
  const [pressedSuggestion, setPressedSuggestion] = useState<number>()
  const [hoveredPanelRow, setHoveredPanelRow] = useState<number>()
  const [hoveredPanelControl, setHoveredPanelControl] = useState<string>()
  const [hoveredPanelFilter, setHoveredPanelFilter] = useState<string>()
  const [hoveredPanelSlider, setHoveredPanelSlider] = useState(false)
  const [hoveredSuggestion, setHoveredSuggestion] = useState<number>()
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
  const [metadataElements, registerMetadataElement] = useElementMap<MetadataTarget>()
  const panelElement = useRef<DOMElement | undefined>(undefined)
  const [panelRowElements, registerPanelRowElement] = useElementMap<number>()
  const [panelControlElements, registerPanelControlElement] = useElementMap<string>()
  const [panelFilterElements, registerPanelFilterElement] = useElementMap<string>()
  const [panelPinElements, registerPanelPinElement] = useElementMap<number>()
  const panelSearchElement = useRef<DOMElement | undefined>(undefined)
  const panelSliderElement = useRef<DOMElement | undefined>(undefined)
  const [suggestionElements, registerSuggestionElement] = useElementMap<number>()
  const [queuedPromptElements, registerQueuedPromptElement] = useElementMap<QueuedPromptTarget>()
  const [toolGroupElements, registerToolGroupElement] = useElementMap<string>()
  const frogElement = useRef<DOMElement | undefined>(undefined)
  const frogPressRef = useRef<Pick<MouseInput, 'column' | 'row'> | undefined>(undefined)
  const toolGroupPressRef = useRef<string | undefined>(undefined)
  const setEditor = useCallback((next: EditorState): void => {
    editorRef.current = next
    setEditorState(next)
  }, [])
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
    setHoveredPanelSlider(false)
    setHoveredSuggestion(undefined)
  }, [])
  const resetPressed = useCallback((): void => {
    setPressedMetadata(undefined)
    setPressedPanelFilter(undefined)
    setPressedPanelRow(undefined)
    setPressedPanelControl(undefined)
    setPressedPanelSlider(false)
    setPressedSuggestion(undefined)
    setPressedQueuedPrompt(undefined)
  }, [])
  const rawAssistance =
    snapshot.panel || dismissedSuggestions === editor.input || controller.busy
      ? undefined
      : commandAssistance(editor.input)
  const assistance =
    rawAssistance && (rawAssistance.completions.length > 0 || /^\/[^\s]+\s$/.test(editor.input))
      ? rawAssistance
      : undefined
  const suggestions = assistance?.completions ?? []
  const startupCovered = snapshot.panel !== undefined || assistance !== undefined
  const actionableCommandToken = controller.actionableCommandToken(editor.input)
  const panelRows = snapshot.panel
    ? filterPanelRows(
        snapshot.panel.rows,
        panelQuery,
        snapshot.panel.kind === 'settings' && snapshot.panel.settingsCategory ? 'all' : panelFilter,
        snapshot.panel.kind === 'models'
      )
    : undefined
  const viewProps = {
    snapshot,
    input: editor.input,
    cursor: editor.cursor,
    terminalWidth: terminal.width,
    terminalHeight: terminal.height,
    suggestions,
    ...(panelRows ? { panelRows } : {}),
    panelQuery,
    panelFilter,
    modelPanelFocus,
    panelViewportStart,
    suggestionSelection,
    panelSelection,
    detailScroll,
    transcriptScroll,
    ...(actionableCommandToken ? { actionableCommandToken } : {}),
    ...(assistance ? { commandAssistance: assistance } : {}),
    party,
    expandedToolGroups,
  }
  const viewPropsRef = useRef(viewProps)
  viewPropsRef.current = viewProps
  const registerPanelElement = useCallback((element: DOMElement | null): void => {
    panelElement.current = element ?? undefined
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
  const updateMaxTranscriptScroll = useCallback((maximum: number): void => {
    maxTranscriptScrollRef.current = maximum
    setTranscriptScroll((value) => Math.min(value, maximum))
  }, [])
  const dispatchPrompt = useCallback(
    (prompt: string, steer = false): void => {
      const command = prompt.trim().toLowerCase()
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
      void (steer ? controller.steer(prompt) : controller.submit(prompt))
    },
    [controller, openUrl]
  )
  const finishFrog = useCallback((id: number): void => {
    setFrog((current) => (current?.id === id ? undefined : current))
  }, [])

  useEffect(() => {
    const resize = (): void => {
      const size = { width: stdout.columns || 80, height: stdout.rows || 24 }
      const { snapshot, panelRows } = viewPropsRef.current
      if (snapshot.panel && panelRows) {
        const agents = snapshot.panel.kind === 'agents'
        const capacity = agents
          ? agentGridCapacity(size.width, size.height)
          : panelRowCapacity(snapshot.panel.kind, size.height, size.width, panelRows)
        const start = agents
          ? revealAgentGridSelection(
              panelSelectionRef.current,
              panelViewportStartRef.current,
              capacity,
              panelRows.length,
              agentGridColumns(size.width)
            )
          : revealPanelSelection(panelSelectionRef.current, panelViewportStartRef.current, capacity, panelRows.length)
        panelViewportStartRef.current = start
        setPanelViewportStart(start)
      }
      setTerminal(size)
    }
    stdout.on('resize', resize)
    return (): void => {
      stdout.off('resize', resize)
    }
  }, [stdout])

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

  useEffect(() => {
    resetPanelPosition()
    setPanelQuery('')
    setPanelFilter(
      snapshot.panel?.kind === 'help'
        ? 'controls'
        : snapshot.panel?.kind === 'settings' && snapshot.panel.settingsCategory
          ? `settings:${snapshot.panel.settingsCategory}`
          : 'all'
    )
    setModelPanelFocus(snapshot.panel?.slider?.focused ? 'effort' : 'models')
    setPressedPanelFilter(undefined)
    setPressedPanelRow(undefined)
    setPressedPanelControl(undefined)
    setPressedPanelSlider(false)
    resetHover()
    setPressedQueuedPrompt(undefined)
    setDetailScroll(0)
    panelSliderDraggingRef.current = false
    panelSliderValueRef.current = snapshot.panel?.slider?.options.find((option) => option.active)?.id
  }, [snapshot.panel?.id, resetPanelPosition, resetHover])

  useEffect(() => {
    if (startupCovered) {
      setFrogBrandAnimationId(undefined)
    }
  }, [startupCovered])

  useEffect(() => {
    if (!snapshot.activeTurn && snapshot.completedTurns.length === 0) {
      setExpandedToolGroups((current) => (current.size > 0 ? new Set() : current))
    }
  }, [snapshot.activeTurn, snapshot.completedTurns.length])

  useEffect(() => {
    if (
      editingQueuedPromptId &&
      !snapshot.queuedPrompts.some((prompt) => prompt.id === editingQueuedPromptId && prompt.source !== 'peer')
    ) {
      setEditingQueuedPromptId(undefined)
    }
  }, [editingQueuedPromptId, snapshot.queuedPrompts])

  useEffect(() => {
    panelSliderValueRef.current = snapshot.panel?.slider?.options.find((option) => option.active)?.id
  }, [snapshot.panel?.slider])

  useEffect(() => {
    setTranscriptScroll(0)
  }, [snapshot.activeTurn?.id])

  const menuOpen = snapshot.panel !== undefined || suggestions.length > 0
  useEffect(() => {
    setTerminalMouseMotion(menuOpen, stdout)
    return (): void => {
      setTerminalMouseMotion(false, stdout)
    }
  }, [menuOpen, stdout])

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

  const toggleModelPin = useCallback(
    (modelId: string): void => {
      void controller.toggleModelPin(modelId).then((changed) => {
        if (!changed) {
          return
        }
        const state = viewPropsRef.current
        const rows = filterPanelRows(
          controller.getSnapshot().panel?.rows ?? [],
          state.panelQuery,
          state.panelFilter,
          true
        )
        const selection = Math.max(
          0,
          rows.findIndex((row) => row.value === modelId)
        )
        selectPanelRow(selection, panelRowCapacity('models', state.terminalHeight), rows.length)
      })
    },
    [controller, selectPanelRow]
  )

  const handleMouse = useCallback(
    (mouse: MouseInput): void => {
      if (!shouldProcessMouseInput(mouse, mouseMoveStateRef.current)) {
        return
      }
      const { snapshot, terminalWidth, terminalHeight, suggestions, panelRows } = viewPropsRef.current
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
        if (snapshot.panel?.kind === 'detail') {
          const maxScroll = maxDetailScroll(snapshot.panel, terminalWidth, terminalHeight)
          setDetailScroll((value) => scrollDetail(value, scroll, maxScroll, snapshot.panel?.followTail === true, 3))
        } else if (snapshot.panel?.kind === 'permission') {
          const maxScroll = maxPermissionScroll(snapshot.panel, terminalHeight, terminalWidth)
          setDetailScroll((value) => scrollDetail(value, scroll, maxScroll, false, 3))
        } else if (snapshot.panel) {
          const rows = panelRows ?? []
          const agents = snapshot.panel.kind === 'agents'
          const capacity = agents
            ? agentGridCapacity(terminalWidth, terminalHeight)
            : panelRowCapacity(snapshot.panel.kind, terminalHeight, terminalWidth, rows)
          const nextStart = agents
            ? scrollAgentGridViewport(
                panelViewportStartRef.current,
                scroll,
                rows.length,
                capacity,
                agentGridColumns(terminalWidth)
              )
            : scrollPanelViewport(panelViewportStartRef.current, scroll, rows.length, capacity)
          panelViewportStartRef.current = nextStart
          setPanelViewportStart(nextStart)
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
      const footerAction = !snapshot.panel ? elementAtMouse(footerElements, mouse) : undefined
      const panelRowIndex = snapshot.panel ? elementAtMouse(panelRowElements, mouse) : undefined
      const panelControlTarget =
        snapshot.panel?.kind === 'settings' || snapshot.panel?.kind === 'voice' || snapshot.panel?.kind === 'models'
          ? elementAtMouse(panelControlElements, mouse)
          : undefined
      const panelFilterId = snapshot.panel ? elementAtMouse(panelFilterElements, mouse) : undefined
      const panelPinIndex = snapshot.panel?.kind === 'models' ? elementAtMouse(panelPinElements, mouse) : undefined
      const suggestionIndex =
        !snapshot.panel && suggestions.length > 0 ? elementAtMouse(suggestionElements, mouse) : undefined
      const queuedPromptTarget = !snapshot.panel ? elementAtMouse(queuedPromptElements, mouse) : undefined
      const toolGroupTarget = !snapshot.panel ? elementAtMouse(toolGroupElements, mouse) : undefined
      const sliderElement = snapshot.panel?.kind === 'models' ? panelSliderElement.current : undefined
      const sliderHit = sliderElement ? elementContainsMouse(sliderElement, mouse) : false
      const searchElement = snapshot.panel?.kind === 'models' ? panelSearchElement.current : undefined
      const searchHit = searchElement ? elementContainsMouse(searchElement, mouse) : false
      const frogHit = frogElement.current ? elementContainsMouse(frogElement.current, mouse) : false
      if (mouse.action === 'move' && !leftMouseDownRef.current) {
        setHoveredPanelRow(panelRowIndex)
        setHoveredPanelControl(panelControlTarget)
        setHoveredPanelFilter(panelFilterId)
        setHoveredPanelSlider(sliderHit)
        setHoveredSuggestion(suggestionIndex)
      }
      if (mouse.action === 'press' && button === 0) {
        resetHover()
        setFrog(undefined)
        leftMouseDownRef.current = true
        frogPressRef.current = frogHit ? { column: mouse.column, row: mouse.row } : undefined
        toolGroupPressRef.current = toolGroupTarget
        setScreenSelection([])
        selectionDragRef.current =
          sliderHit || panelControlTarget || toolGroupTarget || queuedPromptTarget
            ? undefined
            : {
                anchor: mouse,
                lines: sanitizeTerminalText(
                  renderToString(
                    createElement(ChatView, {
                      ...viewPropsRef.current,
                      input: currentEditor.input,
                      cursor: currentEditor.cursor,
                      synchronousTranscriptLayout: true,
                    }),
                    { columns: terminalWidth }
                  )
                ).split('\n'),
              }
        setPressedMetadata(metadataTarget)
        setPressedPanelFilter(panelFilterId)
        setPressedPanelRow(panelRowIndex)
        setPressedPanelControl(panelControlTarget)
        setPressedPanelSlider(sliderHit)
        setPressedSuggestion(suggestionIndex)
        setPressedQueuedPrompt(queuedPromptTarget)
        if (sliderHit) {
          setModelPanelFocus('effort')
        } else if (searchHit) {
          setModelPanelFocus('search')
        } else if (panelFilterId) {
          setModelPanelFocus('providers')
        } else if (panelRowIndex !== undefined) {
          setModelPanelFocus('models')
        } else if (panelControlTarget === MODEL_COPY_TARGET) {
          setModelPanelFocus('copy')
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
        const slider = snapshot.panel?.slider
        if (!sliderElement || !slider || slider.disabled) {
          return
        }
        const option = sliderOptionAtMouse(slider, sliderElement, mouse)
        if (!option || option.id === panelSliderValueRef.current) {
          return
        }
        panelSliderValueRef.current = option.id
        void activateRow({
          label: slider.label,
          description: option.label,
          value: `effort:${option.id}`,
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
      if (panelFilterId) {
        if (snapshot.panel?.kind === 'settings' && snapshot.panel.settingsCategory) {
          void activateRow({ label: '', description: '', value: panelFilterId })
        } else {
          setPanelFilter(panelFilterId)
          resetPanelPosition()
        }
      } else if (panelControlTarget) {
        if (panelControlTarget === MODEL_COPY_TARGET) {
          const modelId = panelRows?.[panelSelectionRef.current]?.value
          if (modelId) {
            copyText(modelId)
          }
        } else {
          const target = parsePanelControlTarget(panelControlTarget)
          const row = target ? panelRows?.[target.index] : undefined
          if (!row?.value || !target) {
            return
          }
          void activateRow({
            ...row,
            value: row.control?.kind === 'toggle' ? row.value : `${row.value}=${target.value}`,
          })
        }
      } else if (panelPinIndex !== undefined) {
        const row = panelRows?.[panelPinIndex]
        if (row?.value) {
          toggleModelPin(row.value)
        }
      } else if (panelRowIndex !== undefined) {
        panelSelectionRef.current = panelRowIndex
        setPanelSelection(panelRowIndex)
        const row = panelRows?.[panelRowIndex]
        if (row?.value && (snapshot.panel?.kind !== 'settings' || !row.control)) {
          void activateRow(row)
        }
      } else if (snapshot.panel && !panelHit && !metadataTarget) {
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
        if (target.action === 'steer') {
          controller.steerQueued(target.id)
        } else if (target.action === 'up' || target.action === 'down') {
          controller.moveQueuedPrompt(target.id, target.action === 'up' ? -1 : 1)
        } else {
          const prompt = snapshot.queuedPrompts.find((candidate) => candidate.id === target.id)
          if (prompt && prompt.source !== 'peer') {
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
        void controller.submit(`/${footerAction}`)
      } else if (metadataTarget) {
        void activateMetadataTarget(controller, metadataTarget)
      }
    },
    [
      activateRow,
      copyText,
      controller,
      dispatchPrompt,
      footerElements,
      metadataElements,
      panelControlElements,
      panelFilterElements,
      panelPinElements,
      panelRowElements,
      queuedPromptElements,
      resetHover,
      resetPanelPosition,
      resetPressed,
      setEditor,
      suggestionElements,
      toggleModelPin,
      toolGroupElements,
    ]
  )

  const handleInput = useCallback(
    (character: string, key: Key): void => {
      if (appearanceOpen) return
      const {
        snapshot,
        terminalWidth,
        terminalHeight,
        suggestions,
        panelRows,
        panelQuery,
        panelFilter,
        modelPanelFocus,
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
      setPressedPanelSlider(false)
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

      if (
        snapshot.setupGuide &&
        snapshot.panel?.kind === 'question' &&
        editsSetupAnswer(character, key, currentEditor.input)
      ) {
        const result = reduceInputSequence(currentEditor, character, key, 'idle')
        setEditor(result.state)
        if (result.action === 'submit') {
          void controller.submit(result.prompt)
        }
        return
      }

      if (snapshot.panel) {
        if (snapshot.panel.kind === 'detail') {
          if (key.escape || key.return || key.backspace || key.delete || character === '\u007f') {
            controller.dismissPanel()
            return
          }
          const page = detailPageSize(terminalHeight, snapshot.panel.rows.length)
          const maxScroll = maxDetailScroll(snapshot.panel, terminalWidth, terminalHeight)
          if (key.upArrow) {
            setDetailScroll((value) => scrollDetail(value, -1, maxScroll, snapshot.panel?.followTail === true, 1))
          } else if (key.downArrow) {
            setDetailScroll((value) => scrollDetail(value, 1, maxScroll, snapshot.panel?.followTail === true, 1))
          } else if (key.pageUp) {
            setDetailScroll((value) => scrollDetail(value, -1, maxScroll, snapshot.panel?.followTail === true, page))
          } else if (key.pageDown) {
            setDetailScroll((value) => scrollDetail(value, 1, maxScroll, snapshot.panel?.followTail === true, page))
          } else if (key.home) {
            setDetailScroll(snapshot.panel.followTail ? maxScroll : 0)
          } else if (key.end) {
            setDetailScroll(snapshot.panel.followTail ? 0 : maxScroll)
          }
          return
        }

        const rows = panelRows ?? []
        const rowCapacity =
          snapshot.panel.kind === 'agents'
            ? agentGridCapacity(terminalWidth, terminalHeight)
            : panelRowCapacity(snapshot.panel.kind, terminalHeight, terminalWidth, rows)
        if (snapshot.panel.kind === 'permission' && key.escape) {
          const reject = rows.find((row) => row.tone === 'danger')
          if (reject) {
            void activateRow(reject)
          }
          return
        }
        if (snapshot.panel.kind === 'permission' && (key.pageUp || key.pageDown || key.home || key.end)) {
          const maximum = maxPermissionScroll(snapshot.panel, terminalHeight, terminalWidth)
          if (key.home) {
            setDetailScroll(0)
          } else if (key.end) {
            setDetailScroll(maximum)
          } else {
            setDetailScroll((value) =>
              scrollDetail(value, key.pageUp ? -1 : 1, maximum, false, Math.max(3, terminalHeight - 16))
            )
          }
          return
        }
        if (key.escape) {
          if (panelQuery) {
            setPanelQuery('')
          } else {
            controller.dismissPanel()
          }
          return
        }
        if (snapshot.panel.kind === 'models') {
          if (key.tab) {
            setModelPanelFocus(cycleModelPanelFocus(modelPanelFocus, snapshot.panel, key.shift ? -1 : 1, true))
            return
          }
          if ((key.return || character === ' ') && modelPanelFocus === 'copy') {
            const modelId = rows[Math.min(panelSelectionRef.current, rows.length - 1)]?.value
            if (modelId) {
              copyText(modelId)
            }
            return
          }
          if (character === ' ' && modelPanelFocus === 'models') {
            const selected = rows[Math.min(panelSelectionRef.current, rows.length - 1)]
            if (selected?.value) {
              toggleModelPin(selected.value)
            }
            return
          }
          if (
            modelPanelFocus === 'effort' &&
            snapshot.panel.slider &&
            !snapshot.panel.slider.disabled &&
            (key.leftArrow || key.rightArrow)
          ) {
            const option = adjacentSliderOption(snapshot.panel.slider, key.leftArrow ? -1 : 1)
            if (option) {
              void activateRow({
                label: snapshot.panel.slider.label,
                description: option.label,
                value: `effort:${option.id}`,
              })
            }
            return
          }
          if (modelPanelFocus === 'providers' && snapshot.panel.filters?.length) {
            if (key.upArrow || key.downArrow) {
              setPanelFilter(cyclePanelFilter(snapshot.panel.filters, panelFilter, key.upArrow ? -1 : 1))
              resetPanelPosition()
              return
            }
            if (key.rightArrow) {
              setModelPanelFocus('models')
              return
            }
          }
          if (modelPanelFocus === 'models') {
            if (key.leftArrow && snapshot.panel.filters?.length) {
              setModelPanelFocus('providers')
              return
            }
            if (key.rightArrow) {
              setModelPanelFocus('copy')
              return
            }
            const nextSelection = moveSelection(panelSelectionRef.current, key, rows.length, rowCapacity)
            if (nextSelection !== undefined) {
              selectPanelRow(nextSelection, rowCapacity, rows.length)
              return
            }
          }
          if (modelPanelFocus === 'copy' && key.leftArrow) {
            setModelPanelFocus('models')
            return
          }
          if (modelPanelFocus === 'search') {
            if (key.downArrow) {
              setModelPanelFocus('models')
              return
            }
            if (key.upArrow && snapshot.panel.slider) {
              setModelPanelFocus('effort')
              return
            }
          }
          if (key.backspace || key.delete || character === '\u007f') {
            setModelPanelFocus('search')
            setPanelQuery(graphemes(panelQuery).slice(0, -1).join(''))
            resetPanelPosition()
            return
          }
          if (key.ctrl && character === 'u') {
            setModelPanelFocus('search')
            setPanelQuery('')
            resetPanelPosition()
            return
          }
          if (!key.ctrl && !key.meta && !key.super && character) {
            const clean = sanitizeTerminalText(character).replaceAll('\n', '')
            if (clean) {
              setModelPanelFocus('search')
              setPanelQuery((query) => query + clean)
              resetPanelPosition()
              return
            }
          }
        }
        if (
          key.tab &&
          snapshot.panel.kind === 'settings' &&
          snapshot.panel.settingsCategory &&
          snapshot.panel.filters?.length
        ) {
          const category = cyclePanelFilter(
            snapshot.panel.filters,
            `settings:${snapshot.panel.settingsCategory}`,
            key.shift ? -1 : 1
          )
          void activateRow({ label: '', description: '', value: category })
          return
        }
        if (key.tab && snapshot.panel.filters?.length) {
          setPanelFilter(cyclePanelFilter(snapshot.panel.filters, panelFilter, key.shift ? -1 : 1))
          resetPanelPosition()
          return
        }
        if (
          (snapshot.panel.kind === 'settings' || snapshot.panel.kind === 'voice') &&
          (key.leftArrow || key.rightArrow || (snapshot.panel.kind === 'settings' && (key.upArrow || key.downArrow)))
        ) {
          const selected = rows[Math.min(panelSelectionRef.current, rows.length - 1)]
          if (selected?.value && selected.control?.kind === 'segmented') {
            const { columns } =
              selected.value === 'frogTheme'
                ? settingsThemeLayout(terminalWidth - 4)
                : settingsLayout(terminalWidth - 4, selected.value)
            const index = adjacentSettingOption(selected.control, key, columns)
            const option = index === undefined ? undefined : selected.control.options[index]
            if (option) {
              if (!option.active) {
                void activateRow({
                  ...selected,
                  value: `${selected.value}=${option.value}`,
                })
              }
              return
            }
          }
          if (key.leftArrow || key.rightArrow) {
            return
          }
        }
        if (
          (snapshot.panel.kind === 'settings' ||
            snapshot.panel.kind === 'voice' ||
            snapshot.panel.kind === 'permissions') &&
          character === ' '
        ) {
          const selected = rows[Math.min(panelSelectionRef.current, rows.length - 1)]
          if (selected?.value) {
            void activateRow(selected)
          }
          return
        }
        if (snapshot.panel.kind === 'agents') {
          const nextSelection = moveAgentGridSelection(
            panelSelectionRef.current,
            key,
            rows.length,
            agentGridColumns(terminalWidth),
            rowCapacity
          )
          if (nextSelection !== undefined) {
            panelSelectionRef.current = nextSelection
            setPanelSelection(nextSelection)
            const nextStart = revealAgentGridSelection(
              nextSelection,
              panelViewportStartRef.current,
              rowCapacity,
              rows.length,
              agentGridColumns(terminalWidth)
            )
            panelViewportStartRef.current = nextStart
            setPanelViewportStart(nextStart)
            return
          }
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
          if (snapshot.panel.kind === 'settings' && key.upArrow && nextSelection < panelSelectionRef.current) {
            const row = rows[nextSelection]
            if (row?.value && row.control?.kind === 'segmented') {
              const { columns } =
                row.value === 'frogTheme'
                  ? settingsThemeLayout(terminalWidth - 4)
                  : settingsLayout(terminalWidth - 4, row.value)
              const options = row.control.options
              const active = Math.max(
                0,
                options.findIndex((option) => option.active)
              )
              const lastRow = Math.floor((options.length - 1) / columns) * columns
              const option = options[Math.min(options.length - 1, lastRow + (active % columns))]
              if (option && !option.active) {
                void activateRow({ ...row, value: `${row.value}=${option.value}` })
              }
            }
          }
          selectPanelRow(nextSelection, rowCapacity, rows.length)
          return
        }
        if (snapshot.panel.searchable && (key.backspace || key.delete || character === '\u007f')) {
          setPanelQuery(graphemes(panelQuery).slice(0, -1).join(''))
          resetPanelPosition()
          return
        }
        if (snapshot.panel.searchable && key.ctrl && character === 'u') {
          setPanelQuery('')
          resetPanelPosition()
          return
        }
        if (snapshot.panel.searchable && !key.ctrl && !key.meta && !key.super && character) {
          const clean = sanitizeTerminalText(character).replaceAll('\n', '')
          if (clean) {
            setPanelQuery((query) => query + clean)
            resetPanelPosition()
          }
        }
        return
      }

      if (editingQueuedPromptId && key.escape) {
        setEditingQueuedPromptId(undefined)
        setEditor({
          ...currentEditor,
          input: '',
          cursor: 0,
          historyIndex: currentEditor.history.length,
          draft: '',
        })
        return
      }

      const phase = editingQueuedPromptId ? 'idle' : controller.busy ? 'running' : 'idle'
      if (phase === 'idle' && suggestions.length > 0) {
        if (key.escape) {
          setDismissedSuggestions(currentEditor.input)
          return
        }
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

      const result = reduceInputSequence(currentEditor, character, key, phase)
      if (phase === 'running' && key.ctrl && character === 'g' && !currentEditor.input.trim()) {
        controller.steerQueued()
        return
      }
      setEditor(result.state)
      if (result.action === 'submit') {
        if (editingQueuedPromptId && controller.updateQueuedPrompt(editingQueuedPromptId, result.prompt)) {
          setEditingQueuedPromptId(undefined)
        } else {
          dispatchPrompt(result.prompt)
        }
      } else if (result.action === 'steer') {
        dispatchPrompt(result.prompt, true)
      } else if (result.action === 'cancel') {
        controller.cancel()
      }
    },
    [
      activateRow,
      appearanceOpen,
      controller,
      dispatchPrompt,
      editingQueuedPromptId,
      frog,
      handleMouse,
      resetHover,
      resetPanelPosition,
      selectPanelRow,
      setEditor,
      toggleModelPin,
    ]
  )
  useInput(handleInput)

  return (
    <ChatView
      {...viewProps}
      snapshot={
        previewAppearance ? { ...snapshot, settings: { ...snapshot.settings, ...previewAppearance } } : snapshot
      }
      onActionElement={registerFooterElement}
      {...(appearanceOpen
        ? {
            overlay: (
              <CustomThemeEditor
                settings={snapshot.settings}
                animate={snapshot.settings.animations}
                width={terminal.width}
                height={terminal.height}
                onPreview={setPreviewAppearance}
                onClose={closeAppearance}
                onApply={async (appearance) => {
                  const value = `customTheme=${encodeURIComponent(JSON.stringify(appearance.customTheme))}`
                  const applied = await controller.activatePanelRow({ label: 'Theme', description: '', value })
                  if (!applied) throw new Error('Could not save the theme.')
                }}
              />
            ),
          }
        : {})}
      {...(controller.voice ? { voice: controller.voice } : {})}
      onMaxTranscriptScroll={updateMaxTranscriptScroll}
      onMetadataElement={registerMetadataElement}
      onPanelElement={registerPanelElement}
      onPanelRowElement={registerPanelRowElement}
      onPanelControlElement={registerPanelControlElement}
      onPanelFilterElement={registerPanelFilterElement}
      onPanelPinElement={registerPanelPinElement}
      onPanelSearchElement={registerPanelSearchElement}
      onPanelSliderElement={registerPanelSliderElement}
      onSuggestionElement={registerSuggestionElement}
      {...(pressedMetadata ? { pressedMetadata } : {})}
      {...(pressedPanelFilter ? { pressedPanelFilter } : {})}
      {...(pressedPanelRow !== undefined ? { pressedPanelRow } : {})}
      {...(pressedPanelControl ? { pressedPanelControl } : {})}
      {...(hoveredPanelControl ? { hoveredPanelControl } : {})}
      pressedPanelSlider={pressedPanelSlider}
      {...(pressedSuggestion !== undefined ? { pressedSuggestion } : {})}
      {...(hoveredPanelRow !== undefined ? { hoveredPanelRow } : {})}
      {...(hoveredPanelFilter ? { hoveredPanelFilter } : {})}
      hoveredPanelSlider={hoveredPanelSlider}
      {...(hoveredSuggestion !== undefined ? { hoveredSuggestion } : {})}
      {...(pressedQueuedPrompt ? { pressedQueuedPrompt } : {})}
      {...(editingQueuedPromptId ? { editingQueuedPromptId } : {})}
      {...(frog ? { frog, onFrogComplete: finishFrog } : {})}
      {...(frogBrandAnimationId !== undefined ? { frogBrandAnimationId } : {})}
      selection={screenSelection}
      {...(clipboardNotice ? { clipboardNotice } : {})}
      onQueuedPromptElement={registerQueuedPromptElement}
      onFrogElement={registerFrogElement}
      onToolGroupElement={registerToolGroupElement}
    />
  )
}

function editsSetupAnswer(character: string, key: Key, input: string): boolean {
  if (key.return) {
    return input.trim().length > 0
  }
  if (key.escape || key.tab || key.upArrow || key.downArrow || key.pageUp || key.pageDown) {
    return false
  }
  return Boolean(character || key.backspace || key.delete || key.leftArrow || key.rightArrow || key.home || key.end)
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

function parseQueuedPromptTarget(target: QueuedPromptTarget): { id: string; action: QueuedPromptAction } | undefined {
  const separator = target.lastIndexOf(':')
  const id = target.slice(0, separator)
  const action = target.slice(separator + 1)
  if (!id || (action !== 'edit' && action !== 'up' && action !== 'down' && action !== 'steer')) {
    return undefined
  }
  return { id, action }
}
