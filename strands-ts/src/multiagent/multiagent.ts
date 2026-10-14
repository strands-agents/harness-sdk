import type { InvocationState, InvokeArgs } from '../types/agent.js'
import type { Invocation } from '../agent/invocation.js'
import type { CheckpointResumeContent } from '../experimental/checkpoint.js'
import type { Message, MessageData } from '../types/messages.js'
import type { HookableEvent } from '../hooks/events.js'
import type { HookCallback, HookableEventConstructor, HookCleanup } from '../hooks/types.js'
import type { InterruptResponseContentData } from '../types/interrupt.js'
import { InterruptResponseContent, isInterruptResponseContent } from '../types/interrupt.js'
import type { MultiAgentStreamEvent } from './events.js'
import { NodeResult, Status } from './state.js'
import type { MultiAgentResult, MultiAgentState, NodeState } from './state.js'

/**
 * Input type for multi-agent orchestrators. Excludes `Message[]` / `MessageData[]`
 * since orchestrators route content blocks between nodes rather than replaying raw
 * conversation history.
 *
 * Accepts `InterruptResponseContent[]` / `InterruptResponseContentData[]` for resuming
 * from an interrupted run — orchestrators detect resume input at the entry point and
 * route responses to the interrupted nodes rather than flowing through dependency
 * resolution.
 */
export type MultiAgentInput = Exclude<InvokeArgs, Message[] | MessageData[] | CheckpointResumeContent>

/**
 * The non-resume subset of {@link MultiAgentInput}. Internal orchestrator helpers that
 * participate in dependency resolution / handoff routing accept this narrower type so
 * they don't need to re-check for {@link InterruptResponseContent} entries at each call.
 *
 * @internal
 */
export type MultiAgentContentInput = Exclude<
  MultiAgentInput,
  InterruptResponseContent[] | InterruptResponseContentData[]
>

/**
 * Options for a single multi-agent orchestrator invocation.
 */
export interface MultiAgentInvokeOptions {
  /**
   * Per-invocation state forwarded to every node's child agent. Mutable —
   * one node's hooks/tools can read state written by a previous node. See
   * {@link InvocationState} for details. Defaults to `{}` when omitted.
   */
  invocationState?: InvocationState

  /**
   * Cancellation signal forwarded to every node (and into any nested orchestrators
   * via `MultiAgentNode`). Composed with the orchestrator's own timeout and
   * short-circuit signals, matching {@link InvokeOptions.cancelSignal} on the
   * single-agent path. Cooperative — honored by nodes that forward it to their
   * underlying agents/tools.
   *
   * When this signal aborts, the orchestrator throws rather than returning a clean
   * result. This matches single-agent behavior: external cancellation is treated as
   * an exceptional exit, not a normal terminal state.
   */
  cancelSignal?: AbortSignal

  /** Runs this orchestration as part of an enclosing request, shared by every node's agent; see {@link InvokeOptions.invocation}. */
  invocation?: Invocation
}

/**
 * Interface for any multi-agent orchestrator that can stream execution.
 * Implement this interface to create custom orchestration patterns that can be
 * composed as nodes within other orchestrators via {@link MultiAgentNode}.
 */
export interface MultiAgent {
  /** Unique identifier for this orchestrator. */
  readonly id: string

  /**
   * Execute the orchestrator and return the final result.
   * @param input - Input to pass to the orchestrator
   * @param options - Optional per-invocation options
   * @returns The aggregate result from all executed nodes
   */
  invoke(input: MultiAgentInput, options?: MultiAgentInvokeOptions): Promise<MultiAgentResult>

  /**
   * Execute the orchestrator and stream events as they occur.
   * @param input - Input to pass to the orchestrator
   * @param options - Optional per-invocation options
   * @returns Async generator yielding events and returning the final result
   */
  stream(
    input: MultiAgentInput,
    options?: MultiAgentInvokeOptions
  ): AsyncGenerator<MultiAgentStreamEvent, MultiAgentResult, undefined>

  /**
   * Register a hook callback for a specific orchestrator event type.
   *
   * @param eventType - The event class constructor to register the callback for
   * @param callback - The callback function to invoke when the event occurs
   * @returns Cleanup function that removes the callback when invoked
   */
  addHook<T extends HookableEvent>(eventType: HookableEventConstructor<T>, callback: HookCallback<T>): HookCleanup
}

/**
 * Detects whether a {@link MultiAgentInput} is a resume from an interrupted run and
 * normalizes its entries to {@link InterruptResponseContent} instances.
 *
 * Returns `undefined` for fresh input (string / content blocks / empty array).
 */
export function extractResumeResponses(input: MultiAgentInput): InterruptResponseContent[] | undefined {
  if (!Array.isArray(input) || input.length === 0) return undefined
  if (!isInterruptResponseContent(input[0])) return undefined

  const responses: InterruptResponseContent[] = []
  for (const entry of input) {
    if (entry instanceof InterruptResponseContent) {
      responses.push(entry)
    } else if (isInterruptResponseContent(entry)) {
      responses.push(InterruptResponseContent.fromJSON(entry as InterruptResponseContentData))
    } else {
      throw new TypeError('Must resume from interrupt with a list of interruptResponse content blocks only')
    }
  }
  return responses
}

/**
 * Groups a flat list of interrupt responses by the node that raised each interrupt.
 *
 * For each response, finds the node whose `NodeState.interrupts` contains an entry
 * with a matching id. Ids are globally unique (derived from model-assigned
 * `toolUseId`s) so each response maps to exactly one node. Nested orchestrators
 * carry their subtree's interrupts on the wrapping `MultiAgentNode`'s state, so a
 * matching response is forwarded as-is to the nested orchestrator, which does its
 * own grouping recursively.
 *
 * @throws Error if any response's interrupt id does not match any tracked node
 */
export function groupInterruptResponsesByNode(
  responses: InterruptResponseContent[],
  state: MultiAgentState
): Map<string, InterruptResponseContent[]> {
  const grouped = new Map<string, InterruptResponseContent[]>()
  for (const response of responses) {
    const id = response.interruptResponse.interruptId
    let target: string | undefined
    for (const [nodeId, nodeState] of state.nodes) {
      if (nodeState.interrupts.some((i) => i.id === id)) {
        target = nodeId
        break
      }
    }
    if (!target) {
      throw new Error(`interrupt_id=<${id}> | no node found with matching interrupt`)
    }
    const bucket = grouped.get(target) ?? []
    bucket.push(response)
    grouped.set(target, bucket)
  }
  return grouped
}

/**
 * Removes a stale INTERRUPTED result for the given node from both per-node history
 * and the orchestrator-level aggregate so a fresh result (from resume or cancel)
 * replaces it cleanly. No-op if the node isn't in an INTERRUPTED state.
 */
export function dropStaleInterruptedResult(nodeId: string, nodeState: NodeState, state: MultiAgentState): void {
  if (nodeState.status !== Status.INTERRUPTED) return
  if (nodeState.results[nodeState.results.length - 1]?.status === Status.INTERRUPTED) {
    nodeState.results.pop()
  }
  const idx = state.results.findIndex((r) => r.nodeId === nodeId && r.status === Status.INTERRUPTED)
  if (idx >= 0) state.results.splice(idx, 1)
}

/**
 * Records a hook-raised interrupt on a node that hadn't started executing: builds
 * the INTERRUPTED {@link NodeResult}, transitions `nodeState.status`, and appends
 * the result to `nodeState.results`. Returns the result so callers can route it
 * into their own queue/lifecycle machinery.
 *
 * Shared between Graph and Swarm so their hook-interrupt branches don't drift.
 */
export function recordHookInterrupt(nodeId: string, nodeState: NodeState): NodeResult {
  const result = new NodeResult({
    nodeId,
    status: Status.INTERRUPTED,
    duration: Date.now() - nodeState.startTime,
    interrupts: nodeState.interrupts,
  })
  nodeState.status = Status.INTERRUPTED
  nodeState.results.push(result)
  return result
}

/**
 * Applies interrupt responses to a node's own orchestrator-level interrupts and
 * returns the remaining responses — those bound for the child agent's interrupts.
 *
 * Orchestrator hooks (source `'multiagent-hook'`) store their interrupts on
 * `NodeState.interrupts` directly; the hook re-runs on resume and reads the stored
 * response. Agent-level interrupts aren't answerable here — they flow to the child
 * agent as resume input and are applied by the agent's own interrupt machinery.
 */
export function applyOrchestratorHookResponses(
  nodeState: NodeState,
  responses: InterruptResponseContent[]
): InterruptResponseContent[] {
  const forwarded: InterruptResponseContent[] = []
  for (const response of responses) {
    const local = nodeState.interrupts.find(
      (i) => i.id === response.interruptResponse.interruptId && i.source === 'multiagent-hook'
    )
    if (local) {
      local.response = response.interruptResponse.response
    } else {
      forwarded.push(response)
    }
  }
  return forwarded
}
