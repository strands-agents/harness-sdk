/**
 * Telemetry helpers for the bidirectional streaming agent.
 *
 * Wraps the shared `Tracer` primitives with bidi-specific span creation and attribute names.
 * Uses the tracer's internal span helpers directly rather than adding bidi-specific public methods
 * to the shared `Tracer` class, keeping bidi telemetry self-contained.
 *
 * @internal
 */

import type { AttributeValue, Span } from '@opentelemetry/api'
import type { Tracer } from '../telemetry/tracer.js'

/** The internal `Tracer` members this module reuses. */
interface TracerInternals {
  _getCommonAttributes(operationName: string): Record<string, AttributeValue>
  _startSpan(options: { name: string; attributes?: Record<string, AttributeValue>; parentSpan?: Span }): Span
  _endSpan(span: Span, attributes?: Record<string, AttributeValue>, error?: Error): void
  _useLatestConventions: boolean
}

/** Reach the tracer's internal span helpers; see the module docstring. */
function internals(tracer: Tracer): TracerInternals {
  return tracer as unknown as TracerInternals
}

/**
 * Start a span for the bidi session lifecycle.
 *
 * @param tracer - Tracer instance.
 * @param agentName - Name of the bidi agent.
 * @param options - Model identifier, tool names, and system prompt configured on the agent.
 * @returns The session span.
 * @internal
 */
export function startSessionSpan(
  tracer: Tracer,
  agentName: string,
  options?: { modelId?: string; tools?: string[]; systemPrompt?: string }
): Span {
  const tracerInternals = internals(tracer)
  const attributes = tracerInternals._getCommonAttributes('bidi_session')
  attributes['gen_ai.agent.name'] = agentName

  if (options?.modelId) {
    attributes['gen_ai.request.model'] = options.modelId
  }

  if (options?.tools && options.tools.length > 0) {
    attributes['gen_ai.agent.tools'] = JSON.stringify(options.tools)
  }

  if (options?.systemPrompt) {
    attributes['gen_ai.system_instructions'] = options.systemPrompt
  }

  return tracerInternals._startSpan({ name: `bidi_session ${agentName}`, attributes })
}

/**
 * End the bidi session span.
 *
 * @param tracer - Tracer instance.
 * @param span - The session span to end.
 * @param options - Accumulated token counts and the error the session ended with, if any.
 * @internal
 */
export function endSessionSpan(
  tracer: Tracer,
  span: Span,
  options?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    cacheReadInputTokens?: number
    error?: Error
  }
): void {
  const tracerInternals = internals(tracer)
  const cacheReadInputTokens = options?.cacheReadInputTokens ?? 0
  const tokenAttributes: Record<string, number> = {
    'gen_ai.usage.input_tokens': options?.inputTokens ?? 0,
    'gen_ai.usage.output_tokens': options?.outputTokens ?? 0,
    'gen_ai.usage.total_tokens': options?.totalTokens ?? 0,
    'gen_ai.usage.cache_read.input_tokens': cacheReadInputTokens,
  }
  if (!tracerInternals._useLatestConventions) {
    // Deprecated pre-semconv name, dual-emitted unless opted into the latest conventions
    tokenAttributes['gen_ai.usage.cache_read_input_tokens'] = cacheReadInputTokens
  }

  const attributes: Record<string, AttributeValue> = {}
  for (const [name, value] of Object.entries(tokenAttributes)) {
    if (value > 0) attributes[name] = value
  }

  tracerInternals._endSpan(span, attributes, options?.error)
}

/**
 * Start a span for a model response.
 *
 * @param tracer - Tracer instance.
 * @param responseId - Unique identifier for the response.
 * @param parentSpan - Parent session span.
 * @returns The response span.
 * @internal
 */
export function startResponseSpan(tracer: Tracer, responseId: string, parentSpan?: Span): Span {
  const tracerInternals = internals(tracer)
  const attributes = tracerInternals._getCommonAttributes('bidi_response')
  attributes['gen_ai.response.id'] = responseId

  // Static span name (responseId is recorded as an attribute) to avoid high-cardinality names.
  return tracerInternals._startSpan(
    parentSpan ? { name: 'bidi_response', attributes, parentSpan } : { name: 'bidi_response', attributes }
  )
}

/**
 * End a model response span.
 *
 * @param tracer - Tracer instance.
 * @param span - The response span to end.
 * @param options - Time to first audio chunk and the error the response ended with, if any.
 * @internal
 */
export function endResponseSpan(
  tracer: Tracer,
  span: Span,
  options?: { timeToFirstAudioMs?: number; error?: Error }
): void {
  const attributes: Record<string, AttributeValue> = {}

  if (options?.timeToFirstAudioMs !== undefined) {
    attributes['gen_ai.server.time_to_first_audio'] = options.timeToFirstAudioMs
  }

  internals(tracer)._endSpan(span, attributes, options?.error)
}

/**
 * Start a span for a connection restart.
 *
 * @param tracer - Tracer instance.
 * @param options - Parent session span, what triggered the restart (`"timeout"` reactively,
 *   `"scheduled"` proactively; defaults to `"timeout"`), and the triggering error message.
 * @returns The restart span.
 * @internal
 */
export function startRestartSpan(
  tracer: Tracer,
  options?: { parentSpan?: Span; reason?: string; errorMessage?: string }
): Span {
  const tracerInternals = internals(tracer)
  const attributes = tracerInternals._getCommonAttributes('bidi_connection_restart')
  attributes['gen_ai.bidi.restart_reason'] = options?.reason ?? 'timeout'

  // The message of the timeout that triggered a reactive restart. Namespaced under
  // gen_ai.bidi.* (not gen_ai.error.*) so it does not read as a failure of this span,
  // which may end successfully; a failed restart is recorded via endRestartSpan.
  if (options?.errorMessage) {
    attributes['gen_ai.bidi.restart_error_message'] = options.errorMessage
  }

  const spanOptions = { name: 'bidi_connection_restart', attributes }
  return tracerInternals._startSpan(
    options?.parentSpan ? { ...spanOptions, parentSpan: options.parentSpan } : spanOptions
  )
}

/**
 * End a connection restart span.
 *
 * @param tracer - Tracer instance.
 * @param span - The restart span to end.
 * @param error - Error if the restart failed.
 * @internal
 */
export function endRestartSpan(tracer: Tracer, span: Span, error?: Error): void {
  internals(tracer)._endSpan(span, {}, error)
}

/**
 * Start a span for the model connection establishment.
 *
 * @param tracer - Tracer instance.
 * @param options - Parent session span and the model identifier being connected to.
 * @returns The connection span.
 * @internal
 */
export function startConnectionSpan(tracer: Tracer, options?: { parentSpan?: Span; modelId?: string }): Span {
  const tracerInternals = internals(tracer)
  const attributes = tracerInternals._getCommonAttributes('bidi_connect')

  if (options?.modelId) {
    attributes['gen_ai.request.model'] = options.modelId
  }

  const spanOptions = { name: 'bidi_connect', attributes }
  return tracerInternals._startSpan(
    options?.parentSpan ? { ...spanOptions, parentSpan: options.parentSpan } : spanOptions
  )
}

/**
 * End the model connection span.
 *
 * @param tracer - Tracer instance.
 * @param span - The connection span to end.
 * @param error - Error if the connection failed.
 * @internal
 */
export function endConnectionSpan(tracer: Tracer, span: Span, error?: Error): void {
  internals(tracer)._endSpan(span, {}, error)
}

/**
 * Record a barge-in as a span event on the session span.
 *
 * @param span - The session span to add the event to.
 * @internal
 */
export function addBargeInEvent(span: Span | undefined): void {
  if (span && span.isRecording()) {
    span.addEvent('bidi_barge_in')
  }
}
