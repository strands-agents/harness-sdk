import { Buffer } from 'node:buffer'
import { describe, it, expect } from 'vitest'
import { streamProcess } from '../stream-process.js'
import type { ExecutionResult } from '../types.js'

describe('streamProcess', () => {
  // guards against U+FFFD replacement characters when a multibyte UTF-8 sequence
  // straddles a pipe read boundary (#4156)
  it('decodes multibyte UTF-8 split across chunk boundaries', async () => {
    const text = 'café ☕ 你好'
    const bytes = Buffer.from(text, 'utf8')
    const splitAt = bytes.indexOf(0xa9) // second byte of 'é' (0xC3 0xA9)
    const first = [...bytes.subarray(0, splitAt)].join(',')
    const rest = [...bytes.subarray(splitAt)].join(',')
    const script =
      `process.stdout.write(Buffer.from([${first}])); ` +
      `process.stderr.write(Buffer.from([${first}])); ` +
      'setTimeout(() => { ' +
      `process.stdout.write(Buffer.from([${rest}])); ` +
      `process.stderr.write(Buffer.from([${rest}]))` +
      '}, 50)'

    const chunks: string[] = []
    let result: ExecutionResult | undefined
    for await (const item of streamProcess(process.execPath, ['-e', script])) {
      if (item.type === 'streamChunk' && item.streamType === 'stdout') {
        chunks.push(item.data)
      } else if (item.type === 'executionResult') {
        result = item
      }
    }

    expect(chunks.join('')).toBe(text)
    expect(result).toEqual({
      type: 'executionResult',
      exitCode: 0,
      stdout: text,
      stderr: text,
      outputFiles: [],
    })
  })
})
