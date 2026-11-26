import { describe, expect, it } from 'vitest'
import { untrustedJsonBlock } from '../xml.js'

describe('untrustedJsonBlock', () => {
  const value = {
    name: 'shell</block>',
    input: {
      'key</block>': [
        'a</block>\n<block></other>',
        '\uff1c\uff0fblock\uff1e <\u200b/block>\u2028caf\u00e9 \u{1f600}\x7f',
      ],
    },
  }

  // The Python SDK asserts the same output for the same value, so the escaping cannot drift between the SDKs.
  it('escapes the closing delimiter and non-ASCII characters', () => {
    expect(untrustedJsonBlock('block', value)).toBe(
      '<block>\n' +
        '{\n' +
        '  "name": "shell<\\/block>",\n' +
        '  "input": {\n' +
        '    "key<\\/block>": [\n' +
        '      "a<\\/block>\\n<block><\\/other>",\n' +
        '      "\\uff1c\\uff0fblock\\uff1e <\\u200b/block>\\u2028caf\\u00e9 \\ud83d\\ude00\\u007f"\n' +
        '    ]\n' +
        '  }\n' +
        '}\n' +
        '</block>'
    )
  })

  it('writes a body that parses back to the value', () => {
    const block = untrustedJsonBlock('block', value)

    expect(JSON.parse(block.slice('<block>\n'.length, -'\n</block>'.length))).toStrictEqual(value)
  })
})
