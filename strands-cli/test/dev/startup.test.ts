import { createElement } from 'react'
import { Text } from 'ink'
import { describe, expect, it, vi } from 'vitest'
import { runInkChat } from '../../src/ui/run.js'
import { captureFrame, render, ttyInput, ttyOutput } from '../fixtures/terminal.js'
import { CliConfigStore } from '../../src/config/store.js'
import { chooseHarness } from '../../src/dev/picker.js'
import type { DevWorkspace } from '../../src/dev/workspace.js'

type RenderApp = NonNullable<NonNullable<Parameters<typeof runInkChat>[1]>['renderApp']>

const workspace: DevWorkspace = {
  root: '/workspace',
  entrypoint: '/workspace/agent.ts',
  config: { version: 1, name: 'local', language: 'typescript', entrypoint: 'agent.ts', origin: { kind: 'created' } },
}

describe('dev startup screen', () => {
  it('shouldOpenTheFullScreenBeforeWorkspacePreparationAndKeepOneRenderer', async () => {
    const input = ttyInput()
    const output = ttyOutput(120, 35)
    const frames = captureFrame(output)
    const events: string[] = []
    output.on('data', (data: Buffer) => {
      if (data.toString().includes('\u001b[?1049h')) events.push('screen')
    })
    const renderApp = vi.fn(render as RenderApp)
    const factory = vi.fn(async (): Promise<never> => {
      throw new Error('Unexpected agent startup')
    })
    let release: () => void = () => undefined
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const running = runInkChat(factory, {
      input,
      output,
      errorOutput: output,
      config: CliConfigStore.memory({}, { animations: false }),
      intro: false,
      renderApp,
      prepare: async (screen) => {
        events.push('prepare')
        screen.show(createElement(Text, {}, 'Harness selection inside the TUI'), 'Select a harness')
        await ready
        return false
      },
    })
    try {
      await vi.waitFor(() => expect(frames().join('\n')).toContain('Harness selection inside the TUI'))
      expect(events.indexOf('screen')).toBeLessThan(events.indexOf('prepare'))
      expect(renderApp).toHaveBeenCalledOnce()
      expect(frames().join('\n')).toContain('/settings')
      expect(factory).not.toHaveBeenCalled()
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
