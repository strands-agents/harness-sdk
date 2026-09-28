import { describe, expect, it } from 'vitest'

import {
  agentGridCapacity,
  agentGridColumns,
  filterPanelRows,
  moveAgentGridSelection,
  moveSelection,
  mouseScrollDirection,
  panelRowCapacity,
  revealPanelSelection,
  revealAgentGridSelection,
  scrollDetail,
  scrollAgentGridViewport,
  scrollPanelViewport,
  scrollTranscript,
  shouldToggleVoiceMute,
} from '../src/tui/view/interaction.js'
import { planTranscriptLayout, transcriptWindow } from '../src/tui/view/transcript-layout.js'
import { summarizeToolInput, toolAction } from '../src/tui/view/presentation.js'
import { parseMouseInput, selectScreenText } from '../src/tui/terminal/mouse-input.js'

describe('voice input', () => {
  it('uses a single empty-editor Space tap for mute without consuming typed spaces', () => {
    expect(shouldToggleVoiceMute(' ', {}, '', 'listening')).toBe(true)
    expect(shouldToggleVoiceMute(' ', {}, '', 'muted')).toBe(true)
    expect(shouldToggleVoiceMute(' ', {}, 'hello', 'listening')).toBe(false)
    expect(shouldToggleVoiceMute(' ', { shift: true }, '', 'listening')).toBe(false)
    expect(shouldToggleVoiceMute(' ', {}, '', 'off')).toBe(false)
  })
})

describe('panel helpers', () => {
  const rows = [
    { label: 'Opus', description: 'Anthropic', filter: 'bedrock' },
    { label: 'GPT', description: 'OpenAI', filter: 'current' },
  ]

  it('presents the SDK Background Tasks management tool', () => {
    expect(toolAction('strands_manage_background_task')).toBe('Manage task')
    expect(summarizeToolInput('strands_manage_background_task', { mode: 'cancel', taskId: 'task-1' })).toBe(
      'cancel · task-1'
    )
  })

  it('filters rows and accepts custom IDs for supported providers', () => {
    expect(filterPanelRows(rows, 'open', 'all')).toEqual([rows[1]])
    expect(filterPanelRows(rows, '', 'bedrock')).toEqual([rows[0]])
    expect(filterPanelRows(rows, 'anthropic.claude-new', 'bedrock', true)).toEqual([
      {
        label: 'bedrock/anthropic.claude-new',
        description: 'Switch to this model ID',
        value: 'bedrock/anthropic.claude-new',
      },
    ])
    expect(filterPanelRows(rows, 'openai/gpt-new', 'bedrock', true)).toEqual([
      {
        label: 'openai/gpt-new',
        description: 'Switch to this model ID',
        value: 'openai/gpt-new',
      },
    ])
    expect(filterPanelRows(rows, 'unknown/gpt-new', 'bedrock', true)).toEqual([])
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
    expect(agentGridColumns(120)).toBe(3)
    expect(agentGridColumns(80)).toBe(2)
    expect(agentGridColumns(48)).toBe(1)
    expect(agentGridCapacity(100, 30)).toBe(6)
    expect(scrollAgentGridViewport(0, 1, 10, 6, 3)).toBe(3)
    expect(scrollAgentGridViewport(3, 1, 10, 6, 3)).toBe(6)
    expect(revealAgentGridSelection(8, 0, 6, 10, 3)).toBe(3)
    expect(panelRowCapacity('models', 20)).toBe(7)
    expect(panelRowCapacity('sessions', 20)).toBe(10)
    expect(panelRowCapacity('settings', 20)).toBe(5)
    expect(scrollPanelViewport(0, 1, 20, 5)).toBe(1)
    expect(scrollPanelViewport(15, 1, 20, 5)).toBe(15)
    expect(scrollPanelViewport(8, -1, 20, 5, 3)).toBe(5)
    expect(revealPanelSelection(3, 8, 5, 20)).toBe(3)
    expect(revealPanelSelection(14, 8, 5, 20)).toBe(10)
    expect(revealPanelSelection(10, 8, 5, 20)).toBe(8)
  })

  it('keeps keyboard navigation valid when a filtered panel shrinks', () => {
    expect(moveAgentGridSelection(0, { rightArrow: true }, 5, 3, 6)).toBe(1)
    expect(moveAgentGridSelection(1, { downArrow: true }, 5, 3, 6)).toBe(4)
    expect(moveAgentGridSelection(4, { leftArrow: true }, 5, 3, 6)).toBe(3)
    expect(moveAgentGridSelection(3, { upArrow: true }, 5, 3, 6)).toBe(0)
    expect(moveAgentGridSelection(2, { rightArrow: true }, 5, 3, 6)).toBe(2)
    expect(moveSelection(8, { upArrow: true }, 2, 5)).toBe(0)
    expect(moveSelection(8, { downArrow: true }, 2, 5)).toBe(1)
    expect(moveSelection(8, { pageUp: true }, 2, 5)).toBe(0)
    expect(moveSelection(8, { pageDown: true }, 2, 5)).toBe(1)
  })

  it('top-aligns short transcripts and bottom-anchors overflowed transcripts without exceeding the viewport', () => {
    expect(planTranscriptLayout([4, 6, 3], 2, 5, 8, 0)).toMatchObject({
      anchorBottom: true,
      scrollOffset: 0,
    })
    expect(planTranscriptLayout([4, 6, 3], 2, 5, 8, 5)).toMatchObject({ anchorBottom: true, scrollOffset: 5 })
    expect(planTranscriptLayout([4, 6, 3], 2, 5, 8, 99)).toMatchObject({ anchorBottom: true, scrollOffset: 12 })
    expect(planTranscriptLayout([1, 1], 0, 2, 8, 3)).toMatchObject({ anchorBottom: false, scrollOffset: 0 })
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
