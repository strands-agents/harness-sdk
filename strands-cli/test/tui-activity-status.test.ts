import { createElement } from 'react'
import { renderToString } from 'ink'
import { describe, expect, it } from 'vitest'

import { toolActivity, toolGroupActivity, turnActivity, turnActivityText } from '../src/tui/view/activity-status.js'
import { TurnView } from '../src/tui/view/transcript-turn.js'
import { DEFAULT_CHAT_SETTINGS, type ChatTurn } from '../src/tui/chat/types.js'
import { sanitizeTerminalText } from '../src/tui/terminal/sanitize.js'

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
  it('labels the turn line from a fixed set of activities', () => {
    expect(turnActivityText(turnActivity(turn(), false), turn(), '|')).toBe('| Working (esc to interrupt)')
    expect(turnActivityText(turnActivity(turn(), true), turn(), '|')).toBe('◆ Waiting for approval')
    expect(turnActivityText(turnActivity(turn('background'), false), turn('background'), '|')).toBe(
      '| Reviewing background result (esc to interrupt)'
    )
    expect(turnActivityText(turnActivity(turn('peer'), false), turn('peer'), '|')).toBe(
      '| Responding to Reviewer (esc to interrupt)'
    )
  })

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

  it('shows a response delay without overriding a pending approval', () => {
    const delayed = { ...turn(), responseDelayed: true }
    expect(turnActivityText(turnActivity(delayed, false), delayed, '|')).toBe(
      '| Waiting for model response (esc to interrupt)'
    )
    expect(turnActivityText(turnActivity(delayed, true), delayed, '|')).toBe('◆ Waiting for approval')
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
