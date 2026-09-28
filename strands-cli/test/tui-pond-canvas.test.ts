import { describe, expect, it } from 'vitest'

import { Canvas } from '../src/tui/view/frog-canvas.js'

describe('pond canvas labels', () => {
  it('rounds coordinates and clips each Unicode character at the canvas edges', () => {
    const canvas = new Canvas(4, 2)
    canvas.label(-1.4, 0.6, 'a🐸cdef', 'white', 'ink')
    expect(canvas.rows(false)).toEqual(['    ', '🐸cde'])

    const before = canvas.rows(true)
    canvas.label(0, -0.6, 'above', 'red', 'yellow', 10)
    canvas.label(0, 1.6, 'below', 'red', 'yellow', 10)
    expect(canvas.rows(true)).toEqual(before)
  })

  it('uses rounded label coordinates for party foreground and background colors', () => {
    const canvas = new Canvas(5, 4, 'green', true, 320)
    const expected = new Canvas(5, 4, 'green', true, 320)
    canvas.label(1.6, 1.6, 'ab', 'white', 'ink', 5)
    expected.label(2, 2, 'ab', 'white', 'ink', 5)
    expect(canvas.rows(true)).toEqual(expected.rows(true))
    expect(canvas.runs(true)).toEqual(expected.runs(true))
  })

  it('rejects lower-priority text and background together and accepts equal-priority writes', () => {
    const canvas = new Canvas(1, 1)
    canvas.label(0, 0, 'A', 'white', 'ink', 5)
    const before = canvas.rows(true)

    canvas.label(0, 0, 'B', 'red', 'yellow', 4)
    canvas.set(0, 0, 'C', 'red', 4, 'blue')
    expect(canvas.rows(true)).toEqual(before)

    canvas.set(0, 0, 'D', 'red', 5, 'blue')
    expect(canvas.rows(false)).toEqual(['D'])
    expect(canvas.rows(true)[0]).toContain('\u001b[48;2;82;139;255m')

    canvas.set(0, 0, 'E', 'white', 5)
    expect(canvas.rows(true)).toEqual(['\u001b[38;2;235;255;241m\u001b[49mE\u001b[0m'])
  })

  it('ignores empty labels and empty characters without changing background or priority', () => {
    const canvas = new Canvas(1, 1)
    canvas.label(0, 0, 'A', 'white', 'ink', 5)
    const before = canvas.rows(true)
    canvas.label(0, 0, '', 'red', 'yellow', 10)
    canvas.set(0, 0, '', 'red', 10, 'blue')
    canvas.set(0, 0, '', 'red', 10)
    expect(canvas.rows(true)).toEqual(before)

    canvas.label(0, 0, 'B', 'white', 'ink', 5)
    expect(canvas.rows(false)).toEqual(['B'])
  })

  it('keeps label spaces opaque over pixels until an ordinary set clears their background', () => {
    const canvas = new Canvas(3, 1)
    canvas.setPixel(1, 0, 'red')
    canvas.label(0, 0, '   ', 'white', 'ink', 1)
    expect(canvas.rows(false)).toEqual(['   '])
    expect(canvas.runs(false)).toEqual([{ row: 0, column: 0, text: '   ' }])
    expect(canvas.rows(true)[0]).toContain('\u001b[48;2;7;28;17m')

    canvas.set(1, 0, ' ', 'white', 1)
    expect(canvas.runs(false)).toEqual([
      { row: 0, column: 0, text: ' ' },
      { row: 0, column: 2, text: ' ' },
    ])
  })
})
