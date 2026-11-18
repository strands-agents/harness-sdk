# SDK TypeScript v1.25.0

Released 2026-11-13
Release: https://github.com/strands-agents/harness-sdk/releases/tag/typescript/v1.25.0 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/1.25.0

## Features
- write injected text into history as an InjectedBlock (typescript) [context, model] (https://github.com/strands-agents/harness-sdk/pull/5569)
- offload conditions decide granularity (typescript) [context] (https://github.com/strands-agents/harness-sdk/pull/5325)
- organize sample guides by user goal (https://github.com/strands-agents/harness-sdk/pull/5761)
- support @anthropic-ai/sdk 0.110 through 1.x in the TypeScript SDK [model] (https://github.com/strands-agents/harness-sdk/pull/5798)
- server-side summary capability with Anthropic on-demand compaction [context, model] (https://github.com/strands-agents/harness-sdk/pull/5840)
- accept pre-built vendor clients in the Anthropic and OpenAI providers (Python + TypeScript) and document Bedrock InvokeModel / Mantle through them [model] (https://github.com/strands-agents/harness-sdk/pull/5914)
- port server-side summary with Anthropic on-demand compaction to TypeScript [context, model] (https://github.com/strands-agents/harness-sdk/pull/5924)
- make the shell tool's default timeout configurable [devx, tool] (https://github.com/strands-agents/harness-sdk/pull/5796)
- give Model.summarize() a client-side base implementation (TS port of #5962) [context, model] (https://github.com/strands-agents/harness-sdk/pull/6022)
- add SageMakerDecisionModel for System One models on SageMaker AI endpoints (TypeScript) [model, decisions] (https://github.com/strands-agents/harness-sdk/pull/5890)
- add "auto" mode to HumanInTheLoop [hil, decisions] (https://github.com/strands-agents/harness-sdk/pull/5975)
- handle Bedrock InvokeModel in AnthropicModel (mid-stream errors, API version); add defaultEffort to the shared model info (py + ts) [model] (https://github.com/strands-agents/harness-sdk/pull/6064)

## Fixes
- snapshot upstream content at deploy (https://github.com/strands-agents/harness-sdk/pull/5838)
- map HTTP 503 from System One providers to ModelThrottledError (TypeScript) [model, decisions] (https://github.com/strands-agents/harness-sdk/pull/5784)
- add GPT-6 Cyber context window (py + ts + cli) [model] (https://github.com/strands-agents/harness-sdk/pull/5899)
- report directories and missing paths distinctly in PosixShellSandbox read\_file (Python + TypeScript) [server] (https://github.com/strands-agents/harness-sdk/pull/5818)
- reroute the Bedrock Mantle client when updateConfig crosses a base path [devx, model] (https://github.com/strands-agents/harness-sdk/pull/3988)
- enable strict tool use on LLMDecisionModel's default BedrockModel [model, decisions] (https://github.com/strands-agents/harness-sdk/pull/5946)
- enforce toolFilters on call\_tool (typescript) (https://github.com/strands-agents/harness-sdk/pull/5972)
- include shell releases in the changelog (https://github.com/strands-agents/harness-sdk/pull/5918)
- keep unknown content blocks when restoring saved data (typescript) [persistence, sessions] (https://github.com/strands-agents/harness-sdk/pull/5564)
- add Claude Fable 5.2 and Mythos 5.2 model info (py + ts + cli) [model] (https://github.com/strands-agents/harness-sdk/pull/5994)
- used strands' tracer and use span\_attributes [otel, decisions] (https://github.com/strands-agents/harness-sdk/pull/6059)
- retry with drop\_block when no thinking config is set [model] (https://github.com/strands-agents/harness-sdk/pull/6061)
- keep other sources' tools when an MCP server refreshes its list [mcp, tool] (https://github.com/strands-agents/harness-sdk/pull/6055)
- send Claude Haiku 5.5 structured output to native output [model, structured-output] (https://github.com/strands-agents/harness-sdk/pull/6073)
- mirror anthropic 1.7.0 enum/const schema handling (typescript) [model, structured-output] (https://github.com/strands-agents/harness-sdk/pull/6016)
- suppress OpenSSH 10.1+ post-quantum warning on stderr (https://github.com/strands-agents/harness-sdk/pull/6069)

## Other
- add glama.json to claim the MCP server on Glama [mcp] (https://github.com/strands-agents/harness-sdk/pull/5832)
- clarify that inputTokens may include cached tokens depending on provider [model] (https://github.com/strands-agents/harness-sdk/pull/5819)
- remove duplicated media-block describe blocks (TS) (https://github.com/strands-agents/harness-sdk/pull/5966)
- bump actions/setup-python from 7.0.0 to 7.1.0 (https://github.com/strands-agents/harness-sdk/pull/6047)
