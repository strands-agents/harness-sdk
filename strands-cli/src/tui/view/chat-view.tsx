import { useCallback, useMemo, useSyncExternalStore, type ReactElement, type ReactNode } from 'react'
import type { DOMElement } from 'ink'

import type { ChatPanel, ChatSnapshot, ChatTask, ChatVoiceStore } from '../chat/controller.js'
import { isActiveTask } from '../chat/controller-helpers.js'
import {
  commandAssistance as commandAssistanceForInput,
  type CommandAssistance,
  type LocalCommandSpec,
} from '../chat/commands.js'
import { composerMaxRows, promptEditorHeight } from '../terminal/composer.js'
import type { ScreenSelectionSegment } from '../terminal/mouse-input.js'
import { VOICE_METER_WIDTH, voiceMeterFill } from '../voice/session.js'
import type { MetadataTarget, ModelPanelFocus } from './interaction.js'
import { PromptEditor } from './prompt-editor.js'
import { EffortPanel } from './effort-panel.js'
import { ResourcePanel } from './panels.js'
import { CommandPalette } from './command-palette.js'
import { FROG_ANIMATION_HEIGHT, FrogEasterEgg, type FrogVariant } from './frog-easter-egg.js'
import { StartupView, useBrandAnimation } from './startup-view.js'
import { TranscriptViewport } from './transcript.js'
import { PARTY_FRAME_INTERVAL_MS, usePartyFrame } from './use-party-frame.js'
import { useSpinner } from './use-spinner.js'
import { Box, Text, ThemeProvider, useTheme } from './theme.js'
import { ComposerFooter, PanelHelpContext } from './help-footer.js'
import { FadeIn } from './fade-in.js'

const MAX_VISIBLE_BACKGROUND_TASKS = 4

export type QueuedPromptAction = 'edit' | 'up' | 'down' | 'steer'
export type QueuedPromptTarget = `${string}:${QueuedPromptAction}`

export function ChatView(props: Parameters<typeof ChatViewContent>[0]): ReactElement {
  return (
    <ThemeProvider settings={props.snapshot.settings}>
      <ChatViewContent {...props} />
    </ThemeProvider>
  )
}

function ChatViewContent({
  overlay,
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
  detailScroll = 0,
  transcriptScroll = 0,
  onMaxTranscriptScroll,
  pressedMetadata,
  hoveredMetadata,
  settingsHovered,
  pressedPanelFilter,
  hoveredPanelFilter,
  pressedPanelRow,
  hoveredPanelRow,
  pressedPanelControl,
  hoveredPanelControl,
  pressedPanelSlider = false,
  hoveredPanelSlider,
  pressedSuggestion,
  hoveredSuggestion,
  pressedQueuedPrompt,
  editingQueuedPromptId,
  onMetadataElement,
  onPanelElement,
  onPanelRowElement,
  onPanelControlElement,
  onPanelFilterElement,
  onPanelSearchElement,
  onPanelSliderElement,
  onSuggestionElement,
  onQueuedPromptElement,
  onFrogElement,
  expandedToolGroups,
  onToolGroupElement,
  frogBrandAnimationId,
  introStartedAt,
  panelRows,
  frog,
  onFrogComplete,
  selection,
  voice,
  clipboardNotice,
  party = false,
}: {
  overlay?: ReactNode
  onActionElement?: (action: 'settings' | 'setup' | 'help', element: DOMElement | null) => void
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
  detailScroll?: number
  transcriptScroll?: number
  onMaxTranscriptScroll?: (maximum: number) => void
  pressedMetadata?: MetadataTarget
  hoveredMetadata?: MetadataTarget
  settingsHovered?: boolean
  pressedPanelFilter?: string
  hoveredPanelFilter?: string
  pressedPanelRow?: number
  hoveredPanelRow?: number
  pressedPanelControl?: string
  hoveredPanelControl?: string
  pressedPanelSlider?: boolean
  hoveredPanelSlider?: boolean
  pressedSuggestion?: number
  hoveredSuggestion?: number
  pressedQueuedPrompt?: QueuedPromptTarget
  editingQueuedPromptId?: string
  onMetadataElement?: (target: MetadataTarget, element: DOMElement | null) => void
  onPanelElement?: (element: DOMElement | null) => void
  onPanelRowElement?: (index: number, element: DOMElement | null) => void
  onPanelControlElement?: (key: string, element: DOMElement | null) => void
  onPanelFilterElement?: (id: string, element: DOMElement | null) => void
  onPanelSearchElement?: (element: DOMElement | null) => void
  onPanelSliderElement?: (element: DOMElement | null) => void
  onSuggestionElement?: (index: number, element: DOMElement | null) => void
  onQueuedPromptElement?: (target: QueuedPromptTarget, element: DOMElement | null) => void
  onFrogElement?: (element: DOMElement | null) => void
  expandedToolGroups?: ReadonlySet<string>
  onToolGroupElement?: (id: string, element: DOMElement | null) => void
  frogBrandAnimationId?: number
  introStartedAt?: number
  panelRows?: ChatPanel['rows']
  frog?: { id: number; variant: FrogVariant }
  onFrogComplete?: (id: number) => void
  selection?: readonly ScreenSelectionSegment[]
  voice?: ChatVoiceStore
  clipboardNotice?: { status: 'success'; characterCount: number } | { status: 'error' }
  party?: boolean
}): ReactElement {
  const { surface, background, canvas } = useTheme()
  const resolvedCommandAssistance =
    commandAssistance ??
    (suggestions === undefined ? commandAssistanceForInput(input, actionableCommandToken) : undefined)
  const resolvedSuggestions = suggestions ?? resolvedCommandAssistance?.completions ?? []
  const hasActivity =
    snapshot.completedTurns.length > 0 || snapshot.activeTurn !== undefined || snapshot.notices.length > 0
  const effortSlider = snapshot.panel?.kind === 'effort' ? snapshot.panel.slider : undefined
  const showCommandPicker = resolvedCommandAssistance !== undefined && !snapshot.panel && !snapshot.activeTurn
  const showQueueStatus = snapshot.queuedPrompts.length > 0 || snapshot.status === 'interrupting'
  const showVoiceStatus = snapshot.voice !== undefined && snapshot.voice.status !== 'off'
  const activeBackgroundTasks = snapshot.tasks.filter(
    (task) => task.source === 'background' && isActiveTask(task.status)
  )
  const visibleBackgroundTasks = activeBackgroundTasks.slice(0, MAX_VISIBLE_BACKGROUND_TASKS)
  const hiddenBackgroundTasks = activeBackgroundTasks.length - visibleBackgroundTasks.length
  const composerSpinner = useSpinner(Boolean(snapshot.composerStatus), snapshot.settings.animations)
  const backgroundTaskSpinner = useSpinner(activeBackgroundTasks.length > 0, snapshot.settings.animations)
  const partyFrame = usePartyFrame(party && snapshot.settings.animations)
  const queueStatusRows = showQueueStatus ? Math.max(1, snapshot.queuedPrompts.length) : 0
  const composerStatusRows =
    queueStatusRows + Number(showVoiceStatus) + visibleBackgroundTasks.length + Number(hiddenBackgroundTasks > 0)
  const editorWidth = Math.max(1, terminalWidth - 2)
  const suggestionCapacity = Math.max(1, Math.min(5, terminalHeight - composerStatusRows - 10))
  const suggestionRows = showCommandPicker
    ? Math.min(suggestionCapacity, resolvedSuggestions.length) +
      Number(resolvedCommandAssistance.signature !== undefined) +
      Number(resolvedCommandAssistance.message !== undefined) +
      1
    : 0
  const editorMaxRows = composerMaxRows(terminalHeight, composerStatusRows + suggestionRows)
  const editorMaxHeight = Math.max(party ? 3 : 1, terminalHeight - composerStatusRows - suggestionRows - 2)
  const commandDeckHeight =
    composerStatusRows +
    suggestionRows +
    promptEditorHeight(
      input,
      cursor,
      editorWidth,
      editorMaxRows,
      Boolean(!effortSlider && (snapshot.composerStatus || snapshot.panel)),
      party,
      editorMaxHeight
    ) +
    2
  // A stable header element keeps the memoized transcript from re-rendering on spinner ticks.
  const { settings } = snapshot
  const frogBrandElapsedMs = useBrandAnimation(frogBrandAnimationId, settings.animations)
  const startupView = useMemo(
    () => (
      <StartupView
        terminalWidth={terminalWidth}
        availableHeight={terminalHeight - commandDeckHeight}
        animate={settings.animations}
        {...(introStartedAt !== undefined ? { introStartedAt } : {})}
        theme={settings.frogTheme}
        customBase={settings.customTheme.base}
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
      introStartedAt,
      settings.frogTheme,
      settings.customTheme.base,
      partyFrame,
      frogBrandAnimationId,
      frogBrandElapsedMs,
      onFrogElement,
      party,
    ]
  )
  return (
    <Box
      flexDirection="column"
      width={Math.max(1, terminalWidth)}
      height={Math.max(1, terminalHeight)}
      paddingX={1}
      overflow="hidden"
      position="relative"
      backgroundColor={canvas}
    >
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        {hasActivity ? (
          <TranscriptViewport
            header={startupView}
            turns={snapshot.completedTurns}
            notices={snapshot.notices}
            settings={snapshot.settings}
            scrollOffset={transcriptScroll}
            layoutKey={`${terminalWidth}:${terminalHeight}:${commandDeckHeight}`}
            {...(expandedToolGroups ? { expandedToolGroups } : {})}
            {...(onToolGroupElement ? { onToolGroupElement } : {})}
            {...(onMaxTranscriptScroll ? { onMaxScrollChange: onMaxTranscriptScroll } : {})}
            {...(snapshot.activeTurn ? { activeTurn: snapshot.activeTurn } : {})}
          />
        ) : (
          startupView
        )}
      </Box>
      <FadeIn animate={settings.animations} background={background}>
        <Box width="100%" flexShrink={0} flexDirection="column" backgroundColor={surface}>
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
            animateCursor={settings.animations}
            width={editorWidth}
            maxRows={editorMaxRows}
            maxHeight={editorMaxHeight}
            {...(actionableCommandToken ? { actionableCommandToken } : {})}
            {...(snapshot.composerStatus ? { busyStatus: `${composerSpinner} ${snapshot.composerStatus}` } : {})}
            {...(snapshot.panel ? { panelStatus: panelEditorStatus(snapshot.panel) } : {})}
            party={party}
            partyFrame={partyFrame}
          >
            {effortSlider && snapshot.panel ? (
              <EffortPanel
                panel={snapshot.panel}
                slider={effortSlider}
                width={Math.max(1, editorWidth - 2 - (party ? 2 : 0))}
                {...(onPanelElement ? { onElement: onPanelElement } : {})}
                {...(onPanelSliderElement ? { onSliderElement: onPanelSliderElement } : {})}
              />
            ) : null}
          </PromptEditor>
        </Box>
        <ComposerFooter
          snapshot={snapshot}
          width={editorWidth}
          {...(settingsHovered !== undefined ? { settingsHovered } : {})}
          {...(pressedMetadata ? { pressed: pressedMetadata } : {})}
          {...(hoveredMetadata ? { hovered: hoveredMetadata } : {})}
          {...(onMetadataElement ? { onMetadataElement } : {})}
          {...(onActionElement ? { onActionElement } : {})}
        />
      </FadeIn>
      {snapshot.panel && !effortSlider ? (
        <FadeIn key={snapshot.panel.kind} animate={settings.animations} background={background}>
          <PanelHelpContext value={snapshot.panel}>
            <ResourcePanel
              panel={snapshot.panel}
              context={snapshot.context}
              settings={snapshot.settings}
              selected={panelSelection}
              viewportStart={panelViewportStart}
              terminalWidth={terminalWidth}
              terminalHeight={terminalHeight}
              query={panelQuery}
              filter={panelFilter}
              modelPanelFocus={modelPanelFocus}
              detailScroll={detailScroll}
              rows={panelRows ?? snapshot.panel.rows}
              {...(pressedPanelFilter ? { pressedFilter: pressedPanelFilter } : {})}
              {...(hoveredPanelFilter !== undefined ? { hoveredFilter: hoveredPanelFilter } : {})}
              {...(pressedPanelRow !== undefined ? { pressedRow: pressedPanelRow } : {})}
              {...(hoveredPanelRow !== undefined ? { hoveredRow: hoveredPanelRow } : {})}
              {...(pressedPanelControl ? { pressedControl: pressedPanelControl } : {})}
              {...(hoveredPanelControl ? { hoveredControl: hoveredPanelControl } : {})}
              pressedSlider={pressedPanelSlider}
              {...(hoveredPanelSlider !== undefined ? { hoveredSlider: hoveredPanelSlider } : {})}
              {...(onPanelElement ? { onPanelElement } : {})}
              {...(onPanelRowElement ? { onRowElement: onPanelRowElement } : {})}
              {...(onPanelControlElement ? { onControlElement: onPanelControlElement } : {})}
              {...(onPanelFilterElement ? { onFilterElement: onPanelFilterElement } : {})}
              {...(onPanelSearchElement ? { onSearchElement: onPanelSearchElement } : {})}
              {...(onPanelSliderElement ? { onSliderElement: onPanelSliderElement } : {})}
            />
          </PanelHelpContext>
        </FadeIn>
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
          customBase={snapshot.settings.customTheme.base}
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
      {clipboardNotice ? (
        <Box
          position="absolute"
          width="100%"
          marginTop={Math.max(0, terminalHeight - commandDeckHeight - 1)}
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
      {overlay}
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
                ? `${prompt.prompt} · editing`
                : prompt.prompt
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
                      { target: `${prompt.id}:steer`, label: 'Steer' },
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
  const { hover, warning, accent, panel, surface } = useTheme()
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
      backgroundColor={disabled ? panel : pressed === target ? hover : active ? warning : accent}
    >
      <Text {...(!disabled ? { color: surface } : {})} dimColor={disabled} bold={!disabled}>
        {label}
      </Text>
    </Box>
  )
}

function panelEditorStatus(panel: ChatPanel): string {
  if (panel.kind === 'error') {
    return 'Esc to dismiss'
  }
  return panel.kind === 'permission' ? 'Permission required' : `Viewing ${panel.title}`
}
