# Decision Models

**Date**: 2026-10-03

**Issue**: [#4551](https://github.com/strands-agents/harness-sdk/issues/4551)

**Scope**: Python SDK, experimental.

## Overview

Add `DecisionModel`, an interface for asking a model closed questions about some state: yes or no, or one of a fixed set of options. It has two implementations: `LLMDecisionModel`, which runs on any Strands `Model`, and an experimental `SystemOneDecisionModel` for System One models. `DecisionStrategy` lets `ModelRouter` pick a model with any `DecisionModel`.

## Problem

Agents often need a model to make a small, closed decision. Which specialist should handle this request? Which model should serve this turn? Is this message urgent? The SDK has no type for this. Each place that needs a decision asks a general `Model` for structured output and turns the reply into a value by hand.

System One models, such as [Jev](https://docs.typesafe.ai/concepts/system-one) by TypeSafe and [Strands Decider](https://github.com/strands-labs/strands-decider), are built for exactly these questions. They take state plus questions and return an answer per question, without generating text, faster than an LLM. They cannot be used at the SDK's decision points today, because those points take a `Model`, which is a streaming chat contract.

### Current State

`ClassifierStrategy` ([`classifier_strategy.py`](../../strands-py/src/strands/models/routing/classifier_strategy.py)) is the SDK's one built-in decision. It asks `structured_output` for a candidate index and parses it, and most of its code bounds the request and keeps message content out of the instructions. A second decision point would have to repeat that work.

Its call opens no span, and its tokens reach neither the agent's metrics nor a trace. That is the same gap [#4005](https://github.com/strands-agents/harness-sdk/pull/4005) describes for other auxiliary calls.

Developers who want a System One model write their own HTTP client and branching code, outside any SDK abstraction.

## Proposal

### Recommended: a `DecisionModel` interface

```python
@dataclass(frozen=True)
class Question:
    instructions: str                                # "Which team should handle this ticket?"
    options: type[Enum] | type[bool] = bool          # bool: yes or no. An Enum class: one of its members.
    descriptions: Mapping[Enum, str] | None = None   # optional, what each member means

@dataclass(frozen=True)
class DecisionResult:
    answers: Mapping[str, bool | Enum]               # one answer per question id
    usage: Usage
    model_id: str | None = None

class DecisionModel(abc.ABC):
    @abc.abstractmethod
    async def ask(self, state: str | Mapping[str, Any], questions: Mapping[str, Question], **kwargs) -> DecisionResult: ...
```

An implementation returns an answer for every question id: a `bool`, or a member of that question's `Enum`. How it gets them, whether in one request or one per question, is up to the implementation. A failure raises; there is no partial result.

- **`LLMDecisionModel(model)`** asks any Strands `Model` through a tool call and reads the answers from the tool input. It sends the state as message content and the questions as instructions, so text in the state cannot rewrite a question.
- **`SystemOneDecisionModel(...)`** (experimental) calls a System One endpoint, `POST /v1/systemone`. Jev serves this API, and Strands Decider documents the same request and response shape.
- **`DecisionStrategy(decision_model)`** is a `RoutingStrategy` for `ModelRouter`. It asks one question whose options are the candidates' names and descriptions. On any error it declines, so the router serves its default, as `ClassifierStrategy` does.

Uncertain answers are out of scope. Only System One models measure confidence, so how a caller handles an uncertain answer needs its own design.

#### Token usage and traces

- Every `DecisionResult` carries `usage` (input, output and total tokens). `LLMDecisionModel` takes it from the model's metadata event; `SystemOneDecisionModel` takes it from the response.
- As with `Model`, implementations do not open spans. The SDK code that calls `ask`, `DecisionStrategy` here, opens a `decision` span as a child of the active span. A new `Tracer.start_decision_span`/`end_decision_span` pair follows the existing memory spans.
- The span records `gen_ai.operation.name="decision"`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, the question ids, and the answers as a span event.
- The routing decision's usage counts toward the agent's `accumulated_usage` through the auxiliary-call path in #4005, under source `decision`. Until that lands, usage is on the span and on the result.

**Pros:** one small interface, any implementation; the LLM implementation needs no new vendor; routing gains telemetry it lacks today.

**Cons:** answers are `bool | Enum` and callers narrow them; a second model type to learn; `ClassifierStrategy` and `DecisionStrategy` overlap while both exist.

### Alternative: a System One model as a `Model` provider

- **Pros:** no new type; works anywhere a `Model` does.
- **Cons:** `Model` streams text and tool calls for any schema. A System One model generates neither and answers only closed questions, so the provider would fake a stream and reject most requests at run time.

### Alternative: a typed schema

A Pydantic class whose `bool` and `Literal` fields become questions, returning an instance of that class.

- **Pros:** statically typed answers.
- **Cons:** more surface (schema compiler, builder for run-time options) for something a mapping of `Question`s already covers. It can be added later on top of `ask`.

## Developer Experience

```python
from enum import Enum

from strands import Agent
from strands.experimental.decisions import DecisionStrategy, LLMDecisionModel, Question, SystemOneDecisionModel
from strands.models import BedrockModel, ModelRouter, RoutingCandidate

class Team(Enum):
    BILLING = "billing"
    TECHNICAL = "technical"
    ACCOUNT = "account"

decider = LLMDecisionModel(BedrockModel(model_id="us.amazon.nova-2-lite-v1:0"))
# or: decider = SystemOneDecisionModel()

result = await decider.ask(
    state="I was charged twice and now I can't log in.",
    questions={
        "team": Question("Which team should handle this ticket?", options=Team),
        "urgent": Question("Does the customer need an answer today?"),
    },
)
result.answers["team"]    # Team.BILLING
result.answers["urgent"]  # True
result.usage              # {"inputTokens": 212, "outputTokens": 31, "totalTokens": 243}

router = ModelRouter(
    models=[
        RoutingCandidate(BedrockModel(model_id="global.anthropic.claude-sonnet-5-5"), name="complex",
                         description="Multi-step reasoning, code generation"),
        RoutingCandidate(BedrockModel(model_id="us.amazon.nova-2-lite-v1:0"), name="routine",
                         description="Direct questions, short summaries"),
    ],
    strategy=DecisionStrategy(decider),
)
agent = Agent(model=router)
```

Errors:

- An `Enum` with no members, or empty `questions`, raises `ValueError` before any request.
- A missing or wrong-typed answer from an implementation raises `ValueError`.
- A throttled request raises `ModelThrottledException`.
- `DecisionStrategy` turns every error into a decline.
