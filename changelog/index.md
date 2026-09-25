# Strands Agents Changelog

## SDK Python v1.57.1 — 2026-09-25
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.57.1 · Package: https://pypi.org/project/strands-agents/1.57.1/

### Features
- add Agent.shutdown() for scope-based cleanup [devx, agent] (https://github.com/strands-agents/harness-sdk/pull/4519)
- require explicit model IDs for providers [model, bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/4525)
- add a2a\_client vended tool [tool, a2a] (https://github.com/strands-agents/harness-sdk/pull/4304)
- replace setup Q&A with Quickstart, Customize, and Export, and add /tools [devx, mcp] (https://github.com/strands-agents/harness-sdk/pull/4581)
- add snapshot capture and restore [bidirectional-streaming, persistence] (https://github.com/strands-agents/harness-sdk/pull/4584)

### Fixes
- improve onboarding and terminal responsiveness [devx] (https://github.com/strands-agents/harness-sdk/pull/4518)
- align @strands-agents/sdk range with harness (fixes interventions instanceof crash) [devx, interventions] (https://github.com/strands-agents/harness-sdk/pull/4530)
- reject non-boolean classifier decisions [hil] (https://github.com/strands-agents/harness-sdk/pull/4538)
- simplify and clarify CLI UX; fix bugs [context, devx] (https://github.com/strands-agents/harness-sdk/pull/4548)
- migrate off removed mcp.server.fastmcp for mcp 2.x compat [mcp] (https://github.com/strands-agents/harness-sdk/pull/4547)
- extract content from task.status.message when artifacts are absent [a2a] (https://github.com/strands-agents/harness-sdk/pull/4511)
- cap sqlalchemy\<2.1.0 to avoid RecursionError in Hatch dependency check (https://github.com/strands-agents/harness-sdk/pull/4583)
- finalize invocation before yielding the result [multiagent, hooks] (https://github.com/strands-agents/harness-sdk/pull/4580)
- align response boundaries and transcript history [hooks, bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/4560)
- record tool dispatch in conversation history [tool, bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/4605)
- rewrite all stored copies of a message when guardrail redacts it [persistence, interventions] (https://github.com/strands-agents/harness-sdk/pull/4606)
- update model id in cancellation integ tests [model] (https://github.com/strands-agents/harness-sdk/pull/4611)

### Other
- lift the @strands-agents/sdk \<1.18.0 cap (https://github.com/strands-agents/harness-sdk/pull/4520)
- enforce formatting checks (https://github.com/strands-agents/harness-sdk/pull/4526)
- add versioning policy for Strands harness and the CLI (https://github.com/strands-agents/harness-sdk/pull/4535)
- add Python lint/format gate to pre-commit hook [devx] (https://github.com/strands-agents/harness-sdk/pull/4528)
- use barge-in terminology [hooks, bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/4566)
- depend on harness ~0.1.1 (https://github.com/strands-agents/harness-sdk/pull/4582)
- remove response stop reasons [hooks, bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/4604)

## SDK Python v1.57.0 — 2026-09-22
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.57.0 · Package: https://pypi.org/project/strands-agents/1.57.0/

### Features
- accept shared content blocks as input [bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/4331)
- select the bedrock-runtime endpoint from bedrock\_mantle\_config [model] (https://github.com/strands-agents/harness-sdk/pull/4360)
- distinguish audio deltas from complete content [devx, bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/4366)
- add handoff\_to\_user tool [hil, tool] (https://github.com/strands-agents/harness-sdk/pull/4348)
- support snapshot session management for Graph and Swarm [multiagent, persistence] (https://github.com/strands-agents/harness-sdk/pull/4240)
- add mcp\_router vended tool [mcp, tool] (https://github.com/strands-agents/harness-sdk/pull/4252)
- merge in the Strands harness (https://github.com/strands-agents/harness-sdk/pull/4447)
- launch the redesigned Strands website (https://github.com/strands-agents/harness-sdk/pull/4446)
- opus 5 and high thinking by default [model] (https://github.com/strands-agents/harness-sdk/pull/4460)

### Fixes
- reject unrecognized limits keys instead of silently applying no cap [devx, agent] (https://github.com/strands-agents/harness-sdk/pull/4355)
- propagate handler-raised interrupts regardless of on\_error [hooks, interventions] (https://github.com/strands-agents/harness-sdk/pull/4372)
- pin the strands command to the commit it was issued against (https://github.com/strands-agents/harness-sdk/pull/4393)
- surface prompt-cache write tokens on Chat Completions [model] (https://github.com/strands-agents/harness-sdk/pull/4361)
- make MemoryStore optional methods instantiable under type checkers [devx, persistence] (https://github.com/strands-agents/harness-sdk/pull/3966)
- keep only text when re-roling a summary as a user message [context, model] (https://github.com/strands-agents/harness-sdk/pull/4402)
- stop schema normalization from mutating caller-owned specs [tool] (https://github.com/strands-agents/harness-sdk/pull/4426)
- align Node requirement and default model docs [devx] (https://github.com/strands-agents/harness-sdk/pull/4469)
- depend on the published harness in exported projects [devx, server] (https://github.com/strands-agents/harness-sdk/pull/4478)
- default effort back to 'auto' so no-reasoning models resolve [model] (https://github.com/strands-agents/harness-sdk/pull/4473)
- let an explicit web\_search: 'exa' win over native search [model, tool] (https://github.com/strands-agents/harness-sdk/pull/4491)
- send auth flow requests as yielded and strip decoded framing headers [mcp] (https://github.com/strands-agents/harness-sdk/pull/4233)
- install provider SDKs with the CLI [devx, model] (https://github.com/strands-agents/harness-sdk/pull/4508)
- remove retired Nova Sonic 1 from integration tests [model, bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/4512)

### Other
- separate audio buffering and processing modules [bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/4310)
- standardize owner-package imports [devx, bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/4369)
- Rename file number appropriately for design doc 0018-shared-agent-model-types.md (https://github.com/strands-agents/harness-sdk/pull/4376)
- remove duplicate docs-strands-command workflow (https://github.com/strands-agents/harness-sdk/pull/4380)
- add CI for the merged harness-py and harness-ts packages (https://github.com/strands-agents/harness-sdk/pull/4450)
- add strands-harness (harness-py) PyPI release pipeline (https://github.com/strands-agents/harness-sdk/pull/4453)
- Strands CLI and some text nits (https://github.com/strands-agents/harness-sdk/pull/4457)
- add @strands-agents/harness (harness-ts) npm release pipeline (https://github.com/strands-agents/harness-sdk/pull/4455)
- bump cedarpy from 4.8.7 to 4.12.0 in /strands-py (https://github.com/strands-agents/harness-sdk/pull/4365)
- add @strands-agents/cli CI + npm release pipeline (https://github.com/strands-agents/harness-sdk/pull/4468)
- remove stale test issue references (https://github.com/strands-agents/harness-sdk/pull/4467)
- use Strands wordmarks in package READMEs (https://github.com/strands-agents/harness-sdk/pull/4475)
- adopt production component names [bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/4444)

## SDK TypeScript v1.19.0 — 2026-09-22
Release: https://github.com/strands-agents/harness-sdk/releases/tag/typescript/v1.19.0 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/1.19.0

### Features
- non-clobbering seam for Anthropic-direct server-side tools (web search) [devx, model] (https://github.com/strands-agents/harness-sdk/pull/3568)
- port handoff\_to\_user tool to TypeScript [hil, tool] (https://github.com/strands-agents/harness-sdk/pull/4382)
- requestTimeout option on BedrockModel [devx, model] (https://github.com/strands-agents/harness-sdk/pull/4408)
- merge in the Strands harness (https://github.com/strands-agents/harness-sdk/pull/4447)
- launch the redesigned Strands website (https://github.com/strands-agents/harness-sdk/pull/4446)
- opus 5 and high thinking by default [model] (https://github.com/strands-agents/harness-sdk/pull/4460)

### Fixes
- deliver background results through the registered management tool [async, tool] (https://github.com/strands-agents/harness-sdk/pull/4347)
- reject unrecognized limits keys instead of silently applying no cap [devx, agent] (https://github.com/strands-agents/harness-sdk/pull/4356)
- interrupt retry backoff on cancellation [model, agent] (https://github.com/strands-agents/harness-sdk/pull/4291)
- propagate handler-raised interrupts regardless of onError [hil, interventions] (https://github.com/strands-agents/harness-sdk/pull/4373)
- pin the strands command to the commit it was issued against (https://github.com/strands-agents/harness-sdk/pull/4393)
- keep only text when re-roling a summary as a user message [context] (https://github.com/strands-agents/harness-sdk/pull/4421)
- accept a ContextManager instance in Agent contextManager [context, devx] (https://github.com/strands-agents/harness-sdk/pull/4459)
- align Node requirement and default model docs [devx] (https://github.com/strands-agents/harness-sdk/pull/4469)
- depend on the published harness in exported projects [devx, server] (https://github.com/strands-agents/harness-sdk/pull/4478)
- default effort back to 'auto' so no-reasoning models resolve [model] (https://github.com/strands-agents/harness-sdk/pull/4473)
- let an explicit web\_search: 'exa' win over native search [model, tool] (https://github.com/strands-agents/harness-sdk/pull/4491)
- preserve UTF-8 across stream chunk boundaries [server] (https://github.com/strands-agents/harness-sdk/pull/4157)
- install provider SDKs with the CLI [devx, model] (https://github.com/strands-agents/harness-sdk/pull/4508)

### Other
- Rename file number appropriately for design doc 0018-shared-agent-model-types.md (https://github.com/strands-agents/harness-sdk/pull/4376)
- remove duplicate docs-strands-command workflow (https://github.com/strands-agents/harness-sdk/pull/4380)
- add CI for the merged harness-py and harness-ts packages (https://github.com/strands-agents/harness-sdk/pull/4450)
- add strands-harness (harness-py) PyPI release pipeline (https://github.com/strands-agents/harness-sdk/pull/4453)
- Strands CLI and some text nits (https://github.com/strands-agents/harness-sdk/pull/4457)
- add @strands-agents/harness (harness-ts) npm release pipeline (https://github.com/strands-agents/harness-sdk/pull/4455)
- add @strands-agents/cli CI + npm release pipeline (https://github.com/strands-agents/harness-sdk/pull/4468)
- remove stale test issue references (https://github.com/strands-agents/harness-sdk/pull/4467)
- use Strands wordmarks in package READMEs (https://github.com/strands-agents/harness-sdk/pull/4475)
- bump fast-uri from 3.1.5 to 3.1.8 (https://github.com/strands-agents/harness-sdk/pull/4385)
- bump hono from 4.13.0 to 4.13.8 (https://github.com/strands-agents/harness-sdk/pull/4386)
- bump the production-minor group across 1 directory with 3 updates (https://github.com/strands-agents/harness-sdk/pull/4344)

## Evals v1.4.0 — 2026-09-22
Release: https://github.com/strands-agents/evals/releases/tag/v1.4.0 · Package: https://pypi.org/project/strands-agents-evals/1.4.0/

### Features
- add model-output corruption effects [chaos] (https://github.com/strands-agents/evals/pull/284)

### Fixes
- pin strands command runs to the commit the command was issued against (https://github.com/strands-agents/evals/pull/403)

## SDK Python v1.56.0 — 2026-09-15
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.56.0 · Package: https://pypi.org/project/strands-agents/1.56.0/

### Features
- include exit\_code in shell tool result [tool, server] (https://github.com/strands-agents/harness-sdk/pull/4269)
- align model configuration and parameter overrides [model, bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/4255)
- automatically use openAI prompt-cache keys from session id [model, sessions] (https://github.com/strands-agents/harness-sdk/pull/4083)
- share lifecycle hooks and add response completion hooks [hooks, bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/4280)
- add transcript completion events [hooks, bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/4230)
- add session manager integration [context, sessions] (https://github.com/strands-agents/harness-sdk/pull/4254)
- add web\_fetch tool for TypeScript [tool] (https://github.com/strands-agents/harness-sdk/pull/4153)
- render live transcripts with audio output [bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/4287)
- port strategy presets and agent rewire [context, agent] (https://github.com/strands-agents/harness-sdk/pull/4282)
- include partial output in shell timeout errors [tool, server] (https://github.com/strands-agents/harness-sdk/pull/4325)
- add bm25 search strategy [persistence] (https://github.com/strands-agents/harness-sdk/pull/4079)
- non-clobbering seam for Anthropic-direct server-side tools (web search) [devx, model] (https://github.com/strands-agents/harness-sdk/pull/3568)

### Fixes
- route Bedrock Mantle openai.gpt-6-\* to /openai/v1 [model] (https://github.com/strands-agents/harness-sdk/pull/4267)
- clean up CRT streams on shutdown [model, bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/4253)
- avoid leaking YAML parse error and dropping valid ski… [config] (https://github.com/strands-agents/harness-sdk/pull/4192)
- align reference semantics with Agent and Model [hooks, bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/4286)
- preserve image blocks in requests [model] (https://github.com/strands-agents/harness-sdk/pull/4200)
- force structured output retry by tool name [structured-output] (https://github.com/strands-agents/harness-sdk/pull/4263)
- make AgentResult.to\_dict JSON-serializable with bytes [agent] (https://github.com/strands-agents/harness-sdk/pull/4313)
- deliver background results through the registered management tool [async, tool] (https://github.com/strands-agents/harness-sdk/pull/4347)

### Other
- share repository session methods through LocalAgent [bidirectional-streaming, sessions] (https://github.com/strands-agents/harness-sdk/pull/4257)
- ai usage reflection blog (https://github.com/strands-agents/harness-sdk/pull/4148)
- rename model configuration validator [bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/4297)
- refine model audio configuration [model, bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/4303)
- pin native OTel trace continuity on the mcp 2.x version [mcp, otel] (https://github.com/strands-agents/harness-sdk/pull/4131)

## SDK TypeScript v1.18.0 — 2026-09-15
Release: https://github.com/strands-agents/harness-sdk/releases/tag/typescript/v1.18.0 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/1.18.0

### Features
- include exit\_code in shell tool result [tool, server] (https://github.com/strands-agents/harness-sdk/pull/4269)
- automatically use openAI prompt-cache keys from session id [model, sessions] (https://github.com/strands-agents/harness-sdk/pull/4083)
- add web\_fetch tool for TypeScript [tool] (https://github.com/strands-agents/harness-sdk/pull/4153)
- add context strategy presets + rewire defaults to use class [context, language] (https://github.com/strands-agents/harness-sdk/pull/4256)
- port Python notebook improvements to TS [tool] (https://github.com/strands-agents/harness-sdk/pull/4281)
- include partial output in shell timeout errors [tool, server] (https://github.com/strands-agents/harness-sdk/pull/4325)
- add bm25 search strategy [persistence] (https://github.com/strands-agents/harness-sdk/pull/4079)

### Fixes
- emit tool results before user text to preserve tool\_use/tool\_result adjacency [model] (https://github.com/strands-agents/harness-sdk/pull/4234)
- fix various context manager parity items [context] (https://github.com/strands-agents/harness-sdk/pull/4228)
- route Bedrock Mantle openai.gpt-6-\* to /openai/v1 [model] (https://github.com/strands-agents/harness-sdk/pull/4267)

### Other
- ai usage reflection blog (https://github.com/strands-agents/harness-sdk/pull/4148)

## Evals v1.3.0 — 2026-09-15
Release: https://github.com/strands-agents/evals/releases/tag/v1.3.0 · Package: https://pypi.org/project/strands-agents-evals/1.3.0/

### Features
- add OpenAI Agents support to GenAI session mapper [tracing] (https://github.com/strands-agents/evals/pull/365)

### Fixes
- ensure parse\_timestamp always returns timezone-aware UTC datetime [tracing] (https://github.com/strands-agents/evals/pull/377)
- skip non-serializable tools in OutputEvaluator serialization (https://github.com/strands-agents/evals/pull/379)
- make Experiment.to\_file() reject non-strict JSON instead of writing invalid files [core, devx] (https://github.com/strands-agents/evals/pull/383)
- clarify tool-selection prompt in flaky Claude integration test [evaluators] (https://github.com/strands-agents/evals/pull/386)
- omit default model=None from to\_dict instead of pinning to default model id [evaluators, devx] (https://github.com/strands-agents/evals/pull/392)

## SDK Python v1.55.1 — 2026-09-09
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.55.1 · Package: https://pypi.org/project/strands-agents/1.55.1/

### Features
- add backgroundTasks to Agent [async, agent] (https://github.com/strands-agents/harness-sdk/pull/4226)
- simplify Google and OpenAI model configs [model, bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/4189)
- port notebook tool to Python [tool] (https://github.com/strands-agents/harness-sdk/pull/4132)

### Fixes
- fix various context manager parity items [context] (https://github.com/strands-agents/harness-sdk/pull/4228)
- resolve nested Bedrock model prefixes [model] (https://github.com/strands-agents/harness-sdk/pull/4221)
- use semantic system instructions for agent spans [otel, agent] (https://github.com/strands-agents/harness-sdk/pull/4222)
- filter malformed immutable snapshot IDs [persistence] (https://github.com/strands-agents/harness-sdk/pull/4199)

## SDK Python v1.55.0 — 2026-09-08
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.55.0 · Package: https://pypi.org/project/strands-agents/1.55.0/

### Features
- support API key authentication [model] (https://github.com/strands-agents/harness-sdk/pull/3601)
- proactive session reconnect for bidi session [bidirectional-streaming, sessions] (https://github.com/strands-agents/harness-sdk/pull/3874)
- add cache\_config to Mistral [model] (https://github.com/strands-agents/harness-sdk/pull/3986)
- mcp v2 compatible changes under a flag [mcp] (https://github.com/strands-agents/harness-sdk/pull/3708)
- added server/discover for SEP-2575 [mcp] (https://github.com/strands-agents/harness-sdk/pull/3821)
- support multiple continuation inputs [hil] (https://github.com/strands-agents/harness-sdk/pull/3953)
- add reconnect() for gemini google live [model, bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/4078)
- added call\_tool support for 2.x [mcp] (https://github.com/strands-agents/harness-sdk/pull/4090)
- add tools\_ttl to CacheConfig and deprecate cache\_tools (#3893) [model] (https://github.com/strands-agents/harness-sdk/pull/3985)
- add LocalAgent protocol [hooks, agent] (https://github.com/strands-agents/harness-sdk/pull/4091)
- add reconnect() for openai [model, bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/4104)
- added MRTR input-required support for 2.x [mcp] (https://github.com/strands-agents/harness-sdk/pull/4094)
- refresh tools on list-changed notifications for 2.x [mcp] (https://github.com/strands-agents/harness-sdk/pull/4112)
- extend MRTR to prompts and resources, scope hand-sent cancel to 1.x [mcp] (https://github.com/strands-agents/harness-sdk/pull/4121)
- add cache config to llama.cpp [model] (https://github.com/strands-agents/harness-sdk/pull/4127)
- implement LocalAgent [hooks, bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/4108)
- add web\_fetch vended tool [tool] (https://github.com/strands-agents/harness-sdk/pull/4001)
- add internal in-process task engine / manager [async] (https://github.com/strands-agents/harness-sdk/pull/4115)
- support SEP-2663 tasks [mcp] (https://github.com/strands-agents/harness-sdk/pull/4125)
- relax mcp version to \<2.2 [mcp] (https://github.com/strands-agents/harness-sdk/pull/4151)
- add AudioCapable and typed model config [model, bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/4144)
- port offloading stratgies [context] (https://github.com/strands-agents/harness-sdk/pull/4146)
- add prefix\_with\_server\_name and continue\_on\_error defaults to load\_servers [mcp] (https://github.com/strands-agents/harness-sdk/pull/4177)
- port stash integration [context, tool] (https://github.com/strands-agents/harness-sdk/pull/4187)
- accept cache\_config on Ollama, Writer, and SageMaker [model] (https://github.com/strands-agents/harness-sdk/pull/4232)
- export context manager types as experimental [context, devx] (https://github.com/strands-agents/harness-sdk/pull/4231)

### Fixes
- close agent trace span on BaseException cancellation [async, otel] (https://github.com/strands-agents/harness-sdk/pull/4013)
- pass list pagination as params for the mcp 2.x version [mcp] (https://github.com/strands-agents/harness-sdk/pull/3984)
- bedrock nova sonic reconnect [model, bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/4082)
- parse each SSE event within a PayloadPart [model] (https://github.com/strands-agents/harness-sdk/pull/4036)
- handle missing reasoningText in non-streaming conversion [model] (https://github.com/strands-agents/harness-sdk/pull/4124)
- reject backslashes in storage keys [persistence] (https://github.com/strands-agents/harness-sdk/pull/4126)
- internal renames for bidi constants and private class [bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/4140)
- resolve the OAuth scope keyword rename on mcp 2.x [mcp] (https://github.com/strands-agents/harness-sdk/pull/4147)
- report max\_tokens when a Responses function call is cut off [model] (https://github.com/strands-agents/harness-sdk/pull/4139)
- rename reconnect to restart [bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/4143)
- gate the deprecated cache\_tools point on the resolved cache strategy [model] (https://github.com/strands-agents/harness-sdk/pull/4186)
- added httpx2 adapter [mcp] (https://github.com/strands-agents/harness-sdk/pull/4183)
- remove orphaned toolResults at any index, not only the first [context, model] (https://github.com/strands-agents/harness-sdk/pull/4154)
- preserve non-bytes image/document blocks (#4017) [context] (https://github.com/strands-agents/harness-sdk/pull/4059)
- handle empty input for zero-argument tools without warning [tool] (https://github.com/strands-agents/harness-sdk/pull/4195)
- stop str\_replace and insert from expanding tabs on the write path [devx, tool] (https://github.com/strands-agents/harness-sdk/pull/4182)

### Other
- align 0016 with shipped ClassifierStrategy (https://github.com/strands-agents/harness-sdk/pull/4046)
- port pending tool execution state [hil, persistence] (https://github.com/strands-agents/harness-sdk/pull/3894)
- deprecate LlamaAPI model provider [model] (https://github.com/strands-agents/harness-sdk/pull/4011)
- rename model providers [model, bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/3956)
- refine audio processing configuration [bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/3952)
- make BidiModel extend Model [model, bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/4081)
- design: propose shared agent and model types [devx, agent] (https://github.com/strands-agents/harness-sdk/pull/3855)
- stabilize the cache-point-after-document integ test (https://github.com/strands-agents/harness-sdk/pull/4119)
- cancel superseded PR runs to reduce runner concurrency (https://github.com/strands-agents/harness-sdk/pull/4134)
- use strands-agents 4-core runner pool (https://github.com/strands-agents/harness-sdk/pull/4141)
- upgrade pywebrtc audio to 0.2 [bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/4149)
- move codecov config to repo root so Codecov discovers it again (https://github.com/strands-agents/harness-sdk/pull/4174)
- feat(bidi) compress event queues to be one event queue for bidi lifecycle events [bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/4173)
- added mcp 2.x integ tests [mcp] (https://github.com/strands-agents/harness-sdk/pull/4129)
- add install-size guard to pack test (https://github.com/strands-agents/harness-sdk/pull/4179)

## SDK TypeScript v1.17.0 — 2026-09-08
Release: https://github.com/strands-agents/harness-sdk/releases/tag/typescript/v1.17.0 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/1.17.0

### Features
- require Node.js 22+, drop Node 20 support (https://github.com/strands-agents/harness-sdk/pull/4145)
- porting classifier routing strategy from python [model, language] (https://github.com/strands-agents/harness-sdk/pull/3987)
- add L1 stash for durable storage of offloaded content [context, persistence] (https://github.com/strands-agents/harness-sdk/pull/3924)
- support caching for vercel provider [model] (https://github.com/strands-agents/harness-sdk/pull/4055)
- add session support for L1 [persistence, sessions] (https://github.com/strands-agents/harness-sdk/pull/4118)
- add prefix\_with\_server\_name and continue\_on\_error defaults to load\_servers [mcp] (https://github.com/strands-agents/harness-sdk/pull/4177)
- export context manager types as experimental [context, devx] (https://github.com/strands-agents/harness-sdk/pull/4231)

### Fixes
- include cached tokens in input\_tokens [model] (https://github.com/strands-agents/harness-sdk/pull/4080)
- reject backslashes in storage keys [persistence] (https://github.com/strands-agents/harness-sdk/pull/4126)
- close the model invoke span when the consumer breaks the stream [otel, model] (https://github.com/strands-agents/harness-sdk/pull/3898)
- remove @tobilu/qmd from optional dependencies (https://github.com/strands-agents/harness-sdk/pull/4178)
- emit tool results before user text to preserve tool\_use/tool\_result adjacency [model] (https://github.com/strands-agents/harness-sdk/pull/4138)

### Other
- design: propose shared agent and model types [devx, agent] (https://github.com/strands-agents/harness-sdk/pull/3855)
- cancel superseded PR runs to reduce runner concurrency (https://github.com/strands-agents/harness-sdk/pull/4134)
- use strands-agents 4-core runner pool (https://github.com/strands-agents/harness-sdk/pull/4141)
- move codecov config to repo root so Codecov discovers it again (https://github.com/strands-agents/harness-sdk/pull/4174)
- add install-size guard to pack test (https://github.com/strands-agents/harness-sdk/pull/4179)

## SDK TypeScript v1.16.0 — 2026-08-31
Release: https://github.com/strands-agents/harness-sdk/releases/tag/typescript/v1.16.0 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/1.16.0

### Features
- add internal BackgroundTaskManager interface + InProcessTaskManager impl [async, multiagent] (https://github.com/strands-agents/harness-sdk/pull/3876)
- add QmdSearchStrategy with BM25 full-text search [persistence] (https://github.com/strands-agents/harness-sdk/pull/3897)
- add backgroundTasks to Agent [async, agent] (https://github.com/strands-agents/harness-sdk/pull/4026)

### Fixes
- stop str\_replace and insert from rewriting untouched bytes [tool] (https://github.com/strands-agents/harness-sdk/pull/4014)
- close cycle telemetry when the stream iterator exits early [otel] (https://github.com/strands-agents/harness-sdk/pull/4054)

### Other
- align 0016 with shipped ClassifierStrategy (https://github.com/strands-agents/harness-sdk/pull/4046)

## SDK Python v1.54.0 — 2026-08-27
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.54.0 · Package: https://pypi.org/project/strands-agents/1.54.0/

### Features
- add cache\_key to CacheConfig for key-routed cache providers [model] (https://github.com/strands-agents/harness-sdk/pull/3949)
- add configurable classifier strategy [multiagent, model] (https://github.com/strands-agents/harness-sdk/pull/3846)
- add FileMemoryStore [persistence] (https://github.com/strands-agents/harness-sdk/pull/3925)
- inject an external cancellation signal into agent invocations [async, agent] (https://github.com/strands-agents/harness-sdk/pull/3999)
- add session\_id property to Agent [agent, sessions] (https://github.com/strands-agents/harness-sdk/pull/4007)

### Fixes
- count Gemini tool-use tokens as input and thinking tokens as output [model] (https://github.com/strands-agents/harness-sdk/pull/3892)
- warn and skip cachePoint message blocks instead of raising [model] (https://github.com/strands-agents/harness-sdk/pull/3947)
- redact blocked content when guardrail trace is disabled [model, interventions] (https://github.com/strands-agents/harness-sdk/pull/3772)
- convert JSON content blocks to text for Amazon Nova models in tool results [model] (https://github.com/strands-agents/harness-sdk/pull/1985)
- harden mantle routing integ tests (https://github.com/strands-agents/harness-sdk/pull/3957)
- restore always() in upload-metrics if guard (https://github.com/strands-agents/harness-sdk/pull/3970)
- yield trailing usage metadata chunk after finish\_reason (#3902) [model] (https://github.com/strands-agents/harness-sdk/pull/3955)
- grant Bidi integration test permissions [bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/3975)
- use shared Google API key in integration test [model, bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/3977)
- append the format to message document filenames [model] (https://github.com/strands-agents/harness-sdk/pull/3912)
- prevent in-place mutation of message history in normalizer [context, agent] (https://github.com/strands-agents/harness-sdk/pull/2326)
- detect Mantle context overflow errors [context, model] (https://github.com/strands-agents/harness-sdk/pull/3973)
- emit semconv-compliant cache usage attributes [otel] (https://github.com/strands-agents/harness-sdk/pull/3964)
- simplify agent delegation by making end\_turn accept content blocks [multiagent, hooks] (https://github.com/strands-agents/harness-sdk/pull/3961)
- treat empty integration test reports as a no-op (https://github.com/strands-agents/harness-sdk/pull/4006)
- count cached tokens in context-size and compaction baseline [context] (https://github.com/strands-agents/harness-sdk/pull/3886)

### Other
- refresh dependencies and isolate test results (https://github.com/strands-agents/harness-sdk/pull/3900)
- bump dorny/paths-filter from 3.0.2 to 4.0.3 (https://github.com/strands-agents/harness-sdk/pull/3907)
- harden bedrock kb integ tests [persistence] (https://github.com/strands-agents/harness-sdk/pull/3954)
- consolidate development configuration [bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/3960)
- update Bidi Bedrock dependencies (https://github.com/strands-agents/harness-sdk/pull/3997)
- record decision on null vs undefined input handling (https://github.com/strands-agents/harness-sdk/pull/3889)

## SDK TypeScript v1.15.0 — 2026-08-27
Release: https://github.com/strands-agents/harness-sdk/releases/tag/typescript/v1.15.0 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/1.15.0

### Features
- export key-aware extractor and make it model-configurable [model, language] (https://github.com/strands-agents/harness-sdk/pull/3948)
- add cache\_key to CacheConfig for key-routed cache providers [model] (https://github.com/strands-agents/harness-sdk/pull/3949)
- add internal InProcessTaskEngine [async, language] (https://github.com/strands-agents/harness-sdk/pull/3838)
- add sessionId getter to Agent [devx, sessions] (https://github.com/strands-agents/harness-sdk/pull/4000)
- add model routing [model, language] (https://github.com/strands-agents/harness-sdk/pull/3903)

### Fixes
- count Gemini tool-use tokens as input and thinking tokens as output [model] (https://github.com/strands-agents/harness-sdk/pull/3892)
- redact blocked content when guardrail trace is disabled [model, interventions] (https://github.com/strands-agents/harness-sdk/pull/3772)
- harden vercel document test [model] (https://github.com/strands-agents/harness-sdk/pull/3958)
- harden mantle routing integ tests (https://github.com/strands-agents/harness-sdk/pull/3957)
- restore always() in upload-metrics if guard (https://github.com/strands-agents/harness-sdk/pull/3970)
- grant Bidi integration test permissions [bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/3975)
- emit semconv-compliant cache usage attributes [otel] (https://github.com/strands-agents/harness-sdk/pull/3964)
- forward cancellation signal to OpenAI [async, model] (https://github.com/strands-agents/harness-sdk/pull/3936)
- support content blocks in AfterToolsEvent.endTurn and simplify delegation [multiagent, hooks] (https://github.com/strands-agents/harness-sdk/pull/3995)
- treat empty integration test reports as a no-op (https://github.com/strands-agents/harness-sdk/pull/4006)
- count cached tokens in context-size and compaction baseline [context] (https://github.com/strands-agents/harness-sdk/pull/3886)

### Other
- refresh dependencies and isolate test results (https://github.com/strands-agents/harness-sdk/pull/3900)
- bump dorny/paths-filter from 3.0.2 to 4.0.3 (https://github.com/strands-agents/harness-sdk/pull/3907)
- bump the production-minor group across 1 directory with 2 updates (https://github.com/strands-agents/harness-sdk/pull/3880)
- bump the production-minor group across 1 directory with 3 updates (https://github.com/strands-agents/harness-sdk/pull/3942)
- record decision on null vs undefined input handling (https://github.com/strands-agents/harness-sdk/pull/3889)

## SDK Python v1.53.0 — 2026-08-21
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.53.0 · Package: https://pypi.org/project/strands-agents/1.53.0/

### Features
- enable prompt caching via cache\_config and cache\_tools [model] (https://github.com/strands-agents/harness-sdk/pull/3571)
- surface tool annotations in ToolSpec [mcp, tool] (https://github.com/strands-agents/harness-sdk/pull/3528)
- add client OAuth authentication for streamable HTTP [mcp] (https://github.com/strands-agents/harness-sdk/pull/3554)
- add agent-as-tool delegation [multiagent, agent] (https://github.com/strands-agents/harness-sdk/pull/3346)
- add after tool call duration [hooks, tool] (https://github.com/strands-agents/harness-sdk/pull/3589)
- add injected content behind cache points (https://github.com/strands-agents/harness-sdk/pull/3704)
- built-in SDK integrations and maintainer tiers in the catalog (https://github.com/strands-agents/harness-sdk/pull/3766)
- count only complexity a PR adds, in both SDKs (https://github.com/strands-agents/harness-sdk/pull/3771)
- support min/max score filtering in Bedrock knowledge base store [model, tool] (https://github.com/strands-agents/harness-sdk/pull/3726)
- add /community/ editorial hub and 14-lesson course (https://github.com/strands-agents/harness-sdk/pull/3520)
- add echo suppression support [bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/3580)
- add audio content blocks [model, bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/3862)

### Fixes
- include strandly workspace in root build and type-check (https://github.com/strands-agents/harness-sdk/pull/3804)
- omit falsy cache point TTLs [model] (https://github.com/strands-agents/harness-sdk/pull/3799)
- classify Bedrock Mantle context-overflow errors [context, model] (https://github.com/strands-agents/harness-sdk/pull/3722)
- inherit cache\_config ttl on an untimed tools cache point [model] (https://github.com/strands-agents/harness-sdk/pull/3858)
- raise on unsupported document and image formats instead of sending undeliverable requests [model, tool] (https://github.com/strands-agents/harness-sdk/pull/3790)
- emit gemini usage metadata alongside content events [model, bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/3725)
- failing tests [bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/3883)
- fix failing unit tests for bedrock caching [model] (https://github.com/strands-agents/harness-sdk/pull/3887)
- accumulate cache token counters in Graph and Swarm [multiagent] (https://github.com/strands-agents/harness-sdk/pull/3884)
- cache system prompt in auto mode (https://github.com/strands-agents/harness-sdk/pull/3681)

### Other
- re-enable anthropic integration tests (https://github.com/strands-agents/harness-sdk/pull/3783)
- update litellm requirement from \<=1.95.0,\>=1.75.9 to \>=1.75.9,\<=1.96.0 in /strands-py (https://github.com/strands-agents/harness-sdk/pull/3775)
- require both decorator and log when deprecating a tool [tool] (https://github.com/strands-agents/harness-sdk/pull/3599)
- update API review label names in strands-review skill (https://github.com/strands-agents/harness-sdk/pull/3805)
- add integration testing for caching [model] (https://github.com/strands-agents/harness-sdk/pull/3793)
- remove vestigial strandly workspace (https://github.com/strands-agents/harness-sdk/pull/3806)
- bump astral-sh/setup-uv from 9.0.0 to 10.0.1 (https://github.com/strands-agents/harness-sdk/pull/3848)
- apply ruff formatting (https://github.com/strands-agents/harness-sdk/pull/3866)
- file-based memory store [persistence] (https://github.com/strands-agents/harness-sdk/pull/2895)
- scope portaudio install to a gated bidi job (https://github.com/strands-agents/harness-sdk/pull/3890)
- remove unwinnable rate-limit throttling integ test [context, model] (https://github.com/strands-agents/harness-sdk/pull/3891)
- update mypy requirement from \<2.0.0,\>=1.15.0 to \>=1.15.0,\<3.0.0 in /strands-py (https://github.com/strands-agents/harness-sdk/pull/3868)

## SDK TypeScript v1.14.0 — 2026-08-21
Release: https://github.com/strands-agents/harness-sdk/releases/tag/typescript/v1.14.0 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/1.14.0

### Features
- enable prompt caching via cache\_config and cache\_tools [model] (https://github.com/strands-agents/harness-sdk/pull/3571)
- surface tool annotations in ToolSpec [mcp, tool] (https://github.com/strands-agents/harness-sdk/pull/3528)
- add injected content behind cache points (https://github.com/strands-agents/harness-sdk/pull/3704)
- built-in SDK integrations and maintainer tiers in the catalog (https://github.com/strands-agents/harness-sdk/pull/3766)
- add execution-scoped cancellation to ToolContext [devx, tool] (https://github.com/strands-agents/harness-sdk/pull/3807)
- count only complexity a PR adds, in both SDKs (https://github.com/strands-agents/harness-sdk/pull/3771)
- support min/max score filtering in Bedrock knowledge base store [model, tool] (https://github.com/strands-agents/harness-sdk/pull/3726)
- add /community/ editorial hub and 14-lesson course (https://github.com/strands-agents/harness-sdk/pull/3520)
- support multiple continuation inputs [hooks, agent] (https://github.com/strands-agents/harness-sdk/pull/3837)
- thread per-call model through InvokeModelStage [model, language] (https://github.com/strands-agents/harness-sdk/pull/3875)
- add audio content blocks [model, language] (https://github.com/strands-agents/harness-sdk/pull/3865)
- add FileMemoryStore [persistence] (https://github.com/strands-agents/harness-sdk/pull/3825)
- add context manager offloading strategies [context] (https://github.com/strands-agents/harness-sdk/pull/3505)

### Fixes
- throw on undeliverable document blocks instead of silently dropping them [devx, model] (https://github.com/strands-agents/harness-sdk/pull/3786)
- deliver url-source images instead of silently dropping them [model] (https://github.com/strands-agents/harness-sdk/pull/3792)
- unwrap NumericValue metadata back to the stored number [model, persistence] (https://github.com/strands-agents/harness-sdk/pull/3655)
- include strandly workspace in root build and type-check (https://github.com/strands-agents/harness-sdk/pull/3804)
- omit falsy cache point TTLs [model] (https://github.com/strands-agents/harness-sdk/pull/3799)
- preserve initialization failures [hooks, agent] (https://github.com/strands-agents/harness-sdk/pull/3482)
- read prompt\_tokens\_details cache reads in TS OpenAI Chat [model] (https://github.com/strands-agents/harness-sdk/pull/3885)
- cache system prompt in auto mode (https://github.com/strands-agents/harness-sdk/pull/3681)

### Other
- require both decorator and log when deprecating a tool [tool] (https://github.com/strands-agents/harness-sdk/pull/3599)
- bump @aws-sdk/client-bedrock-runtime from 3.1097.0 to 3.1104.0 in the production-minor group (https://github.com/strands-agents/harness-sdk/pull/3801)
- update API review label names in strands-review skill (https://github.com/strands-agents/harness-sdk/pull/3805)
- add integration testing for caching [model] (https://github.com/strands-agents/harness-sdk/pull/3793)
- remove vestigial strandly workspace (https://github.com/strands-agents/harness-sdk/pull/3806)
- bump @aws-sdk/client-bedrock-runtime from 3.1104.0 to 3.1105.0 in the production-minor group (https://github.com/strands-agents/harness-sdk/pull/3816)
- bump @aws-sdk/client-bedrock-runtime from 3.1105.0 to 3.1106.0 in the production-minor group (https://github.com/strands-agents/harness-sdk/pull/3850)
- bump astral-sh/setup-uv from 9.0.0 to 10.0.1 (https://github.com/strands-agents/harness-sdk/pull/3848)
- bump @aws-sdk/client-bedrock-runtime from 3.1106.0 to 3.1107.0 in the production-minor group (https://github.com/strands-agents/harness-sdk/pull/3869)
- file-based memory store [persistence] (https://github.com/strands-agents/harness-sdk/pull/2895)
- scope portaudio install to a gated bidi job (https://github.com/strands-agents/harness-sdk/pull/3890)

## Evals v1.2.0 — 2026-08-21
Release: https://github.com/strands-agents/evals/releases/tag/v1.2.0 · Package: https://pypi.org/project/strands-agents-evals/1.2.0/

### Features
- add Claude Agents OpenInference integration tests [tracing] (https://github.com/strands-agents/evals/pull/353)
- add skill-level evaluators for skill-equipped agents [evaluators] (https://github.com/strands-agents/evals/pull/330)
- add OpenAI Agents SDK support to OpenInference mapper [tracing] (https://github.com/strands-agents/evals/pull/366)

### Fixes
- select root agent span by earliest start\_time in multi-agent traces [tracing] (https://github.com/strands-agents/evals/pull/371)
- reduce flakiness for integration tests targeting new session mappers [evaluators] (https://github.com/strands-agents/evals/pull/374)
- change bridge\_parent\_gaps to return new spans instead of mutating in place [tracing] (https://github.com/strands-agents/evals/pull/375)

### Other
- update mypy requirement from \<2.0.0 to \<3.0.0 (https://github.com/strands-agents/evals/pull/368)
- update opentelemetry-instrumentation-langchain requirement from \<0.62.0,\>=0.40.0 to \>=0.40.0,\<0.63.0 (https://github.com/strands-agents/evals/pull/369)

## SDK Python v1.52.0 — 2026-08-12
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.52.0 · Package: https://pypi.org/project/strands-agents/1.52.0/

### Features
- add AgentStreamStage with middleware-initiated interrupts [hooks, hil] (https://github.com/strands-agents/harness-sdk/pull/3594)
- add top level storage [persistence, agent] (https://github.com/strands-agents/harness-sdk/pull/3743)
- add ModelRouter and accept it via Agent(model=) [model, agent] (https://github.com/strands-agents/harness-sdk/pull/3474)

### Fixes
- send document content as file\_data on the Responses API [model] (https://github.com/strands-agents/harness-sdk/pull/3576)
- honor a cache point placed in the last user message [model] (https://github.com/strands-agents/harness-sdk/pull/3677)
- update bidi google-genai version floor [model, bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/3740)
- keep the pre-rename name on the deprecated bash aliases [devx, tool] (https://github.com/strands-agents/harness-sdk/pull/3751)
- move count\_tokens fixture off retired gemini-2.0-flash [model] (https://github.com/strands-agents/harness-sdk/pull/3755)
- report retrieval failures as tool errors (https://github.com/strands-agents/harness-sdk/pull/3680)
- send tool-result documents as file\_data, not file\_url [model, tool] (https://github.com/strands-agents/harness-sdk/pull/3674)
- emit thought signature as its own reasoning delta [model] (https://github.com/strands-agents/harness-sdk/pull/3306)
- move count\_tokens fixture to gemini-3.1-flash-lite [model] (https://github.com/strands-agents/harness-sdk/pull/3763)
- retry incompatible tool-result turns [model] (https://github.com/strands-agents/harness-sdk/pull/3622)
- log warning when tool input JSON is malformed [tool, agent] (https://github.com/strands-agents/harness-sdk/pull/2054)

### Other
- bump actions/upload-artifact from 6.0.0 to 7.0.1 (https://github.com/strands-agents/harness-sdk/pull/3702)
- bump actions/setup-python from 6.3.0 to 7.0.0 (https://github.com/strands-agents/harness-sdk/pull/3701)
- bump actions/download-artifact from 6.0.0 to 8.0.1 (https://github.com/strands-agents/harness-sdk/pull/3703)
- bump dorny/paths-filter from 4.0.2 to 4.0.3 (https://github.com/strands-agents/harness-sdk/pull/3729)
- skipped mcp otel instrumentation for mcp v2 [mcp, otel] (https://github.com/strands-agents/harness-sdk/pull/3611)
- retry inconclusive Mantle routing probes [model] (https://github.com/strands-agents/harness-sdk/pull/3747)
- add prescriptive guidance for keeping cognitive complexity low (https://github.com/strands-agents/harness-sdk/pull/3741)
- post release notes to the announcements discussion board (https://github.com/strands-agents/harness-sdk/pull/3707)
- treat bash as its own deprecated tool [tool] (https://github.com/strands-agents/harness-sdk/pull/3756)
- link catalog and standalone page changes in the preview comment (https://github.com/strands-agents/harness-sdk/pull/3774)

## SDK TypeScript v1.13.0 — 2026-08-12
Release: https://github.com/strands-agents/harness-sdk/releases/tag/typescript/v1.13.0 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/1.13.0

### Features
- support appending to notebooks [tool] (https://github.com/strands-agents/harness-sdk/pull/3459)

### Fixes
- honor a cache point placed in the last user message [model] (https://github.com/strands-agents/harness-sdk/pull/3677)
- keep the pre-rename name on the deprecated bash aliases [devx, tool] (https://github.com/strands-agents/harness-sdk/pull/3751)
- trim at complete tool pairs [context] (https://github.com/strands-agents/harness-sdk/pull/3447)
- abort in-flight Bedrock requests on cancellation [model, agent] (https://github.com/strands-agents/harness-sdk/pull/3337)

### Other
- bump dorny/paths-filter from 4.0.2 to 4.0.3 (https://github.com/strands-agents/harness-sdk/pull/3729)
- retry inconclusive Mantle routing probes [model] (https://github.com/strands-agents/harness-sdk/pull/3747)
- add prescriptive guidance for keeping cognitive complexity low (https://github.com/strands-agents/harness-sdk/pull/3741)
- post release notes to the announcements discussion board (https://github.com/strands-agents/harness-sdk/pull/3707)
- treat bash as its own deprecated tool [tool] (https://github.com/strands-agents/harness-sdk/pull/3756)
- link catalog and standalone page changes in the preview comment (https://github.com/strands-agents/harness-sdk/pull/3774)

## Evals v1.1.1 — 2026-08-12
Release: https://github.com/strands-agents/evals/releases/tag/v1.1.1 · Package: https://pypi.org/project/strands-agents-evals/1.1.1/

### Features
- add support for Claude agents to OpenInference mapper [tracing] (https://github.com/strands-agents/evals/pull/340)

### Fixes
- add GenericGenAISessionMapper for dict spans with unrecognized scope [tracing] (https://github.com/strands-agents/evals/pull/309)

### Other
- update pre-commit requirement from \<4.6.0,\>=3.2.0 to \>=3.2.0,\<4.7.0 (https://github.com/strands-agents/evals/pull/321)
- bump pypa/gh-action-pypi-publish from 1.14.0 to 1.14.2 (https://github.com/strands-agents/evals/pull/333)

## SDK Python v1.51.0 — 2026-08-07
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.51.0 · Package: https://pypi.org/project/strands-agents/1.51.0/

### Features
- hydrate search snippets concurrently [async, mcp] (https://github.com/strands-agents/harness-sdk/pull/3435)
- support the interrupt round trip over A2A [hil, a2a] (https://github.com/strands-agents/harness-sdk/pull/3486)
- add BeforeToolsEvent and AfterToolsEvent batch hooks [hooks, hil] (https://github.com/strands-agents/harness-sdk/pull/3508)
- add telemetry and metrics [otel, bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/3282)
- add \_\_str\_\_ support for MultiAgentResult and NodeResult [devx, multiagent] (https://github.com/strands-agents/harness-sdk/pull/1998)
- add should\_offload callback for selective offloading [context, hooks] (https://github.com/strands-agents/harness-sdk/pull/3267)
- add context window limits for Claude 5 and GPT-5.6 families [context, model] (https://github.com/strands-agents/harness-sdk/pull/3629)
- support Tool Choice for Gemini in Python [model] (https://github.com/strands-agents/harness-sdk/pull/3551)
- add classifier option for LLM-driven risk classification [hil, interventions] (https://github.com/strands-agents/harness-sdk/pull/3575)
- community integration catalog with search, filtering, and curated backfill (https://github.com/strands-agents/harness-sdk/pull/3416)
- add snapshot session manager to python [persistence, sessions] (https://github.com/strands-agents/harness-sdk/pull/3283)
- add estimateUtilization method to Model base class [context, model] (https://github.com/strands-agents/harness-sdk/pull/3641)
- add AgentStreamStage and AgentStreamContext types [hooks, hil] (https://github.com/strands-agents/harness-sdk/pull/3635)

### Fixes
- refresh eviction cycle on retrieve for unified Storage backends [context] (https://github.com/strands-agents/harness-sdk/pull/3487)
- pin mcp dependency below v2.0.0 [mcp] (https://github.com/strands-agents/harness-sdk/pull/3524)
- exclude bootstrap tools from MCP audit (https://github.com/strands-agents/harness-sdk/pull/3565)
- skip guardContent wrap for unsupported image formats [model, interventions] (https://github.com/strands-agents/harness-sdk/pull/3607)
- count usage from hook-retried model calls [otel, hooks] (https://github.com/strands-agents/harness-sdk/pull/3627)
- record gen\_ai.tool.call.arguments/result on execute\_tool spans [otel] (https://github.com/strands-agents/harness-sdk/pull/3550)
- index document content on hydration with thread safety [mcp] (https://github.com/strands-agents/harness-sdk/pull/3502)
- resolve a default region for the store's clients so it works in cloud envs [model, persistence] (https://github.com/strands-agents/harness-sdk/pull/3583)
- correct crash-restart resume for handoff and completed swarms [multiagent] (https://github.com/strands-agents/harness-sdk/pull/3391)
- reject redundant languages in astro frontmatter [devx] (https://github.com/strands-agents/harness-sdk/pull/3678)
- mantle base path routing (https://github.com/strands-agents/harness-sdk/pull/3691)
- label fork PRs by verifying the artifact's claim against the PR head (https://github.com/strands-agents/harness-sdk/pull/3705)

### Other
- update design doc template to uncover key information early (https://github.com/strands-agents/harness-sdk/pull/3532)
- bump cedarpy from 4.8.6 to 4.8.7 in /strands-py (https://github.com/strands-agents/harness-sdk/pull/3214)
- mark agentic context management mode as experimental [context] (https://github.com/strands-agents/harness-sdk/pull/3553)
- bump postcss from 8.5.15 to 8.5.25 (https://github.com/strands-agents/harness-sdk/pull/3543)
- remove reference to agent builder after archival (https://github.com/strands-agents/harness-sdk/pull/3581)
- bump fast-uri from 3.1.2 to 3.1.4 (https://github.com/strands-agents/harness-sdk/pull/3405)
- rename sandbox-routed bash tool to shell [tool, server] (https://github.com/strands-agents/harness-sdk/pull/3574)
- update litellm requirement from \<=1.91.1,\>=1.75.9 to \>=1.75.9,\<=1.93.0 in /strands-py (https://github.com/strands-agents/harness-sdk/pull/3587)
- run the package build test on pull requests [mcp] (https://github.com/strands-agents/harness-sdk/pull/3592)
- mark make\_bash with typing\_extensions.deprecated [devx, tool] (https://github.com/strands-agents/harness-sdk/pull/3595)
- update litellm requirement from \<=1.93.0,\>=1.75.9 to \>=1.75.9,\<=1.95.0 in /strands-py (https://github.com/strands-agents/harness-sdk/pull/3649)
- bump hono from 4.12.32 to 4.13.0 (https://github.com/strands-agents/harness-sdk/pull/3643)
- bump the npm\_and\_yarn group across 1 directory with 1 update (https://github.com/strands-agents/harness-sdk/pull/3620)
- bump ip-address from 10.2.0 to 10.4.0 (https://github.com/strands-agents/harness-sdk/pull/3619)
- bump @hono/node-server and @modelcontextprotocol/sdk (https://github.com/strands-agents/harness-sdk/pull/3596)
- label PRs by cognitive complexity, stop counting tests toward size (https://github.com/strands-agents/harness-sdk/pull/3634)
- wait for the retained task, not the log line [async, mcp] (https://github.com/strands-agents/harness-sdk/pull/3537)
- extend the comment rule to require to-the-point, non-inferable content (https://github.com/strands-agents/harness-sdk/pull/3676)

## SDK TypeScript v1.12.0 — 2026-08-07
Release: https://github.com/strands-agents/harness-sdk/releases/tag/typescript/v1.12.0 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/1.12.0

### Features
- hydrate search snippets concurrently [async, mcp] (https://github.com/strands-agents/harness-sdk/pull/3435)
- add llm as judge tool risk classifier to hitl [hil, interventions] (https://github.com/strands-agents/harness-sdk/pull/3566)
- add MCP tool filtering and name prefixes [mcp] (https://github.com/strands-agents/harness-sdk/pull/3415)
- add context window limits for Claude 5 and GPT-5.6 families [context, model] (https://github.com/strands-agents/harness-sdk/pull/3629)
- community integration catalog with search, filtering, and curated backfill (https://github.com/strands-agents/harness-sdk/pull/3416)
- detect repetitive swarm handoffs [multiagent] (https://github.com/strands-agents/harness-sdk/pull/3461)
- add estimateUtilization method to Model base class [context, model] (https://github.com/strands-agents/harness-sdk/pull/3641)
- accept storage as optional top-level Agent parameter [agent, sessions] (https://github.com/strands-agents/harness-sdk/pull/3660)

### Fixes
- pin mcp dependency below v2.0.0 [mcp] (https://github.com/strands-agents/harness-sdk/pull/3524)
- exclude bootstrap tools from MCP audit (https://github.com/strands-agents/harness-sdk/pull/3565)
- validate snapshot scope [persistence] (https://github.com/strands-agents/harness-sdk/pull/3593)
- preserve interrupt state across cancelled resumes and middleware re-reads [hil] (https://github.com/strands-agents/harness-sdk/pull/3615)
- record gen\_ai.tool.call.arguments/result on execute\_tool spans [otel] (https://github.com/strands-agents/harness-sdk/pull/3550)
- index document content on hydration with thread safety [mcp] (https://github.com/strands-agents/harness-sdk/pull/3502)
- reject redundant languages in astro frontmatter [devx] (https://github.com/strands-agents/harness-sdk/pull/3678)
- mantle base path routing (https://github.com/strands-agents/harness-sdk/pull/3691)
- label fork PRs by verifying the artifact's claim against the PR head (https://github.com/strands-agents/harness-sdk/pull/3705)
- bump @aws-sdk/core to 3.977.6 to fix NumericValue metadata regression [model, persistence] (https://github.com/strands-agents/harness-sdk/pull/3709)

### Other
- update design doc template to uncover key information early (https://github.com/strands-agents/harness-sdk/pull/3532)
- mark agentic context management mode as experimental [context] (https://github.com/strands-agents/harness-sdk/pull/3553)
- bump postcss from 8.5.15 to 8.5.25 (https://github.com/strands-agents/harness-sdk/pull/3543)
- remove reference to agent builder after archival (https://github.com/strands-agents/harness-sdk/pull/3581)
- bump fast-uri from 3.1.2 to 3.1.4 (https://github.com/strands-agents/harness-sdk/pull/3405)
- rename sandbox-routed bash tool to shell [tool, server] (https://github.com/strands-agents/harness-sdk/pull/3574)
- run the package build test on pull requests [mcp] (https://github.com/strands-agents/harness-sdk/pull/3592)
- bump @aws-sdk/client-bedrock-runtime from 3.1078.0 to 3.1095.0 in the production-minor group across 1 directory (https://github.com/strands-agents/harness-sdk/pull/3174)
- bump hono from 4.12.32 to 4.13.0 (https://github.com/strands-agents/harness-sdk/pull/3643)
- bump the npm\_and\_yarn group across 1 directory with 1 update (https://github.com/strands-agents/harness-sdk/pull/3620)
- bump ip-address from 10.2.0 to 10.4.0 (https://github.com/strands-agents/harness-sdk/pull/3619)
- bump @aws-sdk/client-bedrock-runtime from 3.1095.0 to 3.1097.0 in the production-minor group across 1 directory (https://github.com/strands-agents/harness-sdk/pull/3625)
- bump @hono/node-server and @modelcontextprotocol/sdk (https://github.com/strands-agents/harness-sdk/pull/3596)
- extend the comment rule to require to-the-point, non-inferable content (https://github.com/strands-agents/harness-sdk/pull/3676)
- bump actions/upload-artifact from 6.0.0 to 7.0.1 (https://github.com/strands-agents/harness-sdk/pull/3702)
- bump @hono/node-server from 1.19.14 to 2.1.0 (https://github.com/strands-agents/harness-sdk/pull/3669)
- bump actions/setup-python from 6.3.0 to 7.0.0 (https://github.com/strands-agents/harness-sdk/pull/3701)
- bump fast-uri from 3.1.4 to 3.1.5 (https://github.com/strands-agents/harness-sdk/pull/3618)
- bump actions/download-artifact from 6.0.0 to 8.0.1 (https://github.com/strands-agents/harness-sdk/pull/3703)

## Evals v1.1.0 — 2026-08-07
Release: https://github.com/strands-agents/evals/releases/tag/v1.1.0 · Package: https://pypi.org/project/strands-agents-evals/1.1.0/

### Features
- allow custom tools on judge-based evaluators (Trajectory, Output, Multimodal) [evaluators] (https://github.com/strands-agents/evals/pull/324)
- add ADK mapper [tracing] (https://github.com/strands-agents/evals/pull/326)
- add integration tests for ADK mapper [tracing] (https://github.com/strands-agents/evals/pull/339)

### Fixes
- include prior tool results in session\_history for tool-level evaluators [evaluators, tracing] (https://github.com/strands-agents/evals/pull/338)
- scope tools to owning agent in multi-agent traces [evaluators, tracing] (https://github.com/strands-agents/evals/pull/336)
- update ADK multi-agent integ test for single-trace design [tracing] (https://github.com/strands-agents/evals/pull/352)
- reset target session between PAIR/SequentialBreak iterations [redteam] (https://github.com/strands-agents/evals/pull/292)

### Other
- update ruff requirement from \<0.16.0,\>=0.13.0 to \>=0.13.0,\<0.17.0 (https://github.com/strands-agents/evals/pull/327)

## SDK Python v1.50.2 — 2026-07-27
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.50.2 · Package: https://pypi.org/project/strands-agents/1.50.2/

### Features
- add per-call MCP tool cancellation [mcp, hil] (https://github.com/strands-agents/harness-sdk/pull/3402)
- add context manager class design doc [context] (https://github.com/strands-agents/harness-sdk/pull/3307)

### Fixes
- gemini live mp to use updated api [model, bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/3424)
- deduplicate inverted-index postings [mcp] (https://github.com/strands-agents/harness-sdk/pull/3417)
- consume reasoning signature per content block [model, agent] (https://github.com/strands-agents/harness-sdk/pull/3472)
- legacy file storage accepts bare filenames and stems [persistence] (https://github.com/strands-agents/harness-sdk/pull/3495)

### Other
- bump google-genai floor to \>=1.67.0 [model, bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/3478)
- correct search tool contracts [mcp] (https://github.com/strands-agents/harness-sdk/pull/3456)
- update context offloader comments to deprecate legacy storage [persistence] (https://github.com/strands-agents/harness-sdk/pull/3476)
- remove security features, accept httpx.AsyncClient [devx, tool] (https://github.com/strands-agents/harness-sdk/pull/3491)

## SDK TypeScript v1.11.2 — 2026-07-27
Release: https://github.com/strands-agents/harness-sdk/releases/tag/typescript/v1.11.2 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/1.11.2

### Features
- add agent-as-tool delegation [multiagent, agent] (https://github.com/strands-agents/harness-sdk/pull/3265)
- add context manager class design doc [context] (https://github.com/strands-agents/harness-sdk/pull/3307)

### Fixes
- deduplicate inverted-index postings [mcp] (https://github.com/strands-agents/harness-sdk/pull/3417)

### Other
- correct search tool contracts [mcp] (https://github.com/strands-agents/harness-sdk/pull/3456)
- update context offloader comments to deprecate legacy storage [persistence] (https://github.com/strands-agents/harness-sdk/pull/3476)

## SDK Python v1.50.1 — 2026-07-24
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.50.1 · Package: https://pypi.org/project/strands-agents/1.50.1/

### Features
- thread per-call model through InvokeModelStage [hooks, model] (https://github.com/strands-agents/harness-sdk/pull/3434)

### Other
- move stop tool to experimental [devx, tool] (https://github.com/strands-agents/harness-sdk/pull/3465)
- bump hono from 4.12.25 to 4.12.32 (https://github.com/strands-agents/harness-sdk/pull/3469)
- update ruff requirement from \<0.16.0,\>=0.13.0 to \>=0.13.0,\<0.17.0 in /strands-py (https://github.com/strands-agents/harness-sdk/pull/3439)
- add model routing design doc (0016) [model] (https://github.com/strands-agents/harness-sdk/pull/3217)
- run the sync backstop every 2 hours (https://github.com/strands-agents/harness-sdk/pull/3475)
- enforce single-increment versions and verify publish on the registry (https://github.com/strands-agents/harness-sdk/pull/3473)
- add automated release workflow [mcp] (https://github.com/strands-agents/harness-sdk/pull/3413)

## SDK Python v1.50.0 — 2026-07-24
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.50.0 · Package: https://pypi.org/project/strands-agents/1.50.0/

### Features
- add ExecuteToolStage with middleware-initiated interrupts [hooks, tool] (https://github.com/strands-agents/harness-sdk/pull/3233)
- configurable retry exceptions (#1597) [devx, agent] (https://github.com/strands-agents/harness-sdk/pull/3340)
- propose bidi webrtc design [bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/3386)
- add http\_request to strands-py [tool] (https://github.com/strands-agents/harness-sdk/pull/3395)
- add stop tool [tool, agent] (https://github.com/strands-agents/harness-sdk/pull/3397)
- add sleep tool [tool] (https://github.com/strands-agents/harness-sdk/pull/3393)

### Fixes
- make the release pip-audit step actually run (https://github.com/strands-agents/harness-sdk/pull/3335)
- replay assistant text history as valid string-content input in Responses adapters [devx, model] (https://github.com/strands-agents/harness-sdk/pull/3399)
- keep fan-in node out of resume while a parallel sibling is in-flight [multiagent] (https://github.com/strands-agents/harness-sdk/pull/3390)
- reject keys for s3 storage if not configured [persistence] (https://github.com/strands-agents/harness-sdk/pull/3411)
- verify aws region (https://github.com/strands-agents/harness-sdk/pull/3412)
- send llama.cpp sampler params at the top level, not under extra\_body [model] (https://github.com/strands-agents/harness-sdk/pull/3423)
- preserve shared context and cumulative accounting across serialize/deserialize [context, multiagent] (https://github.com/strands-agents/harness-sdk/pull/3396)
- surface Responses stream failures [model] (https://github.com/strands-agents/harness-sdk/pull/3427)

### Other
- merge strands-agents/mcp-server into monorepo [mcp] (https://github.com/strands-agents/harness-sdk/pull/3300)
- replace duplicated examples guide with reference pointer (https://github.com/strands-agents/harness-sdk/pull/3288)
- bump brace-expansion from 5.0.6 to 5.0.7 (https://github.com/strands-agents/harness-sdk/pull/3370)
- refactor TestMemoryStore to use the unified storage interface (https://github.com/strands-agents/harness-sdk/pull/3260)
- bump body-parser from 2.2.2 to 2.3.0 (https://github.com/strands-agents/harness-sdk/pull/3387)
- bump actions/setup-python from 6 to 7 (https://github.com/strands-agents/harness-sdk/pull/3352)
- bump astral-sh/setup-uv from 8.3.0 to 9.0.0 (https://github.com/strands-agents/harness-sdk/pull/3407)
- bump pypa/gh-action-pypi-publish from 1.14.0 to 1.14.1 (https://github.com/strands-agents/harness-sdk/pull/3406)

## SDK TypeScript v1.11.1 — 2026-07-24
Release: https://github.com/strands-agents/harness-sdk/releases/tag/typescript/v1.11.1 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/1.11.1

### Features
- add per-call MCP tool cancellation [mcp, hil] (https://github.com/strands-agents/harness-sdk/pull/3402)

### Fixes
- persist message strategy after invocation [persistence, sessions] (https://github.com/strands-agents/harness-sdk/pull/3440)

### Other
- move stop tool to experimental [devx, tool] (https://github.com/strands-agents/harness-sdk/pull/3465)
- bump hono from 4.12.25 to 4.12.32 (https://github.com/strands-agents/harness-sdk/pull/3469)
- add model routing design doc (0016) [model] (https://github.com/strands-agents/harness-sdk/pull/3217)
- run the sync backstop every 2 hours (https://github.com/strands-agents/harness-sdk/pull/3475)
- enforce single-increment versions and verify publish on the registry (https://github.com/strands-agents/harness-sdk/pull/3473)
- add automated release workflow [mcp] (https://github.com/strands-agents/harness-sdk/pull/3413)

## SDK TypeScript v1.11.0 — 2026-07-24
Release: https://github.com/strands-agents/harness-sdk/releases/tag/typescript/v1.11.0 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/1.11.0

### Features
- add ToolExecutor class hierarchy [language, tool] (https://github.com/strands-agents/harness-sdk/pull/3268)
- propose bidi webrtc design [bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/3386)
- add stop tool [tool, agent] (https://github.com/strands-agents/harness-sdk/pull/3397)
- add sleep tool [tool] (https://github.com/strands-agents/harness-sdk/pull/3393)

### Fixes
- make the release pip-audit step actually run (https://github.com/strands-agents/harness-sdk/pull/3335)
- detect tool use from streamed content when finish\_reason is non-tool [model] (https://github.com/strands-agents/harness-sdk/pull/3206)
- surface Responses stream failures [model] (https://github.com/strands-agents/harness-sdk/pull/3290)
- replay assistant text history as valid string-content input in Responses adapters [devx, model] (https://github.com/strands-agents/harness-sdk/pull/3399)
- reject keys for s3 storage if not configured [persistence] (https://github.com/strands-agents/harness-sdk/pull/3411)
- verify aws region (https://github.com/strands-agents/harness-sdk/pull/3412)

### Other
- merge strands-agents/mcp-server into monorepo [mcp] (https://github.com/strands-agents/harness-sdk/pull/3300)
- extract shared registerNodeDefaults() to prevent src/test drift [devx] (https://github.com/strands-agents/harness-sdk/pull/3303)
- replace duplicated examples guide with reference pointer (https://github.com/strands-agents/harness-sdk/pull/3288)
- bump brace-expansion from 5.0.6 to 5.0.7 (https://github.com/strands-agents/harness-sdk/pull/3370)
- refactor TestMemoryStore to use the unified storage interface (https://github.com/strands-agents/harness-sdk/pull/3260)
- bump body-parser from 2.2.2 to 2.3.0 (https://github.com/strands-agents/harness-sdk/pull/3387)
- bump actions/setup-python from 6 to 7 (https://github.com/strands-agents/harness-sdk/pull/3352)
- bump astral-sh/setup-uv from 8.3.0 to 9.0.0 (https://github.com/strands-agents/harness-sdk/pull/3407)
- bump pypa/gh-action-pypi-publish from 1.14.0 to 1.14.1 (https://github.com/strands-agents/harness-sdk/pull/3406)

## Evals v1.0.3 — 2026-07-23
Release: https://github.com/strands-agents/evals/releases/tag/v1.0.3 · Package: https://pypi.org/project/strands-agents-evals/1.0.3/

### Features
- map type labels to native issue type (https://github.com/strands-agents/evals/pull/287)

### Fixes
- sha-pin third-party GitHub Actions (https://github.com/strands-agents/evals/pull/285)
- added pyproject classifiers (https://github.com/strands-agents/evals/pull/307)
- fix tool parsing from list [tracing] (https://github.com/strands-agents/evals/pull/313)
- route smolagents OpenInference spans to OpenInferenceSessionMapper [tracing] (https://github.com/strands-agents/evals/pull/308)
- detect\_otel\_mapper checks all spans for body in CloudWatch split format [tracing] (https://github.com/strands-agents/evals/pull/320)

### Other
- add CODEOWNERS (https://github.com/strands-agents/evals/pull/305)
- deflake async concurrency test by tracking in-flight tasks [core] (https://github.com/strands-agents/evals/pull/304)
- align dependabot config with harness-sdk conventions (https://github.com/strands-agents/evals/pull/306)
- bump actions/setup-python from 6 to 7 (https://github.com/strands-agents/evals/pull/318)

## SDK Python v1.48.0 — 2026-07-17
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.48.0 · Package: https://pypi.org/project/strands-agents/1.48.0/

### Features
- allow ports in either direction (https://github.com/strands-agents/harness-sdk/pull/3160)
- expose client\_name parameter on MCPClient for clientInfo identification [devx, mcp] (https://github.com/strands-agents/harness-sdk/pull/3113)
- add gen\_ai\_span\_attributes\_only env var [otel] (https://github.com/strands-agents/harness-sdk/pull/3191)
- add unified storage interface [persistence] (https://github.com/strands-agents/harness-sdk/pull/3259)

### Fixes
- upgrade ts release workflow to npm 12 (https://github.com/strands-agents/harness-sdk/pull/3188)
- load directory tools under a namespaced module key [tool] (https://github.com/strands-agents/harness-sdk/pull/2994)
- set Strands user agent for Nova Sonic client [bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/2132)
- support vLLM v0.16.0+ reasoning field in streaming and non-streaming paths [model] (https://github.com/strands-agents/harness-sdk/pull/3252)
- detect throttling via ClientError status attribute [model] (https://github.com/strands-agents/harness-sdk/pull/3228)
- place cache point before non-PDF document blocks [model] (https://github.com/strands-agents/harness-sdk/pull/2001)
- prevent symlink attacks in FileSessionManager [persistence] (https://github.com/strands-agents/harness-sdk/pull/2937)

### Other
- bump actions/checkout from 6 to 7 (https://github.com/strands-agents/harness-sdk/pull/3138)
- group Python dev tooling by name pattern (https://github.com/strands-agents/harness-sdk/pull/3171)
- scale description length to diff size (https://github.com/strands-agents/harness-sdk/pull/3183)
- run docs CI on python and typescript changes (https://github.com/strands-agents/harness-sdk/pull/3178)
- sync bot fork with upstream before opening PRs (https://github.com/strands-agents/harness-sdk/pull/3179)
- update Nova Sonic docs for v2 and fix stale references [bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/3195)
- trigger changelog sync directly from the release workflows (https://github.com/strands-agents/harness-sdk/pull/3193)
- revert chore(deps): relax litellm upper bound to \<2.0.0 (#3149) [model] (https://github.com/strands-agents/harness-sdk/pull/3223)
- document Bedrock strict\_tools schema constraints [devx, model] (https://github.com/strands-agents/harness-sdk/pull/3261)
- guard sync job to upstream; document workflow-scope requirement (https://github.com/strands-agents/harness-sdk/pull/3278)
- bump actions/setup-node from 6 to 7 (https://github.com/strands-agents/harness-sdk/pull/3229)
- remove dead private code (https://github.com/strands-agents/harness-sdk/pull/3286)
- deduplicate pr guidelines summary in sdk agents files (https://github.com/strands-agents/harness-sdk/pull/3293)

## SDK TypeScript v1.10.0 — 2026-07-17
Release: https://github.com/strands-agents/harness-sdk/releases/tag/typescript/v1.10.0 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/1.10.0

### Features
- add unified storage interface [hooks, persistence] (https://github.com/strands-agents/harness-sdk/pull/3099)
- added gen\_ai\_span\_attributes\_only var to skip event attributes [otel] (https://github.com/strands-agents/harness-sdk/pull/3194)
- auto-namespace unified Storage under offloader [context, persistence] (https://github.com/strands-agents/harness-sdk/pull/3258)

### Fixes
- place cache point before non-PDF document blocks [model] (https://github.com/strands-agents/harness-sdk/pull/2001)
- use /openai/v1 Mantle base URL for the Responses API [model] (https://github.com/strands-agents/harness-sdk/pull/3280)

### Other
- sync bot fork with upstream before opening PRs (https://github.com/strands-agents/harness-sdk/pull/3179)
- trigger changelog sync directly from the release workflows (https://github.com/strands-agents/harness-sdk/pull/3193)
- extract generic async Queue from multiagent [async, multiagent] (https://github.com/strands-agents/harness-sdk/pull/3262)
- guard sync job to upstream; document workflow-scope requirement (https://github.com/strands-agents/harness-sdk/pull/3278)
- bump actions/setup-node from 6 to 7 (https://github.com/strands-agents/harness-sdk/pull/3229)
- remove dead barrel and obsolete types package (https://github.com/strands-agents/harness-sdk/pull/3285)
- deduplicate pr guidelines summary in sdk agents files (https://github.com/strands-agents/harness-sdk/pull/3293)
- deduplicate testing guide and agents file (https://github.com/strands-agents/harness-sdk/pull/3291)

## SDK Python v1.47.0 — 2026-07-10
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.47.0 · Package: https://pypi.org/project/strands-agents/1.47.0/

### Features
- map labels to native issue type and language field (https://github.com/strands-agents/harness-sdk/pull/2984)
- add durable identifiers to messages [sessions] (https://github.com/strands-agents/harness-sdk/pull/2836)
- publish TypeScript integ test metrics to CloudWatch (https://github.com/strands-agents/harness-sdk/pull/3134)
- add continue\_on\_error to MCP client [devx, mcp] (https://github.com/strands-agents/harness-sdk/pull/3101)
- added span redaction [otel] (https://github.com/strands-agents/harness-sdk/pull/3111)

### Fixes
- validate the AWS region before building the Nova Sonic endpoint URL [model, bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/2990)
- remove duplicate client creation in Nova Sonic start() [bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/3124)
- fix typo and inconsistent error messages across model providers [devx, bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/3125)
- declarative rebuild for \_fix\_broken\_tool\_use [context, sessions] (https://github.com/strands-agents/harness-sdk/pull/3119)
- export BidiConnectionRestartEvent and add 8kHz sample rate support [devx, bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/3127)
- encode bytes in SessionAgent.to\_dict() for JSON serialization [persistence, sessions] (https://github.com/strands-agents/harness-sdk/pull/3117)
- harden npm lifecycle scripts for best practices (https://github.com/strands-agents/harness-sdk/pull/3128)
- rename LocalMemoryStore to TestMemoryStore (https://github.com/strands-agents/harness-sdk/pull/3123)
- handle tool usage after reasoning content [model, tool] (https://github.com/strands-agents/harness-sdk/pull/1647)
- handle tool use metadata in contentBlockDelta for non-standard models [model, agent] (https://github.com/strands-agents/harness-sdk/pull/2077)

### Other
- add changelog generator and sync workflow (https://github.com/strands-agents/harness-sdk/pull/2765)
- fixed typescript release-workflow not running integ tests (https://github.com/strands-agents/harness-sdk/pull/3126)
- bump peter-evans/create-pull-request from 7.0.11 to 8.1.1 (https://github.com/strands-agents/harness-sdk/pull/3135)
- improve agent guidance on issue references in regression tests (https://github.com/strands-agents/harness-sdk/pull/3146)
- route message appends through Agent.\_append\_messages [agent] (https://github.com/strands-agents/harness-sdk/pull/3131)
- tweak pr-writer skill to be more concise (https://github.com/strands-agents/harness-sdk/pull/3148)
- update litellm requirement from \<=1.91.0,\>=1.75.9 to \>=1.75.9,\<=1.91.1 in /strands-py (https://github.com/strands-agents/harness-sdk/pull/3142)
- relax litellm upper bound to \<2.0.0 [model] (https://github.com/strands-agents/harness-sdk/pull/3149)

## SDK TypeScript v1.9.0 — 2026-07-10
Release: https://github.com/strands-agents/harness-sdk/releases/tag/typescript/v1.9.0 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/1.9.0

### Features
- expose metrics getter on LocalAgent [devx, agent] (https://github.com/strands-agents/harness-sdk/pull/3116)
- map labels to native issue type and language field (https://github.com/strands-agents/harness-sdk/pull/2984)
- add durable identifiers to messages [sessions] (https://github.com/strands-agents/harness-sdk/pull/2836)
- publish TypeScript integ test metrics to CloudWatch (https://github.com/strands-agents/harness-sdk/pull/3134)
- port durable-execution checkpoints to TypeScript [language, persistence] (https://github.com/strands-agents/harness-sdk/pull/3103)
- allow ports in either direction (https://github.com/strands-agents/harness-sdk/pull/3160)

### Fixes
- harden npm lifecycle scripts for best practices (https://github.com/strands-agents/harness-sdk/pull/3128)
- rename LocalMemoryStore to TestMemoryStore (https://github.com/strands-agents/harness-sdk/pull/3123)
- upgrade ts release workflow to npm 12 (https://github.com/strands-agents/harness-sdk/pull/3188)

### Other
- add changelog generator and sync workflow (https://github.com/strands-agents/harness-sdk/pull/2765)
- fixed typescript release-workflow not running integ tests (https://github.com/strands-agents/harness-sdk/pull/3126)
- bump peter-evans/create-pull-request from 7.0.11 to 8.1.1 (https://github.com/strands-agents/harness-sdk/pull/3135)
- improve agent guidance on issue references in regression tests (https://github.com/strands-agents/harness-sdk/pull/3146)
- bump the development-dependencies group across 1 directory with 16 updates (https://github.com/strands-agents/harness-sdk/pull/3143)
- tweak pr-writer skill to be more concise (https://github.com/strands-agents/harness-sdk/pull/3148)
- bump @aws-sdk/client-bedrock-runtime from 3.1075.0 to 3.1078.0 in the production-minor group across 1 directory (https://github.com/strands-agents/harness-sdk/pull/3108)
- bump actions/checkout from 6 to 7 (https://github.com/strands-agents/harness-sdk/pull/3138)
- group Python dev tooling by name pattern (https://github.com/strands-agents/harness-sdk/pull/3171)
- export Checkpoint APIs only from /experimental [devx, persistence] (https://github.com/strands-agents/harness-sdk/pull/3180)
- scale description length to diff size (https://github.com/strands-agents/harness-sdk/pull/3183)
- run docs CI on python and typescript changes (https://github.com/strands-agents/harness-sdk/pull/3178)

## Evals v1.0.2 — 2026-07-09
Release: https://github.com/strands-agents/evals/releases/tag/v1.0.2 · Package: https://pypi.org/project/strands-agents-evals/1.0.2/

### Fixes
- rename structured-output models off leading underscore [redteam] (https://github.com/strands-agents/evals/pull/294)

### Other
- added evals full release workflow (https://github.com/strands-agents/evals/pull/302)
- add aggregate CI Gate status check (https://github.com/strands-agents/evals/pull/303)

## SDK TypeScript v1.8.0 — 2026-07-08
Release: https://github.com/strands-agents/harness-sdk/releases/tag/typescript/v1.8.0 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/1.8.0

### Features
- result handling, model-state isolation, and system-prompt fidelity [hooks, model] (https://github.com/strands-agents/harness-sdk/pull/2812)
- add local memory store [persistence] (https://github.com/strands-agents/harness-sdk/pull/2859)
- add Port Request template [language] (https://github.com/strands-agents/harness-sdk/pull/3009)
- load MCP servers from JSON [mcp, config] (https://github.com/strands-agents/harness-sdk/pull/2947)
- add storage design doc proposal [persistence] (https://github.com/strands-agents/harness-sdk/pull/3080)
- preserve MCP output schemas [mcp] (https://github.com/strands-agents/harness-sdk/pull/3109)

### Fixes
- fixed memory test failure (https://github.com/strands-agents/harness-sdk/pull/3020)
- allow interface return types from tool callbacks [language, tool] (https://github.com/strands-agents/harness-sdk/pull/3025)
- emit valid json for null/undefined tool returns [language, tool] (https://github.com/strands-agents/harness-sdk/pull/3024)
- preserve body when search output exceeds max\_chars [tool] (https://github.com/strands-agents/harness-sdk/pull/3065)
- buffer graph node printer output to prevent interleaving [async, multiagent] (https://github.com/strands-agents/harness-sdk/pull/3077)
- drop blank text content blocks before send [model] (https://github.com/strands-agents/harness-sdk/pull/3029)
- guard upload-metrics on integration-test job result (https://github.com/strands-agents/harness-sdk/pull/3102)
- confine retrieved paths to the artifact directory [context, persistence] (https://github.com/strands-agents/harness-sdk/pull/3035)
- create release tag via git push instead of gh release --target (https://github.com/strands-agents/harness-sdk/pull/3115)
- exclude test artifacts from package (https://github.com/strands-agents/harness-sdk/pull/3055)

### Other
- add Strandslator design doc [language] (https://github.com/strands-agents/harness-sdk/pull/2790)
- improve agent guidance (https://github.com/strands-agents/harness-sdk/pull/2959)
- change-based selective integration testing (https://github.com/strands-agents/harness-sdk/pull/2921)
- move strandslator design docs into team/designs (https://github.com/strands-agents/harness-sdk/pull/3006)
- restrict issue responder to collaborators and pin action version (https://github.com/strands-agents/harness-sdk/pull/2991)
- add CODEOWNERS to scaffold PR assignment (https://github.com/strands-agents/harness-sdk/pull/3078)
- bump astral-sh/setup-uv from 7.6.0 to 8.2.0 (https://github.com/strands-agents/harness-sdk/pull/2974)
- bump the development-dependencies group across 1 directory with 9 updates (https://github.com/strands-agents/harness-sdk/pull/3075)
- bump commander from 14.0.3 to 15.0.0 (https://github.com/strands-agents/harness-sdk/pull/2999)
- bump dorny/paths-filter from 4.0.1 to 4.0.2 (https://github.com/strands-agents/harness-sdk/pull/3083)
- bump astral-sh/setup-uv from 8.2.0 to 8.3.0 (https://github.com/strands-agents/harness-sdk/pull/3094)
- bump the development-dependencies group across 1 directory with 10 updates (https://github.com/strands-agents/harness-sdk/pull/3098)
- added release workflow (https://github.com/strands-agents/harness-sdk/pull/2940)
- fix integration test runs (https://github.com/strands-agents/harness-sdk/pull/3112)

## SDK Python v1.46.0 — 2026-07-07
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.46.0 · Package: https://pypi.org/project/strands-agents/1.46.0/

### Features
- telemetry for memory manager [otel] (https://github.com/strands-agents/harness-sdk/pull/2858)
- result handling, model-state isolation, and system-prompt fidelity [hooks, model] (https://github.com/strands-agents/harness-sdk/pull/2812)
- add local memory store [persistence] (https://github.com/strands-agents/harness-sdk/pull/2859)
- add Port Request template [language] (https://github.com/strands-agents/harness-sdk/pull/3009)
- load MCP servers from JSON [mcp, config] (https://github.com/strands-agents/harness-sdk/pull/3053)
- pass per-message sequence numbers to add\_messages [persistence, sessions] (https://github.com/strands-agents/harness-sdk/pull/3030)
- add storage design doc proposal [persistence] (https://github.com/strands-agents/harness-sdk/pull/3080)

### Fixes
- raise specific error for interrupt responses without active interrupt state [devx, hil] (https://github.com/strands-agents/harness-sdk/pull/1979)
- normalize 3gp video format [model] (https://github.com/strands-agents/harness-sdk/pull/2306)
- map webp images explicitly [model] (https://github.com/strands-agents/harness-sdk/pull/2304)
- prevent reset\_executor\_state from corrupting MultiAgentBase state [multiagent] (https://github.com/strands-agents/harness-sdk/pull/1988)
- raise ContextWindowOverflowException for ollama/llama/mistral/writer [context, model] (https://github.com/strands-agents/harness-sdk/pull/2958)
- update outdated document url of exception note [model] (https://github.com/strands-agents/harness-sdk/pull/2049)
- treat guardContent qualifiers as optional [model, interventions] (https://github.com/strands-agents/harness-sdk/pull/3027)
- surface cache\_read/write input tokens in metadata chunk [model] (https://github.com/strands-agents/harness-sdk/pull/2302)
- route gpt-5 mantle traffic through /openai/v1 base path [model] (https://github.com/strands-agents/harness-sdk/pull/3032)
- drop misleading gen\_ai.agent.name from multiagent spans [multiagent, otel] (https://github.com/strands-agents/harness-sdk/pull/3023)
- preserve body when search output exceeds max\_chars [context] (https://github.com/strands-agents/harness-sdk/pull/3064)
- log exception type instead of full traceback on cycle failure [otel, agent] (https://github.com/strands-agents/harness-sdk/pull/2989)
- record tool\_trace on interrupted tool calls [otel, hil] (https://github.com/strands-agents/harness-sdk/pull/3031)
- exclude edges from bypassed nodes in resume AND-join [multiagent] (https://github.com/strands-agents/harness-sdk/pull/3069)
- preserve failed status reported by graph nodes [multiagent] (https://github.com/strands-agents/harness-sdk/pull/3028)
- repair mid-iteration skip of orphaned toolUse [context, sessions] (https://github.com/strands-agents/harness-sdk/pull/3026)
- guard upload-metrics on integration-test job result (https://github.com/strands-agents/harness-sdk/pull/3102)
- validate transcript message roles [bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/3037)
- create release tag via git push instead of gh release --target (https://github.com/strands-agents/harness-sdk/pull/3115)

### Other
- update litellm requirement from \<=1.89.3,\>=1.75.9 to \>=1.75.9,\<=1.89.4 in /strands-py (https://github.com/strands-agents/harness-sdk/pull/2960)
- revert pinning virtualenv now that hatch 1.16.5 is out (https://github.com/strands-agents/harness-sdk/pull/1780)
- add Strandslator design doc [language] (https://github.com/strands-agents/harness-sdk/pull/2790)
- fix two broken main tests (https://github.com/strands-agents/harness-sdk/pull/2982)
- improve agent guidance (https://github.com/strands-agents/harness-sdk/pull/2959)
- move strandslator design docs into team/designs (https://github.com/strands-agents/harness-sdk/pull/3006)
- add TypeScript-to-Python porting guide (https://github.com/strands-agents/harness-sdk/pull/3010)
- restrict issue responder to collaborators and pin action version (https://github.com/strands-agents/harness-sdk/pull/2991)
- add CODEOWNERS to scaffold PR assignment (https://github.com/strands-agents/harness-sdk/pull/3078)
- bump astral-sh/setup-uv from 7.6.0 to 8.2.0 (https://github.com/strands-agents/harness-sdk/pull/2974)
- update google-genai requirement from \<2.0.0,\>=1.32.0 to \>=1.32.0,\<3.0.0 in /strands-py (https://github.com/strands-agents/harness-sdk/pull/2927)
- bump cedarpy from 4.8.5 to 4.8.6 in /strands-py (https://github.com/strands-agents/harness-sdk/pull/2997)
- update litellm requirement from \<=1.89.4,\>=1.75.9 to \>=1.75.9,\<=1.90.2 in /strands-py (https://github.com/strands-agents/harness-sdk/pull/3057)
- bump commander from 14.0.3 to 15.0.0 (https://github.com/strands-agents/harness-sdk/pull/2999)
- bump dorny/paths-filter from 4.0.1 to 4.0.2 (https://github.com/strands-agents/harness-sdk/pull/3083)
- bump astral-sh/setup-uv from 8.2.0 to 8.3.0 (https://github.com/strands-agents/harness-sdk/pull/3094)
- update litellm requirement from \<=1.90.2,\>=1.75.9 to \>=1.75.9,\<=1.91.0 in /strands-py (https://github.com/strands-agents/harness-sdk/pull/3097)
- added release workflow (https://github.com/strands-agents/harness-sdk/pull/2940)
- drop unused snapshot and app\_data fields [hil, persistence] (https://github.com/strands-agents/harness-sdk/pull/3104)
- fix integration test runs (https://github.com/strands-agents/harness-sdk/pull/3112)

## SDK Python v1.45.0 — 2026-06-25
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.45.0 · Package: https://pypi.org/project/strands-agents/1.45.0/

### Features
- support mistralai 2.x in Mistral provider [model] (https://github.com/strands-agents/harness-sdk/pull/2917)
- add pre-push skill mirroring the CI merge gate locally [devx] (https://github.com/strands-agents/harness-sdk/pull/2856)
- support image input via BidiImageInputEvent [model, bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/2327)
- make BedrockModel.\_format\_request and \_convert\_non\_streaming\_to… [model] (https://github.com/strands-agents/harness-sdk/pull/2315)
- add search/grep support to Python retrieval tool [context, tool] (https://github.com/strands-agents/harness-sdk/pull/2878)
- added per-invocation idempotency support via idempotency\_token [async, agent] (https://github.com/strands-agents/harness-sdk/pull/1937)
- support managed Bedrock knowledge bases in retrieve and ACL [model, tool] (https://github.com/strands-agents/harness-sdk/pull/2909)
- implement MCP progress notifications in MCPClient [mcp] (https://github.com/strands-agents/harness-sdk/pull/2290)

### Fixes
- bound tool schema normalization recursion depth [mcp, tool] (https://github.com/strands-agents/harness-sdk/pull/2853)
- make gemini thinking-model tool-call integ test robust [model] (https://github.com/strands-agents/harness-sdk/pull/2861)
- retry flaky guardrail output-intervention test [interventions] (https://github.com/strands-agents/harness-sdk/pull/2869)
- raise timeout on multimodal swarm/graph integ tests to reduce flakiness [multiagent] (https://github.com/strands-agents/harness-sdk/pull/2871)
- report OpenAI Responses cached tokens [model] (https://github.com/strands-agents/harness-sdk/pull/2663)
- include reasoning block with empty text and non-empty signature [agent] (https://github.com/strands-agents/harness-sdk/pull/2150)
- handle empty Bedrock content blocks [model] (https://github.com/strands-agents/harness-sdk/pull/2656)
- support non-streaming OpenAI chat completions [model] (https://github.com/strands-agents/harness-sdk/pull/2400)
- preserve non-ASCII tool result text [tool] (https://github.com/strands-agents/harness-sdk/pull/2653)
- fix on-demand throughput doc URL to preserve anchor fragment [model] (https://github.com/strands-agents/harness-sdk/pull/2228)
- pass structured output request params [model, structured-output] (https://github.com/strands-agents/harness-sdk/pull/2396)
- preserve non-ASCII text in provider tool-result and tool-call serialization [model] (https://github.com/strands-agents/harness-sdk/pull/2661)
- consume orphaned task exception on stream cancellation [async, model] (https://github.com/strands-agents/harness-sdk/pull/2916)
- avoid UnboundLocalError on empty model stream [model] (https://github.com/strands-agents/harness-sdk/pull/2823)
- surface cache read tokens in metadata chunk [context, model] (https://github.com/strands-agents/harness-sdk/pull/2555)
- prevent tool list mutation across API calls [model] (https://github.com/strands-agents/harness-sdk/pull/2551)
- stop idempotency waiters from blocking thread-pool workers [async, agent] (https://github.com/strands-agents/harness-sdk/pull/2932)
- clarify MaxTokensReachedException message [context, devx] (https://github.com/strands-agents/harness-sdk/pull/2201)
- forward structured output request params for OpenAI Chat Completions [model, structured-output] (https://github.com/strands-agents/harness-sdk/pull/2944)
- release invocation lock only in throw mode [async, agent] (https://github.com/strands-agents/harness-sdk/pull/2954)
- generate toolUseId when missing from provider [model, tool] (https://github.com/strands-agents/harness-sdk/pull/2949)
- prevent false-positive test failures when output is piped [agent] (https://github.com/strands-agents/harness-sdk/pull/2963)
- respect role from BidiTextInputEvent [bidirectional-streaming] (https://github.com/strands-agents/harness-sdk/pull/2952)
- sha-pin third-party GitHub Actions (https://github.com/strands-agents/harness-sdk/pull/2964)
- unwrap FieldInfo default to avoid pydantic warning [devx, tool] (https://github.com/strands-agents/harness-sdk/pull/2955)
- bypass model\_dump on content\_block\_stop [model] (https://github.com/strands-agents/harness-sdk/pull/2953)
- update GeminiModel to handle empty tools in Vertex AI mode [model] (https://github.com/strands-agents/harness-sdk/pull/1040)

### Other
- type the Bedrock KB store's S3 client via boto3-stubs [model, persistence] (https://github.com/strands-agents/harness-sdk/pull/2847)
- add memory manager docs (https://github.com/strands-agents/harness-sdk/pull/2758)
- add sandbox docs [server] (https://github.com/strands-agents/harness-sdk/pull/2854)
- require 2 maintainer reviews on bot/agent PRs (https://github.com/strands-agents/harness-sdk/pull/2755)
- add SSH sandbox integration tests for Py and TS [server] (https://github.com/strands-agents/harness-sdk/pull/2863)
- bump codecov/codecov-action from 6 to 7 (https://github.com/strands-agents/harness-sdk/pull/2657)
- bump cedarpy from 4.8.0 to 4.8.4 in /strands-py (https://github.com/strands-agents/harness-sdk/pull/2852)
- update pytest-asyncio requirement from \<1.4.0,\>=1.0.0 to \>=1.0.0,\<1.5.0 in /strands-py (https://github.com/strands-agents/harness-sdk/pull/2337)
- add timeouts and apt retries to test-lint workflow (https://github.com/strands-agents/harness-sdk/pull/2874)
- bump actions/checkout from 6 to 7 (https://github.com/strands-agents/harness-sdk/pull/2876)
- update dependencies and refactor dev tooling internals (https://github.com/strands-agents/harness-sdk/pull/2870)
- opt back into fork-PR checkout under pull\_request\_target (https://github.com/strands-agents/harness-sdk/pull/2879)
- gate dependency vulns on PR-introduced changes only (https://github.com/strands-agents/harness-sdk/pull/2872)
- bump cedarpy from 4.8.4 to 4.8.5 in /strands-py (https://github.com/strands-agents/harness-sdk/pull/2890)
- update litellm requirement from \<=1.83.13,\>=1.75.9 to \>=1.75.9,\<=1.89.3 in /strands-py (https://github.com/strands-agents/harness-sdk/pull/2889)
- update ruff requirement from \<0.15.0,\>=0.13.0 to \>=0.13.0,\<0.16.0 in /strands-py (https://github.com/strands-agents/harness-sdk/pull/2334)
- update mistralai requirement from \<2.0.0,\>=1.8.2 to \>=1.8.2,\<3.0.0 in /strands-py (https://github.com/strands-agents/harness-sdk/pull/2331)
- update writer-sdk requirement from \<3.0.0,\>=2.2.0 to \>=2.2.0,\<4.0.0 in /strands-py (https://github.com/strands-agents/harness-sdk/pull/2621)
- tighten dependabot versioning strategy (https://github.com/strands-agents/harness-sdk/pull/2899)
- revert mistralai upper bound to \<2.0.0 (https://github.com/strands-agents/harness-sdk/pull/2900)
- bump actions/dependency-review-action from 4 to 5 (https://github.com/strands-agents/harness-sdk/pull/2903)
- add a reasoning bridge to the design doc template (https://github.com/strands-agents/harness-sdk/pull/2907)
- bump actions/checkout from 6 to 7 (https://github.com/strands-agents/harness-sdk/pull/2904)
- unify Dependabot grouping and cooldown across all ecosystems (https://github.com/strands-agents/harness-sdk/pull/2901)
- add TESTING.md for python (https://github.com/strands-agents/harness-sdk/pull/2961)
- improve testing instructions (https://github.com/strands-agents/harness-sdk/pull/2965)
- skip SDK test matrices on markdown-only changes (https://github.com/strands-agents/harness-sdk/pull/2967)

## SDK TypeScript v1.7.0 — 2026-06-25
Release: https://github.com/strands-agents/harness-sdk/releases/tag/typescript/v1.7.0 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/1.7.0

### Features
- add pre-push skill mirroring the CI merge gate locally [devx] (https://github.com/strands-agents/harness-sdk/pull/2856)
- add namespace option for namespaced Cedar policies [interventions] (https://github.com/strands-agents/harness-sdk/pull/2896)
- support managed Bedrock knowledge bases in retrieve and ACL [model, tool] (https://github.com/strands-agents/harness-sdk/pull/2909)
- telemetry for memory manager [otel] (https://github.com/strands-agents/harness-sdk/pull/2858)

### Fixes
- report Responses prompt-cache tokens (TypeScript) [otel, model] (https://github.com/strands-agents/harness-sdk/pull/2782)
- handle non-string error code in classifyOpenAIError [devx, model] (https://github.com/strands-agents/harness-sdk/pull/2850)
- disambiguate Gemini tool-result part displayNames [model] (https://github.com/strands-agents/harness-sdk/pull/2881)
- prevent false-positive test failures when output is piped [agent] (https://github.com/strands-agents/harness-sdk/pull/2963)
- sha-pin third-party GitHub Actions (https://github.com/strands-agents/harness-sdk/pull/2964)
- run bedrock-kb store test in node only (https://github.com/strands-agents/harness-sdk/pull/2966)
- filter graph dependency reasoning blocks [multiagent, model] (https://github.com/strands-agents/harness-sdk/pull/2883)

### Other
- add memory manager docs (https://github.com/strands-agents/harness-sdk/pull/2758)
- require 2 maintainer reviews on bot/agent PRs (https://github.com/strands-agents/harness-sdk/pull/2755)
- raise timeout for sandbox isolation test [server] (https://github.com/strands-agents/harness-sdk/pull/2842)
- add SSH sandbox integration tests for Py and TS [server] (https://github.com/strands-agents/harness-sdk/pull/2863)
- bump codecov/codecov-action from 6 to 7 (https://github.com/strands-agents/harness-sdk/pull/2657)
- bump @aws-sdk/client-bedrock-runtime from 3.1058.0 to 3.1066.0 in the production-minor group across 1 directory (https://github.com/strands-agents/harness-sdk/pull/2708)
- add timeouts and apt retries to test-lint workflow (https://github.com/strands-agents/harness-sdk/pull/2874)
- bump actions/checkout from 6 to 7 (https://github.com/strands-agents/harness-sdk/pull/2876)
- update dependencies and refactor dev tooling internals (https://github.com/strands-agents/harness-sdk/pull/2870)
- opt back into fork-PR checkout under pull\_request\_target (https://github.com/strands-agents/harness-sdk/pull/2879)
- remove abandoned wasm TypeScript-to-Python experiment (https://github.com/strands-agents/harness-sdk/pull/2838)
- gate dependency vulns on PR-introduced changes only (https://github.com/strands-agents/harness-sdk/pull/2872)
- tighten dependabot versioning strategy (https://github.com/strands-agents/harness-sdk/pull/2899)
- bump actions/dependency-review-action from 4 to 5 (https://github.com/strands-agents/harness-sdk/pull/2903)
- add a reasoning bridge to the design doc template (https://github.com/strands-agents/harness-sdk/pull/2907)
- bump @aws-sdk/client-bedrock-runtime from 3.1066.0 to 3.1069.0 in the production-minor group across 1 directory (https://github.com/strands-agents/harness-sdk/pull/2877)
- bump actions/checkout from 6 to 7 (https://github.com/strands-agents/harness-sdk/pull/2904)
- unify Dependabot grouping and cooldown across all ecosystems (https://github.com/strands-agents/harness-sdk/pull/2901)
- bump bulk minors and patches (https://github.com/strands-agents/harness-sdk/pull/2933)
- bump dev-dependency majors (https://github.com/strands-agents/harness-sdk/pull/2935)
- add TESTING.md for python (https://github.com/strands-agents/harness-sdk/pull/2961)
- improve testing instructions (https://github.com/strands-agents/harness-sdk/pull/2965)
- skip SDK test matrices on markdown-only changes (https://github.com/strands-agents/harness-sdk/pull/2967)
- bump uuid from 14.0.0 to 14.0.1 in the production-minor group across 1 directory (https://github.com/strands-agents/harness-sdk/pull/2957)
- revert pinning virtualenv now that hatch 1.16.5 is out (https://github.com/strands-agents/harness-sdk/pull/1780)

## Evals v1.0.1 — 2026-06-25
Release: https://github.com/strands-agents/evals/releases/tag/v1.0.1 · Package: https://pypi.org/project/strands-agents-evals/1.0.1/

### Fixes
- provide tool parameters in evaluation prompt, update refusal and helpfulness prompts [evaluators] (https://github.com/strands-agents/evals/pull/278)

### Other
- bump actions/github-script from 8 to 9 (https://github.com/strands-agents/evals/pull/193)
- added fetch command to pull traces from different sources [cli, tracing] (https://github.com/strands-agents/evals/pull/276)
- bump actions/checkout from 6 to 7 (https://github.com/strands-agents/evals/pull/280)
- update opentelemetry-instrumentation-langchain requirement from \<0.50.0,\>=0.40.0 to \>=0.40.0,\<0.62.0 [tracing] (https://github.com/strands-agents/evals/pull/237)
- bump actions/github-script from 8 to 9 (https://github.com/strands-agents/evals/pull/279)
- update pytest-asyncio requirement from \<1.4.0,\>=1.0.0 to \>=1.0.0,\<1.5.0 (https://github.com/strands-agents/evals/pull/233)
- bump actions/download-artifact from 7 to 8 (https://github.com/strands-agents/evals/pull/148)
- update ruff requirement from \<0.15.0,\>=0.13.0 to \>=0.13.0,\<0.16.0 (https://github.com/strands-agents/evals/pull/116)
- bump actions/upload-artifact from 6 to 7 (https://github.com/strands-agents/evals/pull/149)
- tighten dependabot versioning strategy (https://github.com/strands-agents/evals/pull/281)

## SDK Python v1.44.0 — 2026-06-16
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.44.0 · Package: https://pypi.org/project/strands-agents/1.44.0/

### Features
- add turn-based eviction to InMemoryStorage [context] (https://github.com/strands-agents/harness-sdk/pull/2648)
- add internal middleware system for InvokeModelStage [hooks, model] (https://github.com/strands-agents/harness-sdk/pull/2760)
- pass invocation\_state to edge condition calls [multiagent, hil] (https://github.com/strands-agents/harness-sdk/pull/2642)
- port memory manager and extraction to Python [async, hooks, persistence] (https://github.com/strands-agents/harness-sdk/pull/2740)
- add GoalLoop vended plugin with docs [hooks, structured-output] (https://github.com/strands-agents/harness-sdk/pull/2738)
- add Agent memory\_manager param with configurable sync auto-flush [persistence, agent] (https://github.com/strands-agents/harness-sdk/pull/2795)
- add memory injection (https://github.com/strands-agents/harness-sdk/pull/2797)
- add default for memory extraction trigger (https://github.com/strands-agents/harness-sdk/pull/2811)
- port agentic context management to python [context] (https://github.com/strands-agents/harness-sdk/pull/2808)
- port HumanInTheLoop vended intervention to Python [hil, interventions] (https://github.com/strands-agents/harness-sdk/pull/2750)
- integrate Sandbox with Agent [server, agent] (https://github.com/strands-agents/harness-sdk/pull/2762)
- add Cedar authorization handler for Python [tool, interventions] (https://github.com/strands-agents/harness-sdk/pull/2802)
- port BedrockKnowledgeBaseStore to strands-py [model, persistence] (https://github.com/strands-agents/harness-sdk/pull/2834)
- vended tools/plugins for sandbox [tool, server] (https://github.com/strands-agents/harness-sdk/pull/2835)

### Fixes
- remove pin messaging barrel export [context, devx] (https://github.com/strands-agents/harness-sdk/pull/2767)
- reduce workflow noise from deployment history and label churn (https://github.com/strands-agents/harness-sdk/pull/2766)
- consolidate PR guidelines and update pr-writer skill (https://github.com/strands-agents/harness-sdk/pull/2772)
- allow sync or async InterventionHandler lifecycle overrides [async, interventions] (https://github.com/strands-agents/harness-sdk/pull/2800)
- mark internal memory functions as private (https://github.com/strands-agents/harness-sdk/pull/2817)

### Other
- add message pinning section to conversation management page [context] (https://github.com/strands-agents/harness-sdk/pull/2749)
- design: add context management presets design doc [context] (https://github.com/strands-agents/harness-sdk/pull/2756)
- add Syntax component for inline language-specific identifiers [documentation] (https://github.com/strands-agents/harness-sdk/pull/2751)
- improve monorepo clarity for releases and issues (https://github.com/strands-agents/harness-sdk/pull/2759)
- bump esbuild version (https://github.com/strands-agents/harness-sdk/pull/2785)
- consolidate dev docs into a consistent home (https://github.com/strands-agents/harness-sdk/pull/2791)
- suppress verbose logging in tests with large text payloads [devx] (https://github.com/strands-agents/harness-sdk/pull/2773)
- point PR reviewers at docs skills for site/ changes (https://github.com/strands-agents/harness-sdk/pull/2794)
- apply ruff format to fix pre-existing drift in strands-py (https://github.com/strands-agents/harness-sdk/pull/2799)
- point PR reviewers at docs skills for site/ changes (https://github.com/strands-agents/harness-sdk/pull/2807)
- add CLAUDE.md files (https://github.com/strands-agents/harness-sdk/pull/2809)
- represent passed-in config types as TypedDicts [devx] (https://github.com/strands-agents/harness-sdk/pull/2824)
- represent ExtractionConfig as a TypedDict [devx] (https://github.com/strands-agents/harness-sdk/pull/2827)
- drop redundant \`| None\` from optional config fields [devx] (https://github.com/strands-agents/harness-sdk/pull/2832)
- remove lockfile drift check to unblock Dependabot and audit fixes (https://github.com/strands-agents/harness-sdk/pull/2841)
- bump hono to 4.12.25 to fix high-severity audit failure (https://github.com/strands-agents/harness-sdk/pull/2843)
- assert S3 sidecar metadata and scope round-trip [persistence] (https://github.com/strands-agents/harness-sdk/pull/2840)

## SDK TypeScript v1.6.0 — 2026-06-16
Release: https://github.com/strands-agents/harness-sdk/releases/tag/typescript/v1.6.0 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/1.6.0

### Features
- copy middleware context inputs to prevent accidental mutation [hooks, agent] (https://github.com/strands-agents/harness-sdk/pull/2742)
- add turn-based eviction to InMemoryStorage [context] (https://github.com/strands-agents/harness-sdk/pull/2648)
- memory injection [context, agent] (https://github.com/strands-agents/harness-sdk/pull/2631)
- add internal middleware system for InvokeModelStage [hooks, model] (https://github.com/strands-agents/harness-sdk/pull/2760)
- add cedar vended intervention handler [interventions] (https://github.com/strands-agents/harness-sdk/pull/2365)
- add agentic context management with model-driven compression tools [context, agent] (https://github.com/strands-agents/harness-sdk/pull/2754)
- add memory injection (https://github.com/strands-agents/harness-sdk/pull/2797)
- port agentic context management to python [context] (https://github.com/strands-agents/harness-sdk/pull/2808)

### Fixes
- remove pin messaging barrel export [context, devx] (https://github.com/strands-agents/harness-sdk/pull/2767)
- reduce workflow noise from deployment history and label churn (https://github.com/strands-agents/harness-sdk/pull/2766)
- correct fixture path in integration test (https://github.com/strands-agents/harness-sdk/pull/2810)

### Other
- add message pinning section to conversation management page [context] (https://github.com/strands-agents/harness-sdk/pull/2749)
- design: add context management presets design doc [context] (https://github.com/strands-agents/harness-sdk/pull/2756)
- add Syntax component for inline language-specific identifiers [documentation] (https://github.com/strands-agents/harness-sdk/pull/2751)
- improve monorepo clarity for releases and issues (https://github.com/strands-agents/harness-sdk/pull/2759)
- bump esbuild version (https://github.com/strands-agents/harness-sdk/pull/2785)
- add integration test for memory manager [context] (https://github.com/strands-agents/harness-sdk/pull/2764)
- consolidate dev docs into a consistent home (https://github.com/strands-agents/harness-sdk/pull/2791)
- point PR reviewers at docs skills for site/ changes (https://github.com/strands-agents/harness-sdk/pull/2794)
- point PR reviewers at docs skills for site/ changes (https://github.com/strands-agents/harness-sdk/pull/2807)
- add CLAUDE.md files (https://github.com/strands-agents/harness-sdk/pull/2809)
- isolate KB search/add tool tests from auto-injection [tool] (https://github.com/strands-agents/harness-sdk/pull/2825)
- remove lockfile drift check to unblock Dependabot and audit fixes (https://github.com/strands-agents/harness-sdk/pull/2841)
- bump hono to 4.12.25 to fix high-severity audit failure (https://github.com/strands-agents/harness-sdk/pull/2843)
- assert S3 sidecar metadata and scope round-trip [persistence] (https://github.com/strands-agents/harness-sdk/pull/2840)
- inline tool prefixing into getTools implementations [server] (https://github.com/strands-agents/harness-sdk/pull/2806)

## Evals v1.0.0 — 2026-06-16
Release: https://github.com/strands-agents/evals/releases/tag/v1.0.0 · Package: https://pypi.org/project/strands-agents-evals/1.0.0/

### Features
- add GOAT multi-turn attack strategy [redteam] (https://github.com/strands-agents/evals/pull/250)
- add PAIR single-stream multi-turn attack strategy [redteam] (https://github.com/strands-agents/evals/pull/253)
- add SequentialBreak narrative-scaffold attack strategy [redteam] (https://github.com/strands-agents/evals/pull/254)
- support async cases execution [redteam] (https://github.com/strands-agents/evals/pull/272)

### Other
- updated markdown files and skills to know the CLI exists [cli] (https://github.com/strands-agents/evals/pull/264)
- added RedTeamExperiment round-trips [redteam] (https://github.com/strands-agents/evals/pull/263)
- redteam multi-agent session [redteam] (https://github.com/strands-agents/evals/pull/251)
- per-call judge lifecycle + per-risk-category judge rubric + minor strategy improvements [redteam] (https://github.com/strands-agents/evals/pull/265)
- updated input to AgentInput but only supporting its… [simulation] (https://github.com/strands-agents/evals/pull/267)
- added strategies round-trips [redteam] (https://github.com/strands-agents/evals/pull/269)
- shortened the docstrings [devx] (https://github.com/strands-agents/evals/pull/270)
- add module README [redteam] (https://github.com/strands-agents/evals/pull/271)
- updated AGENT.md, SKILL.md, README (https://github.com/strands-agents/evals/pull/273)

## SDK Python v1.43.0 — 2026-06-12
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.43.0 · Package: https://pypi.org/project/strands-agents/1.43.0/

### Features
- add python wasm release workflow (https://github.com/strands-agents/harness-sdk/pull/2409)
- add optional hook order [hooks] (https://github.com/strands-agents/harness-sdk/pull/2559)
- wire checkpointing into agent event loop [persistence] (https://github.com/strands-agents/harness-sdk/pull/2190)
- make get/set app state sync [server] (https://github.com/strands-agents/harness-sdk/pull/2610)
- wire vended tools through the WASM guest [server] (https://github.com/strands-agents/harness-sdk/pull/2607)
- add test-infra/ CDK stack for long-running integ test resources (https://github.com/strands-agents/harness-sdk/pull/2650)
- add Sandbox core abstraction (TS→Python port, core only 1/N) [server] (https://github.com/strands-agents/harness-sdk/pull/2665)
- add context\_manager="auto" facade on Agent [context] (https://github.com/strands-agents/harness-sdk/pull/2643)
- add claude-opus-4-8 to context window limits [context] (https://github.com/strands-agents/harness-sdk/pull/2676)
- add model\_state as a snapshot field [persistence] (https://github.com/strands-agents/harness-sdk/pull/2680)
- generate smart preview links for changed doc pages [documentation] (https://github.com/strands-agents/harness-sdk/pull/2692)
- add message pinning to conversation managers [context] (https://github.com/strands-agents/harness-sdk/pull/2644)
- add Docker/SSH Sandbox implementations [server] (https://github.com/strands-agents/harness-sdk/pull/2691)
- add pr-create and pr-writer agent skills [devx] (https://github.com/strands-agents/harness-sdk/pull/2646)
- add pr-feedback agent skill for triaging PR review comments (https://github.com/strands-agents/harness-sdk/pull/2712)
- allow same-account IAM roles to assume the integ test role (https://github.com/strands-agents/harness-sdk/pull/2723)
- implement intervention primitive in python with cancellation support [interventions] (https://github.com/strands-agents/harness-sdk/pull/2693)

### Fixes
- resolve dependabot alerts and bump CI actions (https://github.com/strands-agents/harness-sdk/pull/2546)
- workflow\_dispatch step for python wasm release (https://github.com/strands-agents/harness-sdk/pull/2560)
- add maintain role to auto-strands-review allowed-roles (https://github.com/strands-agents/harness-sdk/pull/2633)
- include json blocks in counting tokens [context] (https://github.com/strands-agents/harness-sdk/pull/2639)
- introduce agent factory for isolating agent context from different callers [a2a] (https://github.com/strands-agents/harness-sdk/pull/2628)
- update stale GitHub links from old repos to harness-sdk [documentation] (https://github.com/strands-agents/harness-sdk/pull/2698)
- isolate conversation state per context in TypeScript [a2a, sessions] (https://github.com/strands-agents/harness-sdk/pull/2696)
- default to us-east-1 for integration tests (https://github.com/strands-agents/harness-sdk/pull/2720)
- label npm updates typescript instead of javascript (https://github.com/strands-agents/harness-sdk/pull/2726)
- remove stale consuming-repos reference from PR template (https://github.com/strands-agents/harness-sdk/pull/2727)
- remove flaky test\_graph\_parallel\_execution test [multiagent] (https://github.com/strands-agents/harness-sdk/pull/2743)
- stop over-applying area-community and chore (https://github.com/strands-agents/harness-sdk/pull/2725)

### Other
- commit LICENSE and NOTICE directly into package directories (https://github.com/strands-agents/harness-sdk/pull/2392)
- update repository references to harness-sdk (https://github.com/strands-agents/harness-sdk/pull/2618)
- document per-invocation limits feature [documentation] (https://github.com/strands-agents/harness-sdk/pull/2638)
- add missing policies to integ test role (https://github.com/strands-agents/harness-sdk/pull/2670)
- fixup test-infra constructs (https://github.com/strands-agents/harness-sdk/pull/2673)
- use local monorepo source instead of cloning SDKs [documentation] (https://github.com/strands-agents/harness-sdk/pull/2677)
- use native model\_state snapshot field [a2a] (https://github.com/strands-agents/harness-sdk/pull/2694)
- add explicit permissions to workflow jobs (https://github.com/strands-agents/harness-sdk/pull/2388)
- add automated issue labeling workflow (https://github.com/strands-agents/harness-sdk/pull/2359)
- bump actions/checkout from 4 to 6 (https://github.com/strands-agents/harness-sdk/pull/2100)
- add PR labeling to issue-labeler workflow (https://github.com/strands-agents/harness-sdk/pull/2702)
- add README to .agents/skills/ explaining each skill's purpose (https://github.com/strands-agents/harness-sdk/pull/2714)
- allow \`blog\` type in PR title validation (https://github.com/strands-agents/harness-sdk/pull/2718)
- enforce API review label requirement before merge (https://github.com/strands-agents/harness-sdk/pull/2716)
- add AI contribution guidance to CONTRIBUTING and PR template (https://github.com/strands-agents/harness-sdk/pull/2728)

## SDK TypeScript v1.5.0 — 2026-06-12
Release: https://github.com/strands-agents/harness-sdk/releases/tag/typescript/v1.5.0 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/1.5.0

### Features
- add python wasm release workflow (https://github.com/strands-agents/harness-sdk/pull/2409)
- add memory manager [memory] (https://github.com/strands-agents/harness-sdk/pull/2544)
- make get/set app state sync [server] (https://github.com/strands-agents/harness-sdk/pull/2610)
- wire vended tools through the WASM guest [server] (https://github.com/strands-agents/harness-sdk/pull/2607)
- simplify DockerSandbox to bring-your-own-container [server] (https://github.com/strands-agents/harness-sdk/pull/2561)
- add test-infra/ CDK stack for long-running integ test resources (https://github.com/strands-agents/harness-sdk/pull/2650)
- add context\_manager="auto" facade on Agent [context] (https://github.com/strands-agents/harness-sdk/pull/2643)
- add claude-opus-4-8 to context window limits [context] (https://github.com/strands-agents/harness-sdk/pull/2676)
- generate smart preview links for changed doc pages [documentation] (https://github.com/strands-agents/harness-sdk/pull/2692)
- add message pinning to conversation managers [context] (https://github.com/strands-agents/harness-sdk/pull/2644)
- add Bedrock Knowledge Base memory store [persistence] (https://github.com/strands-agents/harness-sdk/pull/2630)
- add pr-create and pr-writer agent skills [devx] (https://github.com/strands-agents/harness-sdk/pull/2646)
- add pr-feedback agent skill for triaging PR review comments (https://github.com/strands-agents/harness-sdk/pull/2712)
- add memory extraction [context] (https://github.com/strands-agents/harness-sdk/pull/2671)
- add middleware system for wrapping agent stages [agent] (https://github.com/strands-agents/harness-sdk/pull/2681)
- migrate TS integration test role to shared test-infra CDK stack (https://github.com/strands-agents/harness-sdk/pull/2715)
- allow same-account IAM roles to assume the integ test role (https://github.com/strands-agents/harness-sdk/pull/2723)
- integrate Sandbox with Agent [server, agent] (https://github.com/strands-agents/harness-sdk/pull/2563)
- update vended tools/plugins for sandbox compatibility [hooks, tool, server] (https://github.com/strands-agents/harness-sdk/pull/2649)
- pass sequenceNumber to memory store addMessages method [memory] (https://github.com/strands-agents/harness-sdk/pull/2721)
- add extraction defaults and support for bedrock kbs (https://github.com/strands-agents/harness-sdk/pull/2719)

### Fixes
- resolve dependabot alerts and bump CI actions (https://github.com/strands-agents/harness-sdk/pull/2546)
- workflow\_dispatch step for python wasm release (https://github.com/strands-agents/harness-sdk/pull/2560)
- update package-lock.json file to resolve wasm dependencies (https://github.com/strands-agents/harness-sdk/pull/2564)
- drop deprecated gemini-2.0-flash override in integ tests (https://github.com/strands-agents/harness-sdk/pull/2609)
- surface MaxTokensError when max\_tokens truncates tool input JSON [tool] (https://github.com/strands-agents/harness-sdk/pull/2620)
- add maintain role to auto-strands-review allowed-roles (https://github.com/strands-agents/harness-sdk/pull/2633)
- update package.json repository URLs to harness-sdk (https://github.com/strands-agents/harness-sdk/pull/2675)
- update stale GitHub links from old repos to harness-sdk [documentation] (https://github.com/strands-agents/harness-sdk/pull/2698)
- address CodeQL static analysis findings in JS/TS (https://github.com/strands-agents/harness-sdk/pull/2390)
- update remaining sdk-python references to harness-sdk (https://github.com/strands-agents/harness-sdk/pull/2701)
- preserve signature-only reasoning blocks across turns [model] (https://github.com/strands-agents/harness-sdk/pull/2704)
- isolate conversation state per context in TypeScript [a2a, sessions] (https://github.com/strands-agents/harness-sdk/pull/2696)
- improve devx for instantiating multiple bedrock KBs [model] (https://github.com/strands-agents/harness-sdk/pull/2722)
- label npm updates typescript instead of javascript (https://github.com/strands-agents/harness-sdk/pull/2726)
- remove stale consuming-repos reference from PR template (https://github.com/strands-agents/harness-sdk/pull/2727)
- stop over-applying area-community and chore (https://github.com/strands-agents/harness-sdk/pull/2725)

### Other
- sync strands-agents/docs and strands-agents/sdk-typescript into monorepo (https://github.com/strands-agents/harness-sdk/pull/2556)
- commit LICENSE and NOTICE directly into package directories (https://github.com/strands-agents/harness-sdk/pull/2392)
- change memory store return type on add [memory] (https://github.com/strands-agents/harness-sdk/pull/2613)
- update repository references to harness-sdk (https://github.com/strands-agents/harness-sdk/pull/2618)
- document per-invocation limits feature [documentation] (https://github.com/strands-agents/harness-sdk/pull/2638)
- update Bedrock examples to default model id [model] (https://github.com/strands-agents/harness-sdk/pull/2669)
- add missing policies to integ test role (https://github.com/strands-agents/harness-sdk/pull/2670)
- fixup test-infra constructs (https://github.com/strands-agents/harness-sdk/pull/2673)
- use local monorepo source instead of cloning SDKs [documentation] (https://github.com/strands-agents/harness-sdk/pull/2677)
- add explicit permissions to workflow jobs (https://github.com/strands-agents/harness-sdk/pull/2388)
- add automated issue labeling workflow (https://github.com/strands-agents/harness-sdk/pull/2359)
- bump actions/checkout from 4 to 6 (https://github.com/strands-agents/harness-sdk/pull/2100)
- add PR labeling to issue-labeler workflow (https://github.com/strands-agents/harness-sdk/pull/2702)
- add README to .agents/skills/ explaining each skill's purpose (https://github.com/strands-agents/harness-sdk/pull/2714)
- allow \`blog\` type in PR title validation (https://github.com/strands-agents/harness-sdk/pull/2718)
- enforce API review label requirement before merge (https://github.com/strands-agents/harness-sdk/pull/2716)
- add AI contribution guidance to CONTRIBUTING and PR template (https://github.com/strands-agents/harness-sdk/pull/2728)

## Evals v0.3.0 — 2026-06-12
Release: https://github.com/strands-agents/evals/releases/tag/v0.3.0 · Package: https://pypi.org/project/strands-agents-evals/0.3.0/

### Features
- add built-in red teaming support [redteam] (https://github.com/strands-agents/evals/pull/184)
- add chaos resilience evaluators (failure communication, partial completion, recovery strategy) (https://github.com/strands-agents/evals/pull/236)
- add Crescendo multi-turn attack strategy [redteam] (https://github.com/strands-agents/evals/pull/245)
- added strands-evals cli [cli] (https://github.com/strands-agents/evals/pull/243)
- add LLM issue labeler for area and type [cli] (https://github.com/strands-agents/evals/pull/255)
- add Bad Likert Judge multi-turn attack strategy [redteam] (https://github.com/strands-agents/evals/pull/248)

### Fixes
- join all toolResult.content blocks to fix faithfulness false negatives (https://github.com/strands-agents/evals/pull/240)
- correct doc link and clean up issue/PR templates (https://github.com/strands-agents/evals/pull/256)

### Other
- allow importing EvaluationReport from root (https://github.com/strands-agents/evals/pull/238)
- added trace-based evaluators into defaults (https://github.com/strands-agents/evals/pull/244)
- always return flattened report (https://github.com/strands-agents/evals/pull/241)
- bumped strands-agents-version to the latest (https://github.com/strands-agents/evals/pull/246)
- added evaluator name and evaluator\_type for report (https://github.com/strands-agents/evals/pull/249)
- added single case evaluation command [cli] (https://github.com/strands-agents/evals/pull/252)
- add AI contribution guidance to CONTRIBUTING and PR template (https://github.com/strands-agents/evals/pull/257)
- add high-quality PR guidance to AGENTS.md [agent] (https://github.com/strands-agents/evals/pull/258)
- add community and character guidance to AGENTS.md [agent] (https://github.com/strands-agents/evals/pull/261)
- added generate command for experiment generation [cli] (https://github.com/strands-agents/evals/pull/260)

## SDK Python v1.42.0 — 2026-06-01
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.42.0 · Package: https://pypi.org/project/strands-agents/1.42.0/

### Features
- add endpoint\_url parameter to S3SessionManager (https://github.com/strands-agents/sdk-python/pull/1934)
- plumb through cache tokens in metadata events [model] (https://github.com/strands-agents/sdk-python/pull/2287)
- add \`agent\_card\_url\` property to \`A2AServer\` for customizable \`url\` in \`AgentCard\` [a2a] (https://github.com/strands-agents/sdk-python/pull/2003)
- use call\_async for true async streaming [bidirectional-streaming] (https://github.com/strands-agents/sdk-python/pull/2361)
- add Limits and support it during invoke/stream [bidirectional-streaming] (https://github.com/strands-agents/sdk-python/pull/2360)
- pass invocation\_state to edge condition calls [multiagent, hooks] (https://github.com/strands-agents/sdk-python/pull/2305)
- make variant arms inherit from container (https://github.com/strands-agents/sdk-python/pull/2386)
- promote content-to-tool-result method to public API [devx, mcp] (https://github.com/strands-agents/sdk-python/pull/2370)
- add DecoratedTool for host-side Python tools [tool] (https://github.com/strands-agents/sdk-python/pull/2412)

### Fixes
- fix flaky tests to accept string or number (https://github.com/strands-agents/sdk-python/pull/2319)
- handle None text in message content sanitization [model] (https://github.com/strands-agents/sdk-python/pull/1920)
- make MetricsClient singleton thread-safe [otel] (https://github.com/strands-agents/sdk-python/pull/2349)
- handle safety-blocked metadata [model] (https://github.com/strands-agents/sdk-python/pull/2353)
- read vllm reasoning deltas [model] (https://github.com/strands-agents/sdk-python/pull/2354)
- downgrade validation failure log from error to debug [structured-output] (https://github.com/strands-agents/sdk-python/pull/2368)
- scope authorization-check job permissions to contents: read (https://github.com/strands-agents/sdk-python/pull/2367)
- use separate READMEs for Python and TypeScript packages (https://github.com/strands-agents/sdk-python/pull/2384)
- keep concurrent tool results in request order [tool] (https://github.com/strands-agents/sdk-python/pull/2340)
- realign provider context-overflow patterns and drop MIT dual-license [context] (https://github.com/strands-agents/sdk-python/pull/2394)
- fix bootstrap ordering and update README (https://github.com/strands-agents/sdk-python/pull/2402)
- update vitest to ^4.1.6 (https://github.com/strands-agents/sdk-python/pull/2534)

### Other
- prepare directory layout for monorepo convergence (https://github.com/strands-agents/sdk-python/pull/2317)
- merge strands-agents/docs into monorepo (https://github.com/strands-agents/sdk-python/pull/2339)
- address fast-follow items from docs monorepo merge (https://github.com/strands-agents/sdk-python/pull/2348)
- merge strands-agents/sdk-typescript into monorepo (https://github.com/strands-agents/sdk-python/pull/2350)
- update stale references for monorepo consolidation (https://github.com/strands-agents/sdk-python/pull/2358)
- use env var for repository name in integration test workflow (https://github.com/strands-agents/sdk-python/pull/2371)
- sync strands-agents/sdk-typescript into monorepo (https://github.com/strands-agents/sdk-python/pull/2363)
- revert "feat: pass invocation\_state to edge condition calls (#2305)" (https://github.com/strands-agents/sdk-python/pull/2389)
- add security warnings to http\_request and file\_editor vended tools [tool] (https://github.com/strands-agents/sdk-python/pull/2391)
- allow design type in PR title validation (https://github.com/strands-agents/sdk-python/pull/2395)

## SDK TypeScript v1.4.0 — 2026-06-01
Release: https://github.com/strands-agents/harness-sdk/releases/tag/typescript/v1.4.0 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/1.4.0

First TypeScript release cut from the unified harness-sdk monorepo. The
itemized change list was omitted during the repository merge — see the
[release on GitHub](https://github.com/strands-agents/harness-sdk/releases/tag/typescript/v1.4.0)
for the full compare. Earlier TypeScript history continues below from the
original sdk-typescript repository.

## Evals v0.2.1 — 2026-05-29
Release: https://github.com/strands-agents/evals/releases/tag/v0.2.1 · Package: https://pypi.org/project/strands-agents-evals/0.2.1/

### Features
- add chaos testing module for fault injection (https://github.com/strands-agents/evals/pull/224)

### Other
- added evals-skills (https://github.com/strands-agents/evals/pull/231)

## SDK Python v1.41.0 — 2026-05-21
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.41.0 · Package: https://pypi.org/project/strands-agents/1.41.0/

### Features
- add MultiAgentPlugin for Swarm and Graph orchestrators [multiagent] (https://github.com/strands-agents/sdk-python/pull/2280)
- bump starlette dependency to 1.x (https://github.com/strands-agents/sdk-python/pull/2297)
- add TTL support to auto-injected tool and system/user cache points [model] (https://github.com/strands-agents/sdk-python/pull/2232)

### Fixes
- add use\_native\_token\_count=True when expected (https://github.com/strands-agents/sdk-python/pull/2311)

## SDK TypeScript v1.3.0 — 2026-05-21
Release: https://github.com/strands-agents/sdk-typescript/releases/tag/v1.3.0 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/1.3.0

### Features
- add interventions primitive (https://github.com/strands-agents/sdk-typescript/pull/883)
- add search results tool [tool] (https://github.com/strands-agents/sdk-typescript/pull/1060)
- added bedrock-mantle support [model] (https://github.com/strands-agents/sdk-typescript/pull/1066)
- add confirm action with built-in approve/deny semantics [interventions] (https://github.com/strands-agents/sdk-typescript/pull/1072)

### Fixes
- defer tool announcement until after hooks resolve [tool] (https://github.com/strands-agents/sdk-typescript/pull/1076)

### Other
- update anthropic-provider [model] (https://github.com/strands-agents/sdk-typescript/pull/1075)
- Migrate strands-py to strands-py-wasm (https://github.com/strands-agents/sdk-typescript/pull/1078)

## SDK Python v1.40.0 — 2026-05-14
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.40.0 · Package: https://pypi.org/project/strands-agents/1.40.0/

### Features
- add proactive context compression to conversation managers [context] (https://github.com/strands-agents/sdk-python/pull/2239)
- cache AccessDenied error for count tokens (https://github.com/strands-agents/sdk-python/pull/2279)
- add official Discord link (https://github.com/strands-agents/sdk-python/pull/2285)

### Fixes
- update return type of latencyMs metric for ollama model provider [model] (https://github.com/strands-agents/sdk-python/pull/2236)
- set use\_native\_token\_count default to false (https://github.com/strands-agents/sdk-python/pull/2284)
- swarm bug "Failed to detach context" with opentelemetry [multiagent] (https://github.com/strands-agents/sdk-python/pull/2281)

## SDK TypeScript v1.2.0 — 2026-05-14
Release: https://github.com/strands-agents/sdk-typescript/releases/tag/v1.2.0 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/1.2.0

### Features
- refine sliding window coversation manager logic (https://github.com/strands-agents/sdk-typescript/pull/1018)
- add npm-pack test to ci-cd (https://github.com/strands-agents/sdk-typescript/pull/996)
- cache AccessDenied error for count tokens (https://github.com/strands-agents/sdk-typescript/pull/1032)
- handle toolsChanged notifications [mcp] (https://github.com/strands-agents/sdk-typescript/pull/1038)
- WIT-first SDK contract and strands-py 2.0.0a1 rewrite (https://github.com/strands-agents/sdk-typescript/pull/1034)
- expose takeSnapshot and loadSnapshot on Agent [agent] (https://github.com/strands-agents/sdk-typescript/pull/1045)
- add official Discord link (https://github.com/strands-agents/sdk-typescript/pull/1051)
- normalize tool-name and update correct MessageAddedEvent behavior [tool] (https://github.com/strands-agents/sdk-typescript/pull/1048)
- make totalDuration and averageCycleTime O(1) on AgentMetrics (https://github.com/strands-agents/sdk-typescript/pull/1063)
- support multi-agent interrupts; add InterruptEvent [multiagent] (https://github.com/strands-agents/sdk-typescript/pull/1044)
- support url + auth fields on McpClientConfig [mcp] (https://github.com/strands-agents/sdk-typescript/pull/1059)
- forward agent cancel signal to MCP server [mcp] (https://github.com/strands-agents/sdk-typescript/pull/1069)

### Fixes
- npm security audit fix (https://github.com/strands-agents/sdk-typescript/pull/1041)
- align context overflow detection patterns(#894) [context] (https://github.com/strands-agents/sdk-typescript/pull/966)
- default useNativeTokenCount to false (https://github.com/strands-agents/sdk-typescript/pull/1056)
- structured tool output user/assistant bug fix [tool] (https://github.com/strands-agents/sdk-typescript/pull/1049)
- use correct 'citation' delta key for streaming citations in Bedrock provider [model] (https://github.com/strands-agents/sdk-typescript/pull/1058)
- give maintainers auto integ tests (https://github.com/strands-agents/sdk-typescript/pull/1064)
- replace Node 22+ globSync with readdirSync in strands-dev CLI (https://github.com/strands-agents/sdk-typescript/pull/1062)

### Other
- serialized interrupts and structuredOutput as JSON and citationsBlock (https://github.com/strands-agents/sdk-typescript/pull/1043)
- persist guardrails redaction (https://github.com/strands-agents/sdk-typescript/pull/1040)
- update AGENTS.MD (https://github.com/strands-agents/sdk-typescript/pull/1057)

## Evals v0.2.0 — 2026-05-14
Release: https://github.com/strands-agents/evals/releases/tag/v0.2.0 · Package: https://pypi.org/project/strands-agents-evals/0.2.0/

### Features
- structured\_output for ActorSimulator [structured-output] (https://github.com/strands-agents/evals/pull/207)
- added strands-reviewer workflow into evals (https://github.com/strands-agents/evals/pull/223)
- add official Discord link (https://github.com/strands-agents/evals/pull/227)

### Other
- update import to include DiagnosisTrigger [detectors] (https://github.com/strands-agents/evals/pull/219)

## SDK Python v1.39.0 — 2026-05-08
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.39.0 · Package: https://pypi.org/project/strands-agents/1.39.0/

### Features
- enable openai provider use aws profile [model] (https://github.com/strands-agents/sdk-python/pull/2230)
- add context window limit lookup table [context] (https://github.com/strands-agents/sdk-python/pull/2249)
- add useNativeTokenCount flag to skip token counting API calls (https://github.com/strands-agents/sdk-python/pull/2255)
- implement full A2A task lifecycle state support [a2a] (https://github.com/strands-agents/sdk-python/pull/2245)

### Fixes
- include root cause in MCPClientInitializationError message (https://github.com/strands-agents/sdk-python/pull/2238)
- fix count tokens for bedrock models [model] (https://github.com/strands-agents/sdk-python/pull/2254)
- cache unsupported models for bedrocks token counting (https://github.com/strands-agents/sdk-python/pull/2250)
- correct MCPClient.\_\_exit\_\_ and stop() type annotations (https://github.com/strands-agents/sdk-python/pull/2248)
- integration test updates (https://github.com/strands-agents/sdk-python/pull/2262)

## SDK TypeScript v1.1.0 — 2026-05-08
Release: https://github.com/strands-agents/sdk-typescript/releases/tag/v1.1.0 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/1.1.0

### Features
- add hook fields on Before/After Tool Call Event and AfterInvocationEvent [tool] (https://github.com/strands-agents/sdk-typescript/pull/957)
- add tsc type-checking to strands-wasm (https://github.com/strands-agents/sdk-typescript/pull/979)
- auto-populate contextWindowLimit from model ID lookup tables (https://github.com/strands-agents/sdk-typescript/pull/954)
- expose model on local agent [agent] (https://github.com/strands-agents/sdk-typescript/pull/938)
- add agent guide for wasm feature development [agent] (https://github.com/strands-agents/sdk-typescript/pull/992)
- add result offload plugin [context] (https://github.com/strands-agents/sdk-typescript/pull/974)
- implement interrupt system for human-in-the-loop workflows (https://github.com/strands-agents/sdk-typescript/pull/784)
- add structured output implementation for wasm [structured-output] (https://github.com/strands-agents/sdk-typescript/pull/1000)
- surface server logs, enable failOpen, metadata getters [mcp] (https://github.com/strands-agents/sdk-typescript/pull/1010)
- add timeouts to graph/swarm; bedrock request timeout [model] (https://github.com/strands-agents/sdk-typescript/pull/1008)
- add endTurn decision field to AfterToolsEvent [hooks] (https://github.com/strands-agents/sdk-typescript/pull/982)
- add useNativeTokenCount flag to skip token counting API calls (https://github.com/strands-agents/sdk-typescript/pull/1009)
- add Symbol.asyncDispose to McpClient to enable await-using cleanup [mcp] (https://github.com/strands-agents/sdk-typescript/pull/1016)
- add optional hook order [hooks] (https://github.com/strands-agents/sdk-typescript/pull/1005)
- add proactive context compression to conversation managers [context] (https://github.com/strands-agents/sdk-typescript/pull/965)
- normalize invalid tool names [tool] (https://github.com/strands-agents/sdk-typescript/pull/1017)
- add DefaultModelRetryStrategy, ModelRetryStrategy, and BackoffStrategy (https://github.com/strands-agents/sdk-typescript/pull/888)

### Fixes
- migrate LifecycleBridge from deleted HookProvider to Plugin (https://github.com/strands-agents/sdk-typescript/pull/967)
- format entry.ts (https://github.com/strands-agents/sdk-typescript/pull/975)
- fix stale imports and ToolRegistry API in WASM bridge (https://github.com/strands-agents/sdk-typescript/pull/973)
- add missing root script delegations (https://github.com/strands-agents/sdk-typescript/pull/972)
- run generate before type-check in strands-wasm (https://github.com/strands-agents/sdk-typescript/pull/987)
- paginate listTools(), improve fallback description [mcp] (https://github.com/strands-agents/sdk-typescript/pull/984)
- mapEvent interrupt guard, broken test imports (https://github.com/strands-agents/sdk-typescript/pull/1003)
- remove type checking for wasm temporarily (https://github.com/strands-agents/sdk-typescript/pull/1007)
- cache unsupported models for bedrocks token counting (https://github.com/strands-agents/sdk-typescript/pull/999)
- allow browser env in OpenAI responses integ fixture [model] (https://github.com/strands-agents/sdk-typescript/pull/1014)

### Other
- bump @anthropic-ai/sdk from 0.89.0 to 0.92.0 [model] (https://github.com/strands-agents/sdk-typescript/pull/978)
- add contract tests for the WASM bridge (https://github.com/strands-agents/sdk-typescript/pull/983)
- eliminate type safety gaps in entry.ts bridge (https://github.com/strands-agents/sdk-typescript/pull/988)
- decompose mapEvent into typed functions (https://github.com/strands-agents/sdk-typescript/pull/989)
- update tenacity requirement from \>=8.0 to \>=9.1.4 in /strands-py (https://github.com/strands-agents/sdk-typescript/pull/842)
- update docstring-parser requirement from \>=0.16 to \>=0.18.0 in /strands-py (https://github.com/strands-agents/sdk-typescript/pull/843)
- bump commander from 12.1.0 to 14.0.3 (https://github.com/strands-agents/sdk-typescript/pull/845)
- bump fast-xml-parser and @aws-sdk/xml-builder (https://github.com/strands-agents/sdk-typescript/pull/940)
- bump uuid from 13.0.0 to 14.0.0 (https://github.com/strands-agents/sdk-typescript/pull/962)
- update boto3 requirement from \>=1.42.92 to \>=1.43.2 in /strands-py (https://github.com/strands-agents/sdk-typescript/pull/986)
- bump @aws-sdk/client-bedrock-runtime from 3.1033.0 to 3.1037.0 in the production-minor group across 1 directory [model] (https://github.com/strands-agents/sdk-typescript/pull/993)
- rename hook order to SDK first/last [hooks] (https://github.com/strands-agents/sdk-typescript/pull/1024)

## Evals v0.1.17 — 2026-05-08
Release: https://github.com/strands-agents/evals/releases/tag/v0.1.17 · Package: https://pypi.org/project/strands-agents-evals/0.1.17/

### Features
- add multimodal evaluators and prompt templates for image-to-text evaluation (https://github.com/strands-agents/evals/pull/187)
- added analyze\_root\_cause [detectors] (https://github.com/strands-agents/evals/pull/179)
- integrated rca into evaluation workflow [detectors] (https://github.com/strands-agents/evals/pull/210)
- added refusalEvaluator, stereotypingEvaluator, insructionFollowingEvaluator [evaluators] (https://github.com/strands-agents/evals/pull/213)
- add optional tools parameter to ToolSimulator (#208) [tool] (https://github.com/strands-agents/evals/pull/209)

### Fixes
- preserve input order in run\_evaluations\_async (https://github.com/strands-agents/evals/pull/214)
- update default judge model to Claude Sonnet 4.6 [evaluators] (https://github.com/strands-agents/evals/pull/215)

### Other
- included more fields to the RCAItem [detectors] (https://github.com/strands-agents/evals/pull/211)
- updated confidencelevel and diagnose\_trigger to enum [detectors] (https://github.com/strands-agents/evals/pull/212)
- formatting (https://github.com/strands-agents/evals/pull/217)

## SDK Python v1.38.0 — 2026-04-30
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.38.0 · Package: https://pypi.org/project/strands-agents/1.38.0/

### Features
- preserve CallToolResult.isError flag in MCPToolResult [mcp] (https://github.com/strands-agents/sdk-python/pull/2118)
- add \`count\_token\` method to model with naive estimation using tiktoken [context] (https://github.com/strands-agents/sdk-python/pull/2031)
- add TTL support to CachePoint for prompt caching (https://github.com/strands-agents/sdk-python/pull/1660)
- large tool result offload [tool] (https://github.com/strands-agents/sdk-python/pull/2162)
- override count\_tokens with native token counting for supported providers (https://github.com/strands-agents/sdk-python/pull/2189)
- add ProviderTokenCountError for native token counting failures (https://github.com/strands-agents/sdk-python/pull/2211)
- estimate input tokens before model calls (https://github.com/strands-agents/sdk-python/pull/2221)
- return explicit paths in preview and auto-enable retrieval (https://github.com/strands-agents/sdk-python/pull/2222)
- add strict\_tools config with auto-inject of additional… [model] (https://github.com/strands-agents/sdk-python/pull/2213)

### Fixes
- forward ttl field from CachePoint in \_format\_system\_messages [model] (https://github.com/strands-agents/sdk-python/pull/2153)
- preserve cache points in system prompt during skills inj… (https://github.com/strands-agents/sdk-python/pull/2134)
- generate unique toolUseId instead of reusing tool name [model] (https://github.com/strands-agents/sdk-python/pull/2053)
- use non-interactive flag for Nova Sonic history and system promp… (https://github.com/strands-agents/sdk-python/pull/2188)
- upgrade default model to Claude Sonnet 4.5 [model] (https://github.com/strands-agents/sdk-python/pull/2193)
- handle window\_size=0 and reject negative values (https://github.com/strands-agents/sdk-python/pull/2208)
- change token counting fallback log from warning to debug (https://github.com/strands-agents/sdk-python/pull/2220)
- do not synthesize exception for cancelled tools [tool] (https://github.com/strands-agents/sdk-python/pull/2106)
- update tests to use non-EOL'd model (https://github.com/strands-agents/sdk-python/pull/2226)

### Other
- added warning for default model awareness and is subject to change (https://github.com/strands-agents/sdk-python/pull/2164)
- update litellm requirement from \<=1.82.6,\>=1.75.9 to \>=1.75.9,\<=1.83.13 [model] (https://github.com/strands-agents/sdk-python/pull/2197)
- update pre-commit requirement from \<4.6.0,\>=3.2.0 to \>=3.2.0,\<4.7.0 (https://github.com/strands-agents/sdk-python/pull/2185)
- update style guide for tool spec navigation [tool] (https://github.com/strands-agents/sdk-python/pull/2203)

## SDK TypeScript v1.0.0 — 2026-04-30
Release: https://github.com/strands-agents/sdk-typescript/releases/tag/v1.0.0 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/1.0.0

### Features
- add prepack script so git installs build dist/ (https://github.com/strands-agents/sdk-typescript/pull/874)
- add mcp tool result multimodal support [mcp] (https://github.com/strands-agents/sdk-typescript/pull/865)
- add concise inline comments in the wit contract (https://github.com/strands-agents/sdk-typescript/pull/878)
- add countTokens() heuristic to Model base class (https://github.com/strands-agents/sdk-typescript/pull/853)
- add elicitation callback support [mcp] (https://github.com/strands-agents/sdk-typescript/pull/876)
- make tool result mutable [tool] (https://github.com/strands-agents/sdk-typescript/pull/907)
- add cancellation support to BeforeInvocationEvent and BeforeModelCallEvent (https://github.com/strands-agents/sdk-typescript/pull/908)
- centralize model defaults; emit warnings when defaults are used… (https://github.com/strands-agents/sdk-typescript/pull/909)
- estimate input tokens before model calls (https://github.com/strands-agents/sdk-typescript/pull/890)
- override countTokens with native token counting for supported providers (https://github.com/strands-agents/sdk-typescript/pull/886)
- add concurrent tool execution [tool] (https://github.com/strands-agents/sdk-typescript/pull/854)
- add bridge in wasm for conversation manager (https://github.com/strands-agents/sdk-typescript/pull/880)
- add invocation state; apply to all events (https://github.com/strands-agents/sdk-typescript/pull/887)
- add openai-responses model provider and stateful model support [model] (https://github.com/strands-agents/sdk-typescript/pull/820)
- add optional session token to browser-agent Bedrock settings [model] (https://github.com/strands-agents/sdk-typescript/pull/960)
- concurrent tool execution strategy by default [tool] (https://github.com/strands-agents/sdk-typescript/pull/970)

### Fixes
- add version field to root package.json so downstream file: insta… (https://github.com/strands-agents/sdk-typescript/pull/875)
- remove internal ProviderTokenCountError from public exports (https://github.com/strands-agents/sdk-typescript/pull/937)
- change token counting fallback log from warn to debug (https://github.com/strands-agents/sdk-typescript/pull/942)
- fix transport type cast for StreamableHTTPClientTransport [mcp] (https://github.com/strands-agents/sdk-typescript/pull/939)
- add prepare script to examples for standalone install (https://github.com/strands-agents/sdk-typescript/pull/961)
- include README and LICENSE files in published npm package (https://github.com/strands-agents/sdk-typescript/pull/969)

### Other
- update wasm content with guides (https://github.com/strands-agents/sdk-typescript/pull/879)

## Evals v0.1.16 — 2026-04-30
Release: https://github.com/strands-agents/evals/releases/tag/v0.1.16 · Package: https://pypi.org/project/strands-agents-evals/0.1.16/

### Features
- simplify devx by adding @eval\_task decorator and handlers for wrapping task functions (https://github.com/strands-agents/evals/pull/199)
- detectors interface and failure\_detector implementation [detectors] (https://github.com/strands-agents/evals/pull/189)

### Other
- use PEP 604 union syntax and add Model type to HarmfulnessEvaluator [evaluators] (https://github.com/strands-agents/evals/pull/206)

## SDK Python v1.37.0 — 2026-04-22
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.37.0 · Package: https://pypi.org/project/strands-agents/1.37.0/

### Features
- introduce checkpoint in experimental [persistence] (https://github.com/strands-agents/sdk-python/pull/2181)
- add context\_window\_limit to model configs (https://github.com/strands-agents/sdk-python/pull/2176)

### Fixes
- add fallback trim point for tool-heavy conversations in SlidingWindowConversationManager [tool] (https://github.com/strands-agents/sdk-python/pull/2174)
- skip MCPClient cleanup during interpreter finalization [mcp] (https://github.com/strands-agents/sdk-python/pull/2144)
- update retired claude-3-haiku model in integration tests (https://github.com/strands-agents/sdk-python/pull/2186)

## SDK TypeScript v1.0.0-rc.5 — 2026-04-22
Release: https://github.com/strands-agents/sdk-typescript/releases/tag/v1.0.0-rc.5 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/1.0.0-rc.5

### Features
- add strands-wasm, strands-py, strands-dev, and wit from wasm monorepo (https://github.com/strands-agents/sdk-typescript/pull/829)
- add contextWindowLimit to BaseModelConfig (https://github.com/strands-agents/sdk-typescript/pull/848)
- handle -32042 elicitation error in tool results [mcp] (https://github.com/strands-agents/sdk-typescript/pull/864)
- export MultiagentSaveLatestStrategy in top level index (https://github.com/strands-agents/sdk-typescript/pull/873)

### Fixes
- update maxTokens default value, remove dead default and haiku fallback [model] (https://github.com/strands-agents/sdk-typescript/pull/824)

### Other
- remove preview status from README (https://github.com/strands-agents/sdk-typescript/pull/828)
- move TS package into strands-ts/ for monorepo structure (https://github.com/strands-agents/sdk-typescript/pull/827)
- update AGENTS.md and CONTRIBUTING.md for strands-ts workspace layout (https://github.com/strands-agents/sdk-typescript/pull/832)
- update setuptools requirement from \>=68.0 to \>=82.0.1 in /strands-py (https://github.com/strands-agents/sdk-typescript/pull/834)
- update pytest-asyncio requirement from \>=0.23 to \>=1.3.0 in /strands-py (https://github.com/strands-agents/sdk-typescript/pull/837)
- update boto3 requirement from \>=1.35 to \>=1.42.92 in /strands-py (https://github.com/strands-agents/sdk-typescript/pull/840)
- bump actions/github-script from 8 to 9 (https://github.com/strands-agents/sdk-typescript/pull/805)
- bump the npm\_and\_yarn group across 2 directories with 2 updates (https://github.com/strands-agents/sdk-typescript/pull/830)
- update pydantic requirement from \>=2.0 to \>=2.13.3 in /strands-py (https://github.com/strands-agents/sdk-typescript/pull/839)
- update pytest requirement from \>=8.0 to \>=9.0.3 in /strands-py (https://github.com/strands-agents/sdk-typescript/pull/841)
- bump the development-dependencies group across 1 directory with 11 updates (https://github.com/strands-agents/sdk-typescript/pull/831)
- rename AgentSkillsPlugin -\> AgentSkills (https://github.com/strands-agents/sdk-typescript/pull/861)
- add README for wasm (https://github.com/strands-agents/sdk-typescript/pull/863)
- update AGENTS.md (https://github.com/strands-agents/sdk-typescript/pull/862)
- upgrade to otel js sdk v2 [otel] (https://github.com/strands-agents/sdk-typescript/pull/867)

## SDK Python v1.36.0 — 2026-04-17
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.36.0 · Package: https://pypi.org/project/strands-agents/1.36.0/

### Features
- accept callable hook callbacks in Agent constructor [hooks] (https://github.com/strands-agents/sdk-python/pull/1992)
- add client\_config param and deprecate a2a\_client\_factory [a2a] (https://github.com/strands-agents/sdk-python/pull/2103)
- plumb through cache tokens in metadata events [model] (https://github.com/strands-agents/sdk-python/pull/2116)
- add take\_snapshot() and load\_snapshot() methods [agent] (https://github.com/strands-agents/sdk-python/pull/1948)
- support loading skills from URLs (https://github.com/strands-agents/sdk-python/pull/2091)
- add metadata field to messages for stateful context tracking [context] (https://github.com/strands-agents/sdk-python/pull/2125)
- support request\_state stop\_event\_loop flag [bidirectional-streaming] (https://github.com/strands-agents/sdk-python/pull/1954)

### Fixes
- handle missing optional fields in non-streaming citation conversion [bidirectional-streaming] (https://github.com/strands-agents/sdk-python/pull/2098)
- add common gen\_ai attributes to event loop cycle spans [otel] (https://github.com/strands-agents/sdk-python/pull/1973)
- use per-invocation usage in agent span attributes [otel] (https://github.com/strands-agents/sdk-python/pull/2017)
- clear leaked running loop in MCP client background thread [mcp] (https://github.com/strands-agents/sdk-python/pull/2111)
- preserve Gemini thought\_signature in LiteLLM multi-turn tool calls [model] (https://github.com/strands-agents/sdk-python/pull/2129)
- normalize empty toolResult content arrays in \_format\_bedrock\_messages [model] (https://github.com/strands-agents/sdk-python/pull/2123)
- remove force\_flush in tracer [otel] (https://github.com/strands-agents/sdk-python/pull/2142)

## SDK TypeScript v1.0.0-rc.4 — 2026-04-17
Release: https://github.com/strands-agents/sdk-typescript/releases/tag/v1.0.0-rc.4 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/1.0.0-rc.4

### Features
- add swarm+session manager resume logic,unit tests, integration test [multiagent] (https://github.com/strands-agents/sdk-typescript/pull/800)
- support custom ClientFactory in A2AAgent for authenticated requests [a2a] (https://github.com/strands-agents/sdk-typescript/pull/810)
- track agent.messages token size [context] (https://github.com/strands-agents/sdk-typescript/pull/790)
- add graph+session manager integration + tests [multiagent] (https://github.com/strands-agents/sdk-typescript/pull/809)
- add agent skills plugin [agent] (https://github.com/strands-agents/sdk-typescript/pull/807)
- expose metrics/usage on message metadata [otel] (https://github.com/strands-agents/sdk-typescript/pull/815)

### Fixes
- evaluate all incoming edge handlers in Graph.\_findReady [multiagent] (https://github.com/strands-agents/sdk-typescript/pull/804)
- added function replacer for notebook\_tool replace [tool] (https://github.com/strands-agents/sdk-typescript/pull/814)

### Other
- add package-lock.json (https://github.com/strands-agents/sdk-typescript/pull/813)

## Evals v0.1.15 — 2026-04-17
Release: https://github.com/strands-agents/evals/releases/tag/v0.1.15 · Package: https://pypi.org/project/strands-agents-evals/0.1.15/

### Features
- add correctness evaluator, trace-based and reference-based (https://github.com/strands-agents/evals/pull/185)
- add OpenSearchProvider and OpenSearchSessionMapper (https://github.com/strands-agents/evals/pull/192)

### Other
- updated simulators README (https://github.com/strands-agents/evals/pull/195)

## SDK Python v1.35.0 — 2026-04-08
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.35.0 · Package: https://pypi.org/project/strands-agents/1.35.0/

### Features
- add service\_tier support to BedrockModel (https://github.com/strands-agents/sdk-python/pull/1799)

### Fixes
- forward \_meta to MCP tool calls and fix model\_dump alias seriali… (https://github.com/strands-agents/sdk-python/pull/1918)
- avoid Pydantic warnings for message\_stop events (https://github.com/strands-agents/sdk-python/pull/2044)
- propagate tool exceptions to spans so StatusCode.ERROR is set correctly (https://github.com/strands-agents/sdk-python/pull/2046)
- enforce that the first message is a user message in the sliding window conversation manager (https://github.com/strands-agents/sdk-python/pull/2087)
- forward meta to MCP task-augmented tool calls (https://github.com/strands-agents/sdk-python/pull/2081)
- handle premature stream termination for Anthropic (#1868) (https://github.com/strands-agents/sdk-python/pull/2047)
- update session integ test for sliding window conversation manager (https://github.com/strands-agents/sdk-python/pull/2092)
- fix anthropic stream test mock missing get\_final\_message (https://github.com/strands-agents/sdk-python/pull/2094)

### Other
- add weekly markdown link check workflow (https://github.com/strands-agents/sdk-python/pull/2088)

## SDK TypeScript v1.0.0-rc.3 — 2026-04-08
Release: https://github.com/strands-agents/sdk-typescript/releases/tag/v1.0.0-rc.3 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/1.0.0-rc.3

### Features
- add browser-based agent example (https://github.com/strands-agents/sdk-typescript/pull/384)
- add multiagent snapshot (https://github.com/strands-agents/sdk-typescript/pull/756)
- add AgentAsTool internal class (https://github.com/strands-agents/sdk-typescript/pull/768)
- enable session manager in multiagent (P0, resume logic will be in separate PR) (https://github.com/strands-agents/sdk-typescript/pull/764)
- add mid-execution cancellation (https://github.com/strands-agents/sdk-typescript/pull/781)

### Fixes
- sync BEDROCK\_CONTEXT\_WINDOW\_OVERFLOW\_MESSAGES with Python SDK (https://github.com/strands-agents/sdk-typescript/pull/782)
- update browser-agent example for current SDK API (https://github.com/strands-agents/sdk-typescript/pull/792)
- prevent invocation lock leak when consumer breaks from stream (https://github.com/strands-agents/sdk-typescript/pull/796)
- migrate MultiagentPlugin to be an interface (https://github.com/strands-agents/sdk-typescript/pull/794)
- disable thinking when tool\_choice forces tool use (https://github.com/strands-agents/sdk-typescript/pull/798)

## Evals v0.1.14 — 2026-04-08
Release: https://github.com/strands-agents/evals/releases/tag/v0.1.14 · Package: https://pypi.org/project/strands-agents-evals/0.1.14/

### Features
- add ground truth assertion support to Goal Success Rate evaluator (https://github.com/strands-agents/evals/pull/180)

### Other
- devx to allow for passing the Provider directly to evaluations with creating a wrapper task (https://github.com/strands-agents/evals/pull/183)

## SDK Python v1.34.1 — 2026-04-01
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.34.1 · Package: https://pypi.org/project/strands-agents/1.34.1/

### Features
- track context tokens [context] (https://github.com/strands-agents/sdk-python/pull/2009)

### Fixes
- fix type imcompatible (https://github.com/strands-agents/sdk-python/pull/2018)
- isolate langfuse env vars (https://github.com/strands-agents/sdk-python/pull/2022)
- restore explicit span.end() to fix span end\_time regression [otel] (https://github.com/strands-agents/sdk-python/pull/2032)

## SDK Python v1.34.0 — 2026-03-31
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.34.0 · Package: https://pypi.org/project/strands-agents/1.34.0/

### Features
- add AgentAsTool (https://github.com/strands-agents/sdk-python/pull/1932)
- auto-wrap Agent instances passed in tools list [tool] (https://github.com/strands-agents/sdk-python/pull/1997)
- emit system prompt on chat spans per GenAI semconv [otel] (https://github.com/strands-agents/sdk-python/pull/1818)
- add support for MCP elicitation -32042 error handling [mcp] (https://github.com/strands-agents/sdk-python/pull/1745)
- add stateful model support for server-side conversation management (https://github.com/strands-agents/sdk-python/pull/2004)
- add built-in tool support for OpenAI Responses API [model] (https://github.com/strands-agents/sdk-python/pull/2011)

### Fixes
- ollama input/output token count [model] (https://github.com/strands-agents/sdk-python/pull/2008)
- handle reasoning content in OpenAIResponsesModel request formatting (https://github.com/strands-agents/sdk-python/pull/2013)

### Other
- remove Cohere from required integ test providers (https://github.com/strands-agents/sdk-python/pull/1967)

## SDK TypeScript v1.0.0-rc.2 — 2026-03-31
Release: https://github.com/strands-agents/sdk-typescript/releases/tag/v1.0.0-rc.2 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/1.0.0-rc.2

### Features
- make multiagent state implements stateSerializable [multiagent] (https://github.com/strands-agents/sdk-typescript/pull/740)
- add VercelModel adapter for Language Model Specification v3 providers (https://github.com/strands-agents/sdk-typescript/pull/702)
- add SummarizationConversationManager (https://github.com/strands-agents/sdk-typescript/pull/746)
- mark LocalAgent interface as internal-only (https://github.com/strands-agents/sdk-typescript/pull/755)
- add Model to Before/AfterModelCallEvent. add Model to Conversat… (https://github.com/strands-agents/sdk-typescript/pull/754)
- rename summarization -\> SummarizingConversationManager; mark mo… (https://github.com/strands-agents/sdk-typescript/pull/766)

### Other
- rename VercelModelOptions.model to provider (https://github.com/strands-agents/sdk-typescript/pull/753)

## Evals v0.1.13 — 2026-03-31
Release: https://github.com/strands-agents/evals/releases/tag/v0.1.13 · Package: https://pypi.org/project/strands-agents-evals/0.1.13/

### Features
- add LocalFileTaskResultStore for caching task results locally (https://github.com/strands-agents/evals/pull/178)
- langfuse provider changes to support newer version of langfuse (https://github.com/strands-agents/evals/pull/165)

## SDK TypeScript v1.0.0-rc.1 — 2026-03-26
Release: https://github.com/strands-agents/sdk-typescript/releases/tag/v1.0.0-rc.1 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/1.0.0-rc.1

### Fixes
- remove top level telemetry export [otel] (https://github.com/strands-agents/sdk-typescript/pull/748)

## SDK TypeScript v1.0.0-rc.0 — 2026-03-26
Release: https://github.com/strands-agents/sdk-typescript/releases/tag/v1.0.0-rc.0 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/1.0.0-rc.0

### Features
- prevent self-handoffs in Swarm [multiagent] (https://github.com/strands-agents/sdk-typescript/pull/697)
- update default model to Claude Sonnet 4 (claude-sonnet-4-6) (https://github.com/strands-agents/sdk-typescript/pull/692)
- add before tool cancellation support [hooks] (https://github.com/strands-agents/sdk-typescript/pull/696)
- add local traces into agentResult [otel] (https://github.com/strands-agents/sdk-typescript/pull/620)
- add multi-agent traces [multiagent, otel] (https://github.com/strands-agents/sdk-typescript/pull/666)
- add model subpath exports, rename GeminiModel to GoogleModel, and add api field to OpenAIModel (https://github.com/strands-agents/sdk-typescript/pull/711)
- add toJSON() to multiagent and a2a streaming events for wire-safe serialization [multiagent] (https://github.com/strands-agents/sdk-typescript/pull/741)
- add toJSON() to all streaming events for wire-safe serialization [bidirectional-streaming] (https://github.com/strands-agents/sdk-typescript/pull/708)

### Fixes
- gemini model should handle throttling correctly [model] (https://github.com/strands-agents/sdk-typescript/pull/691)
- use logger instead of console log that bypass logging system (https://github.com/strands-agents/sdk-typescript/pull/698)
- remove vi.restoreAllMocks() breaking Anthropic mock in browser tests [model] (https://github.com/strands-agents/sdk-typescript/pull/700)
- swarm maxstep throws when finish normally [multiagent] (https://github.com/strands-agents/sdk-typescript/pull/678)
- correctly restore null systemPrompt in loadSnapshot (https://github.com/strands-agents/sdk-typescript/pull/704)
- add newline after printing agent response [agent] (https://github.com/strands-agents/sdk-typescript/pull/705)
- update anthropic log line to follow structured logging convention [model] (https://github.com/strands-agents/sdk-typescript/pull/706)
- use undefined rather than falsy system prompt check (https://github.com/strands-agents/sdk-typescript/pull/707)
- clarify A2AAgent log message for non-text content stripping (https://github.com/strands-agents/sdk-typescript/pull/718)
- sliding window conversation manager treats windowSize 0 as no-op (https://github.com/strands-agents/sdk-typescript/pull/716)
- standardize log messages to follow structured logging format (https://github.com/strands-agents/sdk-typescript/pull/722)
- update default OpenAI model IDs to current generation [model] (https://github.com/strands-agents/sdk-typescript/pull/723)
- inner node status should propagate (https://github.com/strands-agents/sdk-typescript/pull/726)
- add SessionManager guard rails and widen snapshot types to LocalAgent (https://github.com/strands-agents/sdk-typescript/pull/730)
- add persistence to vended bash tool [tool] (https://github.com/strands-agents/sdk-typescript/pull/738)
- force slidingWindowConversationManager to use user message (https://github.com/strands-agents/sdk-typescript/pull/739)
- guarantee after-events fire during hook errors and stream cleanup [hooks] (https://github.com/strands-agents/sdk-typescript/pull/737)
- move A2AExpressServer to dedicated subpath export for browser compatibility (https://github.com/strands-agents/sdk-typescript/pull/721)
- allow pre-release versions in NPM publish workflow (https://github.com/strands-agents/sdk-typescript/pull/745)
- add --tag latest to npm publish for pre-release versions (https://github.com/strands-agents/sdk-typescript/pull/747)

### Other
- bump uuid from 10.0.0 to 13.0.0 (https://github.com/strands-agents/sdk-typescript/pull/625)
- simplify structured output internals and fix infinite loop bug [structured-output] (https://github.com/strands-agents/sdk-typescript/pull/709)

## Evals v0.1.12 — 2026-03-26
Release: https://github.com/strands-agents/evals/releases/tag/v0.1.12 · Package: https://pypi.org/project/strands-agents-evals/0.1.12/

### Features
- added framework detection for traces from CloudWatch (https://github.com/strands-agents/evals/pull/164)
- add TaskResultStore for caching and replaying task execution results (https://github.com/strands-agents/evals/pull/176)
- cloudwatch change for openinference (https://github.com/strands-agents/evals/pull/174)

### Other
- unify sync/async evaluation by defaulting aevaluate to asyncio.to\_thread (https://github.com/strands-agents/evals/pull/173)

## SDK Python v1.33.0 — 2026-03-24
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.33.0 · Package: https://pypi.org/project/strands-agents/1.33.0/

### Fixes
- summarization conversation manager sometimes returns empty response (https://github.com/strands-agents/sdk-python/pull/1947)
- remove agent from swarm test to get more consistency out of it [multiagent] (https://github.com/strands-agents/sdk-python/pull/1946)
- CRITICAL: Hard pin \`litellm\<=1.82.6\` to mitigate supply chain attack [model] (https://github.com/strands-agents/sdk-python/pull/1961)

## SDK Python v1.32.0 — 2026-03-20
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.32.0 · Package: https://pypi.org/project/strands-agents/1.32.0/

### Fixes
- ensure all cycle metrics include end time and duration [otel] (https://github.com/strands-agents/sdk-python/pull/1903)
- pin upper bound for mistralai dependency (https://github.com/strands-agents/sdk-python/pull/1935)
- override end\_turn stop reason when streaming response contains toolUse blocks [bidirectional-streaming] (https://github.com/strands-agents/sdk-python/pull/1827)

## SDK Python v1.31.0 — 2026-03-19
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.31.0 · Package: https://pypi.org/project/strands-agents/1.31.0/

### Features
- pass A2A request context metadata as invocation state [a2a] (https://github.com/strands-agents/sdk-python/pull/1854)
- widen openai dependency to support 2.x for litellm compatibility [model] (https://github.com/strands-agents/sdk-python/pull/1793)

### Fixes
- s3session manager bug [sessions] (https://github.com/strands-agents/sdk-python/pull/1915)
- only evaluate outbound edges from completed nodes [multiagent] (https://github.com/strands-agents/sdk-python/pull/1846)
- always use string content for tool messages [model] (https://github.com/strands-agents/sdk-python/pull/1878)
- typeError when serializing multimodal prompts with binary content in Graph/Swarm session persistence [multiagent] (https://github.com/strands-agents/sdk-python/pull/1870)
- lowercase the python language in code snippet (https://github.com/strands-agents/sdk-python/pull/1929)
- openai repsonses api error handling [model] (https://github.com/strands-agents/sdk-python/pull/1931)

## SDK TypeScript v0.7.0 — 2026-03-19
Release: https://github.com/strands-agents/sdk-typescript/releases/tag/v0.7.0 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/0.7.0

### Features
- add guardLatestUserMessage guardrail option [model] (https://github.com/strands-agents/sdk-typescript/pull/635)
- implement Plugin system to replace HookProvider (https://github.com/strands-agents/sdk-typescript/pull/619)
- add A2A protocol support with AgentBase interface [a2a] (https://github.com/strands-agents/sdk-typescript/pull/601)
- add otel meter [otel] (https://github.com/strands-agents/sdk-typescript/pull/655)
- make Swarm start optional, defaulting to first node [multiagent] (https://github.com/strands-agents/sdk-typescript/pull/657)
- add promptcaching for bedrock model provider [model] (https://github.com/strands-agents/sdk-typescript/pull/595)
- add agents-as-tools example [tool] (https://github.com/strands-agents/sdk-typescript/pull/662)
- replace agentId with id and add id/name/description to AgentBase (https://github.com/strands-agents/sdk-typescript/pull/663)
- support documentblock, imageblock, videoblock in model providers that support it (https://github.com/strands-agents/sdk-typescript/pull/576)
- strongly type the conversation-manager (https://github.com/strands-agents/sdk-typescript/pull/664)
- add MultiAgentState to remaining multi-agent streaming events [multiagent] (https://github.com/strands-agents/sdk-typescript/pull/661)
- align S3 location pattern with Python SDK (https://github.com/strands-agents/sdk-typescript/pull/679)
- add TTFB metric, Langfuse detection, system prompt on chat spans [otel] (https://github.com/strands-agents/sdk-typescript/pull/681)

### Fixes
- delete package-lock.json (https://github.com/strands-agents/sdk-typescript/pull/649)
- fix build errors locally and on actions (https://github.com/strands-agents/sdk-typescript/pull/653)
- migrate plugins to be an interface (https://github.com/strands-agents/sdk-typescript/pull/654)
- resolve peer dependency type errors for consumers with skipLibCheck: false (https://github.com/strands-agents/sdk-typescript/pull/671)
- export LocalAgent and MultiAgent types for plugin authors [multiagent] (https://github.com/strands-agents/sdk-typescript/pull/683)
- narrow multi-agent input type to exclude Message\[\] and MessageData\[\] [multiagent] (https://github.com/strands-agents/sdk-typescript/pull/684)
- fix export type bug (https://github.com/strands-agents/sdk-typescript/pull/674)
- fix model sliently overwrites syntaxerror when both maxtoken& syntax occur (https://github.com/strands-agents/sdk-typescript/pull/680)
- fix file editor replace bug (https://github.com/strands-agents/sdk-typescript/pull/688)
- fix agent retry pass in same arg [agent] (https://github.com/strands-agents/sdk-typescript/pull/687)

### Other
- add concrete metric assertions and usage support to MockMessageModel (https://github.com/strands-agents/sdk-typescript/pull/644)
- add multi-agent orchestration documentation and examples [multiagent] (https://github.com/strands-agents/sdk-typescript/pull/648)
- extract MIME type utilities into dedicated mime module (https://github.com/strands-agents/sdk-typescript/pull/656)
- widen AgentNode and orchestrators to accept AgentBase with type discriminators (https://github.com/strands-agents/sdk-typescript/pull/665)
- make StateSerializable use symbols for private api implementations (https://github.com/strands-agents/sdk-typescript/pull/667)
- rename vended tools modules from snake\_case to kebab-case [tool] (https://github.com/strands-agents/sdk-typescript/pull/672)
- split agent interfaces into InvokableAgent and LocalAgent, rename MultiAgentBase to MultiAgent [multiagent] (https://github.com/strands-agents/sdk-typescript/pull/670)
- document NodeStreamUpdateInnerEvent source values (https://github.com/strands-agents/sdk-typescript/pull/677)
- remove v1 issue template (https://github.com/strands-agents/sdk-typescript/pull/686)
- rename AppState to StateStore and Agent.state to Agent.appState [agent] (https://github.com/strands-agents/sdk-typescript/pull/685)

## Evals v0.1.11 — 2026-03-19
Release: https://github.com/strands-agents/evals/releases/tag/v0.1.11 · Package: https://pypi.org/project/strands-agents-evals/0.1.11/

### Features
- allow flattened report (https://github.com/strands-agents/evals/pull/157)
- add environment state evaluation support (https://github.com/strands-agents/evals/pull/156)
- added Langchain mappers (https://github.com/strands-agents/evals/pull/153)
- add environment state support to OutputEvaluator (https://github.com/strands-agents/evals/pull/160)

### Fixes
- hatch run test-lint (https://github.com/strands-agents/evals/pull/161)

## SDK Python v1.30.0 — 2026-03-11
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.30.0 · Package: https://pypi.org/project/strands-agents/1.30.0/

### Features
- add "anthropic" cache strategy to bypass model ID check [model] (https://github.com/strands-agents/sdk-python/pull/1808)
- serialize tool results as JSON when possible [tool] (https://github.com/strands-agents/sdk-python/pull/1752)
- expose server instructions from InitializeResult on MCPClient [mcp] (https://github.com/strands-agents/sdk-python/pull/1814)
- add dirty flag to skip unnecessary agent state persistence [sessions] (https://github.com/strands-agents/sdk-python/pull/1803)
- add public tool\_spec setter (https://github.com/strands-agents/sdk-python/pull/1822)
- add CancellationToken for graceful agent execution cancellation [agent] (https://github.com/strands-agents/sdk-python/pull/1772)
- optimize session manager initialization [sessions] (https://github.com/strands-agents/sdk-python/pull/1829)
- add resume flag to AfterInvocationEvent [hooks] (https://github.com/strands-agents/sdk-python/pull/1767)
- add agent skills as a plugin [agent] (https://github.com/strands-agents/sdk-python/pull/1755)
- move steering from experimental to production (https://github.com/strands-agents/sdk-python/pull/1853)

### Fixes
- summary manager using structured output [structured-output] (https://github.com/strands-agents/sdk-python/pull/1805)
- added LANGFUSE\_BASE\_URL check for additinoal attribute (https://github.com/strands-agents/sdk-python/pull/1826)
- report usage metrics in streaming mode [model] (https://github.com/strands-agents/sdk-python/pull/1697)
- use output\_text for assistant messages in multi-turn conversations (https://github.com/strands-agents/sdk-python/pull/1851)
- place cache point on last user message instead of assistant (https://github.com/strands-agents/sdk-python/pull/1821)
- break circular references so Agent cleanup doesn't hang with MCPClient [agent] (https://github.com/strands-agents/sdk-python/pull/1830)
- Set \_is\_new\_session = False at the end of each initialize\_\* method (https://github.com/strands-agents/sdk-python/pull/1859)

## SDK TypeScript v0.6.0 — 2026-03-11
Release: https://github.com/strands-agents/sdk-typescript/releases/tag/v0.6.0 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/0.6.0

### Features
- add CitationsBlock for document citation support (https://github.com/strands-agents/sdk-typescript/pull/568)
- add session manager implementation and related tests [sessions] (https://github.com/strands-agents/sdk-typescript/pull/569)
- make tasks opt-in via tasksConfig [mcp] (https://github.com/strands-agents/sdk-typescript/pull/516)
- swarm orchestration pattern [multiagent] (https://github.com/strands-agents/sdk-typescript/pull/606)
- browser-compatible tracer with    NodeTracerProvider auto-detection [otel] (https://github.com/strands-agents/sdk-typescript/pull/622)
- add getTracer to telemetry api surface [otel] (https://github.com/strands-agents/sdk-typescript/pull/604)
- support both Zod and JSON schemas for tool() factory [tool] (https://github.com/strands-agents/sdk-typescript/pull/617)
- add guardrail redaction support with input/output hand… [model] (https://github.com/strands-agents/sdk-typescript/pull/631)
- graph orchestration pattern [multiagent] (https://github.com/strands-agents/sdk-typescript/pull/632)
- local metrics tracking for agent loop [otel] (https://github.com/strands-agents/sdk-typescript/pull/597)
- add delete session & list pagination API, update tests [sessions] (https://github.com/strands-agents/sdk-typescript/pull/623)

### Fixes
- remove circular import of barrel index.js in agent.ts [agent] (https://github.com/strands-agents/sdk-typescript/pull/605)
- remove deprecated eslint-env comments incompatible with flat config (https://github.com/strands-agents/sdk-typescript/pull/611)
- use source import for Agent in swarm integ tests [multiagent] (https://github.com/strands-agents/sdk-typescript/pull/628)
- add warn log when node execution fails in multi-agent orchestration [multiagent] (https://github.com/strands-agents/sdk-typescript/pull/640)

### Other
- bump express-rate-limit from 8.2.1 to 8.3.0 (https://github.com/strands-agents/sdk-typescript/pull/607)
- remove color assertions from image/video integ tests (https://github.com/strands-agents/sdk-typescript/pull/609)
- tidy registry tests in to separate \_\_tests\_\_ dir (https://github.com/strands-agents/sdk-typescript/pull/612)
- simplify ToolRegistry to name-based CRUDL interface (https://github.com/strands-agents/sdk-typescript/pull/616)
- bump actions/upload-artifact from 6 to 7 (https://github.com/strands-agents/sdk-typescript/pull/580)
- bump aws-actions/configure-aws-credentials from 5 to 6 (https://github.com/strands-agents/sdk-typescript/pull/496)
- bump actions/github-script from 7 to 8 (https://github.com/strands-agents/sdk-typescript/pull/525)
- bump amannn/action-semantic-pull-request from 5 to 6 (https://github.com/strands-agents/sdk-typescript/pull/526)
- npm audit fix (https://github.com/strands-agents/sdk-typescript/pull/638)

## Evals v0.1.10 — 2026-03-11
Release: https://github.com/strands-agents/evals/releases/tag/v0.1.10 · Package: https://pypi.org/project/strands-agents-evals/0.1.10/

### Features
- add deterministic evaluators for output and trajectory checks (https://github.com/strands-agents/evals/pull/154)

## SDK Python v1.29.0 — 2026-03-04
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.29.0 · Package: https://pypi.org/project/strands-agents/1.29.0/

### Features
- improve tool result truncation strategy [tool] (https://github.com/strands-agents/sdk-python/pull/1756)
- improve plugin creation devex with @hook and @tool decorators [tool] (https://github.com/strands-agents/sdk-python/pull/1740)
- add OpenAI Responses API model implementation [model] (https://github.com/strands-agents/sdk-python/pull/975)

### Fixes
- added latest semantic conventions as span attributes for langfuse [otel] (https://github.com/strands-agents/sdk-python/pull/1768)
- preserve guardrail\_latest\_message wrapping after tool execution [tool] (https://github.com/strands-agents/sdk-python/pull/1658)
- throw exceptions from ConcurrentToolExecutor (#1796) (https://github.com/strands-agents/sdk-python/pull/1797)

### Other
- pin virtualenv to \<21 for hatch bug (https://github.com/strands-agents/sdk-python/pull/1771)
- bump actions/upload-artifact from 6 to 7 (https://github.com/strands-agents/sdk-python/pull/1777)
- bump actions/download-artifact from 7 to 8 (https://github.com/strands-agents/sdk-python/pull/1776)

## SDK TypeScript v0.5.0 — 2026-03-04
Release: https://github.com/strands-agents/sdk-typescript/releases/tag/v0.5.0 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/0.5.0

### Features
- multiagents - components (https://github.com/strands-agents/sdk-typescript/pull/574)
- add rebased telemetry implementation [otel] (https://github.com/strands-agents/sdk-typescript/pull/579)
- rename agent state to app state [agent] (https://github.com/strands-agents/sdk-typescript/pull/591)
- structured output - per invocation override [structured-output] (https://github.com/strands-agents/sdk-typescript/pull/596)
- multiagents - components - part 2 (https://github.com/strands-agents/sdk-typescript/pull/589)

### Fixes
- auto-approve strands command and review workflows (https://github.com/strands-agents/sdk-typescript/pull/572)
- rename event loop to agent loop [agent] (https://github.com/strands-agents/sdk-typescript/pull/570)
- remove rollup pin (https://github.com/strands-agents/sdk-typescript/pull/584)
- update import to fix build (https://github.com/strands-agents/sdk-typescript/pull/599)
- get rid of \<name\> tags since in docstrings (https://github.com/strands-agents/sdk-typescript/pull/598)

### Other
- remove monkey patching for mcp [mcp] (https://github.com/strands-agents/sdk-typescript/pull/593)

## Evals v0.1.9 — 2026-03-04
Release: https://github.com/strands-agents/evals/releases/tag/v0.1.9 · Package: https://pypi.org/project/strands-agents-evals/0.1.9/

### Features
- add CloudWatchProvider to pull remote cloudwatch traces and run evals against them. (https://github.com/strands-agents/evals/pull/147)
- add ToolSimulator for tool response simulation [tool] (https://github.com/strands-agents/evals/pull/111)

## SDK Python v1.28.0 — 2026-02-25
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.28.0 · Package: https://pypi.org/project/strands-agents/1.28.0/

### Features
- support union types and list of types for add\_hook [hooks] (https://github.com/strands-agents/sdk-python/pull/1719)
- make pyaudio an optional dependency by lazy loading (https://github.com/strands-agents/sdk-python/pull/1731)
- add Plugin Protocol for agent extensibility [hooks] (https://github.com/strands-agents/sdk-python/pull/1733)
- add plugins parameter to Agent [agent] (https://github.com/strands-agents/sdk-python/pull/1734)
- migrate SteeringHandler from HookProvider to Plugin (https://github.com/strands-agents/sdk-python/pull/1738)

### Fixes
- update region for agentcore in our new account (https://github.com/strands-agents/sdk-python/pull/1715)
- remove test that fails for python 3.14 (https://github.com/strands-agents/sdk-python/pull/1717)
- rename init\_plugin to init\_agent (https://github.com/strands-agents/sdk-python/pull/1765)

### Other
- convert Plugin from Protocol to ABC (https://github.com/strands-agents/sdk-python/pull/1741)
- switch to Sonnet 4.6 for Anthropic provider integ tests [model] (https://github.com/strands-agents/sdk-python/pull/1754)

## SDK TypeScript v0.4.0 — 2026-02-25
Release: https://github.com/strands-agents/sdk-typescript/releases/tag/v0.4.0 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/0.4.0

### Features
- add structured output support with Zod schema validation [structured-output] (https://github.com/strands-agents/sdk-typescript/pull/402)
- sessionManager - Interface Design & Storage Implementation (https://github.com/strands-agents/sdk-typescript/pull/520)
- add serialization/deserialization support for Message & ContentBlocks (https://github.com/strands-agents/sdk-typescript/pull/548)
- implement low-level snapshot API [agent] (https://github.com/strands-agents/sdk-typescript/pull/560)
- wrap raw data objects in event wrappers for agent stream [bidirectional-streaming] (https://github.com/strands-agents/sdk-typescript/pull/544)
- add multi-agent node orchestration primitives [multiagent] (https://github.com/strands-agents/sdk-typescript/pull/547)

## Evals v0.1.8 — 2026-02-25
Release: https://github.com/strands-agents/evals/releases/tag/v0.1.8 · Package: https://pypi.org/project/strands-agents-evals/0.1.8/

### Features
- trace provider interface (https://github.com/strands-agents/evals/pull/140)
- add LangfuseProvider for remote trace evaluation (https://github.com/strands-agents/evals/pull/144)

### Fixes
- handle parallel tool calls during tool extraction [tool] (https://github.com/strands-agents/evals/pull/137)

### Other
- bump amannn/action-semantic-pull-request from 5 to 6 (https://github.com/strands-agents/evals/pull/138)

## SDK Python v1.27.0 — 2026-02-19
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.27.0 · Package: https://pypi.org/project/strands-agents/1.27.0/

### Features
- Propagate exceptions to AfterToolCallEvent for decorated tools (#1565) [tool] (https://github.com/strands-agents/sdk-python/pull/1566)
- add conventional commit workflow in PR (https://github.com/strands-agents/sdk-python/pull/1645)
- add concurrent\_invocation\_mode parameter [agent] (https://github.com/strands-agents/sdk-python/pull/1707)
- add add\_hook convenience method for hook callback registration [agent] (https://github.com/strands-agents/sdk-python/pull/1706)

### Fixes
- the A2AAgent returns empty AgentResult content (https://github.com/strands-agents/sdk-python/pull/1675)
- correct output reference for approval-env in integration test (https://github.com/strands-agents/sdk-python/pull/1685)
- update approval env var for strands agent workflows [agent] (https://github.com/strands-agents/sdk-python/pull/1701)
- update allowed roles to include maintainer (https://github.com/strands-agents/sdk-python/pull/1704)
- propagate reasoningSignature on Gemini tool use [model] (https://github.com/strands-agents/sdk-python/pull/1703)
- handle OpenAI model responses with tool calls and no other assistant content [model] (https://github.com/strands-agents/sdk-python/pull/1562)
- Update finalize condition for workflow execution (https://github.com/strands-agents/sdk-python/pull/1708)
- upgrade mcp minimum dependency to 1.23.0 for Tasks support [mcp] (https://github.com/strands-agents/sdk-python/pull/1674)

### Other
- auto run review workflow on maintainer PR (https://github.com/strands-agents/sdk-python/pull/1673)
- bump actions/github-script from 7 to 8 (https://github.com/strands-agents/sdk-python/pull/1699)
- bump amannn/action-semantic-pull-request from 5 to 6 (https://github.com/strands-agents/sdk-python/pull/1684)
- coverage for python 3.14 (https://github.com/strands-agents/sdk-python/pull/1178)

## SDK TypeScript v0.3.0 — 2026-02-19
Release: https://github.com/strands-agents/sdk-typescript/releases/tag/v0.3.0 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/0.3.0

### Features
- add conventional commit workflow in PR (https://github.com/strands-agents/sdk-typescript/pull/518)
- add tool calling support [model] (https://github.com/strands-agents/sdk-typescript/pull/517)
- add environment-specific unit test naming convention (https://github.com/strands-agents/sdk-typescript/pull/541)

### Fixes
- correct output reference for approval-env in integration test (https://github.com/strands-agents/sdk-typescript/pull/529)
- update finalize condition for workflow execution (https://github.com/strands-agents/sdk-typescript/pull/543)
- update env auth parameter name (https://github.com/strands-agents/sdk-typescript/pull/534)

### Other
- auto run review workflow on maintainer PR (https://github.com/strands-agents/sdk-typescript/pull/522)
- bump qs from 6.14.1 to 6.14.2 (https://github.com/strands-agents/sdk-typescript/pull/523)

## Evals v0.1.7 — 2026-02-19
Release: https://github.com/strands-agents/evals/releases/tag/v0.1.7 · Package: https://pypi.org/project/strands-agents-evals/0.1.7/

### Features
- add conventional commit workflow in PR (https://github.com/strands-agents/evals/pull/134)

### Fixes
- retrieve multiple text contentBlock in messageConent (https://github.com/strands-agents/evals/pull/133)
- add tool info to concisenss, harmfulness, helpfulness and response relevance evaluators [tool] (https://github.com/strands-agents/evals/pull/132)
- update output variable name in workflow (https://github.com/strands-agents/evals/pull/139)
- update finalize condition for workflow execution (https://github.com/strands-agents/evals/pull/142)

## SDK Python v1.26.0 — 2026-02-11
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.26.0 · Package: https://pypi.org/project/strands-agents/1.26.0/

### Features
- Implement basic support for Tasks [mcp] (https://github.com/strands-agents/sdk-python/pull/1475)

### Fixes
- set empty text part data in \`parts\` for \`Artifact\` [multiagent] (https://github.com/strands-agents/sdk-python/pull/1643)
- use model stream to generate summary [bidirectional-streaming] (https://github.com/strands-agents/sdk-python/pull/1653)
- add 'prompt is too long' to context window overflow mes… [model] (https://github.com/strands-agents/sdk-python/pull/1663)
- fix mcp tests [mcp] (https://github.com/strands-agents/sdk-python/pull/1664)

### Other
- bump aws-actions/configure-aws-credentials from 5 to 6 (https://github.com/strands-agents/sdk-python/pull/1632)
- add guidance on using Protocol instead of Callable for extensible interfaces (https://github.com/strands-agents/sdk-python/pull/1637)

## SDK TypeScript v0.2.2 — 2026-02-11
Release: https://github.com/strands-agents/sdk-typescript/releases/tag/v0.2.2 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/0.2.2

### Features
- Support Anthropic as a model provider [model] (https://github.com/strands-agents/sdk-typescript/pull/374)
- add ModelThrottledError for rate limiting (https://github.com/strands-agents/sdk-typescript/pull/498)
- add apiKey option to BedrockModel for bearer token authentication (https://github.com/strands-agents/sdk-typescript/pull/509)
- add image, video, document, and reasoning content support [model] (https://github.com/strands-agents/sdk-typescript/pull/495)

### Fixes
- run npm clean install (https://github.com/strands-agents/sdk-typescript/pull/499)

### Other
- add dependency management guidelines to AGENTS.md (https://github.com/strands-agents/sdk-typescript/pull/507)
- docs - when to modify package-lock.json (https://github.com/strands-agents/sdk-typescript/pull/510)
- Add AgentInitializedEvent to Hook System [hooks] (https://github.com/strands-agents/sdk-typescript/pull/512)

## Evals v0.1.6 — 2026-02-11
Release: https://github.com/strands-agents/evals/releases/tag/v0.1.6 · Package: https://pypi.org/project/strands-agents-evals/0.1.6/

### Other
- centralized InputT and OutputT (https://github.com/strands-agents/evals/pull/124)
- Added CoherenceEvaluator (https://github.com/strands-agents/evals/pull/125)

## SDK Python v1.25.0 — 2026-02-05
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.25.0 · Package: https://pypi.org/project/strands-agents/1.25.0/

### Features
- add A2AAgent class (https://github.com/strands-agents/sdk-python/pull/1441)
- make structured output prompt message configurable (#1288) (https://github.com/strands-agents/sdk-python/pull/1627)
- Add AgentBase support for A2AAgent compatibility (https://github.com/strands-agents/sdk-python/pull/1615)

### Fixes
- preserve nullable semantics for required Union\[T, None\] params (https://github.com/strands-agents/sdk-python/pull/1584)
- LedgerProvider handles parallel tool calls (https://github.com/strands-agents/sdk-python/pull/1559)
- Handles Bedrock-style context overflow errors for OpenAI-compatible endpoints (https://github.com/strands-agents/sdk-python/pull/1529)
- Update retry\_strategy=None to turn off retries (https://github.com/strands-agents/sdk-python/pull/1630)
- update agent card URL when host/port overridden in A2AServer.ser… (https://github.com/strands-agents/sdk-python/pull/1626)

### Other
- Increase pytest timeout to 45 seconds (https://github.com/strands-agents/sdk-python/pull/1586)
- Publish integ tests results to cloudwatch (https://github.com/strands-agents/sdk-python/pull/1587)
- Feature: Allow s3Location as Document, Image, and Video location source (https://github.com/strands-agents/sdk-python/pull/1572)
- Clone main metrics upload script for integ tests (https://github.com/strands-agents/sdk-python/pull/1600)
- Skip location for non bedrock model providers (https://github.com/strands-agents/sdk-python/pull/1602)
- Add conditional execution for finalize step (https://github.com/strands-agents/sdk-python/pull/1605)
- interrupts - graph - multiagent nodes (https://github.com/strands-agents/sdk-python/pull/1606)
- fix various test warnings (https://github.com/strands-agents/sdk-python/pull/1613)
- Fix bedrock file warnings (https://github.com/strands-agents/sdk-python/pull/1603)
- increase test timeout (https://github.com/strands-agents/sdk-python/pull/1623)
- Fix openai test (https://github.com/strands-agents/sdk-python/pull/1624)
- bump actions/setup-python from 4 to 6 (https://github.com/strands-agents/sdk-python/pull/1548)
- bump aws-actions/configure-aws-credentials from 4 to 5 (https://github.com/strands-agents/sdk-python/pull/1547)
- bump actions/download-artifact from 4 to 7 (https://github.com/strands-agents/sdk-python/pull/1609)
- bump actions/upload-artifact from 4 to 6 (https://github.com/strands-agents/sdk-python/pull/1608)
- remove broken MCP transport timeout test (https://github.com/strands-agents/sdk-python/pull/1635)

## SDK TypeScript v0.2.1 — 2026-02-05
Release: https://github.com/strands-agents/sdk-typescript/releases/tag/v0.2.1 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/0.2.1

### Features
- add retry property to AfterToolCallEvent (https://github.com/strands-agents/sdk-typescript/pull/493)
- add text only implementation of gemini model (https://github.com/strands-agents/sdk-typescript/pull/426)

### Fixes
- add @google/genai to devDependencies for TypeScript compilation (https://github.com/strands-agents/sdk-typescript/pull/502)

### Other
- add sqs arn from secret (https://github.com/strands-agents/sdk-typescript/pull/459)
- Add always condition to finalize step, fix audit, and update bash test to use real path (https://github.com/strands-agents/sdk-typescript/pull/465)
- Add sqs arn (https://github.com/strands-agents/sdk-typescript/pull/470)

## Evals v0.1.5 — 2026-02-05
Release: https://github.com/strands-agents/evals/releases/tag/v0.1.5 · Package: https://pypi.org/project/strands-agents-evals/0.1.5/

### Features
- added ResponseRelevanceEvaluator (https://github.com/strands-agents/evals/pull/112)
- added ConcisenessEvaluator (https://github.com/strands-agents/evals/pull/115)

### Fixes
- replace deprecated structured\_output methods with new API (https://github.com/strands-agents/evals/pull/67)

### Other
- Feat/retry throttled tenacity (https://github.com/strands-agents/evals/pull/107)
- bump aws-actions/configure-aws-credentials from 5 to 6 (https://github.com/strands-agents/evals/pull/118)
- workflow: add strands-command for PR and issue (https://github.com/strands-agents/evals/pull/122)

## SDK Python v1.24.0 — 2026-01-29
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.24.0 · Package: https://pypi.org/project/strands-agents/1.24.0/

### Features
- add automatic prompt caching support [model] (https://github.com/strands-agents/sdk-python/pull/1438)
- add retry mechanism for tool calls [hooks] (https://github.com/strands-agents/sdk-python/pull/1556)
- move ToolProvider out of experimental namespace [tool] (https://github.com/strands-agents/sdk-python/pull/1567)
- update AgentResult \_\_str\_\_ priority order [agent] (https://github.com/strands-agents/sdk-python/pull/1553)
- Add invocation state [hooks] (https://github.com/strands-agents/sdk-python/pull/1550)

### Fixes
- Populate tool\_args correctly for steering (https://github.com/strands-agents/sdk-python/pull/1531)

### Other
- fix flaky openai structured output test by adding Field guidance [model] (https://github.com/strands-agents/sdk-python/pull/1534)
- interrupts - multiagent - do not emit AfterNodeCallEvent on interrupt [multiagent] (https://github.com/strands-agents/sdk-python/pull/1539)
- add workflow for lambda layer publish (https://github.com/strands-agents/sdk-python/pull/870)
- interrupts - graph - agent based [multiagent] (https://github.com/strands-agents/sdk-python/pull/1533)
- refactor use\_span to be closed automatically (https://github.com/strands-agents/sdk-python/pull/1293)
- limit permission scope on lambda layer github action (https://github.com/strands-agents/sdk-python/pull/1555)
- Enable Auto-close labels on Pull requests as well. (https://github.com/strands-agents/sdk-python/pull/1552)
- Use devtools actions (https://github.com/strands-agents/sdk-python/pull/1554)
- \[FIX\] models - gemini - start and stop reasoningContent [model] (https://github.com/strands-agents/sdk-python/pull/1557)
- callback handler - fix reporting of tool when missing delta [tool] (https://github.com/strands-agents/sdk-python/pull/1573)
- Fix failing integ tests (https://github.com/strands-agents/sdk-python/pull/1580)

## SDK TypeScript v0.2.0 — 2026-01-29
Release: https://github.com/strands-agents/sdk-typescript/releases/tag/v0.2.0 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/0.2.0

### Features
- add base model exception type [model] (https://github.com/strands-agents/sdk-typescript/pull/444)

### Fixes
- pin MCP SDK to 1.25.2 [mcp] (https://github.com/strands-agents/sdk-typescript/pull/449)

### Other
- Update to use shared auth check (https://github.com/strands-agents/sdk-typescript/pull/428)
- Create v1 issue template for feature requests (https://github.com/strands-agents/sdk-typescript/pull/431)
- Add condition to authorization-check job (https://github.com/strands-agents/sdk-typescript/pull/434)
- Update issue template for v1 release (https://github.com/strands-agents/sdk-typescript/pull/432)
- Rename issue template from 'v1' to 'V1 Release' (https://github.com/strands-agents/sdk-typescript/pull/435)
- add env for langfuse (https://github.com/strands-agents/sdk-typescript/pull/442)
- bump the production-minor group across 1 directory with 3 updates (https://github.com/strands-agents/sdk-typescript/pull/445)
- peer dependencies (https://github.com/strands-agents/sdk-typescript/pull/452)
- extract code quality checks into separate workflow (https://github.com/strands-agents/sdk-typescript/pull/450)
- replace string with StopReason type for type safety (https://github.com/strands-agents/sdk-typescript/pull/322)

## Evals v0.1.4 — 2026-01-29
Release: https://github.com/strands-agents/evals/releases/tag/v0.1.4 · Package: https://pypi.org/project/strands-agents-evals/0.1.4/

### Fixes
- include tool executions in \_extract\_trace\_level [tool] (https://github.com/strands-agents/evals/pull/77)

## SDK Python v1.23.0 — 2026-01-21
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.23.0 · Package: https://pypi.org/project/strands-agents/1.23.0/

### Features
- override service name by OTEL\_SERVICE\_NAME env (https://github.com/strands-agents/sdk-python/pull/1400)
- allow steering on AfterModelCallEvents (https://github.com/strands-agents/sdk-python/pull/1429)
- add configurable retry\_strategy for model calls [agent] (https://github.com/strands-agents/sdk-python/pull/1424)
- graduate multiagent hook events from experimental [multiagent] (https://github.com/strands-agents/sdk-python/pull/1498)

### Fixes
- prevent agent hang by checking session closure state [mcp] (https://github.com/strands-agents/sdk-python/pull/1396)
- extract text from citationsContent in AgentResult.\_\_str\_\_ [agent] (https://github.com/strands-agents/sdk-python/pull/1489)
- Swap unit test sleeps with explicit signaling (https://github.com/strands-agents/sdk-python/pull/1497)
- disable thinking mode when forcing tool\_choice [model] (https://github.com/strands-agents/sdk-python/pull/1495)
- use a2a artifact update event [a2a] (https://github.com/strands-agents/sdk-python/pull/1401)
- provide unique toolUseId for gemini models [model] (https://github.com/strands-agents/sdk-python/pull/1201)
- handle missing usage attribute on ModelResponseStream [model] (https://github.com/strands-agents/sdk-python/pull/1520)
- accumulate execution\_time across interrupt/resume cycles [multiagent] (https://github.com/strands-agents/sdk-python/pull/1502)
- reduce flakiness in guardrail redact output test (https://github.com/strands-agents/sdk-python/pull/1505)

### Other
- update sphinx-rtd-theme requirement from \<2.0.0,\>=1.0.0 to \>=1.0.0,\<4.0.0 (https://github.com/strands-agents/sdk-python/pull/1466)
- update websockets requirement from \<16.0.0,\>=15.0.0 to \>=15.0.0,\<17.0.0 (https://github.com/strands-agents/sdk-python/pull/1451)
- Update ruff configuration to apply pyupgrade to modernize python syntax (https://github.com/strands-agents/sdk-python/pull/1336)
- Expose input messages to BeforeInvocationEvent hook [hooks] (https://github.com/strands-agents/sdk-python/pull/1474)
- interrupts - graph - hook based [multiagent] (https://github.com/strands-agents/sdk-python/pull/1478)
- Fix PEP 563 incompatibility with @tool decorated tools [tool] (https://github.com/strands-agents/sdk-python/pull/1494)
- Add parallel reading support to S3SessionManager.list\_messages() (https://github.com/strands-agents/sdk-python/pull/1186)
- gemini - tool\_use\_id\_to\_name - local [model] (https://github.com/strands-agents/sdk-python/pull/1521)
- Nova Sonic 2 support for BidiAgent (https://github.com/strands-agents/sdk-python/pull/1476)

## SDK TypeScript v0.1.6 — 2026-01-21
Release: https://github.com/strands-agents/sdk-typescript/releases/tag/v0.1.6 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/0.1.6

### Features
- add support for task-augmented MCP tools [mcp] (https://github.com/strands-agents/sdk-typescript/pull/357)

### Other
- Test multiple node versions (https://github.com/strands-agents/sdk-typescript/pull/353)
- bump the production-minor group with 3 updates (https://github.com/strands-agents/sdk-typescript/pull/405)
- Add PR review agent - rebased [agent] (https://github.com/strands-agents/sdk-typescript/pull/409)
- bump the production-minor group with 2 updates (https://github.com/strands-agents/sdk-typescript/pull/410)
- Use devtools strands command (https://github.com/strands-agents/sdk-typescript/pull/408)
- Feature: export Model as value and not as type (https://github.com/strands-agents/sdk-typescript/pull/387)

## Evals v0.1.3 — 2026-01-21
Release: https://github.com/strands-agents/evals/releases/tag/v0.1.3 · Package: https://pypi.org/project/strands-agents-evals/0.1.3/

### Fixes
- Multiple Tool Usage Not Detected in tools\_use\_extractor.py [tool] (https://github.com/strands-agents/evals/pull/80)

## SDK Python v1.22.0 — 2026-01-13
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.22.0 · Package: https://pypi.org/project/strands-agents/1.22.0/

### Features
- provide extra command content as the the prompt to the agent [agent] (https://github.com/strands-agents/sdk-python/pull/1419)
- add guardrail\_latest\_message option [model] (https://github.com/strands-agents/sdk-python/pull/1224)
- introduce AgentBase Protocol as the interface for agent classes to implement [agent] (https://github.com/strands-agents/sdk-python/pull/1126)
- pass invocation\_state to model providers (https://github.com/strands-agents/sdk-python/pull/1414)

### Fixes
- import errors for models with optional imports (https://github.com/strands-agents/sdk-python/pull/1384)
- UnboundLocal Exception Fix [model] (https://github.com/strands-agents/sdk-python/pull/1420)
- make calculator tool more robust to LLM output variations [tool] (https://github.com/strands-agents/sdk-python/pull/1445)
- resolve string formatting error in MCP client error handling [mcp] (https://github.com/strands-agents/sdk-python/pull/1446)
- add concurrency protection to prevent parallel invocations from corrupting agent state [agent] (https://github.com/strands-agents/sdk-python/pull/1453)
- propagate contextvars to background thread [mcp] (https://github.com/strands-agents/sdk-python/pull/1444)

### Other
- update github agent action to reference S3\_SESSION\_BUCKET [agent] (https://github.com/strands-agents/sdk-python/pull/1418)
- \[FEATURE\] add MCP resource operations in MCP Tools [mcp] (https://github.com/strands-agents/sdk-python/pull/1117)
- add BidiGeminiLiveModel and BidiOpenAIRealtimeModel to the init (https://github.com/strands-agents/sdk-python/pull/1383)
- bidi - async - remove cancelling call (https://github.com/strands-agents/sdk-python/pull/1357)
- fix! Litellm handle non streaming response fix for issue #477 [model] (https://github.com/strands-agents/sdk-python/pull/512)
- update pytest requirement from \<9.0.0,\>=8.0.0 to \>=8.0.0,\<10.0.0 in the dev-dependencies group (https://github.com/strands-agents/sdk-python/pull/1161)
- Add Security.md file (https://github.com/strands-agents/sdk-python/pull/1454)
- Update release notes sop (https://github.com/strands-agents/sdk-python/pull/1456)
- bidi - move 3.12 check to nova sonic module (https://github.com/strands-agents/sdk-python/pull/1439)
- update sphinx requirement from \<9.0.0,\>=5.0.0 to \>=5.0.0,\<10.0.0 (https://github.com/strands-agents/sdk-python/pull/1426)
- Update to opus 4.5 (https://github.com/strands-agents/sdk-python/pull/1471)

## SDK TypeScript v0.1.5 — 2026-01-13
Release: https://github.com/strands-agents/sdk-typescript/releases/tag/v0.1.5 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/0.1.5

### Other
- Fix audit issue (https://github.com/strands-agents/sdk-typescript/pull/378)
- Fix audit errors + split out audit to a separate workflow (https://github.com/strands-agents/sdk-typescript/pull/397)
- Update model to opus 4.5 (https://github.com/strands-agents/sdk-typescript/pull/400)

## Evals v0.1.2 — 2026-01-13
Release: https://github.com/strands-agents/evals/releases/tag/v0.1.2 · Package: https://pypi.org/project/strands-agents-evals/0.1.2/

### Fixes
- Isolate evaluator errors in run\_evaluations (https://github.com/strands-agents/evals/pull/84)
- Add null check for toolResult in message extraction (https://github.com/strands-agents/evals/pull/85)

## SDK Python v1.21.0 — 2026-01-02
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.21.0 · Package: https://pypi.org/project/strands-agents/1.21.0/

### Features
- support passing additional keyword arguments to FastAPI and Starlette constructors [a2a] (https://github.com/strands-agents/sdk-python/pull/1250)
- add replace method to ToolRegistry [tool] (https://github.com/strands-agents/sdk-python/pull/1182)
- add meta field support to MCP tool results [mcp] (https://github.com/strands-agents/sdk-python/pull/1237)
- Add support for web and search result citations (https://github.com/strands-agents/sdk-python/pull/1344)
- add gemini\_tools field to GeminiModel with validation and tests (https://github.com/strands-agents/sdk-python/pull/1050)
- allow custom-client for OpenAIModel and GeminiModel (https://github.com/strands-agents/sdk-python/pull/1366)
- add api check to github workflow (https://github.com/strands-agents/sdk-python/pull/1348)
- add per\_turn parameter to SlidingWindowConversationManager (https://github.com/strands-agents/sdk-python/pull/1374)
- added agent\_invocations (https://github.com/strands-agents/sdk-python/pull/1387)
- allow hooks to retry model invocations on exceptions [hooks] (https://github.com/strands-agents/sdk-python/pull/1405)

### Fixes
- remove unnecessary None from dict.get() calls (https://github.com/strands-agents/sdk-python/pull/956)
- CitationLocation is UnionType, and correctly joining citation chunks when streaming is being used [bidirectional-streaming] (https://github.com/strands-agents/sdk-python/pull/1341)
- prevent double counting of usage metrics [otel] (https://github.com/strands-agents/sdk-python/pull/1327)
- Pass CODECOV\_TOKENS through for code-coverage stats (https://github.com/strands-agents/sdk-python/pull/1385)
- check api breaking change against main (https://github.com/strands-agents/sdk-python/pull/1397)
- support tools returning image content [model] (https://github.com/strands-agents/sdk-python/pull/1079)
- emit deprecation warning only when deprecated aliases are accessed (https://github.com/strands-agents/sdk-python/pull/1380)

### Other
- Add issue-responder action agent [agent] (https://github.com/strands-agents/sdk-python/pull/1319)
- Expose Status from .base for easier imports (https://github.com/strands-agents/sdk-python/pull/1356)
- Port PR guidelines from sdk-typescript (https://github.com/strands-agents/sdk-python/pull/1373)
- bump actions/checkout from 5 to 6 (https://github.com/strands-agents/sdk-python/pull/1222)
- update pytest-asyncio requirement from \<1.3.0,\>=1.0.0 to \>=1.0.0,\<1.4.0 (https://github.com/strands-agents/sdk-python/pull/1166)
- bump actions/upload-artifact from 4 to 6 (https://github.com/strands-agents/sdk-python/pull/1332)
- bump actions/download-artifact from 5 to 7 (https://github.com/strands-agents/sdk-python/pull/1333)
- update pre-commit requirement from \<4.4.0,\>=3.2.0 to \>=3.2.0,\<4.6.0 (https://github.com/strands-agents/sdk-python/pull/1242)
- bump aws-actions/configure-aws-credentials from 4 to 5 (https://github.com/strands-agents/sdk-python/pull/1352)
- update ruff requirement from \<0.14.0,\>=0.13.0 to \>=0.13.0,\<0.15.0 (https://github.com/strands-agents/sdk-python/pull/1004)
- bump astral-sh/setup-uv from 6 to 7 (https://github.com/strands-agents/sdk-python/pull/1390)
- bump actions/checkout from 5 to 6 (https://github.com/strands-agents/sdk-python/pull/1389)
- Port TypeScript agents into Python (https://github.com/strands-agents/sdk-python/pull/1403)

## SDK TypeScript v0.1.4 — 2026-01-02
Release: https://github.com/strands-agents/sdk-typescript/releases/tag/v0.1.4 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/0.1.4

### Fixes
- reset accumulatedReasoning state to prevent corrupting ReasoningBlock with accumulated content [model] (https://github.com/strands-agents/sdk-typescript/pull/363)

### Other
- Add release-notes SOP for generating release notes (https://github.com/strands-agents/sdk-typescript/pull/361)
- bump the development-dependencies group across 1 directory with 4 updates (https://github.com/strands-agents/sdk-typescript/pull/359)
- bump the production-minor group with 2 updates (https://github.com/strands-agents/sdk-typescript/pull/358)
- bump actions/upload-artifact from 5 to 6 (https://github.com/strands-agents/sdk-typescript/pull/355)
- Make action.yml compatible with Python agents (https://github.com/strands-agents/sdk-typescript/pull/366)
- Unify bedrock & openai client creation for integ tests [model] (https://github.com/strands-agents/sdk-typescript/pull/340)
- Switch integ tests to environment opt-out pattern (https://github.com/strands-agents/sdk-typescript/pull/370)
- Provide better names for integ test jobs (https://github.com/strands-agents/sdk-typescript/pull/371)
- Mock aws config file path env var (https://github.com/strands-agents/sdk-typescript/pull/372)

## SDK Python v1.20.0 — 2025-12-15
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.20.0 · Package: https://pypi.org/project/strands-agents/1.20.0/

### Features
- add AgentResult to AfterInvocationEvent [hooks] (https://github.com/strands-agents/sdk-python/pull/1125)
- Create agent.md and docs folder [agent] (https://github.com/strands-agents/sdk-python/pull/1312)

### Fixes
- Return structured output JSON when AgentResult has no text [agent] (https://github.com/strands-agents/sdk-python/pull/1290)
- fix broken tool spec with composition keywords [tool] (https://github.com/strands-agents/sdk-python/pull/1301)
- close mcp client event loop [mcp] (https://github.com/strands-agents/sdk-python/pull/1321)

### Other
- Remove toolResult message when toolUse is missing due to pagination in session management [sessions] (https://github.com/strands-agents/sdk-python/pull/1274)
- interrupts - swarm [multiagent] (https://github.com/strands-agents/sdk-python/pull/1193)
- bidi - fix record direct tool call [tool] (https://github.com/strands-agents/sdk-python/pull/1300)
- Update doc strings to eliminate warnings in doc build (https://github.com/strands-agents/sdk-python/pull/1284)
- bidi - tests - lint (https://github.com/strands-agents/sdk-python/pull/1307)
- bidi - fix mypy errors (https://github.com/strands-agents/sdk-python/pull/1308)
- bidi - remove python 3.11+ features (https://github.com/strands-agents/sdk-python/pull/1302)

## SDK TypeScript v0.1.3 — 2025-12-15
Release: https://github.com/strands-agents/sdk-typescript/releases/tag/v0.1.3 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/0.1.3

### Fixes
- missing export entry for vended\_tools/bash (https://github.com/strands-agents/sdk-typescript/pull/319)
- Update agent PR creation logic to url encode parameters [agent] (https://github.com/strands-agents/sdk-typescript/pull/333)
- Removed MCP implementation info from AGENTS.md [mcp] (https://github.com/strands-agents/sdk-typescript/pull/349)

### Other
- Allow OpenAI apiKey to accept function for dynamic key loading [model] (https://github.com/strands-agents/sdk-typescript/pull/320)
- Enable vitest test reports + upload artifacts (https://github.com/strands-agents/sdk-typescript/pull/325)
- Update TypeScript configurations for tests & source (https://github.com/strands-agents/sdk-typescript/pull/324)
- Tweak agent runner to be more general-purpose [agent] (https://github.com/strands-agents/sdk-typescript/pull/326)
- Move vended\_tools under src (https://github.com/strands-agents/sdk-typescript/pull/327)
- Move integration tests into test/integ (https://github.com/strands-agents/sdk-typescript/pull/328)
- bump @aws-sdk/client-bedrock-runtime from 3.943.0 to 3.946.0 [model] (https://github.com/strands-agents/sdk-typescript/pull/336)
- bump the development-dependencies group across 1 directory with 4 updates (https://github.com/strands-agents/sdk-typescript/pull/339)
- Guide agents(s) to be more concise on issue & PR descriptions (https://github.com/strands-agents/sdk-typescript/pull/338)
- Unify integ fixture loading and test skipping (https://github.com/strands-agents/sdk-typescript/pull/337)
- bump openai from 6.9.1 to 6.10.0 [model] (https://github.com/strands-agents/sdk-typescript/pull/323)
- Group dependabot updates together + add cooldown (https://github.com/strands-agents/sdk-typescript/pull/345)
- Update guidance with testing guide + agent guidance for tests [agent] (https://github.com/strands-agents/sdk-typescript/pull/344)
- Update task refiner to use details & summary (https://github.com/strands-agents/sdk-typescript/pull/346)

## Evals v0.1.1 — 2025-12-15
Release: https://github.com/strands-agents/evals/releases/tag/v0.1.1 · Package: https://pypi.org/project/strands-agents-evals/0.1.1/

### Features
- Extract whether tool result was an error [tool] (https://github.com/strands-agents/evals/pull/66)

### Fixes
- preserve non-ASCII characters in JSON file output (https://github.com/strands-agents/evals/pull/69)

### Other
- fix broken links (https://github.com/strands-agents/evals/pull/63)
- updated README to include simulator feature (https://github.com/strands-agents/evals/pull/70)
- bump actions/download-artifact from 4 to 7 (https://github.com/strands-agents/evals/pull/71)
- bump actions/upload-artifact from 5 to 6 (https://github.com/strands-agents/evals/pull/72)
- us VCS for versioning and remove hardcoded (https://github.com/strands-agents/evals/pull/73)

## SDK TypeScript v0.1.2 — 2025-12-04
Release: https://github.com/strands-agents/sdk-typescript/releases/tag/v0.1.2 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/0.1.2

### Other
- Update repository url for TypeDoc (https://github.com/strands-agents/sdk-typescript/pull/311)
- fix broken API reference link in README (https://github.com/strands-agents/sdk-typescript/pull/314)
- Update exports to account for CJS (https://github.com/strands-agents/sdk-typescript/pull/316)

## SDK Python v1.19.0 — 2025-12-03
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.19.0 · Package: https://pypi.org/project/strands-agents/1.19.0/

### Features
- add experimental steering for modular prompting (https://github.com/strands-agents/sdk-python/pull/1280)

### Fixes
- avoid KeyError in direct tool calls with context [tool] (https://github.com/strands-agents/sdk-python/pull/1213)
- attached custom attributes to all spans (https://github.com/strands-agents/sdk-python/pull/1235)

### Other
- hooks - before node call - cancel node [hooks] (https://github.com/strands-agents/sdk-python/pull/1203)
- interrupts - support falsey responses (https://github.com/strands-agents/sdk-python/pull/1256)
- Bidirectional Streaming Agent [bidirectional-streaming] (https://github.com/strands-agents/sdk-python/pull/1276)
- mcp - elicitation - fix server request test [mcp] (https://github.com/strands-agents/sdk-python/pull/1281)
- adjust integ test system prompts to reduce flakiness (https://github.com/strands-agents/sdk-python/pull/1282)

## SDK TypeScript v0.1.1 — 2025-12-03
Release: https://github.com/strands-agents/sdk-typescript/releases/tag/v0.1.1 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/0.1.1

### Other
- bump @aws-sdk/client-bedrock-runtime from 3.941.0 to 3.943.0 [model] (https://github.com/strands-agents/sdk-typescript/pull/304)
- bump actions/upload-artifact from 4 to 5 (https://github.com/strands-agents/sdk-typescript/pull/302)
- bump the development-dependencies group with 10 updates (https://github.com/strands-agents/sdk-typescript/pull/303)
- Update mcp version [mcp] (https://github.com/strands-agents/sdk-typescript/pull/307)
- Update MCP example in readme [mcp] (https://github.com/strands-agents/sdk-typescript/pull/308)

## Evals v0.1.0 — 2025-12-03
Release: https://github.com/strands-agents/evals/releases/tag/v0.1.0 · Package: https://pypi.org/project/strands-agents-evals/0.1.0/

## SDK TypeScript v0.1.0 — 2025-12-03
Release: https://github.com/strands-agents/sdk-typescript/releases/tag/v0.1.0 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/0.1.0

## SDK Python v1.18.0 — 2025-11-21
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.18.0 · Package: https://pypi.org/project/strands-agents/1.18.0/

### Fixes
- fix swarm session management integ test. [multiagent] (https://github.com/strands-agents/sdk-python/pull/1155)
- protect connection on non-fatal client side timeout error [mcp] (https://github.com/strands-agents/sdk-python/pull/1231)
- populate cacheWriteInputTokens from cache\_creation\_input\_token not cache\_creation\_tokens [model] (https://github.com/strands-agents/sdk-python/pull/1233)
- fix integ test for mcp elicitation\_server [mcp] (https://github.com/strands-agents/sdk-python/pull/1234)

### Other
- multi agent input [agent] (https://github.com/strands-agents/sdk-python/pull/1196)
- interrupt - activate - set context separately [context] (https://github.com/strands-agents/sdk-python/pull/1194)
- In PrintingCallbackHandler, make the verbose description and counting… (https://github.com/strands-agents/sdk-python/pull/1211)
- move tool caller definition out of agent module [tool] (https://github.com/strands-agents/sdk-python/pull/1215)
- interrupt - interruptible multi agent hook interface [hooks] (https://github.com/strands-agents/sdk-python/pull/1207)
- security(tool\_loader): prevent tool name and sys modules collisions i… [tool] (https://github.com/strands-agents/sdk-python/pull/1214)

## SDK Python v1.17.0 — 2025-11-18
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.17.0 · Package: https://pypi.org/project/strands-agents/1.17.0/

### Features
- allow setting a timeout when creating MCPAgentTool (https://github.com/strands-agents/sdk-python/pull/1184)

### Fixes
- add validation for stream parameter in LiteLLM [model] (https://github.com/strands-agents/sdk-python/pull/1183)
- handle MetadataEvents without optional usage and metrics [otel] (https://github.com/strands-agents/sdk-python/pull/1187)
- base64 decode byte data before placing in ContentBlocks [a2a] (https://github.com/strands-agents/sdk-python/pull/1195)

### Other
- swarm - switch to handoff node only after current node stops [multiagent] (https://github.com/strands-agents/sdk-python/pull/1147)

## SDK Python v1.16.0 — 2025-11-12
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.16.0 · Package: https://pypi.org/project/strands-agents/1.16.0/

### Features
- Add tool definitions to traces via semconv opt-in [otel] (https://github.com/strands-agents/sdk-python/pull/1113)
- Support string descriptions in Annotated parameters [tool] (https://github.com/strands-agents/sdk-python/pull/1089)
- allow SystemContentBlocks in LiteLLMModel [model] (https://github.com/strands-agents/sdk-python/pull/1141)

### Fixes
- handle non-JSON error messages from Gemini API [model] (https://github.com/strands-agents/sdk-python/pull/1062)
- Handle "prompt is too long" from Anthropic [model] (https://github.com/strands-agents/sdk-python/pull/1137)
- Strip argument sections out of inputSpec top-level description (https://github.com/strands-agents/sdk-python/pull/1142)
- Don't hang when MCP server returns 5xx [mcp] (https://github.com/strands-agents/sdk-python/pull/1169)
- allow setter on system\_prompt and system\_prompt\_content [model] (https://github.com/strands-agents/sdk-python/pull/1171)

### Other
- share thread context [context] (https://github.com/strands-agents/sdk-python/pull/1146)
- async hooks [hooks] (https://github.com/strands-agents/sdk-python/pull/1119)
- updated opt-in attributes to internal [otel] (https://github.com/strands-agents/sdk-python/pull/1152)
- share interrupt state (https://github.com/strands-agents/sdk-python/pull/1148)

## SDK Python v1.15.0 — 2025-11-04
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.15.0 · Package: https://pypi.org/project/strands-agents/1.15.0/

### Features
- add multiagent session/repository management. [multiagent] (https://github.com/strands-agents/sdk-python/pull/1071)
- Add stream\_async [multiagent] (https://github.com/strands-agents/sdk-python/pull/961)
- Enable multiagent session persistent in Graph/Swarm [multiagent] (https://github.com/strands-agents/sdk-python/pull/1110)
- add SystemContentBlock support for provider-agnostic caching [model] (https://github.com/strands-agents/sdk-python/pull/1112)

### Fixes
- (bug): Drop reasoningContent from request (https://github.com/strands-agents/sdk-python/pull/1099)
- Dont initialize an agent on swarm init [multiagent] (https://github.com/strands-agents/sdk-python/pull/1107)
- Allow none structured output context in tool executors [structured-output] (https://github.com/strands-agents/sdk-python/pull/1128)
- Fix broken converstaion with orphaned toolUse (https://github.com/strands-agents/sdk-python/pull/1123)

### Other
- Fix #1077: properly redact toolResult blocks to avoid corrupting the conversation (https://github.com/strands-agents/sdk-python/pull/1080)
- linting (https://github.com/strands-agents/sdk-python/pull/1120)
- Fix input/output message not redacted when guardrails\_trace="enabled\_full" (https://github.com/strands-agents/sdk-python/pull/1072)

## SDK Python v1.14.0 — 2025-10-29
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.14.0 · Package: https://pypi.org/project/strands-agents/1.14.0/

### Features
- add experimental AgentConfig with comprehensive tool management [tool] (https://github.com/strands-agents/sdk-python/pull/935)
- add multiagent hooks, add serialize & deserialize function to multiagent base & agent result [multiagent] (https://github.com/strands-agents/sdk-python/pull/1070)
- Add Structured Output as part of the agent loop [structured-output] (https://github.com/strands-agents/sdk-python/pull/943)
- add experimental agent managed connection via ToolProvider [mcp] (https://github.com/strands-agents/sdk-python/pull/895)
- skip model invocation when latest message contains ToolUse (https://github.com/strands-agents/sdk-python/pull/1068)

### Fixes
- make strands agent invoke\_agent span as INTERNAL spanKind [otel] (https://github.com/strands-agents/sdk-python/pull/1055)
- Don't bail out if there are no tool\_uses (https://github.com/strands-agents/sdk-python/pull/1087)
- enhance structured output handling [model] (https://github.com/strands-agents/sdk-python/pull/1021)

### Other
- models - litellm - start and stop reasoning [model] (https://github.com/strands-agents/sdk-python/pull/947)
- integ tests - interrupts - remove asyncio marker (https://github.com/strands-agents/sdk-python/pull/1045)
- interrupt - docstring - fix formatting (https://github.com/strands-agents/sdk-python/pull/1074)
- add pr size labeler (https://github.com/strands-agents/sdk-python/pull/1082)
- fix (bug): retry on varying Bedrock throttlingexception cases [model] (https://github.com/strands-agents/sdk-python/pull/1096)
- direct tool call - interrupt not allowed [tool] (https://github.com/strands-agents/sdk-python/pull/1097)
- mcp elicitation [mcp] (https://github.com/strands-agents/sdk-python/pull/1094)
- Transform invalid tool usages on sending, not on initial detection [tool] (https://github.com/strands-agents/sdk-python/pull/1091)

## SDK Python v1.13.0 — 2025-10-17
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.13.0 · Package: https://pypi.org/project/strands-agents/1.13.0/

### Features
- replace kwargs with invocation\_state in agent APIs [agent] (https://github.com/strands-agents/sdk-python/pull/966)
- updated semantic conventions, added timeToFirstByteMs into spans and metrics [otel] (https://github.com/strands-agents/sdk-python/pull/997)
- Support adding exception notes for Python 3.10 (https://github.com/strands-agents/sdk-python/pull/1034)

### Fixes
- validate ToolContext parameter name and raise clear error (https://github.com/strands-agents/sdk-python/pull/1028)

### Other
- added gen\_ai.tool.description and gen\_ai.tool.json\_schema [otel] (https://github.com/strands-agents/sdk-python/pull/1027)
- integ tests - fix flaky structured output test [structured-output] (https://github.com/strands-agents/sdk-python/pull/1030)
- hooks - before tool call event - interrupt [tool] (https://github.com/strands-agents/sdk-python/pull/987)
- multiagents - temporarily raise exception when interrupted (https://github.com/strands-agents/sdk-python/pull/1038)
- interrupts - decorated tools [tool] (https://github.com/strands-agents/sdk-python/pull/1041)

## SDK Python v1.12.0 — 2025-10-10
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.12.0 · Package: https://pypi.org/project/strands-agents/1.12.0/

### Features
- Refactor and update tool loading to support modules [tool] (https://github.com/strands-agents/sdk-python/pull/989)
- use tool for litellm structured\_output when supports\_response\_schema=false [model] (https://github.com/strands-agents/sdk-python/pull/957)

### Other
- Adding Development Tenets to CONTRIBUTING.md (https://github.com/strands-agents/sdk-python/pull/1009)
- Revert "feat: implement concurrent message reading for session managers (#897)" [sessions] (https://github.com/strands-agents/sdk-python/pull/1013)
- Add EmbeddedResource support to mcp (read GitHub file contents blocker) [mcp] (https://github.com/strands-agents/sdk-python/pull/726)
- conversation manager - summarization - noop tool [tool] (https://github.com/strands-agents/sdk-python/pull/1003)
- Fix additional\_args passing in SageMakerAIModel (https://github.com/strands-agents/sdk-python/pull/983)

## SDK Python v1.11.0 — 2025-10-08
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.11.0 · Package: https://pypi.org/project/strands-agents/1.11.0/

### Features
- updated traces to match OTEL v1.37 semantic conventions [otel] (https://github.com/strands-agents/sdk-python/pull/952)
- implement concurrent message reading for session managers [sessions] (https://github.com/strands-agents/sdk-python/pull/897)

### Fixes
- GeminiModel argument in README (https://github.com/strands-agents/sdk-python/pull/955)
- removed double serialization for events [otel] (https://github.com/strands-agents/sdk-python/pull/977)
- map LiteLLM context window errors to ContextWindowOverflowException [model] (https://github.com/strands-agents/sdk-python/pull/994)

### Other
- tool - executors - concurrent - remove no-op gather [tool] (https://github.com/strands-agents/sdk-python/pull/954)
- event loop - handle model execution (https://github.com/strands-agents/sdk-python/pull/958)
- hooks - before tool call event - cancel tool [tool] (https://github.com/strands-agents/sdk-python/pull/964)

## SDK Python v1.10.0 — 2025-09-29
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.10.0 · Package: https://pypi.org/project/strands-agents/1.10.0/

### Features
- add optional outputSchema support for tool specifications [tool] (https://github.com/strands-agents/sdk-python/pull/818)
- add Gemini model provider [model] (https://github.com/strands-agents/sdk-python/pull/725)
- add supports\_hot\_reload property to PythonAgentTool (https://github.com/strands-agents/sdk-python/pull/928)
- Mark ModelCall and ToolCall events as non-experimental [hooks] (https://github.com/strands-agents/sdk-python/pull/926)
- Create a new HookEvent for Multiagent [multiagent] (https://github.com/strands-agents/sdk-python/pull/925)

### Fixes
- Fix event loop closed error from Gemini asyncio [model] (https://github.com/strands-agents/sdk-python/pull/932)
- Fix mcp timeout issue [mcp] (https://github.com/strands-agents/sdk-python/pull/922)

### Other
- Improve OpenAI error handling [model] (https://github.com/strands-agents/sdk-python/pull/918)
- update sphinx-autodoc-typehints requirement from \<2.0.0,\>=1.12.0 to \>=1.12.0,\<4.0.0 (https://github.com/strands-agents/sdk-python/pull/903)
- update sphinx requirement from \<6.0.0,\>=5.0.0 to \>=5.0.0,\<9.0.0 (https://github.com/strands-agents/sdk-python/pull/904)
- update openai requirement from \<1.108.0,\>=1.68.0 to \>=1.68.0,\<1.110.0 [model] (https://github.com/strands-agents/sdk-python/pull/916)
- update pytest-asyncio requirement from \<1.2.0,\>=1.0.0 to \>=1.0.0,\<1.3.0 (https://github.com/strands-agents/sdk-python/pull/861)

## SDK Python v1.9.1 — 2025-09-19
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.9.1 · Package: https://pypi.org/project/strands-agents/1.9.1/

### Features
- decouple Strands ContentBlock and BedrockModel (https://github.com/strands-agents/sdk-python/pull/836)

### Fixes
- Invoke callback handler for structured\_output [structured-output] (https://github.com/strands-agents/sdk-python/pull/857)
- Update prepare to use format instead of test-format (https://github.com/strands-agents/sdk-python/pull/858)
- add explicit permissions to auto-close workflow (https://github.com/strands-agents/sdk-python/pull/893)
- make mcp\_instrumentation idempotent to prevent recursion errors (https://github.com/strands-agents/sdk-python/pull/892)
- Fix github workflow to use fmt instead of hatch run (https://github.com/strands-agents/sdk-python/pull/898)
- make tool\_choice an optional keyword arg instead positional [model] (https://github.com/strands-agents/sdk-python/pull/899)

## SDK Python v1.9.0 — 2025-09-17
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.9.0 · Package: https://pypi.org/project/strands-agents/1.9.0/

### Features
- add cache usage metrics to OpenTelemetry spans [otel] (https://github.com/strands-agents/sdk-python/pull/825)
- Make entry point configurable [multiagent] (https://github.com/strands-agents/sdk-python/pull/851)
- add automated issue auto-close workflows with dry-run testing (https://github.com/strands-agents/sdk-python/pull/832)

### Fixes
- Add type to tool\_input (https://github.com/strands-agents/sdk-python/pull/854)
- Clean up pyproject.toml (https://github.com/strands-agents/sdk-python/pull/844)
- Updating documentation in decorator.py (https://github.com/strands-agents/sdk-python/pull/852)
- correctly label tool result messages in OpenTelemetry events [tool] (https://github.com/strands-agents/sdk-python/pull/839)
- litellm structured\_output test with more descriptive model [model] (https://github.com/strands-agents/sdk-python/pull/871)
- auto cleanup on exceptions occurring in \_\_enter\_\_ [mcp] (https://github.com/strands-agents/sdk-python/pull/833)
- do not verify \_background\_session is present in stop() [mcp] (https://github.com/strands-agents/sdk-python/pull/876)

### Other
- improve docstring formatting (https://github.com/strands-agents/sdk-python/pull/846)
- bump actions/setup-python from 5 to 6 (https://github.com/strands-agents/sdk-python/pull/796)
- bump actions/github-script from 7 to 8 (https://github.com/strands-agents/sdk-python/pull/801)
- bump aws-actions/configure-aws-credentials from 4 to 5 (https://github.com/strands-agents/sdk-python/pull/795)
- update ruff requirement from \<0.13.0,\>=0.12.0 to \>=0.12.0,\<0.14.0 (https://github.com/strands-agents/sdk-python/pull/840)
- update openai requirement from \<1.102.0,\>=1.68.0 to \>=1.68.0,\<1.108.0 [model] (https://github.com/strands-agents/sdk-python/pull/827)
- models - openai - use client context [model] (https://github.com/strands-agents/sdk-python/pull/856)
- Feature: Handle Bedrock redactedContent [model] (https://github.com/strands-agents/sdk-python/pull/848)
- models - openai - client context comment [model] (https://github.com/strands-agents/sdk-python/pull/864)
- fix links and imports (https://github.com/strands-agents/sdk-python/pull/837)

## SDK Python v1.8.0 — 2025-09-10
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.8.0 · Package: https://pypi.org/project/strands-agents/1.8.0/

### Features
- improve structured output tool circular reference handling [structured-output] (https://github.com/strands-agents/sdk-python/pull/817)
- add default read timeout to Bedrock config [model] (https://github.com/strands-agents/sdk-python/pull/829)
- add support for Bedrock/Anthropic ToolChoice to structured\_output [model] (https://github.com/strands-agents/sdk-python/pull/720)
- allow callers of swarm and graph to pass kwargs to executors [multiagent] (https://github.com/strands-agents/sdk-python/pull/816)
- add region-aware default model ID for Bedrock [model] (https://github.com/strands-agents/sdk-python/pull/835)

### Fixes
- fix cyclic graph behavior [multiagent] (https://github.com/strands-agents/sdk-python/pull/768)
- filter reasoningContent in Bedrock requests using DeepSeek [model] (https://github.com/strands-agents/sdk-python/pull/652)
- do not block asyncio event loop between retries (https://github.com/strands-agents/sdk-python/pull/805)
- load and register all decorated @tool functions from file path [tool] (https://github.com/strands-agents/sdk-python/pull/742)
- patch litellm bug to honor passing in use\_litellm\_proxy as client\_args [model] (https://github.com/strands-agents/sdk-python/pull/808)

### Other
- Moved tool\_spec retrieval to after the before model invocation callback (https://github.com/strands-agents/sdk-python/pull/786)
- cleanup docs so the yields section renders correctly (https://github.com/strands-agents/sdk-python/pull/820)
- Warn on unknown model configuration properties (https://github.com/strands-agents/sdk-python/pull/819)
- llama.cpp model provider support [model] (https://github.com/strands-agents/sdk-python/pull/585)
- fix(llama.cpp) - add ToolChoice and validation of model config values [model] (https://github.com/strands-agents/sdk-python/pull/838)

## SDK Python v1.7.1 — 2025-09-05
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.7.1 · Package: https://pypi.org/project/strands-agents/1.7.1/

### Features
- Implement async generator tools [tool] (https://github.com/strands-agents/sdk-python/pull/788)

### Fixes
- don't emit ToolStream events for non generator functions (https://github.com/strands-agents/sdk-python/pull/773)
- adjust test\_bedrock\_guardrails to account for async behavior (https://github.com/strands-agents/sdk-python/pull/785)
- replace invalid Hook names in doc comment with BeforeInvocationEvent & AfterInvocationEvent [hooks] (https://github.com/strands-agents/sdk-python/pull/782)
- Remove status field from toolResult for non-claude 3 models in Bedrock model provider [model] (https://github.com/strands-agents/sdk-python/pull/686)
- filter 'SDK\_UNKNOWN\_MEMBER' from response content (https://github.com/strands-agents/sdk-python/pull/798)
- only add signature to reasoning blocks if signature is provided (https://github.com/strands-agents/sdk-python/pull/806)

### Other
- update openai requirement from \<1.100.0 to \<1.102.0 [model] (https://github.com/strands-agents/sdk-python/pull/722)

## SDK Python v1.7.0 — 2025-09-02
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.7.0 · Package: https://pypi.org/project/strands-agents/1.7.0/

### Features
- Implement typed events internally (https://github.com/strands-agents/sdk-python/pull/745)
- Use TypedEvent inheritance for callback behavior (https://github.com/strands-agents/sdk-python/pull/755)
- claude citation support with BedrockModel [model] (https://github.com/strands-agents/sdk-python/pull/631)
- Enable hooks for MultiAgents [hooks] (https://github.com/strands-agents/sdk-python/pull/760)

### Fixes
- fix stop reason for bedrock model when stop\_reason [model] (https://github.com/strands-agents/sdk-python/pull/767)
- Return tool result message as part of event + expand unit test coverage [tool] (https://github.com/strands-agents/sdk-python/pull/771)
- fix loading tools with same tool name [tool] (https://github.com/strands-agents/sdk-python/pull/772)

### Other
- summarization manager - add summary prompt to messages (https://github.com/strands-agents/sdk-python/pull/698)
- Add invocation\_state to ToolContext (https://github.com/strands-agents/sdk-python/pull/761)
- Add VPC endpoint support to BedrockModel class - Add optional endpoin… [model] (https://github.com/strands-agents/sdk-python/pull/502)

## SDK Python v1.6.0 — 2025-08-26
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.6.0 · Package: https://pypi.org/project/strands-agents/1.6.0/

### Features
- support A2A FileParts and DataParts [a2a] (https://github.com/strands-agents/sdk-python/pull/596)
- Add \_\_call\_\_ implementation to MultiAgentBase [multiagent] (https://github.com/strands-agents/sdk-python/pull/645)
- Add support for agent invoke with no input, or Message input [agent] (https://github.com/strands-agents/sdk-python/pull/653)

### Fixes
- fix non-serializable parameter of agent from toolUse block [agent] (https://github.com/strands-agents/sdk-python/pull/568)
- add system\_prompt to structured\_output\_span before adding input\_messages (https://github.com/strands-agents/sdk-python/pull/709)
- prevent path traversal for message\_id in file\_session\_manager (https://github.com/strands-agents/sdk-python/pull/728)
- Add AgentInput TypeAlias (https://github.com/strands-agents/sdk-python/pull/738)
- Move AgentInput to types submodule (https://github.com/strands-agents/sdk-python/pull/746)

### Other
- Add .DS\_Store to .gitignore (https://github.com/strands-agents/sdk-python/pull/681)
- update pre-commit requirement from \<4.2.0,\>=3.2.0 to \>=3.2.0,\<4.4.0 (https://github.com/strands-agents/sdk-python/pull/706)
- update ruff requirement from \<0.5.0,\>=0.4.4 to \>=0.4.4,\<0.13.0 (https://github.com/strands-agents/sdk-python/pull/704)
- update pytest-asyncio requirement from \<0.27.0,\>=0.26.0 to \>=0.26.0,\<1.2.0 (https://github.com/strands-agents/sdk-python/pull/708)
- Update pydantic minimum version (https://github.com/strands-agents/sdk-python/pull/723)
- tool executors [tool] (https://github.com/strands-agents/sdk-python/pull/658)
- bump actions/checkout from 4 to 5 (https://github.com/strands-agents/sdk-python/pull/711)
- bump actions/download-artifact from 4 to 5 (https://github.com/strands-agents/sdk-python/pull/712)
- update pytest-cov requirement from \<5.0.0,\>=4.1.0 to \>=4.1.0,\<7.0.0 (https://github.com/strands-agents/sdk-python/pull/705)
- @dependabot\[bot\] made their first contribution (https://github.com/strands-agents/sdk-python/pull/706)

## SDK Python v1.5.0 — 2025-08-19
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.5.0 · Package: https://pypi.org/project/strands-agents/1.5.0/

### Features
- Add configuration option to MCP Client for server init timeout [mcp] (https://github.com/strands-agents/sdk-python/pull/657)
- add structured\_output\_span (https://github.com/strands-agents/sdk-python/pull/655)
- expose tool\_use and agent through ToolContext to decorated tools [tool] (https://github.com/strands-agents/sdk-python/pull/557)
- add cached token metrics support for Amazon Bedrock [model] (https://github.com/strands-agents/sdk-python/pull/531)

### Fixes
- Properly handle prompt=None & avoid agent hanging [agent] (https://github.com/strands-agents/sdk-python/pull/643)
- only set signature in message if signature was provided by the model (https://github.com/strands-agents/sdk-python/pull/682)
- Add openai dependency to sagemaker dependency group [model] (https://github.com/strands-agents/sdk-python/pull/678)
- append blank text content if assistant content is empty (https://github.com/strands-agents/sdk-python/pull/677)

### Other
- feature(graph): Allow cyclic graphs [multiagent] (https://github.com/strands-agents/sdk-python/pull/497)
- request to include code snippet section (https://github.com/strands-agents/sdk-python/pull/654)
- litellm - set 1.73.1 as minimum version [model] (https://github.com/strands-agents/sdk-python/pull/668)
- session manager - prevent file path injection [sessions] (https://github.com/strands-agents/sdk-python/pull/680)
- Have \[all\] group reference the other optional dependency groups by name (https://github.com/strands-agents/sdk-python/pull/674)

## SDK Python v1.4.0 — 2025-08-08
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.4.0 · Package: https://pypi.org/project/strands-agents/1.4.0/

### Features
- Add additional intructions for contributors to find issues that are ready to be worked on (https://github.com/strands-agents/sdk-python/pull/595)
- configurable request handler [a2a] (https://github.com/strands-agents/sdk-python/pull/601)

### Fixes
- added mcp tracing context propagation [otel] (https://github.com/strands-agents/sdk-python/pull/569)
- ensure tool\_use content blocks are valid after max\_tokens to prevent unrecoverable state (https://github.com/strands-agents/sdk-python/pull/607)
- do not modify conversation\_history when prompt is passed [structured-output] (https://github.com/strands-agents/sdk-python/pull/628)

### Other
- Change max\_tokens type to int to match Anthropic API [model] (https://github.com/strands-agents/sdk-python/pull/588)
- update host per AppSec recommendation [a2a] (https://github.com/strands-agents/sdk-python/pull/619)

## SDK Python v1.3.0 — 2025-08-04
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.3.0 · Package: https://pypi.org/project/strands-agents/1.3.0/

### Fixes
- pin a2a-sdk\>=0.2.16 to resolve #572 [a2a] (https://github.com/strands-agents/sdk-python/pull/581)
- sessions code fence, a2a tests & lint [a2a] (https://github.com/strands-agents/sdk-python/pull/591)
- raise dedicated exception when encountering max toke… (https://github.com/strands-agents/sdk-python/pull/576)

### Other
- pin a2a to a minor version while it is still in beta [a2a] (https://github.com/strands-agents/sdk-python/pull/586)

## SDK Python v1.2.0 — 2025-07-30
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.2.0 · Package: https://pypi.org/project/strands-agents/1.2.0/

### Features
- retain structured content in the AgentTool response [mcp] (https://github.com/strands-agents/sdk-python/pull/528)
- Add list\_prompts, get\_prompt methods [mcp] (https://github.com/strands-agents/sdk-python/pull/160)

### Fixes
- Remove leftover print statement from sagemaker model provider [model] (https://github.com/strands-agents/sdk-python/pull/553)

### Other
- Support for Amazon SageMaker AI endpoints as Model Provider [model] (https://github.com/strands-agents/sdk-python/pull/176)
- \[Feat\] Update structured output error message [structured-output] (https://github.com/strands-agents/sdk-python/pull/563)

## SDK Python v1.1.0 — 2025-07-24
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.1.0 · Package: https://pypi.org/project/strands-agents/1.1.0/

### Features
- support mounts for containerized deployments [a2a] (https://github.com/strands-agents/sdk-python/pull/524)

### Fixes
- include agent trace into tool for agent as tools [tool] (https://github.com/strands-agents/sdk-python/pull/526)

### Other
- Update to use dedicated github logo (https://github.com/strands-agents/sdk-python/pull/505)
- deps(a2a): address interface changes and bump min version [a2a] (https://github.com/strands-agents/sdk-python/pull/515)
- expose STRANDS\_TEST\_API\_KEYS\_SECRET\_NAME to integration tests (https://github.com/strands-agents/sdk-python/pull/513)
- Don't re-run workflows on un/approvals (https://github.com/strands-agents/sdk-python/pull/516)
- Doc fixes: suppressing some typos in various texts (https://github.com/strands-agents/sdk-python/pull/487)
- add hot reloading documentation for load\_tools\_from\_directory (https://github.com/strands-agents/sdk-python/pull/517)
- enable integ tests for anthropic, cohere, mistral, openai, writer [model] (https://github.com/strands-agents/sdk-python/pull/510)
- Automatically flatten nested tool collections [tool] (https://github.com/strands-agents/sdk-python/pull/508)

## SDK Python v1.0.1 — 2025-07-18
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.0.1 · Package: https://pypi.org/project/strands-agents/1.0.1/

### Fixes
- enable parallel execution in graph workflow [multiagent] (https://github.com/strands-agents/sdk-python/pull/485)
- prevent JSON serialization errors with non-serializable direct tool parameters [agent] (https://github.com/strands-agents/sdk-python/pull/498)
- group traces when using agent as tool in an agent [otel] (https://github.com/strands-agents/sdk-python/pull/493)

### Other
- Switch readme to use light logo for better display in github dark mode (https://github.com/strands-agents/sdk-python/pull/475)
- update development status classifier (https://github.com/strands-agents/sdk-python/pull/480)
- Update README.md with Writer (https://github.com/strands-agents/sdk-python/pull/474)

## SDK Python v1.0.0 — 2025-07-15
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.0.0 · Package: https://pypi.org/project/strands-agents/1.0.0/

### Features
- add pagination to mcp\_client list\_tools\_sync (https://github.com/strands-agents/sdk-python/pull/436)
- Graph - support multi-modal inputs [multiagent] (https://github.com/strands-agents/sdk-python/pull/430)
- redact content from a message in a session [sessions] (https://github.com/strands-agents/sdk-python/pull/446)
- added swarm and graph spans [multiagent] (https://github.com/strands-agents/sdk-python/pull/451)
- Store conversation manager in session [sessions] (https://github.com/strands-agents/sdk-python/pull/441)
- introduce Swarm multi-agent orchestrator [multiagent] (https://github.com/strands-agents/sdk-python/pull/416)
- add Swarm tracing [multiagent] (https://github.com/strands-agents/sdk-python/pull/461)
- Expose OpenTelemetry exporter init arguments in API [otel] (https://github.com/strands-agents/sdk-python/pull/365)
- Add kwargs to session interfaces for future extensibility [sessions] (https://github.com/strands-agents/sdk-python/pull/464)

### Fixes
- session manager tracks all agent last message [sessions] (https://github.com/strands-agents/sdk-python/pull/455)
- Fix session manager agent init [sessions] (https://github.com/strands-agents/sdk-python/pull/458)
- Plumb system\_prompt through to structured\_output [structured-output] (https://github.com/strands-agents/sdk-python/pull/466)
- Fix various docstring issues (https://github.com/strands-agents/sdk-python/pull/469)
- raise ValueError for unsupported Graph and Swarm agent features [multiagent] (https://github.com/strands-agents/sdk-python/pull/472)

### Other
- configurable host and port and remove excessive logging [a2a] (https://github.com/strands-agents/sdk-python/pull/423)
- models - bedrock - remove signaling [model] (https://github.com/strands-agents/sdk-python/pull/429)
- deps(a2a): upper bound a2a sdk dep [a2a] (https://github.com/strands-agents/sdk-python/pull/432)
- models - ollama - init async client per request [model] (https://github.com/strands-agents/sdk-python/pull/433)
- models - mistral - init client on every request [model] (https://github.com/strands-agents/sdk-python/pull/434)
- models - ollama - clean up in tests [model] (https://github.com/strands-agents/sdk-python/pull/435)
- Session persistence [sessions] (https://github.com/strands-agents/sdk-python/pull/302)
- update span names [otel] (https://github.com/strands-agents/sdk-python/pull/440)
- models - openai - null usage [model] (https://github.com/strands-agents/sdk-python/pull/442)
- upper bound deps + remove from multiagent submodule [a2a] (https://github.com/strands-agents/sdk-python/pull/447)
- Expand additional $refs for structured\_output [structured-output] (https://github.com/strands-agents/sdk-python/pull/439)
- docstrings - fix formatting (https://github.com/strands-agents/sdk-python/pull/456)
- add kwargs to multiagent interfaces [multiagent] (https://github.com/strands-agents/sdk-python/pull/454)
- multiagent - use invoke\_async instead of stream\_async [multiagent] (https://github.com/strands-agents/sdk-python/pull/463)
- correct naming in registry.py (https://github.com/strands-agents/sdk-python/pull/425)
- Update default model to be Claude 4 Sonnet (https://github.com/strands-agents/sdk-python/pull/467)
- Swarm - Remove unnecessary complete\_swarm\_task tool [multiagent] (https://github.com/strands-agents/sdk-python/pull/473)
- remove preview from README.md (https://github.com/strands-agents/sdk-python/pull/459)

## SDK Python v0.3.0 — 2025-07-11
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v0.3.0 · Package: https://pypi.org/project/strands-agents/0.3.0/

### Features
- Implement the core system of typed hooks & callbacks [hooks] (https://github.com/strands-agents/sdk-python/pull/304)
- Add hooks for before/after tool calls + allow hooks to update values [tool] (https://github.com/strands-agents/sdk-python/pull/352)
- mcp async call tool [async] (https://github.com/strands-agents/sdk-python/pull/406)
- introduce Graph multi-agent orchestrator [multiagent] (https://github.com/strands-agents/sdk-python/pull/336)

### Fixes
- handle multiple tool calls in Mistral streaming responses [model] (https://github.com/strands-agents/sdk-python/pull/384)
- add-threading-instrumentation (https://github.com/strands-agents/sdk-python/pull/394)
- Update mistral tests to avoid shared agents [model] (https://github.com/strands-agents/sdk-python/pull/398)
- Allow tool names that start with numbers [tool] (https://github.com/strands-agents/sdk-python/pull/407)

### Other
- iterative tool handler process [tool] (https://github.com/strands-agents/sdk-python/pull/340)
- remove thread pool wrapper (https://github.com/strands-agents/sdk-python/pull/339)
- updated scope name, enable setting up meter (https://github.com/strands-agents/sdk-python/pull/331)
- async model stream interface [bidirectional-streaming] (https://github.com/strands-agents/sdk-python/pull/306)
- allow custom agent name [agent] (https://github.com/strands-agents/sdk-python/pull/347)
- Extract hook based tests to a separate file [hooks] (https://github.com/strands-agents/sdk-python/pull/349)
- Refactor event loop to use Agent object rather than individual parameters [agent] (https://github.com/strands-agents/sdk-python/pull/359)
- models - openai - async client [model] (https://github.com/strands-agents/sdk-python/pull/353)
- models - openai - do not accept b64 images [model] (https://github.com/strands-agents/sdk-python/pull/368)
- iterative tools [tool] (https://github.com/strands-agents/sdk-python/pull/345)
- a2a streaming [a2a] (https://github.com/strands-agents/sdk-python/pull/366)
- Update A2AServer docstrings [multiagent] (https://github.com/strands-agents/sdk-python/pull/377)
- move a2a test module [a2a] (https://github.com/strands-agents/sdk-python/pull/379)
- models - mistral - async [model] (https://github.com/strands-agents/sdk-python/pull/375)
- models - ollama - async [model] (https://github.com/strands-agents/sdk-python/pull/373)
- models - anthropic - async [model] (https://github.com/strands-agents/sdk-python/pull/371)
- agent tool - remove invoke [tool] (https://github.com/strands-agents/sdk-python/pull/369)
- Add cohere client (https://github.com/strands-agents/sdk-python/pull/236)
- deps(a2a): upgrade a2a with db support [a2a] (https://github.com/strands-agents/sdk-python/pull/395)
- Writer model provider [model] (https://github.com/strands-agents/sdk-python/pull/228)
- Update integ tests to isolate provider-based tests (https://github.com/strands-agents/sdk-python/pull/396)
- Remove agent.tool\_config and update usages to use tool\_specs [agent] (https://github.com/strands-agents/sdk-python/pull/388)
- multi modal input (https://github.com/strands-agents/sdk-python/pull/367)
- async tools support [tool] (https://github.com/strands-agents/sdk-python/pull/391)
- Add basis for conformance-based tests (https://github.com/strands-agents/sdk-python/pull/403)
- Add hooks for when new messages are appended to the agent's messages [hooks] (https://github.com/strands-agents/sdk-python/pull/385)
- Add Model Invocation Hooks [hooks] (https://github.com/strands-agents/sdk-python/pull/387)
- structured output - multi-modal input [structured-output] (https://github.com/strands-agents/sdk-python/pull/405)
- \[REFACTOR\] Unify Model Interface Around Single Entry Point (model.stream) [bidirectional-streaming] (https://github.com/strands-agents/sdk-python/pull/400)
- Rename StartRequestEvent & EndRequestEvent events (https://github.com/strands-agents/sdk-python/pull/408)
- models - bedrock - threading [model] (https://github.com/strands-agents/sdk-python/pull/411)
- Mark hooks as non-experimental [hooks] (https://github.com/strands-agents/sdk-python/pull/410)
- models - litellm - async [model] (https://github.com/strands-agents/sdk-python/pull/414)
- models - move abstract class (https://github.com/strands-agents/sdk-python/pull/409)
- Remove event\_loop\_cycle from top level import (https://github.com/strands-agents/sdk-python/pull/415)
- Remove message processor (https://github.com/strands-agents/sdk-python/pull/417)
- Update interfaces to include kwargs to enable backwards compatibility (https://github.com/strands-agents/sdk-python/pull/413)
- Remove \_remove\_dangling\_messages from SlidingWindowConversationManager (https://github.com/strands-agents/sdk-python/pull/418)
- set Agent property load\_tools\_from\_directory to default to False [agent] (https://github.com/strands-agents/sdk-python/pull/419)

## SDK Python v0.2.1 — 2025-07-04
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v0.2.1 · Package: https://pypi.org/project/strands-agents/0.2.1/

### Other
- tools - parallel execution - sleep [tool] (https://github.com/strands-agents/sdk-python/pull/355)

## SDK Python v0.2.0 — 2025-07-02
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v0.2.0 · Package: https://pypi.org/project/strands-agents/0.2.0/

### Features
- Add reasoning content for openai model provider [model] (https://github.com/strands-agents/sdk-python/pull/187)
- tools as skills [a2a] (https://github.com/strands-agents/sdk-python/pull/287)
- Add Mistral model support to strands [model] (https://github.com/strands-agents/sdk-python/pull/284)
- add debug logging for model converse requests (https://github.com/strands-agents/sdk-python/pull/297)
- Add reproduction test for #320 (https://github.com/strands-agents/sdk-python/pull/322)
- Agent State [agent] (https://github.com/strands-agents/sdk-python/pull/292)

### Fixes
- correcting incorrect docstring in tracer.py - non-existing argument documented (https://github.com/strands-agents/sdk-python/pull/293)
- Fix docs warnings (https://github.com/strands-agents/sdk-python/pull/303)
- Migrate Mistral structured\_output to an iterator [model] (https://github.com/strands-agents/sdk-python/pull/305)

### Other
- iterative event loop (https://github.com/strands-agents/sdk-python/pull/268)
- Add additional exception information for common bedrock errors [model] (https://github.com/strands-agents/sdk-python/pull/290)
- iterative structured output [structured-output] (https://github.com/strands-agents/sdk-python/pull/291)
- tools - do not remove $defs [tool] (https://github.com/strands-agents/sdk-python/pull/294)
- refactor tracer (https://github.com/strands-agents/sdk-python/pull/286)
- iterative agent [agent] (https://github.com/strands-agents/sdk-python/pull/295)
- Use region from boto3 session when possible [sessions] (https://github.com/strands-agents/sdk-python/pull/299)
- update spanKind and attributes for tokens (https://github.com/strands-agents/sdk-python/pull/296)
- remove kwargs spread after agent call [agent] (https://github.com/strands-agents/sdk-python/pull/289)
- allow custom tracer\_provider and chain setup (https://github.com/strands-agents/sdk-python/pull/316)
- stop passing around callback handler (https://github.com/strands-agents/sdk-python/pull/323)
- Remove unused code (https://github.com/strands-agents/sdk-python/pull/326)
- updated semantic conventions on Generative AI spans (https://github.com/strands-agents/sdk-python/pull/319)
- Consolidate agent state unit tests [agent] (https://github.com/strands-agents/sdk-python/pull/334)
- Remove FunctionTool as a breaking change (https://github.com/strands-agents/sdk-python/pull/325)
- executor - run tools - yield [tool] (https://github.com/strands-agents/sdk-python/pull/328)

## SDK Python v0.1.9 — 2025-06-24
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v0.1.9 · Package: https://pypi.org/project/strands-agents/0.1.9/

### Features
- add meter (https://github.com/strands-agents/sdk-python/pull/219)
- add structured output support using Pydantic models [structured-output] (https://github.com/strands-agents/sdk-python/pull/60)

### Fixes
- Emit warning that default region behavior will be changing (https://github.com/strands-agents/sdk-python/pull/254)

### Other
- models - openai - images - b64 validate [model] (https://github.com/strands-agents/sdk-python/pull/251)
- Inline event loop helper functions (https://github.com/strands-agents/sdk-python/pull/222)
- models - openai - b64encode method [model] (https://github.com/strands-agents/sdk-python/pull/260)
- chore/update metrics [otel] (https://github.com/strands-agents/sdk-python/pull/248)
- iterative streaming [bidirectional-streaming] (https://github.com/strands-agents/sdk-python/pull/241)
- Initial A2A server Integration [a2a] (https://github.com/strands-agents/sdk-python/pull/218)
- litellm - bug in v1.73.0 [model] (https://github.com/strands-agents/sdk-python/pull/270)
- Update @tool to return an AgentTool that also acts as a function [tool] (https://github.com/strands-agents/sdk-python/pull/258)

## SDK Python v0.1.8 — 2025-06-18
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v0.1.8 · Package: https://pypi.org/project/strands-agents/0.1.8/

### Features
- implement summarizing conversation manager (https://github.com/strands-agents/sdk-python/pull/112)
- Simplify contribution template + pr scripts to run (https://github.com/strands-agents/sdk-python/pull/221)

### Fixes
- Enable underscores in direct method invocations to match hyphens (https://github.com/strands-agents/sdk-python/pull/178)
- add inference profile to litellm test and remove ownership check… [model] (https://github.com/strands-agents/sdk-python/pull/209)
- Update PR Integration Test Workflow (https://github.com/strands-agents/sdk-python/pull/237)
- remove unused dependency swagger-parser (https://github.com/strands-agents/sdk-python/pull/220)
- Update throttling logic to use exponential back-off (https://github.com/strands-agents/sdk-python/pull/223)

### Other
- moved truncation logic to conversation manager and added should\_truncate\_results (https://github.com/strands-agents/sdk-python/pull/192)
- Disallow similar tool names in the tool registry [tool] (https://github.com/strands-agents/sdk-python/pull/193)
- add integration test workflow (https://github.com/strands-agents/sdk-python/pull/201)
- allow custom tracer provider to Agent [agent] (https://github.com/strands-agents/sdk-python/pull/207)
- add a2a deps and mitigate otel conflict [a2a] (https://github.com/strands-agents/sdk-python/pull/232)
- raise exception if exporter unavailable [otel] (https://github.com/strands-agents/sdk-python/pull/234)
- docstring parser (https://github.com/strands-agents/sdk-python/pull/239)

## SDK Python v0.1.7 — 2025-06-09
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v0.1.7 · Package: https://pypi.org/project/strands-agents/0.1.7/

### Features
- Add CachePoint type definition to ContentBlock (https://github.com/strands-agents/sdk-python/pull/142)

### Fixes
- Preserve deeply nested schemas (https://github.com/strands-agents/sdk-python/pull/133)
- ignore mypy error from latest OpenTelemetrySDK update (https://github.com/strands-agents/sdk-python/pull/180)
- Handle empty choices in OpenAI model provider [model] (https://github.com/strands-agents/sdk-python/pull/185)

### Other
- models - unsupported content types (https://github.com/strands-agents/sdk-python/pull/144)
- \[Docs\] add meta copyright header (https://github.com/strands-agents/sdk-python/pull/153)
- Update conversation manager interface (https://github.com/strands-agents/sdk-python/pull/161)
- models - correct tool result content [tool] (https://github.com/strands-agents/sdk-python/pull/154)
- set OTEL\_ env vars correctly for tests (https://github.com/strands-agents/sdk-python/pull/169)
- Fix agent default callback handler [agent] (https://github.com/strands-agents/sdk-python/pull/170)
- Add permissions to workflows (https://github.com/strands-agents/sdk-python/pull/166)
- Remove redundant permissions block (https://github.com/strands-agents/sdk-python/pull/172)
- Add permission block to call-tst-lint job (https://github.com/strands-agents/sdk-python/pull/186)
- Remove codeowners (https://github.com/strands-agents/sdk-python/pull/181)
- enhance error messaging when MCP tools are used without sessio… [mcp] (https://github.com/strands-agents/sdk-python/pull/175)

## SDK Python v0.1.6 — 2025-05-30
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v0.1.6 · Package: https://pypi.org/project/strands-agents/0.1.6/

### Features
- Add non-streaming support to BedrockModel [bidirectional-streaming] (https://github.com/strands-agents/sdk-python/pull/75)

### Fixes
- Added hyphen to allowed characters in tool name validation [tool] (https://github.com/strands-agents/sdk-python/pull/55)
- correct environment variable precedence for OTEL config [otel] (https://github.com/strands-agents/sdk-python/pull/86)

### Other
- fix docstring for PrintingCallbackHandler.\_\_call\_\_ (https://github.com/strands-agents/sdk-python/pull/126)
- Add unit tests for user agent changes [agent] (https://github.com/strands-agents/sdk-python/pull/125)
- Increasing Coverage Message Processor : From 79% to 94% (https://github.com/strands-agents/sdk-python/pull/115)
- models - content - documents (https://github.com/strands-agents/sdk-python/pull/138)
- models - anthropic - document - plain text [model] (https://github.com/strands-agents/sdk-python/pull/141)
- Automate deployment to PYPI (https://github.com/strands-agents/sdk-python/pull/145)

## SDK Python v0.1.5 — 2025-05-26
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v0.1.5 · Package: https://pypi.org/project/strands-agents/0.1.5/

### Features
- add reasoning text to callback handler and related tests (https://github.com/strands-agents/sdk-python/pull/109)
- Add dynamic system prompt override functionality (https://github.com/strands-agents/sdk-python/pull/108)
- Update SlidingWindowConversationManager (https://github.com/strands-agents/sdk-python/pull/120)

### Fixes
- use logo that changes color automatically depending on user's color preference scheme (https://github.com/strands-agents/sdk-python/pull/105)
- fix agent span start and end when using Agent.stream\_async() [otel] (https://github.com/strands-agents/sdk-python/pull/119)

### Other
- models - openai - argument none [model] (https://github.com/strands-agents/sdk-python/pull/97)
- add open PRs badge + link to samples repo + change 'Docs' to 'Documentation' (https://github.com/strands-agents/sdk-python/pull/100)
- add logo (https://github.com/strands-agents/sdk-python/pull/101)
- add logo, title, badges, links to other repos, standardize headings (https://github.com/strands-agents/sdk-python/pull/102)
- use dark logo for clearer visibility when system is using light color scheme (https://github.com/strands-agents/sdk-python/pull/104)
- 🔥🕊️ Rise of the Phoenix: Event Loop Refactor (https://github.com/strands-agents/sdk-python/pull/106)
- v0.1.5 (https://github.com/strands-agents/sdk-python/pull/121)

## SDK Python v0.1.4 — 2025-05-23
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v0.1.4 · Package: https://pypi.org/project/strands-agents/0.1.4/

### Fixes
- Updated GitHub Action to use GitHub native approvals (https://github.com/strands-agents/sdk-python/pull/67)
- add missing quotation marks in pip install commands (https://github.com/strands-agents/sdk-python/pull/80)
- Merge strands-agents user agent into existing botocore config [agent] (https://github.com/strands-agents/sdk-python/pull/76)

### Other
- models - litellm - capture usage [model] (https://github.com/strands-agents/sdk-python/pull/73)
- fixing various typos in markdowns and scripts (https://github.com/strands-agents/sdk-python/pull/74)
- feature: models - openai [model] (https://github.com/strands-agents/sdk-python/pull/65)
- fixing typos in .py and .md (https://github.com/strands-agents/sdk-python/pull/78)
- update contributing guide to manage python env with hatch shell (https://github.com/strands-agents/sdk-python/pull/46)
- Add ensure\_ascii=False to json.dumps() calls in telemetry tracer [otel] (https://github.com/strands-agents/sdk-python/pull/37)
- lint - openai client protocol [model] (https://github.com/strands-agents/sdk-python/pull/87)
- Lower OpenTelemetry minimum version (https://github.com/strands-agents/sdk-python/pull/89)

## SDK Python v0.1.3 — 2025-05-21
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v0.1.3 · Package: https://pypi.org/project/strands-agents/0.1.3/

### Fixes
- update direct tool call references [tool] (https://github.com/strands-agents/sdk-python/pull/56)

### Other
- Update README.md - corrected spelling of "model" (https://github.com/strands-agents/sdk-python/pull/59)
- style guide (https://github.com/strands-agents/sdk-python/pull/49)
- Update version to 0.1.3 (https://github.com/strands-agents/sdk-python/pull/63)

## SDK Python v0.1.2 — 2025-05-18
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v0.1.2 · Package: https://pypi.org/project/strands-agents/0.1.2/

### Fixes
- tracing of non-serializable values, e.g. bytes [otel] (https://github.com/strands-agents/sdk-python/pull/34)
- use the AWS\_REGION environment variable for the Bedrock model provider region if set and boto\_session is not passed [model] (https://github.com/strands-agents/sdk-python/pull/39)

### Other
- Update README.md mention of tools repo [tool] (https://github.com/strands-agents/sdk-python/pull/29)
- Update README to mention Meta Llama API as a supported model provider [model] (https://github.com/strands-agents/sdk-python/pull/21)
- v0.1.2 (https://github.com/strands-agents/sdk-python/pull/41)

## SDK Python v0.1.1 — 2025-05-17
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v0.1.1 · Package: https://pypi.org/project/strands-agents/0.1.1/

### Fixes
- set user-agent for Bedrock API calls [model] (https://github.com/strands-agents/sdk-python/pull/23)

### Other
- Update the PyPI package description (https://github.com/strands-agents/sdk-python/pull/15)
- update README with LlamaAPI (https://github.com/strands-agents/sdk-python/pull/18)
- Update readme to include badges (https://github.com/strands-agents/sdk-python/pull/17)
- actions: fix docs dispatch (https://github.com/strands-agents/sdk-python/pull/19)
- actions: remove dispatch docs (https://github.com/strands-agents/sdk-python/pull/22)
- v0.1.1 release (https://github.com/strands-agents/sdk-python/pull/26)

## SDK Python v0.1.0 — 2025-05-16
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v0.1.0 · Package: https://pypi.org/project/strands-agents/0.1.0/
