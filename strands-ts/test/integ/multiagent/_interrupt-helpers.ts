/**
 * Shared helpers for multi-agent interrupt integration tests.
 *
 * Leading-underscore filename keeps it out of vitest's auto-discovery.
 */
import type { InterruptResponseContentData, JSONValue } from '@strands-agents/sdk'
import { Status } from '$/sdk/multiagent/index.js'
import type { MultiAgentResult } from '$/sdk/multiagent/index.js'
import { SessionManager } from '$/sdk/session/session-manager.js'
import { FileStorage } from '$/sdk/session/file-storage.js'

export function makeSessionManager(sessionId: string, storageDir: string): SessionManager {
  return new SessionManager({ sessionId, storage: { snapshot: new FileStorage(storageDir) } })
}

/**
 * Resumes an interrupted orchestrator by answering all pending interrupts, looping
 * until the run terminates or we hit the max iteration limit. Used for both Graph
 * and Swarm.
 */
export async function resumeUntilDone(
  invoke: (responses: InterruptResponseContentData[]) => Promise<MultiAgentResult>,
  initial: MultiAgentResult,
  respond: (interrupt: { id: string; name: string; reason?: unknown }) => JSONValue,
  maxRounds = 5
): Promise<MultiAgentResult> {
  let current = initial
  for (let i = 0; i < maxRounds && current.status === Status.INTERRUPTED; i++) {
    const responses: InterruptResponseContentData[] = current.interrupts!.map((interrupt) => ({
      interruptResponse: { interruptId: interrupt.id, response: respond(interrupt) },
    }))
    current = await invoke(responses)
  }
  return current
}
