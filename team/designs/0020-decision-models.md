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
  async ask<const Q extends Record<string, Question>>(state: DecisionInput, questions: Q): Promise<DecisionResult<Q>> {
    // Validates questions synchronously, opens a `decision` span,
    // delegates to _ask, records usage, closes the span.
  }

  protected abstract _ask<const Q extends Record<string, Question>>(
    state: DecisionInput,
    questions: Q
  ): Promise<DecisionResult<Q>>
}

export interface Question {
  question: string
  choices: 'boolean' | readonly string[]
  uncertainty?:
    | boolean
    | {
        minConfidence?: number // [0, 1]. Overrides the provider's
        // default confidence threshold. Omitted/true permits Uncertain; false
        // requires the provider to return its selected answer.
      }
}

export class Uncertain {
  constructor(public readonly reason?: string) {}
}

export interface DecisionResult<Q extends Record<string, Question> = Record<string, Question>> {
  answers: { [K in keyof Q]: boolean | string | Uncertain }
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
  metadata: {
    latencyMs: number
    providerName?: string
    modelId?: string
    probabilities?: { [K in keyof Q]: Readonly<Record<string, number>> }
    confidence?: { [K in keyof Q]: number }
  }
}

export type DecisionInput = string | ContentBlock[] | Message[]
```

`ask` is generic over the questions map, and `DecisionResult.answers` is a mapped type keyed off the same map. Each answer's type is derived from its question's `choices`: a `'boolean'` question yields `boolean | Uncertain`, a string-literal tuple yields that tuple's union plus `Uncertain`.

Lets say we start with an `LLMDecisionModel` as an implementation of this interface (more about this discussed below). A customer may use it as follows:

```ts
const llmDecisionModel = new LLMDecisionModel({ model: new BedrockModel() })

const result = await llmDecisionModel.ask('The fruit is an apple', {
  color: {
    question: 'What color is the fruit?',
    choices: ['red', 'green', 'blue'],
  },
  isFruit: {
    question: 'Is the thing talked about a fruit?',
    choices: 'boolean',
    uncertainty: false,
  },
})

// result.answers.color   is 'red' | 'green' | 'blue' | Uncertain
// result.answers.isFruit is boolean
```

### Uncertainty handling

`Uncertain` is a possible answer for every question unless the caller sets `uncertainty: false`. Each implementation handles uncertainty according to the evidence it has:

- `LLMDecisionModel` includes `uncertain` as an allowed model answer.
- API-backed decision models compare per-answer confidence with a threshold. An explicit `uncertainty.minConfidence` takes precedence over the provider instance's `defaultMinConfidence`; otherwise each provider uses its API-wide default of `0.5`.
- Choice uses the API-returned confidence. Noul returns only a yes probability `p`, so its confidence is `|2p - 1|`, on the same scale where an even split is `0` and certainty is `1`.
- Some APIs return their own Noul confidence on a different scale. Gemini Decisions reports `max(p, 1 - p)`, where an even split is `0.5`. The provider reports that value in metadata, so callers see the confidence the API documents, but normalizes it to `|2p - 1|` (equal to `2 * confidence - 1`) before comparing it with `minConfidence`. A threshold therefore means the same thing for every provider. Because Gemini caps `p` at `[0.01, 0.99]`, its normalized Noul confidence is at most `0.98`, so a `minConfidence` above `0.98` always yields `Uncertain` for its Noul answers.

A provider returns `Uncertain` when uncertainty is enabled and the threshold confidence is below `minConfidence`; equality passes. The threshold confidence is the reported confidence, except for Noul answers from APIs that report their own scale, which use the normalized value above. Metadata retains every question's probability distribution and reported confidence even when its public answer is `Uncertain`.

Customers can handle `Uncertainty` in there code as follows:

```ts
const llmDecisionModel = new LLMDecisionModel({ model: new BedrockModel() })

const result = await llmDecisionModel.ask('The fruit is an apple', {
  color: {
    question: 'What color is the fruit?',
    choices: ['red', 'green', 'blue'],
  },
  isFruit: {
    question: 'Is the thing talked about a fruit?',
    choices: 'boolean',
    uncertainty: false,
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

A `DecisionResult` carries token usage when the underlying provider reports it. The `decision` span opened by the base class records `gen_ai.operation.name="decision"`, available token usage, the question ids, and the answers. API-backed implementations also return the provider name, resolved model id, per-question probabilities, confidence, and latency in typed metadata. Agent-level `accumulatedUsage` wiring lands when [#4005](https://github.com/strands-agents/harness-sdk/pull/4005) merges — the base class picks up the auxiliary-call hook under `source='decision'` without changing the public surface.

### System One Decision Models

Each decision API gets its own `DecisionModel` provider class so endpoints, credentials, model ids, request limits, error handling, and confidence defaults do not leak into the base abstraction:

- `TypeSafeDecisionModel` calls TypeSafeAI's hosted [Jev API](https://docs.typesafe.ai/introduction), using `TYPESAFE_API_KEY` and the provider's Jev model ids.
- `DecisionsAPIDecisionModel` calls [decisionapi.net](https://decisionapi.net/), using `JEV_API_KEY` and that service's model catalog.
- `SageMakerDecisionModel` calls a System One model hosted on a SageMaker AI real-time endpoint through `InvokeEndpoint`, signed with SigV4 through the standard AWS credential chain instead of an API key. It isn't tied to one model: any container that serves the System One wire format works, such as one deployed with strands-decider's [`deploy/sagemaker`](https://github.com/strands-labs/strands-decider/tree/main/deploy/sagemaker). It is exported from `@strands-agents/sdk/decisions/sagemaker` rather than the package root, so `@aws-sdk/client-sagemaker-runtime` stays an optional peer that is loaded on first use and its types stay out of the root `.d.ts`. Callers can pass a pre-built `SageMakerRuntimeClient`.
- `GeminiDecisionModel` calls Google's [Gemini Decisions API](https://ai.google.dev/gemini-api/docs/decisions-api) (`gemini-decision-1`), using `GEMINI_API_KEY` sent in the `x-goog-api-key` header. Its wire format differs from the other System One APIs: the request carries `input` instead of `state`, Choice criteria take string descriptions, the response does not echo `model`, and usage is reported as `total_input_tokens` and `total_output_tokens`. It also returns its own Noul confidence, handled as described in [Uncertainty handling](#uncertainty-handling). It calls the REST endpoint with `fetch` rather than `@google/genai`, whose installed version does not expose the Decisions API.
- [Strands Decider](https://github.com/strands-labs/strands-decider) is vended from its own repository. Its models can be self-hosted on SageMaker and called through `SageMakerDecisionModel`, and it can still add its own provider class.

The System One providers map `choices: 'boolean'` to Noul and string choices to Choice. Score remains future work. They share internal wire validation and answer normalization, while each public class owns its API's defaults, limits, transport, and error mapping. Text and structured `ContentBlock` state serialize as JSON; byte-backed media is rejected instead of being misrepresented as base64 text. API keys are server-side credentials; the API-key providers reject browser construction rather than expose them to page users. `SageMakerDecisionModel` has no key to expose, since its credentials come from the AWS credential chain.

When Bedrock hosts decision models, it should receive a separate provider implementation as well. Other APIs can be considered case by case.

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
- **Uncertainty default handling.** Instead of each customer including custom logic to handle default handling, we can include some default option to return if the model is uncertain. Some kind of `uncertainty.default` setting.
- **ClassifierStrategy rewrite.** A thin `DecisionStrategy` routing passthrough + `ClassifierStrategy` as a preset on top, dropping ~325–375 lines of scaffolding across the two SDKs. First real caller that validates the primitive against production load.
- **Python port.** Mirror the TypeScript design, swapping `StructuredOutputTool` + `toolChoice` for `model.structured_output` with a dynamic Pydantic model. Names convert mechanically (`uncertainty` ↔ `uncertainty`, `minConfidence` ↔ `min_confidence`, and `choices` stays as `choices`).
- **Agent-level usage.** When [#4005](https://github.com/strands-agents/harness-sdk/pull/4005) merges, the abstract base's `ask` wires `DecisionResult.usage` into `accumulatedUsage` under `source='decision'`.

## Appendix: fully typed interface

The Interface section above is deliberately simplified for readability. The full version used by the implementation is generic over the question map, so each answer's static type is derived from its question's `choices` — a `'boolean'` question yields `boolean | Uncertain`, a string-literal tuple yields that tuple's union plus `Uncertain`.

```ts
export abstract class DecisionModel {
  // Generics allow for better typing on devex (see below)
  async ask<const Q extends Record<string, Question>>(state: DecisionInput, questions: Q): Promise<DecisionResult<Q>> {
    // Validates questions synchronously, opens a `decision` span,
    // delegates to _ask, records usage, closes the span.
  }

  protected abstract _ask<const Q extends Record<string, Question>>(
    state: DecisionInput,
    questions: Q
  ): Promise<DecisionResult<Q>>
}

export interface Question<C extends 'boolean' | readonly string[] = 'boolean' | readonly string[]> {
  question: string
  choices: C
  uncertainty?:
    | boolean
    | {
        minConfidence?: number // [0, 1]. Overrides the provider's
        // default confidence threshold. Omitted/true permits Uncertain; false
        // requires the provider to return its selected answer.
      }
}

export class Uncertain {
  constructor(public readonly reason?: string) {}
}

export interface DecisionResult<Q extends Record<string, Question> = Record<string, Question>> {
  answers: { [K in keyof Q]: AnswerOf<Q[K]> }
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
  metadata: {
    latencyMs: number
    providerName?: string
    modelId?: string
    probabilities?: { [K in keyof Q]: Readonly<Record<string, number>> }
    confidence?: { [K in keyof Q]: number }
  }
}

// Statically derive each question's answer type from its choices.
export type AnswerOf<Q> =
  // If 'boolean', then the possible return types are boolean | Uncertain
  Q extends Question<'boolean'>
    ? boolean | Uncertain
    : // If ['red', 'green'], then the possible return types are 'red' | 'green' | Uncertain
      Q extends Question<infer S extends readonly string[]>
      ? S[number] | Uncertain
      : never

export type DecisionInput = string | ContentBlock[] | Message[]
```

Inline question maps keep literal choice types through `ask`'s const type parameter. Use `defineQuestions` when storing a question map before calling `ask`.
