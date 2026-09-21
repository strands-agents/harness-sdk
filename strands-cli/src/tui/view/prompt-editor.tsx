import type { ReactElement, ReactNode } from 'react'
import stringWidth from 'string-width'

import {
  DEFAULT_MAX_PROMPT_ROWS,
  MIN_PROMPT_HEIGHT,
  MIN_PROMPT_ROWS,
  PROMPT_PADDING_WIDTH,
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
  agentName,
  actionableCommandToken,
  width = 80,
  maxRows = DEFAULT_MAX_PROMPT_ROWS,
  party = false,
  partyFrame = 0,
  animateCursor = true,
}: {
  input: string
  cursor: number
  panelStatus?: string
  busyStatus?: string
  agentName: string
  actionableCommandToken?: string
  width?: number
  maxRows?: number
  party?: boolean
  partyFrame?: number
  animateCursor?: boolean
}): ReactElement {
  const theme = useTheme()
  const status = busyStatus ?? panelStatus
  if (status) {
    return (
      <PromptSurface width={width} height={MIN_PROMPT_HEIGHT} party={party} partyFrame={partyFrame}>
        <Text {...(busyStatus ? { color: theme.accent } : { dimColor: true })}>{status}</Text>
      </PromptSurface>
    )
  }
  const shellMode = input.startsWith('!')
  const promptPrefix = shellMode ? '◆ shell ' : '◆ '
  const prefixWidth = stringWidth(promptPrefix)
  const continuationPrefix = ' '.repeat(prefixWidth)
  const rows = promptViewport(
    input,
    cursor,
    width - prefixWidth - PROMPT_PADDING_WIDTH,
    Math.max(MIN_PROMPT_ROWS, maxRows)
  )
  const height = Math.max(MIN_PROMPT_HEIGHT, rows.length + (party && input ? 2 : 1))
  return (
    <PromptSurface width={width} height={height} party={party} partyFrame={partyFrame}>
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
          <Text color={theme.accent} bold>
            {'◆ '}
          </Text>
          <Text>
            <BlinkingCursor animate={animateCursor} />
            <Text dimColor>Message {agentName}</Text>
          </Text>
        </Box>
      )}
    </PromptSurface>
  )
}

function PromptSurface({
  width,
  height,
  party,
  partyFrame,
  children,
}: {
  width: number
  height: number
  party: boolean
  partyFrame: number
  children: ReactNode
}): ReactElement {
  const theme = useTheme()
  if (!party) {
    return (
      <Box
        backgroundColor={theme.surface}
        height={height}
        width={width}
        flexShrink={0}
        paddingX={1}
        flexDirection="column"
      >
        {children}
      </Box>
    )
  }
  const innerWidth = Math.max(1, width - 2)
  const innerHeight = height - 2
  return (
    <Box height={height} width={width} flexShrink={0} flexDirection="column">
      <PartyBorder length={width} frame={partyFrame} top />
      <Box height={innerHeight} width={width} flexShrink={0}>
        <PartyBorder length={innerHeight} offset={2 * width + innerHeight} frame={partyFrame} reverse vertical />
        <Box
          backgroundColor={theme.surface}
          height={innerHeight}
          width={innerWidth}
          paddingX={1}
          flexDirection="column"
        >
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
      {beforeHighlight ? <Text color={theme.hover}>{beforeHighlight}</Text> : null}
      {row.before.slice(token.length)}
      {row.current === undefined ? null : (
        <BlinkingCursor
          character={row.current}
          animate={animateCursor}
          {...(currentOffset < token.length ? { color: theme.hover } : {})}
        />
      )}
      {afterHighlight ? <Text color={theme.hover}>{afterHighlight}</Text> : null}
      {row.after.slice(afterHighlightLength)}
    </Text>
  )
}
