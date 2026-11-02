# Cache friendly/Cost reducing Tool management

**Date**: 2026-10-15

**Issue**: [#263](https://github.com/strands-agents/harness-sdk/issues/263), [#1677](https://github.com/strands-agents/harness-sdk/issues/1677), [#1680](https://github.com/strands-agents/harness-sdk/issues/1680)

**Scope**: Both Python & TypeScript

## Problem

The tool selection issues are created months back ago, We had a review session on where this feature would live and its scope. To read full doc: [#4008](https://github.com/strands-agents/harness-sdk/pull/4008)

The conclusion is that toolSpec should be treated to be part of context, and should be under context manager. The scope is limited to `Only select` + `Ways/Strategies of select` as P0 as feasible fast deliver target. To read full code: [#4921](https://github.com/strands-agents/harness-sdk/pull/4921)

Tool selection under existing design is helpful under the condition that we trim 120~ tools to 20~ with short history (see Appendix A), it helps reduce the raw token but it doesn't guarantee cost reduce in less/60~ tools scenarios because of prompt caching.

Models become more advanced and they have more native features, Claude established preserved thinking (Claude Fable 5.1 and newer, enforced by default for accounts created since Aug 31st) + inline tools (beta, Sept 15th), OpenAI also has native tool selection in their APIs on some newer models. That said, the feature scope is widely larger for context management and our focus shifted to cost saving for broader use cases.

To help our customers achieve real cost reduction, we need to find a more sophisticated way on adding/removing tools + keeping tool specs lightweight and consistent.

## Goal

Cost saving -- Find a way to make tool management caching-friendly, and save cost on advanced models.

## Prior Art:

### How Anthropic approach this:
Claude model start supporting tool_addition  and tool_removal without breaking prompt caching. A tool can be added by reference (declared up front, usually with defer_loading: true) or by value (full definition, Claude API only).  To read [more](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages#define-tools-in-a-message-beta)

### How OpenAI approach this:
OpenAI model use tool_search as their answer, also developer would add additional_tools to include extra tools, also should be loaded at the end of the model’s context window for caching. To read [more](https://developers.openai.com/api/docs/guides/tools-tool-search)

- OpenAI Tool choice:
This parameter enable specific tool call ability for OpenAI models, like pinned tools we introduced.

### How Gemini approach this:

No direct answer. Models don't support, just mention limit 10-20 tools. To read [more](https://ai.google.dev/gemini-api/docs/function-calling#python_10)

### Bedrock converse other models:
Nothing native. 

## Proposal

From responsibility perspective, the agent owns the facts, the context manager owns the decision, and the model provider owns the delivery. 

Also, another 4 things:

- Catalog. Which tools exist and what their specs are.
- Availability. Which tools are offered to the model at each point in the conversation.
- Policy. What should be available next: relevance, budget, pins, user overrides.
- Delivery. How that availability reaches a specific provider's wire format without breaking its cache.

### Who owns what

- Catalog : Agent, tool registry.
- Availability : Agent conversation, aka state.
- Policy: Context manager.
- Delivery: Model providers.

### Baseline

Given those scope and definition, to achieve cache-friendly and cheaper, there are two baseline we need to follow:

- The catalog is fixed per conversation. Once tools are declared, they stay declared. Changes are appended, never replaced.
- Native model support first. When the provider supports it, don't change the tools list to control which tools the model sees. Use the provider's deferred loading, mostly add tools, and rarely remove them.

### Solution

Every tool is declared once, and the tools list never changes. Changes to what the model can use are appended to the messages as a provider-neutral block, and each provider renders that block in its own wire format.

**Adding a tool.** The neutral block is `ToolReferenceBlock`. Claude renders it as `tool_reference`, OpenAI as hosted tool search output, and Claude on Bedrock Converse as the schema in text (see How it fits each provider, below).

**Who decides to add a tool.** In this design, the model decides. It calls `load_tools` (or the provider's tool search) when it wants a tool, so the block arrives in a tool result. Later, a context manager policy such as Hide's relevance ranking can add the same tools without the model asking. On Claude that renders as `tool_addition` in a `role: "system"` message, and on OpenAI as an `additional_tools` item with `role: "developer"`. That's a follow-up, for two reasons:

- The SDK's `Role` is `"user" | "assistant"`, so it can't send either message today. Claude's form is also beta (`inline-tools-2026-09-15`).
- It needs a policy to pick tools. With the model deciding, this design works without one.

The follow-up reuses this design's plan and `ToolReferenceBlock`. With it, a tool registered after the first call (an MCP refresh) can be added by value on Claude instead of changing the tools list.

**Removing a tool.** Not in this design, because removal saves no cost. A deferred tool costs only its name and description until it's loaded. Once it's loaded, its schema is part of the cached prefix. On OpenAI, removing a loaded tool breaks the cache. Claude's `tool_removal` keeps the cache, so it fits a later policy feature such as permissions.

**What owns hiding and revealing.** The plan, described below, and not the tool registry. The registry stays the full catalog. A `registry.hide()` or `reveal()` would change the tools list and break the cache.

**Providers without native support.** We don't update the tools list and drop the message, because changing the tools list invalidates the tools, system, and message caches (Appendix B). Where the model can take a stub (Claude on Bedrock Converse), the tools list keeps the stub and the schema is appended as text, so the request only grows at the end. Every other model gets every spec, as today.

### Recommended: defer tool schemas and load them on demand

A tool has three parts: name, description, and input schema. The model needs the name and description to pick a tool, and only needs the schema when it calls one. The schema is also the biggest part: 64% of spec tokens across our Python vended tools, 85% for `file_editor`. Anthropic calls detailed descriptions "by far the most important factor in tool performance" ([implement tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use)), and OpenAI's deferred functions keep the name and description and defer only the schema ([tool search](https://developers.openai.com/api/docs/guides/tools-tool-search)).

On the first model call of a conversation, the context manager makes a plan:

- Pinned: full spec, always sent. User pins, SDK-protected tools (structured output, background tasks), and the loader (`load_tools`, or the provider's search tool).
- Deferred: name and description sent. The schema loads when the model asks for it.
- Loaded: deferred tools whose schema is already loaded. Loads are appended to the messages.

The plan is made once per conversation and saved with the session, so later calls and restored sessions send a byte-identical tools list.

Loading goes through `load_tools`, an ordinary SDK-protected tool. The model calls it with one or more tool names, and the normal tool loop appends its result like any other tool result. Middleware never adds or edits messages. It only renders the per-call tools list from the plan.

**How it fits each provider:**

| Provider | Tools list (fixed) | How the model gets a schema | Status |
|---|---|---|---|
| Claude API, Claude 4.5 and later | Pinned tools, `load_tools`, and every deferred tool with `defer_loading: true` | `load_tools` returns `tool_reference` blocks, and the API expands them | Native, untested |
| OpenAI Responses, gpt-5.4 and later | Pinned tools, `{ type: 'tool_search' }`, and every deferred function with `defer_loading: true` | Hosted tool search; the API returns `tool_search_output` | Native, untested |
| Claude 4.5 and later on Bedrock Converse, `strictTools` off | Pinned tools, `load_tools`, and one stub per deferred tool: real name, full description, schema `{ "type": "object" }` | `load_tools` returns the schema as text | Built by us, prototyped on Haiku 4.5 |
| Everyone else | Every spec, no change | n/a | No change |

- Claude API: deferred tools are hidden from the model, so the `load_tools` description lists each deferred tool's name and description.
- OpenAI Responses: the model sees deferred functions' names and descriptions natively.
- Bedrock Converse has no native deferral, so we send stubs. Bedrock doesn't enforce an open schema, so a stub call always matches. An `ExecuteToolStage` guard answers a call to a stub whose schema isn't loaded yet with the schema, instead of running the tool.

We only do this on models that can take a deferred schema. Models with constrained decoding or strict mode can't, because they only follow the schema declared in the tools list. We don't keep a new model list. It's one rule per provider: Claude 4.5 and later, and OpenAI Responses gpt-5.4 and later. Strict mode turns it off. Every other model gets every spec, the same as today. Supporting another model is a change to that provider's rule.

Claude on Bedrock InvokeModel is out of scope: its native tool search is beta and InvokeModel-only, and `BedrockModel` uses Converse.

Each provider reports which path its model takes (`'native'`, `'stubs'`, or `'none'`). It's internal to the provider, not a user setting: adding the strategy is the user's switch.

To keep the cache valid:

- The tools list and the system prompt never change during a conversation.
- Every change is appended as a message. Earlier messages are never edited.
- The loader is never deferred. Claude needs at least one non-deferred tool.

**Pros:**

- Tools, system, and message caches stay valid on every call, and preserved thinking stays valid.
- The model picks from real names and full descriptions, not summaries.
- Works beyond native providers: Claude on Bedrock Converse, the SDK's default path, gets it too.
- Models that can't defer don't change, so there's no regression risk there.
- On Converse with Claude Haiku 4.5, stubs cut cost by 55–84% against sending every spec (Appendix C). That test also deferred descriptions, so the proposed shape saves less. Anthropic reports about 85% fewer tokens with tool search.

**Cons:**

- Each load call costs one round trip. The model can load several tools in one call, but in our test 4 requests still took 11 model calls instead of 8.
- Savings depend on how much of a tool is schema: at 120 tools, an estimated −58% when the schema is 65% of the spec, and −16% when descriptions dominate.
- On the stub path the provider doesn't enforce the schema. Typed tools validate their input in the SDK; raw JSON-schema tools rely on the model following the loaded schema.
- Only Claude Haiku 4.5 on Converse is tested so far. Other models get no savings until their provider's rule includes them.
- Small catalogs gain nothing, so the preset starts at 20 tools.
- Tools registered after the first call (an MCP refresh, a tool added at runtime) change the tools list. That misses the cache, and on Claude Fable 5.1 and newer it also invalidates preserved thinking. The policy-driven follow-up fixes this on Claude by adding the tool by value (see Solution).
- A model switch mid-conversation keeps the first model's plan. If the new model takes a different path, the strategy has to fall back to sending every spec.

### Alternative: tool selection alone for cost

Replace the tools list per call and rely on the smaller list for savings. Selection still has its own role (see How Hide fits).

- **Pros:** works on every model.
- **Cons:** with caching on, cost ranged from −35% to +37% in our test (Appendix C).

### Alternative: summary stubs that keep the schema

- **Pros:** work on every model.
- **Cons:** save only about 17% on realistic catalogs (Appendix C), and they cut the description.

### Alternative: defer on every model

- **Pros:** one behavior everywhere.
- **Cons:** little to gain on cheap models, and models with constrained decoding can't take an open stub schema.

### Alternative: gateway meta-tools

Fixed `search_tools` and `execute_tool` tools in front of the catalog.

- **Pros:** the tools list never changes.
- **Cons:** hooks, telemetry, and permissions see `execute_tool` instead of the real tool.

### How Hide fits

Hide (#4921) and this design look at tools from different angles. Hide is tool selection: which tools are relevant for this turn. This design is tool delivery: how much of each tool we send, without breaking the cache. They don't replace each other. Once delivery is in place, Hide's selection has a cache-friendly path:

| Model | Hide's selection goes through |
|---|---|
| Doesn't defer, no prompt caching | Replacing the tools list, as Hide does today. With no cache, there's nothing to break |
| Deferral available | The search behind `load_tools`: the model asks with a query and Hide ranks the matches (follow-up). This matters for very large catalogs, where even names and descriptions get big |
| Policy-driven adds available (follow-up, see Solution) | Appended `tool_addition`/`tool_removal` on Claude, `additional_tools` on OpenAI |

OpenAI's `allowed_tools` can also limit which declared tools the model calls without changing the tools list, but it saves no tokens.

Hide's ranking, pins, and protected tools stay the same. Only how its selection reaches the model changes, and this strategy reuses Hide's protected tool set. If both are configured, Hide skips its tools-list rewrite while the plan is active.

## Developer Experience

The strategy is a new `toolSpecs` target on `Offload.drop`. Dropping a tool spec drops its input schema; the name and description stay, and `load_tools` brings the schema back. Tool names in a target use the `toolspec::` prefix.

```ts
import { Agent, BedrockModel, Offload } from '@strands-agents/sdk'

const agent = new Agent({
  model: new BedrockModel({ modelId: 'global.anthropic.claude-sonnet-4-6' }),
  tools,
  contextManager: {
    strategies: [
      'dynamicToolLoading',                       // drops every tool spec, from 20 tools
      // or Offload.drop('toolSpecs')             // every tool spec, any count
      // or Offload.drop(['!toolspec::shell'])    // every tool spec except shell's
      // or Offload.drop(['toolspec::github_create_pr'])  // only this tool spec

      // Passing strategies replaces the default ones, so list any others you want
      'largeToolOffloading',
    ],
  },
})
```

```python
from strands import Agent
from strands.experimental.context_manager import Offload
from strands.models import BedrockModel

agent = Agent(
    model=BedrockModel(model_id="global.anthropic.claude-sonnet-4-6"),
    tools=tools,
    context_manager={
        "strategies": [
            "dynamic_tool_loading",
            # or Offload.drop("tool_specs")
            # or Offload.drop(["!toolspec::shell"])
            "large_tool_offloading",
        ],
    },
)
```

- The decision is made once, on the first call, so the tools list never changes mid-conversation. Offload's `.when()` conditions don't apply to `toolSpecs`.
- The 20-tool minimum is only in the preset. OpenAI recommends fewer than 20 functions ([function calling](https://developers.openai.com/api/docs/guides/function-calling)), Gemini 10–20 ([function calling](https://ai.google.dev/gemini-api/docs/function-calling)), and Anthropic suggests tool search from 10+ tools or 10K tokens of definitions ([advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)).
- On a model that can't defer, or under strict mode, every spec is sent and the strategy logs a warning once.
- SDK-protected tools are always pinned. Asking to drop one logs a warning.
- The preset stays opt-in until we test more Claude models and real catalogs.

Before the strategy ships, users can use the native paths directly by marking tools themselves:

```ts
import { Agent, tool } from '@strands-agents/sdk'
import { AnthropicModel } from '@strands-agents/sdk/models/anthropic'

const createPr = tool({ name: 'github_create_pr', description, inputSchema, callback, deferLoading: true })

const agent = new Agent({
  model: new AnthropicModel({
    modelId: 'claude-sonnet-4-6',
    anthropicTools: [{ type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' }],
  }),
  tools: [createPr, ...otherTools],
})
```

## Interface Sketch

<details>
<summary>Strategy and provider sketch</summary>

Names may change in implementation.

```ts
// Offload.drop('toolSpecs'): middleware registered from init(). For toolSpecs, apply() returns false, so messages are untouched.
class DropStrategy implements ContextStrategy {
  init(agent) {
    if (!targetsToolSpecs(this.target)) return                // message targets behave as today
    agent.addMiddleware(InvokeModelStage.Input, (ctx) => this.renderToolSpecs(ctx))
    agent.addMiddleware(ExecuteToolStage, (ctx, next) => this.guard(ctx, next))
  }

  getTools() {
    return [loadTools]                                        // protected, never dropped
  }

  // Only the per-call tools list changes
  renderToolSpecs(ctx) {
    const plan = this.getOrCreatePlan(ctx)
    if (plan.delivery === 'none') return withoutLoader(ctx)
    const toolSpecs = ctx.toolSpecs.map((spec) => {
      if (!plan.deferred.includes(spec.name)) return spec
      return { ...spec, deferLoading: true }                  // each provider renders it
    })
    return { ...ctx, toolSpecs }
  }

  // First call only; restored sessions read the saved plan
  getOrCreatePlan(ctx) {
    const saved = ctx.agent.appState.get(PLAN_KEY)
    if (saved) return saved
    const candidates = ctx.toolSpecs.filter((spec) => this.matches(spec) && !isProtected(spec))
    const delivery = ctx.model.deferredTools                 // @internal: 'native' | 'stubs' | 'none'
    if (delivery === 'none') warnOnce('model can not defer tool schemas, sending every spec')
    const active = delivery !== 'none' && candidates.length >= this.minTools  // 20 in the preset, 0 otherwise
    const plan = active ? newPlan(candidates, delivery) : INACTIVE_PLAN
    ctx.agent.appState.set(PLAN_KEY, plan)
    return plan
  }

  // Stubs only. Loaded tools are read from the messages, so a load that summarization removed is delivered again.
  async *guard(ctx, next) {
    const plan = ctx.agent.appState.get(PLAN_KEY)
    const name = ctx.toolUse.name
    if (plan?.delivery !== 'stubs' || !plan.deferred.includes(name) || loadedIn(ctx.agent.messages).has(name)) {
      return yield* next(ctx)
    }
    return { result: errorResult(ctx.toolUse, `Not run. Call again with this schema: ${schemaText(ctx.tool)}`) }
  }
}

// Returns references; each provider renders them its own way
function loadTools({ names }, agent) {
  const plan = agent.appState.get(PLAN_KEY)
  return names.map((name) =>
    plan.deferred.includes(name)
      ? new ToolReferenceBlock({ name, definition: agent.toolRegistry.get(name).toolSpec })
      : new TextBlock(`${name} is not a deferred tool`))
}
```

Providers:

```ts
// models/anthropic.ts: 'native' on Claude 4.5 and later
deferred spec       -> { ...spec, defer_loading: true }
load_tools spec     -> description lists each deferred tool's name and description
ToolReferenceBlock  -> { type: 'tool_reference', tool_name: name }

// models/openai/responses-adapter.ts: 'native' on gpt-5.4 and later
deferred spec       -> { type: 'function', ...spec, defer_loading: true }
load_tools spec     -> { type: 'tool_search' }                // hosted, the API loads the schema

// models/bedrock.ts: 'stubs' on Claude 4.5 and later with strictTools off
deferred spec       -> { name, description: `${description} Call load_tools with this name for its parameters first.`,
                         inputSchema: { json: { type: 'object' } } }
ToolReferenceBlock  -> text: `${name} parameters: ${JSON.stringify(definition.inputSchema)}`

// every other provider and model: 'none'
```

</details>

## Willingness to Implement

Yes.

## Additional Details

<details>
<summary>Appendix A: Local benchmark, replacing the tools list</summary>

Replacing the tools list per call (`Hide.drop`), from [`prototypes/0018-tool-selection`](https://github.com/JackYPCOnline/harness-sdk/tree/prototypes/0018-tool-selection-benchmark/prototypes/0018-tool-selection). Claude Haiku 4.5 on Bedrock, 1-hour cache, 60 and 120 synthetic tools, 24 tools kept per call, 4 tasks per cell. Both arms were correct on 16/16.

| Catalog / history | Prompt tokens Δ | Normalized cost Δ |
|---|---:|---:|
| 60 tools / short | −57.2% | +3.3% |
| 60 tools / +16k words | −39.6% | +45.0% |
| 120 tools / short | −78.0% | −46.2% |
| 120 tools / +16k words | −67.1% | −20.5% |

Fewer tokens, but every change to the selected set rewrote the tools and the conversation prefix with zero cache reads.

</details>

<details>
<summary>Appendix B: Prompt caching best practice</summary>

Claude caches in the order tools → system → messages. A change invalidates its level and every level after it ([what invalidates the cache](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#what-invalidates-the-cache)).

| Change | Tools cache | System cache | Messages cache |
|---|---|---|---|
| Tool definitions (names, descriptions, parameters) | ✘ | ✘ | ✘ |
| Web search or citations toggle, speed setting | ✓ | ✘ | ✘ |
| `tool_choice` | ✓ | ✓ | ✘ |
| Images added or removed anywhere | ✓ | ✓ | ✘ |
| Thinking parameters, effort | Model-specific | Model-specific | ✘ |

OpenAI and Bedrock work the same way: changing tool names, descriptions, schemas, or order breaks reuse.

</details>

<details>
<summary>Appendix C: Local experiment, stubs on Bedrock Converse</summary>

Source: [`prototypes/0021-tool-skeleton`](https://github.com/JackYPCOnline/harness-sdk/tree/prototypes/0021-tool-skeleton/prototypes/0021-tool-skeleton), with the raw results and reproduction commands.

Setup:

- Python middleware: the plan on `InvokeModelStage.Input`, saved in `agent.state`, plus `load_tools` and the `ExecuteToolStage` guard.
- Claude Haiku 4.5 on Bedrock Converse, `us-west-2`, with a 1-hour cache.
- The Appendix A catalog (60 and 120 tools) with realistic schemas: nested objects, enums, booleans, arrays. No context manager.
- Every executed call was checked against the real schema and the expected values.

Two stub shapes. Neither is exactly the proposed one:

- Open-schema stubs: open schema, and the description is only a pointer. Names and first sentences are listed in `load_tools`. This is the proposed shape with the description deferred too.
- Summary stubs: the first sentence of the description, real schema kept. Rejected.

Cost on Haiku 4.5 (normalized: input 1×, cache read 0.1×, cache write 2×, output 5×; Δ against every spec):

| Catalog / history | Every spec | Replace per call | Open-schema stubs | Summary stubs |
|---|---:|---:|---:|---:|
| 60 tools / short | 123.5k | +0.7% | −78.4% | −68.0% |
| 60 tools / +16k words | 170.2k | +37.3% | −55.1% | −51.1% |
| 120 tools / short | 241.4k | −34.9% | −84.3% | −69.7% |
| 120 tools / +16k words | 289.8k | +2.9% | −69.7% | −59.7% |

Every arm called the right tool with correct arguments on all 21 tasks (16 cost tasks plus 5 accuracy tasks).

- With stubs, the tools list never changed and no earlier message was edited. Every call after the first write read tools, system, and history from cache.
- Open-schema stubs took 11 model calls per cell instead of 8: three loads, and a loaded tool was reused without reloading. The guard never fired; Claude always loaded first.
- Session restore kept the plan. The first request after restoring had the same tools list and system prompt and read 9,549 tokens from cache.
- In a separate run with the `auto` context manager, the first call was sized from the full registry. At 120 tools and +16k words it summarized before the first call in every arm, including the stub arms.

How much of a spec is schema: 64% across our Python vended tools (`file_editor` 85%, `http_request` 82%). The test catalog is only 17%, because its descriptions are padded. Estimated tools section for the proposed shape at 120 tools, which we didn't run as its own arm:

| Test catalog | Schema share | Every spec | Proposed shape | Change |
|---|---:|---:|---:|---:|
| No padding | 65% | ~25.4K | ~10.8K | −58% |
| 3 repeats | 38% | ~42.3K | ~27.7K | −35% |
| 12 repeats (measured) | 17% | ~93.1K | ~78.4K | −16% |

On the unpadded catalog, summary stubs come to about 21.1K (−17%), because they keep the schema.

Limitations: one run per cell, one model, Converse only, synthetic descriptions, and prompts that state the argument values. Total cost was about $6 at Haiku list prices.

</details>
