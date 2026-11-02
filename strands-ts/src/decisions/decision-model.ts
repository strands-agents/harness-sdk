/**
 * Base interface for making structured "decisions" from inside the SDK.
 */

import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'

import { unwrapInvocationContext } from '../agent/invocation-context.js'
import { getServiceName } from '../telemetry/utils.js'
import type { AskOptions, DecisionInput, DecisionResult, Question } from './types.js'

/**
 * Abstract base for anything that can answer closed questions.
 *
 * The public `ask` opens a `decision` span, validates the question map, delegates
 * to the subclass `_ask`, records usage and the answer set as span attributes/events,
 * and closes the span. Every implementation is traced identically. Given an
 * `invocationContext`, `ask` also adds the reported usage to that request once
 * `_ask` returns.
 */
export abstract class DecisionModel {
  /**
   * Ask one or more closed questions over the given state.
   *
   * @param state - A plain string, a one-shot content list, or a message history.
   * @param questions - Map of identifier → question. The returned `answers` object
   *   is keyed off this same map and statically narrowed per question.
   * @param options - Per-call options, such as the request to add the decision's usage to.
   * @returns A {@link DecisionResult} whose answers are statically narrowed from
   *   each question's `choices`.
   * @throws Error if `questions` is empty or contains an invalid `question`,
   *   `choices`, or `uncertainty`.
   * @throws TypeError if `options.invocationContext` was not created by the SDK.
   */
  async ask<const Q extends Record<string, Question>>(
    state: DecisionInput,
    questions: Q,
    options?: AskOptions
  ): Promise<DecisionResult<Q>> {
    validateQuestions(questions)
    const invocationContext = unwrapInvocationContext(options?.invocationContext)

    const span = trace.getTracer(getServiceName()).startSpan('decision', {
      kind: SpanKind.INTERNAL,
      attributes: {
        'gen_ai.operation.name': 'decision',
      },
    })
    span.addEvent('gen_ai.decision.questions', { ids: Object.keys(questions) })

    try {
      const result = await context.with(trace.setSpan(context.active(), span), () => this._ask(state, questions))

      const spanAttributes: Record<string, number> = { 'gen_ai.decision.latency_ms': result.metadata.latencyMs }
      if (result.usage !== undefined) {
        invocationContext?.recordUsage(result.usage)
        spanAttributes['gen_ai.usage.input_tokens'] = result.usage.inputTokens
        spanAttributes['gen_ai.usage.output_tokens'] = result.usage.outputTokens
      }
      span.setAttributes(spanAttributes)

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
  protected abstract _ask<const Q extends Record<string, Question>>(
    state: DecisionInput,
    questions: Q
  ): Promise<DecisionResult<Q>>
}

function validateQuestions(questions: Record<string, Question>): void {
  const ids = Object.keys(questions)
  if (ids.length === 0) throw new Error('ask requires at least one question')

  for (const id of ids) {
    const question = questions[id]!
    if (typeof question.question !== 'string' || question.question.trim().length === 0) {
      throw new Error(`question id=<${id}> | question must be a non-empty string`)
    }
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
      if (choices.includes('uncertain')) {
        throw new Error(`question id=<${id}> | choice 'uncertain' is reserved for the Uncertain answer`)
      }
    }
    const uncertainty = question.uncertainty
    if (uncertainty !== undefined && typeof uncertainty !== 'boolean') {
      if (uncertainty === null || typeof uncertainty !== 'object') {
        throw new Error(`question id=<${id}> | uncertainty must be a boolean or { minConfidence? } object`)
      }
      const minConfidence = uncertainty.minConfidence
      if (minConfidence !== undefined && (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1)) {
        throw new Error(`question id=<${id}> | uncertainty.minConfidence must be in [0.0, 1.0]`)
      }
    }
  }
}

/**
 * Resolve whether `Uncertain` is permitted for a question, given its `uncertainty`
 * configuration. Shared by every decision-model implementation.
 *
 * @internal
 */
export function uncertaintyAllowed(question: Question): boolean {
  const uncertainty = question.uncertainty
  return uncertainty !== false
}
