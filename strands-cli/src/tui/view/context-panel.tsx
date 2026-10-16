import type { ReactElement } from 'react'
import type { DOMElement } from 'ink'

import type { ChatContextBreakdown, ChatContextUsage } from '../chat/types.js'
import { PanelHelpFooter } from './help-footer.js'
import { contextColor, formatContext } from './presentation.js'
import { Box, Text, useTheme, type Theme } from './theme.js'

type CategoryKind = ChatContextBreakdown['categories'][number]['kind'] | 'free'

interface Segment {
  kind: CategoryKind
  label: string
  shortLabel: string
  tokens: number | undefined
  color: string
}

function contextSegments(context: ChatContextUsage, theme: Theme): Segment[] {
  const used = context.projectedTokens ?? context.currentTokens
  const definitions: [CategoryKind, string, string, string][] = [
    ['systemPrompt', 'System prompt', 'System', theme.mode === 'dark' ? '#79aaff' : '#234e96'],
    ['tools', 'Tool definitions', 'Tools', theme.hover],
    ['userMessages', 'User messages', 'User', theme.success],
    ['assistantMessages', 'Assistant messages', 'Agent', theme.mode === 'dark' ? '#6bd5cf' : '#006960'],
    ['toolResults', 'Tool results', 'Results', theme.warning],
    ['injectedContext', 'Injected context', 'Injected', theme.mode === 'dark' ? '#ef96c8' : '#9d2867'],
    ['other', 'Other / overhead', 'Other', theme.muted],
    ['free', 'Free space', 'Free', theme.border],
  ]
  return definitions.map(([kind, label, shortLabel, color]) => ({
    kind,
    label,
    shortLabel,
    color,
    tokens:
      kind === 'free'
        ? context.contextWindow !== undefined && used !== undefined
          ? Math.max(0, context.contextWindow - used)
          : undefined
        : (context.breakdown?.categories.find((category) => category.kind === kind)?.tokens ?? 0),
  }))
}

function compactTokens(tokens: number | undefined): string {
  if (tokens === undefined) return '—'
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return tokens.toLocaleString()
}

function percentage(tokens: number | undefined, contextWindow: number | undefined): string {
  return tokens !== undefined && contextWindow ? `${((tokens / contextWindow) * 100).toFixed(1)}%` : '—'
}

function UsageMap({
  segments,
  width,
  rows,
}: {
  segments: readonly Segment[]
  width: number
  rows: number
}): ReactElement {
  const columns = Math.max(1, Math.min(20, Math.floor(width / 2)))
  const cellCount = columns * rows
  const total = segments.reduce((sum, segment) => sum + (segment.tokens ?? 0), 0)
  const allocation = segments.map((segment) => {
    const share = total > 0 ? ((segment.tokens ?? 0) / total) * cellCount : 0
    return { segment, cells: Math.floor(share), remainder: share % 1 }
  })
  const remainder = cellCount - allocation.reduce((sum, segment) => sum + segment.cells, 0)
  if (total > 0) {
    const largest = [...allocation].sort((left, right) => right.remainder - left.remainder)
    for (let index = 0; index < remainder; index++) largest[index % largest.length]!.cells++
  }
  const cells = allocation.flatMap(({ segment, cells }) => Array<Segment>(cells).fill(segment))
  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      {Array.from({ length: rows }, (_, row) => (
        <Text key={row} wrap="truncate-end">
          {cells.slice(row * columns, (row + 1) * columns).map((segment, column) => (
            <Text key={column} color={segment.color}>
              {segment.kind === 'free' ? '□ ' : '■ '}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  )
}

function UsageStats({
  context,
  width,
  paired = false,
}: {
  context: ChatContextUsage
  width: number
  paired?: boolean
}): ReactElement {
  const stats = [
    ['Input', context.inputTokens],
    ['Output', context.outputTokens],
    ['Cache read', context.cacheReadInputTokens],
    ['Cache write', context.cacheWriteInputTokens],
  ] as const
  const stat = ([label, tokens]: (typeof stats)[number], statWidth: number): ReactElement => (
    <Box key={label} width={statWidth} justifyContent="space-between">
      <Text dimColor>{label}</Text>
      <Text>{tokens?.toLocaleString() ?? '—'}</Text>
    </Box>
  )
  return (
    <Box width={width} flexDirection="column" flexShrink={0}>
      <Box justifyContent="space-between">
        <Text bold>Last turn</Text>
        <Text>{context.totalTokens?.toLocaleString() ?? '—'} tokens</Text>
      </Box>
      {paired
        ? [stats.slice(0, 2), stats.slice(2)].map((pair) => (
            <Box key={pair[0]![0]} justifyContent="space-between">
              {pair.map((entry) => stat(entry, Math.floor((width - 2) / 2)))}
            </Box>
          ))
        : stats.map((entry) => stat(entry, width))}
    </Box>
  )
}

function Legend({
  segments,
  width,
  contextWindow,
  paired,
}: {
  segments: readonly Segment[]
  width: number
  contextWindow: number | undefined
  paired: boolean
}): ReactElement {
  const cellWidth = paired ? Math.floor((width - 2) / 2) : width
  const row = (segment: Segment): ReactElement => (
    <Box key={segment.kind} width={cellWidth} height={1} flexShrink={0} overflow="hidden">
      <Text color={segment.color}>{segment.kind === 'free' ? '□ ' : '■ '}</Text>
      <Box flexGrow={1} overflow="hidden">
        <Text wrap="truncate-end">{cellWidth < 32 ? segment.shortLabel : segment.label}</Text>
      </Box>
      <Text>{compactTokens(segment.tokens).padStart(6)}</Text>
      {cellWidth >= 39 ? <Text dimColor>{percentage(segment.tokens, contextWindow).padStart(8)}</Text> : null}
    </Box>
  )
  return (
    <Box width={width} flexDirection="column" flexShrink={0}>
      <Text bold wrap="truncate-end">
        Estimated breakdown{paired ? ' · last call' : ''}
      </Text>
      {paired
        ? Array.from({ length: Math.ceil(segments.length / 2) }, (_, index) => (
            <Box key={index} justifyContent="space-between">
              {segments.slice(index * 2, index * 2 + 2).map(row)}
            </Box>
          ))
        : segments.map(row)}
    </Box>
  )
}

export function ContextPanel({
  context,
  title,
  width,
  height: requestedHeight,
  onPanelElement,
}: {
  context: ChatContextUsage
  title: string
  width: number
  height?: number
  onPanelElement?: (element: DOMElement | null) => void
}): ReactElement {
  const theme = useTheme()
  if (!context.breakdown) {
    return (
      <ContextSummary
        context={context}
        title={title}
        width={width}
        {...(requestedHeight === undefined ? {} : { height: requestedHeight })}
        {...(onPanelElement ? { onPanelElement } : {})}
      />
    )
  }
  const height = requestedHeight ?? 14
  const used = context.projectedTokens ?? context.currentTokens
  const segments = contextSegments(context, theme)
  const contentWidth = Math.min(116, width)
  const compact = width < 76 || height < 14
  const showStats = height >= 13
  const mapWidth = compact ? contentWidth : Math.min(40, Math.floor(contentWidth * 0.4))
  const legendWidth = contentWidth - mapWidth - 4
  const summary = (
    <Box flexDirection="column" flexShrink={0}>
      <Box justifyContent="space-between">
        <Text bold color={theme.accent}>
          Context usage
        </Text>
        <Text color={contextColor(context, theme)}>{percentage(used, context.contextWindow)}</Text>
      </Box>
      <Text dimColor wrap="truncate-end">
        {used?.toLocaleString() ?? '—'}
        {context.contextWindow ? ` / ${context.contextWindow.toLocaleString()}` : ''} tokens
      </Text>
    </Box>
  )
  return (
    <Box
      ref={onPanelElement}
      width={width}
      height={height}
      flexDirection="column"
      alignItems="center"
      overflow="hidden"
    >
      <Box width={contentWidth} flexGrow={1} justifyContent="center" flexDirection="column" overflow="hidden">
        {compact ? (
          <Box flexDirection="column">
            {summary}
            {context.contextWindow ? <UsageMap segments={segments} width={mapWidth} rows={1} /> : null}
            <Legend segments={segments} width={contentWidth} contextWindow={context.contextWindow} paired />
            {showStats ? (
              <Box marginTop={1}>
                <UsageStats context={context} width={contentWidth} paired />
              </Box>
            ) : height >= 10 ? (
              <Text dimColor wrap="truncate-end">
                Turn {compactTokens(context.totalTokens)} · In {compactTokens(context.inputTokens)} · Out{' '}
                {compactTokens(context.outputTokens)}
              </Text>
            ) : null}
          </Box>
        ) : (
          <Box justifyContent="space-between">
            <Box width={mapWidth} flexDirection="column">
              {summary}
              {context.contextWindow ? (
                <UsageMap segments={segments} width={mapWidth} rows={5} />
              ) : (
                <Text dimColor>Context window unavailable</Text>
              )}
              <Box marginTop={1}>
                <UsageStats context={context} width={mapWidth} />
              </Box>
            </Box>
            <Box width={legendWidth} flexDirection="column">
              <Legend segments={segments} width={legendWidth} contextWindow={context.contextWindow} paired={false} />
              <Box marginTop={1} flexDirection="column">
                <Text dimColor wrap="truncate-end">
                  Latest model call + response
                </Text>
                <Text dimColor wrap="truncate-end">
                  Cache counts overlap input.
                </Text>
              </Box>
            </Box>
          </Box>
        )}
      </Box>
      <PanelHelpFooter width={contentWidth} centered />
    </Box>
  )
}

function ContextSummary({
  context,
  title,
  width,
  height,
  onPanelElement,
}: {
  context: ChatContextUsage
  title: string
  width: number
  height?: number
  onPanelElement?: (element: DOMElement | null) => void
}): ReactElement {
  const palette = useTheme()
  const { accent } = palette
  const used = context.projectedTokens ?? context.currentTokens
  const wide = width >= 64
  const contentWidth = Math.min(wide ? 96 : 52, width)
  const columnWidth = wide ? Math.floor((contentWidth - 4) / 2) : contentWidth
  const stats = [
    ['Input', context.inputTokens],
    ['Output', context.outputTokens],
    ['Cache read', context.cacheReadInputTokens],
    ['Cache write', context.cacheWriteInputTokens],
  ] as const
  const stat = ([label, tokens]: (typeof stats)[number], statWidth?: number): ReactElement => (
    <Box key={label} {...(statWidth === undefined ? {} : { width: statWidth })} justifyContent="space-between">
      <Text dimColor>{label}</Text>
      <Text>{tokens?.toLocaleString() ?? '—'}</Text>
    </Box>
  )
  return (
    <Box
      ref={onPanelElement}
      width={width}
      {...(height === undefined ? {} : { height })}
      flexDirection="column"
      alignItems="center"
      overflow="hidden"
    >
      <Box width={contentWidth} flexGrow={1} flexDirection="column" justifyContent="center" overflow="hidden">
        <Box
          width="100%"
          overflow="hidden"
          {...(wide ? { flexDirection: 'row', justifyContent: 'space-between' } : { flexDirection: 'column' })}
        >
          <Box width={columnWidth} flexShrink={0} flexDirection="column">
            <Text bold color={accent} wrap="truncate-end">
              {title}
            </Text>
            {context.contextWindow ? (
              <Text color={contextColor(context, palette)} wrap="truncate-end">
                {formatContext(context, Math.max(1, columnWidth - 12))}
              </Text>
            ) : null}
            <Text dimColor wrap="truncate-end">
              {used?.toLocaleString() ?? '—'}
              {context.contextWindow ? ` / ${context.contextWindow.toLocaleString()}` : ''} tokens
            </Text>
            <Text dimColor wrap="truncate-end">
              {used === undefined ? 'Send a message to measure context' : 'Category breakdown unavailable'}
            </Text>
          </Box>
          <Box width={columnWidth} flexShrink={0} flexDirection="column" {...(wide ? {} : { marginTop: 1 })}>
            <Box justifyContent="space-between">
              <Text bold>Last turn</Text>
              <Text>{context.totalTokens?.toLocaleString() ?? '—'} tokens</Text>
            </Box>
            {wide
              ? stats.map((entry) => stat(entry))
              : [stats.slice(0, 2), stats.slice(2)].map((pair) => (
                  <Box key={pair[0]![0]} justifyContent="space-between">
                    {pair.map((entry) => stat(entry, Math.floor((contentWidth - 2) / 2)))}
                  </Box>
                ))}
          </Box>
        </Box>
      </Box>
      <PanelHelpFooter width={contentWidth} centered />
    </Box>
  )
}
