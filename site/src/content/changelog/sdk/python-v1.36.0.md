---
sdk: sdk
language: python
version: "1.36.0"
tag: python/v1.36.0
date: 2026-04-17
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.36.0
packageUrl: https://pypi.org/project/strands-agents/1.36.0/
entries:
  - { type: feat, breaking: false, scope: hooks, areas: [hooks], title: "accept callable hook callbacks in Agent constructor", pr: 1992, prUrl: "https://github.com/strands-agents/sdk-python/pull/1992", commit: "70b0989", commitUrl: "https://github.com/strands-agents/sdk-python/commit/70b0989", author: agent-of-mkmeral }
  - { type: fix, breaking: false, scope: null, areas: [bidirectional-streaming], title: "handle missing optional fields in non-streaming citation conversion", pr: 2098, prUrl: "https://github.com/strands-agents/sdk-python/pull/2098", commit: "762fba2", commitUrl: "https://github.com/strands-agents/sdk-python/commit/762fba2", author: agent-of-mkmeral }
  - { type: fix, breaking: false, scope: telemetry, areas: [otel], title: "add common gen_ai attributes to event loop cycle spans", pr: 1973, prUrl: "https://github.com/strands-agents/sdk-python/pull/1973", commit: "ca6f599", commitUrl: "https://github.com/strands-agents/sdk-python/commit/ca6f599", author: giulio-leone }
  - { type: fix, breaking: false, scope: telemetry, areas: [otel], title: "use per-invocation usage in agent span attributes", pr: 2017, prUrl: "https://github.com/strands-agents/sdk-python/pull/2017", commit: "d27b8ff", commitUrl: "https://github.com/strands-agents/sdk-python/commit/d27b8ff", author: en-yao }
  - { type: feat, breaking: false, scope: a2a, areas: [a2a], title: "add client_config param and deprecate a2a_client_factory", pr: 2103, prUrl: "https://github.com/strands-agents/sdk-python/pull/2103", commit: "50b2c79", commitUrl: "https://github.com/strands-agents/sdk-python/commit/50b2c79", author: agent-of-mkmeral }
  - { type: fix, breaking: false, scope: null, areas: [mcp], title: "clear leaked running loop in MCP client background thread", pr: 2111, prUrl: "https://github.com/strands-agents/sdk-python/pull/2111", commit: "bb7f188", commitUrl: "https://github.com/strands-agents/sdk-python/commit/bb7f188", author: mkmeral }
  - { type: feat, breaking: false, scope: openai, areas: [model], title: "plumb through cache tokens in metadata events", pr: 2116, prUrl: "https://github.com/strands-agents/sdk-python/pull/2116", commit: "0930ca6", commitUrl: "https://github.com/strands-agents/sdk-python/commit/0930ca6", author: Unshure }
  - { type: feat, breaking: false, scope: agent, areas: [agent], title: "add take_snapshot() and load_snapshot() methods", pr: 1948, prUrl: "https://github.com/strands-agents/sdk-python/pull/1948", commit: "2b81401", commitUrl: "https://github.com/strands-agents/sdk-python/commit/2b81401", author: zastrowm }
  - { type: feat, breaking: false, scope: skills, areas: [], title: "support loading skills from URLs", pr: 2091, prUrl: "https://github.com/strands-agents/sdk-python/pull/2091", commit: "09902bd", commitUrl: "https://github.com/strands-agents/sdk-python/commit/09902bd", author: dgallitelli }
  - { type: feat, breaking: false, scope: null, areas: [context], title: "add metadata field to messages for stateful context tracking", pr: 2125, prUrl: "https://github.com/strands-agents/sdk-python/pull/2125", commit: "dd7a7d9", commitUrl: "https://github.com/strands-agents/sdk-python/commit/dd7a7d9", author: lizradway }
  - { type: feat, breaking: false, scope: bidi, areas: [bidirectional-streaming], title: "support request_state stop_event_loop flag", pr: 1954, prUrl: "https://github.com/strands-agents/sdk-python/pull/1954", commit: "117da67", commitUrl: "https://github.com/strands-agents/sdk-python/commit/117da67", author: agent-of-mkmeral }
  - { type: fix, breaking: false, scope: null, areas: [model], title: "preserve Gemini thought_signature in LiteLLM multi-turn tool calls", pr: 2129, prUrl: "https://github.com/strands-agents/sdk-python/pull/2129", commit: "6697d12", commitUrl: "https://github.com/strands-agents/sdk-python/commit/6697d12", author: opieter-aws }
  - { type: fix, breaking: false, scope: bedrock, areas: [model], title: "normalize empty toolResult content arrays in _format_bedrock_messages", pr: 2123, prUrl: "https://github.com/strands-agents/sdk-python/pull/2123", commit: "8e96ea8", commitUrl: "https://github.com/strands-agents/sdk-python/commit/8e96ea8", author: ghhamel }
  - { type: fix, breaking: false, scope: telemetry, areas: [otel], title: "remove force_flush in tracer", pr: 2142, prUrl: "https://github.com/strands-agents/sdk-python/pull/2142", commit: "4e3ad44", commitUrl: "https://github.com/strands-agents/sdk-python/commit/4e3ad44", author: poshinchen }
newContributors:
  - { login: en-yao, pr: 2017 }
  - { login: ghhamel, pr: 2123 }
---
