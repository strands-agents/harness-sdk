/**
 * OpenTelemetry tracing and local execution trace management.
 *
 * This module provides tracing capabilities using OpenTelemetry,
 * enabling trace data to be sent to OTLP endpoints.
 *
 * Uses a fully stateful approach via OpenTelemetry's context propagation.
 * Parent-child relationships are established automatically through
 * context.active(). Use context.with() to set a span as active before
 * creating child spans.
 *
 * Lightweight in-memory LocalTrace trees are always collected regardless
 * of OTel configuration and surfaced via AgentResult.traces.
 *
 * @example
 * ```typescript
 * const tracer = new Tracer()
 * const parentSpan = tracer.startAgentSpan({ ... })
 *
 * context.with(trace.setSpan(context.active(), parentSpan), async () => {
 *   const modelSpan = tracer.startModelInvokeSpan({ messages })
 *   tracer.endModelInvokeSpan(modelSpan)
 * })
 *
 * tracer.endAgentSpan(parentSpan)
 * ```
 */

import { context, isSpanContextValid, ROOT_CONTEXT, SpanStatusCode, SpanKind, trace } from '@opentelemetry/api'
import type { Span, Tracer as OtelTracer, SpanOptions, AttributeValue, Link, SpanContext } from '@opentelemetry/api'
import { logger } from '../logging/index.js'
import type {
  EndAgentSpanOptions,
  EndModelSpanOptions,
  EndToolCallSpanOptions,
  EndAgentLoopSpanOptions,
  StartAgentSpanOptions,
  StartModelInvokeSpanOptions,
  StartToolCallSpanOptions,
  StartAgentLoopSpanOptions,
  StartMultiAgentSpanOptions,
  EndMultiAgentSpanOptions,
  StartNodeSpanOptions,
  EndNodeSpanOptions,
  StartMemorySearchSpanOptions,
  EndMemorySearchSpanOptions,
  StartMemoryAddSpanOptions,
  EndMemoryAddSpanOptions,
  StartMemoryInjectSpanOptions,
  EndMemoryInjectSpanOptions,
  StartMemoryExtractSpanOptions,
  EndMemoryExtractSpanOptions,
  Usage,
  Metrics,
} from './types.js'
import type { ContentBlock, Message, SystemPrompt } from '../types/messages.js'
import type { JSONSerializable } from '../types/json.js'
import { jsonReplacer } from './json.js'
import { getServiceName } from './utils.js'
import { totalPromptTokens } from '../models/streaming.js'

/**
 * JSON-serializable representation of LocalTrace.
 */
interface AgentTraceData {
  id: string
  name: string
  parentId: string | null
  startTime: number
  endTime: number | null
  duration: number
  children: AgentTraceData[]
  metadata: Record<string, string>
  message: Message | null
}

/**
 * Execution trace for performance analysis.
 * Tracks timing and hierarchy of operations within the agent loop.
 * Fields default to null for JSON serialization compatibility.
 */
export class AgentTrace implements JSONSerializable<AgentTraceData> {
  /** Unique identifier (UUID) for this trace. */
  readonly id: string
  /** Human-readable display name (e.g., "Cycle 1", "Tool: calc", "stream_messages"). */
  readonly name: string
  /** ID of the parent trace, if this trace is nested. Null for root traces. */
  readonly parentId: string | null
  /** Start time in milliseconds since epoch. */
  readonly startTime: number
  /** End time in milliseconds since epoch. Null until trace is ended. */
  endTime: number | null = null
  /** Duration in milliseconds (endTime - startTime). */
  duration: number = 0
  /** Child traces nested under this trace. */
  readonly children: AgentTrace[] = []
  /** Additional metadata for this trace (e.g., cycleId, toolUseId, toolName). */
  readonly metadata: Record<string, string> = {}
  /** Message associated with this trace (e.g., model output). Null if not applicable. */
  message: Message | null = null

  /**
   * @param name - Display name for this trace
   * @param options - Optional configuration for parent and startTime
   */
  constructor(name: string, options?: { parent?: AgentTrace; startTime?: number }) {
    this.id = globalThis.crypto.randomUUID()
    this.name = name
    this.parentId = options?.parent?.id ?? null
    this.startTime = options?.startTime ?? Date.now()

    if (options?.parent) {
      options.parent.children.push(this)
    }
  }

  /**
   * @param endTime - Optional end time in milliseconds since epoch
   */
  end(endTime?: number): void {
    this.endTime = endTime ?? Date.now()
    this.duration = this.endTime - this.startTime
  }

  toJSON(): AgentTraceData {
    return {
      id: this.id,
      name: this.name,
      parentId: this.parentId,
      startTime: this.startTime,
      endTime: this.endTime,
      duration: this.duration,
      children: this.children.map((child) => child.toJSON()),
      metadata: this.metadata,
      message: this.message,
    }
  }
}

/**
 * In-memory execution trace state, collected independently of OTel.
 * Always active regardless of whether setupTracer() has been called.
 */
interface AgentTraceState {
  /** Completed and in-progress cycle traces. */
  traces: AgentTrace[]
  /** Current cycle trace, parents model and tool traces. */
  currentCycle?: AgentTrace | undefined
  /** Current model invocation trace. */
  currentModel?: AgentTrace | undefined
  /** Current tool call trace. */
  currentTool?: AgentTrace | undefined
}

/**
 * Manages both OpenTelemetry spans and local execution traces for agent operations.
 *
 * OTel spans are exported to external observability backends (Jaeger, X-Ray, etc.)
 * when configured via setupTracer(). Local traces are lightweight, in-memory timing
 * trees that are always collected regardless of OTel configuration and returned
 * in AgentResult.traces for programmatic access.
 *
 *
 */
export class Tracer {
  /**
   * OpenTelemetry tracer instance obtained from the global API.
   */
  private readonly _tracer: OtelTracer

  /**
   * Whether to use latest experimental semantic conventions.
   *
   * Enabled via `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental`.
   * Changes attribute names (e.g., `gen_ai.system` → `gen_ai.provider.name`) and
   * event formats (single `gen_ai.client.inference.operation.details` event vs
   * separate per-message events). Enable when your observability backend supports
   * newer GenAI conventions.
   *
   * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/
   */
  private readonly _useLatestConventions: boolean

  /**
   * Whether to include full tool JSON schemas in span attributes.
   *
   * Enabled via `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_tool_definitions`.
   * Useful for debugging tool configuration issues. Disabled by default to
   * reduce span payload size and observability costs.
   *
   * Can be combined with other options:
   * `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental,gen_ai_tool_definitions`
   */
  private readonly _includeToolDefinitions: boolean

  /**
   * Custom attributes to include on all spans created by this tracer.
   */
  private readonly _traceAttributes: Record<string, AttributeValue>

  /** Root span for the current agent invocation. */
  private _agentSpan: Span | undefined

  /** Span for the current agent loop cycle, used to parent model and tool spans. */
  private _loopSpan: Span | undefined

  /** Root span for the current multi-agent orchestration, used to parent node spans. */
  private _multiAgentSpan: Span | undefined

  /**
   * Whether Langfuse is configured as the OTLP endpoint.
   * Detected from OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
   * or LANGFUSE_BASE_URL environment variables.
   */
  private readonly _isLangfuse: boolean

  /**
   * Whether to record message content as span attributes instead of span events.
   *
   * True when the backend cannot read span events (Langfuse) or the opt-in is set via
   * `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_span_attributes_only`. Per OpenTelemetry the span-event
   * recording API is deprecated, and non-timestamped span details such as the canonical
   * `gen_ai.*.messages` attributes should be recorded as span attributes instead. This flag is
   * passed by the aggregated content paths (latest-convention `gen_ai.*` messages and the
   * `memory.query`/`memory.content` events); it never reaches the legacy per-message events
   * (which reuse a `content` key and would collide as attributes).
   *
   * @see https://opentelemetry.io/blog/2026/deprecating-span-events/
   */
  private readonly _spanAttributesOnly: boolean

  /** In-memory execution trace state, collected independently of OTEL. */
  private readonly _traceState: AgentTraceState = { traces: [] }

  /**
   * Initialize the tracer with OpenTelemetry configuration.
   * Reads OTEL_SEMCONV_STABILITY_OPT_IN to determine convention version.
   * Gets tracer from the global API to ensure ground truth - works correctly
   * whether the user or Strands initialized the tracer provider.
   *
   * @param traceAttributes - Optional custom attributes to include on all spans
   */
  constructor(traceAttributes?: Record<string, AttributeValue>) {
    this._traceAttributes = traceAttributes ?? {}

    // Read semantic convention version from environment
    const optInValues = Tracer._parseSemconvOptIn()
    this._useLatestConventions = optInValues.has('gen_ai_latest_experimental')
    this._includeToolDefinitions = optInValues.has('gen_ai_tool_definitions')

    this._isLangfuse = Tracer._detectLangfuse()
    this._spanAttributesOnly = this._isLangfuse || optInValues.has('gen_ai_span_attributes_only')

    // Get tracer from global API to ensure ground truth
    this._tracer = trace.getTracer(getServiceName())
  }

  /**
   * All local execution traces collected by this tracer.
   */
  get localTraces(): AgentTrace[] {
    return this._traceState.traces
  }

  /**
   * Start an agent invocation span.
   * Returns the span which should be ended with endAgentSpan.
   * Parents to the current active span from context.active().
   *
   * @param options - Options for starting the agent span
   */
  startAgentSpan(options: StartAgentSpanOptions): Span | null {
    const { messages, agentName, agentId, modelId, tools, traceAttributes, toolsConfig, systemPrompt } = options

    // Reset local trace state for this invocation
    this._traceState.traces = []
    this._traceState.currentCycle = undefined
    this._traceState.currentModel = undefined
    this._traceState.currentTool = undefined

    try {
      const spanName = `invoke_agent ${agentName}`
      const attributes = this._getCommonAttributes('invoke_agent')
      attributes['gen_ai.agent.name'] = agentName
      attributes['name'] = spanName
      if (agentId) attributes['gen_ai.agent.id'] = agentId
      if (modelId) attributes['gen_ai.request.model'] = modelId

      if (tools && tools.length > 0) {
        const toolNames = tools.map((t) => t.name)
        attributes['gen_ai.agent.tools'] = JSON.stringify(toolNames, jsonReplacer)
      }

      if (this._includeToolDefinitions && toolsConfig) {
        attributes['gen_ai.tool.definitions'] = JSON.stringify(toolsConfig, jsonReplacer)
      }

      if (systemPrompt !== undefined) {
        attributes['system_prompt'] = JSON.stringify(systemPrompt, jsonReplacer)
      }

      const mergedAttributes = { ...attributes, ...this._traceAttributes, ...traceAttributes }
      const span = this._startSpan({ name: spanName, attributes: mergedAttributes, spanKind: SpanKind.INTERNAL })

      this._addEventMessages(span, messages)

      this._agentSpan = span

      return span
    } catch (error) {
      logger.warn(`error=<${error}> | failed to start agent span`)
      return null
    }
  }

  /**
   * End an agent invocation span.
   *
   * @param span - The span to end, or null if span creation failed
   * @param options - Options for ending the span including response, error, and usage data
   */
  endAgentSpan(span: Span | null, options: EndAgentSpanOptions = {}): void {
    // Clear stale state from any previous invocation
    this._agentSpan = undefined
    this._loopSpan = undefined

    // Clear local trace state
    this._traceState.currentCycle = undefined
    this._traceState.currentModel = undefined
    this._traceState.currentTool = undefined

    if (!span) return

    const { response, error, accumulatedUsage, stopReason } = options

    try {
      const attributes: Record<string, AttributeValue> = {}
      if (accumulatedUsage) this._setUsageAttributes(attributes, accumulatedUsage)
      // Langfuse auto-generates "generation" observations for spans with token usage,
      // which duplicates the token counts already reported on this agent span.
      // Setting observation.type to "span" prevents Langfuse from creating that
      // extra generation, avoiding double-counted tokens in dashboards.
      // See https://github.com/langfuse/langfuse/issues/7549
      if (this._isLangfuse) attributes['langfuse.observation.type'] = 'span'
      if (response !== undefined) this._addResponseEvent(span, response, stopReason)

      this._endSpan(span, attributes, error)
    } catch (err) {
      logger.warn(`error=<${err}> | failed to end agent span`)
    }
  }

  /**
   * Start a model invocation span.
   * Parents to the current active span from context.active().
   *
   * @param options - Options for starting the model invocation span
   */
  startModelInvokeSpan(options: StartModelInvokeSpanOptions): Span | null {
    const { messages, modelId, systemPrompt } = options

    // Create local model trace as child of current cycle
    this._traceState.currentModel = new AgentTrace(
      'stream_messages',
      this._traceState.currentCycle ? { parent: this._traceState.currentCycle } : undefined
    )

    try {
      const attributes = this._getCommonAttributes('chat')
      if (modelId) attributes['gen_ai.request.model'] = modelId

      const span = this._startSpan({
        name: 'chat',
        attributes,
        spanKind: SpanKind.INTERNAL,
        ...(this._loopSpan && { parentSpan: this._loopSpan }),
      })
      this._addSystemPromptEvent(span, systemPrompt)
      this._addEventMessages(span, messages)

      return span
    } catch (error) {
      logger.warn(`error=<${error}> | failed to start model invoke span`)
      return null
    }
  }

  /**
   * End a model invocation span.
   *
   * @param span - The span to end, or null if span creation failed
   * @param options - Options for ending the span including usage, metrics, error, and output
   */
  endModelInvokeSpan(span: Span | null, options: EndModelSpanOptions = {}): void {
    // End local model trace and attach output message
    if (this._traceState.currentModel) {
      if (options.output) {
        this._traceState.currentModel.message = options.output
      }
      this._traceState.currentModel.end()
      this._traceState.currentModel = undefined
    }

    if (!span) return

    const { usage, metrics, error, output, stopReason } = options

    try {
      if (output !== undefined) this._addOutputEvent(span, output, stopReason)

      const attributes: Record<string, AttributeValue> = {}
      if (usage) {
        this._setUsageAttributes(attributes, usage)
        if (metrics) this._setMetricsAttributes(attributes, metrics)
      }

      this._endSpan(span, attributes, error)
    } catch (err) {
      logger.warn(`error=<${err}> | failed to end model invoke span`)
    }
  }

  /**
   * Start a tool call span.
   * Parents to the current active span from context.active().
   *
   * @param options - Options for starting the tool call span
   */
  startToolCallSpan(options: StartToolCallSpanOptions): Span | null {
    const { tool } = options

    // Create local tool trace as child of current cycle
    const toolTrace = new AgentTrace(
      `Tool: ${tool.name}`,
      this._traceState.currentCycle ? { parent: this._traceState.currentCycle } : undefined
    )
    toolTrace.metadata.toolUseId = tool.toolUseId
    toolTrace.metadata.toolName = tool.name
    this._traceState.currentTool = toolTrace

    try {
      const attributes = this._getCommonAttributes('execute_tool')
      attributes['gen_ai.tool.name'] = tool.name
      attributes['gen_ai.tool.call.id'] = tool.toolUseId

      const span = this._startSpan({
        name: `execute_tool ${tool.name}`,
        attributes,
        spanKind: SpanKind.INTERNAL,
        ...(this._loopSpan && { parentSpan: this._loopSpan }),
      })

      if (this._useLatestConventions) {
        // The execute_tool span convention records tool inputs in the dedicated
        // gen_ai.tool.call.arguments span attribute (Opt-In), which spec-compliant
        // consumers read on tool spans.
        span.setAttribute('gen_ai.tool.call.arguments', JSON.stringify(tool.input, jsonReplacer))
        this._addEvent(
          span,
          'gen_ai.client.inference.operation.details',
          {
            'gen_ai.input.messages': JSON.stringify(
              [
                {
                  role: 'tool',
                  parts: [{ type: 'tool_call', name: tool.name, id: tool.toolUseId, arguments: tool.input }],
                },
              ],
              jsonReplacer
            ),
          },
          this._spanAttributesOnly
        )
      } else {
        this._addEvent(span, 'gen_ai.tool.message', {
          role: 'tool',
          content: JSON.stringify(tool.input, jsonReplacer),
          id: tool.toolUseId,
        })
      }

      return span
    } catch (error) {
      logger.warn(`error=<${error}> | failed to start tool call span`)
      return null
    }
  }

  /**
   * End a tool call span.
   *
   * @param span - The span to end, or null if span creation failed
   * @param options - Options for ending the tool call span
   */
  endToolCallSpan(span: Span | null, options: EndToolCallSpanOptions = {}): void {
    // End local tool trace
    if (this._traceState.currentTool) {
      this._traceState.currentTool.end()
      this._traceState.currentTool = undefined
    }

    if (!span) return

    const { toolResult, error } = options

    try {
      const attributes: Record<string, AttributeValue> = {}

      if (toolResult) {
        const statusStr = typeof toolResult.status === 'string' ? toolResult.status : String(toolResult.status)
        attributes['gen_ai.tool.status'] = statusStr

        if (this._useLatestConventions) {
          // The execute_tool span convention records tool outputs in the dedicated
          // gen_ai.tool.call.result span attribute (Opt-In), which spec-compliant
          // consumers read on tool spans. The spec scopes the attribute to successful
          // executions; failures are captured in the span status instead.
          if (statusStr !== 'error') {
            attributes['gen_ai.tool.call.result'] = JSON.stringify(toolResult.content, jsonReplacer)
          }
          this._addEvent(
            span,
            'gen_ai.client.inference.operation.details',
            {
              'gen_ai.output.messages': JSON.stringify(
                [
                  {
                    role: 'tool',
                    parts: [{ type: 'tool_call_response', id: toolResult.toolUseId, response: toolResult.content }],
                  },
                ],
                jsonReplacer
              ),
            },
            this._spanAttributesOnly
          )
        } else {
          this._addEvent(span, 'gen_ai.choice', {
            message: JSON.stringify(toolResult.content, jsonReplacer),
            id: toolResult.toolUseId,
          })
        }
      }

      this._endSpan(span, attributes, error)
    } catch (err) {
      logger.warn(`error=<${err}> | failed to end tool call span`)
    }
  }
  /**
   * Start a multi-agent orchestration span.
   * Parents to the current active span from context.active().
   *
   * @param options - Options for starting the multi-agent span
   * @returns The span, or null if span creation failed
   */
  startMultiAgentSpan(options: StartMultiAgentSpanOptions): Span | null {
    const { orchestratorId, orchestratorType, input, traceAttributes } = options

    try {
      const spanName = `invoke_${orchestratorType} ${orchestratorId}`
      const attributes: Record<string, AttributeValue> = {
        ...this._getCommonAttributes(`invoke_${orchestratorType}`),
        'gen_ai.agent.name': orchestratorType,
        'gen_ai.agent.id': orchestratorId,
        name: spanName,
      }
      if (input) attributes['gen_ai.agent.input'] = JSON.stringify(input, jsonReplacer)

      const mergedAttributes = { ...attributes, ...this._traceAttributes, ...traceAttributes }
      const span = this._startSpan({ name: spanName, attributes: mergedAttributes, spanKind: SpanKind.INTERNAL })
      this._multiAgentSpan = span
      return span
    } catch (error) {
      logger.warn(`error=<${error}> | failed to start multi-agent span`)
      return null
    }
  }

  /**
   * End a multi-agent orchestration span.
   *
   * @param span - The span to end, or null if span creation failed
   * @param options - Options for ending the span including duration and error
   */
  endMultiAgentSpan(span: Span | null, options: EndMultiAgentSpanOptions = {}): void {
    this._multiAgentSpan = undefined

    if (!span) return

    try {
      const attributes: Record<string, AttributeValue> = {}
      if (options.status) attributes['gen_ai.agent.status'] = options.status
      if (options.duration !== undefined) attributes['gen_ai.agent.execution_time'] = options.duration
      if (options.usage) this._setUsageAttributes(attributes, options.usage)

      this._endSpan(span, attributes, options.error, options.status === 'FAILED')
    } catch (err) {
      logger.warn(`error=<${err}> | failed to end multi-agent span`)
    }
  }

  /**
   * Start a node execution span.
   * Parents to the current active span from context.active().
   *
   * @param options - Options for starting the node span
   * @returns The span, or null if span creation failed
   */
  startNodeSpan(options: StartNodeSpanOptions): Span | null {
    const { nodeId, nodeType, traceAttributes } = options

    try {
      const spanName = `node ${nodeId}`
      const attributes: Record<string, AttributeValue> = {
        ...this._getCommonAttributes('execute_node'),
        'gen_ai.agent.id': nodeId,
        'gen_ai.agent.node_type': nodeType,
        name: spanName,
      }

      const mergedAttributes = { ...attributes, ...this._traceAttributes, ...traceAttributes }
      return this._startSpan({
        name: spanName,
        attributes: mergedAttributes,
        spanKind: SpanKind.INTERNAL,
        ...(this._multiAgentSpan && { parentSpan: this._multiAgentSpan }),
      })
    } catch (error) {
      logger.warn(`error=<${error}> | failed to start node span`)
      return null
    }
  }

  /**
   * End a node execution span.
   *
   * @param span - The span to end, or null if span creation failed
   * @param options - Options for ending the span including status, duration, and error
   */
  endNodeSpan(span: Span | null, options: EndNodeSpanOptions = {}): void {
    if (!span) return

    try {
      const attributes: Record<string, AttributeValue> = {}
      if (options.status) attributes['gen_ai.agent.status'] = options.status
      if (options.duration !== undefined) attributes['gen_ai.agent.execution_time'] = options.duration
      if (options.usage) this._setUsageAttributes(attributes, options.usage)

      this._endSpan(span, attributes, options.error, options.status === 'FAILED')
    } catch (err) {
      logger.warn(`error=<${err}> | failed to end node span`)
    }
  }

  /**
   * Start a memory search span.
   *
   * The query is recorded verbatim as a span event, consistent with how model and tool spans
   * record their inputs. Memory payloads may contain user PII; suppress span content at the
   * exporter or processor when that is a concern. Parents to the current active span.
   *
   * @param options - Options for starting the memory search span
   */
  startMemorySearchSpan(options: StartMemorySearchSpanOptions): Span | null {
    try {
      const attributes = this._getCommonAttributes('memory.search')
      attributes['memory.store.names'] = JSON.stringify(options.storeNames, jsonReplacer)
      attributes['memory.store.count'] = options.storeNames.length
      if (options.maxSearchResults !== undefined) attributes['memory.max_search_results'] = options.maxSearchResults

      const span = this._startSpan({ name: 'memory.search', attributes, spanKind: SpanKind.INTERNAL })
      this._addEvent(span, 'memory.query', { content: options.query }, this._spanAttributesOnly)
      return span
    } catch (error) {
      logger.warn(`error=<${error}> | failed to start memory search span`)
      return null
    }
  }

  /**
   * End a memory search span with the retrieved entries.
   *
   * Per-store failures are logged and skipped by the manager, so a non-zero `storeFailureCount`
   * still ends the span OK; only `error` marks it as failed.
   *
   * @param span - The span to end, or null if span creation failed
   * @param options - Options for ending the memory search span
   */
  endMemorySearchSpan(span: Span | null, options: EndMemorySearchSpanOptions = {}): void {
    if (!span) return
    try {
      const entries = options.entries ?? []
      const attributes: Record<string, AttributeValue> = {
        'memory.result.count': entries.length,
        'memory.store.failure_count': options.storeFailureCount ?? 0,
      }
      if (!options.error) {
        this._addEvent(
          span,
          'memory.results',
          {
            content: JSON.stringify(
              entries.map((entry) => ({
                content: entry.content,
                storeName: entry.storeName,
                metadata: entry.metadata,
              })),
              jsonReplacer
            ),
          },
          this._spanAttributesOnly
        )
      }
      this._endSpan(span, attributes, options.error)
    } catch (err) {
      logger.warn(`error=<${err}> | failed to end memory search span`)
    }
  }

  /**
   * Start a memory add span.
   *
   * The content is recorded verbatim as a span event, consistent with how model and tool spans
   * record their inputs. Memory payloads may contain user PII; suppress span content at the
   * exporter or processor when that is a concern.
   *
   * @param options - Options for starting the memory add span
   */
  startMemoryAddSpan(options: StartMemoryAddSpanOptions): Span | null {
    try {
      const attributes = this._getCommonAttributes('memory.add')
      attributes['memory.store.names'] = JSON.stringify(options.storeNames, jsonReplacer)
      attributes['memory.store.count'] = options.storeNames.length

      const span = this._startSpan({
        name: 'memory.add',
        attributes,
        spanKind: SpanKind.INTERNAL,
        ...(options.forceRoot && { forceRoot: true }),
      })
      this._addEvent(span, 'memory.content', { content: options.content }, this._spanAttributesOnly)
      return span
    } catch (error) {
      logger.warn(`error=<${error}> | failed to start memory add span`)
      return null
    }
  }

  /**
   * End a memory add span.
   *
   * @param span - The span to end, or null if span creation failed
   * @param options - Options for ending the memory add span
   */
  endMemoryAddSpan(span: Span | null, options: EndMemoryAddSpanOptions = {}): void {
    if (!span) return
    try {
      const attributes: Record<string, AttributeValue> = {
        'memory.store.failure_count': options.storeFailureCount ?? 0,
      }
      this._endSpan(span, attributes, options.error)
    } catch (err) {
      logger.warn(`error=<${err}> | failed to end memory add span`)
    }
  }

  /**
   * Start a memory context injection span.
   *
   * @param options - Options for starting the memory injection span
   */
  startMemoryInjectSpan(options: StartMemoryInjectSpanOptions = {}): Span | null {
    try {
      const attributes = this._getCommonAttributes('memory.inject')
      if (options.maxEntries !== undefined) attributes['memory.max_entries'] = options.maxEntries

      return this._startSpan({ name: 'memory.inject', attributes, spanKind: SpanKind.INTERNAL })
    } catch (error) {
      logger.warn(`error=<${error}> | failed to start memory inject span`)
      return null
    }
  }

  /**
   * End a memory injection span.
   *
   * Injection fails open, so a format failure ends the span OK with a flag rather than an error
   * status (the agent did not fail).
   *
   * @param span - The span to end, or null if span creation failed
   * @param options - Options for ending the memory injection span
   */
  endMemoryInjectSpan(span: Span | null, options: EndMemoryInjectSpanOptions): void {
    if (!span) return
    try {
      const attributes: Record<string, AttributeValue> = {
        'memory.injected': options.injected,
        'memory.entry.count': options.entryCount ?? 0,
      }
      if (options.formatError) attributes['memory.inject.format_error'] = true
      this._endSpan(span, attributes)
    } catch (err) {
      logger.warn(`error=<${err}> | failed to end memory inject span`)
    }
  }

  /**
   * Start a memory extraction span as a trace root.
   *
   * Extraction runs detached from the agent invocation that scheduled it (the agent span has
   * typically ended by the time the save runs), so the span is a trace root, optionally linked
   * back to the agent span for causality.
   *
   * @param options - Options for starting the memory extraction span
   */
  startMemoryExtractSpan(options: StartMemoryExtractSpanOptions): Span | null {
    try {
      const attributes = this._getCommonAttributes('memory.extract')
      attributes['memory.store.name'] = options.storeName
      attributes['memory.message.count'] = options.messageCount
      attributes['memory.message.filtered_count'] = options.filteredCount ?? 0
      if (options.extractor !== undefined) attributes['memory.extractor'] = options.extractor

      // The extract span is a detached root, so its OTel parent is empty. Record the scheduling
      // agent run's ids as plain attributes (in addition to the link below) so backends that don't
      // render span links can still trace the extraction back to the run that triggered it.
      const validAgentSpanContext =
        options.agentSpanContext && isSpanContextValid(options.agentSpanContext) ? options.agentSpanContext : undefined
      if (validAgentSpanContext) {
        attributes['memory.parent.trace_id'] = validAgentSpanContext.traceId
        attributes['memory.parent.span_id'] = validAgentSpanContext.spanId
      }

      const links: Link[] | undefined = validAgentSpanContext ? [{ context: validAgentSpanContext }] : undefined

      return this._startSpan({
        name: 'memory.extract',
        attributes,
        spanKind: SpanKind.INTERNAL,
        forceRoot: true,
        ...(links && { links }),
      })
    } catch (error) {
      logger.warn(`error=<${error}> | failed to start memory extract span`)
      return null
    }
  }

  /**
   * End a memory extraction span.
   *
   * @param span - The span to end, or null if span creation failed
   * @param options - Options for ending the memory extraction span
   */
  endMemoryExtractSpan(span: Span | null, options: EndMemoryExtractSpanOptions = {}): void {
    if (!span) return
    try {
      const attributes: Record<string, AttributeValue> = {}
      if (options.entryCount !== undefined) attributes['memory.entry.count'] = options.entryCount
      this._endSpan(span, attributes, options.error)
    } catch (err) {
      logger.warn(`error=<${err}> | failed to end memory extract span`)
    }
  }

  /**
   * Capture the current active span's context for linking, if one is recording.
   *
   * Used to associate a detached extraction span with the agent run that scheduled it: the
   * context is captured synchronously while the agent span is live, then attached as a link.
   *
   * @returns The active span's context, or undefined when no recording span with a valid context is active
   * @internal
   */
  currentSpanContext(): SpanContext | undefined {
    try {
      const span = trace.getActiveSpan()
      if (!span || !span.isRecording()) return undefined
      const spanContext = span.spanContext()
      return isSpanContextValid(spanContext) ? spanContext : undefined
    } catch (err) {
      logger.warn(`error=<${err}> | failed to capture current span context`)
      return undefined
    }
  }

  /**
   * Runs a callback with the given span set as the active OpenTelemetry context.
   * Downstream code (e.g., MCP clients) can read the span from context.active()
   * for distributed trace propagation. No-ops if span is null.
   *
   * @param span - The span to set as active, or null if span creation failed
   * @param fn - The callback to run within the span's context
   * @returns The return value of the callback
   */
  withSpanContext<T>(span: Span | null, fn: () => T): T {
    if (!span) return fn()
    return context.with(trace.setSpan(context.active(), span), fn)
  }

  /**
   * Start an agent loop cycle span.
   * Parents to the current active span from context.active().
   *
   * @param options - Options for starting the agent loop span
   */
  startAgentLoopSpan(options: StartAgentLoopSpanOptions): Span | null {
    const { cycleId, messages } = options

    // Create local cycle trace
    const cycleNumber = this._traceState.traces.length + 1
    this._traceState.currentCycle = new AgentTrace(`Cycle ${cycleNumber}`)
    this._traceState.currentCycle.metadata.cycleId = cycleId
    this._traceState.traces.push(this._traceState.currentCycle)

    try {
      const attributes: Record<string, AttributeValue> = { 'agent_loop.cycle_id': cycleId }
      const span = this._startSpan({
        name: 'execute_agent_loop_cycle',
        attributes,
        ...(this._agentSpan && { parentSpan: this._agentSpan }),
      })
      this._addEventMessages(span, messages)
      this._loopSpan = span
      return span
    } catch (error) {
      logger.warn(`error=<${error}> | failed to start agent loop cycle span`)
      return null
    }
  }

  /**
   * End an agent loop cycle span.
   *
   * @param span - The span to end, or null if span creation failed
   * @param options - Options for ending the agent loop span
   */
  endAgentLoopSpan(span: Span | null, options: EndAgentLoopSpanOptions = {}): void {
    // End local cycle trace
    if (this._traceState.currentCycle) {
      this._traceState.currentCycle.end()
      this._traceState.currentCycle = undefined
    }

    if (!span) return
    try {
      this._endSpan(span, {}, options.error)
      this._loopSpan = undefined
    } catch (err) {
      logger.warn(`error=<${err}> | failed to end agent loop cycle span`)
    }
  }

  /**
   * Create a span parented to the current active context.
   */
  private _startSpan(options: {
    name: string
    attributes?: Record<string, AttributeValue>
    spanKind?: SpanKind
    parentSpan?: Span
    /**
     * Start the span as a trace root, ignoring any current span. Use for work that runs
     * detached from the span that scheduled it (e.g. background tasks whose parent span
     * has already ended).
     */
    forceRoot?: boolean
    /** Spans to link to without implying a parent-child timing relationship. */
    links?: Link[]
  }): Span {
    const spanOptions: SpanOptions = {}

    if (options.attributes) {
      const otelAttributes: Record<string, AttributeValue | undefined> = {}
      for (const [key, value] of Object.entries(options.attributes)) {
        if (value !== undefined && value !== null) otelAttributes[key] = value
      }
      spanOptions.attributes = otelAttributes
    }

    if (options.spanKind !== undefined) spanOptions.kind = options.spanKind
    if (options.links) spanOptions.links = options.links

    // An empty root context detaches the span from any (possibly ended) current span.
    const ctx = options.forceRoot
      ? ROOT_CONTEXT
      : options.parentSpan
        ? trace.setSpan(context.active(), options.parentSpan)
        : context.active()
    const span = this._tracer.startSpan(options.name, spanOptions, ctx)

    try {
      span.setAttribute('gen_ai.event.start_time', new Date().toISOString())
    } catch (err) {
      logger.warn(`error=<${err}> | failed to set start time attribute`)
    }

    return span
  }

  /**
   * End a span with the given attributes and optional error.
   */
  private _endSpan(span: Span, attributes?: Record<string, AttributeValue>, error?: Error, failed?: boolean): void {
    try {
      const endAttributes: Record<string, AttributeValue> = { 'gen_ai.event.end_time': new Date().toISOString() }
      if (attributes) Object.assign(endAttributes, attributes)

      span.setAttributes(endAttributes)

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
        span.recordException(error)
      } else if (failed) {
        span.setStatus({ code: SpanStatusCode.ERROR })
      } else {
        span.setStatus({ code: SpanStatusCode.OK })
      }

      span.end()
    } catch (err) {
      logger.warn(`error=<${err}> | failed to end span`)
    }
  }

  /**
   * Add an event to a span.
   *
   * Per OpenTelemetry the span-event recording API is deprecated. When `toSpanAttributes` is set,
   * the attributes are recorded directly on the span and the event is skipped, so the content is
   * recorded once rather than duplicated across both; otherwise the event is emitted.
   */
  private _addEvent(
    span: Span,
    eventName: string,
    eventAttributes?: Record<string, AttributeValue>,
    toSpanAttributes = false
  ): void {
    try {
      if (!eventAttributes) {
        span.addEvent(eventName)
        return
      }
      const otelAttributes: Record<string, AttributeValue | undefined> = {}
      for (const [key, value] of Object.entries(eventAttributes)) {
        if (value !== undefined && value !== null) otelAttributes[key] = value
      }
      // Some backends (e.g. Langfuse) don't surface span events, so record the attributes on the
      // span instead of as an event.
      if (toSpanAttributes) {
        span.setAttributes(otelAttributes)
        return
      }
      span.addEvent(eventName, otelAttributes)
    } catch (err) {
      logger.warn(`error=<${err}>, event=<${eventName}> | failed to add span event`)
    }
  }

  /**
   * Get common attributes based on semantic convention version.
   * The attribute name changed between OTEL semconv versions:
   * - Stable: 'gen_ai.system'
   * - Latest experimental: 'gen_ai.provider.name'
   */
  private _getCommonAttributes(operationName: string): Record<string, AttributeValue> {
    const attributes: Record<string, AttributeValue> = {
      'gen_ai.operation.name': operationName,
    }

    if (this._useLatestConventions) {
      attributes['gen_ai.provider.name'] = getServiceName()
    } else {
      attributes['gen_ai.system'] = getServiceName()
    }

    return attributes
  }

  /**
   * Add message events to a span.
   * Uses different event formats based on semantic convention version:
   * - Latest: Single 'gen_ai.client.inference.operation.details' event with all messages
   * - Stable: Separate events per message (gen_ai.user.message, gen_ai.assistant.message, etc.)
   */
  private _addEventMessages(span: Span, messages: Message[]): void {
    try {
      if (!Array.isArray(messages)) return

      if (this._useLatestConventions) {
        const inputMessages = messages.map((m) => ({
          role: m.role,
          parts: Tracer._mapContentBlocksToOtelParts(m.content),
        }))
        this._addEvent(
          span,
          'gen_ai.client.inference.operation.details',
          {
            'gen_ai.input.messages': JSON.stringify(inputMessages, jsonReplacer),
          },
          this._spanAttributesOnly
        )
      } else {
        for (const message of messages) {
          this._addEvent(span, this._getEventNameForMessage(message), {
            content: JSON.stringify(message.content, jsonReplacer),
          })
        }
      }
    } catch (err) {
      logger.warn(`error=<${err}> | failed to add message events`)
    }
  }

  /**
   * Get the event name for a message based on its type.
   */
  private _getEventNameForMessage(message: Message): string {
    if (message.role === 'user' && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block && typeof block === 'object' && 'type' in block && block.type === 'toolResultBlock') {
          return 'gen_ai.tool.message'
        }
      }
    }

    if (message.role === 'user') return 'gen_ai.user.message'
    if (message.role === 'assistant') return 'gen_ai.assistant.message'
    return 'gen_ai.message'
  }

  /**
   * Set usage attributes on an attributes object.
   * Sets both legacy (prompt_tokens/completion_tokens) and new (input_tokens/output_tokens)
   * attribute names for compatibility with different OTEL backends.
   */
  private _setUsageAttributes(attributes: Record<string, AttributeValue>, usage: Usage): void {
    const promptTokens = totalPromptTokens(usage)
    attributes['gen_ai.usage.prompt_tokens'] = promptTokens
    attributes['gen_ai.usage.input_tokens'] = promptTokens
    attributes['gen_ai.usage.completion_tokens'] = usage.outputTokens
    attributes['gen_ai.usage.output_tokens'] = usage.outputTokens
    attributes['gen_ai.usage.total_tokens'] = usage.totalTokens

    if ((usage.cacheReadInputTokens ?? 0) > 0) {
      attributes['gen_ai.usage.cache_read.input_tokens'] = usage.cacheReadInputTokens!
      // Deprecated pre-semconv name, dual-emitted unless opted into the latest conventions
      if (!this._useLatestConventions) {
        attributes['gen_ai.usage.cache_read_input_tokens'] = usage.cacheReadInputTokens!
      }
    }
    if ((usage.cacheWriteInputTokens ?? 0) > 0) {
      attributes['gen_ai.usage.cache_creation.input_tokens'] = usage.cacheWriteInputTokens!
      if (!this._useLatestConventions) {
        attributes['gen_ai.usage.cache_write_input_tokens'] = usage.cacheWriteInputTokens!
      }
    }
  }

  /**
   * Set metrics attributes on an attributes object.
   */
  private _setMetricsAttributes(attributes: Record<string, AttributeValue>, metrics: Metrics): void {
    if (metrics.latencyMs !== undefined && metrics.latencyMs > 0) {
      attributes['gen_ai.server.request.duration'] = metrics.latencyMs
    }
  }

  /**
   * Add response event to a span.
   */
  private _addResponseEvent(span: Span, response: Message, stopReason?: string): void {
    try {
      const finishReason = stopReason || 'end_turn'

      const textParts: string[] = []
      for (const block of response.content) {
        if (block.type === 'textBlock') {
          textParts.push(block.text)
        }
      }
      const messageText = textParts.join('\n')

      if (this._useLatestConventions) {
        this._addEvent(
          span,
          'gen_ai.client.inference.operation.details',
          {
            'gen_ai.output.messages': JSON.stringify(
              [{ role: 'assistant', parts: [{ type: 'text', content: messageText }], finish_reason: finishReason }],
              jsonReplacer
            ),
          },
          this._spanAttributesOnly
        )
      } else {
        this._addEvent(span, 'gen_ai.choice', { message: messageText, finish_reason: finishReason })
      }
    } catch (err) {
      logger.warn(`error=<${err}> | failed to add response event`)
    }
  }

  /**
   * Add output event to a span for model invocation.
   */
  private _addOutputEvent(span: Span, message: Message, stopReason?: string): void {
    try {
      const finishReason = stopReason || 'unknown'

      if (this._useLatestConventions) {
        this._addEvent(
          span,
          'gen_ai.client.inference.operation.details',
          {
            'gen_ai.output.messages': JSON.stringify(
              [
                {
                  role: message.role,
                  parts: Tracer._mapContentBlocksToOtelParts(message.content),
                  finish_reason: finishReason,
                },
              ],
              jsonReplacer
            ),
          },
          this._spanAttributesOnly
        )
      } else {
        this._addEvent(span, 'gen_ai.choice', {
          finish_reason: finishReason,
          message: JSON.stringify(Tracer._mapContentBlocksToStableFormat(message.content), jsonReplacer),
        })
      }
    } catch (err) {
      logger.warn(`error=<${err}> | failed to add output event`)
    }
  }

  /**
   * Parse the OTEL_SEMCONV_STABILITY_OPT_IN environment variable.
   */
  private static _parseSemconvOptIn(): Set<string> {
    const optInEnv = globalThis.process?.env?.OTEL_SEMCONV_STABILITY_OPT_IN ?? ''
    return new Set(
      optInEnv
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    )
  }

  /**
   * Detect whether Langfuse is configured as the OTLP endpoint.
   * Checks OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
   * and LANGFUSE_BASE_URL environment variables.
   */
  private static _detectLangfuse(): boolean {
    const env = globalThis.process?.env
    if (!env) return false

    if (env.LANGFUSE_BASE_URL) return true

    const otlpEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT ?? ''
    const tracesEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? ''
    return otlpEndpoint.includes('langfuse') || tracesEndpoint.includes('langfuse')
  }

  /**
   * Emit system prompt as a span event per OTel GenAI semantic conventions.
   * In stable mode, emits a `gen_ai.system.message` event.
   * In latest experimental mode, emits `gen_ai.system_instructions` on the
   * `gen_ai.client.inference.operation.details` event.
   *
   * @param span - The span to add the event to
   * @param systemPrompt - The system prompt provided to the model
   */
  private _addSystemPromptEvent(span: Span, systemPrompt?: SystemPrompt): void {
    if (systemPrompt === undefined) return

    if (this._useLatestConventions) {
      const parts = Tracer._mapSystemPromptToOtelParts(systemPrompt)
      this._addEvent(
        span,
        'gen_ai.client.inference.operation.details',
        {
          'gen_ai.system_instructions': JSON.stringify(parts, jsonReplacer),
        },
        this._spanAttributesOnly
      )
    } else {
      // Normalize string prompts to an array of text blocks for consistent format
      const blocks = typeof systemPrompt === 'string' ? [{ text: systemPrompt }] : systemPrompt
      this._addEvent(span, 'gen_ai.system.message', {
        content: JSON.stringify(blocks, jsonReplacer),
      })
    }
  }

  /**
   * Map a system prompt to OTEL parts format (latest conventions).
   * Handles both string prompts and SystemContentBlock arrays.
   */
  private static _mapSystemPromptToOtelParts(systemPrompt: SystemPrompt): Record<string, unknown>[] {
    if (typeof systemPrompt === 'string') {
      return [{ type: 'text', content: systemPrompt }]
    }
    return systemPrompt.map((block) => {
      switch (block.type) {
        case 'textBlock':
          return { type: 'text', content: block.text }
        case 'cachePointBlock':
          return { type: 'cache_point', cacheType: block.cacheType }
        case 'guardContentBlock':
          return { type: 'guard_content', text: block.text, image: block.image }
      }
    })
  }

  /**
   * Map content blocks to OTEL parts format (latest conventions).
   * Converts SDK content block types to OTEL semantic convention format.
   */
  private static _mapContentBlocksToOtelParts(contentBlocks: ContentBlock[]): Record<string, unknown>[] {
    if (!Array.isArray(contentBlocks)) return []

    return contentBlocks.map((block) => {
      switch (block.type) {
        case 'textBlock':
          return { type: 'text', content: block.text }
        case 'toolUseBlock':
          return { type: 'tool_call', name: block.name, id: block.toolUseId, arguments: block.input }
        case 'toolResultBlock':
          return { type: 'tool_call_response', id: block.toolUseId, response: block.content }
        default:
          return { type: block.type }
      }
    })
  }

  /**
   * Map content blocks to stable format (older conventions).
   * Simplifies content blocks to a minimal structure for legacy OTEL backends.
   */
  private static _mapContentBlocksToStableFormat(contentBlocks: ContentBlock[]): unknown[] {
    if (!Array.isArray(contentBlocks)) return []

    return contentBlocks
      .map((block) => {
        switch (block.type) {
          case 'textBlock':
            return { text: block.text }
          case 'toolUseBlock':
            return { type: 'toolUse', name: block.name, toolUseId: block.toolUseId, input: block.input }
          case 'toolResultBlock':
            return { type: 'toolResult', toolUseId: block.toolUseId, content: block.content }
          default:
            return null
        }
      })
      .filter(Boolean)
  }
}
