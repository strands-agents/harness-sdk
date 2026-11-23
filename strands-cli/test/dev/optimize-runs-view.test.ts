import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { OptimizeRunsView } from '../../src/dev/temporary-evals-fork/optimize-runs-view.js'
import type { EvalsBrowser, OptimizeState } from '../../src/dev/panels/model.js'
import { captureFrame, render, ttyInput, ttyOutput } from '../fixtures/terminal.js'

const running: OptimizeState = {
  step: 'pick',
  runs: [
    {
      id: 'run-1',
      experiment: 'diff-smoke-test',
      startedAt: 0,
      state: {
        step: 'running',
        progress: { run: '20261120-215946-diff-smoke-test', baseline: 0.1, candidates: [], planned: 17 },
      },
    },
  ],
} as never

const store = (state: OptimizeState) => ({
  subscribe: () => () => {},
  snapshot: () => state,
})

const browser: EvalsBrowser = {
  subscribe: () => () => {},
  snapshot: () => ({ status: 'ready' }),
  open: vi.fn(),
  address: vi.fn(async () => ({ status: 'ready', url: 'http://127.0.0.1:7777/optimization/run-1?t=tok' }) as const),
}

const show = async (close = vi.fn()) => {
  const input = ttyInput()
  const output = ttyOutput(110, 14)
  const frame = captureFrame(output)
  const instance = render(
    createElement(OptimizeRunsView, {
      session: store(running),
      browser,
      width: 108,
      height: 12,
      close,
      openCommand: () => true,
    }),
    { stdin: input, stdout: output }
  )
  await instance.waitUntilRenderFlush()
  const press = async (key: string): Promise<void> => {
    input.write(key)
    await instance.waitUntilRenderFlush()
  }
  return { press, close, text: (): string => frame().join('\n') }
}

describe('OptimizeRunsView', () => {
  it('shouldCloseOnEscape', async () => {
    const { press, close } = await show()

    await press('\u001b')

    await vi.waitFor(() => expect(close).toHaveBeenCalled())
  })

  it('shouldShowEachRunWithItsOwnPageLink', async () => {
    const { text } = await show()

    await vi.waitFor(() => expect(text()).toContain('open in the evals UI'))
    expect(text()).toContain('● 20261120-215946-diff-smoke-test · 1/17')
  })
})
