---
sdk: sdk
language: python
version: "1.35.0"
tag: python/v1.35.0
date: 2026-04-08
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.35.0
packageUrl: https://pypi.org/project/strands-agents/1.35.0/
entries:
  - { type: feat, breaking: false, scope: null, areas: [], title: "add service_tier support to BedrockModel", pr: 1799, prUrl: "https://github.com/strands-agents/sdk-python/pull/1799", commit: "94fc8dd", commitUrl: "https://github.com/strands-agents/sdk-python/commit/94fc8dd", author: BV-Venky }
  - { type: fix, breaking: false, scope: null, areas: [], title: "forward _meta to MCP tool calls and fix model_dump alias seriali…", pr: 1918, prUrl: "https://github.com/strands-agents/sdk-python/pull/1918", commit: "1682a0c", commitUrl: "https://github.com/strands-agents/sdk-python/commit/1682a0c", author: mananpatel320 }
  - { type: fix, breaking: false, scope: anthropic, areas: [], title: "avoid Pydantic warnings for message_stop events", pr: 2044, prUrl: "https://github.com/strands-agents/sdk-python/pull/2044", commit: "a19e73d", commitUrl: "https://github.com/strands-agents/sdk-python/commit/a19e73d", author: opieter-aws }
  - { type: fix, breaking: false, scope: null, areas: [], title: "propagate tool exceptions to spans so StatusCode.ERROR is set correctly", pr: 2046, prUrl: "https://github.com/strands-agents/sdk-python/pull/2046", commit: "287c5b6", commitUrl: "https://github.com/strands-agents/sdk-python/commit/287c5b6", author: mattdai01 }
  - { type: fix, breaking: false, scope: null, areas: [], title: "enforce that the first message is a user message in the sliding window conversation manager", pr: 2087, prUrl: "https://github.com/strands-agents/sdk-python/pull/2087", commit: "65b06d9", commitUrl: "https://github.com/strands-agents/sdk-python/commit/65b06d9", author: JackYPCOnline }
  - { type: fix, breaking: false, scope: null, areas: [], title: "forward meta to MCP task-augmented tool calls", pr: 2081, prUrl: "https://github.com/strands-agents/sdk-python/pull/2081", commit: "46937d2", commitUrl: "https://github.com/strands-agents/sdk-python/commit/46937d2", author: agent-of-mkmeral }
  - { type: fix, breaking: false, scope: null, areas: [], title: "handle premature stream termination for Anthropic (#1868)", pr: 2047, prUrl: "https://github.com/strands-agents/sdk-python/pull/2047", commit: "2f9ffb1", commitUrl: "https://github.com/strands-agents/sdk-python/commit/2f9ffb1", author: gautamsirdeshmukh }
  - { type: other, breaking: false, scope: null, areas: [], title: "add weekly markdown link check workflow", pr: 2088, prUrl: "https://github.com/strands-agents/sdk-python/pull/2088", commit: "f58117c", commitUrl: "https://github.com/strands-agents/sdk-python/commit/f58117c", author: mkmeral }
  - { type: fix, breaking: false, scope: test, areas: [], title: "update session integ test for sliding window conversation manager", pr: 2092, prUrl: "https://github.com/strands-agents/sdk-python/pull/2092", commit: "289e22a", commitUrl: "https://github.com/strands-agents/sdk-python/commit/289e22a", author: mkmeral }
  - { type: fix, breaking: false, scope: test, areas: [], title: "fix anthropic stream test mock missing get_final_message", pr: 2094, prUrl: "https://github.com/strands-agents/sdk-python/pull/2094", commit: "cd5da4f", commitUrl: "https://github.com/strands-agents/sdk-python/commit/cd5da4f", author: agent-of-mkmeral }
newContributors:
  - { login: mananpatel320, pr: 1918 }
  - { login: mattdai01, pr: 2046 }
  - { login: KKamJi98, pr: 1906 }
  - { login: gautamsirdeshmukh, pr: 2047 }
---

### Features

#### Bedrock Service Tier Support — [PR#1799](https://github.com/strands-agents/sdk-python/pull/1799)

Amazon Bedrock now offers service tiers (Priority, Standard, Flex) that let you control the trade-off between latency and cost on a per-request basis. `BedrockModel` accepts a new `service_tier` configuration field, consistent with how other Bedrock-specific features like guardrails are exposed. When not set, the field is omitted and Bedrock uses its default behavior.

```python
from strands import Agent
from strands.models.bedrock import BedrockModel

# Use "flex" tier for cost-optimized batch processing
model = BedrockModel(
    model_id="us.anthropic.claude-sonnet-4-20250514-v1:0",
    service_tier="flex",
)
agent = Agent(model=model)

# Use "priority" for latency-sensitive applications
realtime_model = BedrockModel(
    model_id="us.anthropic.claude-sonnet-4-20250514-v1:0",
    service_tier="priority",
)
```

Valid values are `"default"`, `"priority"`, and `"flex"`. If a model or region does not support the specified tier, Bedrock returns a `ValidationException`.

### Bug Fixes

- **Sliding window conversation manager user-first enforcement** — [PR#2087](https://github.com/strands-agents/sdk-python/pull/2087): The sliding window could produce a trimmed conversation starting with an assistant message, causing `ValidationException` on providers that require user-first ordering (including Bedrock Nova). The trim-point validation now ensures the first remaining message always has `role == "user"`. Also fixed a short-circuit logic bug in the `toolUse` guard that let orphaned tool-use blocks slip through at window boundaries.

- **MCP `_meta` forwarding** — [PR#1918](https://github.com/strands-agents/sdk-python/pull/1918), [PR#2081](https://github.com/strands-agents/sdk-python/pull/2081): Custom metadata per the MCP spec was silently dropped because `MCPClient` never forwarded the `_meta` field to `ClientSession.call_tool()`. Additionally, the OTEL instrumentation used `model_dump()` instead of `model_dump(by_alias=True)`, serializing the field as `"meta"` instead of `"_meta"` and corrupting the payload. Both the direct `call_tool` and task-augmented execution paths now correctly forward `meta`.

- **Tool exception propagation to OpenTelemetry spans** — [PR#2046](https://github.com/strands-agents/sdk-python/pull/2046): When a tool raised an exception, the original exception was dropped before reaching `end_tool_call_span`, causing all tool spans to get `StatusCode.OK` even on errors. Tool errors now correctly propagate with `StatusCode.ERROR`, preserving the original exception type and traceback for observability backends like Langfuse.

- **Anthropic premature stream termination** — [PR#2047](https://github.com/strands-agents/sdk-python/pull/2047): The Anthropic provider crashed with `AttributeError` when the stream terminated before the final `message_stop` event, because it accessed `event.message.usage` on event types that lack a `.message` attribute. Now uses the Anthropic SDK's `stream.get_final_message()` to read accumulated usage from all received events, gracefully handling premature termination and empty streams.

- **Anthropic Pydantic deprecation warnings** — [PR#2044](https://github.com/strands-agents/sdk-python/pull/2044): Fixed `message_stop` event handling to avoid Pydantic deprecation warnings.
