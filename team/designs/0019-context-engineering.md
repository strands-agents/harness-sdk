# Context Engineering

**Status**: Proposed

**Date**: 2026-09-09

**Issue**: TBD

**Related**:
- [0009-context-offloader.md](./0009-context-offloader.md) — the offloader these strategies extend and depend on
- [0011-context-strategy.md](./0011-context-strategy.md) — context management presets; `ContextStrategy` is the single-strategy construct proposed there
- [0003-context-management.md](./0003-context-management.md) — the broader context-management picture

**Scope**: Python SDK. Three vended plugins under `strands/vended_plugins/`, plus one additive parameter on an existing plugin. No cross-SDK surface change beyond the shared naming parity rules.

## Problem

An agent's per-call cost is dominated by material it already paid for on an earlier call and no longer needs. A measured 18-turn banking session opened at 74,675 input tokens with an empty history and peaked at 288,678. Two components account for almost all of that growth, and neither is reachable by the conversation managers the SDK ships today:

- **Tool schemas.** Every model call carries the full specification of every registered tool. In the measured session that set was ~63,000 tokens, identical across all 33 calls — roughly 85% of the floor of a call with an empty history, and ~30% of the whole session's consumption.
- **Stale tool results and turns.** About 75% of the peak was tool-result content that mattered only on the turn it was fetched. Four turns of debugging one connector added up to 44.7% of the session's tokens and kept being resent after the problem was resolved.

- **Who experiences it?** Any agent with a non-trivial tool suite and a multi-turn conversation — which is most production agents. The cost grows with tool count and conversation length, the two axes real deployments grow along.

### Current State

The SDK already has the building blocks, but they cut by position, not by relevance, and they do not reach the schema at all.

- **`SlidingWindowConversationManager`** discards the oldest messages after an overflow. It cuts by age: the connector-debugging turns above were discarded only once they were old enough, long after they stopped being the subject, and a −71,701-token cut at a turn boundary in the measured session was age-based eviction with no notion of what the turn was about.
- **`SummarizingConversationManager`** replaces spans with a generated summary. It cuts by position and is irreversible — the original is gone, and a summary of a bank statement paraphrases the numbers.
- **`ContextOffloader`** (design 0009) intercepts oversized tool results, stores the full output, and returns a **positional prefix** of the text. The prefix is blind: for an HTML page the first characters are `<head>`, `<style>`, `<script>` — it keeps the CSS and drops the content.
- **Tool schemas are untouched by all of the above.** Summarization and the sliding window operate on `agent.messages`; `tool_specs` is a separate parameter of the call assembled fresh from the registry every time (`event_loop.py`: `tool_specs = agent.tool_registry.get_all_tool_specs()`).

The paper cut compounds: every one of these mechanisms is an independent extension point the developer must discover, choose, and compose, and none of them addresses the single largest line item — the schema — or cuts history by what the current turn actually needs.

## Goals

- **Cut the two dominant cost components — schema and stale history — by relevance, not by position.**
- **Reversibility by construction.** A wrong decision costs one poorer model call, never lost information. Nothing mutates `agent.messages`; every strategy operates on the per-call copy the event loop hands to `InvokeModelStage`.
- **No new runtime dependency.** No graph library, no similarity library, no model call added on the critical path beyond, at most, one embedding per turn.
- **Composability.** The strategies target different parts of the request and compose cleanly; a developer can adopt one, two, or all three.
- **Measurable payoff.** Each strategy carries the instrumentation to answer whether it earns its cost on a given workload, because the answer is workload-dependent.
- **Constraint: opt-in and non-regressive.** An agent that does not enable a strategy sees byte-identical behavior. Defaults preserve today's behavior.

## Key Decisions

1. **Design 0009 (offloader) and 0011 (`ContextStrategy`) are the ground these build on.** Relevance filtering is a preview strategy *inside* the offloader, not a new plugin. The context graph is one strategy of the single-per-agent `ContextStrategy` construct that 0011 established.
2. **Invariant: act on the per-call copy at `InvokeModelStage.Input`, never on the live list at `BeforeModelCallEvent`.** This is what makes every decision reversible. The event loop already deep-copies `agent.messages` and `tool_specs` into `InvokeModelContext` for exactly this purpose.
3. **Invariant: fail open.** Any failure — a scorer erroring, an embedding timing out, a malformed response — degrades to today's behavior (positional preview, full schema, full history), logs once, and never propagates.
4. **Risk: scale dependence.** In a short (18-turn) session the schema dominates and the history-side strategies measure as *more expensive* than baseline, because there is little stale history to cut yet. The strategies pay off as the conversation grows. This is inherent, not a defect, and it shapes the recommendation below (pair the history strategy with the schema strategy).
5. **Alternative weighed and rejected: one combined plugin.** Considered folding all three into a single "context engineering" plugin. Rejected — see Alternatives — because the three touch different request components with different failure semantics, and coupling them would force one failure policy where three are correct.
6. **Team alignment needed on:** whether the context graph ships under the `0011` design or wants its own, and whether the additive `referenced_source` parameter on `ProgressiveToolDisclosure` is acceptable as the coupling point between the schema and history strategies.

## Proposal

Three independent, composable strategies, each attacking one slice of the per-call spend. All operate on the per-call copy, all fail open, all are opt-in.

### Recommended: three focused strategies over the existing offloader and context-strategy constructs

**A — Relevance Filtering** (`ContextOffloader(preview_strategy="relevance")`). An alternative preview strategy inside the existing offloader. When a tool result is offloaded, instead of keeping `text[:preview_tokens*4]`, it splits the text into chunks, scores each against the current question plus the tool's arguments using Amazon Bedrock Rerank, and keeps the passing chunks **verbatim** up to the preview budget, with gap markers naming the omitted line ranges. The raw content stays in `Storage`, retrievable by `retrieve_offloaded_content`.

```python
from strands import Agent
from strands.vended_plugins.context_offloader import ContextOffloader, FileStorage

agent = Agent(
    plugins=[
        ContextOffloader(
            storage=FileStorage("./artifacts"),
            preview_strategy="relevance",   # default stays "prefix"
        )
    ],
)
```

**B — Progressive Tool Disclosure** (`ProgressiveToolDisclosure`). Replaces the full schema of every tool on every call with a lean catalog (name + a ~20-token description) plus a `find_tools` search tool. The model describes what it needs; the matching tools' full `inputSchema` arrives on the next call; unused schemas expire by inactivity (TTL in event-loop cycles, renewed on use). Nothing leaves the registry — only the per-call projection changes.

```python
from strands.vended_plugins.progressive_tool_disclosure import ProgressiveToolDisclosure

agent = Agent(tools=[...], plugins=[ProgressiveToolDisclosure()])
```

**C — Context Graph** (`ContextStrategy(strategy="graph")`). Replaces the linear message list as short-term memory with a graph of Cards — one Card per turn, derived by deterministic scan with no model call. Each Card enters a call at one of three resolutions: Title (~5 tokens, always present), Description (derived by rule, capped), or Full Content. A per-turn note — embedding similarity between the question and each Card's description, propagated along links — decides the resolution, which only ever descends by budget, never by verdict. Delivery removes stale history and folds the descriptions in as a per-call final block, reusing the existing message-injection primitive.

```python
from strands.agent.conversation_manager import NullConversationManager
from strands.vended_plugins.context_graph import ContextStrategy

agent = Agent(
    conversation_manager=NullConversationManager(),
    plugins=[ContextStrategy(strategy="graph")],
)
```

**The coupling point, and why it is one line of new surface.** When the graph lowers a Card to Description, that turn's `toolUse` blocks leave the retained history, so B would drop the tool from its Full-Specification block to a name-only entry — and the model would read a Description that still names a tool it no longer knows how to call. B therefore accepts an additive `referenced_source` callable; the graph publishes the tool names its surviving Cards still mention, and B unions them into the set it already computes from the retained history. B keeps ownership of the level decision; the source is one more input, not a delegated decision. With `referenced_source=None`, B's projection is byte-identical to today's.

**Pros:**
- Each strategy is independently adoptable, testable, and reasoned about; the failure policy is chosen per strategy where the cost of being wrong differs (the reranker *raises* rather than return a partial list; the graph matcher *never raises*).
- Reuses accepted constructs (0009 offloader, 0011 `ContextStrategy`) and an existing primitive (message injection), so the net new surface is small.
- Measured payoff on the full stack: on a 60-turn run the graph-plus-schema-plus-preview stack cut input tokens by ~82% at baseline accuracy; the schema strategy alone cut ~54%.

**Cons:**
- Three knobs instead of one; a developer wanting "just make it cheaper" has to compose them (mitigated by 0011's preset direction).
- The graph and relevance filtering each add one auxiliary model call (embedding, rerank) whose cost is billed separately from the agent's tokens and must be accounted for.
- Scale-dependent payoff: on short conversations the history strategies can measure as net-negative until the history grows.

### Alternative: a single combined "context engineering" plugin

One plugin that offloads, filters, discloses, and graphs, behind a single switch.

- **Pros:** one import, one knob; the "make it cheaper" happy path is literal.
- **Cons:** the three components have genuinely different failure semantics — a reranker must raise (a partial relevance list silently drops the passage the question needed), while the graph matcher must not (failing to score only costs tokens). A single plugin forces one failure policy, or carries three behind flags, which is the composition problem in disguise. It also couples release cadence: a change to schema handling would touch the same unit as history handling.
- **Why not recommended:** it trades a small composition cost (three constructs) for a large coupling cost (one failure policy, one release unit, one blast radius). The preset direction in 0011 already addresses the "one knob" need without the coupling.

### Alternative: reduce the schema by trimming descriptions at the source

Ask tool authors to write shorter descriptions, or auto-truncate every schema unconditionally.

- **Pros:** no new machinery.
- **Cons:** unconditional truncation degrades every call whether or not the tool is relevant, and it cannot recover detail when a tool *is* used. It also puts the burden on tool authors for a problem that is per-call, not per-tool. Progressive disclosure keeps the full schema exactly when the tool is in play and drops it otherwise — a per-call decision the source cannot make.

## Developer Experience

The default of every strategy preserves today's behavior; adoption is one parameter.

**Relevance filtering** — flip the preview strategy:

```python
ContextOffloader(storage=FileStorage("./artifacts"), preview_strategy="relevance")
# The model now sees the passages that answer its question, verbatim, with gap markers:
#   Account 0001/12345-6
#   Consolidated position: 47,832.15
#   [... 1,204 lines omitted ...]
# and retrieve_offloaded_content(reference, line_range={"start": 1200, "end": 1260}) reads the gap.
```

**Progressive tool disclosure** — tune the catalog, or drop it entirely:

```python
ProgressiveToolDisclosure(
    catalog_tokens=None,               # search-only: ~200 tokens resident instead of ~63k
    ttl_cycles=10,
    always_available=["current_time"],  # high-frequency tools skip the discovery cycle
)
```

**Context graph** — the regression switch makes it safe to adopt and easy to debug:

```python
# expand_threshold=0.0 projects every Card at Full Content, so the call is byte-identical to
# the one produced without the plugin. Reach for it to tell a graph problem from a pre-existing one.
ContextStrategy(strategy="graph", expand_threshold=0.0)
```

**The full stack**, which is where the graph pays off — B knocks the schema down, and the graph then cuts what has become the largest remaining component, the history:

```python
strategy = ContextStrategy(strategy="graph")
agent = Agent(
    conversation_manager=NullConversationManager(),
    plugins=[
        ContextOffloader(storage=FileStorage("./artifacts"), preview_strategy="relevance"),
        strategy,
        ProgressiveToolDisclosure(referenced_source=strategy.referenced_tool_names),
    ],
)
```

**Errors and edge cases.** Every strategy degrades to today's behavior and logs once: a reranker failure falls back to the positional preview; an embedding failure sends the full history that turn; a `find_tools` miss returns guidance to rephrase. The graph pairs with `NullConversationManager` and warns (once, non-blocking) if a destructive manager is installed alongside it, because a manager that removes messages can drop what the graph only meant to fold.

## Consequences

**Easier:**
- Running a large-tool-suite agent over a long conversation without the schema and stale history dominating the bill.
- Auditing what a strategy did: each ships counters (resolution distribution, retrieval-cycle curve, search units, premature-call count) that answer whether it earns its cost.
- Extending the scorers: rerank, embedding, and tool-index are each behind a protocol with a network-free default, so a test never calls out and an alternative implementation is a drop-in.

**Harder / to watch:**
- **Provider prompt cache.** Changing the projected schema set or the folded history invalidates the provider's tool/prefix cache. The token saving must be weighed against cache loss on workloads with heavy tool alternation; `always_available` and stable ordering are the mitigations, and this is called out as needing measurement.
- **Auxiliary-call accounting.** The graph's embedding and relevance's rerank bill against separate models; a cost comparison that shows only agent tokens flatters exactly those two. Reporting must include the auxiliary bill.
- **Aggregation questions over decayed evidence.** If a tool result decayed to numeric-line fragments and the question needs the raw whole ("sum every transaction"), the answer can be wrong rather than merely poor. The mitigation is the reference in the Card Title plus `expand_artifact` by line range; automatic detection is out of scope and acknowledged.
- **Three constructs to keep in parity** with the TypeScript SDK's naming, per the cross-SDK rules.

## Willingness to Implement

Yes — the three plugins and the additive `referenced_source` parameter are implemented and under test in the Python SDK, pending this design's review and the PR sequence that references it.
