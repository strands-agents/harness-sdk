# System One Decision Models

**Status**: Proposed

**Date**: 2026-09-24

**Issue**: [#4551](https://github.com/strands-agents/harness-sdk/issues/4551)

**Scope**: Python SDK first; the TypeScript shape is specified here and ported after the Python API stabilizes (the same sequencing as [0016 Model Routing](./0016-model-routing.md)).

## Problem

Agents make many small decisions that are not generation: which specialist handles this request, which model tier serves this turn, whether this tool call needs a human, which on-screen element to click next, whether an answer is faithful to its source. Today every one of those decisions is made by a general-purpose LLM asked to emit a structured answer — the same model family, latency, and price as the generative work around it.

A class of models built for exactly this exists. **System One** models (the name follows Kahneman's fast/slow distinction) take natural-language _state_ plus a set of _typed questions_ and return typed answers with calibrated probabilities. They do not generate text. [Jev](https://docs.typesafe.ai/concepts/system-one) by TypeSafe is the first commercially available one.

Strands has no way to express "ask a decision model a typed question." Developers who want one hand-roll an HTTP client, re-derive the SDK's bounded-context and untrusted-input handling, and wire the answer into routing, graphs, or guardrails by hand — once per integration point.

### Current State

**Every SDK decision point is an LLM wearing a classifier costume.**

| Decision point      | Today                                                                                                                                                                                                                        | What it costs                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Model selection     | `ClassifierStrategy(model: Model)` calls `model.structured_output(_ClassifierSelection)` and parses an integer index ([`classifier_strategy.py`](../../strands-py/src/strands/models/routing/classifier_strategy.py))        | A full LLM call per invocation; the index carries no uncertainty, so the strategy can only decline on _errors_, never on _ambiguity_ |
| HITL risk           | `_create_llm_risk_classifier` builds a fresh inner `Agent` and asks for `_RiskDecision(requires_approval: bool, reason: str)` ([`hitl/classifier.py`](../../strands-py/src/strands/vended_interventions/hitl/classifier.py)) | An agent loop per tool call; a bare boolean that cannot express "I'm not sure"                                                       |
| Graph routing       | `EdgeCondition` is a sync `(GraphState) -> bool` ([`graph.py`](../../strands-py/src/strands/multiagent/graph.py))                                                                                                            | Semantic routing requires an LLM node that emits text or structured output, then a condition that parses it                          |
| Swarm handoff       | The active LLM calls `handoff_to_agent(agent_name, …)`                                                                                                                                                                       | Routing is a side effect of a generative turn; there is no confidence and no deterministic override                                  |
| Guardrails / judges | User-written `InterventionHandler`s or an inner `Agent`                                                                                                                                                                      | Each author re-solves prompt construction, bounding, and parsing                                                                     |

**A System One model cannot be plugged into any of these today.** Every seam above is typed as `Model`, and `Model` is a streaming chat contract: `stream(messages, tool_specs, …) -> AsyncIterable[StreamEvent]` plus `structured_output(output_model: type[BaseModel], …)`. A decision model has no messages, no tool use, no text stream, and cannot answer an arbitrary Pydantic schema — only closed-set, yes/no, and ordinal fields. Implementing `Model` for Jev would mean faking a text stream and raising on most schemas. The seam that exists is the wrong shape.

**The paper cuts compound.** Each integration re-implements the same four things: projecting agent context into a bounded state, isolating untrusted content from instructions, mapping the answer to a typed value, and deciding what to do when the model is unsure. `ClassifierStrategy` alone spends ~150 lines on bounding and injection-hardening that a guard or graph router would need again.

**Measured on the live API** (jev-1.13.0, 2026-09-24, one request per use case, 5-run p50 for the fan-out row; scripts in the PR's sample directory):

| Use case shape                                  | Questions              | p50 latency       | Input tokens | Answer                                                                               |
| ----------------------------------------------- | ---------------------- | ----------------- | ------------ | ------------------------------------------------------------------------------------ |
| Multi-agent routing (next agent + multi-issue?) | Choice(4) + Noul       | 0.81 s            | 440          | `billing_agent` p=0.60 vs `auth_agent` 0.34, **confidence 0.46**; multi-issue p=0.98 |
| Model selection (tier + difficulty)             | Choice(2) + Score(4)   | 0.63 s            | 424          | `complex` confidence 0.99                                                            |
| Browser use (next element + goal reached?)      | Choice(6) + Noul       | 0.56 s            | 498          | `e2` ("Add to cart") p=0.91; goal reached p=0.07                                     |
| Guardrail (approval, severity, faithful output) | Noul + Score(4) + Noul | 0.60 s            | 421          | approval p=0.97; severity 2.93 on levels 0–3; output faithful p=0.24                 |
| Fan-out: 1 question vs 12 on the same state     | 1 / 12                 | 0.579 s / 0.568 s | 339 / 751    | latency flat in question count                                                       |

Two observations drive the design. First, the routing row's low confidence is _correct_ — the request genuinely has two issues — and it is exactly the signal an LLM index cannot give. Second, twelve questions cost the same wall-clock as one, so the API must make asking together the default, not an optimization. At the listed price ($0.042 per million input tokens, output free) a decision costs on the order of $0.00002. A same-task LLM baseline on public labeled data is in the companion [baseline](./0020-system-one-decision-models-baseline.md). Jev ties Claude Haiku 4.5 on intent routing at about 1/30th of the cost and 0.3 s lower median latency (0.25 s on the guardrail task). It trails Haiku by 11 points on prompt-injection detection. A confidence-gated cascade to the LLM beats Haiku-only on routing at about a fifth of the cost.

## Goals

The issue sets the objectives; each is a pass/fail criterion the Proposal is checked against in [Objective Check](#objective-check).

- **G1 Model-first, as a provider primitive.** A System One model is a first-class, vendor-neutral model type with its own contract, peer to `Model`. Jev is the first provider; the contract admits others (a local classifier, a future vendor, a self-hosted open model such as [Kev](https://github.com/jaredpalmer/kev)) and an LLM-backed adapter.
- **G2 Model-first, as control flow.** A decision model can _drive_ control flow at the SDK's existing decision points — model routing, graph edges, entry-point dispatch, tool gating — through supported integration points, not glue.
- **G3 Developer-friendly typed API.** Questions are declared as typed Python the IDE understands; answers come back typed; asking together is the default; confidence is a first-class value; simple cases need one import and a few lines, and a low-level escape hatch exists ([Provide Both Low-Level and High-Level APIs](../DECISIONS.md#provide-both-low-level-and-high-level-apis)).
- **G4 Four use cases, validated.** Runnable samples for dynamic multi-agent routing, model selection, computer/browser use, and guardrails/judges, each measured against an LLM baseline. Evals move to a separate issue.
- **G5 Three placements, explained.** Samples and docs for a decision model as (a) the first agent that sees external input, (b) a subagent/node, (c) a tool — with guidance on when each fits.
- **G6 Pay for play.** No change to `Agent`, `Model`, or any default behavior; the vendor SDK is an optional extra.
- **G7 Honest uncertainty and safety.** Facts stay in code; uncertainty is surfaced, never silently coerced; every integration states its failure mode; state is treated as untrusted data.
- **G8 Observable and accountable.** Decision calls appear in traces and usage, consistent with the in-flight auxiliary-model-call design.
- **G9 Cross-SDK parity.** The TypeScript surface is specified now so Python choices do not strand it.

Non-goals (v1): evals and LLM-as-judge scoring (separate issue); training or fine-tuning; multimodal state (Jev is text-only — callers pre-process images into text); replacing the generative agent loop.

## Key Decisions

1. **Relevant prior decisions.** [0016 Model Routing](./0016-model-routing.md) already reserves a "small decision model" slot (`ClassifierStrategy`) and the `RoutingStrategy` protocol — the System One strategy is a peer there, not a new mechanism. [Hooks as Low-Level Primitives](../DECISIONS.md#hooks-as-low-level-primitives-not-high-level-abstractions) says integrations get domain interfaces, not raw hooks. [Flat Namespaces](../DECISIONS.md#prefer-flat-namespaces-over-nested-modules) puts the common surface in one module. [Avoid Overloading Domain Terms](../DECISIONS.md#avoid-overloading-domain-terms-in-api-naming) governs question-type names. In-flight [#4005](https://github.com/strands-agents/harness-sdk/pull/4005) (auxiliary model calls) defines how non-loop model calls report usage; decision calls should use it rather than invent their own.
2. **Assumptions and invariants.**
   - A decision model answers _closed_ questions only: one-of-N, yes/no probability, ordinal level. Anything open-ended is extracted into candidates by code first ("select, don't generate").
   - Probabilities are only meaningful from a model that declares itself calibrated. Confidence thresholds are code-owned policy, evaluated per consequence.
   - Deterministic facts (lane legality, permissions, budgets, blockers) are gated in code _before_ a decision is asked.
   - Decision answers are data; they never become model-visible instructions without code choosing to put them there.
3. **Alternatives set aside** (detailed below): Jev as a `Model` subclass; a dict-only API; baking System One into the `Agent` constructor.
4. **For the review to align on:** the new `DecisionModel` primitive vs. extending `Model`; `experimental` placement; and whether the System-One-first fast path (P1) belongs in the SDK. The type names are proposed with their rationale and rejected alternatives in [Naming](#naming).

## Proposal

The proposal has three layers. Each layer uses only the one beneath it, so a developer can start at any of them.

```
 Layer 3  Integrations      DecisionStrategy · DecisionAgent(routes=) · when_choice() · decision_tool() · DecisionGuard
                                   │ uses
 Layer 2  Typed schema      Pydantic class with Choice / Score / YesNo fields  →  Decision[T]
                                   │ compiles to
 Layer 1  Primitive         DecisionModel.ask(state, questions) → answers
                            providers: TypeSafeDecisionModel (Jev) · LLMDecisionModel(model) · your own
```

### Recommended: a `DecisionModel` primitive with typed schemas and integration adapters

#### Layer 1 — the primitive (G1)

`DecisionModel` is a new abstract base, a peer to `Model` (not a subclass), with one required method:

```python
class DecisionModel(abc.ABC):
    @property
    def calibrated(self) -> bool:
        """True when answer probabilities are trained to be calibrated. Gates that threshold on
        confidence require it."""
        return False

    @abc.abstractmethod
    async def ask(
        self,
        state: DecisionState,                 # str | Mapping[str, JSON] | Sequence[JSON]
        questions: Mapping[str, Question],     # Choice | Score | YesNo
        **kwargs: Any,
    ) -> DecisionResponse: ...                # answers keyed like questions, plus usage + model id

    def get_config(self) -> Any: ...
    def update_config(self, **config: Any) -> None: ...
```

- **`TypeSafeDecisionModel`** (optional extra `strands-agents[typesafe]` → `typesafe-sdk`, MIT) calls `POST /v1/systemone`. `calibrated = True`. It reads `TYPESAFE_API_KEY` by default, defaults to `model_id="jev-latest"`, records the versioned id that answered (`jev-1.13.0`), maps 429/529 to `ModelThrottledException` so existing retry strategies apply, and validates context budgets (64k total; 32k for state plus the longest question) before sending. `base_url=` points it at any server that speaks the same API, such as a self-hosted Kev. In that case it never reads `TYPESAFE_API_KEY`, so a TypeSafe key is not sent to a third party, and the budgets are configurable (Kev serves 8,192 tokens for state plus one question, with no per-request cap). It also validates the TypeSafe API's documented limits before sending (see [Question types](#question-types)).
- **Kev**, an open-weight family of System One models (Apache-2.0, 0.8B–27B) that serves the same `/v1/systemone` API, is the second backend for `TypeSafeDecisionModel`. It needs no new class. Each checkpoint ships with a fitted temperature, so it is calibrated. The samples run on it (`--engine kev`), and it runs on commodity hardware: Kev-4B answered in 0.45–1.5 s per request on a 32-core CPU with no GPU.
- **`LLMDecisionModel(model: Model)`** answers the same questions through `model.structured_output`. `calibrated = False`, probabilities are one-hot, and `confidence` is `None`. It exists so every integration below runs without a vendor account, and so benchmarks compare the same questions on both engines.
- Custom providers subclass `DecisionModel` (for example a local classifier or a future vendor).

#### Question types

Question types are small frozen dataclasses mirroring the three closed shapes. The same objects serve as `Annotated` markers in Layer 2:

| Type                                                        | Asks                               | Answer                                                         |
| ----------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------- |
| `Choice(instructions, options={name: description \| None})` | one of N options                   | `ChoiceAnswer(choice, probabilities, confidence)`              |
| `Score(instructions, levels=[...])`                         | position on ordered levels         | `ScoreAnswer(score, probabilities, confidence)`, plus `.level` |
| `YesNo(instructions, true=None, false=None, threshold=0.5)` | probability that a condition holds | `YesNoAnswer(probability)`, plus a derived `.confidence`       |

`instructions` and option/level descriptions accept strings or JSON structure, as the Jev API does.

**Answer semantics.** Every answer carries the full distribution. The summary fields are defined the same way for every provider:

- `ChoiceAnswer.probabilities` maps each option name to its probability. `choice` is the most probable option. `confidence` is the provider's calibrated confidence in `choice`, in [0, 1].
- `ScoreAnswer.probabilities` maps each level _index_ (0 to `len(levels) - 1`) to its probability. `score` is the probability-weighted level index, `Σ index × p(index)`, so it lies in `[0, len(levels) - 1]`. With levels `["calm", "frustrated", "very angry"]`, a `score` of 1.4 means "between frustrated and very angry, nearer frustrated". `level` is the most probable index. `confidence` is the provider's calibrated confidence, in [0, 1]. Threshold `score` for "how much", and `confidence` for "how sure".
- `YesNoAnswer.probability` is the probability that the condition holds, in [0, 1]. A yes/no answer has no separate confidence on the wire; its uncertainty _is_ the probability. Calibrated providers set `YesNoAnswer.confidence` to `yes_no_confidence(p) = |2p − 1|`: 0 at p = 0.5 (no idea), 1 at p = 0 or 1 (certain). It is defined only so gates that read `confidence` (`when_below`) compose over every answer type. Policy on a yes/no field should threshold `probability` directly, as `YesNo(threshold=)`, `when_yes`, and `DecisionGuard`'s floors do.
- Every `confidence` is `None` when the provider is not calibrated. A gate reads `None` as "unsure", never as "sure".

**Contract limits and provider limits.** The question types enforce only what the _shape_ needs, so a local classifier or a future vendor inherits no single vendor's limits:

| Constraint                                                                           | Level                                             | Enforced                                                               |
| ------------------------------------------------------------------------------------ | ------------------------------------------------- | ---------------------------------------------------------------------- |
| Non-empty `instructions`; `Score` has at least 2 levels; `YesNo.threshold` in [0, 1] | Contract (every provider)                         | `ValueError` at question construction                                  |
| A `Choice` has at least one option when asked (a schema marker may omit them)        | Contract (every provider)                         | `DecisionModel.ask`, before the provider is called                     |
| `Choice` ≤ 255 options; `Score` ≤ 10 levels                                          | TypeSafe API (Jev); Kev accepts up to 255 of each | `TypeSafeDecisionModel.ask`, before sending, for every server it calls |
| Context budget (state plus the longest question; whole request)                      | Provider, configurable                            | The provider, before sending: `ContextWindowOverflowException`         |
| Anything else a custom provider cannot answer                                        | That provider                                     | Its `ask`, before sending, naming the question                         |

#### Layer 2 — typed schemas (G3)

The high-level API reuses the idiom Strands developers already know from `structured_output_model`: **a Pydantic class is the schema.** Field types say what is being decided and markers say how to ask:

```python
from typing import Annotated, Literal
from pydantic import BaseModel
from strands.decisions import Choice, Score, YesNo

class Triage(BaseModel):
    department: Annotated[
        Literal["billing", "technical", "sales"],
        Choice("Which team should handle `ticket`?", options={
            "billing": "Payments, invoices, refunds",
            "technical": "Bugs, outages, integrations",
            "sales": "Pricing, upgrades, new accounts",
        }),
    ]
    urgent: Annotated[bool, YesNo("Does `ticket` convey time pressure?")]
    frustration: Annotated[float, Score("How frustrated is the customer?", levels=["calm", "frustrated", "very angry"])]

decision = await jev.decide(Triage, state={"ticket": text})
decision.output.department                 # Literal["billing", "technical", "sales"], IDE-checked
decision.answers["department"].confidence  # 0.81
decision.answers["urgent"].probability     # 0.95
```

`decide(schema, state)` is a concrete method on `DecisionModel`. It compiles the class into questions **once** (cached per class) and calls `ask` a single time, so every field is asked together. It then builds `Decision[T]`, where `output: T` holds the validated instance and `answers` holds the full per-field distributions.

Compile rules keep the obvious path correct:

- `Literal[...]` or `Enum` → `Choice`. Options come from the type; descriptions come from the marker's `options`. A bare `Field(description=…)` also works, so an existing `structured_output_model` whose fields are all closed-set can be reused unchanged.
- `bool` → `YesNo`. `output` holds `probability >= threshold`, where `threshold` is a marker parameter defaulting to 0.5. The raw probability always stays on `answers`.
- `float` with a `Score` marker → `Score`.
- **Anything else raises `TypeError` at compile time**, with the fix spelled out. For a `str` field the message reads: _"System One models select or score; they do not generate. Extract candidates in code and ask a `Choice` over them, or use an LLM for this field."_
- Optional fields (`X | None`) signal an explicit no-match option. The compiler adds a `none` option so that "nothing fits" can win.

The class is also a valid `structured_output_model`, so one schema runs on Jev or on any LLM (through `LLMDecisionModel`) without edits. This is what makes the choice of engine a deployment decision rather than a rewrite.

Dynamic option sets (agent names, candidate models, on-screen elements) cannot be `Literal`. They use the low-level `ask` with `Choice(options=…)` built at runtime, or `DecisionSchema.build(...)`, which returns a typed-enough `Decision[dict]`. Every Layer 3 adapter with runtime options builds its questions this way.

**State projection.** `state` is whatever the caller passes. For adapters that start from an agent conversation, a shared helper `project_state(messages, system_prompt, *, max_tokens)` builds on the bounded latest-request and instruction extraction that [#4586](https://github.com/strands-agents/harness-sdk/pull/4586) moves out of `ClassifierStrategy` into one module, so every adapter bounds and sanitizes the same way. Limits are in tokens ([LLM-native units](../DECISIONS.md#use-llm-native-units-in-public-apis)). Because a System One request separates `instructions` (developer-authored) from `state` (data), untrusted content never sits in the instruction channel. State can still try to persuade, so adapters document it as untrusted and never interpolate state into instructions.

#### Layer 3 — integrations that let the model drive control flow (G2, G4, G5)

Each adapter wraps a seam that already exists. **No `Agent`, `Graph`, or `ModelRouter` internals change in P0.**

**Model selection — `DecisionStrategy` for `ModelRouter`.** A `RoutingStrategy` peer to `ClassifierStrategy`. It asks one `Choice` over the candidates' names, descriptions, and metadata, with the projected latest request as state. It declines (so the router serves its default) on error or, when `min_confidence` is set, when `confidence < min_confidence`. `ClassifierStrategy` cannot decline on ambiguity, because an LLM index carries no uncertainty.

```python
router = ModelRouter(
    models=[RoutingCandidate(name="routine", model=haiku, description="…"),
            RoutingCandidate(name="complex", model=opus, description="…")],
    strategy=DecisionStrategy(TypeSafeDecisionModel(), min_confidence=0.7),
)
agent = Agent(model=router)
```

**Front door and subagent — `DecisionAgent`.** A `DecisionAgent` implements `AgentBase` (`invoke_async`, `__call__`, `stream_async`), so it goes wherever an agent goes: as a `Graph` node, behind A2A, or as an entry point. Its `stream_async` ends with the same `{"result": AgentResult}` event that `Graph` consumes from any node. It returns an `AgentResult` whose `message` is a code-templated summary rather than generated prose.

**Where the decision lives.** The canonical location is `AgentResult.state["decision"]` (`DECISION_STATE_KEY`), which holds the full `Decision`: the typed `output`, every field's answer and distribution, the model id, and usage. It is there on every `DecisionAgent` result, routed or not, and the graph helpers read exactly that key. `structured_output` cannot be the canonical place, because it holds only the schema instance (`Decision.output`, with no probabilities), and on a routed call the result is the route's own `AgentResult`, whose `structured_output` belongs to the route. Without `routes=`, `structured_output` is also set to `Decision.output`, so code that already reads `structured_output` keeps working.

With `routes=`, it becomes a dispatcher:

```python
triage = DecisionAgent(
    model=jev,
    schema=Triage,
    route_on="department",
    routes={"billing": billing_agent, "technical": tech_agent, "sales": handle_sales},  # Agent | AgentBase | callable
    min_confidence=0.6,          # example floor; there is no default (see Layer 3 signatures)
    fallback=general_agent,      # low confidence or no-match: hand to a reasoning agent, or raise
)
result = triage("My payouts have failed for three days")   # the route's result
result.state["decision"]                                  # the full Decision, on every result
```

**Graph routing — `when_choice` / `when_yes` / `when_below`.** Graph edge conditions are synchronous, and a graph routes on results that nodes have already recorded. The condition helpers read the node's decision from its canonical location, `state.results[node_id].result.state["decision"]`:

```python
builder.add_node(DecisionAgent(model=jev, schema=NextStep), "router")
builder.add_edge("router", "billing", condition=when_choice("router", "next_agent", "billing_agent", min_confidence=0.5))
builder.add_edge("router", "human",   condition=when_below("router", "next_agent", 0.5))
```

`when_below` is traversed when the field's `confidence` is below the floor, is `None` (uncalibrated), or the node produced no decision, so a fallback edge fires rather than the graph stalling. This works with no changes to `Graph`. Swarm is different: its nodes must be `Agent`, and handoff is an LLM tool call. A deterministic `handoff_strategy=` for `Swarm` is P1 and needs its own small design.

**Tool — `decision_tool`.** This wraps a decision schema as an `AgentTool` that an LLM can call when it wants a calibrated judgment mid-task (for example "is this quote supported by the source?"). The tool's input schema defines the state fields the LLM fills in. The result is JSON carrying answers and probabilities, so the LLM sees the uncertainty.

```python
check_citation = decision_tool(jev, CitationCheck, state_schema=CitationInput,
                               name="check_citation", description="Check a quote against its source.")
writer = Agent(model=sonnet, tools=[check_citation])
```

**Guardrails — `DecisionGuard` and the HITL classifier.** `DecisionGuard` is an `InterventionHandler`. Its `before_tool_call` asks a risk `YesNo` and a severity `Score` over the tool name and input, then maps the approval probability to `Proceed`, `Confirm`, or `Deny` using code-owned floors (`confirm_above=0.5`, `deny_above=0.95`). It needs no separate confidence floor: an unsure risk answer is a probability near 0.5, which the default `confirm_above` sends to a person. A second question set in `after_model_call` can check the model's output. `decision_classifier(jev)` implements the existing `HumanInTheLoopClassifier` protocol, so `HumanInTheLoop` gains a System One classifier without changing HITL. Guards fail closed by default: an error maps to `Confirm`. This is configurable.

**Computer and browser use.** No new adapter is needed. The sample shows the pattern: code extracts actionable elements from the accessibility tree; one request asks a `Choice` over the element ids plus `YesNo` goal-reached and `YesNo` needs-reasoning; high confidence acts directly, and anything else escalates to the LLM computer-use agent. That generalizes into the P1 below.

**P1 — System-One-first fast path.** A plugin registers `InvokeModelStage` middleware, the same internal mechanism `ModelRouter` uses. It asks the decision model whether the next step is a known, closed action. When confidence clears the floor, the plugin short-circuits the LLM call with a synthesized tool-use turn; otherwise it passes through to the LLM. This is Kahneman's arrangement made literal: System One by default, System Two when unsure. It is P1 and experimental because it writes model-attributed messages into history, and that needs its own review of transcript semantics and tracing.

#### Layer 3 signatures

The complete public signatures, with defaults. Every confidence floor defaults to `None` (no gate). The floors in this document's examples (0.5, 0.6, 0.7) are illustrative, not defaults. A default floor would be silent policy, and the right floor depends on the consequence of a wrong answer and on the provider: the [baseline](./0020-system-one-decision-models-baseline.md) and the samples show Jev and Kev put confidence in different places. A floor is opt-in and needs a calibrated model. Setting one on an uncalibrated model raises at construction. The guard's floors do have defaults, because a guard with no floors would never confirm.

```python
class DecisionStrategy(RoutingStrategy):
    def __init__(self, decision_model: DecisionModel, *, min_confidence: float | None = None,
                 instructions: str = DEFAULT_INSTRUCTIONS, max_request_tokens: int = 1_000,
                 max_instruction_tokens: int = 1_000) -> None: ...

class DecisionAgent(AgentBase, Generic[T]):
    def __init__(self, model: DecisionModel, schema: type[T], *, route_on: str | None = None,
                 routes: Mapping[str, Route] | None = None,     # Route = AgentBase | Callable[[str], Any]
                 min_confidence: float | None = None,           # needs route_on (a Choice field)
                 fallback: Route | None = None,                 # None: low confidence / no-match / error raise
                 state_builder: StateBuilder | None = None,     # None: project the latest request
                 name: str = "decision_agent", description: str | None = None) -> None: ...

def when_choice(node_id: str, field: str, option: str, *,
                min_confidence: float | None = None) -> DecisionEdgeCondition: ...
def when_yes(node_id: str, field: str, *, threshold: float = 0.5) -> DecisionEdgeCondition: ...
def when_below(node_id: str, field: str, confidence: float) -> DecisionEdgeCondition: ...

def decision_tool(decision_model: DecisionModel, schema: type[BaseModel], *,
                  state_schema: type[BaseModel], name: str, description: str) -> DecisionTool: ...

class DecisionGuard(InterventionHandler):
    def __init__(self, decision_model: DecisionModel, *, confirm_above: float = 0.5,
                 deny_above: float = 0.95,
                 on_decision_error: Literal["confirm", "deny", "proceed"] = "confirm",
                 risk_instructions: str = RISK_INSTRUCTIONS,
                 severity_levels: Sequence[str] = SEVERITY_LEVELS,
                 output_questions: Mapping[str, YesNo] | None = None,
                 output_guide_above: float = 0.5, max_output_retries: int = 1) -> None: ...

def decision_classifier(decision_model: DecisionModel, *, threshold: float = 0.5,
                        instructions: str = RISK_INSTRUCTIONS) -> HumanInTheLoopClassifier: ...

class TypeSafeDecisionModel(DecisionModel):
    def __init__(self, *, api_key: str | None = None,   # TYPESAFE_API_KEY, only for TypeSafe's own server
                 base_url: str | None = None,             # TYPESAFE_BASE_URL, else https://api.typesafe.ai
                 client: AsyncTypeSafeClient | None = None, client_args: dict[str, Any] | None = None,
                 model_id: str = "jev-latest", max_state_plus_question_tokens: int = 32_000,
                 max_request_tokens: int | None = 64_000) -> None: ...

class LLMDecisionModel(DecisionModel):
    def __init__(self, model: Model, *, system_prompt: str = SYSTEM_PROMPT) -> None: ...
```

`min_confidence` is defined only where the adapter acts on one `Choice`: `DecisionStrategy` (the candidate choice), `DecisionAgent` (its `route_on` field, which must be a `Choice`), and `when_choice`. A yes/no decision is gated on its probability instead, through `YesNo(threshold=)`, `when_yes`, and the guard's floors.

#### Naming

[Avoid Overloading Domain Terms](../DECISIONS.md#avoid-overloading-domain-terms-in-api-naming) asks two things of a name: that it not reuse an SDK term for a _different_ concept, and that it prefer the term native to the domain being wrapped.

**`DecisionModel`.** "Model" here is not a second meaning of the SDK's term. A decision model is a trained model with a model id, provider configuration, calibration, and pricing, like any `Model` provider, and it is placed with them (`strands.models.typesafe`). What it does differently is carried by the qualifier: it decides rather than generates. It is also the domain's own term. TypeSafe calls Jev a "System One model", and Kev describes itself as a family of "decision models". The name does not become a type confusion, because `DecisionModel` does not subclass `Model`: passing one where a `Model` is expected is a type error, which is the failure the `Model`-provider alternative below cannot avoid. The docs lead with "Model generates; DecisionModel decides." Rejected alternatives:

- `DecisionEngine`: "engine" suggests a runtime or executor, not a trained artifact with a versioned id that callers pin and tune thresholds against. It also hides that providers, configuration, and pricing work as they do for models.
- `Decider`: names a role, and every adapter here (`DecisionAgent`, `DecisionStrategy`, `DecisionGuard`) is a decider. The primitive would be indistinguishable from its adapters.
- `SystemOneModel`: a vendor's framing, and it names a cognitive-science metaphor rather than what the type does.
- `Classifier`: already claimed by `ClassifierStrategy` and `HumanInTheLoopClassifier`, and a `Score` is not a classification.

**`DecisionResponse` and `Decision[T]`.** Both are kept, because they are different layers and the names say so:

| Type               | Returned by                       | Holds                                                                 | For                                                                        |
| ------------------ | --------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `DecisionResponse` | `ask(state, questions)` (Layer 1) | answers keyed by question id, model id, usage                         | provider implementers and runtime option sets; mirrors a provider response |
| `Decision[T]`      | `decide(schema, state)` (Layer 2) | the validated `output: T`, plus the same answers, model id, and usage | application code: the typed result a developer reads                       |

"Response" follows provider vocabulary (what the provider returned). `Decision[T]` is the typed outcome, generic in the schema, like `AgentResult` in the agent loop. `AskResult` was rejected because `*Result` already names execution outcomes in the SDK (`AgentResult`, `NodeResult`, `ToolResult`). `TypedDecision` was rejected because the generic parameter already says it is typed.

#### Choosing a placement (G5)

| Placement                                                                              | Who decides _when_ to ask                  | Latency position                              | Sees history?                                    | Failure mode                                                  | Use when                                                                                        |
| -------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **(a) Front door** — `DecisionAgent(routes=)` as entry                                 | Code, on every request                     | Before any LLM; ~0.6 s total for easy paths   | Only the incoming request                        | Low confidence → `fallback` agent                             | Most traffic is classifiable; you want the cheap path first and an LLM only when needed         |
| **(b) Subagent / node** — `DecisionAgent` in a `Graph`, `DecisionStrategy` in a router | The workflow topology                      | At a fixed point in the flow                  | Whatever the node's input or projection gives it | Edge to a human or reasoning node; router declines to default | Routing points are known at design time; you want deterministic, testable flows                 |
| **(c) Tool** — `decision_tool`                                                         | The LLM, mid-reasoning                     | Inside an LLM turn (adds one tool round trip) | What the LLM chooses to pass                     | Probabilities go back to the LLM, which decides               | The need for a judgment is itself a judgment; you want calibrated checks inside an agentic task |
| _(embedded) Guard / strategy_ — `DecisionGuard`, `decision_classifier`                 | Lifecycle events, on every tool/model call | Before each gated call                        | Just the call under review                       | Fail closed → `Confirm`                                       | Policy checks that must never be skipped by the LLM                                             |

The rule of thumb: the more a decision must be _guaranteed_ to happen, the further up the table it belongs. Tools are the only placement where the LLM can skip the decision.

#### Observability and failure (G7, G8)

Every `ask` opens a model-invoke span tagged `source="decision"`. The span records the model id that answered, the question ids and types, per-question top answer and confidence, and token usage. State and instructions are not recorded by default. When a `DecisionModel` is attached through an adapter, its usage rolls into the owning agent's `accumulated_usage` through #4005's auxiliary-call runner. Until #4005 lands, usage goes on the span only. Every adapter states its failure mode in its docstring and exposes it as a parameter; none silently substitutes a guess.

| Adapter                  | On error                    | On low confidence                                            |
| ------------------------ | --------------------------- | ------------------------------------------------------------ |
| `DecisionStrategy`       | decline → router default    | decline → router default (only when `min_confidence` is set) |
| `DecisionAgent(routes=)` | raise, or `fallback` if set | `fallback`, or raise (only when `min_confidence` is set)     |
| `when_choice`            | edge not taken              | `when_below` edge                                            |
| `DecisionGuard`          | `Confirm` (configurable)    | `Confirm` (p near 0.5 is at or above `confirm_above`)        |
| `decision_tool`          | error tool result           | returned to the LLM as data                                  |

#### Placement and packaging (G6)

The core types live in `strands.decisions` as one flat module: `DecisionModel`, `Choice`, `Score`, `YesNo`, `Decision`, `LLMDecisionModel`, `DecisionAgent`, `decision_tool`, `when_choice`, `when_yes`, `when_below`, `DecisionGuard`, `decision_classifier`. `DecisionStrategy` is re-exported from `strands.models.routing` next to its peers. The provider lives at `strands.models.typesafe.TypeSafeDecisionModel` next to the other providers, behind the `typesafe` extra. The first release ships under `strands.experimental.decisions`, per the [feature lifecycle](../FEATURE_LIFECYCLE.md); the exit criteria are listed under [Work Plan](#work-plan).

#### TypeScript (G9)

The same three layers, adapted to the language. Zod is the schema idiom, so `z.enum([...])` compiles to `Choice`, `z.boolean()` to `YesNo`, and `score(levels)` (a branded `z.number()`) to `Score`. Descriptions come from `.describe()` or the marker helpers `choice()`, `yesNo()`, and `score()`, which mirror the TypeSafe JS SDK's helpers. `DecisionModel` is an abstract class with `ask()`. `decide(schema, state)` infers `Decision<z.infer<typeof schema>>`. `TypeSafeDecisionModel` takes `@typesafe-ai/sdk` (MIT) as an optional peer dependency. Everything exports from `@strands-agents/sdk/experimental`, and later from `@strands-agents/sdk/decisions`. `DecisionStrategy` implements the TS `RoutingStrategy`. Names are recased per SDK convention (`minConfidence`, `routeOn`).

**Pros:** It meets every goal without touching `Agent` or `Model`. One schema runs on Jev or any LLM. Each integration reuses a seam that already exists (`RoutingStrategy`, `AgentBase`, `EdgeCondition`, `AgentTool`, `InterventionHandler`, `HumanInTheLoopClassifier`). Uncertainty is a first-class value at every point. It extends to other System One vendors.

**Cons:** It adds a second model abstraction, which developers must learn exists; the naming (`DecisionModel` vs `Model`) must carry that. A class-based schema cannot express runtime option sets, so dynamic cases drop to the lower layer. The `LLMDecisionModel` adapter's missing calibration means confidence-gated adapters refuse it, which is correct but may surprise. Seven adapters is real surface area for an experimental feature.

### Alternative: implement Jev as a `Model` provider

`JevModel(Model)` would implement `structured_output` by compiling the output model into questions, and `stream` by raising or by emitting the JSON answer as text.

- **Pros:** It is the smallest possible surface. It drops into `ClassifierStrategy(model=JevModel())` and `LLMClassifierConfig(model=…)` today.
- **Cons:** It misrepresents the contract. `stream()` cannot honor messages or tool specs, so `Agent(model=JevModel())` type-checks and then fails at runtime. `structured_output` accepts any `BaseModel` and would raise on most of them. Probabilities and confidence have nowhere to go, because the `structured_output` return is the bare instance, so the key capability is lost. Every existing `Model` consumer (context management, token counting, caching) would need a Jev special case. 0016 rejected "router is a `Model`" for the same reason: it re-exposes capabilities that do not describe it.
- **Not recommended.** It fails G1 (the primitive is disguised, not first-class), G3 (no typed uncertainty), and the obvious-path tenet.

### Alternative: low-level dict API only

This would ship only `DecisionModel.ask(state, {id: Choice(...)})` and the provider, leaving schemas and integrations to users.

- **Pros:** Minimal surface, and it maps one-to-one to the wire format. The vendor SDK already offers the same.
- **Cons:** Answers are stringly keyed and untyped. Each user rebuilds the router, guard, and graph glue. It adds little over importing the vendor SDK directly, and it fails G2 and G5.
- **Not recommended** alone. It is kept as Layer 1, the escape hatch.

### Alternative: a `decision_model=` parameter on `Agent`

`Agent(model=sonnet, decision_model=jev)` would let the agent consult the decision model at built-in points (routing, tool gating, stop conditions) automatically.

- **Pros:** Maximally "model-first". A single knob turns it on.
- **Cons:** It hides _which_ decisions are asked, with what questions and thresholds, which is exactly the policy G7 says must be explicit. It adds a constructor parameter with implicit behavior at several lifecycle points and couples the `Agent` core to an experimental feature. The adapters already give each decision point an explicit, opt-in parameter (`strategy=`, `plugins=`, `tools=`).
- **Not recommended** for v1. It can be revisited as sugar once the adapters settle.

## Developer Experience

**Setup.**

```bash
pip install 'strands-agents[typesafe]'
export TYPESAFE_API_KEY=…
```

**One-line judgment.**

```python
from strands.decisions import YesNo
from strands.models.typesafe import TypeSafeDecisionModel

jev = TypeSafeDecisionModel()
answers = await jev.ask(ticket_text, {"refund": YesNo("Does the customer ask for a refund?")})
answers["refund"].probability    # 0.93
```

**Front door with an LLM fallback.** This covers placement (a) and use case 1.

```python
from strands import Agent
from strands.decisions import DecisionAgent

support = DecisionAgent(model=jev, schema=Triage, route_on="department",
                        routes={"billing": billing_agent, "technical": tech_agent, "sales": sales_agent},
                        min_confidence=0.6, fallback=Agent(model=sonnet, system_prompt="General support"))
support("I was charged twice and can't log in")    # confidence 0.46 → fallback agent handles both issues
```

**Same schema, different engine.** This is useful for tests, offline development, and A/B comparison.

```python
decision = await LLMDecisionModel(BedrockModel("amazon.nova-micro-v1:0")).decide(Triage, state=ticket)
decision.answers["department"].confidence    # None — uncalibrated; gates with min_confidence refuse this model
```

**Errors a developer can hit, and what they say.**

| Situation                                                                                        | Error                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `str`/`int`/`list` field in a schema                                                             | `TypeError: Triage.summary: System One models select or score; they do not generate. Extract candidates in code and ask a Choice over them, or use an LLM for this field.` |
| `min_confidence` with an uncalibrated model                                                      | `ValueError: DecisionStrategy(min_confidence=0.7) needs a calibrated DecisionModel; LLMDecisionModel is not. Remove min_confidence or use a calibrated provider.`          |
| Choice with no options, or Score with fewer than 2 levels                                        | `ValueError` at question construction, naming the question                                                                                                                 |
| Choice with more than 255 options, or Score with more than 10 levels, on `TypeSafeDecisionModel` | `ValueError` from `ask`, before sending, naming the question and the provider limit                                                                                        |
| State plus the longest question over the provider budget                                         | `ContextWindowOverflowException` before the request is sent, naming the budget                                                                                             |
| `route_on` names a non-`Choice` field, or `routes` misses an option                              | `ValueError` at `DecisionAgent` construction, listing the unrouted options                                                                                                 |
| Missing `TYPESAFE_API_KEY` for TypeSafe's hosted API                                             | `ValueError` at `TypeSafeDecisionModel()` construction, naming the variable                                                                                                |

**Samples** (G4 × G5), in `site/docs/examples/python/system_one/`. Each runs on three engines: `--engine jev` (with `TYPESAFE_API_KEY`), `--engine kev` (a self-hosted Kev server), or `--engine llm` for the `LLMDecisionModel` baseline. Each prints accuracy on a small labeled set, p50/p95 latency, and cost per 1k decisions:

| #   | Use case                                                                                           | Placement shown                                         |
| --- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1   | Support triage with multi-issue detection → specialists or fallback                                | (a) front door; (b) graph router node                   |
| 2   | Mixture of models via `DecisionStrategy`                                                           | (b) embedded strategy                                   |
| 3   | Browser task: choose the next element, detect goal reached, escalate to the LLM computer-use agent | (a) fast path with System Two escalation                |
| 4   | Tool-call guard and output-faithfulness check                                                      | embedded guard; (c) `decision_tool` for citation checks |

## Objective Check

| Goal                          | Met by                                                                                                                                                                                 | Residual risk / open point                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| G1 provider primitive         | `DecisionModel` peer ABC; `TypeSafeDecisionModel` (Jev hosted, Kev self-hosted), `LLMDecisionModel`, custom subclasses; vendor limits enforced by providers, not question types        | Naming rationale in [Naming](#naming); still for API review                            |
| G2 model-driven control flow  | Adapters at routing, graph edges, entry dispatch, tool gating; System-One-first fast path (P1)                                                                                         | Swarm handoff and the fast path are P1, not P0                                         |
| G3 typed, friendly API        | Pydantic/Zod schema → `Decision[T]`; ask-together by construction; compile-time errors with fixes; low-level `ask`                                                                     | Runtime option sets use the lower layer (typed as `dict`)                              |
| G4 four use cases             | Samples 1–4 with a baseline comparison                                                                                                                                                 | Guardrails trail an LLM alone (see baseline); the cascade is the recommended placement |
| G5 three placements           | Placement table plus samples covering (a), (b), (c)                                                                                                                                    | —                                                                                      |
| G6 pay for play               | No `Agent`/`Model` changes; optional extra; experimental namespace                                                                                                                     | —                                                                                      |
| G7 honest uncertainty, safety | `calibrated` gate; answer semantics defined per type (including yes/no); no default confidence floors; per-adapter failure table; state/instruction separation; facts-in-code guidance | Floors must be tuned per domain and per provider                                       |
| G8 observable                 | `source="decision"` spans; usage via #4005                                                                                                                                             | Depends on #4005 for `accumulated_usage`                                               |
| G9 TS parity                  | TS shape specified                                                                                                                                                                     | Port follows the Python stabilization                                                  |

## Work Plan

- **Refactor, landed separately first.** [#4586](https://github.com/strands-agents/harness-sdk/pull/4586) moves `ClassifierStrategy`'s request-text bounding and instruction extraction into a shared module with no behavior change. Characterization tests pin `ClassifierStrategy`'s existing output (SHA-256 digests of the projected text across bounding, truncation, and injection-hardening cases) and pass unchanged before and after the move, so the routing path and the new decision path cannot diverge silently.
- **P0, primitive and provider** (on top of #4586). `DecisionModel`, question and answer types, `DecisionResponse`, `decide()` with the schema compiler, `TypeSafeDecisionModel` behind the `typesafe` extra (including `base_url=` for Kev), `LLMDecisionModel`, and `project_state`. Unit tests run against a recorded-response fake and a mocked HTTP transport. Integration tests call the live API when `TYPESAFE_API_KEY` is set, and a Kev server when `KEV_BASE_URL` is set.
- **P0, integrations.** `DecisionStrategy`, `DecisionAgent` (with `routes=`), `when_choice`/`when_yes`/`when_below`, `decision_tool`, `DecisionGuard`, `decision_classifier`. Decision spans.
- **P0, samples and benchmark.** Samples 1–4, each with Jev, Kev, and LLM-baseline arms, reporting accuracy on a labeled set, p50/p95 latency, and cost per 1k decisions. Plus a docs page on choosing a placement.
- **P1.** A `Swarm` handoff strategy; the System-One-first fast-path plugin (with its own transcript/tracing review); usage accounting through #4005 once merged; the TypeScript port.
- **Separate issue.** Evals and LLM-judge scoring with System One models.

**Exit criteria from experimental.** The API is unchanged across two minor releases. Every sample has a published baseline comparison. At least one `DecisionModel` implementation that does not speak the `/v1/systemone` API exists (a community provider or a local classifier sample), proving the contract is vendor-neutral. Kev proves that the provider is not tied to TypeSafe's hosting, but it shares the same wire format, so it does not meet this criterion on its own. TS parity has shipped.

## Consequences

Easier:

- Adding a calibrated, sub-second decision to any SDK decision point is one adapter, not a bespoke integration.
- Declining on _ambiguity_, not just on errors, becomes possible for routing and guards.
- One schema can be benchmarked on System One vs an LLM without code changes.
- Other System One vendors have a defined contract to implement.

Needs attention:

- Developers learn a second model type. Docs must lead with "Model generates; DecisionModel decides."
- `ClassifierStrategy` and `DecisionStrategy` coexist. The docs need a clear "use `DecisionStrategy` with a calibrated model; `ClassifierStrategy` when you only have an LLM" line.
- Jev's rate limits are currently dynamic (per the vendor's model page). Adapters must degrade per their failure table rather than stall an agent.
- Alias drift: `jev-latest` can move under tuned thresholds. Docs recommend pinning a versioned id once thresholds are tuned, and spans record the id that answered.
- `DecisionAgent.message` is templated text, not model prose. Consumers that expect a conversational reply from every `AgentBase` must read `structured_output`.

Migration: none. Everything is additive and opt-in.

## Willingness to Implement

Yes.
