import { describe, expect, it } from 'vitest'

import { editHarnessName, HARNESS_NAME_RULE, harnessNameProblem } from '../../src/dev/picker.js'

const allowedCharacters = 'Use letters, digits, ".", "_", and "-".'
const atEnd = (value: string) => ({ value, cursor: value.length })

describe('editHarnessName', () => {
  it.each(['x', 'my-agent', 'v1.2_beta', 'ABC123'])('shouldInsertTheInputWhenEveryCharacterIsAllowed %s', (input) => {
    expect(editHarnessName(atEnd('name-'), input, {})).toEqual(atEnd(`name-${input}`))
  })

  it.each([
    [' ', 'name', 'space'],
    ['/', 'name', '"/"'],
    [' /x', 'namex', 'space and "/"'],
    ['support agent/v2', 'namesupportagentv2', 'space and "/"'],
    ['a\tb', 'nameab', 'tab'],
    ['bot\n', 'namebot', 'line break'],
    ['café', 'namecaf', '"é"'],
    ['a b c#', 'nameabc', 'space and "#"'],
    ['a\u0000b', 'nameab', 'control character'],
    ['a\u200bb', 'nameab', 'invisible character'],
  ])('shouldKeepTheAllowedCharactersAndNameTheRemovedOnesWhenTheInputIs %j', (input, value, removed) => {
    expect(editHarnessName(atEnd('name'), input, {})).toEqual({
      ...atEnd(value),
      notice: `Removed ${removed}. ${allowedCharacters}`,
    })
  })

  it('shouldInsertAtTheCursorWhenTheCursorIsInsideTheName', () => {
    expect(editHarnessName({ value: 'newharness', cursor: 3 }, ' -', {})).toEqual({
      value: 'new-harness',
      cursor: 4,
      notice: `Removed space. ${allowedCharacters}`,
    })
  })

  it('shouldCutTheInputAtTheLimitWhenTheNameWouldBeTooLong', () => {
    const field = atEnd('a'.repeat(60))

    const edited = editHarnessName(field, 'bcdefgh', {})

    expect(edited).toEqual({ ...atEnd(`${'a'.repeat(60)}bcde`), notice: 'A name can have at most 64 characters.' })
  })

  it.each([
    ['left', { leftArrow: true }, '', 2, { value: 'name', cursor: 1 }],
    ['right', { rightArrow: true }, '', 1, { value: 'name', cursor: 2 }],
    ['backspace', { backspace: true }, '', 2, { value: 'nme', cursor: 1 }],
    ['delete character', {}, '\u007f', 2, { value: 'nme', cursor: 1 }],
    ['control U', { ctrl: true }, 'u', 2, { value: 'me', cursor: 0 }],
  ])('shouldEditWithoutANoticeWhenTheKeyIs %s', (_case, key, input, cursor, expected) => {
    const field = { value: 'name', cursor, notice: `Removed space. ${allowedCharacters}` }

    expect(editHarnessName(field, input, key)).toEqual(expected)
  })
})

describe('harnessNameProblem', () => {
  it.each([
    ['', 'Enter a name.'],
    ['.', 'Enter a name other than "." or "..".'],
    ['..', 'Enter a name other than "." or "..".'],
  ])('shouldSayWhatTheNameNeedsWhenTheNameIs %j', (name, problem) => {
    expect(harnessNameProblem(name)).toBe(problem)
  })

  it.each(['new-harness', '.hidden', 'a..b'])('shouldAcceptTheNameWhenItHasAllowedCharacters %s', (name) => {
    expect(harnessNameProblem(name)).toBeUndefined()
  })
})

describe('HARNESS_NAME_RULE', () => {
  it('shouldNameTheAllowedCharactersAndTheLimitWhenTheFormShowsIt', () => {
    expect(HARNESS_NAME_RULE).toBe(`${allowedCharacters} Up to 64 characters.`)
  })
})
