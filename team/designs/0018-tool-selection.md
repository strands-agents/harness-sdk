# Tool Selection

**Status**: Proposed

**Date**: 2026-08-25

**Issues**: [#263](https://github.com/strands-agents/harness-sdk/issues/263), [#1677](https://github.com/strands-agents/harness-sdk/issues/1677), [#1680](https://github.com/strands-agents/harness-sdk/issues/1680)

**Scope**: Python and TypeScript

## Problem

A Strands `Agent` sends every registered tool to the model on every call, whether or not the task needs it. The cost is measured: Anthropic reports a typical five-server MCP setup consuming roughly 55k tokens of tool definitions before the conversation starts, while a request usually needs 3 to 5 tools ([tool search docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)). Large tool menus also reduce selection accuracy, since models choose less reliably among many similarly described tools. The problem grows with MCP adoption, where a few servers contribute dozens of tools the agent author never enumerates by hand, and customers have asked for both automatic filtering and on-demand discovery (#263, #1677, #1680).

### Current State

Each agent-loop cycle calls `agent.tool_registry.get_all_tool_specs()` and sends the full list to the model. No public extension point can filter that list: `BeforeModelCallEvent` fires before the tool list is assembled and can only cancel the call, `BeforeToolCallEvent` runs after the model has already chosen, and the human-in-the-loop intervention gates execution rather than visibility, so every schema still consumes input tokens. Developers can partition tools across agents or build per-task registries, but neither adapts during an invocation: a task that discovers a new requirement mid-run cannot reach another tool without rebuilding the agent.

Other frameworks establish the two useful behaviors. LangChain ships an [LLM tool-selector middleware](https://github.com/langchain-ai/langchain/blob/54383cd12c97eca2fd41984dfed99ea4d4ff1ee9/libs/langchain_v1/langchain/agents/middleware/tool_selection.py) that replaces the visible list before each model call, though it classifies against only the last user message. Anthropic's server-side tool search lets the model pull from a deferred catalog, but is provider-gated and blind to local tools. Google ADK exposes per-request tool filtering as an interface but ships no selection logic. Strands needs both behaviors, push and pull, across local and MCP tools, without requiring a specific provider.

## Goals

- Reduce total model input cost for agents with large tool catalogs, with no behavior change unless the developer enables selection.
- Select tools once per invocation from conversation context, with the visible set adapting mid-run through discovery and retention rather than re-selection.
- Provide automatic filtering and agentic discovery through one construct and one strategy contract.
- Work with zero configuration: the default judges once per invocation on the agent's own model, and is configurable to a dedicated judge model or a custom strategy.
- Keep tool ordering deterministic and avoid unnecessary tool-block changes.
- Never mutate the tool registry. Selection controls visibility for one model call, not tool-calling permissions.
- Preserve structured output, explicit `tool_choice`, session management, and runtime catalog changes through defined lifecycle rules.
- Fail open by default. Selection failure restores the eligible catalog instead of failing the agent call.
- Keep Python and TypeScript concepts, names, defaults, and behavior aligned.

### Non-Goals (v1)

- Provider-native deferred loading, including Anthropic tool search. Native search changes provider request and response handling; it is not a client-side selection strategy.
- A public vector database or embedding abstraction. Custom strategies may use either internally; v1 does not standardize storage or indexing.
- Usage-pattern learning or persisted selection state across invocations.
- Authorization. A hidden tool remains registered and callable; exclusion is a visibility control, not a security boundary.
- Correcting `projected_input_tokens`. Projection occurs before invoke-model middleware and therefore overestimates filtered calls in v1.

## Key Decisions

1. `ToolSelector` is one opt-in `Plugin` registering an `InvokeModelStage.Input` handler that replaces `context.tool_specs`, the same pattern 0016 uses for `model`. The hook system is unchanged.
2. The selector owns lifecycle, ordering, pins, catalog invalidation, and failure policy. A strategy ranks candidates, and in automatic mode derives its own intent signal from the conversation.
3. Selection filters visibility, not executability. Tool calling still resolves against the full registry.
4. The default strategy is the LLM judge, run once per invocation (0016's classifier cadence), on the agent's own model when no judge is configured. The default is provisional while the feature is experimental: before graduation, benchmarking compares unfiltered, lexical, and judge selection (see Open Question below), then keeps or replaces the default, or, if no option wins clearly, removes it and makes `strategy` a required argument.
5. Selection runs once per invocation and the active set only grows, so a discovered tool never disappears mid-task and the tool block stays stable unless a tool is added. Emission order is deterministic, which protects provider prompt caching; adding a tool can still invalidate the provider's cached tool block.
6. Tool names are registry-unique (`register_tool` raises on duplicates), so name-keyed set operations are safe.
7. Accepted gap: `projected_input_tokens` is estimated before middleware runs and over-counts filtered calls.
8. Alignment needed at review:
    - Default strategy: LLM judge as the candidate, evaluation gate decides; explicit strategy required if results are inconclusive.
    - Failure policy: fail open by default, a broken selector shows all tools instead of failing the call.
    - Issue #263: approving this design closes its `ToolManager` proposal; the two are not built in parallel.

## Proposal

Every managed model call flows through `InvokeModelStage`, whose per-call context carries a defensive copy of the tool list. Selection belongs there for the same reason model routing does: it prepares a model invocation, and the stage already provides the interception point and tracing.

### Recommended: one `ToolSelector` plugin over `InvokeModelStage`

Developers enable selection by adding one plugin. The proposed Python surface:

```python
FailurePolicy = Literal["all", "none"] | tuple[str, ...]

@dataclass(frozen=True)
class ToolMatch:
    name: str                    # the tool's registered name (ToolSpec["name"])
    score: float | None = None   # higher is better when present; tracing and
                                 # discovery results only, never emission order

@dataclass(frozen=True)
class ToolSelectionContext:
    messages: Messages
    tool_specs: tuple[ToolSpec, ...]   # eligible candidates for this decision
    query: str | None                  # the model's search string from find_tools;
                                       # None means automatic selection, infer from messages

class ToolSelectionStrategy(Protocol):
    name: str   # stable identifier for traces and logs, identical across SDKs
    async def select(self, context: ToolSelectionContext, *, limit: int) -> Sequence[ToolMatch]:
        """Rank tools for conversation context or an explicit discovery query."""

class ToolSelector(Plugin):
    def __init__(
        self,
        *,
        strategy: ToolSelectionStrategy | None = None,   # None selects LLMSelectionStrategy
                                                         # on the agent's own model
        discovery_tool: bool = True,   # vend find_tools so the model can search the catalog
        selection_limit: int = 25,
        always_include: Sequence[str] = (),
        always_exclude: Sequence[str] = (),
        on_failure: FailurePolicy = "all",
    ) -> None: ...
```

The TypeScript surface mirrors these names and defaults recased to the language convention (`ToolSelectorOptions` with `discoveryTool`, `selectionLimit`, `alwaysInclude`, `alwaysExclude`, `onFailure`), with identical single-word policy values, validation rules, and lifecycle behavior. 

There is no switch for automatic filtering: adding the plugin is the opt-in.

`selection_limit` caps new automatic additions per decision and the result count per discovery request; it never caps the accumulated active set, so the limit is honest about what it bounds.
A `ToolSelector` instance binds to one agent.
### Strategy behavior

The selector hands the strategy a read-only view containing only tools that can expand the visible set. The strategy returns ranked names and scores; the selector validates names, applies the limit, and owns the final ordering.

Two strategies ship in v1:

- `LLMSelectionStrategy` (recommended default). The tool-selection analog of `ModelRouter`'s `ClassifierStrategy`: same structured-output judging, same isolation of untrusted descriptions. It judges once per invocation from the last user message and prior conversation; mid-run needs are covered by pins and retention, not re-judging. When `find_tools` executes with this strategy configured, its ranking is answered by one judge call inside the tool. Defaults to the agent's own model; production points it at a small judge.
- `StaticSelectionStrategy`. A fixed allowlist; the trivial case, the deterministic testing seam, and the zero-model-call option.

The judge execution contract is narrow: a direct model call, never an inner agent, with no tool access. Catalog text passed to the judge is size-capped per description and in aggregate.
A deterministic lexical scorer is not offered as the automatic default: token overlap misses paraphrase, and each miss is recovered through a full extra cycle on the primary model. Explicit discovery queries are a different case, since the model writes capability descriptions that match tool text well, so the initial discovery phase ships with an internal experimental lexical matcher (see Work Plan) and the evaluation gate decides whether lexical graduates to a public strategy.


### Tool-set lifecycle

The selector keeps namespaced state between `BeforeInvocationEvent` and `AfterInvocationEvent`, initialized at the start of every invocation and cleared on normal and exceptional completion. Selector state never enters session state. For each ordinary managed call, the prepared catalog is `context.tool_specs` as the selector's handler receives it, after all earlier input middleware, and the transition is:

```text
eligible = prepared - always_exclude

active   = previous active
         ∪ always_include
         ∪ automatic additions        (≤ selection_limit validated matches)
         ∪ discovery pins
         ∪ tools called this invocation
         ∪ system-retained tools      (find_tools when enabled; the forced structured-output tool)
         ∪ failure-policy additions   (empty during normal selection)

visible  = active ∩ eligible, emitted in deterministic order
```

Selector state is invocation-scoped and never persisted: pins and called-tool retention die with the invocation, and session restoration does not reactivate old tools. Forced structured output and explicit `tool_choice` bypass selection entirely. A catalog change mid-invocation never re-triggers the automatic decision; new tools become reachable through discovery, being called, or fail-open. The prepared catalog (the tool list as the selector receives it) is the ordering authority for ranking, emission, and fingerprinting; the live registry is authoritative only for execution.
Emission order is total and stable: system-retained tools in construct-defined order, then `always_include`, then remaining active tools, both in prepared-catalog order, each name once, never relevance order. Given the same catalog, state, and configuration, both SDKs produce the same ordered list.

### Agentic discovery

With `discovery_tool=True`, the selector vends an implicitly retained `find_tools(query, limit?)` tool, closing the push-based blind spot: a model cannot reveal a need for a tool it never saw. When the model omits `limit` it defaults to 5; an explicit value must be between 1 and `selection_limit`, which caps discovery like everything else. The default is not developer-configurable on purpose: the model can pass a different limit on any call. Results carry names, descriptions, and scores, not input schemas; matched names become pins, and their full schemas enter the tool list on the next ordinary call, so schemas are paid for once, where the model expects them. Pins do not consume the automatic budget. If a registered tool already uses the discovery name, agent initialization fails with an error naming the collision and how to disable discovery.

### Failure policy and runtime catalog changes

After strategy-owned retries, `on_failure` applies: `"all"` (default) promotes every eligible tool to active and latches fail-open for the rest of the invocation, skipping later automatic strategy calls; `"none"` adds nothing beyond retained tools; an explicit tuple adds those validated names. `find_tools` remains callable under the fail-open latch for diagnostics, reporting matches that are already active. Invalid names returned by a strategy count as a strategy failure rather than disappearing silently. The selector logs the error and applied policy once per distinct failure.

The selector fingerprints the prepared catalog (names, descriptions, input schemas) before each managed call, purely as an in-memory change detector. A newly registered tool becomes an eligible candidate (active immediately under the fail-open latch, otherwise when pinned, called, or configured). MCP `listChanged` affects selection only after the MCP integration updates the live registry; propagating that notification remains separate work.

### Observability

Input middleware runs before the model-invoke span exists, so v1 records selection on the agent-loop-cycle span and emits one structured debug record per decision: strategy name, selected and pinned names, candidate count, visible count, duration, and catalog fingerprint. A filtered-out tool is a fact a developer can see in traces, not an invisible absence.

### Pros

- One plugin, both behaviors: automatic filtering (#1677) and discovery (#1680) share one strategy contract instead of competing mechanisms.
- Zero setup: `ToolSelector()` just works. One judge call per invocation buys schema savings on every call after it, and swapping strategies is one argument.
- Nothing new in core: the interception point is the one 0016 proved, and the registry stays the source of truth for tool calling.
- No surprises: lifecycle, failure, ordering, and runtime catalog changes are all specified.
- Ports cleanly: TypeScript has the same middleware shape and the same surface.

### Cons

- The default adds one small-model call per invocation and one per discovery request.
- Monotonic activation can grow beyond `selection_limit` during long invocations.
- `projected_input_tokens` continues to overestimate filtered calls.
- Per-call catalog fingerprinting adds work proportional to catalog size, though target catalogs are hundreds of short specs.

### Alternative: lexical default

Default to a deterministic local scorer (token overlap over names, descriptions, and input-property descriptions) with the judge as opt-in.

**Pros:**

- No selection model call at all.
- Deterministic output, zero added latency, works offline.

**Cons:**

- Token overlap misses semantic paraphrase, the common case in conversational agents ("chart the trend" shares no tokens with `render_visualization`).
- Every miss fails silently: the needed tool is just invisible, and nothing in logs or traces errors.
- Recovering a miss costs a full `find_tools` cycle on the primary model, more than the judge calls the default avoided.
- A weak default discredits the feature on first contact.

Not recommended as the default. It still runs as an arm in the evaluation gate, which can promote it on evidence, and it backs the initial discovery phase internally, where explicit model-written queries suit lexical matching. Latency-sensitive deployments already have `StaticSelectionStrategy` as the zero-call option.

### Alternative: public `ToolIndex`

Publish an index abstraction (`initialize(tools)` / `search(query)`) that lexical, vector, and hosted backends implement.

**Pros:**

- Direct query contract; retrieval backends map onto it naturally.
- Clear ownership for persistence (an embedding cache lives with its index).

**Cons:**

- Automatic selection still needs a separate intent-derivation contract, so developers must learn two concepts where one strategy suffices.
- Provider-native deferred loading does not fit an index queried before the call.
- v1 would publish an abstraction before multiple implementations prove its shape.

Not recommended for v1. Strategies may own private indexes; a shared contract can be extracted later from evidence.

### Alternative: `ToolManager` (issue #263's proposal)

Replace registry sourcing with a `ToolManager` the event loop queries per call.

**Pros:**

- Selection becomes a first-class concept in the event loop.

**Cons:**

- Inserts a new public abstraction between agent and registry and changes the event loop's source of truth.
- Duplicates the per-call transformation seam that already exists.
- Its static implementation would exist only to preserve behavior the plugin preserves for free.

Not recommended. The issue's outcomes become strategies behind this design.

### Alternative: writable `tool_specs` on `BeforeModelCallEvent`

Let a hook callback rewrite the tool list.

**Pros:**

- Hooks are public API, and `HookOrder` makes callback ordering controllable.

**Cons:**

- The event fires before the tool list is assembled, so it must move (changing a public event's observable timing) or split into two events.
- Hook callbacks are now for observation, while middleware serves modification.

Not recommended.

### Alternative: separate automatic and discovery plugins

Ship filtering and `find_tools` as two independent plugins.

**Pros:**

- Each ships and versions independently.

**Cons:**

- Two public names reconciling pins, active state, exclusions, failure, and ordering through an implicit shared contract.

Not recommended. The work plan already phases delivery without permanent duplicate ownership. A dedicated tool-selection middleware stage is likewise rejected for the reason 0016 rejected a routing stage: `InvokeModelStage` already wraps exactly this operation.

## Developer Experience

The default needs no configuration: it judges once per invocation on the agent's own model and includes the discovery escape hatch.

```python
from strands import Agent
from strands.tools.selection import ToolSelector

agent = Agent(model=model, tools=available_tools, plugins=[ToolSelector()])
```

A tuned setup pins a base set and a tighter decision budget:

```python
selector = ToolSelector(
    selection_limit=15,
    always_include=["ask_user", "finish"],
    always_exclude=["legacy_report"],
)
```

Production setups configure a small dedicated judge instead of reusing the agent's model:

```python
from strands.models import BedrockModel
from strands.tools.selection import LLMSelectionStrategy, ToolSelector

judge = BedrockModel(model_id="amazon.nova-micro-v1:0")
selector = ToolSelector(strategy=LLMSelectionStrategy(model=judge), selection_limit=5)
```


## Open Question: Confirming the Default

Which strategy deserves to be the default is an open question this design does not settle; benchmarking does, and the decision is a two-way door while the feature is experimental. The comparison runs unfiltered, lexical, and judge selection, counting total cost honestly: judge calls, discovery cycles, and recovery from missed tools all count against a strategy. A strategy earns the default by cutting total input tokens without regressing task success; if nothing wins clearly, `strategy` becomes a required argument.


## Work Plan

Python ships first; the TypeScript port follows once benchmarking has settled the default, so the surface is ported once.

- **P0, selector core.** Selector state and lifecycle, deterministic ordering, include/exclude validation, bypasses, failure policy, `StaticSelectionStrategy`
- **P0, agentic discovery.** `find_tools` with invocation-scoped pins, backed by an internal experimental lexical matcher. No model call, no filtering; closes #1680 on its own.
- **P0, automatic selection with the judge.** `LLMSelectionStrategy` (once-per-invocation cadence, agent-model fallback, judge execution contract) applied to managed calls with `selection_limit` and monotonic retention. Feature complete, experimental.
- **P1, lexical strategy and benchmarking.** Build the lexical strategy as a benchmark arm, run the three-arm comparison per the open question above, then confirm, replace, or remove the default; lexical graduates to a public strategy only if its arm wins.
- **P1, TypeScript port.** Port the stabilized surface and behavior with a parity review.
- **P2, extensions.** Custom retrieval strategies (vector, hosted), provider-native deferred loading as a separate mode, and post-middleware token projection if filtered projections become necessary.

## Consequences

MCP-heavy agents gain one opt-in mechanism for automatic filtering and discovery, with alternative strategies one argument away. #1677 and #1680 ship as two modes sharing one lifecycle and ordering policy, and #263 closes without introducing `ToolManager` or a public index family.

The design accepts two costs: monotonic visibility that can exceed the per-decision limit, and a default judge call whose net saving must be demonstrated rather than assumed, which is why benchmarking and the discovery escape hatch are part of the feature rather than follow-up polish.

Migration: none. Agents without `ToolSelector` continue to send the full registry; enabling selection changes only what managed model calls see.

## Willingness to Implement

Yes.
