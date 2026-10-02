# Tool Selection

**Status**: Proposed

**Date**: 2026-09-23

**Issues**: [#263](https://github.com/strands-agents/harness-sdk/issues/263), [#1677](https://github.com/strands-agents/harness-sdk/issues/1677)

**Related**: [#1680](https://github.com/strands-agents/harness-sdk/issues/1680), [#4052](https://github.com/strands-agents/harness-sdk/issues/4052), [#4053](https://github.com/strands-agents/harness-sdk/issues/4053)

**Scope**: Python and TS

## Overview

Tool definitions are context. The system that decides which messages and tool results the model sees should also decide which tool definitions it sees. Tool selection therefore belongs to the `ContextManager`, not to a standalone plugin or a new `Agent` parameter.
The `ContextManager` manages durable messages through hooks, while tool definitions are a per-call projection of the tool registry. Tool specs become a ContextManager target managed by `Hide.tool_specs(...)`, which ContextManager delivers through the same model-input seam the SDK already uses for per-call changes. The registry is never touched.

## Goals and Non-Goals

Goals:
- Reduce model input tokens and tool-choice noise for large catalogs.
- Manage tool specs as context, under `context_manager`, with no new top-level surface.
- Change nothing for agents that do not opt in. `ContextManager()` and the `"auto"` and `"agentic"` facades keep today's behavior and today's wire request; `"auto"` adopts selection only after benchmarks establish when it is net-positive.
- Select once per invocation from its input and keep membership stable through the autonomous tool loop, so the tool prefix a provider caches does not change mid-loop.
- Work out of the box. The default strategy is lexical, in-process, and deterministic: the same input always yields the same ranking.
- Support custom relevance through one contract, `ToolSearchStrategy`, so embeddings, an LLM judge, or a storage-backed index are each one class away.
- Correct `projected_input_tokens` for filtered calls, so token status and spans reflect what the model will actually receive.
- Never mutate the tool registry; selection changes only the per-call view.
- Fail open: a search failure leaves eligible tools visible rather than failing the model call.
- Keep Python and TypeScript concepts, names, defaults, and behavior aligned.

Non-Goals (v1):
- Agentic discovery (#1680). An add-on to this design, tracked as a P2 item.
- Provider-native delivery. OpenAI `allowed_tools`, OpenAI and Anthropic deferred loading, and OpenAI `additional_tools` are the cache-preserving paths and are wanted. Each needs adapter request and response handling, new `ToolChoice` or `ToolSpec` fields, and a capability the policy can read from `context.model`. They are P1 and P2 below and consume the v1 selection result rather than replace it; see [Prompt caching](#prompt-caching).
- A second index or persistence abstraction. Semantic search is in scope: `ToolSearchStrategy` ranks in-memory tool candidates, and `StorageSearch` adapts it to the shipped `Storage.search` (and the embeddings and S3 Vectors backends in #3967). What v1 does not add is a new vector, embedding, or persistence API for tools alone.

## Design decisions

**Tool specs are managed at the model-input seam, not in the registry and not in the message pipeline.** Every model call already rebuilds `tool_specs` from the full `ToolRegistry`, copies it into an `InvokeModelContext`, and runs that context through `InvokeModelStage.Input` middleware before the terminal sends it. `ModelRouter`, `BackgroundTasks`, `MemoryManager`, and `ContextInjector` all deliver their policies from that seam, registered from their own `init_agent`. `Hide.tool_specs(...)` does the same. The `ContextManager`'s message strategies stay on hooks and the stash, while `Hide` filters only the per-call spec projection.

**The registry is read, never written.** A tool is executable code; its spec becomes context only when supplied to the model. The registry owns the code and how it is loaded, including local tools, MCP tools, and hot reload.
The `ContextManager` decides which specs appear in a call. "Hiding" a tool means its spec is absent from one call's projection; "reloading" it means a later projection includes it again. Nothing is stored or fetched because the spec comes from code that is still registered. `agent.tools` and `agent.tool_registry` always return the full set, and the executor still resolves a returned tool name against the full registry. Hiding is therefore a visibility control, not authorization.

**Selection is provider-agnostic; delivery is provider-specific.** LangChain filters at the request layer the same way, and Anthropic's and OpenAI's tool search defer definitions rather than remove them, but provider search is gated to one vendor and blind to local tools. Strands selects across every registered source and lets each adapter decide how to express the result.

## Proposed SDK changes

`Hide` is a `ContextStrategy` and goes in the existing strategy list. `ContextManager` already calls `strategy.init(agent, stash)` on every strategy at attach time, and message strategies use that call to register their eager hooks. `Hide` uses the same call to register an `InvokeModelStage.Input` handler and an `AfterInvocationEvent` cleanup, because the tool-spec projection exists only in `InvokeModelContext`, not in `ContextState`. Its `apply()` returns `False`, so the message pipeline treats it as a no-op. `ContextManager` itself is unchanged.

```python
class Hide(ContextStrategy):
    def init(self, agent: Agent, stash: Stash | None) -> None:
        agent._middleware_registry.add_middleware(InvokeModelStage.Input, self._apply_to_model_input)
        agent.hooks.add_callback(AfterInvocationEvent, self._clear_invocation_state, order=HookOrder.SDK_LAST)

    async def apply(self, context: ContextState) -> bool:
        return False  # tool specs are not in the message pipeline
```

The Input handler is an implementation detail; developers configure `Hide` through the strategy list like any other strategy.

No breaking change. Existing strategies and facades are unchanged, and `agent.tools` and `agent.tool_registry` keep returning the full set.

### What happens on a model call

The strategy treats the incoming `context.tool_specs` as the catalog for the call. Specs named in `always_hide` are removed first. Tools that SDK-injected content tells the model to call, the structured-output tool and the stash and offloader retrieval tools, are never hidden. Pinned specs such as `!tool_spec::ask_user` are never candidates and stay visible outside `keep`. If `.when(count=...)` does not match, or the candidates already fit within `keep`, the catalog passes through unchanged.

Otherwise the first call of an invocation derives a query from the latest user text, asks `ToolSearchStrategy` to rank the candidate specs, and keeps the best `keep` of them, filling from unmatched candidates in catalog order, so the model sees `min(keep, candidates)` plus pinned and protected tools. The decision is held per invocation and cleared at its boundaries; later calls in the same invocation reuse it, intersected with that call's catalog, and specs that join the catalog mid-invocation were never ranked and stay visible. A forced call (`tool_choice` names a tool) applies the same decision with the forced tool kept on top. Emitted specs keep catalog order, so a stable selection is a byte-identical tool prefix from call to call, including the forced structured-output call that ends an invocation. A continuation turn with no matches ("yes, do it") carries forward what the model last saw. A turn that names something new and matches nothing, or a search error, shows every candidate or only pinned and protected tools according to `on_failure`.

```mermaid
sequenceDiagram
    participant EL as Event loop
    participant CM as ContextManager
    participant H as Hide strategy
    participant S as ToolSearchStrategy
    participant T as Invoke terminal
    participant M as Model

    EL->>CM: InvokeModelContext (full tool_specs)
    alt condition does not match or candidates fit within keep
        CM->>T: tool_specs unchanged
    else first call of the invocation
        CM->>H: apply(tool_specs)
        H->>S: search(query, candidates, keep)
        S-->>H: ranked names (or failure → on_failure)
        H-->>CM: selected names
        CM->>T: selected specs in catalog order
    else selection exists
        CM->>T: stored names ∩ catalog, catalog order
    end
    T->>M: stream(...)
```

Two things the event loop does today need adjusting for this handler.

Token projection. Current: `projected_input_tokens` is estimated before input middleware, against the full catalog. What we need to do: the handler subtracts the tokens of the specs it removed and writes the corrected value to `context.projected_input_tokens` (P0). Proactive compression at `BeforeModelCallEvent` runs before any input middleware and keeps the pre-filter estimate, which is conservative; 0016 records the same limitation for routing.

Handler ordering. Current: `Hide`'s handler runs after routing and tool-spec producers only because the ContextManager plugin initializes after them. What we need to do: make that an explicit ordering rule, either a `MiddlewareOrder` akin to `HookOrder` or a documented "ContextManager last" (P1).

### Search strategies

`ToolSearchStrategy` ranks in-memory candidates that are never stored. It is a separate contract from the storage package's `SearchStrategy`, which ranks stored keys for a `Storage`; `StorageSearch` bridges the two. Three implementations: `KeywordToolSearch` is the default, in-process overlap between the query's content words and each candidate's name, description, and input-property text; names are split on `_ - . : /` and camelCase, plurals are normalized, any name hit ranks above any number of description hits, and ties keep catalog order. `LLMSearch` is the opt-in judge, one call to a developer-supplied model that picks relevant names from the candidate list, with the output allowlisted to candidate IDs and any failure failing open. `StorageSearch(storage)` indexes candidate text and delegates to `Storage.search`, which is how embeddings and S3 Vectors (#3967) plug in.

### Developer experience

The explicit strategy shows the behavior:

```python
context_manager = ContextManager(
    strategies=[Hide.tool_specs(keep=10).when(count=20)],
)
agent = Agent(tools=[...many tools...], context_manager=context_manager)
```

Pins keep a base set visible outside `keep`; naming candidates narrows what competes for it:

```python
context_manager = ContextManager(
    strategies=[
        Hide.tool_specs(["tool_spec::*", "!tool_spec::ask_user", "!tool_spec::finish"], keep=15).when(count=20),
    ],
)

# Only the billing tools compete for `keep`; everything else stays visible
Hide.tool_specs(["tool_spec::billing_search", "tool_spec::billing_summary"], keep=1)
```

Tools the model must never see, and what to show when nothing matches:

```python
Hide.tool_specs(always_hide=["debug_dump"], on_failure="none")
```

After benchmarks establish the default activation rule, a preset expands to the same strategy:

```python
ContextManager(strategies=["tool_selection"])
```

A judge changes only the search implementation:

```python
judge = BedrockModel(model_id="amazon.nova-micro-v1:0")
context_manager = ContextManager(
    strategies=[
        Hide.tool_specs(search=LLMSearch(model=judge), keep=15).when(count=20),
    ],
)
```

TypeScript recases these to `Hide.toolSpecs`, `toolSpec::ask_user`, `alwaysHide`, `onFailure`, and `toolSelection`. Each decision records strategy, candidate count, selected names, duration, and the `on_failure` outcome on the agent-loop-cycle span; an `LLMSearch` call gets its own child span with usage.

### Interface

The proposed interface is:

```python
@dataclass(frozen=True)
class ToolSearchResult:
    name: str
    score: float   # higher is more relevant; the contract is result ORDER, best-first

class ToolSearchStrategy(Protocol):
    async def search(
        self, query: str, candidates: Sequence[ToolSpec], limit: int
    ) -> Sequence[ToolSearchResult]: ...

class Hide:
    @staticmethod
    def tool_specs(
        target: str | Sequence[str] = "tool_specs",   # or ["tool_spec::*", "tool_spec::name", "!tool_spec::name"]
        *,
        search: ToolSearchStrategy | None = None,     # KeywordToolSearch when omitted
        keep: int = 10,
        always_hide: Sequence[str] = (),
        on_failure: Literal["all", "none"] = "all",
    ) -> HideStrategyBuilder: ...

class HideStrategyBuilder(ContextStrategy):
    def when(self, *, count: int | None = None) -> ContextStrategy: ...
```

The target uses a `tool_spec::` namespace, matching `tool::` for tool results: `tool_spec::*` or `tool_spec::<name>` entries name the candidates, and `!tool_spec::<name>` pins a spec outside the operation. `count` is the number of candidates after pins and protected tools and is `Hide`'s only condition; `threshold`, `utilization`, and `preserve_recent` are message conditions and do not apply. When two `Hide` strategies are listed, the second sees the first's output. `keep` is the number of candidates the model sees: the first matches returned by `ToolSearchStrategy` that name a candidate, then unmatched candidates in catalog order; scores are informational. The `tool_selection` preset joins the existing `StrategyPresetName` union after benchmarks establish its default `Hide` configuration.

## Prompt caching

Tool definitions are the first section of the cached prefix on Anthropic, Bedrock, and OpenAI, so changing them invalidates the tools cache and everything behind it, while a `tool_choice` change invalidates only messages ([Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html), [OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching)). The design does three things about it:

- Membership is fixed within an invocation and specs are emitted in catalog order, so every call in a tool loop sends the same tool prefix.
- Selection stays explicit until benchmarked. Removing definitions saves tokens but can cost more than it saves on a warm cache with a long conversation, so `"auto"` does not enable it until we know when it is net-positive.
- The selection result is kept separate from delivery, so adapters can adopt the cache-preserving modes providers recommend without changing the policy: keep the definitions list stable and restrict callability with `allowed_tools`; mark definitions `defer_loading` and let tool search append loaded ones at the end of context; or record loaded tools as `additional_tools` items in the thread ([OpenAI tool search](https://developers.openai.com/api/docs/guides/tools-tool-search)).

| Delivery mode | Definitions the model sees | Callable set | Saves definition tokens | Cache prefix | Portable |
|---|---|---|---|---|---|
| Full catalog (today) | all | all | no | stable while the registry is stable | yes |
| Portable `Hide` (v1) | selected | selected, not enforced | yes | rewritten when membership changes | yes |
| Stable definitions + `allowed_tools` | all | selected | no | preserved; only message blocks change | OpenAI |
| Deferred, append-only loading | summary, then loaded subset | loaded subset | yes | preserved; discovered definitions enter through the message history | OpenAI, Anthropic |

`allowed_tools` preserves the cache but not the tokens; deferred loading does both but grows the active set through load events rather than re-selecting each invocation. Neither is expressible through `ToolSpec` and `ToolChoice` today; both are follow-up items.

### Measured evidence

A Bedrock prototype ([script and full results](https://github.com/JackYPCOnline/harness-sdk/tree/prototypes/0018-tool-selection-benchmark/prototypes/0018-tool-selection)) compared the full catalog with per-invocation lexical selection over 60- and 120-tool catalogs and short and 16k-word histories, four tool-use tasks per cell, both arms hitting the expected tool 16/16. Selection cut raw prompt tokens 40 to 78 percent in every cell, but cache-adjusted cost rose 3 and 45 percent at 60 tools and fell 46 and 20 percent at 120. Tool count alone is not a safe activation rule. The benchmark is synthetic (padded descriptions, one run per cell) and speaks to cache economics, not retrieval quality.

## Follow-up items

TypeScript proves the extension first because its first-class `ContextManager` and stash already exist. Python ports the stabilized surface rather than shipping a temporary plugin.

- **P0, TypeScript target and local search.** Add the `toolSpecs` target and `Hide.toolSpecs`; register the Input handler and invocation-boundary cleanup from `init`; decide once per invocation; correct `projectedInputTokens` on the cold-start call; add `ToolSearchStrategy` with `KeywordToolSearch` as the default, target validation, `alwaysHide`, `onFailure`, and carry-forward on continuation turns. No registry API changes.
- **P1, span attributes.** Record strategy, candidate count, selected names, duration, and fallback on the agent-loop-cycle span.
- **P0, benchmarks.** Extend the prototype to real MCP and local catalogs and ambiguous tasks; tune `keep` and query projection; derive a cache-aware activation policy from raw tokens, cache reads and writes, latency, realized cost, and task success. Compare automatic selection against progressive disclosure (names plus short previews and a `search_tools` tool) on the same tasks.
- **P1, preset.** After benchmarks choose the default activation rule, add the `toolSelection` preset from #4053 as sugar over the default `Hide` strategy.
- **P1, Python parity.** Port the first-class `ContextManager`, `tool_specs` target, and `Hide` with the same behavior; add the `tool_selection` preset after its default is established.
- **P1, `LLMSearch` and `StorageSearch`.** Add the judge option and the `Storage.search`-backed strategy so embedding and S3 Vectors backends from #3967 plug in without a new abstraction.
- **P1, projection after input middleware.** Re-estimate `projected_input_tokens` once after the `InvokeModelStage.Input` chain so spans and downstream consumers reflect every input handler, not only this one. `BeforeModelCallEvent` compression keeps the pre-middleware estimate; moving it later is a loop change shared with 0016 and out of scope here.
- **P1, ordering contract.** Formalize where `Hide`'s Input handler runs relative to routing and tool-spec producers, either a `MiddlewareOrder` akin to `HookOrder` or a documented "ContextManager last" rule, before the surface leaves experimental.
- **P1, provider callability.** Add OpenAI `allowed_tools` as a separate ContextManager strategy for restricting calls; it does not replace `Hide`.
- **P1, facade default.** Add the `toolSelection` preset to `"auto"` only after benchmarks establish when it is net-positive, with an explicit opt-out.
- **P2, deferred, append-only loading.** Mark definitions `defer_loading` and deliver discovered ones through OpenAI's tool search and `additional_tools` items or Anthropic's `tool_reference` blocks, with the loaded-tool history kept in model input so the prefix survives across calls. The active set grows through load events rather than being re-selected, so this mode needs its own lifecycle rules on top of the P0 policy. Anthropic's custom search tool returns `tool_reference` blocks, which is where `ToolSearchStrategy` plugs in server-side.
- **P2, agentic discovery.** A ContextManager-owned search tool for #1680, backed by `ToolSearchStrategy`.

This design supersedes the `ToolManager` proposal in #263; the registry remains the source of truth. Migration: none. Tool selection is explicit in experimental v1.

## Appendix: alternatives considered

**Use `Offload` for tool specs.** `Offload` can share the `tool_specs` target, but its stash and overflow semantics do not apply because the registry still holds each spec. `Hide` keeps tool selection in the strategy list without storing specs or applying message transformations.

**Use a dedicated `tool_selection` parameter or standalone plugin.** Either can use the same middleware and registry boundary, but creates a second configuration path. `Hide.tool_specs(...)` keeps context policies in one strategy list and supports the preset model.

**Register and unregister tools around each call.** No new seam, and every registry consumer sees the reduced set. It turns the registry into per-call state shared across concurrent invocations, `agent.tools` stops reflecting what the developer registered, a tool use for a tool hidden on this call resolves against a registry that no longer contains it, MCP consumer counts and hot reload are disturbed, and the wire request changes exactly as it does with the portable filter, so nothing is saved on cache. The defensive per-call copy exists so a projection can differ from the inventory.

**Provider-native restriction as the v1 foundation.** `allowed_tools` preserves the tool prefix for OpenAI but is not portable and does not reduce definition tokens. It is a separate ContextManager strategy for restricting calls, not an implementation of `Hide`.

## Willingness to Implement

Yes.
