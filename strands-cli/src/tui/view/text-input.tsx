import { useEffect, useState, type ReactElement } from 'react'
import { useStdout } from 'ink'

import { graphemes, promptViewport } from '../terminal/composer.js'
import { Text, useTheme } from './theme.js'

const TEXT_INPUT_PLACEHOLDER = 'Click to enter text'

export function BlinkingCursor({
  character = ' ',
  animate = true,
  color,
}: {
  character?: string
  animate?: boolean
  color?: string
}): ReactElement {
  const { stdout } = useStdout()
  const { accent } = useTheme()
  const [visible, setVisible] = useState(true)
  const enabled = animate && stdout.isTTY

  useEffect(() => {
    setVisible(true)
    if (!enabled) {
      return
    }
    const timer = setInterval(() => setVisible((current) => !current), 500)
    return (): void => clearInterval(timer)
  }, [enabled])

  if (character === ' ') {
    return <Text color={color ?? accent}>{visible ? '▌' : ' '}</Text>
  }
  return (
    <Text inverse={visible} {...(color ? { color } : {})}>
      {character}
    </Text>
  )
}

export function EditableText({
  value,
  cursor,
  width,
  maxRows = 1,
  active,
  animate = true,
  masked = false,
  placeholder = TEXT_INPUT_PLACEHOLDER,
}: {
  value: string
  cursor: number
  width: number
  maxRows?: number
  active: boolean
  animate?: boolean
  masked?: boolean
  placeholder?: string
}): ReactElement {
  const displayValue = masked ? '•'.repeat(graphemes(value).length) : value
  if (!active && !displayValue) {
    return (
      <Text dimColor wrap="truncate-end">
        {placeholder}
      </Text>
    )
  }
  const rows = promptViewport(displayValue, cursor, width, maxRows)
  return (
    <>
      {rows.map((row, index) => (
        <Text key={index} dimColor={!active} wrap="truncate-end">
          {row.before}
          {active && row.current !== undefined ? (
            <BlinkingCursor character={row.current} animate={animate} />
          ) : (
            row.current
          )}
          {row.after}
        </Text>
      ))}
    </>
  )
}
