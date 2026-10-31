import type { ChatEntry, ChatTurn } from '../chat/controller.js'

type ToolStatus = Extract<ChatEntry, { type: 'tool' }>['status']

/** The still marker that replaces the spinner while activity waits on the user. */
export const PAUSED_MARKER = '◆'

/** What the active turn is doing, shown on the line under its transcript. */
export type TurnActivity =
  'working' | 'awaitingApproval' | 'waitingForResponse' | 'reviewingBackground' | 'respondingToPeer'

export const TURN_ACTIVITY: Record<TurnActivity, { label: string; animated: boolean; interruptible: boolean }> = {
  working: { label: 'Working', animated: true, interruptible: true },
  // The approval prompt owns Esc, so the turn line does not advertise interrupting.
  awaitingApproval: { label: 'Waiting for approval', animated: false, interruptible: false },
  waitingForResponse: { label: 'Waiting for model response', animated: true, interruptible: true },
  reviewingBackground: { label: 'Reviewing background result', animated: true, interruptible: true },
  respondingToPeer: { label: 'Responding to', animated: true, interruptible: true },
}

/** A tool row's displayed state; `paused` is a running call held on an approval prompt. */
export type ToolActivity = 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled'

export const TOOL_ACTIVITY: Record<
  ToolActivity,
  { label?: string; marker?: string; color: 'yellow' | 'green' | 'red' }
> = {
  running: { label: 'running', color: 'yellow' },
  paused: { label: 'paused', marker: PAUSED_MARKER, color: 'yellow' },
  succeeded: { marker: '✓', color: 'green' },
  failed: { label: 'failed', marker: '×', color: 'red' },
  cancelled: { label: 'cancelled', marker: '○', color: 'yellow' },
}

const TOOL_ACTIVITY_BY_STATUS: Record<ToolStatus, ToolActivity> = {
  running: 'running',
  success: 'succeeded',
  error: 'failed',
  cancelled: 'cancelled',
}

export function turnActivity(turn: ChatTurn, awaitingApproval: boolean): TurnActivity {
  if (awaitingApproval) return 'awaitingApproval'
  if (turn.responseDelayed) return 'waitingForResponse'
  if (turn.source === 'background') return 'reviewingBackground'
  return turn.source === 'peer' ? 'respondingToPeer' : 'working'
}

export function turnActivityText(activity: TurnActivity, turn: ChatTurn, spinner: string): string {
  const { label, animated, interruptible } = TURN_ACTIVITY[activity]
  const subject = activity === 'respondingToPeer' ? `${label} ${turn.peer?.name ?? 'agent'}` : label
  return `${animated ? spinner : PAUSED_MARKER} ${subject}${interruptible ? ' (esc to interrupt)' : ''}`
}

export function toolActivity(status: ToolStatus, paused: boolean): ToolActivity {
  return status === 'running' && paused ? 'paused' : TOOL_ACTIVITY_BY_STATUS[status]
}

/** A group reads as its most pressing member: any running call, then failures, then cancellations. */
export function toolGroupActivity(statuses: readonly ToolStatus[], paused: boolean): ToolActivity {
  if (statuses.includes('running')) return paused ? 'paused' : 'running'
  if (statuses.includes('error')) return 'failed'
  return statuses.includes('cancelled') ? 'cancelled' : 'succeeded'
}

export function toolActivityMarker(activity: ToolActivity, spinner: string): string {
  return TOOL_ACTIVITY[activity].marker ?? spinner
}
