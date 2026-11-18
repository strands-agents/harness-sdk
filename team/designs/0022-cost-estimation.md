# Cost estimation

**Date**: 2026-11-18

**Issue**: [#1428](https://github.com/strands-agents/harness-sdk/issues/1428), [#1216](https://github.com/strands-agents/harness-sdk/issues/1216)

**Scope**: Python and TypeScript first. The design carries to Rust and Go.

## Overview

Users want to know roughly what a request cost in dollars. This proposal adds that in three steps:

1. **Every model call a request makes is counted in that request's usage.** Today the harness's own `subagent` and `web_fetch` tools are not. The harness moves to the SDK's versions of those tools, and its duplicates are deleted.
2. **Core reports token usage per model.** It is a fact about the request, like the totals it already reports. Core gets no prices.
3. **An opt-in plugin, `GenAIPricesCostEstimator`, turns that usage into a USD estimate.** It reads list prices from the `genai-prices` package, and the class name says so. It makes no network calls. You can supply your own prices.

The number is an estimate: tokens times list price. The API, the type names, and the docs all say "estimate". Strands does not ship, maintain, or vouch for a price table.

## Problem

You run an agent and want a dollar figure for the request. Today you read the token totals and multiply by prices you keep yourself. Three things make that hard:

- **Providers do not return prices.** Bedrock, Anthropic, OpenAI, and Gemini return token counts only. None of them returns a price or a cost in an API response.
- **A request often uses more than one model, and Strands only reports the sum.** Without the split by model, nobody can price the request correctly, with any price table.
- **In the harness, the sum is incomplete.** Subagent and web fetch tokens are missing from it.

### Current State

`result.invocation_context.usage` holds the token totals for one request. It covers the agent's own calls, agents used as tools, and the auxiliary calls the SDK makes for you (summarization, memory extraction, decision models). It does not say which model used which tokens.

Two gaps in what it counts:

- **The harness has its own copies of `subagent` and `web_fetch`**, in Python and TypeScript. The copies start their child agents outside the request. Their tokens appear nowhere in the parent's result, and token limits do not apply to them. The SDK's versions of both tools do join the request.
- **`Agent.structured_output()` runs outside any request**, so its tokens are not counted.

The harness is a mixed-model setup by default. Web fetch summarizes pages on a small model from the same provider family, for example Claude Haiku 4.5 next to Opus 5.5.

Here is what the missing split costs. Take a request where the main agent runs on Opus 5.5 and a subagent reads 40,000 tokens on Haiku 4.5:

| How it is priced | Estimate |
|---|---|
| Each model's tokens at that model's price | $0.183 |
| The request total at the main model's price | $0.326 |

The second row is the best anyone can do with the totals alone. It is 78% too high.

## Proposal

### Recommended: complete per-model usage in core, plus a genai-prices plugin

**Step 0: the harness uses the SDK's tools, and the duplicates are deleted.**

| Tool | What changes | Tracked in |
|---|---|---|
| `subagent` | The harness calls the SDK's `make_subagent`. Its own copy (about 800 lines per language) is deleted. | [#5276](https://github.com/strands-agents/harness-sdk/issues/5276), PR [#6088](https://github.com/strands-agents/harness-sdk/pull/6088) |
| `web_fetch` | The SDK's `make_web_fetch` gains a `transport="sandbox"` option, the one feature only the harness copy has. Then the harness calls it and deletes its copy. | [#5277](https://github.com/strands-agents/harness-sdk/issues/5277) |

The harness keeps only its policy: which small model summarizes for which provider, and the defaults it passes to the builders.

This step stands on its own. It removes the drift between the two copies, and it makes token limits cover harness subagents.

**Step 1: core reports usage per model.**

`InvocationContext` gains `usage_by_model`: one record per provider and model ID, each with the same `Usage` shape as today. The records add up to `usage`.

```python
result.invocation_context.usage_by_model
# [ModelUsage(provider_name="bedrock", model_id="global.anthropic.claude-opus-5-5", usage={...}),
#  ModelUsage(provider_name="bedrock", model_id="global.anthropic.claude-haiku-4-5-20251001-v1:0", usage={...})]
```

How it works:

- **Recording.** Model calls go through one internal wrapper that knows both the model and the request. It records each call's usage under that model. Two places record usage directly, decision models and the offload summarizer, and they pass their model the same way.
- **Provider name.** `Model` gains a `provider_name` property. It is an instance property, because one class can serve several vendors: `OpenAIModel` with a custom base URL, or the TypeScript `VercelModel`. A model that cannot tell returns `None`.
- **Vocabulary.** The names are the ones the harness already uses in model strings: `bedrock`, `anthropic`, `openai`, `google`, and so on. One table in `shared/` lists them.
- **Unknown stays visible.** Usage with no known model goes under a record with no provider and no model ID. It is never merged into another model.

This step is useful with no plugin. You can price a request with your own table, or see where your tokens went.

**Step 2: the plugin.**

`GenAIPricesCostEstimator` has one job: `cost.estimate(result)` returns the estimated cost of that request, in total and per model.

Where a price comes from, in order:

1. **Your own prices**, passed as `prices={...}`.
2. **genai-prices**, looked up by provider and model ID in the data bundled with the installed package.
3. **Neither**: the model is unpriced. Its cost is `None`, and so is the request total.

A missing price never becomes zero and never raises. `total_usd` is either complete or absent, so nobody reads a partial sum as the whole. Each model's record names the genai-prices entry its price came from, so you can see what was matched.

How the estimate is computed, per model:

```
cost = (uncached_input × input_price
      + cache_read     × cache_read_price
      + cache_write    × cache_write_price
      + output         × output_price) ÷ 1,000,000
```

Prices are USD per one million tokens, the unit providers publish. Two details:

- **Cached tokens are charged once.** Some providers count cached tokens inside `inputTokens` and some do not. The plugin uses the rule already documented on `Usage` to tell which.
- **Base rates only.** Some models charge more above a context size. A request total cannot say which calls crossed that line, so the plugin reads each model's base rate from genai-prices and does this arithmetic itself.

How prices stay current:

- **No network.** `estimate()` reads the data that ships inside the genai-prices package. It works in a VPC with no egress.
- **Freshness is the package version.** genai-prices releases about weekly. A model newer than the installed version is unpriced until you upgrade it.
- **An optional extra with a lower bound only**, for example `strands-agents[cost-estimation]`. You pick up new prices by upgrading genai-prices, without a Strands release.
- **Refresh is yours to turn on.** genai-prices has its own opt-in background updater in Python and JavaScript. The plugin uses whatever data the package currently holds.

What attaching the plugin to an agent does in this version: nothing yet. The estimate works on any result. It is a plugin so that a stream event or a spend limit can be added later without changing how you set it up.

**Step 3: one shared spec for every language.**

`shared/` already holds data that each SDK copies and tests against. Cost estimation adds:

- The provider names, and the genai-prices provider ID each one maps to.
- Test cases: a usage record, a price, and the expected USD. Every SDK runs the same cases.

genai-prices publishes Python, JavaScript, Go, and Rust packages from one data file, at the same version on the same day. A new Strands language in that set implements the formula and passes the shared cases.

**Pros:**

- Core stays free of prices. The new core surface is facts about token usage.
- The estimate is correct for mixed-model requests, including the default harness.
- No runtime call to a third party, and no fetch, cache, or refresh code for us to own. The prototype plugin is 193 lines.
- The third party is named in the class you import. The data is theirs, and the docs say so.
- The same data in every language at the same package version.
- The data already has one-hour cache write prices, service tier prices, and dated price changes, for when usage records carry those.

**Cons:**

- Prices are as recent as the installed package. A model released this week can be unpriced.
- genai-prices needs Python 3.11. Strands declares 3.10, so the plugin is unavailable there. Python 3.10 reached end of life in October 2026.
- One new dependency per language. Python adds `httpx2`. The JavaScript package has no dependencies and is 3.7 MB unpacked.
- The package is in beta (0.2.x), and the Rust crate was first published in October 2026.
- It covers fewer non-Anthropic models on Bedrock than models.dev (14 of 32 in our list, against 24), and it uses one price for all regional profiles.
- No package for the JVM, .NET, or Swift.
- `provider_name` on `Model` is a public, permanent addition. It needs an API review.
- The estimate ignores several things that change the real price (see "What the estimate leaves out").

### Alternative: models.dev over HTTP

The plugin fetches `https://models.dev/api.json` at runtime, caches it on disk, and refreshes it daily.

- **Pros:**
  - Fresh within hours, with no package upgrade.
  - More non-Anthropic Bedrock models, keyed by the exact IDs Strands users write.
  - No dependency and no Python floor.
- **Cons:**
  - A runtime call to a third-party host from an AWS-published SDK. It does not work without egress unless you host a mirror.
  - models.dev has no SLA, no terms of use, and no versioned schema.
  - We own a fetch, cache, and refresh client in each language. The prototype was 362 lines, and most of the defects found in testing were in that client.
  - `estimate()` gains a "prices still loading" state.

The price lookup is one function inside the plugin. A `ModelsDevCostEstimator` can be added next to this one later if freshness matters more than offline.

### Alternative: price the request total at the agent's model

The plugin reads `result.invocation_context.usage` and prices it at `agent.model`. No core change.

- **Pros:** Smallest possible change.
- **Cons:** Wrong whenever a request uses more than one model, which includes the default harness. The plugin cannot tell when it is wrong. The example above is 78% too high.

### Alternative: prices in `shared/model-info.json`, cost on `AgentResult`

Add a `pricing` section next to context windows, and a `cost` field on the result.

- **Pros:** No dependency and no plugin. The most discoverable API.
- **Cons:** We would own the prices. A model has one context window, but its price depends on provider, region, service tier, and date. Nova Pro input has five different prices across EU regions. LangChain and AutoGen both shipped in-repo price tables and both removed them. A `cost` field on the result reads as a promise.

### Alternative: emit cost events into the agent's stream

The plugin adds middleware and yields a cost event, either per model call or once at the end of the run.

- **Pros:** A UI or CLI gets the number pushed to it.
- **Cons:**
  - Per-call middleware belongs to one agent. It does not see subagents or auxiliary calls, so the sum is too low.
  - The only stage that wraps a whole run is internal in both SDKs. It ends before memory extraction and context management have run, and it runs once per pass, so a resumed run emits several growing totals.
- **Where this leaves it:** a follow-up, once there is a public end-of-request point. Until then a UI calls `estimate(result)` when the request returns.

## Developer Experience

Install the extra, then estimate a request:

```python
from strands import Agent
from strands.experimental.cost_estimator import GenAIPricesCostEstimator

cost = GenAIPricesCostEstimator()
agent = Agent(plugins=[cost])

result = agent("Compare the three proposals and recommend one.")
estimate = cost.estimate(result)

print(f"${estimate.total_usd:.4f}")
for model in estimate.models:
    print(model.model_id, model.cost_usd, model.price_source)

# Example output:
# $0.1831
# global.anthropic.claude-opus-5-5 0.1356 genai-prices:aws/global.anthropic.claude-opus-5-5
# global.anthropic.claude-haiku-4-5-20251001-v1:0 0.0475 genai-prices:aws/global.anthropic.claude-haiku-4-5-20251001-v1:0
```

Supply a price genai-prices does not have, or one you negotiated:

```python
from strands.experimental.cost_estimator import GenAIPricesCostEstimator, ModelPrice

cost = GenAIPricesCostEstimator(
    prices={
        "sagemaker/my-endpoint": ModelPrice(input_per_million=0.20, output_per_million=0.60),
    },
)
```

When a model has no price:

```python
estimate = cost.estimate(result)
estimate.total_usd                               # None
[model.model_id for model in estimate.unpriced]  # ["my-endpoint"]
```

Three rules to know:

- **An estimate covers the request so far.** If you continue a request by passing its `invocation_context` to a later call, the estimate grows. Do not add the two together.
- **Background work can add to it.** Memory extraction that finishes after the result returns shows up in a later `estimate(result)`.
- **It accepts any result.** Agent results, Graph and Swarm results, or an `invocation_context` directly.

TypeScript has the same shape (not prototyped yet). `estimate()` is synchronous in both languages.

```typescript
import { Agent } from '@strands-agents/sdk'
import { GenAIPricesCostEstimator } from '@strands-agents/sdk/experimental/cost-estimator'

const cost = new GenAIPricesCostEstimator()
const agent = new Agent({ plugins: [cost] })

const result = await agent.invoke('Compare the three proposals and recommend one.')
const estimate = cost.estimate(result)
console.log(estimate.totalUsd)
```

## What the estimate leaves out

Each of these makes the real bill differ from the estimate. The docs page lists them.

| Left out | Effect | What would close it |
|---|---|---|
| Models newer than the installed genai-prices | Unpriced | Upgrade genai-prices, turn on its updater, or pass your own price |
| Long-context price tiers | Calls above the tier (for example 272k tokens) are underpriced | Price each call instead of each model's total |
| Bedrock source region | Regional profiles get one price; real prices vary by region | Your own prices |
| Service tier, batch, provisioned throughput | Flex and batch are overpriced, priority is underpriced | Record the tier in usage; genai-prices has tier prices for some providers |
| One-hour cache writes | Priced at the five-minute rate, so underpriced | #5257 (cache writes split by TTL); genai-prices has the one-hour price |
| Negotiated discounts | Overpriced | Your own prices |
| Application inference profile ARNs | Unpriced | Your own prices |
| A model call that fails or is cancelled mid-stream | Tokens the provider billed are not counted | Record partial usage on failure |
| `Agent.structured_output()` | Runs outside any request, so not counted | Give it a request |
| Agents your own tools start without passing `invocation_context` | Not counted | Pass it |
| Tool, knowledge base, and other non-model costs | Not counted | Out of scope |
| Realtime (bidirectional) audio | Not counted | Out of scope for now |

For the billed cost on Bedrock, the docs point to application inference profiles with cost allocation tags.

## Rollout

0. **Harness on SDK tools:** switch `subagent` (#6088); add the sandbox transport to the SDK's `web_fetch` and switch the harness (#5277). Python and TypeScript.
1. **Core:** `usage_by_model` and `provider_name`, after API review.
2. **Plugin:** `GenAIPricesCostEstimator` in `strands.experimental`, with the shared spec in `shared/`.
3. **Docs:** one page with the usage above, the "leaves out" table, and the pointer to billed cost.

Steps 0 and 1 do not depend on each other. Until step 0 lands, a harness request's estimate misses its subagent and web fetch tokens, and the docs page says so.

Not in this proposal: a stream event, a dollar limit, an OpenTelemetry cost attribute (the convention is still an open proposal), and a session-wide running total.

## Open questions

1. **Python 3.11 for this feature.** Acceptable while Strands itself supports 3.10?
2. **`provider_name` on `Model`.** Is the public property acceptable, and are the harness's names the right vocabulary? The other candidates are the Python module names and the OpenTelemetry provider names.
3. **Unpriced models.** `total_usd` is `None` when any model has no price. The alternative is a partial total plus a flag.
4. **No stream event in the first version.** Acceptable, given that attaching the plugin then does nothing yet?
5. **Provider-reported cost.** Gateways such as LiteLLM and OpenRouter return a cost with the response. [#3212](https://github.com/strands-agents/harness-sdk/pull/3212) adds LiteLLM's to `AgentResult`. Should it instead become an optional field on `Usage` that the plugin prefers over any table?
6. **Where your own prices live.** On the plugin, as proposed, or as a `model_info` override next to context windows? The model metadata design ([#5305](https://github.com/strands-agents/harness-sdk/pull/5305)) lists `pricing` as a possible later section.

## Additional Details

<details>
<summary>Prototype: what was built and what it showed</summary>

The prototype is a branch off `main` at `d2c9f9840`. The code is linked from the pull request that added this document.

- **Core change** (`core.patch`): `agent/invocation_context.py`, `event_loop/streaming.py`, `models/_model_proxy.py`. 64 lines added, 8 removed. The routing, limits, event loop, and model proxy unit tests pass (332 tests).
- **Plugin** (`plugin.py`): one file, 193 lines. It lives under `vended_plugins` in the prototype.
- **models.dev variant** (`models_dev_estimator.py`): the earlier plugin with the fetch, disk cache, and refresh, 362 lines. Kept for comparison.

Runs with `GenAIPricesCostEstimator` (`demo.py`, network blocked):

| Run | Result |
|---|---|
| Scripted models: Opus 5.5 main agent, Haiku 4.5 subagent, cache reads and writes | Opus $0.1356, Haiku $0.0475, total $0.1831. The models.dev variant gives the same figures. First `estimate()` took 20 ms, later ones 0.2 ms. |
| Subagent on a model genai-prices does not list | That model unpriced, `total_usd` is `None` |
| Same, with a user price | Priced, source `user` |
| Subagent on a tiered model (`gpt-6-luna`) | Priced at the base rate |
| Live Bedrock: Haiku 4.5 main agent, Nova Lite subagent | Both priced, total $0.0021 |

The package's own opt-in updater ran alongside the plugin without error.

Confirmed by independent testing of the first prototype:

- The formula is exact for both cache conventions. Bedrock and Anthropic exclude cached tokens from `inputTokens`; OpenAI, Gemini, LiteLLM, and llama.cpp include them. It holds as long as one provider and model ID keeps one convention.
- The per-model records add up to the request totals at every level: shared requests, child requests with their own limits, routers, summarization, and memory extraction.
- A model router is attributed to the model it routed to. Retried responses that were discarded are counted, since they were billed.
- The harness `web_fetch` gap is real: a summarizer run of 41,500 Haiku tokens did not appear in the parent's usage.

Still open in the prototype:

- Step 0 is not part of the prototype. Decision model and offload summarizer usage still land in the unknown-model record.
- `provider_name` is derived from the class's module. The real change is a property on `Model`.
- `bedrock-mantle`, and LiteLLM IDs beyond a plain `provider/model`, are not mapped to genai-prices provider IDs yet.
- The model ID is read when the call ends. A model reconfigured mid-call is attributed to the new ID.
- No TypeScript prototype. Base-rate access was checked in the Python package and seen in the JavaScript types, not checked in Rust or Go. Not tested live against OpenAI, Anthropic, or Gemini directly.

</details>

<details>
<summary>genai-prices: what it is and what was measured</summary>

- **Packages:** PyPI `genai-prices`, npm `@pydantic/genai-prices`, crates.io `genai-prices`, and a Go module. All four were at 0.2.4, released 2026-11-17. MIT license.
- **History:** Python since July 2025 (79 releases). The Rust crate since 2026-10-21.
- **Dependencies:** Python needs 3.11 and adds `httpx2` and `pydantic`. JavaScript has none (Node 20 or later). Rust adds `fancy-regex`, `serde`, and `serde_json`.
- **Network:** none by default in any language. Python and JavaScript have an opt-in updater. Rust and Go take a data file you download yourself.
- **Matching:** by rule, not exact key. It needs the provider ID, which `provider_name` supplies. A full inference profile ARN matches; an application inference profile ARN does not.

</details>

<details>
<summary>Coverage test against our own model list</summary>

222 provider and model ID combinations generated from the 134 entries in `shared/model-info.json`, written the way Strands users write them. Some generated Bedrock IDs do not exist, and genai-prices matches by rule, so the counts are indicative.

| | genai-prices | models.dev |
|---|---|---|
| Combinations priced | 172 | 144 (131 exact, the rest after removing version and date suffixes) |
| Non-Anthropic models on Bedrock, base IDs | 14 of 32 | 24 of 32 |
| Older Claude models | present | mostly missing |
| Inference profile ARN | matches | matches after taking the last segment |
| Application inference profile ARN | no match | no match |
| Agreement where both had a price | 122 of 123 | |

The one disagreement is the `mistral-large-latest` alias.

</details>

<details>
<summary>Related work in this repository</summary>

- **Usage by source** ([#3863](https://github.com/strands-agents/harness-sdk/issues/3863), [#4005](https://github.com/strands-agents/harness-sdk/pull/4005)): splits usage by which feature made the call (summarization, routing, memory). This proposal splits by which model answered. The two are independent and can share the recording point.
- **One token convention** ([#4618](https://github.com/strands-agents/harness-sdk/issues/4618)): once every provider reports cached tokens the same way, the plugin's convention check goes away.
- **Cache writes split by TTL** ([#5257](https://github.com/strands-agents/harness-sdk/issues/5257)): needed before one-hour cache writes can be priced correctly.
- **Model metadata** ([#5305](https://github.com/strands-agents/harness-sdk/pull/5305)): `provider_name` belongs with the facts a model reports about itself.

</details>

<details>
<summary>What other SDKs and harnesses do</summary>

- **Compute cost in the SDK:** Pydantic AI (genai-prices), Mastra (models.dev snapshot), DSPy and LiteLLM (LiteLLM's JSON). All of them compute it as a layer over usage, none inside the model class.
- **Tokens only:** OpenAI Agents SDK, LangChain core, LlamaIndex, CrewAI, AutoGen 0.4, Semantic Kernel. Google ADK declined the feature in writing because prices drift.
- **Removed their own tables:** LangChain community, AutoGen 0.2.
- **Coding harnesses on models.dev:** opencode, Goose, pi, Cline. On LiteLLM's JSON: Aider, OpenHands, SWE-agent.
- **Shared behavior:** a price from the provider or the user wins over a catalog; an unknown price is `None`, not zero; every project calls the number an estimate. Claude's docs say not to bill end users from it.
- **Observability backends** (Langfuse, LangSmith, Phoenix, Datadog) price spans from the model ID and tokens Strands already emits. OpenTelemetry has no released cost attribute.

</details>
