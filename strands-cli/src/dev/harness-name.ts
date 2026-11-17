import type { Key } from 'ink'

import { emptyEditor, reduceInputSequence } from '../terminal/composer.js'
import { graphemes } from '../terminal/text.js'

export interface HarnessNameField {
  readonly value: string
  readonly cursor: number
  readonly notice?: string
}

const NAME_LIMIT = 64
const ALLOWED = 'letters, digits, ".", "_", and "-"'
const NAME_CHARACTER = /^[a-zA-Z0-9._-]$/u
const EDITING_CONTROL = /^[\b\u007f]$/u
const LIMIT_NOTICE = `A name can have at most ${NAME_LIMIT} characters.`
const RESERVED_NAMES = new Set(['.', '..'])
const removedList = new Intl.ListFormat('en', { type: 'conjunction' })

export const HARNESS_NAME_RULE = `Use ${ALLOWED}. Up to ${NAME_LIMIT} characters.`

const characterName = (character: string): string =>
  character === ' '
    ? 'space'
    : character === '\t'
      ? 'tab'
      : /^[\r\n]+$/u.test(character)
        ? 'line break'
        : /\p{Cc}/u.test(character)
          ? 'control character'
          : /^\p{Cf}+$/u.test(character)
            ? 'invisible character'
            : `"${character}"`

const removedNotice = (removed: readonly string[]): string =>
  `Removed ${removedList.format([...new Set(removed.map(characterName))])}. Use ${ALLOWED}.`

export const editHarnessName = (field: HarnessNameField, input: string, key: Partial<Key>): HarnessNameField => {
  const command = key.ctrl === true || key.meta === true
  const characters = graphemes(input)
  const allowed = (character: string): boolean =>
    command || NAME_CHARACTER.test(character) || EDITING_CONTROL.test(character)
  const kept = characters.filter(allowed)
  const removed = characters.filter((character) => !allowed(character))
  const room = Math.max(0, NAME_LIMIT - graphemes(field.value).length)
  const typed = kept.some((character) => EDITING_CONTROL.test(character)) ? kept : kept.slice(0, room)
  const { state } = reduceInputSequence(
    { ...emptyEditor(), input: field.value, cursor: field.cursor },
    typed.join(''),
    key,
    'idle'
  )
  if (graphemes(state.input).length > NAME_LIMIT)
    return { value: field.value, cursor: field.cursor, notice: LIMIT_NOTICE }
  const notice = removed.length ? removedNotice(removed) : typed.length < kept.length ? LIMIT_NOTICE : undefined
  return { value: state.input, cursor: state.cursor, ...(notice ? { notice } : {}) }
}

export const harnessNameProblem = (name: string): string | undefined =>
  !name ? 'Enter a name.' : RESERVED_NAMES.has(name) ? 'Enter a name other than "." or "..".' : undefined
