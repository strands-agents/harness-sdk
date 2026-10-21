import { useCallback, useMemo, useSyncExternalStore, type ReactElement } from 'react'
import type { DOMElement } from 'ink'

import type {
  ChatAttachmentSummary,
  ChatConfigurationLanguage,
  ChatMcpStartup,
  ChatPanel,
  ChatSnapshot,
  ChatTask,
  ChatTurn,
  ChatVoiceStore,
} from '../chat/controller.js'
import { isActiveTask, isConfigurationTool } from '../chat/controller-helpers.js'
import {
  commandAssistance as commandAssistanceForInput,
  type CommandAssistance,
  type LocalCommandSpec,
} from '../chat/commands.js'
import { composerMaxRows, promptEditorHeight } from '../terminal/composer.js'
import type { ScreenSelectionSegment } from '../terminal/mouse-input.js'
import { VOICE_METER_WIDTH, voiceMeterFill } from '../voice/session.js'
import {
  composerPanelHeight,
  composerStatusRows as countComposerStatusRows,
  configurationDockWidth,
  CONFIG_DOCK_CHROME_HEIGHT,
  CONFIG_DOCK_GAP,
  CONFIG_DOCK_MIN_HEIGHT,
  CONFIG_DOCK_MIN_TERMINAL_WIDTH,
  isComposerPanel,
  isOutlinedComposerPanel,
  MAX_VISIBLE_BACKGROUND_TASKS,
  type MetadataTarget,
  type ModelPanelFocus,
  type SettingsPanelFocus,
} from './interaction.js'
import { PromptEditor, promptContentSize } from './prompt-editor.js'
import { ResourcePanel } from './panels.js'
import { AgentsPanel } from './agents-panel.js'
import { agentGridLayout, clampAgentGridViewport } from './agent-grid.js'
import { CommandPalette } from './command-palette.js'
import { FROG_ANIMATION_HEIGHT, FrogEasterEgg, type FrogVariant } from './frog-easter-egg.js'
import { StartupView, useBrandAnimation } from './startup-view.js'
import { TranscriptViewport } from './transcript.js'
import { PARTY_FRAME_INTERVAL_MS, usePartyFrame } from './use-party-frame.js'
import { useSpinner } from './use-spinner.js'
import { Box, Text, ThemeProvider, useTheme } from './theme.js'
import { ComposerFooter, PanelHelpContext, type FooterAction } from './help-footer.js'
import { FadeIn } from './fade-in.js'
import { isMaxEffort } from './effort-panel.js'
import { attachmentPreviewRows } from './attachment-preview.js'
import { CONFIGURATION_OPEN_CONTROL, ConfigurationDock, passiveConfigurationDockHeight } from './configuration-view.js'
import { VOICE_FROG_HEIGHT, VoiceFrog } from './voice-frog.js'
import { isRecord } from '../values.js'

export type QueuedPromptAction = 'edit' | 'up' | 'down'
export type QueuedPromptTarget = `${string}:${QueuedPromptAction}`

export function ChatView(props: Parameters<typeof ChatViewContent>[0]): ReactElement {
  return (
    <ThemeProvider settings={props.snapshot.settings}>
      <ChatViewContent {...props} />
    </ThemeProvider>
  )
}

function ChatViewContent({
  onActionElement,
  snapshot,
  input,
  cursor,
  terminalWidth = 80,
  terminalHeight = 24,
  commandAssistance,
  suggestions,
  actionableCommandToken,
  suggestionSelection = 0,
  panelSelection = 0,
  panelViewportStart = 0,
  panelQuery = '',
  panelFilter = 'all',
  modelPanelFocus = 'models',
  settingsPanelFocus = 'settings',
  detailScroll = 0,
  dockLanguage,
  dockScroll,
  transcriptScroll = 0,
  onMaxTranscriptScroll,
  pressedMetadata,
  hoveredMetadata,
  hoveredAction,
  availableUpdate,
  pressedPanelFilter,
  hoveredPanelFilter,
  pressedPanelRow,
  hoveredPanelRow,
  pressedPanelControl,
  hoveredPanelControl,
  pressedSuggestion,
  hoveredSuggestion,
  pressedQueuedPrompt,
  editingQueuedPromptId,
  onMetadataElement,
  onPanelElement,
  onDockElement,
  onPanelRowElement,
  onPanelControlElement,
  onPanelFilterElement,
  onPanelSearchElement,
  onPanelSliderElement,
  onSuggestionElement,
  onQueuedPromptElement,
  onFrogElement,
  onJumpToBottomElement,
  hoveredJumpToBottom = false,
  expandedToolGroups,
  onToolGroupElement,
  frogBrandAnimationId,
  introStartedAt,
  panelRows,
  composerHeight,
  frog,
  onFrogComplete,
  selection,
  voice,
  clipboardNotice,
  attachments = [],
  party = false,
  entranceFade = true,
}: {
  onActionElement?: (action: FooterAction, element: DOMElement | null) => void
  snapshot: ChatSnapshot
  input: string
  cursor: number
  terminalWidth?: number
  terminalHeight?: number
  commandAssistance?: CommandAssistance
  suggestions?: readonly LocalCommandSpec[]
  actionableCommandToken?: string
  suggestionSelection?: number
  panelSelection?: number
  panelViewportStart?: number
  panelQuery?: string
  panelFilter?: string
  modelPanelFocus?: ModelPanelFocus
  settingsPanelFocus?: SettingsPanelFocus
  detailScroll?: number
  dockLanguage?: ChatConfigurationLanguage
  dockScroll?: number
  transcriptScroll?: number
  onMaxTranscriptScroll?: (maximum: number) => void
  pressedMetadata?: MetadataTarget
  hoveredMetadata?: MetadataTarget
  hoveredAction?: FooterAction
  availableUpdate?: string
  pressedPanelFilter?: string
  hoveredPanelFilter?: string
  pressedPanelRow?: number
  hoveredPanelRow?: number
  pressedPanelControl?: string
  hoveredPanelControl?: string
  pressedSuggestion?: number
  hoveredSuggestion?: number
  pressedQueuedPrompt?: QueuedPromptTarget
  editingQueuedPromptId?: string
  onMetadataElement?: (target: MetadataTarget, element: DOMElement | null) => void
  onPanelElement?: (element: DOMElement | null) => void
  onDockElement?: (element: DOMElement | null) => void
  onPanelRowElement?: (index: number, element: DOMElement | null) => void
  onPanelControlElement?: (key: string, element: DOMElement | null) => void
  onPanelFilterElement?: (id: string, element: DOMElement | null) => void
  onPanelSearchElement?: (element: DOMElement | null) => void
  onPanelSliderElement?: (element: DOMElement | null) => void
  onSuggestionElement?: (index: number, element: DOMElement | null) => void
  onQueuedPromptElement?: (target: QueuedPromptTarget, element: DOMElement | null) => void
  onFrogElement?: (element: DOMElement | null) => void
  onJumpToBottomElement?: (element: DOMElement | null) => void
  hoveredJumpToBottom?: boolean
  expandedToolGroups?: ReadonlySet<string>
  onToolGroupElement?: (id: string, element: DOMElement | null) => void
  frogBrandAnimationId?: number
  introStartedAt?: number
  /** Skips the command deck's mount fade when the deck was already on screen (controller swap, setup return). */
  entranceFade?: boolean
  panelRows?: ChatPanel['rows']
  composerHeight?: number
  frog?: { id: number; variant: FrogVariant }
  onFrogComplete?: (id: number) => void
  selection?: readonly ScreenSelectionSegment[]
  voice?: ChatVoiceStore
  clipboardNotice?: { status: 'success'; characterCount: number } | { status: 'error' }
  attachments?: readonly ChatAttachmentSummary[]
  party?: boolean
}): ReactElement {
  const { canvas, foreground, accent, panel, selection: selectionBackground } = useTheme()
  const resolvedCommandAssistance =
    commandAssistance ??
    (suggestions === undefined ? commandAssistanceForInput(input, actionableCommandToken) : undefined)
  const resolvedSuggestions = suggestions ?? resolvedCommandAssistance?.completions ?? []
  const hasActivity =
    snapshot.completedTurns.length > 0 || snapshot.activeTurn !== undefined || snapshot.notices.length > 0
  const composerPanel = isComposerPanel(snapshot.panel?.kind) ? snapshot.panel : undefined
  const maxEffort = composerPanel?.kind === 'effort' && isMaxEffort(composerPanel.slider)
  const composerPanelOutlined = isOutlinedComposerPanel(composerPanel)
  const showCommandPicker = resolvedCommandAssistance !== undefined && !snapshot.panel
  const showQueueStatus = snapshot.queuedPrompts.length > 0 || snapshot.status === 'interrupting'
  const showVoiceStatus = snapshot.voice !== undefined && snapshot.voice.status !== 'off'
  const showVoiceFrog =
    snapshot.voice !== undefined && snapshot.voice.status !== 'off' && snapshot.voice.status !== 'error' && !frog
  const activeBackgroundTasks = snapshot.tasks.filter(
    (task) => task.source === 'background' && isActiveTask(task.status)
  )
  const visibleBackgroundTasks = activeBackgroundTasks.slice(0, MAX_VISIBLE_BACKGROUND_TASKS)
  const hiddenBackgroundTasks = activeBackgroundTasks.length - visibleBackgroundTasks.length
  const composerSpinner = useSpinner(Boolean(snapshot.composerStatus), snapshot.settings.animations)
  const backgroundTaskSpinner = useSpinner(activeBackgroundTasks.length > 0, snapshot.settings.animations)
  const mcpStartupSpinner = useSpinner(snapshot.mcpStartup !== undefined, snapshot.settings.animations)
  const partyFrame = usePartyFrame((party || maxEffort) && snapshot.settings.animations)
  const statusRows = countComposerStatusRows(snapshot)
  const canConfigure = snapshot.runtime.tools.some(({ name }) => isConfigurationTool(name))
  const showConfigurationHint =
    canConfigure &&
    !hasActivity &&
    snapshot.status === 'idle' &&
    !snapshot.panel &&
    !showCommandPicker &&
    !snapshot.composerStatus &&
    !clipboardNotice &&
    statusRows === 0
  const composerStatusRows = statusRows + Number(showConfigurationHint)
  const editorWidth = Math.max(1, terminalWidth - 2)
  const suggestionCapacity = Math.max(1, Math.min(5, terminalHeight - composerStatusRows - 10))
  const suggestionRows = showCommandPicker
    ? Math.min(suggestionCapacity, resolvedSuggestions.length) +
      Number(resolvedCommandAssistance.signature !== undefined) +
      Number(resolvedCommandAssistance.message !== undefined) +
      2
    : 0
  const editorMaxRows = composerMaxRows(terminalHeight, composerStatusRows + suggestionRows)
  const editorMaxHeight = Math.max(party ? 3 : 1, terminalHeight - composerStatusRows - suggestionRows - 2)
  const attachmentRows =
    !composerPanel && !snapshot.composerStatus && !snapshot.panel ? attachmentPreviewRows(attachments) : 0
  const editorHeight = composerPanel
    ? (composerHeight ?? composerPanelHeight(snapshot, terminalHeight, party, terminalWidth))
    : Math.min(
        editorMaxHeight,
        promptEditorHeight(
          input,
          cursor,
          editorWidth,
          editorMaxRows,
          Boolean(snapshot.composerStatus || snapshot.panel),
          party,
          Math.max(1, editorMaxHeight - attachmentRows)
        ) + attachmentRows
      )
  const restingEditorHeight = composerPanel
    ? promptEditorHeight('', 0, editorWidth, editorMaxRows, false, party, editorMaxHeight)
    : editorHeight
  const commandDeckHeight = composerStatusRows + restingEditorHeight + 2
  // A composer panel opens at full size and fades in; its contents carry the only animation.
  const expandedCommandDeckHeight = composerStatusRows + suggestionRows + editorHeight + 2
  // The dock stays up after a configuration turn ends, until the next prompt starts a turn.
  const configurationAction = activeConfigurationAction(snapshot.activeTurn ?? snapshot.completedTurns.at(-1))
  const configurationPanel = snapshot.panel?.kind === 'config' ? snapshot.panel : undefined
  const liveConfiguration = snapshot.configuration ?? configurationPanel?.configuration
  const topHeight = Math.max(1, terminalHeight - commandDeckHeight)
  const explicitConfiguration = configurationPanel !== undefined
  // The dock ends above a risen composer panel so its frame stays whole; the passive dock also
  // shrinks to its content, capped at half the available rows, so it stops dominating the screen.
  const dockAvailableHeight = Math.max(1, terminalHeight - expandedCommandDeckHeight)
  const dockHeight =
    explicitConfiguration || liveConfiguration === undefined
      ? dockAvailableHeight
      : passiveConfigurationDockHeight(
          dockAvailableHeight,
          liveConfiguration,
          snapshot.configurationDiffs,
          dockLanguage,
          configurationDockWidth(terminalWidth, false)
        )
  const showConfigurationDock =
    liveConfiguration !== undefined &&
    (explicitConfiguration || configurationAction !== undefined) &&
    (explicitConfiguration || terminalWidth >= CONFIG_DOCK_MIN_TERMINAL_WIDTH) &&
    topHeight >= (explicitConfiguration ? CONFIG_DOCK_CHROME_HEIGHT : CONFIG_DOCK_MIN_HEIGHT)
  const wideConfigurationDock = showConfigurationDock && terminalWidth >= CONFIG_DOCK_MIN_TERMINAL_WIDTH
  const configDockWidth = showConfigurationDock ? configurationDockWidth(terminalWidth, explicitConfiguration) : 0
  const configDockLeft = wideConfigurationDock ? Math.max(0, terminalWidth - 2 - configDockWidth) : 0
  const startupReservedRightWidth = wideConfigurationDock ? configDockWidth + CONFIG_DOCK_GAP : 0
  // The transcript reflows into the space left of the dock instead of running underneath it.
  const transcriptReservedRightWidth = hasActivity ? startupReservedRightWidth : 0
  // A stable header element keeps the memoized transcript from re-rendering on spinner ticks.
  const { settings } = snapshot
  const frogBrandElapsedMs = useBrandAnimation(frogBrandAnimationId, settings.animations)
  const startupView = useMemo(
    () => (
      <StartupView
        terminalWidth={terminalWidth}
        availableHeight={terminalHeight - commandDeckHeight}
        animate={settings.animations}
        reservedRightWidth={startupReservedRightWidth}
        {...(introStartedAt !== undefined ? { introStartedAt } : {})}
        theme={settings.frogTheme}
        partyElapsedMs={partyFrame * PARTY_FRAME_INTERVAL_MS}
        {...(frogBrandAnimationId !== undefined ? { frogBrandElapsedMs } : {})}
        {...(onFrogElement ? { onFrogElement } : {})}
        party={party}
      />
    ),
    [
      terminalWidth,
      terminalHeight,
      commandDeckHeight,
      settings.animations,
      startupReservedRightWidth,
      introStartedAt,
      settings.frogTheme,
      partyFrame,
      frogBrandAnimationId,
      frogBrandElapsedMs,
      onFrogElement,
      party,
    ]
  )
  if (snapshot.panel?.kind === 'agents') {
    const rows = panelRows ?? snapshot.panel.rows
    const { columns, capacity } = agentGridLayout(terminalWidth, terminalHeight)
    const start = clampAgentGridViewport(panelViewportStart, rows.length, capacity, columns)
    return (
      <Box width={terminalWidth} height={terminalHeight} overflow="hidden" position="relative">
        <PanelHelpContext value={snapshot.panel}>
          <AgentsPanel
            panel={snapshot.panel}
            rows={rows.slice(start, start + capacity)}
            selected={panelSelection}
            start={start}
            width={terminalWidth}
            height={terminalHeight}
            {...(pressedPanelRow !== undefined ? { pressedRow: pressedPanelRow } : {})}
            {...(hoveredPanelRow !== undefined ? { hoveredRow: hoveredPanelRow } : {})}
            {...(onPanelElement ? { onPanelElement } : {})}
            {...(onPanelRowElement ? { onRowElement: onPanelRowElement } : {})}
            {...(clipboardNotice
              ? {
                  clipboardNotice:
                    clipboardNotice.status === 'success'
                      ? `${clipboardNotice.characterCount} ${clipboardNotice.characterCount === 1 ? 'char' : 'chars'} copied to clipboard`
                      : 'Clipboard copy failed',
                }
              : {})}
          />
        </PanelHelpContext>
        {selection?.map((segment) => (
          <Box
            key={`${segment.row}:${segment.column}`}
            position="absolute"
            marginLeft={segment.column}
            marginTop={segment.row}
            aria-hidden
          >
            <Text>{`\u001b[7m${segment.text}\u001b[27m`}</Text>
          </Box>
        ))}
      </Box>
    )
  }
  const panelView =
    snapshot.panel && snapshot.panel.kind !== 'config' ? (
      <PanelHelpContext value={snapshot.panel}>
        <ResourcePanel
          panel={snapshot.panel}
          context={snapshot.context}
          settings={snapshot.settings}
          selected={panelSelection}
          viewportStart={panelViewportStart}
          terminalWidth={terminalWidth}
          terminalHeight={terminalHeight}
          {...(composerPanel
            ? {
                composer: promptContentSize(editorWidth, editorHeight, composerPanelOutlined),
              }
            : {})}
          query={panelQuery}
          filter={panelFilter}
          modelPanelFocus={modelPanelFocus}
          settingsPanelFocus={settingsPanelFocus}
          detailScroll={detailScroll}
          rows={panelRows ?? snapshot.panel.rows}
          energyFrame={partyFrame}
          {...(pressedPanelFilter ? { pressedFilter: pressedPanelFilter } : {})}
          {...(hoveredPanelFilter !== undefined ? { hoveredFilter: hoveredPanelFilter } : {})}
          {...(pressedPanelRow !== undefined ? { pressedRow: pressedPanelRow } : {})}
          {...(hoveredPanelRow !== undefined ? { hoveredRow: hoveredPanelRow } : {})}
          {...(pressedPanelControl ? { pressedControl: pressedPanelControl } : {})}
          {...(hoveredPanelControl ? { hoveredControl: hoveredPanelControl } : {})}
          {...(onPanelElement ? { onPanelElement } : {})}
          {...(onPanelRowElement ? { onRowElement: onPanelRowElement } : {})}
          {...(onPanelControlElement ? { onControlElement: onPanelControlElement } : {})}
          {...(onPanelFilterElement ? { onFilterElement: onPanelFilterElement } : {})}
          {...(onPanelSearchElement ? { onSearchElement: onPanelSearchElement } : {})}
          {...(onPanelSliderElement ? { onSliderElement: onPanelSliderElement } : {})}
        />
      </PanelHelpContext>
    ) : null
  return (
    <Box
      flexDirection="column"
      width={Math.max(1, terminalWidth)}
      height={Math.max(1, terminalHeight)}
      paddingX={1}
      overflow="hidden"
      position="relative"
    >
      <Box flexGrow={1} overflowY="hidden" position="relative">
        {!showConfigurationDock || wideConfigurationDock ? (
          <Box
            width="100%"
            flexGrow={1}
            flexDirection="column"
            overflowY="hidden"
            paddingRight={transcriptReservedRightWidth}
          >
            {hasActivity ? (
              <TranscriptViewport
                header={startupView}
                turns={snapshot.completedTurns}
                {...(snapshot.panel?.kind === 'permission'
                  ? { approvalToolName: snapshot.panel.request.toolName }
                  : {})}
                notices={snapshot.notices}
                settings={snapshot.settings}
                scrollOffset={transcriptScroll}
                layoutKey={`${terminalWidth}:${terminalHeight}:${commandDeckHeight}:${transcriptReservedRightWidth}`}
                {...(expandedToolGroups ? { expandedToolGroups } : {})}
                {...(onToolGroupElement ? { onToolGroupElement } : {})}
                {...(onMaxTranscriptScroll ? { onMaxScrollChange: onMaxTranscriptScroll } : {})}
                {...(snapshot.activeTurn ? { activeTurn: snapshot.activeTurn } : {})}
              />
            ) : (
              startupView
            )}
          </Box>
        ) : null}
        {showConfigurationDock && liveConfiguration ? (
          <Box
            position="absolute"
            marginLeft={configDockLeft}
            width={configDockWidth}
            height={dockHeight}
            flexShrink={0}
          >
            <ConfigurationDock
              configuration={liveConfiguration}
              explicit={explicitConfiguration}
              {...(configurationAction ? { configurationDiffs: snapshot.configurationDiffs } : {})}
              {...(configurationPanel
                ? { language: panelFilter, scroll: detailScroll }
                : {
                    ...(dockLanguage ? { language: dockLanguage } : {}),
                    ...(dockScroll !== undefined ? { scroll: dockScroll } : {}),
                  })}
              width={configDockWidth}
              height={dockHeight}
              {...(pressedPanelFilter ? { pressedFilter: pressedPanelFilter } : {})}
              {...(hoveredPanelFilter ? { hoveredFilter: hoveredPanelFilter } : {})}
              pressedOpen={pressedPanelControl === CONFIGURATION_OPEN_CONTROL}
              hoveredOpen={hoveredPanelControl === CONFIGURATION_OPEN_CONTROL}
              onElement={(element: DOMElement | null): void => {
                onDockElement?.(element)
                if (explicitConfiguration) onPanelElement?.(element)
              }}
              {...(onPanelFilterElement ? { onFilterElement: onPanelFilterElement } : {})}
              {...(onPanelControlElement
                ? {
                    onOpenElement: (element: DOMElement | null) =>
                      onPanelControlElement(CONFIGURATION_OPEN_CONTROL, element),
                  }
                : {})}
            />
          </Box>
        ) : null}
      </Box>
      <Box height={commandDeckHeight} flexShrink={0} />
      <FadeIn animate={settings.animations && entranceFade} background={canvas}>
        <Box
          position="absolute"
          marginTop={Math.max(0, terminalHeight - expandedCommandDeckHeight)}
          width="100%"
          height={expandedCommandDeckHeight}
          flexDirection="column"
          backgroundColor={canvas}
        >
          <Box width="100%" flexShrink={0} flexDirection="column">
            {snapshot.pendingSteering.length > 0 ? <SteeringSummary prompts={snapshot.pendingSteering} /> : null}
            {showQueueStatus ? (
              <QueuedPromptSummary
                prompts={snapshot.queuedPrompts}
                interrupting={snapshot.status === 'interrupting'}
                {...(pressedQueuedPrompt ? { pressed: pressedQueuedPrompt } : {})}
                {...(editingQueuedPromptId ? { editingId: editingQueuedPromptId } : {})}
                {...(onQueuedPromptElement ? { onActionElement: onQueuedPromptElement } : {})}
              />
            ) : null}
            {showVoiceStatus ? <VoiceStatus snapshot={snapshot.voice!} {...(voice ? { voice } : {})} /> : null}
            {visibleBackgroundTasks.map((task) => (
              <BackgroundTaskStatus key={task.id} task={task} spinner={backgroundTaskSpinner} />
            ))}
            {hiddenBackgroundTasks > 0 ? (
              <Box height={1} flexShrink={0} paddingX={1} overflow="hidden">
                <Text dimColor>+ {hiddenBackgroundTasks} more background tasks</Text>
              </Box>
            ) : null}
            {snapshot.mcpStartup ? (
              <McpStartupStatus startup={snapshot.mcpStartup} spinner={mcpStartupSpinner} />
            ) : null}
            {showConfigurationHint ? (
              <Box height={1} flexShrink={0} paddingX={1} overflow="hidden">
                <Text dimColor wrap="truncate-end">
                  Ask your agent to change its instructions, tools, or model.
                </Text>
              </Box>
            ) : null}
            {showCommandPicker ? (
              <CommandPalette
                commands={resolvedSuggestions}
                assistance={resolvedCommandAssistance}
                selected={suggestionSelection}
                width={editorWidth}
                capacity={suggestionCapacity}
                {...(pressedSuggestion !== undefined ? { pressed: pressedSuggestion } : {})}
                {...(hoveredSuggestion !== undefined ? { hovered: hoveredSuggestion } : {})}
                {...(onSuggestionElement ? { onRowElement: onSuggestionElement } : {})}
              />
            ) : null}
            <PromptEditor
              input={input}
              cursor={cursor}
              width={editorWidth}
              height={editorHeight}
              maxRows={editorMaxRows}
              maxHeight={editorMaxHeight}
              {...(snapshot.status === 'running' || snapshot.status === 'interrupting'
                ? { placeholder: 'Enter to queue • Ctrl+J for newline • / for commands' }
                : {})}
              {...(actionableCommandToken ? { actionableCommandToken } : {})}
              {...(snapshot.composerStatus ? { busyStatus: `${composerSpinner} ${snapshot.composerStatus}` } : {})}
              {...(snapshot.panel && !composerPanel ? { panelStatus: panelEditorStatus(snapshot.panel) } : {})}
              party={party}
              partyFrame={partyFrame}
              energy={maxEffort}
              energyFrame={partyFrame}
              transparent={composerPanel !== undefined && !composerPanelOutlined}
              attachments={attachments}
            >
              {composerPanel ? panelView : null}
            </PromptEditor>
          </Box>
          <ComposerFooter
            snapshot={snapshot}
            width={editorWidth}
            {...(hoveredAction !== undefined ? { hoveredAction } : {})}
            {...(availableUpdate ? { availableUpdate } : {})}
            {...(pressedMetadata ? { pressed: pressedMetadata } : {})}
            {...(hoveredMetadata ? { hovered: hoveredMetadata } : {})}
            {...(onMetadataElement ? { onMetadataElement } : {})}
            {...(onActionElement ? { onActionElement } : {})}
          />
        </Box>
      </FadeIn>
      {snapshot.panel && snapshot.panel.kind !== 'config' && !composerPanel ? (
        <FadeIn key={snapshot.panel.kind} animate={settings.animations} background={canvas}>
          {panelView}
        </FadeIn>
      ) : null}
      {showVoiceFrog && terminalHeight - expandedCommandDeckHeight >= VOICE_FROG_HEIGHT ? (
        <VoiceFrog
          snapshot={snapshot.voice!}
          {...(voice ? { voice } : {})}
          width={Math.max(1, terminalWidth - 2)}
          top={Math.max(0, terminalHeight - expandedCommandDeckHeight - VOICE_FROG_HEIGHT)}
          animate={snapshot.settings.animations}
          theme={snapshot.settings.frogTheme}
        />
      ) : null}
      {frog && onFrogComplete ? (
        <FrogEasterEgg
          key={frog.id}
          animationId={frog.id}
          variant={frog.variant}
          width={terminalWidth - 2}
          top={Math.max(0, terminalHeight - commandDeckHeight - FROG_ANIMATION_HEIGHT)}
          animate={snapshot.settings.animations}
          theme={snapshot.settings.frogTheme}
          onComplete={onFrogComplete}
        />
      ) : null}
      {selection?.map((segment) => (
        <Box
          key={`${segment.row}:${segment.column}`}
          position="absolute"
          marginLeft={segment.column - 1}
          marginTop={segment.row}
          aria-hidden
        >
          <Text>{`\u001b[7m${segment.text}\u001b[27m`}</Text>
        </Box>
      ))}
      {hasActivity && transcriptScroll > 0 && !snapshot.panel ? (
        <Box
          position="absolute"
          width="100%"
          marginTop={Math.max(0, terminalHeight - expandedCommandDeckHeight - 1)}
          justifyContent="center"
        >
          <Box
            {...(onJumpToBottomElement ? { ref: onJumpToBottomElement } : {})}
            paddingX={1}
            flexShrink={0}
            backgroundColor={hoveredJumpToBottom ? selectionBackground : panel}
          >
            <Text color={hoveredJumpToBottom ? accent : foreground}>Jump to bottom ↓</Text>
          </Box>
        </Box>
      ) : null}
      {clipboardNotice ? (
        <Box
          position="absolute"
          width="100%"
          marginTop={Math.max(0, terminalHeight - expandedCommandDeckHeight - 1)}
          paddingRight={1}
          justifyContent="flex-end"
        >
          <Text dimColor>
            {clipboardNotice.status === 'success'
              ? `${clipboardNotice.characterCount} ${clipboardNotice.characterCount === 1 ? 'char' : 'chars'} copied to clipboard`
              : 'Clipboard copy failed'}
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}

function McpStartupStatus({ startup, spinner }: { startup: ChatMcpStartup; spinner: string }): ReactElement {
  const { foreground, error } = useTheme()
  if (startup.settled) {
    const plural = startup.failed === 1 ? 'server' : 'servers'
    return (
      <Box height={1} flexShrink={0} paddingX={1} overflow="hidden">
        <Text color={error} wrap="truncate-end">
          ✗ {startup.failed} MCP {plural} failed to connect (see /mcp)
        </Text>
      </Box>
    )
  }
  const done = startup.connected + startup.failed
  return (
    <Box height={1} flexShrink={0} paddingX={1} overflow="hidden">
      <Text wrap="truncate-end">
        <Text color={foreground} dimColor>
          {spinner} MCP servers connecting… ({done}/{startup.total})
        </Text>
        {startup.failed > 0 ? <Text color={error}> · {startup.failed} failed</Text> : null}
      </Text>
    </Box>
  )
}

function BackgroundTaskStatus({ task, spinner }: { task: ChatTask; spinner: string }): ReactElement {
  const { warning } = useTheme()
  const status =
    task.status === 'paused' ? 'waiting' : task.status === 'queued' || task.status === 'pending' ? 'queued' : 'running'
  return (
    <Box height={1} flexShrink={0} paddingX={1} overflow="hidden">
      <Text color={warning} wrap="truncate-end">
        {spinner} Background task {status} ({task.label}) - {task.id}
      </Text>
    </Box>
  )
}

function VoiceStatus({
  snapshot: fallbackSnapshot,
  voice,
}: {
  snapshot: NonNullable<ChatSnapshot['voice']>
  voice?: ChatVoiceStore
}): ReactElement {
  const { warning, accent } = useTheme()
  const getSnapshot = voice?.getSnapshot ?? ((): NonNullable<ChatSnapshot['voice']> => fallbackSnapshot)
  const snapshot = useSyncExternalStore(voice?.subscribe ?? emptySubscribe, getSnapshot, getSnapshot)
  const presentation = {
    connecting: { marker: '◐', label: 'Voice connecting', color: warning },
    listening: { marker: '●', label: 'Voice', color: accent },
    hearing: { marker: '◉', label: 'Voice', color: accent },
    speaking: { marker: '▶', label: 'Voice speaking', color: accent },
    muted: { marker: '○', label: 'Voice muted', color: 'gray' },
    interrupted: { marker: '◇', label: 'Voice interrupted', color: warning },
    error: { marker: '×', label: 'Voice error', color: 'red' },
    off: { marker: '○', label: 'Voice off', color: 'gray' },
  }[snapshot.status]
  const showsMeter = snapshot.status === 'listening' || snapshot.status === 'hearing'
  const filled = voiceMeterFill(snapshot.inputLevel)
  const shortcut =
    snapshot.status === 'muted'
      ? 'Tap Space to unmute'
      : snapshot.status === 'connecting' || snapshot.status === 'error' || snapshot.status === 'off'
        ? undefined
        : 'Tap Space to mute'
  return (
    <Box height={1} flexShrink={0} paddingX={1} overflow="hidden">
      <Text color={presentation.color}>
        {presentation.marker} {presentation.label}
      </Text>
      {showsMeter ? (
        <>
          <Text color={accent}> {'▮'.repeat(filled)}</Text>
          <Text dimColor>{'·'.repeat(VOICE_METER_WIDTH - filled)}</Text>
        </>
      ) : null}
      {shortcut ? <Text dimColor> · {shortcut}</Text> : null}
    </Box>
  )
}

function emptySubscribe(): () => void {
  return () => {}
}

function SteeringSummary({ prompts }: { prompts: ChatSnapshot['pendingSteering'] }): ReactElement {
  const { warning } = useTheme()
  return (
    <Box flexDirection="column" flexShrink={0} overflow="hidden">
      {prompts.map((prompt, index) => (
        <Box key={`${index}:${prompt}`} height={1} flexShrink={0} paddingX={1} overflow="hidden">
          <Text wrap="truncate-end">
            <Text color={warning}>↳ Steering{prompts.length > 1 ? ` ${index + 1}/${prompts.length}` : ''}</Text>
            <Text dimColor> · {prompt.replaceAll('\n', ' ')}</Text>
          </Text>
        </Box>
      ))}
    </Box>
  )
}

function QueuedPromptSummary({
  prompts,
  interrupting,
  pressed,
  editingId,
  onActionElement,
}: {
  prompts: ChatSnapshot['queuedPrompts']
  interrupting: boolean
  pressed?: QueuedPromptTarget
  editingId?: string
  onActionElement?: (target: QueuedPromptTarget, element: DOMElement | null) => void
}): ReactElement {
  const { warning, accent } = useTheme()
  const userPrompts = prompts.filter((prompt) => prompt.source !== 'peer')
  return (
    <Box flexDirection="column" flexShrink={0} overflow="hidden">
      {prompts.length === 0 ? (
        <Box height={1} paddingX={1}>
          <Text color={warning}>◇ Interrupting</Text>
        </Box>
      ) : (
        prompts.map((prompt, index) => {
          const userIndex = prompt.source === 'peer' ? -1 : userPrompts.findIndex((item) => item.id === prompt.id)
          const prefix =
            index === 0
              ? interrupting
                ? `◇ Interrupting · ${index + 1}/${prompts.length}`
                : prompts.length === 1
                  ? '◇ Queued'
                  : `◇ Queued ${index + 1}/${prompts.length}`
              : `  Queued ${index + 1}/${prompts.length}`
          const label =
            prompt.source === 'peer'
              ? `Message from ${prompt.from ?? 'agent'}: ${prompt.prompt}`
              : editingId === prompt.id
                ? `${queuedPromptLabel(prompt)} · editing`
                : queuedPromptLabel(prompt)
          return (
            <Box key={prompt.id} height={1} flexShrink={0} paddingX={1} overflow="hidden">
              <Box flexShrink={1} overflow="hidden">
                <Text wrap="truncate-end">
                  <Text color={index === 0 && interrupting ? warning : accent}>{prefix}</Text>
                  <Text dimColor> · {label.replaceAll('\n', ' ')}</Text>
                </Text>
              </Box>
              {prompt.source !== 'peer' ? (
                <Box flexShrink={0}>
                  {(
                    [
                      { target: `${prompt.id}:up`, label: '↑', disabled: userIndex === 0 },
                      { target: `${prompt.id}:down`, label: '↓', disabled: userIndex === userPrompts.length - 1 },
                      { target: `${prompt.id}:edit`, label: 'Edit', active: editingId === prompt.id },
                    ] as const
                  ).map((button) => (
                    <QueueButton
                      key={button.target}
                      {...button}
                      {...(pressed ? { pressed } : {})}
                      {...(onActionElement ? { onElement: onActionElement } : {})}
                    />
                  ))}
                </Box>
              ) : null}
            </Box>
          )
        })
      )}
    </Box>
  )
}

function queuedPromptLabel(prompt: ChatSnapshot['queuedPrompts'][number]): string {
  const files = prompt.attachments?.length
  if (!files) {
    return prompt.prompt
  }
  const attachmentLabel = `${files} attached ${files === 1 ? 'file' : 'files'}`
  return prompt.prompt ? `${prompt.prompt} · ${attachmentLabel}` : attachmentLabel
}

function QueueButton({
  target,
  label,
  disabled = false,
  active = false,
  pressed,
  onElement,
}: {
  target: QueuedPromptTarget
  label: string
  disabled?: boolean
  active?: boolean
  pressed?: QueuedPromptTarget
  onElement?: (target: QueuedPromptTarget, element: DOMElement | null) => void
}): ReactElement {
  const { warning, accent, panel, selection, surface } = useTheme()
  const registerElement = useCallback(
    (element: DOMElement | null): void => {
      onElement?.(target, element)
    },
    [onElement, target]
  )
  return (
    <Box
      {...(!disabled && onElement ? { ref: registerElement } : {})}
      flexShrink={0}
      marginLeft={1}
      paddingX={1}
      backgroundColor={disabled ? panel : pressed === target ? selection : active ? warning : accent}
    >
      <Text {...(!disabled ? { color: surface } : {})} dimColor={disabled} bold={!disabled}>
        {label}
      </Text>
    </Box>
  )
}

function panelEditorStatus(panel: ChatPanel): string {
  if (panel.kind === 'config' && panel.configuration.project) {
    return 'Viewing Configuration · E open'
  }
  return `Viewing ${panel.title}`
}

function activeConfigurationAction(turn: ChatTurn | undefined): string | undefined {
  if (!turn) return undefined
  for (let index = turn.entries.length - 1; index >= 0; index--) {
    const entry = turn.entries[index]
    if (entry?.type !== 'tool' || !isConfigurationTool(entry.name)) continue
    if (isRecord(entry.input)) {
      const action = entry.input.action
      if (typeof action === 'string') return action
    }
    return 'active'
  }
  return undefined
}
