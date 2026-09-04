/**
 * ProfilerObserver — attaches to an Agent as a Plugin.
 * Captures tool calls via hooks. Metrics are patched in after each invoke().
 */

import { BeforeToolCallEvent, AfterToolCallEvent, BeforeInvocationEvent, AfterInvocationEvent, ModelMessageEvent } from '../../../strands-ts/src/hooks/events.js'
import { TextBlock } from '../../../strands-ts/src/types/messages.js'
import type { LocalAgent, AgentResult } from '../../../strands-ts/src/types/agent.js'
import type { Plugin } from '../../../strands-ts/src/plugins/plugin.js'
import type { Invariant } from './invariants.js'
import type { InvocationTrace, ToolCallTrace } from './types.js'

export class ProfilerObserver implements Plugin {
  readonly name = 'strandly-experiment'

  private _invocations: InvocationTrace[] = []
  private _invariants: Invariant[] = []
  private _currentToolCalls: ToolCallTrace[] = []
  private _currentAssistantTurns: string[] = []
  private _invocationAssistantTurns: string[][] = []
  private _pendingTools = new Map<string, { name: string; input: unknown; startTime: number }>()
  private _invocationStart = 0
  private _invocationInput = ''
  private _agent: LocalAgent | undefined
  // The SDK reports model latency as a session-cumulative total; track what
  // we've already attributed so each invocation gets only its own slice.
  private _priorCumulativeLatencyMs = 0

  initAgent(agent: LocalAgent): void {
    this._agent = agent
    agent.addHook(BeforeInvocationEvent, () => {
      this._invocationStart = Date.now()
      this._currentToolCalls = []
      this._currentAssistantTurns = []
      this._pendingTools.clear()
    })

    agent.addHook(ModelMessageEvent, (event) => {
      const text = event.message.content
        ?.filter((block: unknown) => block instanceof TextBlock)
        .map((block: TextBlock) => block.text)
        .join('')
      if (text) this._currentAssistantTurns.push(text)
    })

    agent.addHook(BeforeToolCallEvent, (event) => {
      this._pendingTools.set(event.toolUse.toolUseId, {
        name: event.toolUse.name,
        input: event.toolUse.input,
        startTime: Date.now(),
      })
    })

    agent.addHook(AfterToolCallEvent, (event) => {
      const pending = this._pendingTools.get(event.toolUse.toolUseId)
      if (!pending) return

      const resultContent = event.result.content
        .map((block) => ('text' in block ? (block as any).text : JSON.stringify(block)))
        .join('')

      this._currentToolCalls.push({
        name: pending.name,
        input: pending.input,
        output: resultContent,
        durationMs: Date.now() - pending.startTime,
        success: event.result.status === 'success',
        error: event.error?.message,
        resultSize: resultContent.length,
      })

      this._pendingTools.delete(event.toolUse.toolUseId)
    })

    agent.addHook(AfterInvocationEvent, (event) => {
      const agentMessages = (event.agent as any).messages
      const lastMsg = agentMessages?.at(-1)

      const outputText = lastMsg?.content
        ?.filter((block: unknown) => block instanceof TextBlock)
        .map((block: TextBlock) => block.text)
        .join('') ?? ''

      this._invocations.push({
        input: this._invocationInput,
        output: outputText,
        durationMs: Date.now() - this._invocationStart,
        cycleCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        modelLatencyMs: 0,
        contextSize: 0,
        stopReason: 'unknown',
        messageCountAfter: agentMessages?.length ?? 0,
        toolCalls: [...this._currentToolCalls],
      })
      this._invocationAssistantTurns.push([...this._currentAssistantTurns])
    })
  }

  /**
   * Call after each agent.invoke() to patch metrics from the result
   * into the last recorded invocation.
   */
  recordResult(result: AgentResult): void {
    const last = this._invocations.at(-1)
    if (!last) return

    const metrics = result.metrics
    const lastInvocation = metrics?.latestAgentInvocation
    const usage = lastInvocation?.usage

    last.stopReason = result.stopReason
    last.cycleCount = lastInvocation?.cycles.length ?? 0
    last.inputTokens = usage?.inputTokens ?? 0
    last.outputTokens = usage?.outputTokens ?? 0
    last.totalTokens = usage?.totalTokens ?? 0
    last.cacheReadTokens = usage?.cacheReadInputTokens ?? 0
    last.cacheWriteTokens = usage?.cacheWriteInputTokens ?? 0
    last.contextSize = metrics?.latestContextSize ?? 0

    // latencyMs is cumulative across the shared Agent's invocations; attribute
    // only the delta since the previous recordResult to this invocation.
    const cumulativeLatency = metrics?.accumulatedMetrics.latencyMs ?? 0
    last.modelLatencyMs = Math.max(0, cumulativeLatency - this._priorCumulativeLatencyMs)
    this._priorCumulativeLatencyMs = cumulativeLatency
  }

  recordInvocationInput(input: string): void {
    this._invocationInput = input
  }

  /**
   * Record deterministic SDK-invariant results — the primary signal. Call
   * after the agent finishes, passing the results of checks from
   * `src/invariants.ts` (and any scenario-specific state checks).
   */
  recordInvariants(...invariants: Invariant[]): void {
    this._invariants.push(...invariants)
  }

  get invocations(): InvocationTrace[] {
    return this._invocations
  }

  get invariants(): Invariant[] {
    return this._invariants
  }

  /** Assistant reasoning grouped by invocation, with input labels and metrics. */
  get transcript(): string {
    return this._invocations.map((inv, i) => {
      const inputPreview = inv.input.length > 120 ? inv.input.slice(0, 117) + '...' : inv.input
      const header = `## invocation ${i + 1}: "${inputPreview}"\n## ${inv.cycleCount} cycles, ${inv.inputTokens + inv.outputTokens} tok, stop=${inv.stopReason}`
      const turns = this._invocationAssistantTurns[i] ?? []
      const body = turns.join('\n\n')
      return `${header}\n\n${body}`
    }).join('\n\n---\n\n')
  }

  reset(): void {
    this._invocations = []
    this._invariants = []
    this._currentToolCalls = []
    this._pendingTools.clear()
    this._priorCumulativeLatencyMs = 0
  }
}
