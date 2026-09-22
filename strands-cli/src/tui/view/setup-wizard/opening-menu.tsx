import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useStdout, type DOMElement } from 'ink'

import { Box, Text, useTheme } from '../theme.js'
import { FadeIn, mixHexColors } from '../fade-in.js'
import { OPENING_CHOICES } from './steps.js'

const HOVER_FADE_DURATION_MS = 180

/** Shared with the setup brand so the lockup starts on the grid's left edge. */
export function openingGridLayout(width: number): {
  columns: number
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
    columnGap,
    rowGap: columns === 2 ? 2 : 1,
    cardWidth,
    gridWidth,
    left: Math.floor((width - gridWidth) / 2),
  }
}

export function OpeningMenu({
  width,
  height,
  buttonHeight,
  selection,
  showSelection,
  hovered,
  topGap,
  animate,
  error,
  onRowElement,
}: {
  width: number
  height?: number
  buttonHeight: number
  selection: number
  showSelection: boolean
  hovered?: number
  topGap: number
  animate: boolean
  error?: string
  onRowElement(index: number, element: DOMElement | null): void
}): ReactElement {
  const palette = useTheme()
  const hoverProgress = useHoverProgress(hovered, OPENING_CHOICES.length, animate)
  const { columnGap, rowGap, cardWidth, gridWidth, left } = openingGridLayout(width)
  return (
    <FadeIn animate={animate} background={palette.background}>
      <Box
        {...(height === undefined ? { flexGrow: 1 } : { height, flexGrow: 0, flexShrink: 0 })}
        alignItems="flex-start"
        justifyContent="flex-start"
        flexDirection="column"
        overflow="hidden"
        paddingTop={topGap}
      >
        <Box width={gridWidth} marginLeft={left} flexWrap="wrap" columnGap={columnGap} rowGap={rowGap}>
          {OPENING_CHOICES.map((choice, index) => {
            const active = showSelection && index === selection
            const hover = hoverProgress[index] ?? 0
            const background = mixHexColors(active ? palette.selection : palette.surface, palette.accent, hover)
            const title = mixHexColors(active ? palette.accent : palette.foreground, palette.surface, hover)
            const description = mixHexColors(active ? palette.foreground : palette.muted, palette.surface, hover)
            const descriptionLines = wrapDescription(choice.description, Math.max(1, cardWidth - 4))
            const descriptionHeight = Math.min(3, Math.max(1, buttonHeight - (buttonHeight >= 5 ? 2 : 1)))
            return (
              <Box
                key={choice.id}
                ref={(element) => onRowElement(index, element)}
                width={cardWidth}
                height={buttonHeight}
                alignItems="center"
                justifyContent="center"
                backgroundColor={background}
              >
                {buttonHeight >= 3 ? (
                  <Box flexDirection="column" alignItems="center">
                    <Text bold color={title}>
                      {choice.title}
                    </Text>
                    {buttonHeight >= 5 ? <Text> </Text> : null}
                    <Box height={descriptionHeight} flexDirection="column" alignItems="center" justifyContent="center">
                      {descriptionLines.map((line) => (
                        <Text key={line} color={description}>
                          {line}
                        </Text>
                      ))}
                    </Box>
                  </Box>
                ) : (
                  <Text wrap="truncate-end">
                    <Text bold color={title}>
                      {choice.title}
                    </Text>
                    {'  '}
                    <Text color={description}>{choice.description}</Text>
                  </Text>
                )}
              </Box>
            )
          })}
        </Box>
        {error ? <Text color="red">{error}</Text> : null}
      </Box>
    </FadeIn>
  )
}

function useHoverProgress(hovered: number | undefined, count: number, animate: boolean): readonly number[] {
  const { stdout } = useStdout()
  const enabled = animate && stdout.isTTY
  const current = useRef<number[]>(Array.from({ length: count }, () => 0))
  const [progress, setProgress] = useState<readonly number[]>(current.current)

  useEffect(() => {
    const target = Array.from({ length: count }, (_, index) => (index === hovered ? 1 : 0))
    if (!enabled) {
      current.current = target
      setProgress(target)
      return
    }

    const start = current.current
    const startedAt = Date.now()
    const timer = setInterval(() => {
      const elapsed = Math.min(1, (Date.now() - startedAt) / HOVER_FADE_DURATION_MS)
      const eased = 1 - (1 - elapsed) ** 3
      const next = start.map((value, index) => value + (target[index]! - value) * eased)
      current.current = next
      setProgress(next)
      if (elapsed === 1) {
        clearInterval(timer)
      }
    }, 24)
    return (): void => clearInterval(timer)
  }, [count, enabled, hovered])

  return progress
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
