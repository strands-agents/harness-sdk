---
sdk: sdk
language: python
version: "1.11.0"
tag: python/v1.11.0
date: 2025-10-08
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.11.0
packageUrl: https://pypi.org/project/strands-agents/1.11.0/
entries:
  - { type: fix, breaking: false, scope: null, areas: [], title: "GeminiModel argument in README", pr: 955, prUrl: "https://github.com/strands-agents/sdk-python/pull/955", commit: "921ca89", commitUrl: "https://github.com/strands-agents/sdk-python/commit/921ca89", author: tosi29 }
  - { type: other, breaking: false, scope: null, areas: [tool], title: "tool - executors - concurrent - remove no-op gather", pr: 954, prUrl: "https://github.com/strands-agents/sdk-python/pull/954", commit: "81c00e4", commitUrl: "https://github.com/strands-agents/sdk-python/commit/81c00e4", author: pgrayy }
  - { type: feat, breaking: false, scope: telemetry, areas: [otel], title: "updated traces to match OTEL v1.37 semantic conventions", pr: 952, prUrl: "https://github.com/strands-agents/sdk-python/pull/952", commit: "2493545", commitUrl: "https://github.com/strands-agents/sdk-python/commit/2493545", author: poshinchen }
  - { type: other, breaking: false, scope: null, areas: [], title: "event loop - handle model execution", pr: 958, prUrl: "https://github.com/strands-agents/sdk-python/pull/958", commit: "428750b", commitUrl: "https://github.com/strands-agents/sdk-python/commit/428750b", author: pgrayy }
  - { type: feat, breaking: false, scope: null, areas: [sessions], title: "implement concurrent message reading for session managers", pr: 897, prUrl: "https://github.com/strands-agents/sdk-python/pull/897", commit: "08dc4ae", commitUrl: "https://github.com/strands-agents/sdk-python/commit/08dc4ae", author: vamgan }
  - { type: other, breaking: false, scope: null, areas: [tool], title: "hooks - before tool call event - cancel tool", pr: 964, prUrl: "https://github.com/strands-agents/sdk-python/pull/964", commit: "bab1270", commitUrl: "https://github.com/strands-agents/sdk-python/commit/bab1270", author: pgrayy }
  - { type: fix, breaking: false, scope: telemetry, areas: [otel], title: "removed double serialization for events", pr: 977, prUrl: "https://github.com/strands-agents/sdk-python/pull/977", commit: "776fd93", commitUrl: "https://github.com/strands-agents/sdk-python/commit/776fd93", author: poshinchen }
  - { type: fix, breaking: false, scope: litellm, areas: [model], title: "map LiteLLM context window errors to ContextWindowOverflowException", pr: 994, prUrl: "https://github.com/strands-agents/sdk-python/pull/994", commit: "2a26ffa", commitUrl: "https://github.com/strands-agents/sdk-python/commit/2a26ffa", author: Ratish1 }
newContributors:
  - { login: tosi29, pr: 955 }
---
