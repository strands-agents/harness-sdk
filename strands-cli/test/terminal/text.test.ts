import { describe, expect, it } from 'vitest'

import { wrapWords } from '../../src/terminal/text.js'

describe('wrapWords', () => {
  it.each([
    ['BreakAtTheLastSpaceThatFits', 'issued refund without checking', 14, ['issued refund', 'without', 'checking']],
    ['SplitAWordThatIsWiderThanTheWidth', 'abcdefghij xy', 4, ['abcd', 'efgh', 'ij', 'xy']],
    ['KeepLineBreaksAndIndentation', 'def f():\n    return 1\n', 20, ['def f():', '    return 1', '']],
    ['MeasureWideCharactersByCells', '你好 世界', 4, ['你好', '世界']],
    ['ExpandTabsAndDropCarriageReturns', 'a\tb\r\nc', 20, ['a    b', 'c']],
    ['KeepOneCharacterPerRowWhenTheWidthIsZero', 'ab', 0, ['a', 'b']],
  ])('should%s', (_case, text, width, rows) => {
    expect(wrapWords(text, width)).toEqual(rows)
  })
})
