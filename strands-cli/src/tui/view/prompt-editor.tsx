import type { ReactElement, ReactNode } from 'react'
import stringWidth from 'string-width'

import {
  DEFAULT_MAX_PROMPT_ROWS,
  MIN_PROMPT_ROWS,
  PROMPT_PADDING_WIDTH,
  promptEditorHeight,
  promptViewport,
  type PromptViewportRow,
} from '../terminal/composer.js'
import { Box, Text, useTheme, type Theme } from './theme.js'
import { BlinkingCursor } from './text-input.js'

const PARTY_BORDER_COLORS = [
  '#f55ba9',
  '#ff525c',
  '#ff9e43',
  '#ffe05c',
  '#81ff9d',
  '#5cdaff',
  '#526fff',
  '#a967ff',
] as const
const LIGHT_PARTY_BORDER_COLORS = [
  '#98245e',
  '#b42332',
  '#934600',
  '#765b00',
  '#166534',
  '#006581',
  '#3048a5',
  '#7036a8',
] as const

export function PromptEditor({
  input,
  cursor,
  panelStatus,
  busyStatus,
  actionableCommandToken,
  width = 80,
  height: fixedHeight,
  maxRows = DEFAULT_MAX_PROMPT_ROWS,
  maxHeight = Infinity,
  party = false,
  partyFrame = 0,
  animateCursor = true,
  transparent = false,
  children,
}: {
  input: string
  cursor: number
  panelStatus?: string
  busyStatus?: string
  actionableCommandToken?: string
  width?: number
  height?: number
  maxRows?: number
  maxHeight?: number
  party?: boolean
  partyFrame?: number
  animateCursor?: boolean
  transparent?: boolean
  children?: ReactNode
}): ReactElement {
  const theme = useTheme()
  const status = busyStatus ?? panelStatus
  const height =
    fixedHeight ?? promptEditorHeight(input, cursor, width, maxRows, Boolean(status && !children), party, maxHeight)
  if (children || status) {
    return (
      <PromptSurface width={width} height={height} party={party} partyFrame={partyFrame} transparent={transparent}>
        {children ?? <Text {...(busyStatus ? { color: theme.accent } : { dimColor: true })}>{status}</Text>}
      </PromptSurface>
    )
  }
  const shellMode = input.startsWith('!')
  const promptPrefix = shellMode ? '◆ shell ' : ''
  const prefixWidth = stringWidth(promptPrefix)
  const continuationPrefix = ' '.repeat(prefixWidth)
  const frameSize = party || !transparent ? 2 : 0
  const rows = promptViewport(
    input,
    cursor,
    width - prefixWidth - PROMPT_PADDING_WIDTH - frameSize,
    Math.max(1, Math.min(Math.max(MIN_PROMPT_ROWS, maxRows), height - frameSize))
  )
  return (
    <PromptSurface width={width} height={height} party={party} partyFrame={partyFrame} transparent={transparent}>
      {input ? (
        rows.map((row, index) => (
          <Box key={index} height={1} flexShrink={0}>
            <Text color={shellMode ? 'red' : theme.accent} bold>
              {index === 0 ? promptPrefix : continuationPrefix}
            </Text>
            <EditorRow
              row={row}
              animateCursor={animateCursor}
              {...(actionableCommandToken ? { actionableCommandToken } : {})}
            />
          </Box>
        ))
      ) : (
        <Box height={1} flexShrink={0}>
          <Text wrap="truncate-end">
            <BlinkingCursor animate={animateCursor} />
            <Text dimColor>{promptPlaceholder(width - prefixWidth - PROMPT_PADDING_WIDTH - 1 - frameSize)}</Text>
          </Text>
        </Box>
      )}
    </PromptSurface>
  )
}

function promptPlaceholder(width: number): string {
  return (
    [
      'Enter to send • Ctrl+J for newline • / for commands',
      'Enter send • Ctrl+J newline • / commands',
      'Enter send • / commands',
      'Enter send',
    ].find((hint) => stringWidth(hint) <= width) ?? 'Enter'
  )
}

// Matches PromptSurface's border and horizontal padding.
export function promptContentSize(width: number, height: number, outlined: boolean): { width: number; height: number } {
  return { width: Math.max(1, width - (outlined ? 4 : 0)), height: Math.max(1, height - (outlined ? 2 : 0)) }
}

function PromptSurface({
  width,
  height,
  party,
  partyFrame,
  transparent,
  children,
}: {
  width: number
  height: number
  party: boolean
  partyFrame: number
  transparent: boolean
  children: ReactNode
}): ReactElement {
  const theme = useTheme()
  if (transparent) {
    return (
      <Box height={height} width={width} flexShrink={0} flexDirection="column" overflow="hidden">
        {children}
      </Box>
    )
  }
  if (!party) {
    return (
      <Box
        height={height}
        width={width}
        flexShrink={0}
        paddingX={1}
        flexDirection="column"
        overflow="hidden"
        borderStyle="single"
        borderColor={theme.accent}
      >
        {children}
      </Box>
    )
  }
  const innerWidth = Math.max(1, width - 2)
  const innerHeight = height - 2
  return (
    <Box height={height} width={width} flexShrink={0} flexDirection="column" overflow="hidden">
      <PartyBorder length={width} frame={partyFrame} top />
      <Box height={innerHeight} width={width} flexShrink={0}>
        <PartyBorder length={innerHeight} offset={2 * width + innerHeight} frame={partyFrame} reverse vertical />
        <Box height={innerHeight} width={innerWidth} paddingX={1} flexDirection="column">
          {children}
        </Box>
        <PartyBorder length={innerHeight} offset={width} frame={partyFrame} vertical />
      </Box>
      <PartyBorder length={width} offset={width + innerHeight} frame={partyFrame} reverse />
    </Box>
  )
}

function PartyBorder({
  length,
  offset = 0,
  frame,
  reverse = false,
  top = false,
  vertical = false,
}: {
  length: number
  offset?: number
  frame: number
  reverse?: boolean
  top?: boolean
  vertical?: boolean
}): ReactElement {
  const theme = useTheme()
  const characters = vertical
    ? Array.from({ length }, () => '│')
    : length <= 1
      ? ['─']
      : [top ? '┌' : '└', ...'─'.repeat(length - 2), top ? '┐' : '┘']
  return (
    <Box
      height={vertical ? length : 1}
      width={vertical ? 1 : length}
      flexShrink={0}
      flexDirection={vertical ? 'column' : 'row'}
    >
      {characters.map((character, index) => (
        <Text key={index} color={partyBorderColor(offset + (reverse ? length - 1 - index : index), frame, theme.mode)}>
          {character}
        </Text>
      ))}
    </Box>
  )
}

function partyBorderColor(position: number, frame: number, mode: Theme['mode']): string {
  const colors = mode === 'light' ? LIGHT_PARTY_BORDER_COLORS : PARTY_BORDER_COLORS
  const colorIndex = Math.floor((position + frame) / 2) % colors.length
  return colors[colorIndex]!
}

function EditorRow({
  row,
  actionableCommandToken,
  animateCursor,
}: {
  row: PromptViewportRow
  actionableCommandToken?: string
  animateCursor: boolean
}): ReactElement {
  const theme = useTheme()
  const fullRow = `${row.before}${row.current ?? ''}${row.after}`
  const token = actionableCommandToken && fullRow.startsWith(actionableCommandToken) ? actionableCommandToken : ''
  const currentOffset = row.before.length
  const afterOffset = currentOffset + (row.current === undefined ? 0 : row.current.length)
  const afterHighlightLength = Math.max(0, token.length - afterOffset)
  const beforeHighlight = row.before.slice(0, token.length)
  const afterHighlight = row.after.slice(0, afterHighlightLength)
  return (
    <Text wrap="truncate-end">
      {beforeHighlight ? <Text color={theme.accent}>{beforeHighlight}</Text> : null}
      {row.before.slice(token.length)}
      {row.current === undefined ? null : (
        <BlinkingCursor
          character={row.current}
          animate={animateCursor}
          {...(currentOffset < token.length ? { color: theme.accent } : {})}
        />
      )}
      {afterHighlight ? <Text color={theme.accent}>{afterHighlight}</Text> : null}
      {row.after.slice(afterHighlightLength)}
    </Text>
  )
}
