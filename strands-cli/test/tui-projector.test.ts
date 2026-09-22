import { Message, TextBlock } from '@strands-agents/sdk'
import { describe, expect, it, vi } from 'vitest'

import { TurnProjector, projectMessages } from '../src/tui/chat/projector.js'
import { peerMessageMetadata } from '../src/tui/messaging.js'
import { upgradeDesktopAgentProfileMessages } from '../src/tui/session/desktop-profile.js'
import { SHELL_OUTPUT_LIMIT_BYTES, SHELL_OUTPUT_LIMIT_NOTICE } from '../src/tui/terminal/shell-output.js'

describe('TurnProjector', () => {
  it('preserves reasoning, assistant text, media, and tool activity in order', () => {
    const bytes = new Uint8Array([1, 2, 3])
    const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValue(13_400)
    const projector = new TurnProjector('turn-1', 'inspect')
    projector.handle({ type: 'reasoningDelta', text: 'checking' })
    projector.handle({ type: 'reasoningDelta', text: ' files' })
    projector.handle({ type: 'toolStart', toolUseId: 'tool-1', name: 'read', input: { path: 'image.png' } })
    projector.handle({
      type: 'toolResult',
      toolUseId: 'tool-1',
      status: 'success',
      content: [{ type: 'image', format: 'png', source: { type: 'bytes', bytes } }],
    })
    projector.handle({ type: 'media', content: { type: 'image', format: 'png', source: { type: 'bytes', bytes } } })
    projector.handle({ type: 'textDelta', text: 'Done.' })
    projector.finish({
      stopReason: 'endTurn',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cacheReadInputTokens: 3,
        cacheWriteInputTokens: 2,
      },
    })
    clock.mockRestore()

    bytes[0] = 9
    const firstSnapshot = projector.snapshot()
    expect(firstSnapshot).toMatchObject({
      prompt: 'inspect',
      status: 'complete',
      durationMs: 12_400,
      entries: [
        { type: 'reasoning', text: 'checking files' },
        {
          type: 'tool',
          name: 'read',
          status: 'success',
          result: [{ type: 'image', source: { type: 'bytes', bytes: new Uint8Array([1, 2, 3]) } }],
        },
        { type: 'media', content: { source: { type: 'bytes', bytes: new Uint8Array([1, 2, 3]) } } },
        { type: 'assistant', text: 'Done.' },
      ],
      usage: { totalTokens: 15 },
    })
  })

  it('reconciles streamed text with the authoritative completed message', () => {
    const projector = new TurnProjector('turn-1', 'hello')
    projector.handle({ type: 'textDelta', text: 'Hello! Ow can I help you today?' })
    projector.finish({
      stopReason: 'endTurn',
      finalText: 'Hello! How can I help you today?',
    })

    expect(projector.snapshot().entries).toEqual([
      {
        id: 'turn-1:1',
        type: 'assistant',
        text: 'Hello! How can I help you today?',
      },
    ])
  })

  it('upserts retried tools and sanitizes terminal control characters', () => {
    const projector = new TurnProjector('turn-1', 'retry')
    projector.handle({ type: 'toolStart', toolUseId: 'tool-1', name: 'bash', input: { command: 'first' } })
    projector.handle({ type: 'toolStart', toolUseId: 'tool-1', name: 'bash', input: { command: 'second' } })
    projector.handle({
      type: 'toolResult',
      toolUseId: 'tool-1',
      status: 'error',
      content: [{ type: 'text', text: 'failed\u001b[2J' }],
      error: 'bad\u0007 input',
    })

    expect(projector.snapshot().entries).toEqual([
      {
        id: 'turn-1:1',
        type: 'tool',
        toolUseId: 'tool-1',
        name: 'bash',
        input: { command: 'second' },
        status: 'error',
        result: [{ type: 'text', text: 'failed' }],
        error: 'bad input',
      },
    ])
  })

  it('preserves background state across duplicate tool start events', () => {
    const projector = new TurnProjector('turn-1', 'delegate')
    projector.handle({
      type: 'toolStart',
      toolUseId: 'tool-1',
      name: 'generalist',
      input: { task: 'Review authentication.' },
      background: true,
    })
    projector.handle({
      type: 'toolStart',
      toolUseId: 'tool-1',
      name: 'generalist',
      input: { task: 'Review authentication.' },
    })

    expect(projector.snapshot().entries).toEqual([
      {
        id: 'turn-1:1',
        type: 'tool',
        toolUseId: 'tool-1',
        name: 'generalist',
        input: { task: 'Review authentication.' },
        status: 'running',
        background: true,
      },
    ])
  })

  it('appends streamed tool output while the tool is still running', () => {
    const projector = new TurnProjector('turn-1', '!printf hello')
    projector.handle({
      type: 'toolStart',
      toolUseId: 'shell-1',
      name: 'shell',
      input: { command: 'printf hello' },
    })
    projector.handle({
      type: 'toolOutputDelta',
      toolUseId: 'shell-1',
      stream: 'stdout',
      text: 'hel',
    })
    projector.handle({
      type: 'toolOutputDelta',
      toolUseId: 'shell-1',
      stream: 'stderr',
      text: 'lo\u001b[2J',
    })

    expect(projector.snapshot().entries).toEqual([
      {
        id: 'turn-1:1',
        type: 'tool',
        toolUseId: 'shell-1',
        name: 'shell',
        input: { command: 'printf hello' },
        status: 'running',
        result: [{ type: 'text', text: 'hello' }],
      },
    ])
  })

  it('bounds streamed tool output retained by the turn projector', () => {
    const retained = 'x'.repeat(SHELL_OUTPUT_LIMIT_BYTES - 1)
    const projector = new TurnProjector('turn-1', '!yes')
    projector.handle({
      type: 'toolStart',
      toolUseId: 'shell-1',
      name: 'shell',
      input: { command: 'yes' },
    })
    projector.handle({
      type: 'toolOutputDelta',
      toolUseId: 'shell-1',
      stream: 'stdout',
      text: retained,
    })
    projector.handle({
      type: 'toolOutputDelta',
      toolUseId: 'shell-1',
      stream: 'stdout',
      text: SHELL_OUTPUT_LIMIT_NOTICE,
    })
    projector.handle({
      type: 'toolOutputDelta',
      toolUseId: 'shell-1',
      stream: 'stdout',
      text: 'ignored',
    })

    expect(projector.snapshot().entries).toEqual([
      {
        id: 'turn-1:1',
        type: 'tool',
        toolUseId: 'shell-1',
        name: 'shell',
        input: { command: 'yes' },
        status: 'running',
        result: [{ type: 'text', text: `${retained}${SHELL_OUTPUT_LIMIT_NOTICE}` }],
      },
    ])
  })

  it('sanitizes structured tool and document strings before snapshotting', () => {
    const projector = new TurnProjector('turn-1', 'inspect')
    projector.handle({
      type: 'toolStart',
      toolUseId: 'tool-1',
      name: 'read',
      input: { command: '\u001b]52;c;clipboard\u0007safe' },
    })
    projector.handle({
      type: 'media',
      content: {
        type: 'document',
        name: 'report\u001b[2J',
        format: 'txt',
        source: { type: 'text', text: 'before\u001b]52;c;clipboard\u0007after' },
        context: 'context\u0007',
      },
    })

    expect(projector.snapshot().entries).toMatchObject([
      { type: 'tool', input: { command: 'safe' } },
      {
        type: 'media',
        content: {
          name: 'report',
          source: { type: 'text', text: 'beforeafter' },
          context: 'context',
        },
      },
    ])
  })

  it('sanitizes restored structured content while preserving image bytes', () => {
    const bytes = new Uint8Array([0x1b, 0x07, 0x9b])
    const turns = projectMessages(
      [
        {
          role: 'user',
          content: [{ type: 'textBlock', text: 'inspect' }],
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'toolUseBlock',
              toolUseId: 'tool\u0007-1',
              name: 're\u001b[31mad',
              input: { '\u009b31mkey': 'safe\u0007' },
            },
            {
              type: 'documentBlock',
              name: 'report\u001b[2J',
              format: 'txt',
              source: { type: 'documentSourceText', text: 'line\tone\nline\u009b31mtwo' },
              context: 'context\u0007',
            },
            {
              type: 'imageBlock',
              format: 'png',
              source: { type: 'imageSourceBytes', bytes },
            },
          ],
        },
      ] as never,
      'Agent\u001b[2J'
    )

    expect(turns).toMatchObject([
      {
        agentName: 'Agent',
        entries: [
          { type: 'tool', toolUseId: 'tool-1', name: 'read', input: { key: 'safe' } },
          {
            type: 'media',
            content: {
              type: 'document',
              name: 'report',
              source: { type: 'text', text: 'line\tone\nlinetwo' },
              context: 'context',
            },
          },
          {
            type: 'media',
            content: { type: 'image', source: { type: 'bytes', bytes } },
          },
        ],
      },
    ])
  })

  it('restores peer-message attribution from persisted SDK metadata', () => {
    const message = {
      from: { id: 'agent-2', name: 'Reviewer' },
      body: 'Please check the parser.',
    }

    expect(
      projectMessages([
        {
          role: 'user',
          content: [{ type: 'textBlock', text: 'A peer agent sent you a message.' }],
          metadata: { custom: peerMessageMetadata(message) },
        },
        {
          role: 'assistant',
          content: [{ type: 'textBlock', text: 'I will review it.' }],
        },
      ] as never)
    ).toMatchObject([
      {
        prompt: 'Please check the parser.',
        source: 'peer',
        peer: { id: 'agent-2', name: 'Reviewer' },
        entries: [{ type: 'assistant', text: 'I will review it.' }],
      },
    ])
  })

  it('keeps Desktop agent identity out of the user transcript and disambiguates old sessions', () => {
    const original = new Message({
      role: 'user',
      content: [
        new TextBlock(
          [
            '<strands_agent_profile>',
            'Name: John',
            'Job: Another tester',
            'Operating brief: Helpful agent who speaks like Tony Stark',
            'Keep this role for the entire durable session. Do not repeat this profile unless the user asks.',
            '</strands_agent_profile>',
            '',
            '<strands_session_recovery>',
            'User: Earlier request.',
            'Agent: Earlier response.',
            '</strands_session_recovery>',
            '',
            '<strands_reply_context>',
            'Replying to message: earlier',
            '</strands_reply_context>',
            '',
            'What changed?',
          ].join('\n')
        ),
      ],
    })

    const messages = upgradeDesktopAgentProfileMessages([original])
    const upgraded = messages[0]!.content[0]

    if (!upgraded) {
      throw new Error('Expected the restored user message to contain text.')
    }
    expect(upgraded).toBeInstanceOf(TextBlock)
    const text = upgraded.type === 'textBlock' ? upgraded.text : ''
    expect(text).toContain('The following fields describe you, the assistant. They do not describe the user.')
    expect(text).toContain('Assistant name: John')
    expect(text).toContain("Never infer or address the user by the assistant's name.")
    expect(projectMessages(messages)[0]?.prompt).toBe('What changed?')
    expect(original.content[0]?.type === 'textBlock' ? original.content[0].text : '').toContain('Name: John')
  })
})
