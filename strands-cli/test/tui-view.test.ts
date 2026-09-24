import chalk from 'chalk'
import { createElement } from 'react'
import { renderToString } from 'ink'
import stringWidth from 'string-width'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { snapshot } from './fixtures/chat-snapshot.js'

import { ChatView } from '../src/tui/view/chat-view.js'
import { Markdown } from '../src/tui/view/markdown.js'
import { panelControlTarget, panelRowCapacity, revealPanelSelection } from '../src/tui/view/interaction.js'
import { maxPermissionScroll, permissionLines } from '../src/tui/view/presentation.js'
import { DEFAULT_CHAT_SETTINGS, type ChatPanel } from '../src/tui/chat/controller.js'
import { formatPermissionPanelBody, settingsRows } from '../src/tui/chat/panels.js'
import { SETTINGS_CATEGORIES } from '../src/tui/settings.js'
import { sanitizeTerminalText } from '../src/tui/terminal/sanitize.js'
import { selectScreenText } from '../src/tui/terminal/mouse-input.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('ChatView', () => {
  it.each([
    [80, 40],
    [40, 24],
  ])('keeps long approval input and choices reachable at %ix%i', (width, height) => {
    const command = `BEGIN_INPUT_${'界👩‍💻x'.repeat(500)}\nEND_INPUT`
    const panel: ChatPanel = {
      id: 'long-approval',
      kind: 'permission',
      title: 'Tool approval',
      body: formatPermissionPanelBody({ id: 'request', toolName: 'shell', input: { command }, options: [] }),
      rows: [
        { label: 'Allow once', description: 'Run this call', value: 'allow' },
        { label: 'Always allow tool', description: 'Save this choice', value: 'always' },
        { label: 'Deny', description: 'Block this call', value: 'deny' },
      ],
    }
    expect(panel.body).toContain(JSON.stringify(command))
    const contentWidth = Math.min(68, width - 4) - 6
    const lines = permissionLines(panel, contentWidth)
    expect(lines.every((line) => stringWidth(line.text) <= contentWidth)).toBe(true)
    expect(lines.map((line) => line.text).join('')).toContain(JSON.stringify(command))
    const render = (detailScroll: number): string =>
      renderView({
        snapshot: snapshot({ panel }),
        terminalWidth: width,
        terminalHeight: height,
        detailScroll,
      })
    const first = render(0)
    const last = render(maxPermissionScroll(panel, height, width))
    expect(first).toContain('BEGIN_INPUT')
    expect(last).toContain('END_INPUT')
    for (const output of [first, last]) {
      expect(output).toContain('Tool approval')
      expect(output).toContain('Allow once')
      expect(output).toContain('Deny')
      expect(output.split('\n').length).toBeLessThanOrEqual(height)
    }
  })

  it('presents permission diffs before the full tool input', () => {
    const lines = permissionLines(
      {
        id: 'write-approval',
        kind: 'permission',
        title: 'Write approval',
        body: 'Tool: write\nInputs:\npath: example.ts',
        rows: [],
        diff: {
          path: 'example.ts',
          lines: [{ kind: 'add', text: 'const ready = true', newLine: 1 }],
        },
      },
      80
    ).map((line) => line.text)

    expect(lines.indexOf('example.ts')).toBeLessThan(lines.indexOf('Tool: write'))
    expect(lines).toContain('        1 +const ready = true')
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

  it('renders resource panels after the transcript and immediately above the composer', () => {
    const output = renderView({
      snapshot: snapshot({
        completedTurns: [
          {
            id: 'turn-1',
            prompt: 'hello',
            agentName: 'Strands harness',
            entries: [{ id: 'turn-1:1', type: 'assistant', text: '**answer**' }],
            status: 'complete',
          },
        ],
        panel: {
          id: 'panel-1',
          kind: 'mcp',
          title: 'MCP servers (1 configured)',
          rows: [{ label: 'Docs', description: 'Local MCP server' }],
        },
      }),
      terminalWidth: 100,
      terminalHeight: 40,
    })

    expect(output).toContain('answer')
    expect(output.indexOf('MCP servers (1 configured)')).toBeLessThan(
      output.indexOf('Viewing MCP servers (1 configured)')
    )
    expect(output).not.toContain('┌')
    expect(output).not.toContain('┘')
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

    expect(output.split('\n').find((line) => line.includes('/context'))).toMatch(/\/context\s+Show context usage/)
    expect(output).toContain('/help')
  })

  it('renders slash-command signatures and completions while editing arguments', () => {
    const output = renderView({
      snapshot: snapshot(),
      input: '/permissions ',
      cursor: 13,
      terminalWidth: 100,
      terminalHeight: 40,
    })

    expect(output).toContain('/permissions [default|bypass]')
    expect(output).toContain('Allow tool calls without prompting')
  })

  it('renders background-agent detail as a structured transcript and expands tool-result tabs', () => {
    const output = renderView({
      snapshot: snapshot({
        panel: {
          id: 'task-detail',
          kind: 'detail',
          title: 'agent reviewer | completed',
          rows: [
            { label: 'task id', description: 'task-1' },
            { label: 'status', description: 'completed' },
          ],
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
        },
      }),
      terminalWidth: 100,
      terminalHeight: 40,
    })

    expect(output).toContain('TASK')
    expect(output).toContain('◇ Reasoning')
    expect(output).toContain('✓ Read')
    expect(output).toContain('│ 1    const authenticated = true')
    expect(output).toContain('◆ reviewer')
    expect(output).not.toContain('\t')
  })

  it('renders the wordmark and keeps metadata in the footer', () => {
    const output = renderView({
      snapshot: snapshot(),
      terminalWidth: 100,
      terminalHeight: 40,
    })
    const plainOutput = sanitizeTerminalText(output)

    expect(output).toContain('[48;2;129;255;157m ')
    expect(output).toMatch(/[▗▖▄▝▐▞▟▘▚▌▙▀▜▛]/u)
    expect(plainOutput.match(/bedrock\/test/g)).toHaveLength(1)
    expect(output).toContain('/work')
  })

  it('renders the composer with an integrated runtime strip and navigation footer', () => {
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

    expect(output.indexOf('answer')).toBeLessThan(output.indexOf('Message Strands harness'))
    expect(output.indexOf('Message Strands harness')).toBeLessThan(output.lastIndexOf('bedrock/test'))
    expect(output.split('\n').some((line) => line.trim() === 'hello')).toBe(true)
    expect(output).toContain('context ░░░░░░░░░░ 0%')
    expect(output).toContain('Ctrl+J')
    const rows = output.trimEnd().split('\n')
    expect(rows.at(-3)).toContain('context')
    expect(rows.at(-2)?.trim()).toBe('')
    expect(rows.at(-1)).toContain('Enter send')
    expect(rows.at(-1)).toContain('/help')
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
    expect(output.indexOf('Background task queued (read)')).toBeLessThan(output.indexOf('Message Strands harness'))
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

    expect(output).toContain('╔')
    expect(output.indexOf('╔')).toBeLessThan(output.indexOf('hello'))
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
        synchronousTranscriptLayout: true,
      })
    )
    expect(continuedOutput).not.toContain('╔')
  })

  it.each([
    [3_497, 1_000_000, 'context █░░░░░░░░░ 0.3%'],
    [125_000, 100_000, 'context ██████████ 125%'],
  ])('shows precise context usage for %i of %i tokens', (projectedTokens, contextWindow, expected) => {
    const output = renderView({
      snapshot: snapshot({
        context: { projectedTokens, contextWindow },
      }),
      terminalWidth: 100,
      terminalHeight: 40,
    })

    expect(output).toContain(expected)
  })

  it('hides the context meter when the context window is unknown', () => {
    const output = renderView({
      snapshot: snapshot({ context: { projectedTokens: 12_000 } }),
      terminalWidth: 100,
      terminalHeight: 40,
    })

    expect(output).toContain('bedrock/test')
    expect(output).not.toContain('context ')
    expect(output).not.toContain('░')
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
    expect(output).not.toContain('░')
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
    expect(output.trimEnd().split('\n').at(-3)).toContain('5.7%')
    expect(output.trimEnd().split('\n').at(-1)).toContain('/help')
    expect(output).toMatch(/Last turn\s+71,289 tokens/)
    expect(output).toMatch(/Input\s+71,077/)
    expect(output).toMatch(/Output\s+212/)
    expect(output).toMatch(/Cache read\s+0/)
    expect(output).toMatch(/Cache write\s+59,675/)
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
    expect(output).not.toContain('Delegate Review authentication.')
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
    expect(output).not.toContain('Delegate Review authentication.')
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

    expect(output).toContain('Run npm test · running')
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
          body: 'Tool: write\nInputs:\npath: /Users/test/Desktop/storage/test.txt\ncontent: The treasure is buried.',
          rows: [
            { label: 'Allow once', description: 'Run only this call', value: 'allow' },
            {
              label: 'Always allow tool',
              description: 'Save this tool to config.json',
              value: 'always',
            },
            { label: 'Deny', description: 'Block this call', value: 'deny', tone: 'danger' },
          ],
        },
      }),
      terminalWidth: 100,
      terminalHeight: 30,
    })

    expect(output).toContain('Tool: write')
    expect(output).toContain('Inputs')
    expect(output).toContain('path: /Users/test/Desktop/storage/test.txt')
    expect(output).toContain('content: The treasure is buried.')
    expect(output).toContain('Permission required')
    expect(output).not.toContain('Viewing Strands harness requests permission')
  })

  it('keeps interruption, steering, and queued prompts visible while the agent streams output', () => {
    const output = renderView({
      snapshot: snapshot({
        activeTurn: {
          id: 'turn-1',
          prompt: 'Inspect the repository',
          agentName: 'Strands harness',
          entries: [{ id: 'turn-1:1', type: 'assistant', text: 'I am inspecting the files.' }],
          status: 'running',
        },
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

    expect(output).toContain('I am inspecting the files.')
    expect(output).toContain('* Working (esc to interrupt)')
    expect(output).toContain('Steer toward the failing test')
    expect(output).toContain('Queued 1/2')
    expect(output).toContain('Run the focused tests')
    expect(output).toContain('Edit')
    expect(output).toContain('Steer')
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
    expect(output).toContain('Steer')
  })

  it('renders autonomous background continuations without a fake user message', () => {
    const output = renderView({
      snapshot: snapshot({
        completedTurns: [
          {
            id: 'turn-1',
            prompt: '',
            source: 'background',
            agentName: 'Strands harness',
            entries: [{ id: 'turn-1:1', type: 'assistant', text: 'The review completed successfully.' }],
            status: 'complete',
          },
        ],
      }),
      terminalWidth: 100,
      terminalHeight: 30,
    })

    expect(output).toContain('Strands harness')
    expect(output).toContain('The review completed successfully.')
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

  it('renders the agents panel as a grid of chat targets', () => {
    const output = renderView({
      snapshot: snapshot({
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
          ],
        },
      }),
      terminalWidth: 100,
      terminalHeight: 30,
    })

    expect(output).toContain('Agents')
    expect(output).toContain('1/2')
    expect(output).toContain('CURRENT')
    expect(output).toContain('Primary agent')
    expect(output).toContain('idle')
    expect(output).toContain('Reviewer')
    expect(output).toContain('CHAT')
    expect(output).toContain('Fork of Research')
    expect(output).toContain('working')
  })

  it('renders compaction progress inside the composer instead of as a panel', () => {
    const output = renderView({
      snapshot: snapshot({ composerStatus: 'Compacting context...' }),
      terminalWidth: 100,
      terminalHeight: 30,
    })

    expect(output).toContain('| Compacting context...')
    expect(output).not.toContain('Message Strands harness')
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

  it.each([40, 80])('keeps settings controls and footer visible at %sx24 for first and last selections', (width) => {
    const config = { ...DEFAULT_CHAT_SETTINGS, colorMode: 'light' as const }
    const rows = settingsRows(config, false, 'Appearance')
    const capacity = panelRowCapacity('settings', 24, width, rows)
    for (const selected of [0, rows.length - 1]) {
      const output = sanitizeTerminalText(
        renderView({
          snapshot: snapshot({
            settings: config,
            panel: {
              id: 'settings',
              kind: 'settings',
              title: 'Appearance',
              rows,
              settingsCategory: 'Appearance',
              settingsCategories: SETTINGS_CATEGORIES,
            },
          }),
          terminalWidth: width,
          terminalHeight: 24,
          panelSelection: selected,
          panelViewportStart: revealPanelSelection(selected, 0, capacity, rows.length),
        })
      )
      const lines = output.split('\n')
      expect(lines.length).toBeLessThanOrEqual(24)
      expect(output).toContain(rows[selected]!.label)
      expect(output).toContain(selected === 0 ? 'Dark' : 'Full')
      expect(output).toContain('←→ change')
      expect(output).toContain('Esc back')
      expect(lines.findIndex((line) => line.includes('Esc back'))).toBeLessThan(
        lines.findIndex((line) => line.includes('/help'))
      )
    }
  })

  it('renders settings with a plain title and labeled controls', () => {
    const rendered = renderView({
      snapshot: snapshot({
        settings: { ...DEFAULT_CHAT_SETTINGS, showReasoning: false },
        panel: {
          id: 'settings',
          kind: 'settings',
          title: 'Settings',
          rows: [
            {
              label: 'transcript spacing',
              description: 'comfortable',
              value: 'transcriptSpacing',
              section: 'Appearance',
              control: {
                kind: 'segmented',
                options: [
                  { label: 'Compact', value: 'compact' },
                  { label: 'Comfortable', value: 'comfortable', active: true },
                ],
              },
            },
            {
              label: 'animations',
              description: 'on',
              value: 'animations',
              section: 'Appearance',
              control: { kind: 'toggle', checked: true },
            },
            {
              label: 'reasoning',
              description: 'hidden',
              value: 'showReasoning',
              section: 'Appearance',
              control: { kind: 'toggle', checked: false },
            },
          ],
        },
      }),
      terminalWidth: 100,
      terminalHeight: 30,
    })
    const output = sanitizeTerminalText(rendered)

    expect(output).toContain('Appearance')
    expect(output).toContain('transcript spacing')
    expect(output).toContain('Compact')
    expect(output).toContain('Comfortable')
    expect(output).toContain('━━●')
    expect(output).toContain('●━━')
    expect(output).toContain('Settings')
    expect(output).toContain('On')
    expect(output).toContain('Off')
  })

  it('renders permission tool grants as toggles', () => {
    const rendered = renderView({
      snapshot: snapshot({
        panel: {
          id: 'permissions',
          kind: 'permissions',
          title: 'permissions',
          body: 'WARNING: Permission checks are bypassed.',
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
      terminalWidth: 100,
      terminalHeight: 30,
    })
    const output = sanitizeTerminalText(rendered)

    expect(output).toContain('WARNING')
    expect(output).toContain('bash')
    expect(output).toContain('write')
    expect(output).toContain('━━●')
    expect(output).toContain('●━━')
  })

  it('uses provider nodes on both wide and narrow terminals', () => {
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
        slider: {
          label: 'Effort',
          options: [
            { id: 'off', label: 'Model default' },
            { id: 'medium', label: 'Medium' },
            { id: 'xhigh', label: 'High', active: true },
            { id: 'max', label: 'Max' },
          ],
        },
        rows: [
          {
            label: 'Claude Opus',
            description: 'bedrock/anthropic.claude-opus',
            value: 'bedrock/anthropic.claude-opus',
            filter: 'bedrock',
            badge: { text: 'current', tone: 'success' },
          },
          {
            label: 'Claude Sonnet',
            description: 'bedrock/anthropic.claude-sonnet',
            value: 'bedrock/anthropic.claude-sonnet',
            filter: 'bedrock',
          },
        ],
        body: 'Claude Opus\nbedrock/anthropic.claude-opus',
      },
    })
    const render = (terminalWidth: number): string =>
      renderView({
        snapshot: current,
        terminalWidth,
        terminalHeight: 30,
        panelRows: current.panel!.rows,
      })
    const wide = render(150)
    const narrow = render(60)

    expect(wide).toContain('Provider')
    expect(narrow).not.toContain('Provider')
    expect(narrow.split('\n').some((line) => line.includes('◆ All') && line.includes('· Bedrock'))).toBe(true)
    expect(wide).toContain('Model details')
    expect(wide.split('\n').find((line) => line.includes('Claude Opus'))).toContain('Claude Opus')
    expect(wide).toContain('Model ID')
    expect(wide).toContain('bedrock/anthropic.claude-opus')
    expect(wide).toContain('Copy model ID')
    expect(wide).toContain('High')
    expect(wide).not.toContain('Medium')
    expect(wide).not.toContain('Model default')
    expect(wide).not.toContain('Max')
    expect(wide.match(/Effort/g)).toHaveLength(1)
    expect(wide).not.toContain('bedrock/anthropic.claude-sonnet')
  })

  it('highlights hovered controls or rows and reserves purple for presses across panel renderers', () => {
    const kinds: ChatPanel['kind'][] = ['models', 'settings', 'agents', 'export', 'sessions', 'voice']
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
                value: kind === 'voice' ? 'voice:start' : 'choice',
                ...(kind === 'settings'
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
      expect(rendered[index * 3], kind).not.toContain('\u001b[38;2;192;132;252m')
      const hoverFrame = rendered[index * 3 + 1]!
      expect(hoverFrame, kind).not.toContain('\u001b[38;2;192;132;252m')
      if (kind === 'settings') {
        const highlighted = hoverFrame.split('\u001b[48;2;89;91;92m').slice(1)
        expect(highlighted).toHaveLength(1)
        const button = sanitizeTerminalText(highlighted[0]!.split('\u001b[49m')[0]!)
        expect(button).toContain('Option B')
        expect(button).not.toContain('Option A')
        expect(button).not.toContain('Choose this')
      } else {
        expect(
          hoverFrame.split('\n').find((line) => line.includes('Choose this')),
          kind
        ).toContain('\u001b[48;2;48;50;51m')
      }
      const purpleText = rendered[index * 3 + 2]!.split('\u001b[38;2;192;132;252m')
        .slice(1)
        .map((segment) => sanitizeTerminalText(segment.split('\u001b[39m')[0]!))
      expect(
        purpleText.some((text) => text.includes('Choose this')),
        kind
      ).toBe(true)
      if (kind === 'settings') {
        expect(purpleText.join('')).toContain('Option B')
        expect(purpleText.join('')).not.toContain('Option A')
      }
    }
  }, 15_000)

  it('wraps error details without truncating actionable context', () => {
    const error = renderView({
      snapshot: snapshot({
        panel: {
          id: 'restart-error',
          kind: 'error',
          title: 'model change failed',
          rows: [
            {
              label: 'bedrock/anthropic.claude-sonnet-5',
              description:
                'Failed to create agent with model bedrock/anthropic.claude-sonnet-5: AWS credentials are not configured.',
              tone: 'danger',
            },
          ],
        },
      }),
      terminalWidth: 100,
      terminalHeight: 30,
    })

    expect(error.replace(/\s+/gu, ' ')).toContain('AWS credentials are not configured.')
    expect(error).not.toContain('model change failed')
    expect(error).not.toContain('◆')
    expect(error).toContain('Esc to dismiss')
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
          voice: 'tiffany',
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
    const target = lines.findIndex((line) => line.includes('context █'))
    const column = lines[target]!.indexOf('context █')
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

function renderView(
  props: Omit<Parameters<typeof ChatView>[0], 'input' | 'cursor'> & { input?: string; cursor?: number },
  options?: Parameters<typeof renderToString>[1]
): string {
  return renderToString(createElement(ChatView, { input: '', cursor: 0, ...props }), options)
}
