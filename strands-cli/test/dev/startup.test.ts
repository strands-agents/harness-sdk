import { createElement } from 'react'
import { Text } from 'ink'
import { describe, expect, it, vi } from 'vitest'
import { runInkChat } from '../../src/ui/run.js'
import { sanitizeTerminalText } from '../../src/terminal/text.js'
import { captureFrame, render, ttyInput, ttyOutput } from '../fixtures/terminal.js'
import { CliConfigStore } from '../../src/config/store.js'
import { chooseHarness } from '../../src/dev/picker.js'
import type { DevWorkspace } from '../../src/dev/workspace.js'

const STRANDS_WORDMARK = /STRANDS|▄▟[ █]{3}▙▄|█▀▀ ▀█▀ █▀█ ▄▀█ █▄ █ █▀▄ █▀▀|▀▀ ▀ ▀ {2}▀ {2}▄▀ {3}▄ {4}▀▄ {2}▀▀/

type RenderApp = NonNullable<NonNullable<Parameters<typeof runInkChat>[1]>['renderApp']>

const workspace: DevWorkspace = {
  root: '/workspace',
  entrypoint: '/workspace/agent.ts',
  config: { version: 1, name: 'local', language: 'typescript', entrypoint: 'agent.ts', origin: { kind: 'created' } },
}

describe('dev startup screen', () => {
  const startupRun = (prepare: NonNullable<Parameters<typeof runInkChat>[1]>['prepare']) => {
    const input = ttyInput()
    const output = ttyOutput(120, 35)
    const frames: string[] = []
    output.on('data', (data: Buffer) => {
      const text = sanitizeTerminalText(data.toString())
      if (text.includes('\n') && text.trim()) frames.push(text)
    })
    const renderApp = vi.fn(render as RenderApp)
    const factory = vi.fn(async (): Promise<never> => {
      throw new Error('Unexpected agent startup')
    })
    const running = runInkChat(factory, {
      input,
      output,
      errorOutput: output,
      config: CliConfigStore.memory({}, { animations: false }),
      intro: false,
      renderApp,
      ...(prepare ? { prepare } : {}),
    })
    return { frames, renderApp, factory, running }
  }

  it('shouldOpenTheScreenWithTheFirstStartupCardAndKeepOneRenderer', async () => {
    let release: () => void = () => undefined
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const { frames, renderApp, factory, running } = startupRun(async (screen) => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      screen.show(createElement(Text, {}, 'Harness selection inside the TUI'), 'Select a harness')
      await ready
      return false
    })
    try {
      await vi.waitFor(() => expect(frames.join('\n')).toContain('Harness selection inside the TUI'))

      expect(frames[0]).toContain('Harness selection inside the TUI')
      expect(frames[0]).toMatch(STRANDS_WORDMARK)
      expect(frames.join('\n')).not.toContain('/settings')
      expect(renderApp).toHaveBeenCalledOnce()
      expect(factory).not.toHaveBeenCalled()
    } finally {
      release()
      expect(await running).toBe(0)
    }
  })

  it('shouldShowTheStatusUnderTheWordmarkWhenTheFirstCardTakesLonger', async () => {
    let release: () => void = () => undefined
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const renderedAtShow: number[] = []
    const { frames, renderApp, running } = startupRun(async (screen) => {
      screen.show(undefined, 'Discovering local harnesses…')
      renderedAtShow.push(renderApp.mock.calls.length)
      await ready
      return false
    })
    try {
      await vi.waitFor(() => expect(frames.join('\n')).toContain('Discovering local harnesses…'))

      expect(renderedAtShow).toEqual([0])
      expect(frames[0]).toContain('Discovering local harnesses…')
      expect(frames[0]).toMatch(STRANDS_WORDMARK)
      expect(frames.join('\n')).not.toContain('/settings')
    } finally {
      release()
      expect(await running).toBe(0)
    }
  })

  it('shouldKeepThePickerOpenWhenCreationFailsThenAllowRetry', async () => {
    const input = ttyInput()
    const output = ttyOutput(120, 35)
    const frame = captureFrame(output)
    const open = vi
      .fn()
      .mockRejectedValueOnce(new Error('Model dependency could not be copied'))
      .mockResolvedValueOnce(workspace)
    let selected: DevWorkspace | undefined
    const running = runInkChat(
      async (): Promise<never> => {
        throw new Error('Unexpected agent startup')
      },
      {
        input,
        output,
        errorOutput: output,
        intro: false,
        config: CliConfigStore.memory({}, { animations: false }),
        renderApp: render as RenderApp,
        prepare: async (screen) => {
          selected = await chooseHarness({ cli: { name: 'Saved CLI' }, harnesses: [] }, screen, open)
          return false
        },
      }
    )
    try {
      await vi.waitFor(() => expect(frame().join('\n')).toContain('Select a harness'))
      input.write('\r')
      await vi.waitFor(() => expect(frame().join('\n')).toContain('Workspace could not open.'))
      expect(frame().join('\n')).toContain('Model dependency could not be copied')
      expect(frame().join('\n')).toContain('Next:')
      expect(frame().join('\n')).toContain('Base CLI')
      input.write('\r')
      expect(await running).toBe(0)
      expect(selected).toEqual(workspace)
      expect(open).toHaveBeenCalledTimes(2)
    } finally {
      input.write('\u0003')
      await running
    }
  })

  it('shouldKeepEveryOpenFailureLineReadableWithTheCopyHintOnAnEightyByTwentyFourScreen', async () => {
    const input = ttyInput()
    const output = ttyOutput(80, 24)
    const frame = captureFrame(output)
    const open = vi.fn().mockRejectedValue(new Error('Model dependency could not be copied'))
    const running = runInkChat(
      async (): Promise<never> => {
        throw new Error('Unexpected agent startup')
      },
      {
        input,
        output,
        errorOutput: output,
        intro: false,
        config: CliConfigStore.memory({}, { animations: false }),
        renderApp: render as RenderApp,
        prepare: async (screen) => {
          await chooseHarness({ cli: { name: 'Saved CLI' }, harnesses: [] }, screen, open)
          return false
        },
      }
    )
    try {
      await vi.waitFor(() => expect(frame().join('\n')).toContain('Select a harness'))
      input.write('\r')
      await vi.waitFor(() => expect(frame().join('\n')).toContain('Ctrl+Y copy error'))

      const text = frame()
        .map((line) => line.replace(/[│╭╮╰╯─]/gu, '').trim())
        .join(' ')
        .replace(/\s+/gu, ' ')
      expect(text).toContain('Workspace could not open.')
      expect(text).toContain('Reason: Model dependency could not be copied')
      expect(text).toContain('Next: Fix the reported source or configuration, then retry this workspace.')
    } finally {
      input.write('\u0003')
      await running
    }
  })

  it('shouldCancelPreparationWithoutStartingAnAgentWhenControlCIsPressed', async () => {
    const input = ttyInput()
    const output = ttyOutput(120, 35)
    const frame = captureFrame(output)
    const factory = vi.fn(async (): Promise<never> => {
      throw new Error('Unexpected agent startup')
    })
    let signal: AbortSignal | undefined
    const running = runInkChat(factory, {
      input,
      output,
      errorOutput: output,
      intro: false,
      config: CliConfigStore.memory({}, { animations: false }),
      renderApp: render as RenderApp,
      prepare: async (screen) => {
        signal = screen.signal
        await chooseHarness({ cli: { name: 'Saved CLI' }, harnesses: [] }, screen, vi.fn())
        return false
      },
    })
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Select a harness'))
    input.write('\u0003')

    expect(await running).toBe(130)
    expect(signal?.aborted).toBe(true)
    expect(factory).not.toHaveBeenCalled()
  })
})
