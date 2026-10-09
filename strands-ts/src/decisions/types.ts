/**
 * Public types for the decision model primitive.
 *
 * See `team/designs/0020-decision-models.md` for the design rationale.
 */

import type { ContentBlock, Message } from '../types/messages.js'

/**
 * Input state passed to a {@link DecisionModel} invocation.
 *
 * The subset of {@link InvokeArgs} that fits a stateless decision: a plain string
 * question, a single-turn content list (multimodal), or a full message history.
 */
export type DecisionInput = string | ContentBlock[] | Message[]

/**
 * A single question posed to a {@link DecisionModel}.
 *
 * `choices` constrains the shape of the answer: `'boolean'` yields a boolean, and
 * a readonly tuple of strings yields that tuple's union. In both cases
 * {@link Uncertain} is also a possible answer unless opted out via
 * `uncertainOptions.allow = false`.
 *
 * @typeParam C - Static shape of the `choices` field; narrow it with `as const`
 *   so TypeScript keeps the literal types.
 */
export interface Question<C extends 'boolean' | readonly string[] = 'boolean' | readonly string[]> {
  /** Natural-language description of the question, surfaced to the implementation. */
  instructions: string
  /** Answer shape: `'boolean'` or a non-empty readonly tuple of string literals. */
  choices: C
  /** Uncertainty configuration for this question. */
  uncertainOptions?: {
    /** Whether `Uncertain` is a permitted response. Defaults to `true`. */
    allow: boolean
    /**
     * Minimum confidence required to commit to an answer, in `[0.5, 1.0]`.
     * Read only by implementations that return per-answer confidence (e.g.
     * System One models); ignored by {@link LLMDecisionModel}. Defaults to `0.5`.
     */
    threshold?: number
  }
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
 */
export type AnswerOf<Q> =
  Q extends Question<'boolean'>
    ? boolean | Uncertain
    : Q extends Question<infer S extends readonly string[]>
      ? S[number] | Uncertain
      : never

/**
 * Result returned by {@link DecisionModel.ask}, keyed by the same identifiers
 * as the input question map.
 *
 * @typeParam Q - The question map passed to `ask`.
 */
export interface DecisionResult<Q extends Record<string, Question> = Record<string, Question>> {
  /** Per-question answer, statically narrowed from each question's `choices`. */
  answers: { [K in keyof Q]: AnswerOf<Q[K]> }
  /** Aggregate token usage for the underlying model call(s). */
  usage: {
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
