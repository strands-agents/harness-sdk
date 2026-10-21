import type { ReactElement } from 'react'
import stringWidth from 'string-width'

import { graphemes, promptViewport, type PromptViewportRow } from '../terminal/composer.js'
import { Text, useTheme } from './theme.js'

const TEXT_INPUT_PLACEHOLDER = 'Click to enter text'

export function Cursor({ character = ' ', color }: { character?: string; color?: string }): ReactElement {
  const { accent } = useTheme()
  if (character === ' ') {
    return <Text color={color ?? accent}>▌</Text>
  }
  return (
    <Text inverse {...(color ? { color } : {})}>
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
  masked = false,
  placeholder = TEXT_INPUT_PLACEHOLDER,
}: {
  value: string
  cursor: number
  width: number
  maxRows?: number
  active: boolean
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
  const rows =
    maxRows === 1
      ? [singleLineViewport(displayValue, cursor, width, active)]
      : promptViewport(displayValue, cursor, width, maxRows)
  return (
    <>
      {rows.map((row, index) => (
        <Text key={index} dimColor={!active} wrap="truncate-end">
          {row.before}
          {active && row.current !== undefined ? <Cursor character={row.current} /> : row.current}
          {row.after}
        </Text>
      ))}
    </>
  )
}

function singleLineViewport(value: string, cursor: number, width: number, active: boolean): PromptViewportRow {
  const characters = graphemes(value).map((character) => (character === '\n' ? ' ' : character))
  const safeCursor = Math.max(0, Math.min(cursor, characters.length))
  const safeWidth = Math.max(1, width)
  let current = characters[safeCursor] ?? (active ? ' ' : undefined)
  if (current && stringWidth(current) > safeWidth) current = ' '
  let columns = current ? stringWidth(current) : 0
  let start = safeCursor
  while (start > 0 && columns + stringWidth(characters[start - 1]!) <= safeWidth) {
    columns += stringWidth(characters[--start]!)
  }
  let end = Math.min(characters.length, safeCursor + 1)
  while (end < characters.length && columns + stringWidth(characters[end]!) <= safeWidth) {
    columns += stringWidth(characters[end++]!)
  }
  return {
    before: characters.slice(start, safeCursor).join(''),
    ...(current === undefined ? {} : { current }),
    after: characters.slice(safeCursor + 1, end).join(''),
  }
}
