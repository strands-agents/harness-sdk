/**
 * Base interface for making structured "decisions" from inside the SDK.
 */

import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'

import { getServiceName } from '../telemetry/utils.js'
import type { DecisionInput, DecisionResult, Question } from './types.js'

/**
 * Abstract base for anything that can answer closed questions.
 *
 * The public `ask` opens a `decision` span, validates the question map, delegates
 * to the subclass `_ask`, records usage and the answer set as span attributes/events,
 * and closes the span. Every implementation is traced identically.
 */
export abstract class DecisionModel {
  /**
   * Ask one or more closed questions over the given state.
   *
   * @param state - A plain string, a one-shot content list, or a message history.
   * @param questions - Map of identifier → question. The returned `answers` object
   *   is keyed off this same map and statically narrowed per question.
   * @returns A {@link DecisionResult} whose answers are statically narrowed from
   *   each question's `options`.
   * @throws Error if `questions` is empty or contains invalid options/thresholds.
   */
  async ask<Q extends Record<string, Question>>(state: DecisionInput, questions: Q): Promise<DecisionResult<Q>> {
    validateQuestions(questions)

    const span = trace.getTracer(getServiceName()).startSpan('decision', {
      kind: SpanKind.INTERNAL,
      attributes: {
        'gen_ai.operation.name': 'decision',
      },
    })
    span.addEvent('gen_ai.decision.questions', { ids: Object.keys(questions) })

    try {
      const result = await this._ask(state, questions)

      span.setAttributes({
        'gen_ai.usage.input_tokens': result.usage.inputTokens,
        'gen_ai.usage.output_tokens': result.usage.outputTokens,
        'gen_ai.decision.latency_ms': result.metadata.latencyMs,
      })

      span.addEvent('gen_ai.decision.answers', { answers: JSON.stringify(result.answers) })
      span.setStatus({ code: SpanStatusCode.OK })

      return result
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error))
      span.setStatus({ code: SpanStatusCode.ERROR, message: normalized.message })
      span.recordException(normalized)
      throw error
    } finally {
      span.end()
    }
  }

  /**
   * Implementation-specific decision logic. Must return a complete
   * {@link DecisionResult}, including `metadata.latencyMs` sourced from the
   * underlying model provider.
   */
  protected abstract _ask<Q extends Record<string, Question>>(
    state: DecisionInput,
    questions: Q
  ): Promise<DecisionResult<Q>>
}

function validateQuestions(questions: Record<string, Question>): void {
  const ids = Object.keys(questions)
  if (ids.length === 0) throw new Error('ask requires at least one question')

  for (const id of ids) {
    const question = questions[id]!
    const { choices } = question
    if (choices !== 'boolean') {
      if (!Array.isArray(choices) || choices.length === 0) {
        throw new Error(`question id=<${id}> | choices must be 'boolean' or a non-empty string array`)
      }
      if (new Set(choices).size !== choices.length) {
        throw new Error(`question id=<${id}> | choices must be unique`)
      }
      if (choices.some((choice) => typeof choice !== 'string' || choice.length === 0)) {
        throw new Error(`question id=<${id}> | choices must be non-empty strings`)
      }
    }
    const threshold = question.uncertainOptions?.threshold
    if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)) {
      throw new Error(`question id=<${id}> | uncertainOptions.threshold must be in [0.0, 1.0]`)
    }
  }
}
