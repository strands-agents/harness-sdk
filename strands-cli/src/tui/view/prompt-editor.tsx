import type { ReactElement, ReactNode } from 'react'
import stringWidth from 'string-width'

import {
  DEFAULT_MAX_PROMPT_ROWS,
  MIN_PROMPT_ROWS,
  PROMPT_PADDING_WIDTH,
  promptEditorHeight,
  promptLayout,
  type PromptViewportRow,
} from '../terminal/composer.js'
import { mixHexColors } from './fade-in.js'
import { Box, Text, useTheme, type Theme } from './theme.js'
import { Cursor } from './text-input.js'
import { AttachmentPreview, attachmentPreviewRows } from './attachment-preview.js'
import type { ChatAttachmentSummary } from '../chat/types.js'

const SHELL_PLACEHOLDER = 'Execute a direct shell command'
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
  placeholder,
  actionableCommandToken,
  width = 80,
  height: fixedHeight,
  maxRows = DEFAULT_MAX_PROMPT_ROWS,
  maxHeight = Infinity,
  party = false,
  partyFrame = 0,
  energy = false,
  energyFrame = 0,
  transparent = false,
  attachments = [],
  children,
}: {
  input: string
  cursor: number
  panelStatus?: string
  busyStatus?: string
  placeholder?: string
  actionableCommandToken?: string
  width?: number
  height?: number
  maxRows?: number
  maxHeight?: number
  party?: boolean
  partyFrame?: number
  energy?: boolean
  energyFrame?: number
  transparent?: boolean
  attachments?: readonly ChatAttachmentSummary[]
  children?: ReactNode
}): ReactElement {
  const theme = useTheme()
  const status = busyStatus ?? panelStatus
  const attachmentRows = children || status ? 0 : attachmentPreviewRows(attachments)
  const height =
    fixedHeight ??
    Math.min(
      maxHeight,
      promptEditorHeight(input, cursor, width, maxRows, Boolean(status && !children), party, maxHeight) + attachmentRows
    )
  if (children || status) {
    return (
      <PromptSurface
        width={width}
        height={height}
        party={party}
        partyFrame={partyFrame}
        energy={energy}
        energyFrame={energyFrame}
        transparent={transparent}
      >
        {children ?? <Text {...(busyStatus ? { color: theme.accent } : { dimColor: true })}>{status}</Text>}
      </PromptSurface>
    )
  }
  const shellMode = input.startsWith('!')
  const frameSize = party || !transparent ? 2 : 0
  const { rows, hiddenAbove, hiddenBelow } = promptLayout(
    input,
    cursor,
    width - PROMPT_PADDING_WIDTH - frameSize,
    Math.max(1, Math.min(Math.max(MIN_PROMPT_ROWS, maxRows), height - frameSize - attachmentRows))
  )
  return (
    <PromptSurface
      width={width}
      height={height}
      party={party}
      partyFrame={partyFrame}
      energy={energy}
      energyFrame={energyFrame}
      transparent={transparent}
      hiddenAbove={hiddenAbove}
      hiddenBelow={hiddenBelow}
    >
      {attachmentRows > 0 ? <AttachmentPreview attachments={attachments} /> : null}
      {input ? (
        rows.map((row, index) => {
          const firstLine = index === 0 && hiddenAbove === 0
          const highlight =
            shellMode && firstLine
              ? { token: '!', color: 'red', bold: true }
              : actionableCommandToken
                ? { token: actionableCommandToken, color: theme.accent }
                : undefined
          return (
            <Box key={index} height={1} flexShrink={0}>
              <EditorRow
                row={row}
                {...(highlight ? { highlight } : {})}
                {...(firstLine && input === '!' ? { hint: SHELL_PLACEHOLDER } : {})}
              />
            </Box>
          )
        })
      ) : (
        <Box height={1} flexShrink={0}>
          <Text wrap="truncate-end">
            <Cursor />
            <Text dimColor>{placeholder ?? promptPlaceholder(width - PROMPT_PADDING_WIDTH - 1 - frameSize)}</Text>
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
  energy,
  energyFrame,
  transparent,
  hiddenAbove = 0,
  hiddenBelow = 0,
  children,
}: {
  width: number
  height: number
  party: boolean
  partyFrame: number
  energy: boolean
  energyFrame: number
  transparent: boolean
  hiddenAbove?: number
  hiddenBelow?: number
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
  if (energy && !party) {
    return (
      <EnergySurface width={width} height={height} frame={energyFrame}>
        {children}
      </EnergySurface>
    )
  }
  if (!party) {
    return (
      <Box height={height} width={width} flexShrink={0} flexDirection="column" overflow="hidden">
        <OverflowRule width={width} top hidden={hiddenAbove} />
        <Box
          height={Math.max(0, height - 2)}
          width={width}
          flexShrink={0}
          paddingX={1}
          flexDirection="column"
          overflow="hidden"
          borderStyle="single"
          borderTop={false}
          borderBottom={false}
          borderColor={theme.accent}
        >
          {children}
        </Box>
        <OverflowRule width={width} hidden={hiddenBelow} />
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

/** A horizontal prompt edge that names how many wrapped rows are scrolled out of view on its side. */
function OverflowRule({ width, top = false, hidden }: { width: number; top?: boolean; hidden: number }): ReactElement {
  const { accent } = useTheme()
  const [left, right] = top ? ['┌', '┐'] : ['└', '┘']
  const inner = Math.max(0, width - 2)
  const label = `${top ? '↑' : '↓'} ${hidden} more`
  const text = hidden > 0 && stringWidth(label) + 2 <= inner ? ` ${label} ` : ''
  const before = Math.floor((inner - stringWidth(text)) / 2)
  const after = inner - stringWidth(text) - before
  return (
    <Box height={1} width={width} flexShrink={0}>
      <Text color={accent} wrap="truncate-end">
        {width < 2 ? '─'.repeat(width) : `${left}${'─'.repeat(before)}`}
        {text ? <Text dimColor>{text}</Text> : null}
        {width < 2 ? '' : `${'─'.repeat(after)}${right}`}
      </Text>
    </Box>
  )
}

function EnergySurface({
  width,
  height,
  frame,
  children,
}: {
  width: number
  height: number
  frame: number
  children: ReactNode
}): ReactElement {
  const theme = useTheme()
  const innerWidth = Math.max(1, width - 2)
  const innerHeight = Math.max(1, height - 2)
  const perimeter = Math.max(1, 2 * width + 2 * innerHeight)
  const pulse = 0.5 + Math.sin(frame * 0.42) * 0.24 + Math.sin(frame * 1.37) * 0.08
  const background = mixHexColors(theme.background, theme.accent, 0.035 + pulse * 0.08)
  return (
    <Box height={height} width={width} flexShrink={0} flexDirection="column" overflow="hidden">
      <EnergyBorder length={width} frame={frame} perimeter={perimeter} top />
      <Box height={innerHeight} width={width} flexShrink={0}>
        <EnergyBorder
          length={innerHeight}
          offset={2 * width + innerHeight}
          frame={frame}
          perimeter={perimeter}
          reverse
          vertical
        />
        <Box height={innerHeight} width={innerWidth} paddingX={1} flexDirection="column" backgroundColor={background}>
          {children}
        </Box>
        <EnergyBorder length={innerHeight} offset={width} frame={frame} perimeter={perimeter} vertical />
      </Box>
      <EnergyBorder length={width} offset={width + innerHeight} frame={frame} perimeter={perimeter} reverse />
    </Box>
  )
}

function EnergyBorder({
  length,
  offset = 0,
  frame,
  perimeter,
  reverse = false,
  top = false,
  vertical = false,
}: {
  length: number
  offset?: number
  frame: number
  perimeter: number
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
      {characters.map((character, index) => {
        const position = offset + (reverse ? length - 1 - index : index)
        const intensity = energyBorderIntensity(position, frame, perimeter)
        return (
          <Text key={index} color={mixHexColors(theme.border, theme.accent, intensity)} bold={intensity > 0.72}>
            {intensity > 0.72 ? energizedBorderCharacter(character) : character}
          </Text>
        )
      })}
    </Box>
  )
}

function energyBorderIntensity(position: number, frame: number, perimeter: number): number {
  const primary = circularDistance(position, (frame * 3) % perimeter, perimeter)
  const secondaryHead = (((perimeter - frame * 2 + Math.floor(perimeter / 2)) % perimeter) + perimeter) % perimeter
  const secondary = circularDistance(position, secondaryHead, perimeter)
  const primarySurge = Math.max(0, 1 - primary / 11)
  const secondarySurge = Math.max(0, 1 - secondary / 7)
  const flicker = Math.max(0, Math.sin(position * 1.73 + frame * 2.11)) * 0.12
  const pulse = 0.28 + (Math.sin(frame * 0.42) + 1) * 0.09
  return Math.min(1, pulse + primarySurge * 0.72 + secondarySurge * 0.48 + flicker)
}

function circularDistance(a: number, b: number, length: number): number {
  const distance = Math.abs(a - b)
  return Math.min(distance, length - distance)
}

function energizedBorderCharacter(character: string): string {
  return (
    {
      '─': '━',
      '│': '┃',
      '┌': '┏',
      '┐': '┓',
      '└': '┗',
      '┘': '┛',
    }[character] ?? character
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
  highlight,
  hint,
}: {
  row: PromptViewportRow
  highlight?: { token: string; color: string; bold?: boolean }
  hint?: string
}): ReactElement {
  const fullRow = `${row.before}${row.current ?? ''}${row.after}`
  const token = highlight && fullRow.startsWith(highlight.token) ? highlight.token : ''
  const style = highlight ? { color: highlight.color, bold: highlight.bold === true } : {}
  const currentOffset = row.before.length
  const afterOffset = currentOffset + (row.current === undefined ? 0 : row.current.length)
  const afterHighlightLength = Math.max(0, token.length - afterOffset)
  const beforeHighlight = row.before.slice(0, token.length)
  const afterHighlight = row.after.slice(0, afterHighlightLength)
  return (
    <Text wrap="truncate-end">
      {beforeHighlight ? <Text {...style}>{beforeHighlight}</Text> : null}
      {row.before.slice(token.length)}
      {row.current === undefined ? null : (
        <Cursor
          character={row.current}
          {...(currentOffset < token.length && highlight ? { color: highlight.color } : {})}
        />
      )}
      {afterHighlight ? <Text {...style}>{afterHighlight}</Text> : null}
      {row.after.slice(afterHighlightLength)}
      {hint ? <Text dimColor>{hint}</Text> : null}
    </Text>
  )
}
