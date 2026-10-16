import { PassThrough } from 'node:stream'
import { vi } from 'vitest'

import { sanitizeTerminalText } from '../../src/tui/terminal/sanitize.js'

export function ttyInput(): NodeJS.ReadStream & PassThrough {
  const input = new PassThrough() as PassThrough & NodeJS.ReadStream
  input.isTTY = true
  input.setRawMode = vi.fn(() => input)
  input.ref = vi.fn(() => input)
  input.unref = vi.fn(() => input)
  return input
}

export function ttyOutput(columns: number, rows: number): NodeJS.WriteStream {
  const output = new PassThrough() as PassThrough & NodeJS.WriteStream
  output.isTTY = true
  output.columns = columns
  output.rows = rows
  return output
}

/** Tracks the latest sanitized multi-line frame the app wrote; call the returned getter to read it. */
export function captureFrame(output: NodeJS.WriteStream): () => string[] {
  let frame: string[] = []
  output.on('data', (chunk: Buffer) => {
    const text = sanitizeTerminalText(chunk.toString())
    if (text.includes('\n') && text.trim()) {
      frame = text.split('\n')
    }
  })
  return () => frame
}

export function mouseInputSequence(button: number, column: number, row: number, suffix: 'M' | 'm'): string {
  return `\u001b[<${button};${column + 1};${row + 1}${suffix}`
}
