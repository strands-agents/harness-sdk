/**
 * SDK invariant checks — the axis that actually gives signal on SDK changes.
 *
 * Task-outcome scoring (did the agent get the right answer) is dominated by
 * model strength: a strong model routes around whatever the SDK does, so the
 * score is insensitive to the thing we're trying to measure. These checks
 * instead assert properties the SDK *governs* and the model cannot paper over
 * — tool-call pairing through truncation, history continuity across resume,
 * context staying under the window. They read the final message log + metrics
 * and return deterministic booleans: no LLM judge, no n=1 variance.
 */

import { ToolUseBlock, ToolResultBlock } from '../../../strands-ts/src/types/messages.js'
import type { Message } from '../../../strands-ts/src/types/messages.js'

export interface Invariant {
  /** Short stable id, e.g. "tool-pairing-intact". */
  name: string
  /** `pass` = checked and held; `fail` = checked and broke; `skip` = nothing to
   *  check (e.g. no tool calls in the log), so neither a pass nor a fail.
   *  Distinguishing `skip` keeps a vacuous check from reading as real signal. */
  status: 'pass' | 'fail' | 'skip'
  /** Why it passed/failed/was skipped — concrete enough to act on. */
  detail: string
}

function blocks(messages: Message[]) {
  const uses: ToolUseBlock[] = []
  const results: ToolResultBlock[] = []
  for (const m of messages) {
    for (const b of m.content) {
      if (b instanceof ToolUseBlock) uses.push(b)
      else if (b instanceof ToolResultBlock) results.push(b)
    }
  }
  return { uses, results }
}

/**
 * Every tool_result references a tool_use present in the log, and every
 * tool_use that the log retains has its result. The sliding-window manager
 * explicitly promises to preserve these pairs through truncation — this is
 * the check that holds it to that promise. A dangling block here means the
 * model was handed a corrupt conversation, which is purely an SDK fault.
 */
export function toolPairingIntact(messages: Message[]): Invariant {
  const { uses, results } = blocks(messages)
  const useIds = new Set(uses.map((u) => u.toolUseId))
  const resultIds = new Set(results.map((r) => r.toolUseId))

  if (uses.length === 0 && results.length === 0) {
    return { name: 'tool-pairing-intact', status: 'skip', detail: 'no tool calls in the retained log — nothing to pair' }
  }

  const orphanResults = [...resultIds].filter((id) => !useIds.has(id))
  const danglingUses = [...useIds].filter((id) => !resultIds.has(id))

  const ok = orphanResults.length === 0 && danglingUses.length === 0
  return {
    name: 'tool-pairing-intact',
    status: ok ? 'pass' : 'fail',
    detail: ok
      ? `${uses.length} tool_use / ${results.length} tool_result all paired`
      : `orphan results: [${orphanResults.join(', ')}]; dangling uses: [${danglingUses.join(', ')}]`,
  }
}

/**
 * No tool_result appears before any tool_use, and the log never opens on a
 * tool_result. Truncation or a botched interrupt/resume that drops the head
 * of the conversation shows up as a leading orphan tool_result — a state the
 * model cannot produce on its own.
 */
export function historyWellFormed(messages: Message[]): Invariant {
  const seenUse = new Set<string>()
  for (const m of messages) {
    for (const b of m.content) {
      if (b instanceof ToolUseBlock) seenUse.add(b.toolUseId)
      else if (b instanceof ToolResultBlock && !seenUse.has(b.toolUseId)) {
        return {
          name: 'history-well-formed',
          status: 'fail',
          detail: `tool_result ${b.toolUseId} precedes its tool_use — history head was dropped (truncation/resume fault)`,
        }
      }
    }
  }
  return { name: 'history-well-formed', status: 'pass', detail: 'no tool_result precedes its tool_use' }
}

/**
 * The conversation manager kept the message count within the window it was
 * configured with (after its own reduction runs). Exceeding it means the
 * manager failed to enforce its own bound.
 */
export function contextUnderWindow(messages: Message[], windowSize: number): Invariant {
  const ok = messages.length <= windowSize
  return {
    name: 'context-under-window',
    status: ok ? 'pass' : 'fail',
    detail: ok
      ? `${messages.length} messages <= window ${windowSize}`
      : `${messages.length} messages exceeds window ${windowSize} — manager did not enforce its bound`,
  }
}

/**
 * Scenario-supplied state consistency: the caller knows what the external
 * world (kv/db/rooms) SHOULD contain given the work that was dispatched, and
 * asserts the actual state matches. Catches lost updates from concurrent tool
 * dispatch — the model believes it did the work; the state proves whether the
 * SDK actually applied it.
 */
export function stateConsistent(name: string, ok: boolean, detail: string): Invariant {
  return { name, status: ok ? 'pass' : 'fail', detail }
}
