/**
 * Public types for the decision model primitive.
 *
 * See `team/designs/0020-decision-models.md` for the design rationale.
 */

import type { InvocationContext } from '../agent/invocation-context.js'
import type { ContentBlock, Message } from '../types/messages.js'

/**
 * Input state passed to a {@link DecisionModel} invocation.
 *
 * The subset of {@link InvokeArgs} that fits a stateless decision: a plain string
 * question, a single-turn content list (multimodal), or a full message history.
 */
export type DecisionInput = string | ContentBlock[] | Message[]

/** Per-call options for {@link DecisionModel.ask}. */
export interface AskOptions {
  /** The request to add this decision's token usage to, such as a hook event's or tool context's `invocationContext`; the request's limits don't apply to the decision. */
  invocationContext?: InvocationContext
}

/**
 * Identity helper that preserves the literal types of an inline question map
 * when it's stored in a variable before being passed to {@link DecisionModel.ask}.
 *
 * `ask` already uses a `const` type parameter, so inline question maps work
 * without any helper. Use `defineQuestions` only when you need to declare the
 * map ahead of time — it keeps `choices` tuples and `'boolean'` as literal
 * types without an explicit `as const`.
 */
export function defineQuestions<const Q extends Record<string, Question>>(questions: Q): Q {
  return questions
}

/**
 * A single question posed to a {@link DecisionModel}.
 *
 * `choices` constrains the shape of the answer: `'boolean'` yields a boolean, and
 * a readonly tuple of strings yields that tuple's union. In both cases
 * {@link Uncertain} is also a possible answer unless opted out via
 * `uncertainty: false`.
 *
 * @typeParam C - Static shape of the `choices` field. `ask` is declared with a
 *   `const` type parameter, so inline question maps keep their tuple literals
 *   without an explicit `as const`.
 */
export interface Question<C extends 'boolean' | readonly string[] = 'boolean' | readonly string[]> {
  /** The question posed to the model, in natural language. */
  question: string
  /** Answer shape: `'boolean'` or a non-empty readonly tuple of string literals. */
  choices: C
  /**
   * Uncertainty configuration for this question.
   * - omitted or `true`: `Uncertain` is a permitted response (default).
   * - `false`: `Uncertain` is disabled; the model must commit to one of `choices`.
   * - `{ minConfidence }`: `Uncertain` is permitted, with a custom minimum
   *   confidence in `[0.0, 1.0]`. Read only by implementations that return
   *   per-answer confidence (e.g. System One models); ignored by {@link LLMDecisionModel}.
   */
  uncertainty?: boolean | { minConfidence?: number }
}

/**
 * Sentinel returned in place of an answer when the decision model declined to
 * commit. Carries an optional free-form reason supplied by the implementation.
 */
export class Uncertain {
  constructor(public readonly reason?: string) {}

  toString(): string {
    return this.reason !== undefined ? `Uncertain(${this.reason})` : 'Uncertain'
  }

  toJSON(): { uncertain: true; reason?: string } {
    return { uncertain: true, ...(this.reason !== undefined && { reason: this.reason }) }
  }
}

/**
 * Statically narrows each question's answer type from its `choices`.
 *
 * - `Question<'boolean'>` yields `boolean | Uncertain`.
 * - `Question<readonly ['red', 'green']>` yields `'red' | 'green' | Uncertain`.
 * - An un-narrowed `Question` (e.g. an entry of `Record<string, Question>` without
 *   `as const`) falls back to `boolean | string | Uncertain`.
 */
export type AnswerOf<Q> =
  Q extends Question<'boolean'>
    ? boolean | Uncertain
    : Q extends Question<infer S extends readonly string[]>
      ? S[number] | Uncertain
      : boolean | string | Uncertain

/**
 * Result returned by {@link DecisionModel.ask}, keyed by the same identifiers
 * as the input question map.
 *
 * @typeParam Q - The question map passed to `ask`.
 */
export interface DecisionResult<Q extends Record<string, Question> = Record<string, Question>> {
  /** Per-question answer, statically narrowed from each question's `choices`. */
  answers: { [K in keyof Q]: AnswerOf<Q[K]> }
  /** Aggregate token usage for the underlying model call(s), when the provider reports it. */
  usage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }
  /** Per-call metadata recorded by the implementation. */
  metadata: {
    /** Time spent in the underlying model call, in milliseconds. */
    latencyMs: number
  }
}
