# Instrumenting Auxiliary Model Calls

**Status**: Proposed

**Date**: 2026-08-27

**Issue**: [#3863](https://github.com/strands-agents/harness-sdk/issues/3863)

**Scope**: Python SDK (the same shape ports to the TypeScript SDK; TS already has the `model=` knob on its conversation manager).

## Problem

The SDK makes model calls on the user's behalf that are not part of the main event loop: it summarizes history to stay under the context window, classifies tool calls for human-in-the-loop review, classifies request complexity to route between models, and extracts memories from a conversation. These *auxiliary* calls cost real tokens, but they are invisible to the machinery that tracks the main loop — and each one is instrumented differently, because there is no shared path for "the SDK is calling a model that isn't the agent's turn."

Token usage is only systematically tracked for main-loop calls: `EventLoopMetrics.update_usage` is invoked solely from `event_loop.py`, which feeds `accumulated_usage`, per-invocation usage, and the OTel token histograms. Every auxiliary call sidesteps this in its own way. The result is that `result.metrics.accumulated_usage` does not mean "what this agent invocation spent" — it silently omits summarization and HITL classification today, and would omit routing classification once [#3846](https://github.com/strands-agents/harness-sdk/pull/3846) lands. Any cost feature built on that number ([#1216](https://github.com/strands-agents/harness-sdk/issues/1216), [#1428](https://github.com/strands-agents/harness-sdk/issues/1428), [PR #3212](https://github.com/strands-agents/harness-sdk/pull/3212)) inherits the blind spots. Anyone doing cost accounting or capacity planning sees their observed token counts diverge from their provider bill with no way to explain the gap short of provider-side logging.

### Current State — the gap table

Each of the four auxiliary call sites decided its own telemetry story, and they have already diverged four ways:

| Auxiliary call | Call site | `EventLoopMetrics` | OTel span | Hooks fire | Retry |
|---|---|---|---|---|---|
| **Summarization** (default) | `compression/context_compression.py:156` `generate_summary` → raw `model.stream()` | ✗ usage from the stop event is discarded (`_, result_message, _, _`) | ✗ none | ✗ none | ✗ |
| **Summarization** (user `summarization_agent`) | user-supplied `Agent` | ✗ lands on *that* agent's metrics, never merged into the parent | that agent's own span | that agent's own hooks | that agent's |
| **HITL LLM classifier** | `vended_interventions/hitl/classifier.py:117` — throwaway inner `Agent` per tool call | ✗ inner agent's metrics discarded → parent undercounts | ✓ reaches global histograms, but unattributed | inner agent's hooks | inner agent's |
| **Routing** `InputComplexityStrategy` ([#3846](https://github.com/strands-agents/harness-sdk/pull/3846)) | `_classify` → raw `structured_output()`; lazily creates a Haiku 4.5 model | ✗ none | ✗ none | ✗ none | ✗ |
| **Memory** `ModelExtractor` | `memory/extraction/model_extractor.py:87` — the closest to correct | ✗ none | ✓ span with usage attributes | ✗ none | ✗ |

Two things break as a result. First, cost/usage is wrong or orphaned: the default summarizer's tokens vanish entirely, the routing classifier's recurring Haiku spend is completely invisible, and the HITL inner agent's usage is stranded on a discarded metrics object. Second, customer hooks silently miss these calls. A cost-tracking or logging hook subscribed to `BeforeModelCallEvent` fires for the agent's turns but never for summarization — which is exactly the paper cut the issue reports.

## Goals

- One shared, instrumented entry point for SDK-internal model calls, so a new auxiliary feature does not re-decide its telemetry story.
- Auxiliary spend is attributable per source (`summarization`, `hitl_classifier`, `routing_classifier`, `memory_extraction`) in both `result.metrics` and OTel.
- Auxiliary calls are observable via a hook, so cost/guardrail integrations *can* cover them — **without changing behavior for any existing model-call hook** (backwards compatibility is a hard requirement; see the usage sweep in Appendix B).
- Reuse the existing span types, histograms, and retry machinery rather than minting a parallel telemetry stack.
- Let each auxiliary feature choose its own (cheaper) model, and let the whole-agent features (HITL, goal judge) inherit the parent's interventions/limits/trace instead of spawning a detached `Agent`.

## Proposal

The proposal is **one internal *runner* for SDK-internal model calls, plus two follow-up knobs, shipped in phases.** The runner is the bulk of the value and lands first; the knobs are additive and can follow without further design review. The runner reuses the main loop's telemetry machinery (spans, histograms, metrics, retry); the new API is a dedicated auxiliary hook-event pair (plus one additive per-source metrics field), kept separate from the main model-call events for backwards-compatibility reasons detailed below.

**The runner — the core fix, merged first.** One internal helper — call it `_run_aux_model_call(...)` — that every site which today calls `model.stream()` raw (summarizer, compactor, routing classifier, memory extractor) calls instead. Around each auxiliary call it opens the model-invoke span (tagged with `source`), fires the new auxiliary hook pair, adds usage to the owning agent's metrics (into `accumulated_usage` and a per-source bucket), and applies retry. It is the `stream_messages` + `start_model_invoke_span`/`end_model_invoke_span` pattern that `ModelExtractor` already hand-rolls, centralized so all four sites share it. The Hooks, Metrics, and OTel subsections below spell out what the runner does at each layer; the guiding constraint is backwards compatibility for existing **hook** subscribers, with one deliberate exception — the `accumulated_usage` bump described under Metrics.

**Knob 1 (follow-up) — `model=` per auxiliary feature.** Each feature takes an optional `model=` (a cheap model for summaries; inherits the agent's model when omitted). The TS conversation manager already has this; Python does not.

**Knob 2 (follow-up) — worker inheritance.** The features that spawn a whole agent (HITL classifier, goal judge) get a fresh worker per call that inherits the parent's interventions, limits, and trace context, instead of today's detached `Agent(...)`.

The phasing is deliberate: the runner can merge and deliver the entire cost-visibility fix on its own, and the two knobs are independent enough to land later as separate PRs without revisiting this design.

### Hooks — a new `BeforeAuxModelCallEvent` / `AfterAuxModelCallEvent` pair

**Auxiliary calls fire a new, dedicated hook pair — they do *not* fire `Before/AfterModelCallEvent`.** This is the decision the design turns on, and it is driven by backwards compatibility, not aesthetics.

The tempting shape is to reuse `Before/AfterModelCallEvent` and add a `source` field so existing subscribers can filter. A usage sweep of real `BeforeModelCallEvent` subscribers (in-tree and across public GitHub) shows why that breaks the world: many assume the event means "the user's turn is about to happen" — they *count* it as a turn (limiters that cancel the agent), *raise or cancel* on the scanned input (guardrails), or *mutate the conversation positionally*. A `source` field does not save them: the handler body still *runs* — it just receives a field it was written before and never checks. Backwards compatibility requires that existing handlers are **not invoked** at all for auxiliary calls, which a shared event cannot guarantee.

So auxiliary calls get their own pair, symmetric with the main pair, carrying a `source` string that names which auxiliary feature is calling:

```python
@dataclass
class BeforeAuxModelCallEvent(HookEvent):
    """Fired before an SDK-internal (non-main-loop) model call: summarization,
    routing classification, HITL classification, memory extraction."""
    source: str = ""   # "summarization" | "routing_classifier" | "hitl_classifier" | "memory_extraction"
    invocation_state: dict[str, Any] = field(default_factory=dict)
    cancel: bool | str = False

@dataclass
class AfterAuxModelCallEvent(HookEvent):
    source: str = ""
    stop_response: "AfterAuxModelCallEvent.ModelStopResponse | None" = None
    exception: Exception | None = None
```

One subscription covers *all* auxiliary calls; a consumer that cares about only one filters on `source`. Existing `Before/AfterModelCallEvent` subscribers are untouched — they keep meaning exactly "the main turn" and see zero new traffic. A cost or guardrail integration that *wants* to cover auxiliary calls opts in explicitly by subscribing to the new event. `source` is an open `str`, not a closed literal, so a future auxiliary feature adds a value without a new event class.

Retry still comes for free but through the runner, not a hook: the runner applies the agent's `ModelRetryStrategy` directly around the auxiliary call rather than relying on `AfterModelCallEvent`.

At the *operation* level there is a separate, later follow-up: no event means "about to compact your history," so `Before/AfterSummarizationEvent` (like Claude Code's `PreCompact`/`PostCompact`) is genuinely new and correct there. Not needed for the core fix.

### Metrics — roll auxiliary usage into the owning agent, tagged by source

Auxiliary usage rolls up into the owning agent's `EventLoopMetrics.accumulated_usage`, tagged by `source` so it stays attributable per feature. This makes `result.metrics.accumulated_usage` finally mean "what this invocation spent."

This does change observed numbers — a summarizing agent's `accumulated_usage` goes up because it now includes the summarization tokens it was always spending. That is the point (the number was wrong before), called out in the changelog. The per-`source` breakdown means anyone who wants the old main-loop-only figure can still recover it.

### OTel / Tracing — zero new telemetry machinery

The tracer API already exists and is already used exactly this way (hand-copied today in `memory/extraction/model_extractor.py:87-111`); the runner just centralizes it:

```python
tracer = get_tracer()
span = tracer.start_model_invoke_span(messages=..., model_id=...)   # existing method
with trace_api.use_span(span, end_on_exit=False):                   # OTel context = auto-parenting
    ... stream the model ...
tracer.end_model_invoke_span(span, message, usage, metrics, stop_reason)  # existing method
```

- **Parenting is automatic.** OTel parents the span under whatever span is active in context. Summarization runs inside an agent invocation (`reduce_context` is called from `agent.py`), so the model span lands under the live `invoke_agent` span in the same trace — no span handles to thread around.
- **Same span type as main-loop calls.** Dashboards that sum `gen_ai.usage.*` over model-invoke spans become correct with zero changes. The only new thing is one attribute, `strands.source="summarization"`.
- **Optional wrapper span.** A `summarize_conversation` span (with before/after size attributes) can wrap the model span later; precedent is already in-tree with `start_memory_extract_span` (`memory/extraction/coordinator.py:214`).
- TS mirrors this via `Tracer.startModelInvokeSpan` (`telemetry/tracer.ts:358`).

**Total new observability surface:** zero new span types, one new span attribute, one new metrics field, and one new hook-event pair. Optionally and later: one wrapper-span method and the operation-level summarization events.

### Middleware — same gap, out of scope

`InvokeModelStage` middleware has the identical gap: it runs only on the main event loop, so it does not fire for auxiliary calls. Extending it is left for later — middleware *mutates* the request (memory injection, routing), so running it on auxiliary calls is often wrong (you don't want to inject memory into a summarization prompt), which puts it in a different design conversation from the observation hook this proposal adds.

## Developer Experience

**Cost tracking can now cover auxiliary calls — by opting in.** A subscriber that wants the full picture registers for both the main and auxiliary events; each existing main-only subscriber keeps working untouched:

```python
class CostTracker(HookProvider):
    def register_hooks(self, registry: HookRegistry) -> None:
        registry.add_callback(AfterModelCallEvent, self.on_main)       # unchanged behavior
        registry.add_callback(AfterAuxModelCallEvent, self.on_aux)     # opt in to aux

    def on_main(self, event: AfterModelCallEvent) -> None:
        self.by_source["main"] += event.stop_response.usage["totalTokens"]

    def on_aux(self, event: AfterAuxModelCallEvent) -> None:
        self.by_source[event.source] += event.stop_response.usage["totalTokens"]
        # {"main": 41_320, "summarization": 2_880, "routing_classifier": 190}
```

**Existing guardrail/limit hooks need no change** — they are subscribed to `BeforeModelCallEvent`, which still fires only for the main turn, so they never see (and never block or count) an internal summarization or routing call.

**A guardrail that *does* want to vet auxiliary prompts opts in explicitly:**

```python
    def register_hooks(self, registry: HookRegistry) -> None:
        registry.add_callback(BeforeAuxModelCallEvent, self.scan)   # deliberate, not automatic

    def scan(self, event: BeforeAuxModelCallEvent) -> None:
        if is_unsafe(event): event.cancel = "blocked"
```

**`result.metrics` now reconciles with the provider bill (a deliberate bump):**

```python
result = agent("...")
result.metrics.accumulated_usage            # now includes summarization + routing spend
result.metrics.accumulated_usage_by_source  # {"main": ..., "summarization": ..., "routing_classifier": ...}
```

**Knob 1 — a cheap model for summaries (follow-up):**

```python
agent = Agent(
    model=sonnet,
    conversation_manager=SummarizingConversationManager(model=haiku),  # inherits agent.model when omitted
)
```

## Consequences

- Auxiliary spend becomes attributable everywhere — `result.metrics`, OTel spans, and OTel histograms — with a per-source breakdown. Cost/guardrail integrations that want to cover auxiliary calls opt in via the new hook.
- New auxiliary features route through one helper and inherit correct telemetry, hooks, and retry by default, instead of re-deriving it.
- **Behavior changes** to flag: existing `Before/AfterModelCallEvent` subscribers are untouched (aux calls fire a separate event), but `accumulated_usage` bumps up because it now includes auxiliary spend it always incurred. Called out in the changelog; recoverable from the per-source breakdown.

## Willingness to Implement

Yes.

---

<details>
<summary><strong>Appendix A — What other frameworks do</strong></summary>

- **Google ADK** exposes `before_model_callback` / `after_model_callback`, but its own summarizer bypasses them — so a user callback registered for model calls silently misses summarization. We accept that main-loop hooks miss auxiliary calls *by design* and expose the auxiliary calls through a dedicated event, so covering them is an explicit opt-in rather than a silent gap in either direction.
- **Claude Code** ships distinct `PreCompact` / `PostCompact` hooks for the *operation* of compacting history, separate from model-call hooks. This is the precedent for the (later, follow-up) `Before/AfterSummarizationEvent` — an operation with no existing event is where a new event type is genuinely warranted.
- **LiteLLM / gateways** track spend at the proxy, below the SDK. That catches auxiliary tokens on the bill but cannot attribute them to a source or surface them in `result.metrics`, which is what SDK-side accounting needs.

</details>

<details>
<summary><strong>Appendix B — Alternatives considered</strong></summary>

- **Reuse `Before/AfterModelCallEvent` + a `source` field.** Rejected on backwards-compat grounds: a usage sweep of real `BeforeModelCallEvent` subscribers (in-tree and across public GitHub) shows many treat the event as "the user's turn," and firing it for auxiliary calls would prematurely cancel agents, spuriously block internal prompts via guardrails, or misalign positional state. A `source` field does not help — the handler body still runs.
- **Do nothing / document that auxiliary calls are out-of-band spend.** Cheap, but makes accurate SDK-side cost reporting permanently impossible and leaves the four call sites diverging further.
- **Per-site OTel spans only — don't touch metrics or hooks.** Extend the `ModelExtractor` span pattern to the other three sites but leave `EventLoopMetrics` alone. Non-breaking and attributable in tracing backends, but invisible to anyone who reads `result.metrics` — the most common cost surface.
- **The shared runner without the two knobs.** This is the core proposal minus the follow-ups; it fully fixes cost visibility on its own. The knobs (per-feature `model=`, worker inheritance) are additive quality-of-life improvements, sequenced as later work rather than dropped.
- **Record auxiliary usage on a separate surface (not `accumulated_usage`).** Preserves today's number exactly, but leaves the headline `accumulated_usage` permanently undercounting real spend. The design accepts the one-time bump so the number is correct, and keeps the per-source split for anyone who needs the old figure.

</details>

<details>
<summary><strong>Appendix C — Related work</strong></summary>

- Cost on `AgentResult` (main-loop only): [#1216](https://github.com/strands-agents/harness-sdk/issues/1216), [#1428](https://github.com/strands-agents/harness-sdk/issues/1428)
- LiteLLM cost tracking (open): [PR #3212](https://github.com/strands-agents/harness-sdk/pull/3212)
- Cost-aware routing strategy metadata: [#3860](https://github.com/strands-agents/harness-sdk/issues/3860)
- Per-tool token counts: [#1503](https://github.com/strands-agents/harness-sdk/issues/1503)
- Where `gen_ai.usage.*` attaches on spans: [#3602](https://github.com/strands-agents/harness-sdk/issues/3602)
- Model routing (in flight, source of call site #3): [PR #3846](https://github.com/strands-agents/harness-sdk/pull/3846)

</details>
