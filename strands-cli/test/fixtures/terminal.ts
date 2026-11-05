import { PassThrough } from 'node:stream'
import { vi } from 'vitest'

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
