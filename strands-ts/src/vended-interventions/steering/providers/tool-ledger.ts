/**
 * Ledger context provider for comprehensive agent activity tracking.
 *
 * Tracks tool call history with inputs, outputs, timing, and success/failure status.
 * This audit trail enables steering handlers to make informed guidance decisions
 * based on agent behavior patterns and history.
 */

import { AfterToolCallEvent, BeforeToolCallEvent } from '../../../hooks/events.js'
import type { LocalAgent } from '../../../types/agent.js'
import type { ToolResultStatus } from '../../../tools/types.js'
import type { JSONValue } from '../../../types/json.js'
import type { SteeringContextData, SteeringContextProvider } from './context-provider.js'

/**
 * A single entry in the tool call ledger.
 */
interface LedgerToolCall {
  /** Tool input arguments. */
  args: JSONValue
  /** When the tool finished executing. */
  endTime?: string
  /** Error message if the tool failed. */
  error?: string | null
  /** Unique tool use identifier. */
  id: string
  /** Tool name. */
  name: string
  /** Tool execution result. */
  result?: JSONValue
  /** When the tool call was initiated. */
  startTime: string
  /** Current execution state: pending while in-flight, then the underlying {@link ToolResultStatus}. */
  status: 'pending' | ToolResultStatus
}

/**
 * Configuration for {@link ToolLedgerProvider}.
 */
export interface ToolLedgerProviderConfig {
  /** Maximum number of tool calls to retain. Older entries are dropped. Defaults to 100. */
  maxEntries?: number
  /** Identifier for this provider instance. Defaults to `'strands:steering:toolLedger'`. */
  name?: string
}

/**
 * Context provider that tracks tool call history within a single invocation.
 *
 * Records every tool invocation with inputs, execution time, and success/failure status.
 * The ledger is available to steering handlers for pattern detection
 * (e.g., repeated failures, excessive retries).
 *
 * When the ledger exceeds maxEntries, the oldest entries are dropped.
 *
 * @example
 * ```typescript
 * const handler = new LLMSteeringHandler({
 *   systemPrompt: '...',
 *   contextProviders: [new ToolLedgerProvider()],
 * })
 * ```
 */
export class ToolLedgerProvider implements SteeringContextProvider {
  readonly name: string
  private readonly _maxEntries: number = 100
  private readonly _toolCalls: LedgerToolCall[] = []

  constructor(config?: ToolLedgerProviderConfig) {
    this.name = config?.name ?? 'strands:steering:toolLedger'
    if (config?.maxEntries !== undefined) {
      this._maxEntries = config.maxEntries
    }
  }

  observeAgent(agent: LocalAgent): void {
    agent.addHook(BeforeToolCallEvent, (event) => this._onBeforeToolCall(event))
    agent.addHook(AfterToolCallEvent, (event) => this._onAfterToolCall(event))
  }

  private _onBeforeToolCall(event: BeforeToolCallEvent): void {
    this._toolCalls.push({
      startTime: new Date().toISOString(),
      id: event.toolUse.toolUseId,
      name: event.toolUse.name,
      args: event.toolUse.input,
      status: 'pending',
    })
    if (this._toolCalls.length > this._maxEntries) {
      this._toolCalls.splice(0, this._toolCalls.length - this._maxEntries)
    }
  }

  private _onAfterToolCall(event: AfterToolCallEvent): void {
    const toolUseId = event.toolUse.toolUseId
    for (let i = this._toolCalls.length - 1; i >= 0; i--) {
      const call = this._toolCalls[i]
      if (call?.id === toolUseId) {
        call.endTime = new Date().toISOString()
        call.status = event.result.status
        call.result = event.result.content.map((block) => block.toJSON()) as JSONValue
        call.error = event.error ? event.error.message : null
        break
      }
    }
  }

  /**
   * Return the current ledger snapshot.
   */
  get context(): SteeringContextData {
    return {
      type: 'toolLedger',
      calls: this._toolCalls as unknown as JSONValue,
    }
  }
}
