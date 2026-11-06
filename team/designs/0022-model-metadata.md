# Model Metadata and Capabilities

**Date**: 2026-10-21

**Issue**: [#780](https://github.com/strands-agents/harness-sdk/issues/780)

**Scope**: Both Python & TypeScript. The harness is the first consumer outside the SDK.

**Status**: Proposed. This is an initial proposal; we expect to iterate on the shape.

**Related**: [#5190](https://github.com/strands-agents/harness-sdk/pull/5190) is the closest in-flight PR. It lands as-is; its per-process rejection cache becomes the first caller of `_record_learned_metadata()`, and the structured output retry then reads `forced_tool_choice` and `native_structured_output` from the record instead. [#4667](https://github.com/strands-agents/harness-sdk/pull/4667) introduced `ModelProxy`, the SDK-internal wrapper every model call goes through; see *Where it lives* below.

## Overview

We propose adding a `metadata` object to every `Model`. It holds what the SDK knows about the model behind a provider: its capabilities (can it be forced to call a tool, does it reason, does it cache), its limits (context window, output ceiling), and later its pricing. Providers fill it in, the SDK learns more from provider rejections at runtime, and users can override it. The agent loop, the context manager, the router and the harness read it instead of guessing from model id strings.

## Problem

The SDK already answers questions about models. It answers them in a messy way. Bedrock's provider has five hard-coded lists of model id substrings. The harness has its own tables of effort levels and token ceilings, copied by hand between Python and TypeScript. One feature learns what a model rejects and remembers it in a module-global set; two open PRs each add their own version of that cache. Support for OpenAI's built-in tools is documented in a docstring that no code can read.

The result is that the same question gets answered several times in several styles, and new model ids silently lose features:

- Opus 5.5 rejects forced tool choice. Structured output crashed with a raw 400 because nothing knew that (#5156). Three PRs now compete to fix it, each with its own rejection cache (#4738, #5172, #5190).
- A dot in `openai.gpt-6.1-sol` broke a prefix match, and the harness dropped `web_search=True` without a warning (#5187).
- GPT-6 Sol and Luna got zero reasoning effort levels because the table only knew Astra (#5174, #5191).
- Models that bind reasoning to history reject edits. The context manager, session restore and the structured output retry each discover this separately, with a 400 (#5171, #4933).
- Server-side compaction has two competing shapes in flight: a property (#4752) and a config flag (#5173).

Appendix A (under Additional Details) lists all thirteen questions we keep answering ad hoc, who asks them, and where we hacked each one.

Two facts shape any fix. First, most answers are unknown for most model ids. Registries are incomplete, Bedrock's API exposes none of this (we checked: `ListFoundationModels` returns modalities, streaming support and lifecycle, nothing about tools or reasoning), and new ids ship weekly. Second, some answers only come from asking: the provider rejects the request, and that rejection is the only source. So the design has to represent "unknown", has to learn, and has to never switch a feature off just because it does not know.

## Proposal

We add `Model.metadata`, a frozen record with three sections: `capabilities`, `limits` and `pricing`. Every field can be unknown.

**Where the answers come from.** Four sources, in order of precedence:

1. The provider declares what its wire API can carry at all. Ollama cannot force a tool. Bedrock Converse cannot take a `system` message mid-conversation.
2. The provider declares what it knows about this model id, from the tables we already have. Fetching this from a provider's metadata API (Anthropic's `GET /v1/models`, Ollama's `/api/show`) can come later and is out of scope here.
3. The provider records what a rejection taught it. Bedrock says forced tool choice is not supported for this model; the SDK remembers that for the rest of the process.
4. The user overrides anything, through a `metadata` key in the model config. A gateway strips `tool_choice`; a new id is not in any table; a table is wrong.

**How the SDK behaves based on it.** One rule everywhere: a known "unsupported" disables the feature; unknown means try. The SDK never withholds a feature because it does not know. When a feature is known unsupported, the SDK skips it: with a warning if the SDK inferred the request, with an error if the user asked for it explicitly. When the provider rejects something unknown, the SDK records the answer and tries the next option.

Concretely:

- The structured output retry reads `forced_tool_choice` and `native_structured_output` to pick a mechanism, instead of each provider keeping its own cache (#5190).
- The context manager reads `reasoning.history_bound` to send `drop_block` proactively and keep the tool list stable, instead of waiting for a 400 (#5171).
- The context manager reads `server_compaction` to delegate compaction to the server, replacing both #4752 and #5173.
- The agent reads `mid_conversation_system_messages` and raises a clear error instead of letting the provider 400 (#5176).
- The harness reads `reasoning.effort_levels`, `server_tools`, `prompt_caching` and `limits` and deletes its own tables.
- The router can check that candidates agree on `forced_tool_choice`, `input_modalities` and `reasoning.history_bound` before mixing them.

Hard-coded tables shrink to the cases where the provider fails silently (Nova hallucinates on JSON tool results, cache points are a no-op on models that do not cache). Where the provider rejects loudly, the table stays silent and the rejection teaches us. One failed request is cheaper than a stale row.

**Where it lives.** `ModelProxy` (#4667, TypeScript today) is the SDK-internal wrapper that the agent loop and every auxiliary call route their model calls through. It already sits between the agent and the provider so that providers never see request state. It is most likely the layer that handles metadata as well: the proxy merges the four layers on read, records what a rejection taught, and seeds learned facts from the session, while providers only declare what they know and classify their own errors. Python has no `ModelProxy` yet; porting it is part of this work. The exact split between proxy and provider is one of the things to settle during API Bar Raising.

### Shape

> This shape is tentative. We will iterate on it as part of API Bar Raising.

```python
@dataclass(frozen=True, kw_only=True)
class ReasoningCapability:
    supported: bool | None = None
    effort_levels: Mapping[str, bool] = EMPTY       # "off", "low", "medium", "high", "xhigh", "max"
    history_bound: bool | None = None               # reasoning blocks are bound to the history that produced them
    replayable_blocks: Mapping[str, bool] = EMPTY   # "signed", "unsigned", "redacted"

@dataclass(frozen=True, kw_only=True)
class ModelCapabilities:
    forced_tool_choice: Literal["supported", "unsupported", "unsupported_with_reasoning"] | None = None
    native_structured_output: bool | None = None
    reasoning: ReasoningCapability = ReasoningCapability()
    prompt_caching: Literal["unsupported", "automatic", "cache_points"] | None = None
    server_tools: Mapping[str, bool] = EMPTY        # "web_search", "code_execution", ...
    input_modalities: Mapping[str, bool] = EMPTY    # "text", "image", "document", "video", "audio"
    tool_result_modalities: Mapping[str, bool] = EMPTY
    mid_conversation_system_messages: bool | None = None
    stateful: bool | None = None
    server_compaction: bool | None = None

@dataclass(frozen=True, kw_only=True)
class ModelLimits:
    context_window: int | None = None
    max_output_tokens: int | None = None

@dataclass(frozen=True, kw_only=True)
class ModelPricing:                                 # FUTURE: shape only. The SDK ships no price tables (design 0016).
    input_per_mtok: float | None = None             # Providers that publish prices fill it; users can override.
    output_per_mtok: float | None = None
    cache_read_per_mtok: float | None = None
    cache_write_per_mtok: float | None = None

@dataclass(frozen=True, kw_only=True)
class ModelMetadata:
    capabilities: ModelCapabilities = ModelCapabilities()   # TODAY
    limits: ModelLimits = ModelLimits()                     # TODAY: populated from the existing _defaults.py tables
    pricing: ModelPricing = ModelPricing()                  # FUTURE
```

`None` means unknown. For maps, a missing key means unknown.

**Writing to it.** All four sources write the same partial, JSON-shaped patch, `ModelMetadataPatch`. A missing field inherits from the layer below, a value wins, and an explicit `None` resets the field to unknown. Providers implement `declare_metadata()` and call `_record_learned_metadata(patch)` when they recognize a rejection. Learning is private to providers for now; we make it public if a plugin or the harness needs it. `Model.metadata` merges the layers on every read, because the learned layer changes after construction.

### Examples

A provider declares what it knows and learns the rest:

```python
class BedrockModel(Model):
    def declare_metadata(self) -> ModelMetadataPatch:
        return merge(_CONVERSE_DEFAULTS, _known_metadata(self.config["model_id"]))

    # in the structured output retry
    except ClientError as e:
        if _is_forced_tool_choice_rejection(e):
            self._record_learned_metadata({"capabilities": {"forced_tool_choice": "unsupported"}})
            continue
```

A custom provider declares only what it knows. Everything else stays unknown, which is today's behavior:

```python
class MyModel(Model):
    def declare_metadata(self) -> ModelMetadataPatch:
        return {"capabilities": {"forced_tool_choice": "supported", "prompt_caching": "unsupported"}}
```

The structured output retry picks a mechanism from the record:

```python
caps = model.metadata.capabilities
can_force = caps.forced_tool_choice != "unsupported"
if caps.forced_tool_choice == "unsupported_with_reasoning" and reasoning_on:
    can_force = False
mechanisms = [m for m in ("forced", "native", "auto")
              if (m != "forced" or can_force) and (m != "native" or caps.native_structured_output is not False)]
```

The harness validates an effort level without its own table:

```python
if model.metadata.capabilities.reasoning.effort_levels.get(effort) is False:
    raise ValueError(f"Effort {effort!r} is not supported by {model_id}")
# True or unknown: send it and let the provider answer
```

A user inspects or overrides:

```python
meta = BedrockModel(model_id="us.anthropic.claude-opus-5-5").metadata
meta.capabilities.forced_tool_choice        # None: unknown, the retry will try and learn
meta.capabilities.reasoning.effort_levels   # {"off": True, "low": True, ..., "max": True}
meta.limits.context_window                  # 200000

model = BedrockModel(model_id="...", endpoint_url=gateway,
                     metadata={"capabilities": {"forced_tool_choice": "unsupported"}})
model.update_config(metadata={"capabilities": {"native_structured_output": None}})   # back to unknown: try it
```

### Caching and persistence

Declared facts come from code, so nothing needs to persist them; the record is recomputed on each read.

Learned facts are different. They live in a process-global store keyed by provider and model id, which is what the `CountTokens` check and #5190 already do. The fact is about the model at the endpoint, not the Python object, so a new `BedrockModel` per request in a warm process does not re-learn it. Across processes we save them with the session: the session manager stores the learned patch next to the agent state, and on restore it seeds the learned layer before the first model call. A restored session does not pay the failed request again. Sessions created before this change have nothing to restore and learn once, as today.

### Shared model data

The per-model knowledge layer (source 2 above) is data, not code, and today it is spelled out in 21 model-id-keyed tables across five packages, hand-mirrored and already drifting. The context-window table has 118 entries in Python and 109 in TypeScript. PR #5164 adds a fifth mirrored pair, `_OUTPUT_TOKEN_LIMITS` / `OUTPUT_TOKEN_LIMITS`, whose Claude Sonnet ceilings (65 536 / 64 000) contradict the harness's own `_CLAUDE_MAX_TOKENS` (128 000). The effort-level tables exist three times (both harnesses and `strands-cli/src/tui/model/selection.ts`), and the TypeScript harness is missing the `amazon.nova-2` branch the Python one has. Seven different functions normalize model ids (strip `us.`/`global.`/ARN prefixes), and they disagree: an ARN resolves a context window in Python but not in TypeScript, and `ap.anthropic.*` loses effort support in both harnesses because `_bedrock_family` does not know `ap.`.

We propose one source of truth for this data in the repo, shared by `strands-py`, `strands-ts`, `harness-py`, `harness-ts` and `strands-cli`, kept current by an automated job.

**The file.** `shared/model-info.json` at the repo root, in a `shared/` folder for everything both SDKs must agree on. One entry per model, keyed by the shortest id that names it (`claude-opus-5-5`, `gpt-5.4`, `amazon.nova-pro-v1:0`); each entry is a `ModelInfo`, the same type the SDK exposes, so the file *is* the declared layer:

```json
{
  "version": 1,
  "idPrefixes": ["us", "eu", "ap", "apac", "au", "jp", "us-gov", "global"],
  "models": {
    "claude-opus-5-5": {
      "limits": { "contextWindow": 1000000, "maxOutputTokens": 128000 },
      "capabilities": { "promptCaching": "cachePoints", "forcedToolChoice": "unsupported", "nativeStructuredOutput": "supported" }
    }
  }
}
```

A lookup tries the id as given, then without a trailing Bedrock version suffix (`-v1:0`), then without a trailing dated snapshot (`-20260401`), then with leading dot-separated segments removed one at a time, the rule `_defaults.py` already uses. So `us.anthropic.claude-opus-5-5-20260401-v1:0`, an ARN and `claude-opus-5-5` all resolve to the one entry, and a model gets a second entry only when it differs between providers (`openai.gpt-6.1-sol` on Bedrock). There is no family or substring discovery: a model the file does not list is unknown, and the SDK uses its defaults for it. Keys and multi-word values are camelCase; the Python loader re-cases them on read. Runtime-learned facts (the `(provider, model_id)` caches) do not go in the file; they are per process.

**Packaging.** The constraints were verified by building, not assumed. Hatch can `force-include` a file from outside `strands-py/`, but `python -m build` (what CI runs) builds the wheel from the sdist, which cannot carry a path above its root, and fails. `tsc` copies a JSON imported from inside `rootDir` into `dist` and silently does not for one outside it. Both harness packages and the CLI depend on *published* SDK versions, not the workspace. That rules out the naive "import the root file" and leaves three options:

- **(a) Root file is the source; each SDK copies it into its package at install and build time.** `strands-ts` copies it to `src/models/model-info.json` in `prepare` and `prebuild` (git-ignored); `strands-py` does the same from a hatch build hook. Each SDK's unit tests assert its copy equals the source. The harnesses and CLI read the data through the SDK (`Model.info` and a lookup helper), which means their tables can be deleted once their SDK version floor includes it.
- **(b) Publish the data as its own Python and npm package.** Clean for the harnesses, which could depend on it directly, but it adds two release pipelines to the six we have, for a file that changes with the SDK anyway.
- **(c) Keep per-package copies and only add the parity check.** No packaging change, but it leaves five hand-edited tables and three id-normalization variants in place; the check would be red today.

We recommend **(a)**. It is the only option where a human or the bot edits exactly one file, the build is unchanged, and the harness duplication goes away through the SDK rather than through a new dependency. The copies are build artifacts; the parity tests are what keep that honest.

**Keeping it current.** A scheduled workflow modeled on `catalog-stats.yml` (weekly cron, regenerate, open a PR with `create-pull-request`), owned by `strandly-the-agent`: pull what provider APIs publish (Anthropic `GET /v1/models` for limits, effort levels and capabilities; Bedrock `ListFoundationModels` for new ids, modalities and lifecycle; models.dev as a cross-check), diff against the file, and open one PR per week with the changes and their sources. Facts the APIs do not expose (which Bedrock models reject replayed reasoning, which hallucinate on JSON tool results) stay hand-maintained in the same file and are the ones the bot flags when a new id appears without them.

**What it replaces.** `_CONTEXT_WINDOW_LIMITS` / `CONTEXT_WINDOW_LIMITS`, #5164's `_OUTPUT_TOKEN_LIMITS` / `OUTPUT_TOKEN_LIMITS`, the Bedrock lists (`_MODELS_INCLUDE_STATUS`, `_MODELS_CONVERT_JSON_TO_TEXT`, `_MODELS_REJECT_REASONING_TEXT`, `MODELS_SUPPORTING_ANTHROPIC_CACHING` and its Vercel copy), the Mantle path prefixes, and the harness tables for max tokens, effort levels, thinking mode by version, web-fetch summarizer models and web search, plus the CLI's effort-level copy. Full inventory with locations and entry counts in Appendix E.

### Alternatives considered

- **Keep adding per-feature properties and config flags** (`stateful`, #4752's `supports_compaction`, #5173's `contextManagedServerSide`). This is the path we are on. Each one is binary, cannot learn, has no override, and adds a property to the base class.
- **Learning only, no declared knowledge.** A `supports(feature)` method backed by rejections. It covers forced tool choice and structured output but cannot answer anything a request does not reveal: effort levels, context window, modalities. Those three are why the declared layer exists.
- **Per-call warnings instead of a record.** The Vercel AI SDK deleted its static capability flags and returns `warnings[]` per call. Warnings never go stale, but nothing can plan with them: routing, mechanism choice and the harness need the answer before the call. We keep rejections as the runtime authority and add the record as the planning layer.
- **A shared JSON registry** (models.dev, LiteLLM). One file for both languages, but it is keyed by model id, so Bedrock inference profiles and gateways mis-resolve, and it does nothing for custom providers. It fits as a data source for the declared layer later.
- **Capabilities only, no `limits` or `pricing`.** The context window is not a capability, and pricing would arrive later as a sibling property. One container now avoids a rename later.

### Backwards compatibility

Custom providers see no change. The default record is all-unknown, and unknown means try, which is exactly what the SDK does today for a provider it knows nothing about. New checks only fire on a known "unsupported", which a custom provider never produces unless it overrides `declare_metadata()`.

`stateful` and `context_window_limit` keep their names and behavior. `stateful` keeps its `False` default because the agent and router branch on it today. `context_window_limit` keeps resolving config first, then the built-in table, and becomes a read of `metadata.limits.context_window`.

The `metadata` config key goes on `BaseModelConfig`, which all vended providers extend, so `validate_config_keys` accepts it. It is optional.

Vended providers migrate one at a time, Bedrock first. Each migration relocates existing tables; same inputs, same decisions. A snapshot test asserts that the old table and the new record agree for every id in the old table.

### Open question

`metadata` or `info`? `metadata` matches design 0016 and the existing `_defaults.py` "model metadata" tables. `info` matches Anthropic's `ModelInfo` and cannot be confused with OpenAI's request-level `metadata` field.

## Additional Details

<details>
<summary>Appendix A: the questions we keep answering</summary>

| # | Question | Who asks | Where we hacked it |
|---|---|---|---|
| 1 | Can it be forced to call a specific tool? | structured output retry; routing | six providers warn and ignore (`_validation.py:65-75`); Bedrock crashed on Llama (#1241) and Claude 5.5 (#5156); three PRs add rejection caches (#4738, #5172, #5190) |
| 2 | Can it emit schema-constrained output natively? | structured output retry | #5190 learns it per process; `litellm.py:381` |
| 3 | Does it reason? Which effort levels? Can it be turned off? | harness `resolve_model` | per-family tables patched per id (#5174, #5175, #5191) |
| 4 | Does it bind reasoning to prior history? | context manager, session restore, structured output retry | #5171 learns from a 400 and latches; #4933 |
| 5 | Which reasoning blocks can be replayed to it? | history formatting; summarizer | `bedrock.py:827-848`; `anthropic.py:232-237` assumes signed |
| 6 | Does it support prompt caching, and automatically? | harness `caching=`; cache point injection | `bedrock.py:326-340` substring gate; harness `models.py:466-477` |
| 7 | Which server-side tools can it run? | harness `web_search=` | prefix match (#5187); `openai_responses.py:1-20` docstring |
| 8 | What input modalities, including inside tool results? | harness `read` tool; routing | `isinstance(BedrockModel)` + prefix (`models.py:401-425`); nine formatters warn and skip |
| 9 | Can a `system` message appear mid-conversation? | `Agent` | nothing; the provider 400s (#5176) |
| 10 | Does it hold conversation state server-side? | `Agent`, routing, delegation | `stateful`, the one declared property |
| 11 | Can the server compact the conversation? | context manager | property (#4752) vs config flag (#5173) |
| 12 | Context window and output ceiling? | `estimate_utilization`; harness `max_tokens` | `_defaults.py` defaulting to 200k on a miss (#5146); harness ceiling tables |
| 13 | What does a token cost? | routing (0016), telemetry | nothing |

</details>

<details>
<summary>Appendix B: who reads each field</summary>

| Field | Read by |
|---|---|
| `forced_tool_choice` | structured output retry (#5190); `_validation.py:65-75`; router |
| `native_structured_output` | structured output retry; `litellm.py:381` |
| `reasoning.supported`, `reasoning.effort_levels` | harness `resolve_model` and `supports_thinking` |
| `reasoning.history_bound` | context manager, session restore, structured output retry (#5171, #4933) |
| `reasoning.replayable_blocks` | summarizer input; history formatting |
| `prompt_caching` | harness `caching=`; provider cache point injection |
| `server_tools` | harness `web_search=` (#5187) |
| `input_modalities`, `tool_result_modalities` | harness `read` tool; router; formatters |
| `mid_conversation_system_messages` | `Agent` (#5176) |
| `stateful` | `agent.py:411`, `router.py:523`, `_agent_delegation.py:101` |
| `server_compaction` | context manager (#4752, #5173); #5242 triggers server-side compaction on it instead of adding a new flag |
| `limits.*` | `estimate_utilization`; harness `max_tokens` |
| `pricing.*` | nobody yet; router strategies (0016) and telemetry later |

Fields we left out, and why: a per-mode `tool_choice` map (`any` vs `tool` differ for one model and no consumer acts on it); `can_disable` (it is the `"off"` effort level); `supports_tools`, streaming, lifecycle and rate limits (nothing reads them yet; each is one additive field away); default effort and preferred mechanism (preferences, not facts).

</details>

<details>
<summary>Appendix C: prior art</summary>

| System | What it does | What we took |
|---|---|---|
| Pydantic AI `ModelProfile` | partial profile, resolved by the provider, five-layer merge, user override | the layering and the override |
| LangChain `ModelProfile` | generated from models.dev, every key optional | `reasoning_effort_levels`, `mid_conversation_system_messages` |
| Vercel AI SDK | deleted static flags, returns `warnings[]` per call | rejections stay the runtime authority |
| LiteLLM | global JSON registry; missing key is unknown, explicit `False` is final | the unknown semantics |
| Google ADK `LlmCapabilities` | frozen record recomputed on every read | merge on every read |
| Anthropic `GET /v1/models` | nested `capabilities` with effort levels and thinking types | the nested `reasoning` object |
| Amazon Bedrock `ListFoundationModels` | modalities, streaming, lifecycle only | nothing usable for capabilities |

</details>

<details>
<summary>Appendix D: related work</summary>

- #5190 (`mehtarac`): provider-side structured output, forced then native then auto, learned per provider and model id. Supersedes #5172; #4738 was an earlier take. Root issues #5156, #1241.
- #5171 (`lizradway`): `drop_block` retry on a thinking-binding 400. #4933 asks for binding as a first-class fact.
- #4752 `supports_compaction` and #5173 `contextManagedServerSide`: two shapes for one capability.
- #5176: mid-conversation `system` messages. #5174, #5175, #5191: harness effort tables. #5187, #5188: web search dropped by a prefix miss. #5146: context window miss.
- Design 0016 (model routing): candidates "carry limits, pricing, and capabilities in `metadata`"; the SDK ships no price data.
- #5164: adds `_OUTPUT_TOKEN_LIMITS` / `OUTPUT_TOKEN_LIMITS`, another hand-mirrored pair. #5242: server-side compaction, which reads `server_compaction`. #4667: `ModelProxy`.

</details>

<details>
<summary>Appendix E: model-id-keyed tables the shared file replaces</summary>

| Fact | Python | TypeScript | Entries | Key format |
|---|---|---|---|---|
| Context window | `strands-py/src/strands/models/_defaults.py:33` | `strands-ts/src/models/defaults.ts:62` | 118 vs 109 | exact base id; Python strips every prefix segment, TS strips one known prefix |
| Output-token ceiling (#5164) | `_defaults.py` `_OUTPUT_TOKEN_LIMITS` | `defaults.ts` `OUTPUT_TOKEN_LIMITS` | 16 each | exact id, mixed granularity |
| Harness `max_tokens` ceiling | `harness-py/src/strands_harness/models.py:40-46` | `harness-ts/src/models.ts:39-46` | 4 + 6 | substring on tier + version pins; conflicts with #5164 for Sonnet |
| Effort levels per family | `models.py:93-100,149` | `models.ts:89-96`; third copy `strands-cli/src/tui/model/selection.ts:8-14` | 8 sets | prefix on family after `_bedrock_family`; TS lacks `amazon.nova-2` |
| Adaptive vs extended thinking by Claude version | `models.py:102-108` | `models.ts:100-118` | 3 + 3 + 5 | `_CLAUDE_ID` regex + version compare |
| Tool-result `status` | `bedrock.py:75` | `bedrock.ts:90` | 1 | substring |
| Nova JSON tool results | `bedrock.py:80` | none | 1 | substring |
| Rejects replayed `reasoningText` | `bedrock.py:85` | `bedrock.ts:103` | 15 | substring; ARNs bail out |
| Auto cache points | none (substring inline, `bedrock.py:326-340`) | `bedrock.ts:97`, copied at `vercel.ts:329` | 2 | substring |
| Mantle base path | `_openai_bedrock.py:39` | `openai/mantle.ts:25` | 3 vs 5 | prefix on unprefixed id |
| Web-fetch summarizer model | `models.py:66,84` | `models.ts:66` (no family table) | 5 + 3 | provider / vendor prefix |
| Web search on Mantle | `models.py:375` | `models.ts:557` | 3 | prefix |
| Default model and `maxTokens` per provider | scalars in `bedrock.py:53-55` | `defaults.ts:8` | 4 | provider name |

Id-normalization variants today: Python SDK strips every dot segment in a loop; TS SDK strips one prefix from `{us, eu, ap, global, apac, au, jp, us-gov}`; both harnesses strip one from `{global, apac, us, eu, au, jp}` (no `ap`, no `us-gov`); the CLI uses a regex with `us-gov` but not `ap`; Mantle strips nothing; the Bedrock reasoning filter lowercases and bails on `arn:` or dotless ids. Runtime-learned caches (`_native_output.py` `_UNSUPPORTED_MECHANISMS`, `bedrock.py` `_SKIP_COUNT_TOKENS_MODELS`) are not static data and stay out of the file.

</details>
