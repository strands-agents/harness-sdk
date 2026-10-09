---
sdk: sdk
language: python
version: "1.4.0"
tag: python/v1.4.0
date: 2025-08-08
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.4.0
packageUrl: https://pypi.org/project/strands-agents/1.4.0/
entries:
  - { type: fix, breaking: false, scope: telemetry, areas: [otel], title: "added mcp tracing context propagation", pr: 569, prUrl: "https://github.com/strands-agents/sdk-python/pull/569", commit: "34d499a", commitUrl: "https://github.com/strands-agents/sdk-python/commit/34d499a", author: poshinchen }
  - { type: other, breaking: false, scope: null, areas: [model], title: "Change max_tokens type to int to match Anthropic API", pr: 588, prUrl: "https://github.com/strands-agents/sdk-python/pull/588", commit: "09ca806", commitUrl: "https://github.com/strands-agents/sdk-python/commit/09ca806", author: vinc3m1 }
  - { type: feat, breaking: false, scope: null, areas: [], title: "Add additional intructions for contributors to find issues that are ready to be worked on", pr: 595, prUrl: "https://github.com/strands-agents/sdk-python/pull/595", commit: "bf24ebf", commitUrl: "https://github.com/strands-agents/sdk-python/commit/bf24ebf", author: mehtarac }
  - { type: feat, breaking: false, scope: a2a, areas: [a2a], title: "configurable request handler", pr: 601, prUrl: "https://github.com/strands-agents/sdk-python/pull/601", commit: "297ec5c", commitUrl: "https://github.com/strands-agents/sdk-python/commit/297ec5c", author: jer96 }
  - { type: chore, breaking: false, scope: a2a, areas: [a2a], title: "update host per AppSec recommendation", pr: 619, prUrl: "https://github.com/strands-agents/sdk-python/pull/619", commit: "ec5304c", commitUrl: "https://github.com/strands-agents/sdk-python/commit/ec5304c", author: jer96 }
  - { type: fix, breaking: false, scope: event_loop, areas: [], title: "ensure tool_use content blocks are valid after max_tokens to prevent unrecoverable state", pr: 607, prUrl: "https://github.com/strands-agents/sdk-python/pull/607", commit: "29b2127", commitUrl: "https://github.com/strands-agents/sdk-python/commit/29b2127", author: dbschmigelski }
  - { type: fix, breaking: false, scope: structured_output, areas: [structured-output], title: "do not modify conversation_history when prompt is passed", pr: 628, prUrl: "https://github.com/strands-agents/sdk-python/pull/628", commit: "adac26f", commitUrl: "https://github.com/strands-agents/sdk-python/commit/adac26f", author: dbschmigelski }
newContributors:
  - { login: vinc3m1, pr: 588 }
---
