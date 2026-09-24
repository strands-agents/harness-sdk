import { createElement } from 'react'
import { renderToString } from 'ink'
import { describe, expect, it, vi } from 'vitest'

import { ChatController, type ChatBackend, type ChatPanelRow } from '../src/tui/chat/controller.js'
import { commandAssistance } from '../src/tui/chat/commands.js'
import { ChatView } from '../src/tui/view/chat-view.js'

function backend(overrides: Partial<ChatBackend> = {}): ChatBackend {
  return {
    id: 'test',
    name: 'My agent',
    protocol: 'strands',
    stream: async function* () {
      yield* []
      return { stopReason: 'endTurn' }
    },
    cancel() {},
    ...overrides,
  }
}

function row(controller: ChatController, label: string): ChatPanelRow {
  const result = controller.getSnapshot().panel?.rows.find((candidate) => candidate.label === label)
  expect(result, `Missing row: ${label}`).toBeDefined()
  return result!
}

describe('help', () => {
  it('opens slash help and autocomplete without running an agent turn', async () => {
    const stream = vi.fn()
    const controller = new ChatController(backend({ stream }))
    expect(commandAssistance('/he')?.completions ?? []).toEqual([expect.objectContaining({ name: 'help' })])
    expect(commandAssistance('/help ')?.signature).toBe('/help')
    expect(controller.actionableCommandToken('/help')).toBe('/help')
    await controller.submit('/help')
    const panel = controller.getSnapshot().panel
    expect(panel).toMatchObject({ kind: 'help', title: 'Help', searchable: true })
    expect([...new Set(panel!.rows.map((candidate) => candidate.section))]).toEqual([
      'Controls',
      'Commands',
      'Available tools',
    ])
    expect(stream).not.toHaveBeenCalled()
    await controller.dispose()
  })

  it('opens complete selectable tool details and returns to help', async () => {
    const description = 'First line\n' + 'Long tool documentation. '.repeat(30)
    const controller = new ChatController(
      backend({
        info: () => ({ tools: [{ name: 'custom\u001b[31m_tool', description, source: 'MCP: docs' }] }),
      })
    )
    await controller.submit('/help')
    await controller.activatePanelRow(row(controller, 'custom_tool'))
    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'detail',
      title: 'custom_tool',
      body: `${description}\nSource: MCP: docs`,
    })
    expect(controller.dismissPanel()).toBe(true)
    expect(controller.getSnapshot().panel?.kind).toBe('help')
    await controller.dispose()
  })

  it.each(['running', 'draining'] as const)(
    'opens help immediately while %s without disturbing queued work',
    async (phase) => {
      let finish!: () => void
      const pending = new Promise<void>((resolve) => {
        finish = resolve
      })
      const stream = vi.fn<ChatBackend['stream']>(async function* (prompt) {
        yield { type: 'textDelta', text: prompt }
        await pending
        return { stopReason: 'endTurn' }
      })
      const cancel = vi.fn()
      const controller = new ChatController(backend({ stream, cancel }))
      const running = controller.submit('first')
      await vi.waitFor(() => expect(stream).toHaveBeenCalledOnce())
      const queued = controller.submit('next')
      if (phase === 'draining') {
        controller.cancel()
      }
      const helping = controller.submit(' /HeLp ')
      try {
        expect(controller.getSnapshot().panel?.kind).toBe('help')
        expect(controller.busy).toBe(true)
        expect(controller.getSnapshot().queuedPrompts).toEqual([{ id: 'queued-1', prompt: 'next' }])
        expect(stream).toHaveBeenCalledOnce()
        expect(cancel).toHaveBeenCalledTimes(phase === 'draining' ? 1 : 0)
        await helping
        controller.dismissPanel()
      } finally {
        finish()
        await Promise.all([running, queued, helping])
        await controller.dispose()
      }
      expect(stream.mock.calls.map(([prompt]) => prompt)).toEqual(['first', 'next'])
    }
  )

  it('keeps a pending permission visible when help is submitted during a turn', async () => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const respondPermission = vi.fn(() => true)
    const controller = new ChatController(
      backend({
        stream: async function* () {
          yield {
            type: 'permission',
            request: {
              id: 'permission-1',
              toolName: 'read',
              input: { path: 'README.md' },
              options: [{ id: 'allow', label: 'Allow once', kind: 'allow_once' }],
            },
          }
          await pending
          return { stopReason: 'endTurn' }
        },
        respondPermission,
      })
    )
    const running = controller.submit('read a file')
    await vi.waitFor(() => expect(controller.getSnapshot().panel?.kind).toBe('permission'))
    const helping = controller.submit('/help')
    try {
      expect(controller.getSnapshot().panel?.kind).toBe('permission')
      await controller.activatePanelRow(row(controller, 'Allow once'))
      expect(respondPermission).toHaveBeenCalledWith('permission-1', 'allow')
    } finally {
      finish()
      await Promise.all([running, helping])
      await controller.dispose()
    }
  })

  it.each([
    { width: 80, height: 24 },
    { width: 40, height: 16 },
  ] as const)('bounds help previews at $width×$height and preserves full details', async ({ width, height }) => {
    const description = 'First line\nSecond line\nThird line\nFourth line\nFifth line'
    const controller = new ChatController(
      backend({
        info: () => ({
          tools: Array.from({ length: 8 }, (_, index) => ({
            name: `tool_${index}`,
            description,
            source: 'MCP: docs',
          })),
        }),
      })
    )
    try {
      await controller.submit('/help')
      const panel = controller.getSnapshot().panel!
      const start = panel.rows.findIndex((candidate) => candidate.section === 'Available tools')
      const output = renderToString(
        createElement(ChatView, {
          snapshot: controller.getSnapshot(),
          input: '',
          cursor: 0,
          terminalWidth: width,
          terminalHeight: height,
          panelViewportStart: start,
          panelSelection: start,
        }),
        { columns: width }
      )
      expect(output.split('\n')).toHaveLength(height)
      expect(output).toContain('Help')
      expect(output).toContain('› tool_0')
      expect(output).toContain('Search:')
      expect(output).toContain('First line')
      await controller.activatePanelRow(row(controller, 'tool_0'))
      expect(controller.getSnapshot().panel?.body).toBe(`${description}\nSource: MCP: docs`)
      controller.dismissPanel()
      expect(row(controller, 'tool_0').description).toBe(`${description}\nSource: MCP: docs`)
    } finally {
      await controller.dispose()
    }
  })

  it('uses reported capabilities for ACP connections', async () => {
    const compact = vi.fn(async () => true)
    const controller = new ChatController(backend({ protocol: 'acp', compact }))
    await controller.submit('/help')
    expect(row(controller, '/compact').value).toBe('help:command:compact')
    expect(row(controller, '/clear').description).toContain('Unavailable on this connection')
    expect(row(controller, '/fork [request]').description).not.toContain('Unavailable')
    expect(row(controller, 'Tool list not reported').description).toContain('may still be available')
    await controller.activatePanelRow(row(controller, '/compact'))
    expect(compact).toHaveBeenCalledOnce()
    await controller.dispose()
  })

  it('keeps unknown tools distinct from a reported empty list and refreshes on reopening', async () => {
    let tools: { name: string; description: string }[] = []
    const controller = new ChatController(backend({ info: () => ({ tools }) }))
    await controller.submit('/help')
    row(controller, 'No registered tools')
    tools = [{ name: 'new_tool', description: 'Added by the current agent' }]
    await controller.submit('/help')
    expect(row(controller, 'new_tool').description).toContain('origin not reported')
    expect(controller.getSnapshot().panel?.rows.some((candidate) => candidate.label === 'No registered tools')).toBe(
      false
    )
    await controller.dispose()
  })
})
