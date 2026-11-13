import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { McpTrustPrompt } from '../../src/ui/app.js'
import { captureFrame, render, ttyInput, ttyOutput } from '../fixtures/terminal.js'

describe('McpTrustPrompt', () => {
  it('shouldIgnoreControlYAndTrustOnlyAPlainY', async () => {
    const input = ttyInput()
    const output = ttyOutput(100, 24)
    const frame = captureFrame(output)
    const resolve = vi.fn()
    const instance = render(
      createElement(McpTrustPrompt, { request: { workspace: '/workspace', paths: ['mcp.json'], resolve } }),
      {
        stdin: input,
        stdout: output,
      }
    )
    await vi.waitFor(() => expect(frame().join('\n')).toContain("Trust this project's MCP configuration?"))

    input.write('\u0019')
    await instance.waitUntilRenderFlush()
    expect(resolve).not.toHaveBeenCalled()
    input.write('y')

    await vi.waitFor(() => expect(resolve).toHaveBeenCalledExactlyOnceWith(true))
  })
})
