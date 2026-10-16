import { createElement } from 'react'
import { render, renderToString } from 'ink'
import stringWidth from 'string-width'
import { describe, expect, it, vi } from 'vitest'

import { ChatController, type ChatBackend, type ChatPanelRow } from '../src/tui/chat/controller.js'
import { commandAssistance } from '../src/tui/chat/commands.js'
import { ChatView } from '../src/tui/view/chat-view.js'
import { ChatApp } from '../src/tui/view/app.js'
import { captureFrame, mouseInputSequence, ttyInput, ttyOutput } from './fixtures/terminal.js'
import { idleBackend } from './fixtures/chat-backend.js'

function row(controller: ChatController, label: string): ChatPanelRow {
  const result = controller.getSnapshot().panel?.rows.find((candidate) => candidate.label === label)
  expect(result, `Missing row: ${label}`).toBeDefined()
  return result!
}

describe('help', () => {
  it('opens slash help and autocomplete without running an agent turn', async () => {
    const stream = vi.fn()
    const controller = new ChatController(idleBackend({ stream }))
    expect(commandAssistance('/he')?.completions ?? []).toEqual([expect.objectContaining({ name: 'help' })])
    expect(commandAssistance('/help ')?.signature).toBe('/help')
    expect(commandAssistance('/config ')?.completions).toEqual([])
    expect(commandAssistance('/config p')?.completions).toEqual([
      expect.objectContaining({ name: 'python', replacement: '/config python ' }),
    ])
    expect(controller.actionableCommandToken('/help')).toBe('/help')
    await controller.submit('/help')
    const panel = controller.getSnapshot().panel
    expect(panel).toMatchObject({ kind: 'help', title: 'Help', searchable: true })
    expect([...new Set(panel!.rows.map((candidate) => candidate.section))]).toEqual([
      'Controls',
      'Commands',
      'Available tools',
    ])
    expect(panel!.rows).not.toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Steer running work' })]))
    expect(panel!.rows.map((candidate) => candidate.description).join('\n')).not.toContain('Ctrl+G')
    expect(stream).not.toHaveBeenCalled()
    await controller.dispose()
  })

  it('opens complete selectable tool details and returns to help', async () => {
    const description = 'First line\n' + 'Long tool documentation. '.repeat(30)
    const controller = new ChatController(
      idleBackend({
        info: () => ({ tools: [{ name: 'custom\u001b[31m_tool', description, source: 'MCP: docs' }] }),
      })
    )
    await controller.submit('/help')
    await controller.activatePanelRow(row(controller, 'custom_tool'))
    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'help-detail',
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
        yield { type: 'textDelta', text: typeof prompt === 'string' ? prompt : 'attachment prompt' }
        await pending
        return { stopReason: 'endTurn' }
      })
      const cancel = vi.fn()
      const controller = new ChatController(idleBackend({ stream, cancel }))
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
      idleBackend({
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
      expect(respondPermission).toHaveBeenCalledWith('permission-1', 'allow', undefined)
    } finally {
      finish()
      await Promise.all([running, helping])
      await controller.dispose()
    }
  })

  it.each([
    { width: 200, height: 40 },
    { width: 120, height: 40 },
    { width: 80, height: 24 },
    { width: 40, height: 16 },
  ] as const)('bounds help previews at $width×$height', async ({ width, height }) => {
    const description = 'First line\nSecond line\nThird line\nFourth line\nFifth line'
    const controller = new ChatController(
      idleBackend({
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
      const controls = renderToString(
        createElement(ChatView, {
          snapshot: controller.getSnapshot(),
          input: '',
          cursor: 0,
          terminalWidth: width,
          terminalHeight: height,
          panelRows: panel.rows.filter((candidate) => candidate.filter === 'controls'),
          panelFilter: 'controls',
          modelPanelFocus: 'models',
        }),
        { columns: width }
      )
      expect(controls.split('\n').every((line) => stringWidth(line) <= width)).toBe(true)
      if (width >= 80) {
        const send = controls.split('\n').find((line) => line.includes('Send a message'))!
        const newline = controls.split('\n').find((line) => line.includes('Add a line'))!
        expect(send).toMatch(/Send a message {2,10}Enter/)
        expect(newline).toMatch(/Add a line {2,16}Ctrl\+J/)
        expect(send.indexOf('Enter')).toBe(newline.indexOf('Ctrl+J'))
      }
      const rows = panel.rows.filter((candidate) => candidate.filter === 'tools')
      const output = renderToString(
        createElement(ChatView, {
          snapshot: controller.getSnapshot(),
          input: '',
          cursor: 0,
          terminalWidth: width,
          terminalHeight: height,
          panelRows: rows,
          panelFilter: 'tools',
          modelPanelFocus: 'models',
        }),
        { columns: width }
      )
      expect(output.split('\n')).toHaveLength(height)
      expect(output.split('\n').every((line) => stringWidth(line) <= width)).toBe(true)
      expect(output).toContain('Help')
      expect(output).toContain('› tool_0')
      expect(output).toContain('Search help')
      expect(output).not.toContain('Viewing Help')
      const borders = output.split('\n').filter((line) => line.includes('┌') && line.includes('┐'))
      expect(borders.some((line) => stringWidth(line) >= width - 2)).toBe(true)
      await controller.activatePanelRow(rows[0]!)
      const details = renderToString(
        createElement(ChatView, {
          snapshot: controller.getSnapshot(),
          input: '',
          cursor: 0,
          terminalWidth: width,
          terminalHeight: height,
        }),
        { columns: width }
      )
      expect(details).toContain('First line')
      expect(details).not.toContain('Viewing tool_0')
      expect(details.split('\n')).toHaveLength(height)
      expect(details.split('\n').every((line) => stringWidth(line) <= width)).toBe(true)
    } finally {
      await controller.dispose()
    }
  })

  it.each([
    { width: 100, height: 30 },
    { width: 40, height: 16 },
  ])(
    'navigates, searches, scrolls details, and returns to the same help list at $width×$height',
    async ({ width, height }) => {
      const input = ttyInput()
      const output = ttyOutput(width, height)
      const frame = captureFrame(output)
      const controller = new ChatController(
        idleBackend({
          info: () => ({
            tools: [
              { name: 'other_tool', description: 'Other tool' },
              {
                name: 'docs_tool',
                description: Array.from({ length: 30 }, (_, index) => `Documentation line ${index + 1}`).join('\n'),
                source: 'MCP: docs',
              },
            ],
          }),
        }),
        { settings: { animations: false } }
      )
      const instance = render(createElement(ChatApp, { controller }), {
        stdin: input,
        stdout: output,
        stderr: ttyOutput(width, height),
        exitOnCtrlC: false,
        patchConsole: false,
        interactive: true,
      })
      const key = async (text: string): Promise<void> => {
        input.write(text)
        await instance.waitUntilRenderFlush()
      }
      try {
        await controller.submit('/help')
        await instance.waitUntilRenderFlush()
        await key('\u001b[B')
        await key('\u001b[B')
        await key('\t')
        await key('/')
        await key('docs')
        expect(frame().join('\n')).toContain('docs_tool')
        expect(frame().join('\n')).not.toContain('other_tool')
        await key('\r')
        await key('\r')
        expect(controller.getSnapshot().panel?.kind).toBe('help-detail')
        expect(frame().join('\n')).toContain('Documentation line 1')
        await key('\u001b[F')
        expect(frame().join('\n')).toContain('Source: MCP: docs')
        expect(frame().join('\n')).not.toContain('Documentation line 1\n')
        await key('\u001b')
        await vi.waitFor(() => expect(controller.getSnapshot().panel?.kind).toBe('help'))
        await instance.waitUntilRenderFlush()
        expect(frame().join('\n')).toContain('› docs_tool')
        expect(frame().join('\n')).not.toContain('other_tool')
        await key('\u001b')
        await vi.waitFor(() => expect(frame().join('\n')).toContain('other_tool'))
        await key('\t')
        await key('\u001b[A')
        await key('\t')
        await key('/')
        await key('context')
        await key('\r')
        await key('\r')
        expect(controller.getSnapshot().panel?.kind).toBe('context')
      } finally {
        instance.unmount()
        await controller.dispose()
      }
    }
  )

  it('opens help categories and details with the mouse', async () => {
    const input = ttyInput()
    const output = ttyOutput(100, 30)
    const frame = captureFrame(output)
    const controller = new ChatController(
      idleBackend({
        info: () => ({ tools: [{ name: 'docs_tool', description: 'Complete documentation', source: 'MCP: docs' }] }),
      }),
      { settings: { animations: false } }
    )
    const instance = render(createElement(ChatApp, { controller }), {
      stdin: input,
      stdout: output,
      stderr: ttyOutput(100, 30),
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    })
    const click = async (text: string): Promise<void> => {
      const lines = frame()
      const row = lines.findIndex((line) => line.includes(text))
      expect(row).toBeGreaterThanOrEqual(0)
      const column = lines[row]!.indexOf(text)
      input.write(mouseInputSequence(0, column, row, 'M'))
      input.write(mouseInputSequence(3, column, row, 'm'))
      await instance.waitUntilRenderFlush()
    }
    try {
      await controller.submit('/help')
      await instance.waitUntilRenderFlush()
      await click('Tools')
      await click('docs_tool')
      expect(controller.getSnapshot().panel?.kind).toBe('help-detail')
      expect(frame().join('\n')).toContain('Complete documentation')
      input.write('\u001b')
      await vi.waitFor(() => expect(controller.getSnapshot().panel?.kind).toBe('help'))
      await instance.waitUntilRenderFlush()
      expect(frame().join('\n')).toContain('› docs_tool')
    } finally {
      instance.unmount()
      await controller.dispose()
    }
  })

  it('uses reported capabilities for ACP connections', async () => {
    const compact = vi.fn(async () => ({}))
    const controller = new ChatController(idleBackend({ protocol: 'acp', compact }))
    await controller.submit('/help')
    expect(row(controller, '/compact').value).toBe('help:command:compact')
    expect(row(controller, '/clear').description).toContain('Unavailable on this connection')
    expect(row(controller, '/fork [request]').description).not.toContain('Unavailable')
    expect(row(controller, 'Tool list not reported').description).toContain('may still be available')
    await controller.activatePanelRow(row(controller, '/compact'))
    expect(compact).toHaveBeenCalledOnce()
    await controller.dispose()
  })

  it('refreshes a reported tool list when help reopens', async () => {
    let tools: { name: string; description: string }[] = []
    const controller = new ChatController(idleBackend({ info: () => ({ tools }) }))
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
