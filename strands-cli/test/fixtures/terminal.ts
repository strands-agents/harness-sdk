import { PassThrough } from 'node:stream'
import type { ReactNode } from 'react'
import { render as inkRender, type Instance, type RenderOptions } from 'ink'
import { afterEach, vi } from 'vitest'

import { sanitizeTerminalText } from '../../src/tui/terminal/sanitize.js'

const instances: Instance[] = []

afterEach(async () => {
  for (const instance of instances.splice(0)) {
    instance.unmount()
    await instance.waitUntilExit()
  }
})

/** Unit tests inspect complete frames; PTY tests exercise incremental terminal rendering. */
export function render(node: ReactNode, options: RenderOptions): Instance {
  const instance = inkRender(node, {
    debug: true,
    interactive: true,
    incrementalRendering: false,
    patchConsole: false,
    exitOnCtrlC: false,
    ...options,
  })
  // Ink registers a beforeExit listener even when waitUntilExit is first called after unmount.
  const exited = instance.waitUntilExit()
  void exited.catch(() => {})
  instance.waitUntilExit = () => exited
  instances.push(instance)
  return instance
}

export function ttyInput(): NodeJS.ReadStream & PassThrough {
  const input = new PassThrough() as PassThrough & NodeJS.ReadStream
  input.isTTY = true
  input.setRawMode = vi.fn(() => input)
  input.ref = vi.fn(() => input)
  input.unref = vi.fn(() => input)
  return input
}

export function ttyOutput(columns: number, rows: number): NodeJS.WriteStream {
  const output = new PassThrough({ highWaterMark: 16 * 1024 }) as PassThrough & NodeJS.WriteStream
  output.isTTY = true
  output.columns = columns
  output.rows = rows
  output.resume()
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
