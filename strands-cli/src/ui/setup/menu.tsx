import { type ReactElement, useEffect, useRef, useState } from 'react'
import { type DOMElement, useStdout } from 'ink'
import { Box, Text, useTheme } from '../theme.js'
import { FadeIn } from '../animation.js'
import { OPENING_CHOICES } from './steps.js'
import stringWidth from 'string-width'

/** Quickstart spans the grid as the primary choice; the remaining choices share the row below it. */
export function openingGridLayout(width: number): {
  columns: number
  rows: number
  columnGap: number
  rowGap: number
  cardWidth: number
  gridWidth: number
  left: number
} {
  const columns = width >= 64 ? 2 : 1
  const columnGap = columns === 2 ? 4 : 0
  const cardWidth = columns === 2 ? Math.min(44, Math.floor((width - columnGap) / 2)) : Math.min(48, width)
  const gridWidth = cardWidth * columns + (columns - 1) * columnGap
  return {
    columns,
    rows: columns === 2 ? 1 + Math.ceil((OPENING_CHOICES.length - 1) / columns) : OPENING_CHOICES.length,
    columnGap,
    rowGap: columns === 2 ? 2 : 1,
    cardWidth,
    gridWidth,
    left: Math.floor((width - gridWidth) / 2),
  }
}

/** The opening choice an arrow key moves to from `index`, following the hero-plus-row layout. */
export function openingNeighbor(index: number, direction: 'up' | 'down' | 'left' | 'right', columns: number): number {
  const last = OPENING_CHOICES.length - 1
  if (columns === 1 || index === 0) {
    return direction === 'up' || direction === 'left' ? Math.max(0, index - 1) : Math.min(last, index + 1)
  }
  if (direction === 'up') return 0
  if (direction === 'down') return index
  const column = (index - 1) % columns
  return direction === 'left'
    ? column > 0
      ? index - 1
      : index
    : column < columns - 1
      ? Math.min(last, index + 1)
      : index
}

export function OpeningMenu({
  width,
  buttonHeight,
  selection,
  showSelection,
  topGap,
  animate,
  error,
  availableUpdate,
  escapeHint,
  escapeFocused = false,
  escapeHovered = false,
  onEscapeElement,
  onRowElement,
}: {
  width: number
  buttonHeight: number
  selection: number
  showSelection: boolean
  topGap: number
  animate: boolean
  error?: { text: string; copyHint: string }
  availableUpdate?: string
  escapeHint: string
  escapeFocused?: boolean
  escapeHovered?: boolean
  onEscapeElement?(element: DOMElement | null): void
  onRowElement(index: number, element: DOMElement | null): void
}): ReactElement {
  const palette = useTheme()
  const { columnGap, rowGap, cardWidth, gridWidth, left } = openingGridLayout(width)
  // Matches the model panel's sections: the selected card carries the accent border, the rest stay dim.
  const bordered = buttonHeight >= 3
  const innerHeight = bordered ? buttonHeight - 2 : buttonHeight
  const descriptionHeight = Math.min(3, Math.max(1, innerHeight - (innerHeight >= 5 ? 2 : 1)))
  return (
    <FadeIn animate={animate} background={palette.background}>
      <Box
        flexGrow={1}
        alignItems="flex-start"
        justifyContent="flex-start"
        flexDirection="column"
        overflow="hidden"
        paddingTop={topGap}
      >
        <Box width={gridWidth} marginLeft={left} flexWrap="wrap" columnGap={columnGap} rowGap={rowGap}>
          {OPENING_CHOICES.map((choice, index) => {
            const active = showSelection && index === selection
            const span = index === 0 ? gridWidth : cardWidth
            const descriptionLines = wrapDescription(choice.description, Math.max(1, span - 4))
            return (
              <Box
                key={choice.id}
                ref={(element) => onRowElement(index, element)}
                width={span}
                height={buttonHeight}
                alignItems="center"
                justifyContent="center"
                {...(bordered
                  ? { borderStyle: 'single', borderColor: active ? palette.accent : undefined, borderDimColor: !active }
                  : {})}
              >
                {innerHeight >= 3 ? (
                  <Box flexDirection="column" alignItems="center">
                    <Text bold>{choice.title}</Text>
                    {innerHeight >= 5 ? <Text> </Text> : null}
                    <Box
                      // The full-width card stands alone, so it fits its own text; paired cards share one height.
                      height={index === 0 ? Math.min(descriptionHeight, descriptionLines.length) : descriptionHeight}
                      flexDirection="column"
                      alignItems="center"
                      justifyContent="center"
                    >
                      {descriptionLines.map((line) => (
                        <Text key={line} color={palette.muted}>
                          {line}
                        </Text>
                      ))}
                    </Box>
                  </Box>
                ) : (
                  <Text wrap="truncate-end">
                    <Text bold {...(active && !bordered ? { color: palette.accent } : {})}>
                      {choice.title}
                    </Text>
                    {'  '}
                    <Text color={palette.muted}>{choice.description}</Text>
                  </Text>
                )}
              </Box>
            )
          })}
        </Box>
        <Box width={gridWidth} marginLeft={left} marginTop={2} justifyContent="center">
          <Box ref={(element) => onEscapeElement?.(element)} height={1} flexShrink={0}>
            <Text color={escapeFocused || escapeHovered ? palette.accent : palette.muted} bold wrap="truncate-end">
              {'⬅  '}
              {escapeHint}
            </Text>
          </Box>
        </Box>
        {availableUpdate ? (
          <Box width={gridWidth} marginLeft={left} marginTop={1}>
            <Text wrap="truncate-end">
              <Text color={palette.accent}>Strands CLI {availableUpdate} is available!</Text>
              <Text color={palette.muted}> Run `strands update` to install it.</Text>
            </Text>
          </Box>
        ) : null}
        {error ? (
          <Box width={gridWidth} marginLeft={left} marginTop={1} flexDirection="column">
            <Text color="red">{error.text}</Text>
            <Text dimColor wrap="truncate-end">
              {error.copyHint}
            </Text>
          </Box>
        ) : null}
      </Box>
    </FadeIn>
  )
}

function wrapDescription(value: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of value.split(' ')) {
    if (!line || line.length + word.length + 1 <= width) {
      line = line ? `${line} ${word}` : word
    } else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  for (let index = 0; index < lines.length - 1; index++) {
    while (true) {
      const current = lines[index]!
      const next = lines[index + 1]!
      const words = current.split(' ')
      if (words.length < 2) break
      const candidateCurrent = words.slice(0, -1).join(' ')
      const candidateNext = `${words.at(-1)!} ${next}`
      if (
        candidateNext.length > width ||
        Math.abs(candidateCurrent.length - candidateNext.length) >= Math.abs(current.length - next.length)
      ) {
        break
      }
      lines[index] = candidateCurrent
      lines[index + 1] = candidateNext
    }
  }
  return lines
}

const PARTIAL_BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'] as const
const PROGRESS_DURATION_MS = 240

export function SetupProgress({
  current,
  total,
  label = `${current} of ${total}`,
  width,
  animate,
}: {
  current: number
  total: number
  label?: string
  width: number
  animate: boolean
}): ReactElement {
  const { stdout } = useStdout()
  const { accent } = useTheme()
  const target = Math.max(0, Math.min(1, current / Math.max(1, total)))
  const progressRef = useRef(target)
  const [progress, setProgress] = useState(target)
  const enabled = animate && stdout.isTTY

  useEffect(() => {
    if (!enabled) {
      progressRef.current = target
      setProgress(target)
      return
    }
    const start = progressRef.current
    const startedAt = Date.now()
    const timer = setInterval(() => {
      const elapsed = Math.min(1, (Date.now() - startedAt) / PROGRESS_DURATION_MS)
      const eased = elapsed * elapsed * (3 - 2 * elapsed)
      const next = start + (target - start) * eased
      progressRef.current = next
      setProgress(next)
      if (elapsed === 1) {
        clearInterval(timer)
      }
    }, 24)
    return (): void => clearInterval(timer)
  }, [enabled, target])

  const labelWidth = stringWidth(label)
  const barWidth = width > labelWidth + 1 ? Math.max(1, width - labelWidth - 2) : 0
  const eighths = Math.round(progress * barWidth * 8)
  const fullBlocks = Math.floor(eighths / 8)
  const partialBlock = PARTIAL_BLOCKS[eighths % 8]
  const remainingBlocks = Math.max(0, barWidth - fullBlocks - Number(Boolean(partialBlock)))

  return (
    <Box width={width} height={1} flexShrink={0}>
      <Box width={barWidth} flexShrink={0}>
        <Text color={accent}>
          {'█'.repeat(fullBlocks)}
          {partialBlock}
        </Text>
        <Text dimColor>{'░'.repeat(remainingBlocks)}</Text>
      </Box>
      <Box flexGrow={1} />
      <Text dimColor wrap="truncate-end">
        {label}
      </Text>
    </Box>
  )
}
