import chalk from 'chalk'
import { createElement, type ReactElement } from 'react'
import { render, renderToString } from 'ink'
import stringWidth from 'string-width'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { snapshot } from './fixtures/chat-snapshot.js'
import { ttyOutput } from './fixtures/terminal.js'

import { ChatView } from '../src/tui/view/chat-view.js'
import { Markdown } from '../src/tui/view/markdown.js'
import {
  composerPanelHeight,
  configurationDockWidth,
  CONFIG_DOCK_GAP,
  panelControlTarget,
  panelRowCapacity,
  permissionPanelLayout,
  revealPanelSelection,
} from '../src/tui/view/interaction.js'
import {
  formatContext,
  maxDetailScroll,
  maxPermissionScroll,
  PERMISSION_LABEL_WIDTH,
  permissionLines,
} from '../src/tui/view/presentation.js'
import {
  DEFAULT_CHAT_SETTINGS,
  type ChatDetailPanel,
  type ChatPanel,
  type ChatSnapshot,
  type ChatTurn,
} from '../src/tui/chat/controller.js'
import { formatPermissionPanelBody, mcpRows, settingsCategoryFilters, settingsRows } from '../src/tui/chat/panels.js'
import { SETTINGS_CATEGORIES, type SettingsCategory } from '../src/tui/settings.js'
import { sanitizeTerminalText } from '../src/tui/terminal/sanitize.js'
import { selectScreenText } from '../src/tui/terminal/mouse-input.js'
import { configurationRows } from '../src/tui/view/configuration-view.js'
import { createDiffPreview } from '../src/tui/permissions/file-change-preview.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('ChatView', () => {
  const configurationTool = { name: 'strands_config', description: 'Update agent configuration' }
  const liveConfiguration = {
    preferredLanguage: 'typescript' as const,
    documents: {
      typescript: {
        source:
          "import { createHarness } from '@strands-agents/harness'\n\nexport const agent = await createHarness({\n  name: 'Live frog',\n})\n",
        generated: true,
      },
      python: {
        source: 'from strands_harness import create_harness\n\nagent = create_harness(\n    name="Live frog",\n)\n',
        generated: true,
      },
    },
  }

  it('renders /config in the shared, switchable right-side dock', () => {
    const configuration = {
      ...liveConfiguration,
      documents: {
        ...liveConfiguration.documents,
        typescript: {
          ...liveConfiguration.documents.typescript,
          generated: false,
          path: '/work/agent/agent.ts',
        },
      },
      project: { root: '/work/agent', entrypoint: '/work/agent/agent.ts' },
    }
    const panel: ChatPanel = {
      id: 'config',
      kind: 'config',
      title: 'Configuration',
      rows: [],
      filters: [
        { id: 'typescript', label: 'TypeScript' },
        { id: 'python', label: 'Python' },
      ],
      configuration,
      language: 'typescript',
    }
    const render = (panelFilter: string, terminalWidth = 100, canConfigure = true): string =>
      renderView(
        {
          snapshot: snapshot({
            panel,
            configuration,
            runtime: { ...snapshot().runtime, tools: canConfigure ? [configurationTool] : [] },
          }),
          panelFilter,
          terminalWidth,
          terminalHeight: 24,
        },
        { columns: terminalWidth }
      )
    const tabRow = (frame: string): string | undefined =>
      sanitizeTerminalText(frame)
        .split('\n')
        .find((line) => line.includes('TypeScript'))

    const typescript = render('typescript')
    const python = render('python')
    expect(typescript).toContain('await')
    expect(typescript).toContain('createHarness')
    expect(python).toContain('create_harness')
    expect(typescript).toContain('TypeScript')
    expect(typescript).toContain('Python')
    expect(typescript).toContain('Open')
    // The arrow-key note shrinks to fit beside the tabs rather than truncating.
    expect(tabRow(typescript)).toMatch(/Python {2}←→ +Open/u)
    expect(tabRow(render('typescript', 140))).toMatch(/Python {2}←→ switch +.*Open/u)
    expect(typescript).toContain('E open')
    expect(typescript).toContain('Viewing Configuration')
    expect(typescript).not.toContain('Source ·')
    expect(python).not.toContain('Preview ·')
    expect(python).not.toContain('Ask your agent')
    expect(render('typescript', 100, false)).not.toContain('Source ·')
    expect(typescript.split('\n').length).toBeLessThanOrEqual(24)
  })

  it('wraps configuration source rows instead of clipping long values', () => {
    const value = `const instructions = '${'long-value-'.repeat(10)}'`
    const rows = configurationRows(value, 24)

    expect(rows.length).toBeGreaterThan(1)
    expect(rows.map((row) => row.text).join('')).toBe(value)
  })

  it('docks the live configuration while strands_config is active on a wide terminal', () => {
    const prompt = 'Update the config and reflow the transcript into the space left of the dock, then BESIDE_THE_DOCK'
    const activeTurn = {
      id: 'turn-1',
      prompt,
      agentName: 'Strands harness',
      entries: [
        {
          id: 'turn-1:1',
          type: 'tool' as const,
          toolUseId: 'config-1',
          name: 'strands_config',
          input: { action: 'models' as const, query: 'opus' },
          status: 'running' as const,
        },
      ],
      status: 'running' as const,
    }
    const wide = renderView({
      snapshot: snapshot({
        activeTurn,
        configuration: liveConfiguration,
        status: 'running',
        runtime: { ...snapshot().runtime, tools: [configurationTool] },
      }),
      terminalWidth: 120,
      terminalHeight: 30,
    })
    const narrow = renderView({
      snapshot: snapshot({ activeTurn, configuration: liveConfiguration, status: 'running' }),
      terminalWidth: 80,
      terminalHeight: 24,
    })
    const undocked = renderView({
      snapshot: snapshot({ activeTurn, status: 'running' }),
      terminalWidth: 120,
      terminalHeight: 30,
    })

    expect(wide).toContain('Strands Config models: opus')
    expect(wide).toContain('await createHarness')
    expect(undocked).toContain('BESIDE_THE_DOCK')
    expect(wide).toContain('BESIDE_THE_DOCK')
    const dockLeft = 120 - 1 - configurationDockWidth(120)
    for (const line of sanitizeTerminalText(wide).split('\n')) {
      const prompt = /reflow|BESIDE_THE_DOCK/u.exec(line)
      if (prompt) expect(stringWidth(line.slice(0, prompt.index + prompt[0].length))).toBeLessThan(dockLeft)
    }
    expect(wide).toContain('TypeScript')
    expect(wide).not.toContain('Preview ·')
    expect(wide).not.toContain('←→ switch')
    expect(narrow).not.toContain('TypeScript')
  })

  it('moves the empty-state lockup left when the configuration dock opens', () => {
    const panel: ChatPanel = {
      id: 'config',
      kind: 'config',
      title: 'Configuration',
      rows: [],
      filters: [
        { id: 'typescript', label: 'TypeScript' },
        { id: 'python', label: 'Python' },
      ],
      configuration: liveConfiguration,
      language: 'typescript',
    }
    const render = (open: boolean): string =>
      sanitizeTerminalText(
        renderView(
          {
            snapshot: snapshot({
              settings: { ...DEFAULT_CHAT_SETTINGS, animations: false },
              ...(open ? { panel, configuration: liveConfiguration } : {}),
            }),
            terminalWidth: 180,
            terminalHeight: 40,
            panelFilter: 'typescript',
          },
          { columns: 180 }
        )
      )
    const brandColumn = (output: string): number =>
      output
        .split('\n')
        .find((line) => line.includes('▀▄     ▄▄'))!
        .indexOf('▀▄     ▄▄')

    const centered = brandColumn(render(false))
    const shifted = brandColumn(render(true))
    expect(centered - shifted).toBe(Math.round((configurationDockWidth(180, true) + CONFIG_DOCK_GAP) / 2))
  })

  it('highlights the previous config line red and the replacement green', () => {
    const before = "createHarness({ name: 'Before' })"
    const after = "createHarness({ name: 'After' })"
    const configuration = {
      ...liveConfiguration,
      documents: {
        ...liveConfiguration.documents,
        typescript: { source: after, generated: true },
      },
    }
    const activeTurn = {
      id: 'turn-1',
      prompt: 'Update the config',
      agentName: 'Strands harness',
      entries: [
        {
          id: 'turn-1:1',
          type: 'tool' as const,
          toolUseId: 'config-1',
          name: 'strands_config',
          input: { action: 'update' as const },
          status: 'success' as const,
        },
      ],
      status: 'running' as const,
    }
    const level = chalk.level
    let output: string
    try {
      chalk.level = 3
      output = renderView({
        snapshot: snapshot({
          activeTurn,
          configuration,
          configurationDiffs: { typescript: createDiffPreview('typescript', before, after) },
          status: 'running',
        }),
        terminalWidth: 120,
        terminalHeight: 30,
      })
    } finally {
      chalk.level = level
    }

    // Removed and added rows keep the full file around them, tinted like an editor's inline diff.
    expect(output.split('\n').find((line) => line.includes('Before'))).toContain('\u001b[48;2;70;32;42m')
    expect(output.split('\n').find((line) => line.includes('After'))).toContain('\u001b[48;2;23;58;34m')
  })

  it('shows startup notices below the banner', () => {
    const output = renderView({
      snapshot: snapshot({ notices: [{ id: 'notice-1', status: 'delivered', text: 'Nothing to compact yet' }] }),
      terminalWidth: 80,
      terminalHeight: 24,
    })

    expect(output.indexOf('╚════╝')).toBeLessThan(output.indexOf('Nothing to compact yet'))
  })

  it.each([80, 120])(
    'shows the self-configuration hint only when the empty composer is clear at %i columns',
    (width) => {
      const hint = 'Ask your agent to change its instructions, tools, or model.'
      const initial = snapshot({
        runtime: { ...snapshot().runtime, tools: [configurationTool] },
      })
      const frames: string[] = []
      const render = (overrides: Partial<ChatSnapshot> = {}): string => {
        const frame = sanitizeTerminalText(
          renderView(
            { snapshot: { ...initial, ...overrides }, terminalWidth: width, terminalHeight: 24 },
            { columns: width }
          )
        )
        frames.push(frame)
        return frame
      }

      const empty = render()
      expect(empty).toContain(hint)
      expect(empty.indexOf(hint)).toBeLessThan(empty.indexOf('Enter to send'))

      const connecting = render({ mcpStartup: { total: 3, connected: 1, failed: 0, settled: false } })
      expect(connecting).toContain('MCP servers connecting')
      expect(connecting).not.toContain(hint)

      const warning = render({
        mcpStartup: { total: 3, connected: 0, failed: 3, settled: true },
        tasks: [{ id: 'task-1', label: 'read', status: 'working', source: 'background' }],
      })
      expect(warning).not.toContain(hint)
      const warningRows = warning.split('\n')
      const taskRow = warningRows.findIndex((line) => line.includes('Background task running (read)'))
      const mcpRow = warningRows.findIndex((line) => line.includes('3 MCP servers failed to connect'))
      expect(taskRow).toBeGreaterThanOrEqual(0)
      expect(mcpRow).toBe(taskRow + 1)
      expect(mcpRow).toBeLessThan(warningRows.findIndex((line) => line.includes('Enter to send')))
      expect(render()).toContain(hint)

      expect(
        render({
          completedTurns: [
            { id: 'turn-1', prompt: 'hello', agentName: 'Strands harness', entries: [], status: 'complete' },
          ],
        })
      ).not.toContain(hint)
      expect(render({ panel: settingsPanel('Appearance') })).not.toContain(hint)
      expect(render({ runtime: { ...initial.runtime, tools: [] } })).not.toContain(hint)

      for (const frame of frames) {
        const rows = frame.split('\n')
        expect(rows).toHaveLength(24)
        expect(rows.every((line) => stringWidth(line) <= width)).toBe(true)
      }
    }
  )

  it.each([
    [80, 40, undefined],
    [40, 24, undefined],
    [100, 30, 'allow-always'],
    [40, 24, 'deny-always'],
  ] as const)('keeps long approval input and choices reachable at %ix%i, stage=%s', (width, height, stage) => {
    const command = `BEGIN_INPUT_${'界👩‍💻x'.repeat(500)}\nEND_INPUT`
    const request = {
      id: 'request',
      toolName: 'shell',
      input: { command },
      options: [],
      action: command,
      scopes: [{ rule: `shell(${command})`, label: 'Exact command' }],
    }
    const panel: ChatPanel = {
      id: 'long-approval',
      kind: 'permission',
      title: 'Tool approval',
      body: formatPermissionPanelBody(request),
      request,
      ...(stage ? { stage } : {}),
      rows: [
        { label: stage ? 'Exact command' : 'Allow once', description: 'Run this call', value: 'allow' },
        { label: 'Always allow tool', description: 'Save this choice', value: 'always' },
        { label: stage ? '← Back' : 'Deny', description: 'Block this call', value: 'deny' },
      ],
    }
    expect(panel.body).toContain(JSON.stringify(command))
    const panelHeight = composerPanelHeight(snapshot({ panel }), height)
    const contentWidth = permissionPanelLayout(width - 2, panelHeight, panel.rows.length).previewTextWidth
    const lines = permissionLines(panel, contentWidth)
    expect(lines.every((line) => stringWidth(line.text) <= contentWidth - PERMISSION_LABEL_WIDTH)).toBe(true)
    expect(lines.map((line) => line.text).join('')).toContain(command.replace('\n', ''))
    const render = (detailScroll: number): string =>
      renderView({
        snapshot: snapshot({ panel }),
        terminalWidth: width,
        terminalHeight: height,
        detailScroll,
      })
    const first = render(0)
    const maximum = maxPermissionScroll(panel, height, width)
    const endOffset = lines
      .map((line) => line.text)
      .join('')
      .indexOf('END_INPUT')
    let traversed = 0
    const endLine = lines.findIndex((line) => {
      traversed += line.text.length
      return traversed > endOffset
    })
    const last = render(Math.min(endLine, maximum))
    const lastText = sanitizeTerminalText(last)
    expect(first).toContain('BEGIN_INPUT')
    expect(lastText).toContain('END_IN')
    expect(lastText).toContain('PUT')
    for (const output of [first, last]) {
      expect(output).toContain('Tool approval')
      expect(output).toContain(stage ? 'Exact command' : 'Allow once')
      expect(output).toContain(stage ? '← Back' : 'Deny')
      expect(output.split('\n').length).toBeLessThanOrEqual(height)
    }
  })

  it('summarizes file changes instead of showing a diff in the approval prompt', () => {
    const lines = permissionLines(
      {
        id: 'write-approval',
        kind: 'permission',
        title: 'Write approval',
        rows: [],
        request: {
          id: 'request',
          toolName: 'write',
          input: { path: 'example.ts', content: 'const ready = true' },
          options: [],
          action: 'example.ts',
          diff: { path: 'example.ts', lines: [{ kind: 'add', text: 'const ready = true', newLine: 1 }] },
        },
      },
      80
    )

    expect(lines.map(({ label, text }) => [label, text])).toEqual([
      ['Tool', 'write'],
      ['Action', 'example.ts'],
      ['Changes', '+1 -0 lines'],
    ])
  })

  it('keeps every multiline draft row visible while the composer grows', () => {
    const input = ['alpha draft row', 'bravo draft row', 'charlie draft row', 'delta draft row'].join('\n')
    const output = renderView({
      snapshot: snapshot(),
      input,
      cursor: input.length,
      terminalWidth: 80,
      terminalHeight: 30,
    })

    expect(output).toContain('alpha draft row')
    expect(output).toContain('bravo draft row')
    expect(output).toContain('charlie draft row')
    expect(output).toContain('delta draft row')
  })

  it.each([40, 80, 150])('renders resource panels in the shared composer frame at %s columns', (width) => {
    const panels: readonly [ChatPanel, string][] = [
      [
        {
          id: 'export',
          kind: 'export',
          title: 'Export Strands harness',
          body: 'Export a copy, including pending agent changes.',
          rows: [
            { label: 'Python', description: 'strands-harness project', value: 'export:python' },
            { label: 'TypeScript', description: '@strands-agents/harness project', value: 'export:typescript' },
          ],
        },
        'Python',
      ],
      [
        {
          id: 'tools',
          kind: 'tools',
          title: 'Tools',
          rows: [
            {
              label: 'shell',
              description: 'Run shell commands',
              value: 'tools:toggle:shell',
              control: { kind: 'toggle', checked: true },
            },
          ],
        },
        'shell',
      ],
      [
        {
          id: 'mcp',
          kind: 'mcp',
          title: 'MCP servers (1)',
          searchable: true,
          rows: [{ label: 'docs', description: 'connected | stdio | 2 tools', section: 'Connected' }],
        },
        'docs',
      ],
      [
        {
          id: 'skills',
          kind: 'skills',
          title: 'Skills (1)',
          searchable: true,
          rows: [
            {
              label: 'review',
              description: 'Review code carefully',
              value: 'review',
              section: 'Available skills',
            },
          ],
        },
        'review',
      ],
      [
        {
          id: 'skill-detail',
          kind: 'detail',
          title: 'Skill: review',
          body: 'Read code carefully.',
          rows: [{ label: 'path', description: '/work/SKILL.md' }],
        },
        '/work/SKILL.md',
      ],
      [
        {
          id: 'help-detail',
          kind: 'help-detail',
          title: 'Help: read',
          body: 'Read a file.',
          rows: [],
        },
        'Read a file.',
      ],
      [
        {
          id: 'permissions',
          kind: 'permissions',
          title: 'Permissions',
          searchable: true,
          slider: {
            label: 'Permission mode',
            options: [
              { id: 'ask', label: 'Ask' },
              { id: 'bypass', label: 'Bypass' },
              { id: 'custom', label: 'Custom', active: true },
            ],
          },
          rows: [
            {
              label: 'shell',
              description: 'Runs without asking',
              value: 'permissions:tool:shell',
              section: 'Run without asking',
              control: { kind: 'toggle', checked: true },
            },
          ],
        },
        'shell',
      ],
    ]
    let bounds: { left: number; right: number } | undefined
    for (const [panel, expectedRow] of panels) {
      const output = sanitizeTerminalText(
        renderView({
          snapshot: snapshot({ panel }),
          panelRows: panel.rows,
          terminalWidth: width,
          terminalHeight: 24,
        })
      )
      const lines = output.split('\n')
      const border = lines.find((line) => line.includes('┌') && line.includes('┐'))
      const currentBounds = { left: border!.indexOf('┌'), right: border!.lastIndexOf('┐') }

      expect(output).toContain(panel.kind === 'permissions' && width < 53 ? 'Mode' : panel.title)
      expect(output).toContain(expectedRow)
      expect(output).not.toContain(`Viewing ${panel.title}`)
      expect(lines.at(-1)).toContain('/settings')
      expect(lines.every((line) => stringWidth(line) <= width)).toBe(true)
      bounds ??= currentBounds
      expect(currentBounds).toEqual(bounds)
    }
  })

  it('keeps tool controls beside their names and reveals the hovered description', () => {
    const panel = {
      id: 'tools',
      kind: 'tools' as const,
      title: 'Tools',
      rows: [
        {
          label: 'shell',
          description: 'Run shell commands',
          value: 'tools:toggle:shell',
          control: { kind: 'toggle' as const, checked: true },
        },
        {
          label: 'web_search',
          description: 'Search the web',
          value: 'tools:toggle:web_search',
          control: { kind: 'toggle' as const, checked: false },
        },
      ],
    }
    const render = (hoveredPanelRow?: number): string =>
      sanitizeTerminalText(
        renderView({
          snapshot: snapshot({ panel }),
          panelRows: panel.rows,
          panelSelection: 1,
          terminalWidth: 100,
          terminalHeight: 24,
          ...(hoveredPanelRow === undefined ? {} : { hoveredPanelRow }),
        })
      )

    expect(render()).not.toContain('Run shell commands')
    const hovered = render(0)
    expect(hovered).not.toContain('Search the web')
    expect(hovered.split('\n').find((line) => line.includes('shell'))).toMatch(/shell\s+━━●\s+Run shell commands/u)
  })

  it.each([
    [120, 40, false],
    [80, 24, false],
    [40, 16, false],
    [22, 10, false],
    [80, 24, true],
  ])(
    'overlays the command palette and /effort without shifting the conversation at %ix%i, party=%s',
    (width, height, party) => {
      const current = snapshot({
        completedTurns: [
          {
            id: 'turn-1',
            prompt: 'hello',
            agentName: 'Strands harness',
            entries: [
              {
                id: 'turn-1:1',
                type: 'assistant',
                text: Array.from({ length: 30 }, (_, index) => `Visible conversation ${index}`).join('\n'),
              },
            ],
            status: 'complete',
          },
        ],
      })
      const props = { terminalWidth: width, terminalHeight: height, party }
      const baseline = renderView({ ...props, snapshot: current }, { columns: width }).split('\n')
      const before = renderView({ ...props, input: '/effort', cursor: 7, snapshot: current }, { columns: width }).split(
        '\n'
      )
      const hiddenDraft = 'hidden draft\n'.repeat(20)
      const after = renderView(
        {
          ...props,
          input: hiddenDraft,
          cursor: hiddenDraft.length,
          snapshot: {
            ...current,
            panel: {
              id: 'effort',
              kind: 'effort',
              title: 'effort',
              body: 'Test Model\nprovider.test-model',
              rows: [],
              slider: {
                label: 'Effort',
                options: [
                  { id: 'low', label: 'Low' },
                  { id: 'high', label: 'High', active: true },
                ],
              },
            },
          },
        },
        { columns: width }
      ).split('\n')
      const paletteRow = before.findIndex((line) => line.includes('/effort'))
      expect(paletteRow).toBeGreaterThanOrEqual(0)
      const panelRow = after.findIndex((line) => line.includes('Reasoning effort'))
      expect(panelRow).toBeGreaterThanOrEqual(0)
      if (width >= 40) {
        const paletteTop = before
          .slice(0, paletteRow + 1)
          .map((line) => line.includes('┌'))
          .lastIndexOf(true)
        const panelTop = after
          .slice(0, panelRow + 1)
          .map((line) => line.includes('┌'))
          .lastIndexOf(true)
        expect(paletteTop).toBeGreaterThanOrEqual(0)
        expect(panelTop).toBeGreaterThanOrEqual(0)
        expect(before.slice(0, paletteTop)).toEqual(baseline.slice(0, paletteTop))
        expect(after.slice(0, panelTop)).toEqual(baseline.slice(0, panelTop))
      }
      const track = after
        .slice(panelRow)
        .join('\n')
        .match(/[─┬█]+/u)?.[0]
      expect(track).toBeDefined()
      expect(stringWidth(track!)).toBeLessThanOrEqual(60)
      if (width >= 40) {
        expect(after[panelRow]).toContain('Test Model')
        expect(after.join('\n')).toContain('Enter done · Esc close')
        expect(after.join('\n')).not.toContain('copy ID')
        expect(after.slice(0, panelRow).join('\n')).toContain('Visible conversation')
      }
      expect(after.findIndex((line) => line.includes('/work'))).toBe(before.findIndex((line) => line.includes('/work')))
      expect(after.join('\n')).not.toContain('Enter send')
      expect(after.length).toBe(before.length)
      expect(after.length).toBeLessThanOrEqual(height)
      expect(after.every((line) => stringWidth(line) <= width)).toBe(true)
    }
  )

  it.each([22, 40, 80, 150])('energizes the effort panel only when Max is selected at %s columns', (width) => {
    const effortPanel = (active: 'high' | 'max'): ChatPanel => ({
      id: 'effort',
      kind: 'effort',
      title: 'effort',
      rows: [],
      slider: {
        label: 'Effort',
        options: [
          { id: 'high', label: 'High', ...(active === 'high' ? { active: true } : {}) },
          { id: 'max', label: 'Max', ...(active === 'max' ? { active: true } : {}) },
        ],
      },
    })
    const renderEffort = (active: 'high' | 'max'): string =>
      sanitizeTerminalText(
        renderView({
          snapshot: snapshot({ panel: effortPanel(active), settings: { ...DEFAULT_CHAT_SETTINGS, animations: false } }),
          terminalWidth: width,
          terminalHeight: 24,
        })
      )
    const high = renderEffort('high')
    const max = renderEffort('max')

    expect(high).not.toMatch(/[ϟ✦]/u)
    expect(max).toMatch(/[ϟ✦]/u)
    expect(max).toMatch(/[━┃]/u)
    expect(max.split('\n').every((line) => stringWidth(line) <= width)).toBe(true)
  })

  it.each(['agents', 'mcp', 'settings'] as const)('renders the %s panel from its independent viewport', (kind) => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      label: `Tool ${String(index).padStart(2, '0')}`,
      description: `Description ${index}`,
      value: `configured:tool-${index}`,
    }))
    const output = renderView({
      snapshot: snapshot({
        panel: {
          id: 'tools',
          kind,
          title: 'tools',
          rows,
        },
      }),
      terminalWidth: 80,
      terminalHeight: 10,
      panelRows: rows,
      panelSelection: 0,
      panelViewportStart: 8,
    })

    expect(output).toContain('Tool 08')
    expect(output).not.toContain('Tool 00')
  })

  it('renders slash command suggestions as compact single-line rows', () => {
    const output = renderView({
      snapshot: snapshot(),
      input: '/',
      cursor: 1,
      terminalWidth: 100,
      terminalHeight: 40,
    })

    const lines = output.split('\n')
    expect(lines.find((line) => line.includes('/context'))).toMatch(/\/context\s+Show context usage/)
    expect(lines.find((line) => line.includes('/help'))).toContain('› /help')
  })

  it('renders slash-command signatures and completions while editing arguments', () => {
    const output = renderView({
      snapshot: snapshot(),
      input: '/permissions b',
      cursor: 14,
      terminalWidth: 100,
      terminalHeight: 40,
    })

    expect(output).toContain('/permissions [default|bypass]')
    expect(output).toContain('Allow tool calls without prompting')
  })

  it.each([40, 80, 120])('keeps MCP recovery controls and full error details reachable at %i columns', (width) => {
    const list: ChatPanel = {
      id: 'mcp',
      kind: 'mcp',
      title: 'MCP servers (1)',
      canRetry: true,
      searchable: true,
      rows: mcpRows(
        [
          {
            name: 'docs',
            transport: 'stdio',
            target: 'node',
            state: 'failed',
            error: 'Version negotiation failed: connection closed during the server/discover probe',
          },
        ],
        true
      ),
    }
    const listOutput = renderView(
      { snapshot: snapshot({ panel: list }), terminalWidth: width, terminalHeight: 24 },
      { columns: width }
    )
    expect(listOutput).toContain('Enter toggle')
    expect(listOutput).toContain(width < 66 ? '→ info' : '→ details')
    expect(listOutput).toContain(width < 66 ? 'R ·' : 'R retry')
    const panel: ChatDetailPanel = {
      id: 'mcp-detail',
      kind: 'detail',
      title: 'MCP: docs',
      rows: [
        {
          label: 'Next step',
          description: 'Check the server command and environment, then press R in the server list.',
        },
        { label: 'Source', description: '/Users/test/.strands/mcp.json' },
        { label: 'Transport', description: 'stdio' },
        { label: 'Target', description: 'node' },
      ],
      body: `Full error\nERROR_START\n${'Server negotiation diagnostic. '.repeat(30)}\nERROR_END`,
    }
    const maximum = maxDetailScroll(panel, width)
    const offsets = [...Array.from({ length: Math.ceil(maximum / 7) }, (_, index) => index * 7), maximum]
    const frames = offsets.map((detailScroll) =>
      renderView(
        { snapshot: snapshot({ panel }), terminalWidth: width, terminalHeight: 24, detailScroll },
        { columns: width }
      )
    )
    expect(frames[0]).toContain('Next step')
    expect(frames.join('\n')).toContain('ERROR_START')
    expect(frames.at(-1)).toContain('ERROR_END')
    expect(frames.every((frame) => frame.split('\n').every((line) => stringWidth(line) <= width))).toBe(true)
  })

  it.each([40, 80, 120])('scrolls background-agent details and follows the latest output at %i columns', (width) => {
    const panel: ChatDetailPanel = {
      id: 'task-detail',
      kind: 'detail',
      title: 'agent reviewer | completed',
      rows: [
        { label: 'task id', description: 'task-1' },
        { label: 'status', description: 'completed' },
        { label: 'agent', description: 'reviewer' },
      ],
      followTail: true,
      activity: {
        toolUseId: 'subagent-1',
        taskId: 'task-1',
        name: 'reviewer',
        task: 'Review authentication.',
        status: 'completed',
        entries: [
          { type: 'reasoning', text: 'Inspecting routes.' },
          {
            type: 'tool',
            toolUseId: 'read-1',
            name: 'read',
            input: { path: 'auth.ts' },
            status: 'success',
            result: '1\tconst authenticated = true',
          },
          { type: 'assistant', text: 'Authentication is sound.' },
        ],
      },
    }
    const maximum = maxDetailScroll(panel, width)
    const offsets = [...Array.from({ length: Math.ceil(maximum / 7) }, (_, index) => index * 7), maximum]
    const frames = offsets.map((detailScroll) =>
      sanitizeTerminalText(
        renderView(
          { snapshot: snapshot({ panel }), terminalWidth: width, terminalHeight: 24, detailScroll },
          { columns: width }
        )
      )
    )
    expect(frames[0]).toContain('Authentication is sound.')
    expect(frames[0]).not.toContain('task id')
    expect(frames.at(-1)).toContain('task id')
    expect(frames.at(-1)).toContain('task-1')
    expect(frames.at(-1)).toContain('status')
    expect(frames.at(-1)).toContain('TASK')
    expect(frames.at(-1)).not.toContain('Authentication is sound.')

    const output = frames.join('\n')
    expect(output).toContain('◇ Reasoning')
    expect(output).toContain('✓ Read')
    expect(output).toContain('│ 1    const authenticated')
    expect(output).toContain('◆ reviewer')
    expect(output).not.toContain('\t')
    for (const frame of frames) {
      const rows = frame.split('\n')
      const top = rows.findIndex((line) => line.includes('┌'))
      const bottom = rows.findIndex((line) => line.includes('└'))
      expect(stringWidth(rows[top]!.trim())).toBe(width - 2)
      expect(bottom - top + 1).toBe(11)
      expect(rows[top + 1]).toContain('agent reviewer')
      expect(rows[bottom + 1]).toContain('Esc back')
      expect(rows.at(-1)).toContain('/settings')
      expect(rows).toHaveLength(24)
      expect(rows.every((line) => stringWidth(line) <= width)).toBe(true)
      expect(frame).not.toContain('Viewing')
    }
  })

  it.each([40, 80, 120])(
    'keeps skill metadata and Unicode paths readable throughout scrolling at %i columns',
    (width) => {
      const panel: ChatDetailPanel = {
        id: 'skill-detail',
        kind: 'detail',
        title: 'Skill: review',
        rows: [
          { label: 'status', description: 'available on demand' },
          { label: 'description', description: 'Review source and explain changes 界👩‍💻e\u0301.' },
          { label: 'path', description: `/Users/用户/界👩‍💻e\u0301/${'nested/'.repeat(18)}SKILL.md` },
          { label: 'allowed tools', description: 'read, shell' },
          { label: 'license', description: 'Apache-2.0' },
          { label: 'compatibility', description: 'Strands CLI' },
        ],
        body: `FIRST_INSTRUCTION\nRead source before editing.\n${'界👩‍💻e\u0301/'.repeat(12)}\nFINAL_INSTRUCTION`,
      }
      const maximum = maxDetailScroll(panel, width)
      const offsets = [...Array.from({ length: Math.ceil(maximum / 7) }, (_, index) => index * 7), maximum]
      const level = chalk.level
      let frames: string[]
      try {
        chalk.level = 3
        frames = offsets.map((detailScroll) =>
          renderView(
            { snapshot: snapshot({ panel }), terminalWidth: width, terminalHeight: 24, detailScroll },
            { columns: width }
          )
        )
      } finally {
        chalk.level = level
      }
      const content: string[] = []
      let consumed = 0
      for (const [index, frame] of frames.entries()) {
        const rows = sanitizeTerminalText(frame).split('\n')
        const top = rows.findIndex((line) => line.includes('┌'))
        const bottom = rows.findIndex((line) => line.includes('└'))
        const visible = rows
          .slice(top + 3, bottom)
          .map((line) => line.slice(line.indexOf('│') + 1, line.lastIndexOf('│')))
        const start = offsets[index]!
        content.push(...visible.slice(Math.max(0, consumed - start)))
        consumed = start + visible.length

        expect(stringWidth(rows[top]!.trim())).toBe(width - 2)
        expect(bottom - top + 1).toBe(11)
        expect(rows[top + 1]).toContain(panel.title)
        expect(rows[top + 1]).toMatch(/\d+-\d+ \/ \d+/u)
        expect(rows[top + 2]?.replaceAll('│', '').trim()).toBe('')
        expect(rows[bottom + 1]).toContain('Esc back')
        expect(rows.at(-1)).toContain('/settings')
        expect(rows).toHaveLength(24)
        expect(rows.every((line) => stringWidth(line) <= width)).toBe(true)
        expect(frame.split('\n')[top]).toContain('\u001b[38;2;0;204;96m')
        expect(frame.split('\n')[top + 1]).toContain('\u001b[38;2;162;169;173m')
        expect(frame.slice(frame.indexOf('┌'))).not.toContain('\u001b[48;2;24;26;27m')
        expect(frame).not.toContain('Viewing')
      }
      const text = content.join('').replace(/\s/gu, '')
      for (const row of panel.rows) {
        expect(text).toContain(`${row.label}${row.description}`.replace(/\s/gu, ''))
      }
      expect(text).toContain(panel.body!.replace(/\s/gu, ''))
      const pathRow = content.findIndex((line) => line.includes('/Users/'))
      const pathColumn = content[pathRow]!.indexOf('/Users/')
      expect(content[pathRow + 1]!.slice(0, pathColumn).trim()).toBe('')
      expect(sanitizeTerminalText(frames.at(-1)!)).toContain('FINAL_INSTRUCTION')
    }
  )

  it('renders the colored startup wordmark with one model label', () => {
    const output = renderView({
      snapshot: snapshot(),
      terminalWidth: 100,
      terminalHeight: 40,
    })
    const plainOutput = sanitizeTerminalText(output)

    expect(output).toContain('[48;2;129;255;157m ')
    expect(output).toMatch(/[▗▖▄▝▐▞▟▘▚▌▙▀▜▛]/u)
    expect(plainOutput.match(/bedrock\/test/g)).toHaveLength(1)
  })

  it('opens direct shell output when tool output is hidden and collapses it on request', () => {
    const output = Array.from({ length: 12 }, (_, index) => `shell line ${index + 1}`).join('\n')
    const render = (expandedToolGroups?: ReadonlySet<string>): string =>
      sanitizeTerminalText(
        renderView({
          snapshot: snapshot({
            settings: { ...DEFAULT_CHAT_SETTINGS, toolOutput: 'hidden' },
            completedTurns: [
              {
                id: 'turn-1',
                prompt: '!seq 12',
                agentName: 'Strands harness',
                entries: [
                  {
                    id: 'turn-1:1',
                    type: 'tool',
                    toolUseId: 'shell-1',
                    name: 'shell',
                    input: { command: 'seq 12' },
                    status: 'success',
                    result: [{ type: 'text', text: output }],
                  },
                ],
                status: 'complete',
              },
            ],
          }),
          terminalWidth: 100,
          terminalHeight: 40,
          ...(expandedToolGroups ? { expandedToolGroups } : {}),
        })
      )

    const opened = render()
    expect(opened).toContain('▾')
    expect(opened).toContain('shell line 1')
    expect(opened).toContain('shell line 12')
    const collapsed = render(new Set(['turn-1:1:output']))
    expect(collapsed).toContain('▸')
    expect(collapsed).not.toContain('shell line 1')
  })

  it('offers a jump to the bottom just above the composer only while the transcript is scrolled up', () => {
    const render = (transcriptScroll: number): string[] =>
      sanitizeTerminalText(
        renderView({
          snapshot: snapshot({
            completedTurns: [
              {
                id: 'turn-1',
                prompt: 'hello',
                agentName: 'Strands harness',
                entries: [
                  {
                    id: 'turn-1:1',
                    type: 'assistant',
                    text: Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n'),
                  },
                ],
                status: 'complete',
              },
            ],
          }),
          terminalWidth: 80,
          terminalHeight: 24,
          transcriptScroll,
        })
      ).split('\n')

    expect(render(0).join('\n')).not.toContain('Jump to bottom')
    const scrolled = render(5)
    const jumpRow = scrolled.findIndex((line) => line.includes('Jump to bottom ↓'))
    expect(jumpRow).toBeGreaterThanOrEqual(0)
    expect(scrolled[jumpRow + 1]).toContain('┌')
  })

  it('renders phase-appropriate guidance inside the composer and a single metadata row below it', () => {
    const output = renderView({
      snapshot: snapshot({
        completedTurns: [
          {
            id: 'turn-1',
            prompt: 'hello',
            agentName: 'Strands harness',
            entries: [{ id: 'turn-1:1', type: 'assistant', text: 'answer' }],
            status: 'complete',
          },
        ],
        context: { contextWindow: 200_000 },
      }),
      terminalWidth: 100,
      terminalHeight: 40,
    })

    expect(output.indexOf('answer')).toBeLessThan(output.indexOf('Enter to send'))
    expect(output.indexOf('Enter to send')).toBeLessThan(output.lastIndexOf('bedrock/test'))
    expect(output.split('\n').some((line) => line.trim() === 'hello')).toBe(true)
    expect(output).not.toContain('context ░')
    expect(output).toContain('Enter to send • Ctrl+J for newline • / for commands')
    const rows = output.trimEnd().split('\n')
    expect(rows.at(-1)).toContain('bedrock/test')
    expect(rows.at(-1)).toContain('/work')
    expect(rows.at(-2)?.trim()).toBe('')
    expect(rows.at(-1)).toContain('/settings')
    expect(rows.at(-1)).not.toContain('Enter')
    expect(output).not.toContain('/setup')
    expect(output).not.toContain('/help')

    const runningOutput = renderView({
      snapshot: snapshot({
        activeTurn: {
          id: 'turn-2',
          prompt: 'work',
          agentName: 'Strands harness',
          entries: [],
          status: 'running',
        },
        status: 'running',
      }),
      terminalWidth: 100,
      terminalHeight: 40,
    })
    expect(runningOutput).toContain('Enter to queue • Ctrl+J for newline • / for commands')
    expect(runningOutput).not.toContain('Enter to send')

    const updateOutput = renderView({
      snapshot: snapshot(),
      terminalWidth: 100,
      terminalHeight: 40,
      availableUpdate: '0.2.1',
    })
    expect(updateOutput).toContain('↑ Update 0.2.1')
    expect(updateOutput).toContain('/settings')
  })

  it('shows active background tasks immediately above the composer', () => {
    const output = renderView({
      snapshot: snapshot({
        tasks: [
          {
            id: 'task-1',
            label: 'subagent',
            status: 'working',
            source: 'background',
          },
          {
            id: 'task-2',
            label: 'read',
            status: 'queued',
            source: 'background',
          },
          {
            id: 'task-3',
            label: 'write',
            status: 'completed',
            source: 'background',
          },
        ],
      }),
      terminalWidth: 100,
      terminalHeight: 30,
    })

    expect(output).toContain('Background task running (subagent) - task-1')
    expect(output).toContain('Background task queued (read) - task-2')
    expect(output).not.toContain('Background task completed (write) - task-3')
    expect(output.indexOf('Background task queued (read)')).toBeLessThan(output.indexOf('Enter to send'))
  })

  it('scrolls the startup lockup with the conversation', () => {
    const firstTurn = {
      id: 'turn-1',
      prompt: 'hello',
      agentName: 'Strands harness',
      entries: [{ id: 'turn-1:1', type: 'assistant' as const, text: 'answer' }],
      status: 'complete' as const,
    }
    const output = sanitizeTerminalText(
      renderView({
        snapshot: snapshot({
          completedTurns: [firstTurn],
        }),
        terminalWidth: 100,
        terminalHeight: 40,
      })
    )

    expect(output).toContain('╚════╝')
    expect(output.indexOf('╚════╝')).toBeLessThan(output.indexOf('hello'))
    expect(output.indexOf('hello')).toBeLessThan(output.indexOf('answer'))

    const continuedOutput = sanitizeTerminalText(
      renderView({
        snapshot: snapshot({
          completedTurns: Array.from({ length: 8 }, (_, index) => ({
            id: `turn-${index + 1}`,
            prompt: index === 0 ? 'hello' : `continue ${index}`,
            agentName: 'Strands harness',
            entries: [
              {
                id: `turn-${index + 1}:1`,
                type: 'assistant',
                text: index === 0 ? 'answer' : `continued answer ${index}`,
              },
            ],
            status: 'complete',
          })),
        }),
        terminalWidth: 100,
        terminalHeight: 40,
      })
    )
    expect(continuedOutput).not.toContain('╚════╝')
  })

  it('keeps the transcript on its latest rows in the frame where a turn completes', async () => {
    const turn = (status: ChatTurn['status']): ChatTurn => ({
      id: 'turn-1',
      prompt: 'hello',
      agentName: 'Strands harness',
      entries: [
        {
          id: 'turn-1:1',
          type: 'assistant',
          text: Array.from({ length: 30 }, (_, index) => `answer line ${index}`).join('\n\n'),
        },
      ],
      status,
    })
    const output = ttyOutput(100, 30)
    const frames: string[] = []
    output.on('data', (chunk: Buffer) => frames.push(sanitizeTerminalText(chunk.toString())))
    const view = (overrides: Partial<ChatSnapshot>): ReactElement =>
      createElement(ChatView, {
        snapshot: snapshot(overrides),
        input: '',
        cursor: 0,
        terminalWidth: 100,
        terminalHeight: 30,
      })
    const instance = render(view({ activeTurn: turn('running'), status: 'running' }), {
      stdout: output,
      debug: true,
      patchConsole: false,
    })
    try {
      await instance.waitUntilRenderFlush()
      frames.length = 0
      instance.rerender(view({ completedTurns: [turn('complete')] }))
      await instance.waitUntilRenderFlush()

      expect(frames.length).toBeGreaterThan(0)
      for (const frame of frames) {
        expect(frame).toContain('answer line 29')
        expect(frame).not.toContain('╚════╝')
      }
    } finally {
      instance.unmount()
    }
  })

  it.each([
    [3_497, 1_000_000, '█░░░░░░░░░ 0.3%'],
    [125_000, 100_000, '██████████ 125%'],
  ])('shows precise context usage for %i of %i tokens', (projectedTokens, contextWindow, expected) => {
    expect(formatContext({ projectedTokens, contextWindow })).toBe(expected)
  })

  it('marks the context meter as unknown when the context window is unavailable', () => {
    const output = renderView({
      snapshot: snapshot({ context: { projectedTokens: 12_000 } }),
      terminalWidth: 100,
      terminalHeight: 40,
    })

    expect(output).toContain('bedrock/test')
    expect(output).not.toContain('context ')
    expect(output).toContain('░░░░░░░░░░ —')
  })

  it('shows only the token count in the context panel when the context window is unknown', () => {
    const output = sanitizeTerminalText(
      renderView({
        snapshot: snapshot({
          context: { projectedTokens: 12_000 },
          panel: { id: 'context', kind: 'context', title: 'Context usage', rows: [] },
        }),
        terminalWidth: 100,
        terminalHeight: 30,
      })
    )

    expect(output).toContain('Context usage')
    expect(output).toContain('12,000 tokens')
    expect(output).not.toContain('/ —')
    expect(output.slice(output.indexOf('Context usage'), output.indexOf('Esc close'))).not.toContain('░')
  })

  it.each([44, 100])('shows the context meter and last-turn usage at width %i', (terminalWidth) => {
    const output = sanitizeTerminalText(
      renderView(
        {
          snapshot: snapshot({
            context: {
              projectedTokens: 59_689,
              contextWindow: 1_050_000,
              inputTokens: 71_077,
              outputTokens: 212,
              totalTokens: 71_289,
              cacheReadInputTokens: 0,
              cacheWriteInputTokens: 59_675,
            },
            panel: { id: 'context', kind: 'context', title: 'Context usage', rows: [] },
          }),
          terminalWidth,
          terminalHeight: 20,
        },
        { columns: terminalWidth }
      )
    )

    expect(output).toContain('Context usage')
    expect(output).toContain('59,689 / 1,050,000 tokens')
    expect(output).toContain('5.7%')
    expect(output).not.toContain('/help')
    expect(output).toMatch(/Last turn\s+71,289 tokens/)
    expect(output).toMatch(/Input\s+71,077/)
    expect(output).toMatch(/Output\s+212/)
    expect(output).toMatch(/Cache read\s+0/)
    expect(output).toMatch(/Cache write\s+59,675/)
  })

  it.each([44, 80, 100, 150])('keeps estimated token categories inside the composer at width %i', (terminalWidth) => {
    const output = sanitizeTerminalText(
      renderView(
        {
          snapshot: snapshot({
            context: {
              currentTokens: 59_800,
              projectedTokens: 60_000,
              contextWindow: 1_050_000,
              totalTokens: 71_289,
              inputTokens: 71_077,
              outputTokens: 212,
              cacheReadInputTokens: 59_675,
              cacheWriteInputTokens: 0,
              breakdown: {
                categories: [
                  { kind: 'systemPrompt', tokens: 4_000 },
                  { kind: 'tools', tokens: 12_000 },
                  { kind: 'userMessages', tokens: 2_000 },
                  { kind: 'assistantMessages', tokens: 6_000 },
                  { kind: 'toolResults', tokens: 30_000 },
                  { kind: 'injectedContext', tokens: 5_000 },
                  { kind: 'other', tokens: 1_000 },
                ],
              },
            },
            panel: { id: 'context', kind: 'context', title: 'Context usage', rows: [] },
          }),
          terminalWidth,
          terminalHeight: 24,
        },
        { columns: terminalWidth }
      )
    )
    const lines = output.split('\n')
    const title = lines.findIndex((line) => line.includes('Context usage'))
    const footer = lines.findIndex((line) => line.includes('Esc close'))
    const bottomBorder = lines.findIndex((line, index) => index > title && line.includes('└'))
    const metadata = lines.findIndex((line, index) => index > title && line.includes('bedrock/test'))
    expect(title).toBeGreaterThan(0)
    expect(output).toContain('60,000 / 1,050,000 tokens')
    expect(output).toContain('5.7%')
    expect(output).toContain('Estimated breakdown')
    for (const count of ['4.0k', '12.0k', '2.0k', '6.0k', '30.0k', '5.0k', '1.0k', '990.0k']) {
      expect(output).toContain(count)
    }
    expect(output).toMatch(/Last turn\s+71,289 tokens/)
    expect(output).toMatch(/Cache read\s+59,675/)
    expect(footer).toBeGreaterThan(title)
    expect(bottomBorder).toBeGreaterThan(footer)
    expect(metadata).toBeGreaterThan(bottomBorder)
    expect(lines.every((line) => stringWidth(line) <= terminalWidth)).toBe(true)
  })

  it('fits the category legend, free space, and close hint in a short context panel', () => {
    const output = sanitizeTerminalText(
      renderView(
        {
          snapshot: snapshot({
            context: {
              projectedTokens: 12_000,
              contextWindow: 100_000,
              breakdown: { categories: [{ kind: 'toolResults', tokens: 12_000 }] },
            },
            panel: { id: 'context', kind: 'context', title: 'Context usage', rows: [] },
          }),
          terminalWidth: 40,
          terminalHeight: 14,
        },
        { columns: 40 }
      )
    )
    expect(output).toContain('Estimated breakdown')
    expect(output).toMatch(/Results\s+12.0k/)
    expect(output).toMatch(/Free\s+88.0k/)
    expect(output).toContain('Esc close')
    expect(output).toContain('/settings')
  })

  it('separates turn boundaries', () => {
    const output = renderView({
      snapshot: snapshot({
        settings: { ...DEFAULT_CHAT_SETTINGS, transcriptSpacing: 'compact' },
        completedTurns: [
          {
            id: 'turn-1',
            prompt: 'hello',
            agentName: 'Strands harness',
            entries: [{ id: 'turn-1:1', type: 'assistant', text: 'answer' }],
            status: 'complete',
            durationMs: 12_400,
            usage: {
              totalTokens: 3_332,
              cacheReadInputTokens: 0,
              cacheWriteInputTokens: 3_235,
            },
          },
          {
            id: 'turn-2',
            prompt: 'next message',
            agentName: 'Strands harness',
            entries: [
              { id: 'turn-2:1', type: 'reasoning', text: 'thinking through the next request' },
              { id: 'turn-2:2', type: 'assistant', text: 'next answer' },
            ],
            status: 'complete',
            durationMs: 2_000,
          },
        ],
      }),
      terminalWidth: 100,
      terminalHeight: 40,
    })

    expect(output).toContain('Worked for 12s · 3,332 tokens used')
    const lines = sanitizeTerminalText(output)
      .split('\n')
      .map((line) => line.trim())
    const firstMetrics = lines.findIndex((line) => line.startsWith('Worked for 12s'))
    const nextMessage = lines.indexOf('next message')
    const finalMetrics = lines.indexOf('Worked for 2.0s')
    expect(lines[firstMetrics + 1]).toBe('')
    expect(nextMessage).toBe(firstMetrics + 2)
    expect(lines[nextMessage + 1]).toBe('')
    expect(lines[nextMessage + 2]).toBe('Reasoning')
    expect(finalMetrics).toBeGreaterThan(nextMessage)
    expect(lines[finalMetrics + 1]).toBe('')
  })

  it.each([
    ['comfortable', 'hidden'],
    ['comfortable', 'compact'],
    ['compact', 'hidden'],
    ['compact', 'compact'],
  ] as const)('adds one blank row after reasoning with %s spacing and %s tools', (transcriptSpacing, toolOutput) => {
    const output = renderView({
      snapshot: snapshot({
        settings: { ...DEFAULT_CHAT_SETTINGS, transcriptSpacing, toolOutput },
        completedTurns: [
          {
            id: 'turn-1',
            prompt: 'inspect this',
            agentName: 'Strands harness',
            entries: [
              { id: 'reasoning-1', type: 'reasoning', text: 'I should inspect the files.' },
              {
                id: 'tool-1',
                type: 'tool',
                toolUseId: 'tool-use-1',
                name: 'bash',
                input: { command: 'npm test' },
                status: 'success',
              },
              {
                id: 'tool-2',
                type: 'tool',
                toolUseId: 'tool-use-2',
                name: 'read',
                input: { path: 'README.md' },
                status: 'success',
              },
              { id: 'reasoning-2', type: 'reasoning', text: 'I have enough context.' },
              { id: 'answer-1', type: 'assistant', text: 'Done.' },
            ],
            status: 'complete',
          },
        ],
      }),
      terminalWidth: 100,
      terminalHeight: 40,
    })

    const lines = sanitizeTerminalText(output)
      .split('\n')
      .map((line) => line.trim())
    expect(lines[lines.indexOf('I should inspect the files.') + 1]).toBe('')
    expect(lines[lines.indexOf('I should inspect the files.') + 2]).toContain(
      toolOutput === 'hidden' ? 'Shell npm test' : 'Tool activity'
    )
    expect(lines[lines.indexOf('I have enough context.') + 1]).toBe('')
    expect(lines[lines.indexOf('I have enough context.') + 2]).toBe('Strands harness')
  })

  it('presents maxTokens as a recoverable output limit', () => {
    const output = renderView({
      snapshot: snapshot({
        completedTurns: [
          {
            id: 'turn-1',
            prompt: 'write a long response',
            agentName: 'Strands harness',
            entries: [{ id: 'turn-1:1', type: 'assistant', text: 'partial response' }],
            status: 'complete',
            stopReason: 'maxTokens',
          },
        ],
      }),
      terminalWidth: 100,
      terminalHeight: 40,
    })

    expect(output).toContain('partial response')
    expect(output).toContain('Response reached its output limit.')
    expect(output).not.toContain('Stopped: maxTokens')
  })

  it('renders forced and model-driven background tasks identically', () => {
    const output = renderView({
      snapshot: snapshot({
        completedTurns: [
          {
            id: 'turn-1',
            prompt: 'delegate this',
            agentName: 'Strands harness',
            entries: [
              {
                id: 'turn-1:1',
                type: 'tool',
                toolUseId: 'subagent-1',
                name: 'subagent',
                input: { task: 'Review authentication.' },
                status: 'success',
                background: true,
                result: [
                  {
                    type: 'text',
                    text: 'Background task dispatched.\n\nTask ID: task-1\nTool: subagent\nStatus: queued',
                  },
                ],
              },
              {
                id: 'turn-1:2',
                type: 'tool',
                toolUseId: 'read-1',
                name: 'read',
                input: { path: 'src/auth.ts', _background_execution: true },
                status: 'success',
                background: true,
                result: [
                  {
                    type: 'text',
                    text: 'Background task dispatched.\n\nTask ID: task-2\nTool: read\nStatus: queued',
                  },
                ],
              },
            ],
            status: 'complete',
          },
        ],
      }),
      terminalWidth: 100,
      terminalHeight: 40,
    })

    expect(output).toContain('↗ Background task started (subagent) - task-1')
    expect(output).toContain('↗ Background task started (read) - task-2')
    expect(output).not.toContain('Subagent Review authentication.')
    expect(output).not.toContain('Read src/auth.ts')
    expect(output).not.toContain('Background task dispatched.')
    expect(output).not.toContain('Status: queued')
  })

  it('shows a subagent as background before its dispatch result arrives', () => {
    const output = renderView({
      snapshot: snapshot({
        activeTurn: {
          id: 'turn-1',
          prompt: 'delegate this',
          agentName: 'Strands harness',
          entries: [
            {
              id: 'turn-1:1',
              type: 'tool',
              toolUseId: 'subagent-1',
              name: 'subagent',
              input: { task: 'Review authentication.' },
              status: 'running',
              background: true,
            },
          ],
          status: 'running',
        },
      }),
      terminalWidth: 100,
      terminalHeight: 30,
    })

    expect(output).toContain('Background task starting (subagent)')
    expect(output).not.toContain('Subagent Review authentication.')
  })

  it.each(['compact', 'comfortable'] as const)('separates tool groups in %s mode', (transcriptSpacing) => {
    const output = renderView({
      snapshot: snapshot({
        settings: { ...DEFAULT_CHAT_SETTINGS, transcriptSpacing, showReasoning: false },
        completedTurns: [
          {
            id: 'turn-1',
            prompt: 'inspect this',
            agentName: 'Strands harness',
            entries: [
              { id: 'hidden-reasoning', type: 'reasoning', text: 'Hidden reasoning' },
              {
                id: 'turn-1:1',
                type: 'tool',
                toolUseId: 'running-1',
                name: 'bash',
                input: { command: 'npm test' },
                status: 'running',
              },
              {
                id: 'turn-1:2',
                type: 'tool',
                toolUseId: 'success-1',
                name: 'read',
                input: { path: 'README.md', offset: 10, limit: 20 },
                status: 'success',
                result: [{ type: 'text', text: 'one\ntwo\nthree\nfour' }],
              },
              {
                id: 'turn-1:3',
                type: 'tool',
                toolUseId: 'error-1',
                name: 'write',
                input: { path: 'blocked.txt' },
                status: 'error',
                error: 'permission denied',
              },
              {
                id: 'turn-1:4',
                type: 'tool',
                toolUseId: 'cancelled-1',
                name: 'web_search',
                input: { query: 'Strands' },
                status: 'cancelled',
              },
            ],
            status: 'complete',
          },
        ],
      }),
      terminalWidth: 100,
      terminalHeight: 60,
      expandedToolGroups: new Set(['turn-1:1']),
    })

    expect(output).toContain('Shell npm test · running')
    expect(output).toContain('✓ Read README.md:10-29')
    expect(output).toContain('└ … 1 more lines')
    expect(output).toContain('× Write blocked.txt · failed')
    expect(output).toContain('└ permission denied')
    expect(output).toContain('○ Search Strands · cancelled')
    const lines = sanitizeTerminalText(output)
      .split('\n')
      .map((line) => line.trim())
    const prompt = lines.indexOf('inspect this')
    expect(lines[prompt + 1]).toBe('')
    expect(lines[prompt + 2]).toContain('Tool activity')
  })

  it.each([80, 20])('renders clickable Markdown labels at %i columns without repeating URLs', (columns) => {
    vi.stubEnv('TERM_PROGRAM', 'ghostty')
    const output = renderToString(
      createElement(Markdown, { children: 'Visit [**Strands** docs](https://strandsagents.com) for details.' }),
      { columns }
    )
    expect(output).toContain('\u001b]8;;https://strandsagents.com/\u0007')
    expect(output).toContain('\u001b]8;;\u0007')
    expect(sanitizeTerminalText(output).replace(/\s+/gu, ' ')).toBe('Visit Strands docs for details.')
    const unsafe = renderToString(createElement(Markdown, { children: '[Unsupported](javascript:alert)' }), { columns })
    expect(unsafe).not.toContain('\u001b]8;;')
    vi.stubEnv('TERM_PROGRAM', 'Apple_Terminal')
    const fallback = renderToString(
      createElement(Markdown, { children: '[Strands docs](https://strandsagents.com)' }),
      { columns }
    )
    expect(fallback).not.toContain('\u001b]8;;')
    expect(sanitizeTerminalText(fallback).replace(/\s/gu, '')).toContain('(https://strandsagents.com)')
  })

  it('shows complete output for direct bang commands even when tool output is compact', () => {
    const output = renderView({
      snapshot: snapshot({
        completedTurns: [
          {
            id: 'turn-1',
            prompt: '!printf output',
            agentName: 'Strands harness',
            entries: [
              {
                id: 'turn-1:1',
                type: 'tool',
                toolUseId: 'shell-1',
                name: 'shell',
                input: { command: 'printf output' },
                status: 'success',
                result: [{ type: 'text', text: 'one\ntwo\nthree\nfour\nfive' }],
              },
            ],
            status: 'complete',
          },
        ],
      }),
      terminalWidth: 100,
      terminalHeight: 40,
    })

    expect(output).toContain('one')
    expect(output).toContain('five')
    expect(output).not.toContain('more lines')
  })

  it('labels permission tools and inputs without treating the prompt as a viewed panel', () => {
    const output = renderView({
      snapshot: snapshot({
        panel: {
          id: 'permission-1',
          kind: 'permission',
          title: 'Strands harness requests permission',
          body: '{}',
          request: {
            id: 'request',
            toolName: 'write',
            input: { path: '/Users/test/Desktop/storage/test.txt', content: 'The treasure is buried.' },
            options: [],
            action: '/Users/test/Desktop/storage/test.txt',
          },
          rows: [
            { label: 'Allow once', description: 'Run only this call', value: 'allow' },
            { label: 'Allow forever…', description: 'Always allow · choose how broadly', value: 'always' },
            { label: 'Deny once', description: 'Block this call', value: 'deny', tone: 'danger' },
            { label: 'Deny forever…', description: 'Always block', value: 'never', tone: 'danger' },
          ],
        },
      }),
      terminalWidth: 100,
      terminalHeight: 30,
    })

    const lines = sanitizeTerminalText(output).split('\n')
    const row = (text: string): string => lines.find((line) => line.includes(text)) ?? ''
    expect(row('Allow once')).toMatch(/│.*Allow once/u)
    expect(row('Tool')).toMatch(/Tool\s+write.*│/u)
    const divider = lines.find((line) => line.includes('┐┌'))!.indexOf('┐')
    expect(row('Allow once').indexOf('Allow once')).toBeLessThan(divider)
    expect(row('Tool').indexOf('Tool')).toBeGreaterThan(divider)
    expect(divider).toBeLessThan(50)
    expect(row('Action')).toMatch(/Action\s+\/Users\/test\/Desktop/u)
    expect(sanitizeTerminalText(output)).toContain('test.txt')
    expect(output).toContain('Deny forever…')
    expect(output).toContain('Run only this call')
    expect(output).not.toContain('The treasure is buried.')
    expect(output).toContain('Strands harness requests permission')
    expect(output).toContain('Esc deny once')
    expect(output).not.toContain('Permission required')
    expect(output).not.toContain('Viewing Strands harness requests permission')
  })

  it('pauses activity signals while a tool approval is pending', () => {
    const request = {
      id: 'request',
      toolName: 'shell',
      input: { command: 'echo hi' },
      options: [],
      action: 'echo hi',
      scopes: [],
    }
    const activeTurn = {
      id: 'turn-1',
      prompt: 'run echo',
      agentName: 'Strands harness',
      entries: [
        {
          id: 'turn-1:1',
          type: 'tool' as const,
          toolUseId: 'shell-1',
          name: 'shell',
          input: { command: 'echo hi' },
          status: 'running' as const,
        },
      ],
      status: 'running' as const,
    }
    const pending = renderView({
      snapshot: snapshot({
        activeTurn,
        status: 'running',
        panel: {
          id: 'permission-1',
          kind: 'permission',
          title: 'Allow tool call?',
          body: '{}',
          request,
          rows: [{ label: 'Allow once', description: 'Run only this call', value: 'allow' }],
        },
      }),
      terminalWidth: 100,
      terminalHeight: 60,
    })
    const working = renderView({
      snapshot: snapshot({ activeTurn, status: 'running' }),
      terminalWidth: 100,
      terminalHeight: 60,
    })

    expect(pending).toContain('◆ Waiting for approval')
    expect(pending).toContain('◆ Shell')
    expect(pending).toContain('· paused')
    expect(pending).not.toContain('esc to interrupt')
    expect(pending).not.toContain('· running')
    expect(working).toContain('Working (esc to interrupt)')
    expect(working).toContain('· running')
  })

  it('renders permission choices as green and red bordered buttons with a bright selected state', () => {
    const request = {
      id: 'request',
      toolName: 'shell',
      input: { command: 'git push' },
      options: [],
      action: 'git push',
      scopes: [],
    }
    const panel: ChatPanel = {
      id: 'permission-buttons',
      kind: 'permission',
      title: 'Allow shell?',
      body: '{}',
      request,
      rows: [
        { label: 'Allow once', description: 'Run only this call', value: 'allow', tone: 'success' },
        { label: 'Allow forever…', description: 'Always allow', value: 'trust', tone: 'success' },
        { label: 'Deny once', description: 'Block this call', value: 'deny', tone: 'danger' },
      ],
    }
    const level = chalk.level
    let output: string
    try {
      chalk.level = 3
      output = renderView({
        snapshot: snapshot({ panel }),
        terminalWidth: 100,
        terminalHeight: 30,
        panelSelection: 0,
      })
    } finally {
      chalk.level = level
    }
    const lines = output.split('\n')
    const selected = lines.find((line) => line.includes('Allow once'))
    const resting = lines.find((line) => line.includes('Deny once'))
    // No fills anywhere: green/red labels, gray borders, and an accent border on the selection.
    expect(output).not.toContain('\u001b[48;2;48;50;51m')
    expect(selected).toContain('\u001b[38;2;104;245;138m')
    expect(selected).toContain('▸')
    expect(selected).not.toContain('\u001b[2m\u001b[38;2;104;245;138m▸')
    expect(resting).toContain('\u001b[38;2;255;114;124m')
    expect(resting).toContain('\u001b[38;2;100;108;113m')
    expect(sanitizeTerminalText(output)).toContain('┌')
  })

  it('keeps interruption, steering, and queued prompts visible while the agent streams output', () => {
    const output = renderView({
      snapshot: snapshot({
        activeTurn: {
          id: 'turn-1',
          prompt: 'Inspect the repository',
          agentName: 'Strands harness',
          entries: [
            { id: 'turn-1:1', type: 'assistant', text: 'I am inspecting the files.' },
            { id: 'turn-1:2', type: 'user', text: 'Focus on the failing test' },
            { id: 'turn-1:3', type: 'assistant', text: 'I am changing direction.' },
          ],
          status: 'running',
        },
        pendingSteering: ['Use parser diagnostics'],
        queuedPrompts: [
          { id: 'queued-1', prompt: 'Run the focused tests' },
          { id: 'queued-2', prompt: 'Then summarize the result' },
        ],
        status: 'running',
        settings: { ...DEFAULT_CHAT_SETTINGS, animations: false },
      }),
      input: 'Steer toward the failing test',
      cursor: 29,
      terminalWidth: 100,
      terminalHeight: 40,
    })

    const lines = output.split('\n')
    const steeringRow = lines.findIndex((line) => line.includes('Focus on the failing test'))
    expect(output).toContain('I am inspecting the files.')
    expect(output).toContain('Focus on the failing test')
    expect(lines[steeringRow + 1]).toBe('')
    expect(output).toContain('I am changing direction.')
    expect(output).toContain('Steering · Use parser diagnostics')
    expect(output).toContain('* Working (esc to interrupt)')
    expect(output).toContain('Steer toward the failing test')
    expect(output).toContain('Queued 1/2')
    expect(output).toContain('Run the focused tests')
    expect(output).toContain('Edit')
    expect(lines.find((line) => line.includes('Queued 1/2'))).not.toContain('Steer')
  })

  it('shows that cancellation is still draining before queued work can run', () => {
    const output = renderView({
      snapshot: snapshot({
        completedTurns: [
          {
            id: 'turn-1',
            prompt: 'Inspect the repository',
            agentName: 'Strands harness',
            entries: [],
            status: 'cancelled',
          },
        ],
        queuedPrompts: [{ id: 'queued-1', prompt: 'Use a different approach' }],
        status: 'interrupting',
      }),
      terminalWidth: 100,
      terminalHeight: 30,
    })

    expect(output).toContain('Interrupting')
    expect(output).toContain('1/1')
    expect(output).toContain('Use a different approach')
    expect(output).toContain('Edit')
  })

  it('renders peer messages with their sender instead of as user input', () => {
    const output = renderView({
      snapshot: snapshot({
        completedTurns: [
          {
            id: 'turn-1',
            prompt: 'Please check the parser.',
            source: 'peer',
            peer: { id: 'agent-2', name: 'Reviewer' },
            agentName: 'Strands harness',
            entries: [{ id: 'turn-1:1', type: 'assistant', text: 'It looks correct.' }],
            status: 'complete',
          },
        ],
      }),
      terminalWidth: 100,
      terminalHeight: 30,
    })

    expect(output).toContain('Message from Reviewer')
    expect(output).toContain('Please check the parser.')
  })

  it.each([
    [100, 30],
    [40, 16],
    [22, 10],
  ])('renders agent cards across the full terminal at %i×%i', (width, height) => {
    const output = renderView({
      snapshot: snapshot({
        completedTurns: [
          {
            id: 'previous-turn',
            prompt: 'Previous conversation request',
            agentName: 'Strands harness',
            entries: [{ id: 'previous-answer', type: 'assistant', text: 'Previous conversation answer' }],
            status: 'complete',
          },
        ],
        configuration: liveConfiguration,
        panel: {
          id: 'agents-1',
          kind: 'agents',
          title: 'Agents',
          rows: [
            {
              label: 'Research',
              description: 'Primary agent',
              value: 'conversation:agent-1',
              bold: true,
              current: true,
              badge: { text: 'idle', tone: 'success' },
            },
            {
              label: 'Reviewer',
              description: 'Fork of Research',
              value: 'conversation:agent-2',
              bold: true,
              current: false,
              badge: { text: 'working', tone: 'success' },
            },
            {
              label: 'Delegate',
              description: 'Live delegate',
              badge: { text: 'working', tone: 'success' },
            },
          ],
        },
      }),
      input: 'Unsent composer draft',
      cursor: 21,
      terminalWidth: width,
      terminalHeight: height,
    })

    expect(output).toContain('Agents')
    expect(output).toContain('1/3')
    expect(output).toContain('Research')
    expect(output).toContain('●')
    expect(output).not.toContain('Viewing Agents')
    expect(output).not.toContain('Previous conversation')
    expect(output).not.toContain('Unsent composer draft')
    expect(output).not.toContain('createHarness')
    expect(output).not.toContain('bedrock/test')
    expect(output).not.toContain('/settings')
    expect(output).not.toContain('Enter to send')
    const lines = output.split('\n')
    expect(lines).toHaveLength(height)
    expect(lines.every((line) => stringWidth(line) <= width)).toBe(true)
    expect(output).toContain('┌')
    expect(output).toContain('┘')
    if (width === 100) {
      expect(lines.some((line) => line.includes('Research') && line.includes('Reviewer'))).toBe(true)
      expect(lines.some((line) => (line.match(/┌/gu)?.length ?? 0) === 3)).toBe(true)
      expect(output).toContain('Current')
      expect(output).toContain('Primary agent')
      expect(output).toContain('idle')
      expect(output).toContain('Chat')
      expect(output).toContain('Fork of Research')
      expect(output).toContain('Live delegate')
      expect(output).toContain('working')
    }
  })

  it('renders fork progress alongside the conversation', () => {
    const output = renderView({
      snapshot: snapshot({
        completedTurns: [
          {
            id: 'turn-1',
            prompt: 'Keep this conversation visible',
            agentName: 'Strands harness',
            entries: [{ id: 'reply-1', type: 'assistant', text: 'Existing reply' }],
            status: 'complete',
          },
        ],
        notices: [{ id: 'manager-fork-progress', afterTurnId: 'turn-1', text: 'Forking agent…', status: 'running' }],
      }),
      terminalWidth: 100,
      terminalHeight: 30,
    })

    expect(output).toContain('Forking agent')
    expect(output).toContain('Keep this conversation visible')
    expect(output).toContain('Existing reply')
    expect(output).toContain('Enter to send')
    expect(output).not.toContain('Viewing Forking agent')
  })

  it('renders compaction status inside the composer instead of as a panel', () => {
    const output = renderView({
      snapshot: snapshot({ composerStatus: 'Compacting context...' }),
      terminalWidth: 100,
      terminalHeight: 30,
    })

    expect(output).toContain('| Compacting context...')
    expect(output).not.toContain('Enter to send')
  })

  it('renders sent peer messages as transcript message bands', () => {
    const output = renderView({
      snapshot: snapshot({
        completedTurns: [
          {
            id: 'turn-1',
            prompt: 'Ask the reviewer',
            agentName: 'Strands harness',
            entries: [
              {
                id: 'turn-1:1',
                type: 'tool',
                toolUseId: 'message-1',
                name: 'message_agent',
                input: { action: 'send', to: 'agent-2', message: 'Please check the parser.' },
                status: 'success',
                result: [
                  {
                    type: 'json',
                    value: {
                      status: 'queued',
                      recipient: 'Reviewer',
                    },
                  },
                ],
              },
            ],
            status: 'complete',
          },
        ],
      }),
      terminalWidth: 100,
      terminalHeight: 30,
    })

    expect(output).toContain('Message to Reviewer')
    expect(output).toContain('Please check the parser.')
    expect(output).not.toContain('message_agent')
  })

  it.each([40, 80])('renders every /settings row inside the composer at %sx24', (width) => {
    const rows = settingsRows(DEFAULT_CHAT_SETTINGS, 'Appearance')
    let lines: string[] = []
    let output = ''
    for (const [selected, row] of rows.entries()) {
      lines = sanitizeTerminalText(
        renderView({
          snapshot: snapshot({ panel: settingsPanel('Appearance') }),
          terminalWidth: width,
          terminalHeight: 24,
          panelSelection: selected,
        })
      ).split('\n')
      output = lines.join('\n')
      expect(output).toContain(`› ${row.label.slice(0, 6)}`)
    }
    expect(lines.length).toBeLessThanOrEqual(24)
    expect(output).toContain('Classic')
    expect(output).toContain('━━● On')
    expect(output).toContain('←→ change')
    expect(output).toContain('Esc back')
    expect(output).not.toContain('Enter send')
    // The panel replaces the prompt, so the composer footer stays on the last row.
    expect(lines.at(-1)).toContain('/settings')
  })

  it.each([40, 80, 120, 150])('renders /sessions inside the large composer at %sx24', (width) => {
    const panel: ChatPanel = {
      id: 'sessions',
      kind: 'sessions',
      title: 'sessions (2)',
      searchable: true,
      filters: [
        { id: 'all', label: 'All' },
        { id: 'directory:workspace', label: 'workspace (current)' },
      ],
      rows: [
        {
          label: 'Current work',
          description: '',
          columns: ['workspace', '10', '10/07 10:30 EDT'],
          filter: 'directory:workspace',
          value: 'current',
          current: true,
        },
        {
          label: 'Earlier work',
          description: '',
          columns: ['workspace', '4', '10/06 09:15 GMT+5:45'],
          filter: 'directory:workspace',
          value: 'earlier',
        },
      ],
    }
    const output = sanitizeTerminalText(
      renderView({
        snapshot: snapshot({ panel }),
        panelRows: panel.rows,
        terminalWidth: width,
        terminalHeight: 24,
      })
    )
    const lines = output.split('\n')

    expect(output).toContain('Sessions')
    expect(output).toContain('Search sessions')
    expect(output).toContain(width >= 80 ? '› Current work' : '› Cu')
    expect(output).toContain('dir')
    if (width >= 80) {
      expect(output).toContain('Directories')
      expect(output).toMatch(width >= 120 ? /dir {2,}# messages {2,}time/u : /dir {2,}msgs {2,}time/u)
      expect(output).toMatch(/Current work {2,}\S/u)
      expect(output).toContain('10/07 10:30 EDT')
      expect(output).toContain('10/06 09:15 GMT+5:45')
    }
    if (width === 150) {
      const header = lines.find((line) => line.includes('# messages'))!
      const directory = header.indexOf('dir')
      const messages = header.indexOf('# messages')
      const time = header.indexOf('time')
      expect(messages - directory).toBeLessThanOrEqual(22)
      expect(time - messages).toBe(12)
      expect(header.length - time - 'time'.length).toBeGreaterThan(12)
    }
    expect(output).not.toContain('Viewing sessions')
    expect(lines.every((line) => stringWidth(line) <= width)).toBe(true)
    expect(lines.at(-1)).toContain('/settings')
  })

  it('does not render session table headings while sessions load', () => {
    const panel: ChatPanel = {
      id: 'sessions',
      kind: 'sessions',
      title: 'sessions',
      rows: [{ label: 'loading', description: 'Reading saved sessions' }],
      filters: [{ id: 'all', label: 'All' }],
      loading: true,
    }
    const output = sanitizeTerminalText(
      renderView({
        snapshot: snapshot({ panel }),
        panelRows: panel.rows,
        terminalWidth: 100,
        terminalHeight: 24,
      })
    )

    expect(output).toContain('Loading sessions')
    expect(output).not.toContain('# messages')
    expect(output).not.toContain('Search sessions')
  })

  it.each([40, 80, 150])('renders /tasks inside the shared composer at %s columns', (width) => {
    const panel: ChatPanel = {
      id: 'tasks',
      kind: 'tasks',
      title: 'Tasks (4)',
      searchable: true,
      waitForCompletion: false,
      rows: [
        {
          label: 'Review authentication',
          description: 'reviewer · task-1',
          value: 'task:task-1',
          badge: { text: 'running', tone: 'success' },
        },
        {
          label: 'Await approval',
          description: '',
          value: 'task:task-2',
          badge: { text: 'waiting', tone: 'warning' },
        },
        {
          label: 'Archive report',
          description: '',
          value: 'task:task-3',
          badge: { text: 'completed', tone: 'success' },
        },
        {
          label: 'Run deployment',
          description: '',
          value: 'task:task-4',
          badge: { text: 'failed', tone: 'danger' },
        },
      ],
    }
    const output = sanitizeTerminalText(
      renderView({
        snapshot: snapshot({ panel }),
        panelRows: panel.rows,
        terminalWidth: width,
        terminalHeight: 24,
      })
    )

    expect(output).toContain('Behavior')
    expect(output).toContain('Search tasks')
    expect(output).toContain('Off')
    expect(output).toContain('On')
    expect(output).toContain('███')
    expect(output).toContain(width < 53 ? 'Tab · / · ←→' : 'Enter open/toggle')
    expect(output).not.toContain('Viewing Tasks')
    if (width >= 80) {
      expect(output).toContain('Wait for completion')
      expect(output).toContain('Review authentication')
      expect(output).toContain('running')
      expect(output).toContain('waiting')
      expect(output).toContain('completed')
      expect(output).toContain('failed')
      expect(output.indexOf('running')).toBeLessThan(output.indexOf('waiting'))
      expect(output.indexOf('waiting')).toBeLessThan(output.indexOf('completed'))
      expect(output.indexOf('completed')).toBeLessThan(output.indexOf('failed'))
    }
    expect(output.split('\n').every((line) => stringWidth(line) <= width)).toBe(true)
  })

  it('renders an empty /tasks panel without a fake task row', () => {
    const panel: ChatPanel = {
      id: 'tasks',
      kind: 'tasks',
      title: 'Tasks (0)',
      rows: [],
      searchable: true,
      waitForCompletion: true,
    }
    const output = sanitizeTerminalText(
      renderView({
        snapshot: snapshot({ panel }),
        panelRows: panel.rows,
        terminalWidth: 150,
        terminalHeight: 24,
      })
    )

    expect(output).toContain('Behavior')
    expect(output).toContain('Search tasks')
    expect(output).toContain('Wait for completion')
    expect(output).toContain('No background tasks')
    expect(output).not.toMatch(/\bnone\b/u)
  })

  it('renders only matching task search results', () => {
    const panel: ChatPanel = {
      id: 'tasks',
      kind: 'tasks',
      title: 'Tasks (2)',
      searchable: true,
      waitForCompletion: false,
      rows: [
        {
          label: 'Review authentication',
          description: '',
          value: 'task:review',
          badge: { text: 'running', tone: 'success' },
        },
        {
          label: 'Run deployment',
          description: '',
          value: 'task:deploy',
          badge: { text: 'failed', tone: 'danger' },
        },
      ],
    }
    const output = sanitizeTerminalText(
      renderView({
        snapshot: snapshot({ panel }),
        panelRows: [panel.rows[1]!],
        panelQuery: 'deploy',
        modelPanelFocus: 'search',
        terminalWidth: 100,
        terminalHeight: 24,
      })
    )

    expect(output).toContain('deploy')
    expect(output).toContain('1 / 2')
    expect(output).toContain('Run deployment')
    expect(output).not.toContain('Review authentication')
  })

  it('scrolls /settings rows in a short terminal', () => {
    const rows = settingsRows(DEFAULT_CHAT_SETTINGS, 'Appearance')
    const height = composerPanelHeight(snapshot({ panel: settingsPanel('Appearance') }), 7)
    const capacity = panelRowCapacity('settings', height)
    expect(capacity).toBeLessThan(rows.length)
    const selected = rows.length - 1
    const output = sanitizeTerminalText(
      renderView({
        snapshot: snapshot({ panel: settingsPanel('Appearance') }),
        terminalWidth: 80,
        terminalHeight: 7,
        panelSelection: selected,
        panelViewportStart: revealPanelSelection(selected, 0, capacity, rows.length),
      })
    )

    expect(output).toContain('› Tool output')
    expect(output).not.toContain('Transcript spacing')
  })

  it('lays out /settings categories beside the settings of the selected category', () => {
    const terminalWidth = 100
    const output = sanitizeTerminalText(
      renderView({
        snapshot: snapshot({ panel: settingsPanel('Auto-Discovery') }),
        terminalWidth,
        terminalHeight: 30,
        settingsPanelFocus: 'categories',
      })
    )
    const lines = output.split('\n')

    for (const { label } of SETTINGS_CATEGORIES) {
      expect(output).toContain(label)
    }
    expect(lines.some((line) => line.includes('Auto-Discovery') && line.includes('›'))).toBe(true)
    const sectionTitle = lines.findIndex((line) => /││ Auto-Discovery/u.test(line))
    expect(sectionTitle).toBe(lines.findIndex((line) => line.includes('Settings')))
    expect(lines.findIndex((line) => line.includes('MCP')) - sectionTitle).toBeGreaterThan(1)
    expect(lines.find((line) => line.includes('MCP'))).toContain('●━━ Off')
    expect(lines.find((line) => line.includes('Agents (peer-to-peer'))).toContain('━━● On')
    expect(lines.filter((line) => line.includes('›'))).toHaveLength(1)
    expect(
      lines.findIndex((line) => line.includes('MCP')) - lines.findIndex((line) => line.includes('┌'))
    ).toBeGreaterThan(2)
    expect(output).toContain('Tab section')

    const agentOutput = sanitizeTerminalText(
      renderView({
        snapshot: snapshot({ panel: settingsPanel('Agent', DEFAULT_CHAT_SETTINGS, true) }),
        terminalWidth,
        terminalHeight: 30,
      })
    )
    expect(agentOutput).toContain('Tool result offloading threshold')
    expect(agentOutput).toContain('Providers & default agent')
    expect(agentOutput).toContain('Open setup')
    for (const option of ['Default', '1.5K', '2.5K', '5K', '10K']) {
      expect(agentOutput).toContain(option)
    }
    expect(agentOutput.split('\n').every((line) => stringWidth(line) <= terminalWidth)).toBe(true)

    const updatesOutput = sanitizeTerminalText(
      renderView({
        snapshot: snapshot({ panel: settingsPanel('Updates') }),
        terminalWidth,
        terminalHeight: 30,
      })
    )
    expect(updatesOutput).toContain('Startup update prompts')
    expect(updatesOutput).toContain('━━● On')

    const telemetryOutput = sanitizeTerminalText(
      renderView({
        snapshot: snapshot({ panel: settingsPanel('Telemetry') }),
        terminalWidth,
        terminalHeight: 30,
      })
    )
    expect(telemetryOutput).toContain('Send anonymous usage data')
    expect(telemetryOutput).toContain('━━● On')

    const models: ChatPanel = {
      id: 'models',
      kind: 'models',
      title: 'models',
      filters: [{ id: 'all', label: 'All' }],
      rows: [{ label: 'Model', description: 'bedrock/model', value: 'bedrock/model' }],
    }
    const modelLines = sanitizeTerminalText(
      renderView({
        snapshot: snapshot({ panel: models }),
        terminalWidth,
        terminalHeight: 30,
        panelRows: models.rows,
      })
    ).split('\n')
    const settingsBorder = lines.find((line) => /┌.*┐┌.*┐/u.test(line))!
    const expectedBounds = { left: settingsBorder.indexOf('┌'), right: settingsBorder.lastIndexOf('┐') }
    const effort: ChatPanel = {
      id: 'effort',
      kind: 'effort',
      title: 'effort',
      rows: [],
      slider: { label: 'Effort', options: [{ id: 'medium', label: 'Medium', active: true }] },
    }
    const context: ChatPanel = { id: 'context', kind: 'context', title: 'Context usage', rows: [] }
    for (const panelLines of [
      modelLines,
      ...[effort, context].map((panel) =>
        sanitizeTerminalText(
          renderView({
            snapshot: snapshot({ panel }),
            terminalWidth,
            terminalHeight: 30,
            panelRows: panel.rows,
          })
        ).split('\n')
      ),
    ]) {
      const border = panelLines.find((line) => line.includes('┌'))!
      expect({ left: border.indexOf('┌'), right: border.lastIndexOf('┐') }).toEqual(expectedBounds)
    }
  })

  it.each([
    ['Appearance', 'Theme, transcript, reasoning, tool output, and animations'],
    ['Agent', 'tool-result tokens'],
    ['Auto-Discovery', 'only explicit --mcp-config sources load'],
    ['Updates', 'asks before installing an available update'],
    ['Telemetry', 'one anonymous ping per launch'],
  ] as const)('uses the %s category title without its description header', (category, description) => {
    const output = sanitizeTerminalText(
      renderView({
        snapshot: snapshot({ panel: settingsPanel(category) }),
        terminalWidth: 100,
        terminalHeight: 30,
      })
    )

    expect(output.split(category)).toHaveLength(3)
    expect(output).not.toContain(description)
  })

  it.each([40, 80, 150])('keeps every /settings section in one centered %i-column frame', (terminalWidth) => {
    const sections = [
      ['Appearance', 'Theme'],
      ['Agent', 'Tool'],
      ['Auto-Discovery', 'MCP'],
      ['Updates', 'Startup'],
      ['Telemetry', 'Send'],
    ] as const
    let expectedBounds: { top: number; bottom: number; left: number; right: number } | undefined

    for (const [category, rowLabel] of sections) {
      const lines = sanitizeTerminalText(
        renderView({
          snapshot: snapshot({
            panel: settingsPanel(category, DEFAULT_CHAT_SETTINGS, category === 'Agent'),
          }),
          terminalWidth,
          terminalHeight: 24,
        })
      ).split('\n')
      const top = lines.findIndex((line) => /┌.*┐┌.*┐/u.test(line))
      const bottom = lines.findIndex((line, index) => index > top && /└.*┘└.*┘/u.test(line))
      const row = lines.findIndex((line) => line.includes(rowLabel))
      const border = lines[top]!
      const bounds = { top, bottom, left: border.indexOf('┌'), right: border.lastIndexOf('┐') }
      const title = lines.findIndex((line) => line.includes(`││ ${category}`))

      expect(lines.every((line) => stringWidth(line) <= terminalWidth)).toBe(true)
      expect(title - top).toBe(1)
      expect(row - title).toBe(2)
      expect(bottom - row).toBeGreaterThan(2)
      expectedBounds ??= bounds
      expect(bounds).toEqual(expectedBounds)
    }
  })

  it('keeps the active theme in view when the theme options overflow the row', () => {
    const output = sanitizeTerminalText(
      renderView({
        snapshot: snapshot({
          settings: { ...DEFAULT_CHAT_SETTINGS, frogTheme: 'scarlet' },
          panel: settingsPanel('Appearance', { ...DEFAULT_CHAT_SETTINGS, frogTheme: 'scarlet' }),
        }),
        terminalWidth: 80,
        terminalHeight: 24,
      })
    )
    const theme = output.split('\n').find((line) => line.includes('› Theme'))

    expect(theme).toContain('‹')
    expect(theme).toContain('Scarlet')
    expect(theme).not.toContain('Classic')
    expect(theme).not.toMatch(/Scarlet.*›/u)
  })

  it.each([40, 80, 150, 200])('renders searchable permission modes and tool grants at %i columns', (width) => {
    const rendered = renderView({
      snapshot: snapshot({
        panel: {
          id: 'permissions',
          kind: 'permissions',
          title: 'Permissions',
          searchable: true,
          slider: {
            label: 'Permission mode',
            options: [
              { id: 'ask', label: 'Ask' },
              { id: 'bypass', label: 'Bypass' },
              { id: 'custom', label: 'Custom', active: true },
            ],
          },
          rows: [
            {
              label: 'bash',
              description: 'Runs without a permission prompt.',
              value: 'permissions:tool:bash',
              section: 'Always allowed tools',
              control: { kind: 'toggle', checked: true },
            },
            {
              label: 'write',
              description: 'Uses Cedar policy and prompts when approval is required.',
              value: 'permissions:tool:write',
              section: 'Always allowed tools',
              control: { kind: 'toggle', checked: false },
            },
          ],
        },
      }),
      terminalWidth: width,
      terminalHeight: 30,
    })
    const output = sanitizeTerminalText(rendered)

    expect(output).toContain(width < 53 ? 'Mode' : 'Permissions')
    expect(output).toContain('Search tools')
    expect(output).toContain('Custom')
    if (width >= 80) {
      expect(output).toContain('Ask')
      expect(output).toContain('Bypass')
    }
    expect(output).toContain('███')
    const bash = output.split('\n').find((line) => line.includes('bash'))!
    const write = output.split('\n').find((line) => line.includes('write'))!
    expect(bash).toMatch(/bash {2,4}━━●/)
    expect(write).toMatch(/write {2,4}●━━/)
    expect(bash.indexOf('━━●')).toBe(write.indexOf('●━━'))
    expect(output).toContain(width < 53 ? 'Tab · / · ←→ · ↑↓ · Enter · Esc' : '/ search tools')
    expect(output).not.toContain('Viewing permissions')
    expect(output).not.toContain('Runs without a permission prompt.')
    expect(output).not.toContain('Uses Cedar policy')
    expect(output.split('\n').every((line) => stringWidth(line) <= width)).toBe(true)
  })

  it.each([
    [90, 30, false],
    [90, 16, false],
    [90, 30, true],
  ])(
    'renders /model loading and loaded states at one panel height above the resting command at %ix%i, party=%s',
    (terminalWidth, terminalHeight, party) => {
      const models: ChatPanel = {
        id: 'models',
        kind: 'models',
        title: 'models',
        rows: Array.from({ length: 12 }, (_, index) => ({
          label: `Model ${index}`,
          description: `bedrock/m${index}`,
          value: `bedrock/m${index}`,
        })),
        body: 'Current Model\nbedrock/current-model',
      }
      const render = (props: Partial<Parameters<typeof renderView>[0]> = {}): string[] =>
        renderView({ snapshot: snapshot(), terminalWidth, terminalHeight, party, ...props }).split('\n')
      const envelope = (
        lines: string[],
        bottomLabel?: string
      ): { top: number; bottom: number; left: number; right: number } => {
        const top = lines.findIndex((line) => line.includes('┌'))
        const bottom = bottomLabel
          ? lines.findIndex((line) => line.includes(bottomLabel))
          : lines.reduce((last, line, index) => (line.includes('┘') ? index : last), -1)
        expect(top).toBeGreaterThanOrEqual(0)
        expect(bottom).toBeGreaterThanOrEqual(top)
        return {
          top,
          bottom,
          left: lines[top]!.indexOf('┌'),
          right: lines[top]!.lastIndexOf('┐'),
        }
      }

      const command = envelope(render({ input: '/model', cursor: 6 }))
      const loading = envelope(
        render({
          snapshot: snapshot({ panel: { id: 'models', kind: 'models', title: 'models', rows: [], loading: true } }),
        })
      )
      const modelLines = render({ snapshot: snapshot({ panel: models }), panelRows: models.rows })
      const model = envelope(modelLines, 'Tab section')
      const commandHeight = command.bottom - command.top + 1

      expect(loading.bottom - loading.top + 1).toBe(model.bottom - model.top + 1)
      expect(model.bottom - model.top + 1).toBeGreaterThan(commandHeight)
      expect({ left: loading.left, right: loading.right }).toEqual({ left: command.left, right: command.right })
      expect({ left: model.left, right: model.right }).toEqual({ left: command.left, right: command.right })
    }
  )

  it('shows only a centered spinner in the composer while /model loads', () => {
    const lines = renderView({
      snapshot: snapshot({ panel: { id: 'models', kind: 'models', title: 'models', rows: [], loading: true } }),
      terminalWidth: 90,
      terminalHeight: 30,
    }).split('\n')
    const loading = lines.find((line) => line.includes('Loading models'))
    expect(loading).toBeDefined()
    const center = loading!.indexOf('Loading models') + 'Loading models'.length / 2
    expect(Math.abs(center - 45)).toBeLessThanOrEqual(3)
    expect(lines.join('\n')).not.toContain('Providers')
    expect(lines.join('\n')).not.toContain('Search models')
  })

  it('renders providers and models as focused 33/66 columns', () => {
    const current = snapshot({
      panel: {
        id: 'models',
        kind: 'models',
        title: 'models (2)',
        searchable: true,
        filters: [
          { id: 'all', label: 'All' },
          { id: 'bedrock', label: 'Bedrock' },
        ],
        rows: [
          {
            label: 'Current Model',
            description: 'bedrock/current-model',
            value: 'bedrock/current-model',
            filter: 'bedrock',
            badge: { text: 'current', tone: 'success' },
          },
          {
            label: 'Next Model',
            description: 'bedrock/next-model',
            value: 'bedrock/next-model',
            filter: 'bedrock',
          },
        ],
        body: 'Current Model\nbedrock/current-model',
      },
    })
    const render = (terminalWidth: number, modelPanelFocus: 'models' | 'search' = 'models'): string =>
      renderView({
        snapshot: current,
        terminalWidth,
        terminalHeight: 30,
        panelRows: current.panel!.rows,
        modelPanelFocus,
      })
    const wide = render(150)
    const wideLines = wide.split('\n')
    const header = wideLines.find((line) => line.includes('Providers'))
    expect(header).toContain('Search models')
    const modelRow = wideLines.findIndex((line) => line.includes('Current Model'))
    expect(wideLines[modelRow]).toContain('current')
    expect(wideLines[modelRow]).toContain('› Current Model')
    expect(wide).not.toContain('Effort')
    expect(wide).not.toContain('Web search')
    expect(wide).toContain('bedrock/current-model')
    expect(wide).toContain('Ctrl+Y copy ID')

    const topBorder = wideLines.find((line) => line.match(/┌.*┐┌.*┐/u))
    expect(topBorder).toBeDefined()
    const firstColumnStart = topBorder!.indexOf('┌')
    const secondColumnStart = topBorder!.indexOf('┌', firstColumnStart + 1)
    const columnsWidth = topBorder!.lastIndexOf('┐') - firstColumnStart + 1
    expect(secondColumnStart - firstColumnStart).toBe(Math.floor(columnsWidth / 3))

    const narrow = render(60)
    expect(narrow).toContain('Providers')
    expect(narrow).toContain('Search models')

    const searching = render(150, 'search')
    expect(searching).not.toContain('Search models')
    expect(searching).toContain('/ ▌')
  })

  it.each([40, 80, 150])(
    'renders /voice in the shared composer with control and speaker sections at %s columns',
    (width) => {
      const panel: ChatPanel = {
        id: 'voice',
        kind: 'voice',
        title: 'Voice',
        rows: [
          {
            label: 'Voice',
            description: 'listening',
            value: 'voice:enabled',
            control: {
              kind: 'segmented',
              options: [
                { label: 'Off', value: 'off' },
                { label: 'On', value: 'on', active: true },
              ],
            },
          },
          {
            label: 'spoken replies',
            description: 'on',
            value: 'voice:spokenReplies',
            section: 'Audio',
            control: { kind: 'toggle', checked: true },
          },
          {
            label: 'provider',
            description: 'Nova',
            value: 'voice:provider',
            section: 'Voice',
            control: {
              kind: 'segmented',
              options: [
                { label: 'Nova', value: 'bedrock', active: true },
                { label: 'OpenAI', value: 'openai' },
              ],
            },
          },
          {
            label: 'Nova 2.5 Sonic',
            description: 'amazon.nova-2-5-sonic',
            value: 'voice:model=amazon.nova-2-5-sonic',
            section: 'Model',
            current: true,
            badge: { text: 'current', tone: 'success' },
          },
          {
            label: 'English (US)',
            description: 'tiffany / matthew',
            value: 'voice:voice',
            section: 'Voice',
            control: {
              kind: 'segmented',
              options: [
                { label: 'tiffany', value: 'tiffany', active: true },
                { label: 'matthew', value: 'matthew' },
              ],
            },
          },
          {
            label: 'French',
            description: 'ambre / florian',
            value: 'voice:voice',
            section: 'Voice',
            control: {
              kind: 'segmented',
              options: [
                { label: 'ambre', value: 'ambre' },
                { label: 'florian', value: 'florian' },
              ],
            },
          },
          {
            label: 'end of turn',
            description: 'patient',
            value: 'voice:endpointing',
            section: 'Listening',
            control: {
              kind: 'segmented',
              options: [
                { label: 'Fast', value: 'HIGH' },
                { label: 'Balanced', value: 'MEDIUM' },
                { label: 'Patient', value: 'LOW', active: true },
              ],
            },
          },
        ],
      }
      const output = sanitizeTerminalText(
        renderView({
          snapshot: snapshot({ panel }),
          panelRows: panel.rows,
          terminalWidth: width,
          terminalHeight: 24,
        })
      )
      expect(output).toContain('Voice')
      expect(output).toContain('Speaker')
      expect(output).toContain('Off')
      expect(output).toContain('On')
      expect(output).toContain(width < 64 ? 'US' : 'English')
      expect(output).toContain('tiffany')
      expect(output).toContain('Nova')
      expect(output).toContain('OpenAI')
      expect(output).toContain('Patient')
      expect(output).toContain('━━● On')
      if (width >= 80) {
        expect(output).toContain('Fast')
        expect(output).toContain('Balanced')
      } else {
        expect(output).toContain('‹')
      }
      expect(output).toContain('Space mute')
      if (width >= 80) {
        expect(output).toContain('Nova 2.5 Sonic')
      }
      if (width >= 150) {
        expect(output).toContain('Nova 2.5 Sonic amazon.nova-2-5-sonic')
        expect(output).not.toContain('current')
        expect(output).toMatch(/Fast.*Balanced.*Patient/u)
        expect(output).toContain('Provider')
      }
      expect(output).not.toContain('Viewing Voice')
      expect(output.split('\n').every((line) => stringWidth(line) <= width)).toBe(true)
    }
  )

  it('highlights hovered and pressed controls without purple flashes', () => {
    const kinds = ['models', 'settings', 'agents', 'export', 'sessions', 'voice'] as const
    const frames = kinds.flatMap((kind) =>
      ['idle', 'hover', 'press'].map((interaction) => ({
        snapshot: snapshot({
          panel: {
            id: kind,
            kind,
            title: kind,
            rows: [
              {
                label: 'Choose this',
                description: '',
                value: kind === 'voice' ? 'voice:enabled' : 'choice',
                ...(kind === 'settings' || kind === 'voice'
                  ? {
                      control: {
                        kind: 'segmented' as const,
                        options: [
                          { label: 'Option A', value: 'a', active: true },
                          { label: 'Option B', value: 'b' },
                        ],
                      },
                    }
                  : {}),
              },
              { label: 'Other choice', description: '', value: 'other' },
            ],
          },
        }),
        panelSelection: 1,
        terminalWidth: 100,
        terminalHeight: 30,
        ...(interaction === 'hover' ? { hoveredPanelRow: 0 } : {}),
        ...(interaction === 'hover' && kind === 'settings' ? { hoveredPanelControl: panelControlTarget(0, 'b') } : {}),
        ...(interaction === 'press' ? { pressedPanelRow: 0 } : {}),
        ...(interaction === 'press' && kind === 'settings' ? { pressedPanelControl: panelControlTarget(0, 'b') } : {}),
      }))
    )
    const level = chalk.level
    let rendered: string[]
    try {
      chalk.level = 3
      rendered = frames.map((props) => renderView(props))
    } finally {
      chalk.level = level
    }
    for (const [index, kind] of kinds.entries()) {
      const idleFrame = rendered[index * 3]!
      expect(idleFrame, kind).not.toContain('\u001b[38;2;192;132;252m')
      const hoverFrame = rendered[index * 3 + 1]!
      expect(hoverFrame, kind).not.toBe(idleFrame)
      expect(hoverFrame, kind).not.toContain('\u001b[38;2;192;132;252m')
      const pressFrame = rendered[index * 3 + 2]!
      expect(pressFrame, kind).not.toBe(idleFrame)
      expect(pressFrame, kind).not.toContain('\u001b[38;2;192;132;252m')
      expect(pressFrame, kind).not.toContain('\u001b[48;2;192;132;252m')
      if (kind === 'settings') {
        const highlighted = hoverFrame.split('\u001b[48;2;89;91;92m').slice(1)
        expect(highlighted).toHaveLength(1)
        const button = sanitizeTerminalText(highlighted[0]!.split('\u001b[49m')[0]!)
        expect(button).toContain('Option B')
        expect(button).not.toContain('Option A')
        expect(button).not.toContain('Choose this')
      } else if (kind === 'agents' || kind === 'voice') {
        for (const frame of [idleFrame, hoverFrame, pressFrame]) {
          // The expanded composer masks the transcript with the terminal canvas.
          const panelFrame = frame.slice(frame.indexOf('┌')).replaceAll('\u001b[48;2;16;18;19m', '')
          expect(panelFrame, kind).not.toMatch(/\[(?:48;|4[0-7]m|10[0-7]m)/u)
        }
      } else {
        expect(
          hoverFrame.split('\n').find((line) => line.includes('Choose this')),
          kind
        ).toContain('\u001b[48;2;48;50;51m')
      }
      if (kind !== 'voice') expect(sanitizeTerminalText(pressFrame), kind).toContain('Choose this')
    }
  }, 15_000)

  it.each([80, 120])('renders compact, full-width errors above the footer at %i columns', (width) => {
    const messages = [
      'Model bedrock/test does not support reasoning effort.',
      'Failed to create agent with model bedrock/next-model: AWS credentials are not configured.',
    ]
    for (const message of messages) {
      const level = chalk.level
      let error: string
      try {
        chalk.level = 3
        error = renderView(
          {
            snapshot: snapshot({
              panel: {
                id: 'restart-error',
                kind: 'error',
                title: 'model change failed',
                rows: [{ label: 'bedrock/next-model', description: message, tone: 'danger' }],
              },
            }),
            terminalWidth: width,
            terminalHeight: 24,
          },
          { columns: width }
        )
      } finally {
        chalk.level = level
      }

      const rows = sanitizeTerminalText(error).split('\n')
      const top = rows.findIndex((line) => line.includes('┌'))
      const bottom = rows.findIndex((line) => line.includes('└'))
      const messageText = rows
        .slice(top + 1, bottom)
        .map((line) => line.slice(line.indexOf('│') + 1, line.lastIndexOf('│')))
        .join('')
      expect(messageText.replace(/\s/gu, '')).toBe(message.replace(/\s/gu, ''))
      expect(top).toBeGreaterThan(24 / 2)
      expect(bottom - top + 1).toBeLessThanOrEqual(4)
      expect(stringWidth(rows[top]!.trim())).toBe(width - 2)
      expect(rows[bottom + 1]?.trim()).toBe('Esc close')
      expect(bottom).toBe(rows.findIndex((line) => line.includes('/settings')) - 3)
      expect(rows.filter((line) => line.includes('Esc close'))).toHaveLength(1)
      expect(rows).toHaveLength(24)
      expect(rows.every((line) => stringWidth(line) <= width)).toBe(true)
      expect(error.split('\n').find((line) => line.includes('┌'))).toContain('\u001b[38;2;0;204;96m')
      expect(error.split('\n').find((line) => line.includes(message.split(' ')[0]!))).toContain(
        '\u001b[38;2;255;114;124m'
      )
      expect(error.slice(error.indexOf('┌'))).not.toContain('\u001b[48;2;24;26;27m')
      expect(error).not.toContain('model change failed')
      expect(error).not.toContain('Viewing')
      expect(error).not.toContain('Esc to dismiss')
    }
  })
})

describe('voice input', () => {
  it('renders microphone level and the tap-Space mute shortcut while voice is active', () => {
    const output = renderView({
      snapshot: snapshot({
        voice: {
          status: 'listening',
          muted: false,
          inputLevel: 0.5,
          inputLevelDb: -30,
          spokenReplies: false,
          endpointingSensitivity: 'LOW',
          provider: 'bedrock',
          voice: 'tiffany',
          model: 'test-sonic',
        },
      }),
      terminalWidth: 100,
      terminalHeight: 30,
    })

    expect(output).toContain('Voice ▮▮▮▮▮▮▮······· · Tap Space to mute')
    expect(output).not.toContain('-30 dB')
    expect(output).not.toContain('test-sonic')
    expect(output).not.toContain('Voice listening')
  })

  it('shows the tap-Space unmute shortcut while voice is muted', () => {
    const output = renderView({
      snapshot: snapshot({
        voice: {
          status: 'muted',
          muted: true,
          inputLevel: 0,
          inputLevelDb: -60,
          spokenReplies: false,
          endpointingSensitivity: 'LOW',
          provider: 'bedrock',
          voice: 'tiffany',
          model: 'amazon.nova-2-5-sonic',
        },
      }),
      terminalWidth: 100,
      terminalHeight: 30,
    })

    expect(output).toContain('Voice muted')
    expect(output).toContain('Tap Space to unmute')
  })
})

describe('panel helpers', () => {
  it('overlays a selection without changing the rendered text', () => {
    const props = {
      snapshot: snapshot({ context: { projectedTokens: 100, contextWindow: 1_000 } }),
      terminalWidth: 80,
      terminalHeight: 16,
    }
    const output = sanitizeTerminalText(renderView(props, { columns: 80 }))
    const lines = output.split('\n')
    const target = lines.findIndex((line) => line.includes('bedrock/test'))
    const column = lines[target]!.indexOf('bedrock/test')
    const selection = selectScreenText(
      lines,
      { column: column + 1, row: target + 1 },
      { column: column + 7, row: target + 1 }
    )
    expect(selection).toBeDefined()

    const highlighted = sanitizeTerminalText(renderView({ ...props, selection: selection!.segments }, { columns: 80 }))

    expect(highlighted).toBe(output)
  })
})

function settingsPanel(
  category: SettingsCategory,
  settings = DEFAULT_CHAT_SETTINGS,
  includeSetupAction = false
): ChatPanel {
  return {
    id: `settings-${category}`,
    kind: 'settings',
    title: category,
    rows: settingsRows(settings, category, includeSetupAction),
    filters: settingsCategoryFilters(),
    settingsCategory: category,
  }
}

function renderView(
  props: Omit<Parameters<typeof ChatView>[0], 'input' | 'cursor'> & { input?: string; cursor?: number },
  options?: Parameters<typeof renderToString>[1]
): string {
  return renderToString(createElement(ChatView, { input: '', cursor: 0, ...props }), options)
}
