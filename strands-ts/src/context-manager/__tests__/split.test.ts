import { describe, it, expect } from 'vitest'
import { fieldRef, isFieldRef, splitLargeStrings } from '../split.js'
import { JsonBlock, TextBlock } from '../../types/messages.js'
import { ImageBlock } from '../../types/media.js'

const BIG = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n') // 4,391 chars, 500 lines

describe('splitLargeStrings (#4741)', () => {
  it('splits a large field of a JSON text block', () => {
    const item = new TextBlock(JSON.stringify({ output: BIG, error: '', exit_code: 0 }))
    const { parent, fields } = splitLargeStrings(item, 'tu_0', 1000)
    expect(fields).toEqual({ 'fields/tu_0/output': BIG })
    expect(JSON.parse((parent as TextBlock).text)).toEqual({
      output: '[ref: fields/tu_0/output (500 lines, 4,391 chars)]',
      error: '',
      exit_code: 0,
    })
  })

  it('splits a large field of a JsonBlock', () => {
    const { parent, fields } = splitLargeStrings(new JsonBlock({ json: { output: BIG, exit_code: 0 } }), 'tu_0', 1000)
    expect(fields).toEqual({ 'fields/tu_0/output': BIG })
    expect(parent.toJSON()).toEqual({
      json: { output: '[ref: fields/tu_0/output (500 lines, 4,391 chars)]', exit_code: 0 },
    })
  })

  it('splits a large plain text block', () => {
    const { parent, fields } = splitLargeStrings(new TextBlock(BIG), 'tu_0', 1000)
    expect(fields).toEqual({ 'fields/tu_0/text': BIG })
    expect(parent.toJSON()).toEqual({ text: '[ref: fields/tu_0/text (500 lines, 4,391 chars)]' })
  })

  it('splits several fields', () => {
    const item = new JsonBlock({ json: { stdout: BIG, stderr: BIG.toUpperCase(), code: 1 } })
    const { parent, fields } = splitLargeStrings(item, 'tu_0', 1000)
    expect(Object.keys(fields)).toEqual(['fields/tu_0/stdout', 'fields/tu_0/stderr'])
    expect((parent as JsonBlock).json).toMatchObject({ code: 1 })
  })

  it('splits large text that is not a JSON object as text', () => {
    for (const text of ['x'.repeat(5000) + '{not json', JSON.stringify([BIG])]) {
      const { parent, fields } = splitLargeStrings(new TextBlock(text), 'tu_0', 1000)
      expect(fields).toEqual({ 'fields/tu_0/text': text })
      expect((parent as TextBlock).text.startsWith('[ref: fields/tu_0/text (1 lines, ')).toBe(true)
    }
  })

  it.each([
    new TextBlock('short'),
    new TextBlock(JSON.stringify({ output: 'short', exit_code: 0 })),
    new JsonBlock({ json: { items: [BIG] } }),
    new JsonBlock({ json: { nested: { output: BIG } } }),
    new JsonBlock({ json: { 'bad key/name': BIG } }),
    new JsonBlock({ json: { output: 'x'.repeat(999) } }),
    new TextBlock(JSON.stringify({ a: 'x'.repeat(600), b: 'y'.repeat(600) })),
    new ImageBlock({ format: 'png', source: { bytes: new Uint8Array([1, 2, 3]) } }),
  ])('leaves other content unchanged: %s', (item) => {
    const { parent, fields } = splitLargeStrings(item, 'tu_0', 1000)
    expect(parent).toBe(item)
    expect(fields).toEqual({})
  })

  it('measures length in code points like Python', () => {
    const emoji = '😀'.repeat(600) // 600 code points, 1,200 UTF-16 units
    expect(splitLargeStrings(new TextBlock(emoji), 'tu_0', 1000).fields).toEqual({})
    const { parent } = splitLargeStrings(new TextBlock('😀'.repeat(1000)), 'tu_0', 1000)
    expect((parent as TextBlock).text).toBe('[ref: fields/tu_0/text (1 lines, 1,000 chars)]')
  })

  it('field ref helpers', () => {
    expect(fieldRef('tu_0', 'output')).toBe('fields/tu_0/output')
    expect(isFieldRef('fields/tu_0/output')).toBe(true)
    expect(isFieldRef('tu_0')).toBe(false)
    expect(isFieldRef('fields/x_0')).toBe(false) // a block key whose toolUseId merely starts with "fields/"
  })
})
