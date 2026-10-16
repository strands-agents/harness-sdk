import { createElement } from 'react'
import { render } from 'ink'
import { describe, expect, it, vi } from 'vitest'

import {
  agentGridLayout,
  clampAgentGridViewport,
  moveAgentGridSelection,
  revealAgentGridSelection,
  scrollAgentGridViewport,
} from '../src/tui/view/agent-grid.js'
import {
  COMPOSER_RESOURCE_PANEL_HEIGHT,
  composerPanelHeight,
  cycleModelPanelFocus,
  cycleMultiColumnPanelSelection,
  filterPanelRows,
  isComposerPanel,
  moveMultiColumnPanelSelection,
  moveSelection,
  mouseScrollDirection,
  panelRowCapacity,
  permissionPanelLayout,
  revealPanelSelection,
  sectionedPanelSidebarWidth,
  scrollDetail,
  scrollPanelViewport,
  scrollTranscript,
  settingArrowValue,
  shouldToggleVoiceMute,
} from '../src/tui/view/interaction.js'
import { planTranscriptLayout, transcriptWindow } from '../src/tui/view/transcript-layout.js'
import type { ChatPanel } from '../src/tui/chat/types.js'
import { summarizeToolInput, toolAction } from '../src/tui/view/presentation.js'
import { parseMouseInput, selectScreenText } from '../src/tui/terminal/mouse-input.js'
import { settingsCategoryFilters, settingsRows } from '../src/tui/chat/panels.js'
import { DEFAULT_CHAT_SETTINGS, type SettingsCategory } from '../src/tui/settings.js'
import { snapshot } from './fixtures/chat-snapshot.js'
import { ChatApp } from '../src/tui/view/app.js'
import { ChatController } from '../src/tui/chat/controller.js'
import { idleBackend } from './fixtures/chat-backend.js'
import { captureFrame, ttyInput, ttyOutput } from './fixtures/terminal.js'

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
        clients: [],
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

describe('panel helpers', () => {
  const rows = [
    { label: 'Model A', description: 'Provider A', filter: 'bedrock' },
    { label: 'Model B', description: 'Provider B', filter: 'current' },
  ]

  it('tabs between /model sections and leaves search for the model list', () => {
    const panel = {
      id: 'models',
      kind: 'models' as const,
      title: 'models',
      rows: [],
      filters: [{ id: 'all', label: 'All' }],
    }
    expect(cycleModelPanelFocus('providers', panel, 1)).toBe('models')
    expect(cycleModelPanelFocus('models', panel, 1)).toBe('providers')
    expect(cycleModelPanelFocus('search', panel, 1)).toBe('providers')
    expect(cycleModelPanelFocus('providers', panel, -1)).toBe('models')

    const bare = { id: 'models', kind: 'models' as const, title: 'models', rows: [] }
    expect(cycleModelPanelFocus('models', bare, 1)).toBe('models')
  })

  it('tabs between every Voice column and every Export choice', () => {
    const voiceRows = [
      { label: 'Voice', description: '', value: 'voice:enabled' },
      { label: 'provider', description: '', value: 'voice:provider', section: 'Voice' },
      { label: 'Nova 2.5 Sonic', description: '', value: 'voice:model', section: 'Model' },
      { label: 'English (US)', description: '', value: 'voice:voice', section: 'Voice' },
      { label: 'French', description: '', value: 'voice:voice', section: 'Voice' },
      { label: 'end of turn', description: '', value: 'voice:endpointing' },
    ]
    expect(cycleMultiColumnPanelSelection('voice', voiceRows, 0, 1)).toBe(1)
    expect(cycleMultiColumnPanelSelection('voice', voiceRows, 1, 1)).toBe(0)
    expect(cycleMultiColumnPanelSelection('voice', voiceRows, 5, -1)).toBe(2)
    expect(moveMultiColumnPanelSelection('voice', voiceRows, 5, { upArrow: true }, 2)).toBe(0)
    expect(moveMultiColumnPanelSelection('voice', voiceRows, 0, { downArrow: true }, 2)).toBe(5)

    const exportRows = [
      { label: 'Python', description: '', value: 'export:python' },
      { label: 'TypeScript', description: '', value: 'export:typescript' },
    ]
    expect(cycleMultiColumnPanelSelection('export', exportRows, 0, 1)).toBe(1)
    expect(cycleMultiColumnPanelSelection('export', exportRows, 0, -1)).toBe(1)
    expect(cycleMultiColumnPanelSelection('models', exportRows, 0, 1)).toBeUndefined()
  })

  it('uses the shared resource height with more room for voice controls', () => {
    const panel = (kind: ChatPanel['kind']) =>
      ({
        id: kind,
        kind,
        title: kind,
        rows: [],
        request: { id: 'request', toolName: 'shell', input: {}, options: [] },
      }) as ChatPanel
    const settingsPanel = (category: SettingsCategory) => ({
      id: `settings-${category}`,
      kind: 'settings' as const,
      title: category,
      rows: settingsRows(DEFAULT_CHAT_SETTINGS, category),
      filters: settingsCategoryFilters(),
      settingsCategory: category,
    })

    const effortPanel = {
      id: 'effort',
      kind: 'effort' as const,
      title: 'effort',
      rows: [],
      slider: { label: 'Effort', options: [{ id: 'medium', label: 'Medium', active: true }] },
    }
    const kinds = [
      'models',
      'context',
      'sessions',
      'export',
      'tools',
      'mcp',
      'skills',
      'tasks',
      'detail',
      'help-detail',
      'permissions',
    ] as const
    for (const composer of [settingsPanel('Appearance'), effortPanel, ...kinds.map(panel)]) {
      expect(isComposerPanel(composer.kind)).toBe(true)
      expect(composerPanelHeight(snapshot({ panel: composer }), 24)).toBe(COMPOSER_RESOURCE_PANEL_HEIGHT)
    }
    expect(composerPanelHeight(snapshot({ panel: panel('detail') }), 7)).toBe(5)
    expect(composerPanelHeight(snapshot({ panel: panel('voice') }), 24)).toBe(16)
    expect(composerPanelHeight(snapshot({ panel: panel('voice') }), 14)).toBe(12)
    expect(composerPanelHeight(snapshot({ panel: panel('permission') }), 24)).toBe(16)
    expect(composerPanelHeight(snapshot({ panel: panel('permission') }), 14)).toBe(12)
    expect(isComposerPanel('config')).toBe(false)
  })

  it('uses one-third of sectioned panels for their sidebar', () => {
    expect(sectionedPanelSidebarWidth(150)).toBe(50)
    expect(sectionedPanelSidebarWidth(80)).toBe(26)
    expect(sectionedPanelSidebarWidth(150, 20)).toBe(20)
  })

  it('maps ←→ on a settings row to its neighboring option, and to Off and On for a toggle', () => {
    const [theme, , animations, , toolOutput] = settingsRows(DEFAULT_CHAT_SETTINGS, 'Appearance')
    const [contextOffloadThreshold] = settingsRows(DEFAULT_CHAT_SETTINGS, 'Agent')

    expect(settingArrowValue(theme!, -1)).toBeUndefined()
    expect(settingArrowValue(theme!, 1)).toBe('frogTheme=minimal')
    expect(settingArrowValue(toolOutput!, -1)).toBe('toolOutput=hidden')
    expect(settingArrowValue(toolOutput!, 1)).toBe('toolOutput=full')
    expect(settingArrowValue(animations!, 1)).toBeUndefined()
    expect(settingArrowValue(animations!, -1)).toBe('animations')
    expect(settingArrowValue(contextOffloadThreshold!, -1)).toBeUndefined()
    expect(settingArrowValue(contextOffloadThreshold!, 1)).toBe('contextOffloadThreshold=1500')
    expect(settingArrowValue({ label: 'note', description: '' }, 1)).toBeUndefined()
  })

  it('labels tools by normalized name and falls back to the raw name', () => {
    expect(toolAction('Strands-Config')).toBe('Strands Config')
    expect(toolAction('custom_tool')).toBe('custom_tool')
  })

  it('shows strands_config operations and concise input details', () => {
    expect(summarizeToolInput('strands_config', { action: 'inspect' })).toBe('inspect')
    expect(summarizeToolInput('strands_config', { action: 'models', provider: 'bedrock', query: 'opus' })).toBe(
      'models: bedrock · opus'
    )
    expect(
      summarizeToolInput('strands_config', {
        action: 'update',
        profile: { model: 'bedrock/global.anthropic.claude-opus-4-6-v1:0' },
      })
    ).toBe('update model: Claude Opus 4.6')
    expect(
      summarizeToolInput('strands_config', {
        action: 'update',
        profile: { effort: 'high' },
        settings: { animations: false },
      })
    ).toBe('update: effort, settings.animations')
    expect(summarizeToolInput('strands_config', { action: 'apply', revision: 2 })).toBe('apply')
  })

  it('presents the SDK Background Tasks management tool', () => {
    expect(toolAction('strands_manage_background_task')).toBe('Background')
    expect(summarizeToolInput('strands_manage_background_task', { mode: 'cancel', taskId: 'task-1' })).toBe(
      'cancel · task-1'
    )
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
    expect(panelRowCapacity('models', 10)).toBe(5)
    expect(panelRowCapacity('models', 12)).toBe(7)
    expect(panelRowCapacity('sessions', 20)).toBe(13)
    expect(panelRowCapacity('settings', 10)).toBe(5)
    expect(panelRowCapacity('permission', 12)).toBe(7)
    expect(permissionPanelLayout(98, 12, 3)).toMatchObject({
      wide: true,
      bodyHeight: 7,
      optionGrid: true,
      previewWidth: 58,
      optionsWidth: 40,
      previewHeight: 7,
      descriptionHeight: 1,
      optionCapacity: 4,
    })
    expect(permissionPanelLayout(38, 12, 4)).toMatchObject({
      wide: false,
      bodyHeight: 7,
      optionGrid: true,
      previewHeight: 3,
      optionCapacity: 2,
    })
    expect(scrollPanelViewport(0, 1, 20, 5)).toBe(1)
    expect(scrollPanelViewport(15, 1, 20, 5)).toBe(15)
    expect(scrollPanelViewport(8, -1, 20, 5, 3)).toBe(5)
    expect(revealPanelSelection(3, 8, 5, 20)).toBe(3)
    expect(revealPanelSelection(14, 8, 5, 20)).toBe(10)
    expect(revealPanelSelection(10, 8, 5, 20)).toBe(8)
  })

  it.each([
    [120, 40, 4, 8],
    [100, 30, 3, 3],
    [40, 16, 1, 1],
    [22, 10, 1, 1],
  ])('fits agent cards to a %i×%i full screen', (width, height, columns, capacity) => {
    const layout = agentGridLayout(width, height)
    expect(isComposerPanel('agents')).toBe(false)
    expect(layout).toMatchObject({ columns, capacity })
    expect(layout.cardWidth * layout.columns + 2 * (layout.columns - 1)).toBeLessThanOrEqual(width - 2)
    expect(layout.cardHeight).toBeLessThanOrEqual(layout.gridHeight)
    expect(layout.gridHeight).toBeLessThan(height)
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
