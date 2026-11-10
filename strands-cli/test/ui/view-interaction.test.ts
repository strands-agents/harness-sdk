import { createElement } from 'react'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  clampAgentGridViewport,
  moveAgentGridSelection,
  revealAgentGridSelection,
  scrollAgentGridViewport,
} from '../../src/ui/panels/agents.js'
import {
  filterPanelRows,
  moveSelection,
  mouseScrollDirection,
  revealPanelSelection,
  scrollDetail,
  scrollPanelViewport,
  scrollTranscript,
  shouldToggleVoiceMute,
} from '../../src/ui/interaction.js'
import { planTranscriptLayout, transcriptWindow } from '../../src/ui/chat/transcript.js'
import { summarizeToolInput } from '../../src/ui/presentation.js'
import { parseMouseInput, selectScreenText } from '../../src/terminal/mouse-input.js'
import { ChatApp } from '../../src/ui/chat/screen.js'
import { ChatController } from '../../src/ui/chat/controller.js'
import { idleBackend } from '../fixtures/chat-backend.js'
import { render, captureFrame, ttyInput, ttyOutput } from '../fixtures/terminal.js'
import * as terminal from '../../src/terminal/terminal.js'

afterEach(() => vi.restoreAllMocks())

describe('voice input', () => {
  it('uses a single empty-editor Space tap for mute without consuming typed spaces', () => {
    expect(shouldToggleVoiceMute(' ', {}, '', 'listening')).toBe(true)
    expect(shouldToggleVoiceMute(' ', {}, '', 'muted')).toBe(true)
    expect(shouldToggleVoiceMute(' ', {}, 'hello', 'listening')).toBe(false)
    expect(shouldToggleVoiceMute(' ', { shift: true }, '', 'listening')).toBe(false)
    expect(shouldToggleVoiceMute(' ', {}, '', 'off')).toBe(false)
  })
})

describe('MCP panel input', () => {
  it('keeps uppercase R searchable and retries the selected server only after leaving search', async () => {
    const input = ttyInput()
    const output = ttyOutput(100, 24)
    const frame = captureFrame(output)
    const setEnabled = vi.fn(async () => 'ECONNREFUSED')
    const controller = new ChatController(idleBackend(), {
      settings: { animations: false },
      mcp: {
        paths: [],
        warnings: [],
        list: async () =>
          ['Docs', 'Research/docs'].map((name) => ({
            name,
            transport: 'streamable-http' as const,
            target: 'https://example.test/mcp',
            state: 'failed' as const,
            error: 'ECONNREFUSED',
          })),
        setEnabled,
        dispose: async () => undefined,
      },
    })
    const instance = render(createElement(ChatApp, { controller }), {
      stdin: input,
      stdout: output,
      stderr: ttyOutput(100, 24),
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    })
    try {
      await controller.submit('/mcp')
      await vi.waitFor(() => expect(frame().join('\n')).toContain('R retry'))
      input.write('/')
      await instance.waitUntilRenderFlush()
      input.write('R')
      await vi.waitFor(() => expect(frame().some((line) => line.includes('/ R'))).toBe(true))
      expect(setEnabled).not.toHaveBeenCalled()
      input.write('esearch')
      await vi.waitFor(() => expect(frame().some((line) => line.includes('/ Research'))).toBe(true))
      expect(frame().join('\n')).toContain('Research/docs')
      expect(frame().join('\n')).not.toContain('› Docs')

      input.write('\u001b[B')
      await instance.waitUntilRenderFlush()
      input.write('R')
      await vi.waitFor(() => expect(setEnabled).toHaveBeenCalledExactlyOnceWith('Research/docs', true))
      await vi.waitFor(() => expect(controller.getSnapshot().composerStatus).toBeUndefined())
      input.write('\u001b[C')
      await vi.waitFor(() => expect(controller.getSnapshot().panel?.title).toBe('MCP: Research/docs'))
      input.write('\u001b')
      await vi.waitFor(() => expect(controller.getSnapshot().panel?.kind).toBe('mcp'))
      await instance.waitUntilRenderFlush()
      input.write('\r')
      await vi.waitFor(() => expect(setEnabled).toHaveBeenLastCalledWith('Research/docs', false))
    } finally {
      instance.unmount()
      await controller.dispose()
    }
  })
})

describe('error panel input', () => {
  it('shouldCopyTheWholeErrorWhenControlYIsPressedInAScrollingErrorPanel', async () => {
    const copy = vi.spyOn(terminal, 'copyTerminalText').mockResolvedValue(true)
    const input = ttyInput()
    const output = ttyOutput(100, 24)
    const frame = captureFrame(output)
    const controller = new ChatController(idleBackend(), { settings: { animations: false } })
    const message = Array.from({ length: 30 }, (_, index) => `Trace ${index}: agent.ts failed`).join('\n')
    const instance = render(createElement(ChatApp, { controller }), {
      stdin: input,
      stdout: output,
      stderr: ttyOutput(100, 24),
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    })
    try {
      await vi.waitFor(() => expect(frame().join('\n')).toContain('/settings'))
      controller.showError('Agent reload failed', message)
      await vi.waitFor(() => expect(frame().join('\n')).toContain('Ctrl+Y copy error · Esc close'))
      expect(frame().join('\n')).not.toContain('Trace 29')

      input.write('\u0019')

      await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce())
      expect(copy.mock.calls[0]![0]).toBe(`Agent reload failed\n${message}`)
      expect(controller.getSnapshot().panel?.kind).toBe('error')
      await vi.waitFor(() => expect(frame().join('\n')).toContain('chars copied to clipboard'))
    } finally {
      instance.unmount()
      await controller.dispose()
    }
  })
})

describe('panel helpers', () => {
  const rows = [
    { label: 'Model A', description: 'Provider A', filter: 'bedrock' },
    { label: 'Model B', description: 'Provider B', filter: 'current' },
  ]

  it('truncates tool summaries without splitting graphemes or changing the input', () => {
    const input = { command: `${'a'.repeat(158)}😀x` }
    expect(summarizeToolInput('shell', input)).toBe(`${'a'.repeat(158)}…`)
    expect(input.command).toBe(`${'a'.repeat(158)}😀x`)
    expect(summarizeToolInput('custom', `${'a'.repeat(155)}😀xxx`)).toBe(`"${'a'.repeat(155)}😀x…`)
    expect(summarizeToolInput('shell', { command: 'e\u0301'.repeat(161) })).toBe(`${'e\u0301'.repeat(159)}…`)
  })

  it('filters rows and accepts custom IDs for supported providers', () => {
    expect(filterPanelRows(rows, 'model b', 'all')).toEqual([rows[1]])
    expect(filterPanelRows(rows, '', 'bedrock')).toEqual([rows[0]])
    const failedTask = { label: 'Deploy', description: '', badge: { text: 'failed', tone: 'danger' as const } }
    expect(filterPanelRows([failedTask], 'failed', 'all')).toEqual([failedTask])
    const session = {
      label: 'Planning',
      description: '',
      columns: ['strands-cli', '7', '2026-10-07 10:30'],
      filter: 'directory:strands-cli',
    }
    expect(filterPanelRows([session], 'strands-cli', 'all')).toEqual([session])
    expect(filterPanelRows([session], '', 'directory:strands-cli')).toEqual([session])
    expect(filterPanelRows(rows, 'vendor.test-model', 'bedrock', true)).toEqual([
      {
        label: 'bedrock/vendor.test-model',
        description: 'Switch to this model ID',
        value: 'bedrock/vendor.test-model',
      },
    ])
    expect(filterPanelRows(rows, 'openai/test-model', 'bedrock', true)).toEqual([
      {
        label: 'openai/test-model',
        description: 'Switch to this model ID',
        value: 'openai/test-model',
      },
    ])
    expect(filterPanelRows(rows, 'unknown/test-model', 'bedrock', true)).toEqual([])
  })

  it('parses mouse wheel input', () => {
    const up = parseMouseInput('\u001b[<64;20;12M')
    const down = parseMouseInput('[<65;20;12M')

    expect(parseMouseInput('[<0;12;30M')?.action).toBe('press')
    expect(parseMouseInput('[<32;12;30M')?.action).toBe('move')
    expect(parseMouseInput('[<32;12;30m')?.action).toBe('release')
    expect(up).toMatchObject({ button: 64, action: 'press' })
    expect(down).toMatchObject({ button: 65, action: 'press' })
    expect(mouseScrollDirection(up!)).toBe(-1)
    expect(mouseScrollDirection(down!)).toBe(1)
    expect(mouseScrollDirection(parseMouseInput('[<0;20;12M')!)).toBeUndefined()
    expect(mouseScrollDirection(parseMouseInput('[<69;20;12M')!)).toBe(1)
    expect(mouseScrollDirection(parseMouseInput('[<65;20;12m')!)).toBeUndefined()
  })

  it('selects screen text across wrapped rows and wide characters', () => {
    expect(selectScreenText(['one two', '🙂 three'], { column: 5, row: 1 }, { column: 2, row: 2 })).toEqual({
      segments: [
        { column: 4, row: 0, text: 'two' },
        { column: 0, row: 1, text: '🙂' },
      ],
      text: 'two\n🙂',
    })
  })

  it('scrolls panel viewports independently and reveals keyboard selection', () => {
    expect(scrollPanelViewport(0, 1, 20, 5)).toBe(1)
    expect(scrollPanelViewport(15, 1, 20, 5)).toBe(15)
    expect(scrollPanelViewport(8, -1, 20, 5, 3)).toBe(5)
    expect(revealPanelSelection(3, 8, 5, 20)).toBe(3)
    expect(revealPanelSelection(14, 8, 5, 20)).toBe(10)
    expect(revealPanelSelection(10, 8, 5, 20)).toBe(8)
  })

  it('scrolls agent cards by grid rows and clamps after the roster shrinks', () => {
    expect(scrollAgentGridViewport(0, 1, 10, 6, 3)).toBe(3)
    expect(scrollAgentGridViewport(3, 1, 10, 6, 3)).toBe(6)
    expect(scrollAgentGridViewport(6, 1, 10, 6, 3)).toBe(6)
    expect(revealAgentGridSelection(8, 0, 6, 10, 3)).toBe(3)
    expect(clampAgentGridViewport(4, 10, 6, 3)).toBe(3)
    expect(clampAgentGridViewport(6, 2, 6, 3)).toBe(0)
    expect(revealAgentGridSelection(8, 6, 6, 2, 3)).toBe(0)
  })

  it('moves between agent cards without wrapping across grid edges', () => {
    expect(moveAgentGridSelection(0, { rightArrow: true }, 5, 3, 6)).toBe(1)
    expect(moveAgentGridSelection(1, { downArrow: true }, 5, 3, 6)).toBe(4)
    expect(moveAgentGridSelection(4, { leftArrow: true }, 5, 3, 6)).toBe(3)
    expect(moveAgentGridSelection(3, { upArrow: true }, 5, 3, 6)).toBe(0)
    expect(moveAgentGridSelection(2, { rightArrow: true }, 5, 3, 6)).toBe(2)
    expect(moveAgentGridSelection(1, { upArrow: true }, 5, 3, 6)).toBe(1)
    expect(moveAgentGridSelection(3, { downArrow: true }, 5, 3, 6)).toBe(3)
    expect(moveAgentGridSelection(0, { home: true }, 5, 3, 6)).toBe(0)
    expect(moveAgentGridSelection(0, { end: true }, 5, 3, 6)).toBe(4)
  })

  it('keeps keyboard navigation valid when a filtered panel shrinks', () => {
    expect(moveSelection(1, { downArrow: true }, 5, 3)).toBe(2)
    expect(moveSelection(3, { upArrow: true }, 5, 3)).toBe(2)
    expect(moveSelection(8, { upArrow: true }, 2, 5)).toBe(0)
    expect(moveSelection(8, { downArrow: true }, 2, 5)).toBe(1)
    expect(moveSelection(8, { pageUp: true }, 2, 5)).toBe(0)
    expect(moveSelection(8, { pageDown: true }, 2, 5)).toBe(1)
  })

  it('clamps the scroll offset to the measured overflow', () => {
    expect(planTranscriptLayout([4, 6, 3], 2, 5, 8, 0)).toMatchObject({ scrollOffset: 0 })
    expect(planTranscriptLayout([4, 6, 3], 2, 5, 8, 5)).toMatchObject({ scrollOffset: 5 })
    expect(planTranscriptLayout([4, 6, 3], 2, 5, 8, 99)).toMatchObject({ scrollOffset: 12 })
    expect(planTranscriptLayout([1, 1], 0, 2, 8, 3)).toMatchObject({ scrollOffset: 0 })
  })

  it('mounts every turn until the viewport is measured and always mounts unmeasured turns', () => {
    expect(planTranscriptLayout([4, undefined, 3], 0, 0, 0, 0).window).toEqual({
      start: 0,
      end: 3,
      before: 0,
      after: 0,
    })
    expect(planTranscriptLayout([4, 6, 3, 5], 0, 0, 6, 0).window).toEqual({ start: 2, end: 4, before: 10, after: 0 })
    expect(planTranscriptLayout([4, undefined, 3, 5], 0, 0, 6, 0).window).toEqual({
      start: 1,
      end: 4,
      before: 4,
      after: 0,
    })
  })

  it('scrolls the transcript without exceeding the viewport', () => {
    expect(scrollTranscript(0, -1, 12)).toBe(3)
    expect(scrollTranscript(3, 1, 12)).toBe(0)
    expect(scrollTranscript(10, -1, 12)).toBe(12)
    expect(scrollTranscript(2, 1, 12, 8)).toBe(0)
    expect(scrollDetail(0, -1, 12, true)).toBe(3)
    expect(scrollDetail(0, 1, 12, false)).toBe(3)
    expect(scrollDetail(3, -1, 12, false)).toBe(0)
  })

  it('windows measured transcript turns without changing their total height', () => {
    expect(transcriptWindow([4, 6, 3], -2, 2)).toEqual({
      start: 0,
      end: 1,
      before: 0,
      after: 9,
    })
    expect(transcriptWindow([4, 6, 3], 5, 11)).toEqual({
      start: 1,
      end: 3,
      before: 4,
      after: 0,
    })
    expect(transcriptWindow([4, 6, 3], 13, 20)).toEqual({
      start: 3,
      end: 3,
      before: 13,
      after: 0,
    })
  })
})
