# Decision Models

**Date**: 2026-10-05

**Issue**: [#4551](https://github.com/strands-agents/harness-sdk/issues/4551)

**Scope**: TypeScript SDK first, stable. Python parity follows.

## Problem

Agents keep asking a model small closed questions. Which specialist handles this request? Which model serves this turn? Is this message urgent? The SDK has no primitive for it, so every call site reaches for a general `Model` through `structured_output` (Python) or `StructuredOutputTool` + forced `toolChoice` (TypeScript). With the newly released system one models, there is an opportunity to create an interface in the SDK that represents ways for Agents to make "decisions" that different kind of models can integrate with.

## Proposal

A `DecisionModel` abstraction acts as the base interface for making a "decision" in strands. You can `ask` a `DecisionModel` one or many `Question`'s, and the decision model can respond with a `DecisionResult` that contains the decisions to the questions asked.
### Interface

```ts
export abstract class DecisionModel {
  // Generics allow for better typing on devex (see below)
  async ask<Q extends Record<string, Question>>(
    state: DecisionInput,
    questions: Q,
  ): Promise<DecisionResult<Q>> {
    // Validates questions synchronously, opens a `decision` span,
    // delegates to _ask, records usage, closes the span.
  }

  protected abstract _ask<Q extends Record<string, Question>>(
    state: DecisionInput,
    questions: Q,
  ): Promise<DecisionResult<Q>>
}

export interface Question {
  instructions: string
  choices: 'boolean' | readonly string[]
  uncertainOptions?: {
    allow: boolean  // default true
    threshold?: number // [0, 1], default 0.5. Only read by implementations that
    // return per-answer confidence (e.g. System One). The implementation yields
    // `Uncertain` when the question's confidence falls below this value; see
    // the System One section for the exact mapping per answer type.
  }
}

export class Uncertain { constructor(public readonly reason?: string) {} }


export interface DecisionResult<Q extends Record<string, Question> = Record<string, Question>> {
  answers: { [K in keyof Q]: boolean | string | Uncertain }
  usage: { inputTokens: number; outputTokens: number; totalTokens: number }
  metadata: { latencyMs: number }
}

export type DecisionInput = string | ContentBlock[] | Message[]
```

`ask` is generic over the questions map, and `DecisionResult.answers` is a mapped type keyed off the same map. Each answer's type is derived from its question's `choices`: a `'boolean'` question yields `boolean | Uncertain`, a string-literal tuple yields that tuple's union plus `Uncertain`.

Lets say we start with an `LLMDecisionModel` as an implementation of this interface (more about this discussed below). A customer may use it as follows:

```ts
const llmDecisionModel = new LLMDecisionModel(new BedrockModel())

const result = await llmDecisionModel.ask('The fruit is an apple', {
  color: {
    instructions: 'What color is the fruit?',
    choices: ['red', 'green', 'blue'] as const,
  },
  isFruit: {
    instructions: 'Is the thing talked about a fruit?',
    choices: 'boolean',
    uncertainOptions: { allow: false },
  },
})

// result.answers.color   is 'red' | 'green' | 'blue' | Uncertain
// result.answers.isFruit is boolean
```

### Uncertainty handling

`Uncertain` is explicitly called out as a return type for any type of question. Inspiration for this comes from system one models including confidence in their result, and can be helpful for customers to decide how they want to deal with uncertain results. We allow for uncertain results by including it as one option returned from the model. Each type of implementation will need to account for handling uncertainty:
- For LLM's, this is included as an additional option when calling the model
- For System One models, each answer carries a native confidence number (see below). The implementation yields `Uncertain` when that confidence falls below the question's `uncertainOptions.threshold`.

Customers can handle `Uncertainty` in there code as follows:
```ts
const llmDecisionModel = new LLMDecisionModel(new BedrockModel())

const result = await llmDecisionModel.ask('The fruit is an apple', {
  color: {
    instructions: 'What color is the fruit?',
    choices: ['red', 'green', 'blue'] as const,
  },
  isFruit: {
    instructions: 'Is the thing talked about a fruit?',
    choices: 'boolean',
    uncertainOptions: { allow: false },
  },
})

if (result.answers.color instanceof Uncertain) {
  console.log('RESULT UNCERTAIN')
}
```

## DecisionModel Implementations

### `LLMDecisionModel`

This will be an adapter to convert any vended model provider as a `DecisionModel`. This will work by taking in an `ask` and transforming it into a tool call. If that `ask` wants uncertainty, we will include uncertain as one of the optional results of the tool.

#### Observability

Every `DecisionResult` carries input, output, and total tokens read from the model's final metadata event. The `decision` span opened by the base class records `gen_ai.operation.name="decision"`, request and response model ids, input and output tokens, the question ids as a span event, and the answers as a span event. Agent-level `accumulatedUsage` wiring lands when [#4005](https://github.com/strands-agents/harness-sdk/pull/4005) merges — the base class picks up the auxiliary-call hook under `source='decision'` without changing the public surface.

### System One Decision Models

Since most system one model providers follow an api that is similar enough to the interface proposed above, the actual implementation details can be hashed out in the pull requests. For a summary of the shared API shape, see [the Jev AI API contract write-up on Hugging Face](https://huggingface.co/blog/sora-2/typesafe-ai-model-and-jev-ai-api-a-production-inte#the-jev-ai-api-contract). We should target the market leaders as decision model providers initially:

- [TypeSafeAI Jev](https://docs.typesafe.ai/introduction)
- [OpenAI Decisions API](https://decisionapi.net/)
- [Strands Decider](https://github.com/strands-labs/strands-decider) (vended from its own repo)

When Bedrock hosts system one models, we should integrate with it as well. Others can be considered on a case-by-case basis.

## Integration points for `DecisionModel`

Candidate callers in the SDK, ordered roughly by how directly the primitive fits:

- **Model router.** The planned `DecisionStrategy` + `ClassifierStrategy` rewrite — `ModelRouter` picks a candidate via a single `choice` question. First real caller; validates the primitive against production load.
- **Choice tool.** A built-in tool wrapping `DecisionModel.ask`, so an LLM-driven agent can delegate a sub-decision to a different (cheaper, faster, higher-confidence) model.
- **Graph.** A node's outgoing edge is selected by `DecisionModel.ask` rather than a hand-coded predicate, enabling model-driven branching.
- **Swarm.** Handoff between agents expressed as a `choice` question whose options are candidate agent names.
- **Tool selector.** A pre-tool-call filter that narrows the candidate tool set before the model sees them (e.g. "which of these 40 tools are plausibly relevant here?").
- **Interventions.** A decision gates whether an intervention fires (e.g. "is this message safe for action X?").
- **Evals.** Structured judging — a rubric expressed as a bag of `Question`s produces calibrated per-criterion scores for test runs.
- **Other.** Open slot; concrete callers surface as the primitive gets exercised.

## Future Work

- **Score questions.** Widen `Question.choices` with a third `{ kind: 'score', levels }` shape and extend `AnswerOf<Q>` to yield `number | Uncertain`, mapping to System One models' score results.
- **Uncertainty default handling.** Instead of each customer including custom logic to handle default handling, we can include some default option to return if the model is uncertain. Some kind of `uncertainOptions.default` setting.
- **ClassifierStrategy rewrite.** A thin `DecisionStrategy` routing passthrough + `ClassifierStrategy` as a preset on top, dropping ~325–375 lines of scaffolding across the two SDKs. First real caller that validates the primitive against production load.
- **Python port.** Mirror the TypeScript design, swapping `StructuredOutputTool` + `toolChoice` for `model.structured_output` with a dynamic Pydantic model. Names convert mechanically (`uncertainOptions` ↔ `uncertain_options`, `choices` stays as `choices`).
- **Agent-level usage.** When [#4005](https://github.com/strands-agents/harness-sdk/pull/4005) merges, the abstract base's `ask` wires `DecisionResult.usage` into `accumulatedUsage` under `source='decision'`.

## Appendix: fully typed interface

The Interface section above is deliberately simplified for readability. The full version used by the implementation is generic over the question map, so each answer's static type is derived from its question's `choices` — a `'boolean'` question yields `boolean | Uncertain`, a string-literal tuple yields that tuple's union plus `Uncertain`.

```ts
export abstract class DecisionModel {
  // Generics allow for better typing on devex (see below)
  async ask<Q extends Record<string, Question>>(
    state: DecisionInput,
    questions: Q,
  ): Promise<DecisionResult<Q>> {
    // Validates questions synchronously, opens a `decision` span,
    // delegates to _ask, records usage, closes the span.
  }

  protected abstract _ask<Q extends Record<string, Question>>(
    state: DecisionInput,
    questions: Q,
  ): Promise<DecisionResult<Q>>
}

export interface Question<C extends 'boolean' | readonly string[] = 'boolean' | readonly string[]> {
  instructions: string
  choices: C
  uncertainOptions?: {
    allow: boolean  // default true
    threshold?: number // [0, 1], default 0.5. Only read by implementations that
    // return per-answer confidence (e.g. System One). The implementation yields
    // `Uncertain` when the question's confidence falls below this value; see
    // the System One section for the exact mapping per answer type.
  }
}

export class Uncertain { constructor(public readonly reason?: string) {} }

export interface DecisionResult<Q extends Record<string, Question> = Record<string, Question>> {
  answers: { [K in keyof Q]: AnswerOf<Q[K]> }
  usage: { inputTokens: number; outputTokens: number; totalTokens: number }
  metadata: { latencyMs: number }
}

// Statically derive each question's answer type from its choices.
export type AnswerOf<Q> =
  // If 'boolean', then the possible return types are boolean | Uncertain
  Q extends Question<'boolean'> ? boolean | Uncertain :
  // If ['red', 'green'], then the possible return types are 'red' | 'green' | Uncertain
  Q extends Question<infer S extends readonly string[]> ? S[number] | Uncertain :
  never

export type DecisionInput = string | ContentBlock[] | Message[]
```

Callers get static narrowing without manual type assertions, provided the `choices` tuple is passed with `as const` so TypeScript keeps the literals.
