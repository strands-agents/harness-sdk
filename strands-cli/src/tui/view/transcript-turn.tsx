import { memo, type ReactElement } from 'react'
import { Box, type DOMElement } from 'ink'

import type { ChatEntry, ChatSnapshot, ChatTurn } from '../chat/controller.js'
import { Markdown } from './markdown.js'
import { MediaView, ToolResultContentView } from './media.js'
import {
  backgroundTaskDispatch,
  formatValue,
  formatTurnMetrics,
  isBackgroundAgent,
  sentPeerMessage,
  summarizeToolInput,
  summarizeToolResult,
  toolAction,
} from './presentation.js'
import { useSpinner } from './use-spinner.js'
import { Text, useTheme } from './theme.js'

export function TurnView({
  turn,
  settings,
  active = false,
  expandedToolGroups,
  onToolGroupElement,
}: {
  turn: ChatTurn
  settings: ChatSnapshot['settings']
  active?: boolean
  expandedToolGroups: ReadonlySet<string>
  onToolGroupElement?: (id: string, element: DOMElement | null) => void
}): ReactElement {
  const theme = useTheme()
  const silentOpening = turn.prompt === '' && turn.source === undefined
  const spinner = useSpinner(active && turn.status === 'running' && !silentOpening, settings.animations)
  const directShell = turn.prompt.trimStart().startsWith('!')
  const visibleEntries = silentOpening
    ? turn.entries.filter((entry) => entry.type === 'assistant' || entry.type === 'media')
    : turn.entries
  const entries = settings.toolOutput === 'hidden' ? visibleEntries : groupToolEntries(visibleEntries)
  const firstEntry = entries.find((entry) => entry.type !== 'reasoning' || settings.showReasoning)
  const startsWithTool = firstEntry?.type === 'tool' || firstEntry?.type === 'toolGroup'
  return (
    <Box flexDirection="column" marginBottom={1}>
      {turn.prompt && turn.source !== 'background' ? (
        <Box
          width="100%"
          flexDirection="column"
          paddingX={1}
          marginBottom={startsWithTool && settings.transcriptSpacing === 'compact' ? 1 : 0}
          backgroundColor={theme.surface}
        >
          {turn.source === 'peer' ? (
            <Text bold>
              <Text color={theme.accent}>◆</Text> Message from {turn.peer?.name ?? 'agent'}
            </Text>
          ) : null}
          <Text>{turn.prompt}</Text>
        </Box>
      ) : null}
      {entries.map((entry) =>
        entry.type === 'toolGroup' ? (
          <ToolActivityGroup
            key={entry.id}
            entries={entry.entries}
            spinner={spinner}
            settings={settings}
            agentName={turn.agentName}
            forceFullResult={directShell}
            expanded={expandedToolGroups.has(entry.id)}
            {...(onToolGroupElement ? { onElement: onToolGroupElement } : {})}
          />
        ) : (
          <EntryView
            key={entry.id}
            entry={entry}
            spinner={spinner}
            settings={settings}
            agentName={turn.agentName}
            forceFullResult={directShell}
            expanded={expandedToolGroups.has(`${entry.id}:output`)}
            {...(onToolGroupElement ? { onElement: onToolGroupElement } : {})}
          />
        )
      )}
      {active && turn.status === 'running' && !silentOpening ? (
        <Box marginTop={1}>
          <Text color={theme.warning}>
            {spinner}{' '}
            {turn.source === 'background'
              ? 'Reviewing background result (esc to interrupt)'
              : turn.source === 'peer'
                ? `Responding to ${turn.peer?.name ?? 'agent'} (esc to interrupt)`
                : 'Working (esc to interrupt)'}
          </Text>
        </Box>
      ) : null}
      {turn.status === 'cancelled' ? <Text color="yellow">Cancelled</Text> : null}
      {turn.status === 'error' ? <Text color="red">Error: {turn.error}</Text> : null}
      {turn.stopReason === 'maxTokens' ? (
        <Text color="yellow">Response reached its output limit.</Text>
      ) : turn.stopReason && !['endTurn', 'end_turn', 'cancelled'].includes(turn.stopReason) ? (
        <Text dimColor>Stopped: {turn.stopReason}</Text>
      ) : null}
      {!silentOpening && (turn.durationMs !== undefined || turn.usage) ? (
        <Box marginTop={1}>
          <Text dimColor>{formatTurnMetrics(turn.durationMs, turn.usage?.totalTokens)}</Text>
        </Box>
      ) : null}
    </Box>
  )
}

export const CompletedTurnView = memo(
  TurnView,
  (previous, next) =>
    previous.turn === next.turn &&
    previous.settings.transcriptSpacing === next.settings.transcriptSpacing &&
    previous.settings.animations === next.settings.animations &&
    previous.settings.showReasoning === next.settings.showReasoning &&
    previous.settings.toolOutput === next.settings.toolOutput &&
    previous.expandedToolGroups === next.expandedToolGroups
)

type ToolEntry = Extract<ChatEntry, { type: 'tool' }>
type TranscriptEntry =
  | ChatEntry
  | {
      id: string
      type: 'toolGroup'
      entries: readonly ToolEntry[]
    }

function groupToolEntries(entries: readonly ChatEntry[]): TranscriptEntry[] {
  const grouped: TranscriptEntry[] = []
  let tools: ToolEntry[] = []
  const flushTools = (): void => {
    if (tools.length === 1) {
      grouped.push(tools[0]!)
    } else if (tools.length > 1) {
      grouped.push({ id: tools[0]!.id, type: 'toolGroup', entries: tools })
    }
    tools = []
  }
  for (const entry of entries) {
    if (entry.type === 'tool' && !sentPeerMessage(entry) && !isBackgroundAgent(entry)) {
      tools.push(entry)
      continue
    }
    flushTools()
    grouped.push(entry)
  }
  flushTools()
  return grouped
}

function ToolActivityGroup({
  entries,
  spinner,
  settings,
  agentName,
  forceFullResult,
  expanded,
  onElement,
}: Omit<Parameters<typeof EntryView>[0], 'entry'> & {
  entries: readonly ToolEntry[]
  expanded: boolean
}): ReactElement {
  const theme = useTheme()
  const id = entries[0]!.id
  const running = entries.filter((entry) => entry.status === 'running')
  const failed = entries.filter((entry) => entry.status === 'error').length
  const cancelled = entries.filter((entry) => entry.status === 'cancelled').length
  const marker = running.length > 0 ? spinner : failed > 0 ? '×' : cancelled > 0 ? '○' : '✓'
  const color = running.length > 0 ? theme.warning : failed > 0 ? 'red' : cancelled > 0 ? 'yellow' : 'green'
  const counts = new Map<string, number>()
  for (const entry of entries) {
    const action = toolAction(entry.name)
    counts.set(action, (counts.get(action) ?? 0) + 1)
  }
  const details = [
    `${entries.length} tool calls`,
    ...Array.from(counts, ([action, count]) => `${action} ×${count}`),
    ...(failed > 0 ? [`${failed} failed`] : []),
    ...(cancelled > 0 ? [`${cancelled} cancelled`] : []),
  ]
  return (
    <Box flexDirection="column" marginTop={settings.transcriptSpacing === 'comfortable' ? 1 : 0}>
      <Box ref={(element) => onElement?.(id, element)} width="100%" paddingX={1} backgroundColor={theme.surface}>
        <Text wrap="wrap">
          <Text dimColor>{expanded ? '▾' : '▸'} </Text>
          <Text color={color} bold>
            {marker} Tool activity
          </Text>
          <Text dimColor> · {details.join(' · ')}</Text>
        </Text>
      </Box>
      {(expanded ? entries : running.slice(-1)).map((entry) => (
        <Box key={entry.id} paddingLeft={2} flexDirection="column">
          <EntryView
            entry={entry}
            spinner={spinner}
            settings={{ ...settings, transcriptSpacing: 'compact' }}
            agentName={agentName}
            forceFullResult={forceFullResult}
          />
        </Box>
      ))}
    </Box>
  )
}

function EntryView({
  entry,
  spinner,
  settings,
  agentName,
  forceFullResult,
  expanded = false,
  onElement,
}: {
  entry: ChatEntry
  spinner: string
  settings: ChatSnapshot['settings']
  agentName: string
  forceFullResult: boolean
  expanded?: boolean
  onElement?: (id: string, element: DOMElement | null) => void
}): ReactElement {
  const theme = useTheme()
  const marginTop = settings.transcriptSpacing === 'comfortable' ? 1 : 0
  if (entry.type === 'reasoning') {
    if (!settings.showReasoning) {
      return <></>
    }
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor bold>
          Reasoning
        </Text>
        <Text dimColor italic>
          {entry.text}
        </Text>
      </Box>
    )
  }
  if (entry.type === 'assistant') {
    return (
      <Box flexDirection="column" marginTop={marginTop}>
        <Text color={theme.accent} bold>
          {agentName}
        </Text>
        <Markdown>{entry.text}</Markdown>
      </Box>
    )
  }
  if (entry.type === 'media') {
    return (
      <Box marginTop={marginTop}>
        <MediaView content={entry.content} />
      </Box>
    )
  }

  const peerMessage = sentPeerMessage(entry)
  if (peerMessage) {
    const color =
      entry.status === 'running'
        ? theme.warning
        : entry.status === 'success'
          ? theme.accent
          : entry.status === 'error'
            ? 'red'
            : 'yellow'
    return (
      <Box flexDirection="column" marginTop={marginTop} paddingX={1} backgroundColor={theme.surface}>
        <Text color={color} bold>
          ◆ Message to {peerMessage.recipient}
        </Text>
        <Text>{peerMessage.body}</Text>
        {entry.error ? <Text color="red">Failed: {entry.error}</Text> : null}
      </Box>
    )
  }

  const backgroundAgent = isBackgroundAgent(entry)
  const { marker, color } = {
    running: { marker: spinner, color: theme.warning },
    success: { marker: backgroundAgent ? '↗' : '✓', color: backgroundAgent ? theme.accent : 'green' },
    cancelled: { marker: '○', color: 'yellow' },
    error: { marker: '×', color: 'red' },
  }[entry.status] ?? { marker: '×', color: 'red' }
  if (backgroundAgent) {
    const dispatch = backgroundTaskDispatch(entry)
    const state =
      entry.status === 'error'
        ? `Background task failed (${entry.name})`
        : entry.status === 'cancelled'
          ? `Background task cancelled (${entry.name})`
          : dispatch
            ? `Background task started (${dispatch.toolName}) - ${dispatch.taskId}`
            : `Background task starting (${entry.name})`
    return (
      <Box flexDirection="column" marginTop={marginTop}>
        <Box width="100%" paddingX={1} backgroundColor={theme.surface}>
          <Text color={color} bold>
            {marker} {state}
          </Text>
        </Box>
        {entry.error ? (
          <Box paddingLeft={3}>
            <Text color="red">└ {entry.error}</Text>
          </Box>
        ) : null}
      </Box>
    )
  }

  const statusLabel =
    entry.status === 'error'
      ? 'failed'
      : entry.status === 'cancelled' || entry.status === 'running'
        ? entry.status
        : undefined
  const hiddenOutput = settings.toolOutput === 'hidden'
  const showDetails = !hiddenOutput || expanded
  const showResult = showDetails ? entry.result : undefined
  const fullResult = !hiddenOutput && (forceFullResult || settings.toolOutput === 'full')
  const resultPreview = showResult
    ? summarizeToolResult(showResult.filter((item) => item.type === 'text' || item.type === 'json'))
    : undefined
  const mediaResults = showResult?.filter((item) => item.type !== 'text' && item.type !== 'json') ?? []
  return (
    <Box flexDirection="column" marginTop={marginTop}>
      <Box
        ref={hiddenOutput ? (element): void => onElement?.(`${entry.id}:output`, element) : undefined}
        width="100%"
        paddingX={1}
        backgroundColor={theme.surface}
      >
        <Text wrap="wrap">
          {hiddenOutput ? <Text dimColor>{expanded ? '▾' : '▸'} </Text> : null}
          <Text color={color} bold>
            {marker} {toolAction(entry.name)}
          </Text>
          <Text dimColor> {summarizeToolInput(entry.name, entry.input)}</Text>
          {statusLabel ? <Text color={color}> · {statusLabel}</Text> : null}
        </Text>
      </Box>
      {settings.toolOutput === 'full' ? (
        <Box paddingLeft={3} flexDirection="column">
          <Text dimColor>input</Text>
          <Text dimColor>{formatValue(entry.input)}</Text>
        </Box>
      ) : null}
      {showResult ? (
        <Box paddingLeft={3} flexDirection="column">
          <Text dimColor>result</Text>
          {fullResult ? (
            <ToolResultContentView content={showResult} />
          ) : (
            <>
              {resultPreview?.lines.map((line, index) => (
                <Text key={`${entry.id}-result-${index}`} dimColor>
                  <Text color={color}>
                    {index === resultPreview.lines.length - 1 && resultPreview.hiddenLines === 0 ? '└' : '│'}
                  </Text>{' '}
                  {line || ' '}
                </Text>
              ))}
              {resultPreview && resultPreview.hiddenLines > 0 ? (
                <Text dimColor>
                  <Text color={color}>└</Text> … {resultPreview.hiddenLines} more lines
                </Text>
              ) : null}
              {mediaResults.length > 0 ? <ToolResultContentView content={mediaResults} /> : null}
            </>
          )}
        </Box>
      ) : null}
      {showDetails && entry.error ? (
        <Box paddingLeft={3}>
          <Text color="red">└ {entry.error}</Text>
        </Box>
      ) : null}
    </Box>
  )
}
