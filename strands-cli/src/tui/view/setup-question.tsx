import type { ReactElement } from 'react'
import type { DOMElement } from 'ink'
import stringWidth from 'string-width'

import type { ChatPanel, ChatPanelRow, FrogTheme } from '../chat/controller.js'
import { renderSetupGuideFrog, SETUP_GUIDE_TRANSITION_DURATION_MS, setupGuideLayout } from './frog-intro-renderer.js'
import { Markdown } from './markdown.js'
import { Box, Text, ThemeProvider, useTheme } from './theme.js'
import { useSpinner } from './use-spinner.js'

const SPEECH_BUBBLE_BACKGROUND = '#ffffff'
const SPEECH_BUBBLE_FOREGROUND = '#000000'
const SPEECH_BUBBLE_THEME = {
  frogTheme: 'custom',
  colorMode: 'light',
  customTheme: {
    base: 'minimal',
    light: {
      background: SPEECH_BUBBLE_BACKGROUND,
      foreground: SPEECH_BUBBLE_FOREGROUND,
      muted: SPEECH_BUBBLE_FOREGROUND,
      surface: SPEECH_BUBBLE_BACKGROUND,
      panel: SPEECH_BUBBLE_BACKGROUND,
      selection: SPEECH_BUBBLE_BACKGROUND,
      border: SPEECH_BUBBLE_FOREGROUND,
      accent: SPEECH_BUBBLE_FOREGROUND,
      hover: SPEECH_BUBBLE_FOREGROUND,
      success: SPEECH_BUBBLE_FOREGROUND,
      warning: SPEECH_BUBBLE_FOREGROUND,
      error: SPEECH_BUBBLE_FOREGROUND,
      frog: SPEECH_BUBBLE_FOREGROUND,
    },
    dark: {},
  },
} as const

export function SetupQuestion({
  message,
  answer,
  working,
  animate,
  panel,
  rows,
  selected,
  terminalWidth,
  terminalHeight,
  frogTheme,
  customBase,
  hoveredRow,
  onPanelElement,
  onRowElement,
}: {
  message: string
  answer?: string
  working: boolean
  animate: boolean
  panel?: ChatPanel
  rows: readonly ChatPanelRow[]
  selected: number
  terminalWidth: number
  terminalHeight: number
  frogTheme: FrogTheme
  customBase: Exclude<FrogTheme, 'custom'>
  hoveredRow?: number
  onPanelElement?: (element: DOMElement | null) => void
  onRowElement?: (index: number, element: DOMElement | null) => void
}): ReactElement {
  const palette = useTheme()
  const spinner = useSpinner(working, animate)
  const elapsedMs = SETUP_GUIDE_TRANSITION_DURATION_MS
  const width = Math.max(1, terminalWidth - 2)
  const height = Math.max(1, terminalHeight)
  const wide = width >= 68
  const compactHeight = height < 24
  const showFrog =
    (wide && (height >= 24 || message.length <= 200)) ||
    (!wide && !compactHeight && rows.length <= 3 && message.length <= 120)
  const { frogWidth, frogHeight, bubbleWidth, tailWidth, contentWidth } = setupGuideLayout(width, height, showFrog)
  const frogOptions = {
    colorMode: palette.mode,
    customBase,
    ...(frogTheme === 'custom' ? { frogColor: palette.frog } : {}),
  }

  const frog = showFrog ? renderSetupGuideFrog(frogWidth, frogHeight, 1, elapsedMs, true, frogTheme, frogOptions) : ''
  const labels = rows.map((row) => row.label)
  const choicesHorizontal = wide && rows.length <= 3 && horizontalChoicesWidth(labels) <= bubbleWidth
  const choiceColumns =
    rows.length > 6 && choiceLabelsFit(labels, bubbleWidth, 3)
      ? 3
      : rows.length > 3 && choiceLabelsFit(labels, bubbleWidth, 2)
        ? 2
        : !wide && compactHeight && rows.length > 2 && choiceLabelsFit(labels, bubbleWidth, 2)
          ? 2
          : 1
  const renderedChoiceColumns = choicesHorizontal ? rows.length : choiceColumns
  const choiceWidths = choicesHorizontal
    ? horizontalChoiceWidths(
        rows.map((row) => row.label),
        bubbleWidth
      )
    : rows.map(() =>
        renderedChoiceColumns > 1
          ? Math.max(12, Math.floor((bubbleWidth - renderedChoiceColumns + 1) / renderedChoiceColumns))
          : ('100%' as const)
      )
  const speech =
    message || working ? (
      <Box
        width={bubbleWidth}
        flexDirection="column"
        borderStyle="round"
        borderColor={SPEECH_BUBBLE_FOREGROUND}
        backgroundColor={SPEECH_BUBBLE_BACKGROUND}
        minHeight={working ? (compactHeight ? 3 : 7) : undefined}
        paddingX={compactHeight ? 1 : 2}
        paddingY={compactHeight ? 0 : wide ? 1 : 0}
      >
        <ThemeProvider settings={SPEECH_BUBBLE_THEME}>
          {message ? <Markdown>{message}</Markdown> : null}
          {working ? <Text color={SPEECH_BUBBLE_FOREGROUND}>{spinner}</Text> : null}
        </ThemeProvider>
      </Box>
    ) : null
  const response = answer ? (
    <Box width={bubbleWidth} marginTop={1} paddingX={1}>
      <Text wrap="wrap">
        <Text dimColor>You: </Text>
        {answer}
      </Text>
    </Box>
  ) : null
  const controls = panel ? (
    <Box ref={onPanelElement} width={bubbleWidth} marginTop={1} flexDirection="column">
      <Box
        flexDirection={choicesHorizontal ? 'row' : choiceColumns > 1 ? 'row' : 'column'}
        flexWrap={choiceColumns > 1 ? 'wrap' : 'nowrap'}
        columnGap={1}
      >
        {rows.map((row, index) => {
          const active = index === selected
          const hovered = index === hoveredRow
          return (
            <Box
              key={row.value ?? row.label}
              ref={(element): void => onRowElement?.(index, element)}
              width={choiceWidths[index]}
              height={compactHeight ? 1 : 3}
              paddingX={choicesHorizontal ? 1 : 0}
              alignItems="center"
              justifyContent="center"
              backgroundColor={hovered ? palette.selection : active ? palette.accent : palette.surface}
            >
              <Text
                color={hovered ? palette.accent : active ? palette.surface : palette.foreground}
                bold={active}
                wrap={!compactHeight && !choicesHorizontal ? 'wrap' : 'truncate-end'}
              >
                {row.label}
              </Text>
            </Box>
          )
        })}
      </Box>
      <Box marginTop={1} paddingX={1}>
        <Text dimColor wrap="wrap">
          Want something else? Type a custom response or ask a question in the message box below.
        </Text>
      </Box>
    </Box>
  ) : message && !working ? (
    <Box width={bubbleWidth} paddingX={1}>
      <Text dimColor wrap="truncate-end">
        Type your reply below and press Enter.
      </Text>
    </Box>
  ) : null

  return (
    <Box width="100%" height="100%" alignItems="center" justifyContent="center" overflow="hidden">
      <Box
        width={contentWidth}
        flexDirection={wide ? 'row' : 'column'}
        alignItems={wide && working ? 'flex-start' : 'center'}
        justifyContent="center"
      >
        {showFrog ? (
          <Box width={frogWidth} flexDirection="column" alignItems="center" flexShrink={0}>
            <Box width={frogWidth} height={frogHeight} overflow="hidden">
              <Text>{frog}</Text>
            </Box>
            <Text bold>Dr. Harness</Text>
          </Box>
        ) : null}
        {wide ? (
          <Box width={bubbleWidth + tailWidth} flexDirection="column">
            {speech ? (
              <Box flexDirection="row" alignItems="center">
                {showFrog ? (
                  <Box width={tailWidth} flexShrink={0} justifyContent="center">
                    <Text color={SPEECH_BUBBLE_BACKGROUND}>◀</Text>
                  </Box>
                ) : null}
                {speech}
              </Box>
            ) : null}
            <Box width={bubbleWidth} marginLeft={tailWidth} flexDirection="column">
              {response}
              {controls}
            </Box>
          </Box>
        ) : (
          <Box width={bubbleWidth} flexDirection="column">
            {speech && showFrog ? <Text color={SPEECH_BUBBLE_BACKGROUND}>▲</Text> : null}
            {speech}
            {response}
            {controls}
          </Box>
        )}
      </Box>
    </Box>
  )
}

function horizontalChoiceWidths(labels: readonly string[], width: number): number[] {
  const available = width - labels.length + 1
  const minimums = labels.map((label) => Math.max(12, stringWidth(label) + 2))
  const required = minimums.reduce((total, value) => total + value, 0)
  if (required > available) {
    return labels.map(() => Math.max(12, Math.floor(available / labels.length)))
  }
  const extra = available - required
  return minimums.map((minimum, index) => minimum + Math.floor((extra + index) / labels.length))
}

function horizontalChoicesWidth(labels: readonly string[]): number {
  return (
    labels.reduce((total, label) => total + Math.max(12, stringWidth(label) + 2), 0) + Math.max(0, labels.length - 1)
  )
}

function choiceLabelsFit(labels: readonly string[], width: number, columns: number): boolean {
  const choiceWidth = Math.max(12, Math.floor((width - columns + 1) / columns))
  return labels.every((label) => stringWidth(label) <= choiceWidth)
}
