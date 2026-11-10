import { createElement } from 'react'
import { renderToString } from 'ink'
import { describe, expect, it } from 'vitest'

import { toolActivity, toolGroupActivity } from '../../src/ui/chat/transcript-turn.js'
import { TurnView } from '../../src/ui/chat/transcript-turn.js'
import { DEFAULT_CHAT_SETTINGS } from '../../src/ui/chat/types.js'
import { type ChatTurn } from '../../src/agent/types.js'
import { sanitizeTerminalText } from '../../src/terminal/text.js'

const turn = (source?: ChatTurn['source']): ChatTurn => ({
  id: 'turn-1',
  prompt: 'go',
  agentName: 'Strands harness',
  entries: [],
  status: 'running',
  ...(source ? { source } : {}),
  ...(source === 'peer' ? { peer: { id: 'peer-1', name: 'Reviewer' } } : {}),
})

describe('activity status', () => {
  it('pauses only a running tool call and ranks a group by its most pressing member', () => {
    expect(toolActivity('running', true)).toBe('paused')
    expect(toolActivity('success', true)).toBe('succeeded')
    expect(toolActivity('error', false)).toBe('failed')
    expect(toolGroupActivity(['success', 'running', 'error'], false)).toBe('running')
    expect(toolGroupActivity(['success', 'running'], true)).toBe('paused')
    expect(toolGroupActivity(['success', 'cancelled', 'error'], false)).toBe('failed')
    expect(toolGroupActivity(['success', 'cancelled'], false)).toBe('cancelled')
    expect(toolGroupActivity(['success'], false)).toBe('succeeded')
  })

  it.each([60, 100])('renders the delayed-response recovery hint at %i columns', (columns) => {
    const render = (props: Partial<Parameters<typeof TurnView>[0]> = {}): string =>
      sanitizeTerminalText(
        renderToString(
          createElement(TurnView, {
            turn: { ...turn(), responseDelayed: true },
            settings: { ...DEFAULT_CHAT_SETTINGS, animations: false },
            expandedToolGroups: new Set<string>(),
            active: true,
            ...props,
          }),
          { columns }
        )
      ).replace(/\s+/g, ' ')

    expect(render()).toContain('Waiting for model response (esc to interrupt)')
    expect(render()).toContain('No response for 30s. /exit to close, then resume.')
    expect(render({ approvalToolName: 'shell' })).not.toContain('No response for 30s')
    const failed = render({
      turn: { ...turn(), status: 'error', error: 'Request failed.', recoveryHint: 'Refresh credentials, then retry.' },
    })
    expect(failed).toContain('Error: Request failed.')
    expect(failed).toContain('Refresh credentials, then retry.')
    expect(failed).not.toContain('Waiting for model response')
    expect(render({ active: false })).not.toContain('No response for 30s')
  })
})
