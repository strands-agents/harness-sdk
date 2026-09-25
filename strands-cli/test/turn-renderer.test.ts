import type { Agent, AgentStreamEvent } from '@strands-agents/sdk'
import { describe, expect, it, vi } from 'vitest'

import { TurnRenderer } from '../src/console.js'

function textDelta(text: string): AgentStreamEvent {
  return {
    type: 'modelStreamUpdateEvent',
    event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text } },
  } as AgentStreamEvent
}

function toolCall(name: string, input: unknown): AgentStreamEvent {
  return { type: 'beforeToolCallEvent', toolUse: { name, input } } as AgentStreamEvent
}

function toolResult(
  status: 'success' | 'error',
  content: Array<{ type: 'textBlock'; text: string }> = []
): AgentStreamEvent {
  return { type: 'toolResultEvent', result: { status, content } } as AgentStreamEvent
}

function render(
  events: AgentStreamEvent[],
  result?: Parameters<TurnRenderer['finish']>[0],
  model?: Agent['model']
): string {
  const written: string[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
    return true
  })
  try {
    const renderer = new TurnRenderer(model)
    for (const event of events) {
      renderer.handle(event)
    }
    renderer.finish(result)
  } finally {
    spy.mockRestore()
  }
  return written.join('')
}

describe('TurnRenderer', () => {
  it('renders a tool call and its result', () => {
    const out = render([
      toolCall('bash', { command: 'printf TOOL_OK' }),
      toolResult('success', [{ type: 'textBlock', text: 'TOOL_OK' }]),
    ])
    expect(out).toContain('⚙ bash')
    expect(out).toContain('printf TOOL_OK')
    expect(out).toContain('↳ TOOL_OK')
  })

  it('uses a neutral completion label when a tool has no displayable result', () => {
    expect(render([toolResult('success')])).toContain('✓ done')
  })

  it('renders a failed tool result', () => {
    const out = render([toolCall('bash', { command: 'boom' }), toolResult('error')])
    expect(out).toContain('error')
  })

  it('strips terminal controls from plain text and tool metadata while preserving layout whitespace', () => {
    const out = render([
      {
        type: 'modelStreamUpdateEvent',
        event: {
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'reasoningContentDelta', text: 'reason\tone\nreason\u001b[2Jtwo' },
        },
      } as AgentStreamEvent,
      textDelta('answer\u0007 text\u009b31m safe'),
      toolCall('ba\u001b]52;c;clipboard\u0007sh', 'printf\u0090hidden\u009c done'),
    ])

    expect(out).toContain('thinking >')
    expect(out).toContain('agent >')
    expect(out).toContain('reason\tone\nreasontwo')
    expect(out).toContain('answer text safe')
    expect(out).toContain('⚙ bash(printf done)')
    for (const control of ['\u0007', '\u001b', '\u0090', '\u009b', '\u009c']) {
      expect(out).not.toContain(control)
    }
  })

  it('prints the usage summary on finish', () => {
    const result = { metrics: { accumulatedUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } }
    const out = render([textDelta('hi')], result)
    expect(out).toContain('15 tokens')
    expect(out).toContain('10 in')
    expect(out).not.toContain('cached')
  })

  it('includes the cache breakdown when cache tokens are present', () => {
    const result = {
      metrics: {
        accumulatedUsage: {
          inputTokens: 4,
          outputTokens: 63,
          totalTokens: 6714,
          cacheReadInputTokens: 3288,
          cacheWriteInputTokens: 3359,
        },
      },
    }
    const out = render([textDelta('hi')], result)
    expect(out).toContain('6714 tokens')
    expect(out).toContain('6651 in')
    expect(out).toContain('63 out')
    expect(out).toContain('6647 cached: 3359w 3288r')
  })

  it('prints the latest turn usage instead of cumulative session usage', () => {
    const result = {
      metrics: {
        latestAgentInvocation: {
          usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
        },
        accumulatedUsage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 },
      },
    }
    const out = render([textDelta('hi')], result)

    expect(out).toContain('15 tokens')
    expect(out).toContain('12 in')
    expect(out).not.toContain('125 tokens')
  })

  it('does not print an unreliable Gemini input/output split', () => {
    class GoogleModel {}
    const result = {
      metrics: {
        latestAgentInvocation: {
          usage: { inputTokens: 100, outputTokens: 55, totalTokens: 155 },
        },
      },
    }
    const out = render([textDelta('hi')], result, new GoogleModel() as Agent['model'])

    expect(out).toContain('155 tokens')
    expect(out).toContain('input/output split unavailable')
    expect(out).not.toContain('100 in')
    expect(out).not.toContain('55 out')
  })

  it('identifies which events render', () => {
    expect(TurnRenderer.renders(textDelta('x'))).toBe(true)
    expect(TurnRenderer.renders(toolCall('bash', {}))).toBe(true)
    expect(TurnRenderer.renders(toolResult('success'))).toBe(true)
    expect(TurnRenderer.renders({ type: 'beforeInvocationEvent' } as AgentStreamEvent)).toBe(false)
  })
})
