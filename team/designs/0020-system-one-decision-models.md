# Decision Models

**Status**: Proposed

**Date**: 2026-09-24 (revised 2026-09-28 after review)

**Issue**: [#4551](https://github.com/strands-agents/harness-sdk/issues/4551)

**Scope**: Python SDK, experimental. TypeScript follows once the Python API settles.

## Problem

Agents keep asking a model small, closed questions. Which specialist should handle this request? Which model tier should serve this turn? Does this message raise more than one issue? Today each of those questions is asked through a general `Model`, and each integration builds the same things by hand:

| Decision point | Today |
|---|---|
| Model selection | `ClassifierStrategy` asks `structured_output` for an integer index and parses it ([`classifier_strategy.py`](../../strands-py/src/strands/models/routing/classifier_strategy.py)). |
| Graph routing | An LLM node emits text or structured output, then an `EdgeCondition` parses it. |
| Entry-point dispatch | Developer code prompts an agent and branches on its reply. |

Each one re-implements four things:

- projecting agent context into a bounded input;
- keeping untrusted content apart from instructions;
- mapping the reply to a typed value;
- deciding what to do when the answer is unclear.

`ClassifierStrategy` alone spends about 150 lines on bounding and injection-hardening, and a graph router would need the same again.

There is also a class of model built only for this: **System One** models such as [Jev](https://docs.typesafe.ai/concepts/system-one) by TypeSafe. They take state plus typed questions and return a probability for every option, and they generate no text. Strands has no seam where such a model fits, because every decision point is typed as `Model`, which is a streaming chat contract.

## Goal

Add one abstraction for asking a model to decide: `DecisionModel`.

- Callers declare closed questions as typed Python and get typed answers.
- One implementation runs on any existing `Model`, so the abstraction is useful with no new vendor.
- A System One model is another implementation.
- The SDK's decision points (model routing, graph edges, and a front-door dispatcher) accept a `DecisionModel` instead of re-implementing the pattern.

## Proposal

```
 Adapters    DecisionAgent(routes=, fallback=) · when_choice / when_yes / when_below · DecisionStrategy
                 │ use
 Schema      class Triage(DecisionSchema): field: Annotated[Literal[...], Choice(...)]   →  Decision[Triage]
                 │ compiles to
 Primitive   DecisionModel.ask(state, {id: Choice | Score | YesNo}) → DecisionResponse
             implementations: LLMDecisionModel(model) · SystemOneDecisionModel() (experimental) · your own
```

### The primitive

```python
class DecisionModel(abc.ABC):
    async def ask(self, state: DecisionState, questions: Mapping[str, Question], **kwargs) -> DecisionResponse: ...
    async def decide(self, schema: type[T], state: DecisionState, **kwargs) -> Decision[T]: ...

    @abc.abstractmethod
    async def _ask(self, state, questions, **kwargs) -> DecisionResponse: ...   # the one method a provider writes
```

- **Questions** are closed: `Choice` picks one of N named options, `YesNo` gives the probability that a condition holds, and `Score` rates on two or more ordered levels. Anything open-ended belongs to a generative model.
- **All questions are asked together**, in one request. `ask` validates that every answer matches its question, and records one `decision` telemetry span with the question kinds, the answers, the model id and token usage.
- **State is data.** Each implementation passes it as untrusted content, never as instructions.

### The typed schema

```python
class Triage(DecisionSchema):
    department: Annotated[Literal["billing", "technical", "account"] | None, Choice("Which team?", options={...})]
    multi_issue: Annotated[bool, YesNo("More than one independent problem?")]

decision = await decider.decide(Triage, state=ticket)
decision.output.department                 # "billing": typed, IDE-checked
decision.answers["department"]             # ChoiceAnswer(choice, probabilities, confidence)
```

`DecisionSchema` is a Pydantic `BaseModel` that compiles its questions when the class is defined, so a field no decision model can answer is an error at import time rather than at the first request. The field types map as follows:

- `Literal`/`Enum` becomes a `Choice`.
- `bool` becomes a `YesNo`, read True at or above its threshold.
- `float` with a `Score` marker becomes a `Score`.
- `X | None` adds a `"none"` option.

`DecisionSchema.build(name, **questions)` builds a schema at run time, for options only known then (for example the elements on a page).

### Implementations

| | `LLMDecisionModel(model)` | `SystemOneDecisionModel()` (experimental) |
|---|---|---|
| Runs on | Any Strands `Model`, through one forced tool call | TypeSafe's hosted Jev, `POST /v1/systemone` (`strands-agents[typesafe]`) |
| `probabilities` | From the answer token's logprobs when the model returns them; otherwise one-hot | One per option |
| `confidence` | The top probability with logprobs; otherwise `None` | The model's own |

A custom implementation, such as a local classifier or another vendor, subclasses `DecisionModel` and implements `_ask`.

### Confidence, and what "unsure" means

Every answer carries `probabilities` plus an optional `confidence: float | None`. The review asked whether confidence is needed at all for LLM implementations, and whether there should be an explicit "unconfident" answer.

- **The model decides, answer by answer.** There is no model-level flag. An implementation sets `confidence` when it can measure it and leaves it `None` when it cannot.
- **LLMs.** `LLMDecisionModel` never asks an LLM to state a confidence, because a stated confidence is not a measurement. When the model returns token logprobs, it reads the answer token's logprobs over the labels. The renormalised distribution becomes `probabilities`, and its peak becomes `confidence`. On Bedrock that covers open-weight models on the OpenAI-schema stack, such as Qwen3, DeepSeek, Ministral 3 and GLM, with a non-streaming `BedrockModel`. Claude, Nova and Llama return no logprobs, so their answers are one-hot with `confidence=None`.
- **"Unsure" is a gate, not an answer.** Adapters take an optional `min_confidence`. An answer below it, or with `confidence=None`, takes the adapter's fallback path. The first such `None` logs a warning, so a gate on a model that never reports confidence is visible rather than silent.
- **"None of these" is an option.** An optional `Choice` (`X | None`) lets the model answer `"none"`, which is different from being unsure.

Implementers of a new decision model only return answers. A raw logprob confidence tends to run high; fitting a temperature for a domain is follow-up 2.

### Adapters

Each adapter uses only the primitive, so it works with any implementation.

- **`DecisionAgent`**: an `AgentBase` that decides and then dispatches, typically as the first agent to see external input.
  - It routes a confident answer to `routes[choice]` (an agent or a plain function), and anything unsure or unmatched to `fallback`.
  - It records the decision at `result.state["decision"]`.
- **Graph edges**: `when_choice`, `when_yes` and `when_below` build `EdgeCondition`s that read a `DecisionAgent` node's recorded decision, so `Graph` itself needs no change.
- **`DecisionStrategy`**: a `RoutingStrategy` for `ModelRouter`, a peer of `ClassifierStrategy` from [0016](./0016-model-routing.md).
  - It asks one `Choice` over the candidates' descriptions.
  - Below `min_confidence` it declines, and the router serves its default.
  - It shares the bounded, injection-hardened request text with `ClassifierStrategy` (`models/_request_text.py`).
  - Direction: both strategies remain while `DecisionStrategy` is experimental. `DecisionStrategy(LLMDecisionModel(model))` covers the same job as `ClassifierStrategy(model)`: it picks a candidate with an LLM and declines only on errors. So if `DecisionStrategy` graduates, `ClassifierStrategy` becomes a thin alias for it and is deprecated under the [feature lifecycle](../FEATURE_LIFECYCLE.md).

### Failure modes

| Failure | Behaviour |
|---|---|
| State or questions over the provider's budget | `ContextWindowOverflowException` before sending |
| Throttled or overloaded (429/529) | `ModelThrottledException` |
| Malformed or mismatched answers | `ValueError` from `ask`; `DecisionStrategy` then declines to the router default |
| Low or missing confidence under a `min_confidence` gate | The adapter's fallback path, never a silent coercion |

## Alternatives considered

- **A System One model as a `Model` provider.** `Model` is a streaming chat contract: messages in, text and tool calls out, plus `structured_output` for any schema. A decision model has none of that, and it answers only closed questions. Forcing it into `Model` would mean faking a stream and rejecting most schemas at run time.
- **Only a dict-level API.** `ask` with `Choice`/`YesNo` objects is kept as the low-level escape hatch, but on its own it gives up typed answers and IDE help ([Provide Both Low-Level and High-Level APIs](../DECISIONS.md#provide-both-low-level-and-high-level-apis)).
- **A `decision_model=` parameter on `Agent`.** This would change the `Agent` contract for a feature most agents never use. The adapters compose with `Agent` from outside instead.

## Objective check

This checks the objectives from #4551 against the initial PR and the follow-ups.

| Objective | Met by |
|---|---|
| A decision model is a first-class, vendor-neutral type | `DecisionModel`, with two implementations that share no code path beyond the base class |
| It drives control flow at existing decision points | `DecisionStrategy`, graph edges and `DecisionAgent`, with no change to `Agent`, `Model` or `Graph` |
| Typed, developer-friendly API with a low-level escape hatch | `DecisionSchema` → `Decision[T]`; `ask` with question objects |
| Honest uncertainty and safety | `confidence` only when measured (System One, or LLM logprobs), never stated by the LLM; `None` is unsure under a gate; state is untrusted data; the failure table above |
| Observable | One `decision` span per request, with answers, model id and usage |
| Pay for play | Experimental package; the vendor SDK is an optional extra |
| Use cases and placements, with samples | Initial PR: routing and handoff (`support_triage.py`: front door and graph node). Model selection, browser use and guardrails: follow-ups 1 and 4 |
| TypeScript parity | Follow-up 7 |

## Follow-ups

Each follow-up is a separate PR stacked on the initial one, with its own tests, docs section and sample:

1. **Samples**: model selection (`mixture_of_models.py`) and browser next-action, plus the System One vs LLM baseline benchmark and its harness.
2. **Calibration**: an optional fitted `temperature` that rescales raw scores, such as LLM logprobs, for a domain.
3. **Self-hosted System One**: Kev over the same API, and a SageMaker implementation.
4. **Guardrails**: `DecisionGuard` for tool calls, and `decision_tool` for decisions the LLM can request.
5. **Swarm handoff** driven by a decision model.
6. **Fast path**: take a confident next action without an LLM turn.
7. **TypeScript** port.
8. **Usage accounting** through the auxiliary-model-call design ([#4005](https://github.com/strands-agents/harness-sdk/issues/4005)).

## Consequences

- There is one place to add a decision implementation, and each SDK decision point gets it for free.
- Developers learn a second model type. The docs lead with "a `Model` generates; a `DecisionModel` decides".
- `ClassifierStrategy` and `DecisionStrategy` coexist. The docs say to use `DecisionStrategy` for a confidence gate, and `ClassifierStrategy` for an LLM with no confidence.
- Model aliases such as `jev-latest` move with new releases, so the docs recommend pinning a versioned id once thresholds are tuned. Spans record the id that answered.

Migration: none.

## Willingness to Implement

Yes.
