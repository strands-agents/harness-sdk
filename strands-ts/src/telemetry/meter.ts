/**
 * Agent loop metrics tracking.
 *
 * The {@link Meter} accumulates local metrics during agent invocation and
 * provides them as a read-only {@link AgentMetrics} snapshot via the
 * {@link Meter.metrics} getter for inclusion in {@link AgentResult}.
 *
 * When an OTEL MeterProvider is registered (via {@link setupMeter} or
 * directly), the Meter also emits counters and histograms through the
 * global OTEL metrics API, enabling export to OTLP backends.
 */

import type { Counter, Histogram, Meter as OtelMeter } from '@opentelemetry/api'
import { metrics as otelMetrics } from '@opentelemetry/api'
import type { Usage, Metrics, ModelMetadataEventData } from '../models/streaming.js'
import { accumulateUsage, createEmptyUsage, totalPromptTokens } from '../models/streaming.js'
import type { ToolUse } from '../tools/types.js'
import type { JSONSerializable } from '../types/json.js'
import { getServiceName } from './utils.js'

/**
 * Per-tool execution metrics.
 */
export interface ToolMetricsData {
  /**
   * Total number of calls to this tool.
   */
  callCount: number

  /**
   * Number of successful calls.
   */
  successCount: number

  /**
   * Number of failed calls.
   */
  errorCount: number

  /**
   * Total execution time in milliseconds.
   */
  totalTime: number
}

/**
 * Per-cycle usage tracking.
 */
export interface AgentLoopMetricsData {
  /**
   * Unique identifier for this cycle.
   */
  cycleId: string

  /**
   * Duration of this cycle in milliseconds.
   */
  duration: number

  /**
   * Token usage for this cycle.
   */
  usage: Usage
}

/**
 * Per-invocation metrics tracking.
 */
export interface InvocationMetricsData {
  /**
   * Cycle metrics for this invocation.
   */
  cycles: AgentLoopMetricsData[]

  /**
   * Accumulated token usage for this invocation.
   */
  usage: Usage
}

/**
 * JSON-serializable representation of AgentMetrics.
 */
export interface AgentMetricsData {
  /**
   * Total number of agent loop cycles executed across all invocations.
   */
  cycleCount: number

  /**
   * Accumulated token usage across all model invocations.
   */
  accumulatedUsage: Usage

  /**
   * Accumulated performance metrics across all model invocations.
   */
  accumulatedMetrics: Metrics

  /**
   * Per-invocation metrics for recent invocations.
   * Only the most recent 50 entries are retained.
   */
  agentInvocations: InvocationMetricsData[]

  /**
   * Per-tool execution metrics keyed by tool name.
   */
  toolMetrics: Record<string, ToolMetricsData>

  /**
   * The total prompt the model processed on the last invocation, including cached tokens.
   * Represents the current context window utilization.
   */
  latestContextSize?: number

  /**
   * Projected context size for the next model call (total prompt including cached tokens plus the
   * generated output from the last call).
   * Represents the baseline token count the next invocation will start with.
   */
  projectedContextSize?: number

  /**
   * Total duration of all cycles across all invocations in milliseconds.
   */
  totalDuration?: number
}

/**
 * Options for recording tool usage.
 */
interface ToolUsageOptions {
  /**
   * The tool that was used.
   */
  tool: ToolUse

  /**
   * Execution duration in milliseconds.
   */
  duration: number

  /**
   * Whether the tool call succeeded.
   */
  success: boolean
}

/**
 * Read-only snapshot of aggregated agent metrics.
 *
 * Returned by {@link Meter.metrics} and stored on {@link AgentResult}.
 * Provides access to cycle counts, tool usage, token consumption,
 * and per-invocation breakdowns. Supports serialization via {@link toJSON}.
 *
 * @example
 * ```typescript
 * const result = await agent.invoke('Hello')
 * console.log(result.metrics?.cycleCount)
 * console.log(result.metrics?.totalDuration)
 * console.log(result.metrics?.accumulatedData)
 * console.log(result.metrics?.toolMetrics)
 * console.log(JSON.stringify(result.metrics))
 * ```
 */
export class AgentMetrics implements JSONSerializable<AgentMetricsData> {
  /**
   * Total number of agent loop cycles executed across all invocations.
   */
  readonly cycleCount: number

  /**
   * Accumulated token usage across all model invocations.
   */
  readonly accumulatedUsage: Usage

  /**
   * Accumulated performance metrics across all model invocations.
   */
  readonly accumulatedMetrics: Metrics

  /**
   * Per-invocation metrics for recent invocations.
   * Only the most recent 50 entries are retained to prevent unbounded memory growth.
   * For full history, collect {@link latestAgentInvocation} from each {@link AgentResult}.
   */
  readonly agentInvocations: InvocationMetricsData[]

  /**
   * Per-tool execution metrics keyed by tool name.
   */
  readonly toolMetrics: Record<string, ToolMetricsData>

  /**
   * The total prompt the model processed on the last invocation, including cached tokens.
   * Represents the current context window utilization.
   * Returns `undefined` when no invocations have occurred.
   */
  readonly latestContextSize: number | undefined

  /**
   * Projected context size for the next model call (total prompt including cached tokens plus the
   * generated output from the last call).
   * Represents the baseline token count the next invocation will start with.
   * Returns `undefined` when no invocations have occurred.
   */
  readonly projectedContextSize: number | undefined

  /**
   * Total duration of all cycles across all invocations in milliseconds.
   */
  readonly totalDuration: number

  constructor(data?: Partial<AgentMetricsData>) {
    this.cycleCount = data?.cycleCount ?? 0
    this.accumulatedUsage = data?.accumulatedUsage ?? createEmptyUsage()
    this.accumulatedMetrics = data?.accumulatedMetrics ?? { latencyMs: 0 }
    this.agentInvocations = data?.agentInvocations ?? []
    this.toolMetrics = data?.toolMetrics ?? {}
    this.latestContextSize = data?.latestContextSize
    this.projectedContextSize = data?.projectedContextSize
    this.totalDuration = data?.totalDuration ?? 0
  }

  /**
   * The most recent agent invocation, or undefined if none exist.
   */
  get latestAgentInvocation(): InvocationMetricsData | undefined {
    return this.agentInvocations.length > 0 ? this.agentInvocations[this.agentInvocations.length - 1] : undefined
  }

  /**
   * Accumulated usage and performance metrics across all model invocations.
   */
  get accumulatedData(): { usage: Usage; metrics: Metrics } {
    return { usage: this.accumulatedUsage, metrics: this.accumulatedMetrics }
  }

  /**
   * Average cycle duration in milliseconds, or 0 if no cycles exist.
   */
  get averageCycleTime(): number {
    return this.cycleCount > 0 ? this.totalDuration / this.cycleCount : 0
  }

  /**
   * Per-tool execution statistics with computed averages and rates.
   */
  get toolUsage(): Record<string, ToolMetricsData & { averageTime: number; successRate: number }> {
    const usage: Record<string, ToolMetricsData & { averageTime: number; successRate: number }> = {}
    for (const [toolName, toolEntry] of Object.entries(this.toolMetrics)) {
      usage[toolName] = {
        ...toolEntry,
        averageTime: toolEntry.callCount > 0 ? toolEntry.totalTime / toolEntry.callCount : 0,
        successRate: toolEntry.callCount > 0 ? toolEntry.successCount / toolEntry.callCount : 0,
      }
    }
    return usage
  }

  /**
   * Returns a JSON-serializable representation of all collected metrics.
   * Called automatically by JSON.stringify().
   *
   * @returns A plain object suitable for round-trip serialization
   */
  toJSON(): AgentMetricsData {
    return {
      cycleCount: this.cycleCount,
      accumulatedUsage: this.accumulatedUsage,
      accumulatedMetrics: this.accumulatedMetrics,
      agentInvocations: this.agentInvocations,
      toolMetrics: this.toolMetrics,
      totalDuration: this.totalDuration,
      ...(this.latestContextSize !== undefined && { latestContextSize: this.latestContextSize }),
      ...(this.projectedContextSize !== undefined && { projectedContextSize: this.projectedContextSize }),
    }
  }
}

/**
 * Maximum number of invocation history entries retained by the Meter.
 * Prevents unbounded memory growth on long-lived Agent instances.
 * Users who need full history can collect per-invocation metrics
 * from successive AgentResult objects.
 */
const MAX_INVOCATION_HISTORY = 50

/**
 * Accumulates local metrics during agent invocation.
 *
 * Tracks cycle counts, token usage, tool execution stats, and model latency.
 * Use the {@link metrics} getter to obtain a read-only {@link AgentMetrics}
 * snapshot for inclusion in {@link AgentResult}.
 *
 * When an OTEL MeterProvider is registered, the same data is also emitted
 * as OTEL counters and histograms via the global metrics API. If no
 * provider is registered the OTEL meter is a no-op and adds no overhead.
 */
export class Meter {
  /**
   * Number of agent loop cycles executed.
   */
  private _cycleCount: number = 0

  /**
   * Accumulated token usage across all model invocations.
   */
  private readonly _accumulatedUsage: Usage = createEmptyUsage()

  /**
   * Accumulated performance metrics across all model invocations.
   */
  private readonly _accumulatedMetrics: Metrics = { latencyMs: 0 }

  /**
   * Per-invocation metrics.
   */
  private readonly _agentInvocations: InvocationMetricsData[] = []

  /**
   * Per-tool execution metrics keyed by tool name.
   */
  private readonly _toolMetrics: Record<string, ToolMetricsData> = {}

  /**
   * The total prompt the model processed on the last invocation, including cached tokens.
   */
  private _latestContextSize: number | undefined

  /**
   * Projected context size for the next model call (total prompt including cached tokens plus output).
   */
  private _projectedContextSize: number | undefined

  /**
   * Running total of all cycle durations in milliseconds.
   */
  private _totalDuration: number = 0

  // OTEL instruments (no-op when no MeterProvider is registered)
  private readonly _otelMeter: OtelMeter
  private readonly _otelCycleCounter: Counter
  private readonly _otelInvocationCounter: Counter
  private readonly _otelCycleDuration: Histogram
  private readonly _otelToolCallCounter: Counter
  private readonly _otelToolErrorCounter: Counter
  private readonly _otelToolDuration: Histogram
  private readonly _otelInputTokens: Counter
  private readonly _otelOutputTokens: Counter
  private readonly _otelModelLatency: Histogram
  private readonly _otelTimeToFirstToken: Histogram

  constructor() {
    this._otelMeter = otelMetrics.getMeter(getServiceName())

    this._otelCycleCounter = this._otelMeter.createCounter('gen_ai.agent.cycle.count', {
      description: 'Number of agent loop cycles executed',
    })
    this._otelInvocationCounter = this._otelMeter.createCounter('gen_ai.agent.invocation.count', {
      description: 'Number of agent invocations',
    })
    this._otelCycleDuration = this._otelMeter.createHistogram('gen_ai.agent.cycle.duration', {
      description: 'Duration of agent loop cycles in milliseconds',
      unit: 'ms',
    })
    this._otelToolCallCounter = this._otelMeter.createCounter('gen_ai.agent.tool.call.count', {
      description: 'Number of tool calls',
    })
    this._otelToolErrorCounter = this._otelMeter.createCounter('gen_ai.agent.tool.error.count', {
      description: 'Number of failed tool calls',
    })
    this._otelToolDuration = this._otelMeter.createHistogram('gen_ai.agent.tool.duration', {
      description: 'Duration of tool calls in milliseconds',
      unit: 'ms',
    })
    this._otelInputTokens = this._otelMeter.createCounter('gen_ai.agent.tokens.input', {
      description: 'Input tokens consumed',
    })
    this._otelOutputTokens = this._otelMeter.createCounter('gen_ai.agent.tokens.output', {
      description: 'Output tokens consumed',
    })
    this._otelModelLatency = this._otelMeter.createHistogram('gen_ai.agent.model.latency', {
      description: 'Model invocation latency in milliseconds',
      unit: 'ms',
    })
    // OTel GenAI semconv requires seconds for this metric, unlike the SDK-internal histograms which use ms
    this._otelTimeToFirstToken = this._otelMeter.createHistogram('gen_ai.server.time_to_first_token', {
      description: 'Time to generate first token for successful responses',
      unit: 's',
    })
  }

  /**
   * Begin tracking a new agent invocation.
   * Creates a new InvocationMetricsData entry for per-invocation metrics.
   * Evicts the oldest entry when the history exceeds MAX_INVOCATION_HISTORY.
   */
  startNewInvocation(): void {
    if (this._agentInvocations.length >= MAX_INVOCATION_HISTORY) {
      this._agentInvocations.shift()
    }

    this._agentInvocations.push({
      cycles: [],
      usage: createEmptyUsage(),
    })
    this._otelInvocationCounter.add(1)
  }

  /**
   * Start a new agent loop cycle.
   *
   * @returns The cycle id and start time
   */
  startCycle(): { cycleId: string; startTime: number } {
    this._cycleCount++
    this._otelCycleCounter.add(1)

    const cycleId = `cycle-${this._cycleCount}`
    const startTime = Date.now()

    const latestInvocation = this._latestAgentInvocation
    if (latestInvocation) {
      latestInvocation.cycles.push({
        cycleId: cycleId,
        duration: 0,
        usage: createEmptyUsage(),
      })
    }

    return { cycleId, startTime }
  }

  /**
   * End the current agent loop cycle and record its duration.
   *
   * @param startTime - The timestamp when the cycle started (milliseconds since epoch)
   */
  endCycle(startTime: number): void {
    const duration = Date.now() - startTime
    this._otelCycleDuration.record(duration)

    this._totalDuration += duration

    const latestInvocation = this._latestAgentInvocation
    if (latestInvocation) {
      const cycles = latestInvocation.cycles
      if (cycles.length > 0) {
        cycles[cycles.length - 1]!.duration = duration
      }
    }
  }

  /**
   * Record metrics for a completed tool invocation.
   *
   * @param options - Tool usage recording options
   */
  endToolCall(options: ToolUsageOptions): void {
    const { tool, duration, success } = options
    const toolName = tool.name

    if (!this._toolMetrics[toolName]) {
      this._toolMetrics[toolName] = { callCount: 0, successCount: 0, errorCount: 0, totalTime: 0 }
    }

    const toolEntry = this._toolMetrics[toolName]!
    toolEntry.callCount++
    toolEntry.totalTime += duration

    const attrs = { 'gen_ai.tool.name': toolName }
    this._otelToolCallCounter.add(1, attrs)
    this._otelToolDuration.record(duration, attrs)

    if (success) {
      toolEntry.successCount++
    } else {
      toolEntry.errorCount++
      this._otelToolErrorCounter.add(1, attrs)
    }
  }

  /**
   * Update loop-level metrics from a model response.
   *
   * Call this after each model invocation within a cycle to
   * accumulate usage and latency.
   *
   * @param metadata - The metadata event from a model invocation, or undefined if unavailable
   */
  updateCycle(metadata?: ModelMetadataEventData): void {
    if (metadata) {
      this._updateFromMetadata(metadata)
    }
  }

  /**
   * Read-only snapshot of the accumulated metrics.
   * Returns an AgentMetrics instance suitable for inclusion in AgentResult.
   */
  get metrics(): AgentMetrics {
    return new AgentMetrics({
      cycleCount: this._cycleCount,
      accumulatedUsage: this._accumulatedUsage,
      accumulatedMetrics: this._accumulatedMetrics,
      agentInvocations: this._agentInvocations,
      toolMetrics: this._toolMetrics,
      totalDuration: this._totalDuration,
      ...(this._latestContextSize !== undefined && { latestContextSize: this._latestContextSize }),
      ...(this._projectedContextSize !== undefined && { projectedContextSize: this._projectedContextSize }),
    })
  }

  /**
   * The most recent agent invocation, or undefined if none exist.
   */
  private get _latestAgentInvocation(): InvocationMetricsData | undefined {
    return this._agentInvocations.length > 0 ? this._agentInvocations[this._agentInvocations.length - 1] : undefined
  }

  /**
   * Update accumulated usage and metrics from a model metadata event.
   *
   * @param metadata - The metadata event from a model invocation
   */
  private _updateFromMetadata(metadata: ModelMetadataEventData): void {
    if (metadata.usage) {
      this._updateUsage(metadata.usage)
    }
    if (metadata.metrics) {
      this._accumulatedMetrics.latencyMs += metadata.metrics.latencyMs
      this._otelModelLatency.record(metadata.metrics.latencyMs)

      if (metadata.metrics.timeToFirstByteMs !== undefined && metadata.metrics.timeToFirstByteMs > 0) {
        this._otelTimeToFirstToken.record(metadata.metrics.timeToFirstByteMs / 1000)
      }
    }
  }

  /**
   * Update the accumulated token usage with new usage data.
   *
   * @param usage - The usage data to accumulate
   */
  private _updateUsage(usage: Usage): void {
    accumulateUsage(this._accumulatedUsage, usage)
    this._latestContextSize = totalPromptTokens(usage)
    this._projectedContextSize = totalPromptTokens(usage) + usage.outputTokens

    this._otelInputTokens.add(usage.inputTokens)
    this._otelOutputTokens.add(usage.outputTokens)

    const latestInvocation = this._latestAgentInvocation
    if (latestInvocation) {
      accumulateUsage(latestInvocation.usage, usage)

      const cycles = latestInvocation.cycles
      if (cycles.length > 0) {
        accumulateUsage(cycles[cycles.length - 1]!.usage, usage)
      }
    }
  }
}
