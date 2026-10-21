import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Box, useInput, useStdout, type DOMElement } from 'ink'

import { parseMouseInput } from '../terminal/mouse-input.js'
import { errorMessage, sanitizeTerminalText } from '../terminal/sanitize.js'
import { useTerminalSize } from '../terminal/size.js'
import { hyperlinkEscapes, setTerminalMouseMotion } from '../terminal/terminal.js'
import { elementAtMouse, registerElement } from './interaction.js'
import { Text, useTheme } from './theme.js'

const CLI_PACKAGE_URL = 'https://www.npmjs.com/package/@strands-agents/cli'
const UPDATE_CHOICES = [
  { label: 'Update now', description: 'Install the update, then restart Strands.' },
  { label: 'Ask next time', description: 'Dismiss this prompt for this launch.' },
  { label: "Don't ask again", description: 'Disable startup update prompts.' },
] as const

export function UpdatePrompt({
  version,
  onUpdate,
  onLater,
  onDisable,
  width: requestedWidth,
  height: requestedHeight,
  manageMouseMotion = false,
}: {
  version: string
  onUpdate(): void
  onLater(): void
  onDisable(): Promise<boolean>
  width?: number
  height?: number
  manageMouseMotion?: boolean
}): ReactElement {
  const terminal = useTerminalSize()
  const { stdout } = useStdout()
  const palette = useTheme()
  const [selection, setSelection] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const choiceElements = useRef(new Map<number, DOMElement>())
  const pressedChoice = useRef<number | undefined>(undefined)
  const width = Math.max(1, requestedWidth ?? terminal.columns)
  const height = Math.max(1, requestedHeight ?? terminal.rows)
  const cardWidth = Math.max(1, Math.min(70, width - 4))
  const minimumChoiceWidth = Math.max(...UPDATE_CHOICES.map(({ label }) => label.length + 4))
  const horizontal = cardWidth - 4 >= (minimumChoiceWidth + 1) * UPDATE_CHOICES.length - 1
  const borderedChoices = height >= (horizontal ? 12 : 20)
  const showDescription = height >= (horizontal ? 10 : 12)
  const safeVersion = sanitizeTerminalText(version)
  const versionLink = hyperlinkEscapes(CLI_PACKAGE_URL)
  const linkedVersion = versionLink ? `${versionLink.open}${safeVersion}${versionLink.close}` : safeVersion

  useEffect(() => {
    if (!manageMouseMotion) return
    setTerminalMouseMotion(true, stdout)
    return (): void => setTerminalMouseMotion(false, stdout)
  }, [manageMouseMotion, stdout])

  const activate = (index: number): void => {
    if (busy) return
    if (index === 0) {
      onUpdate()
      return
    }
    if (index === 1) {
      onLater()
      return
    }
    setBusy(true)
    setError(undefined)
    void onDisable()
      .then((disabled) => {
        if (!disabled) {
          setError('Could not disable update prompts.')
        }
      })
      .catch((cause: unknown) => {
        setError(errorMessage(cause))
      })
      .finally(() => setBusy(false))
  }

  useInput((input, key) => {
    if (busy) return
    const mouse = parseMouseInput(input)
    if (mouse) {
      const choice = elementAtMouse(choiceElements.current, mouse)
      if (mouse.action === 'move' && choice !== undefined) {
        setSelection(choice)
      } else if (mouse.action === 'press' && (mouse.button & 3) === 0) {
        pressedChoice.current = choice
        if (choice !== undefined) setSelection(choice)
      } else if (mouse.action === 'release') {
        const pressed = pressedChoice.current
        pressedChoice.current = undefined
        if (pressed !== undefined && pressed === choice) activate(pressed)
      }
      return
    }
    if (key.escape) {
      onLater()
      return
    }
    if (key.leftArrow || key.upArrow || (key.shift && key.tab)) {
      setSelection((current) => (current + UPDATE_CHOICES.length - 1) % UPDATE_CHOICES.length)
      return
    }
    if (key.rightArrow || key.downArrow || key.tab) {
      setSelection((current) => (current + 1) % UPDATE_CHOICES.length)
      return
    }
    if (key.return) {
      activate(selection)
      return
    }
    const numberedChoice = Number(input) - 1
    if (Number.isInteger(numberedChoice) && numberedChoice >= 0 && numberedChoice < UPDATE_CHOICES.length) {
      setSelection(numberedChoice)
      activate(numberedChoice)
    }
  })

  return (
    <Box width={width} height={height} alignItems="center" justifyContent="center" overflow="hidden">
      <Box width={cardWidth} flexDirection="column">
        <Box flexDirection="column" paddingX={1} borderStyle="single" borderColor={palette.border} borderDimColor>
          <Text bold>Update available</Text>
          <Text>
            Strands CLI{' '}
            <Text color={palette.accent} underline>
              {linkedVersion}
            </Text>{' '}
            is available!
          </Text>
          <Box marginTop={1} flexDirection={horizontal ? 'row' : 'column'} gap={borderedChoices ? 1 : 0}>
            {UPDATE_CHOICES.map((choice, index) => {
              const active = index === selection
              return (
                <Box
                  key={choice.label}
                  ref={(element) => registerElement(choiceElements.current, index, element)}
                  {...(horizontal ? { flexBasis: 0, flexGrow: 1 } : {})}
                  height={borderedChoices ? 3 : 1}
                  flexShrink={0}
                  justifyContent={borderedChoices || horizontal ? 'center' : 'flex-start'}
                  overflow="hidden"
                  {...(borderedChoices
                    ? {
                        borderStyle: 'single',
                        borderColor: active ? palette.accent : palette.border,
                        borderDimColor: !active,
                      }
                    : {})}
                >
                  <Text bold={active} {...(active ? { color: palette.accent } : {})} wrap="truncate-end">
                    {active ? '▸ ' : borderedChoices || horizontal ? '' : '  '}
                    {choice.label}
                  </Text>
                </Box>
              )
            })}
          </Box>
          {showDescription || error ? (
            <Box marginTop={1} height={1} justifyContent={horizontal ? 'center' : 'flex-start'}>
              <Text color={error ? palette.error : palette.muted} wrap="truncate-end">
                {error ?? UPDATE_CHOICES[selection]!.description}
              </Text>
            </Box>
          ) : null}
        </Box>
        <Box marginTop={1} justifyContent="center">
          <Text dimColor wrap="truncate-end">
            {busy
              ? 'Saving…'
              : `${horizontal ? '←→' : '↑↓'} choose · Enter · Esc ${cardWidth < 48 ? 'later' : 'ask next time'}`}
          </Text>
        </Box>
      </Box>
    </Box>
  )
}
