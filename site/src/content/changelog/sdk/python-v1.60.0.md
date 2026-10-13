---
sdk: sdk
language: python
version: "1.60.0"
tag: python/v1.60.0
date: 2026-10-12
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.60.0
packageUrl: https://pypi.org/project/strands-agents/1.60.0/
entries:
  - { type: fix, breaking: false, scope: gemini, areas: [model], title: "format video content blocks as inline data", pr: 4910, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4910", commit: "e519d67", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/e519d67", author: expect04199 }
  - { type: fix, breaking: false, scope: models, areas: [context, model], title: "add context window limit for Haiku 5.5 (py + ts)", pr: 4998, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4998", commit: "6d60fdb", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/6d60fdb", author: Katsuhito04 }
  - { type: feat, breaking: false, scope: ts, areas: [multiagent, language], title: "port vended subagent tool to TypeScript", pr: 4971, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4971", commit: "29d006e", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/29d006e", author: liramon2 }
  - { type: feat, breaking: true, scope: context, areas: [context, multiagent], title: "share the stash across agents through a caller-scoped storage view", pr: 4389, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4389", commit: "b340edb", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/b340edb", author: tummon }
  - { type: fix, breaking: false, scope: harness-py, areas: [model], title: "map Bedrock families to small web_fetch summarizers; enable Nova 2 thinking", pr: 4853, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4853", commit: "7583a50", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/7583a50", author: karmendra8386 }
  - { type: feat, breaking: false, scope: py, areas: [tool, server], title: "add python_repl vended tool", pr: 4384, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4384", commit: "a2524a5", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/a2524a5", author: liramon2 }
  - { type: fix, breaking: false, scope: openai, areas: [model], title: "warn about reasoningContent once per request", pr: 5016, prUrl: "https://github.com/strands-agents/harness-sdk/pull/5016", commit: "e46b0db", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/e46b0db", author: AkshayShah03 }
  - { type: feat, breaking: false, scope: harness, areas: [model], title: "support Anthropic native web search in TypeScript", pr: 4789, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4789", commit: "afc3e05", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/afc3e05", author: strandly-the-agent }
  - { type: fix, breaking: false, scope: python, areas: [devx], title: "deduplicate usage nudges via stdlib warnings module", pr: 4983, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4983", commit: "38afb96", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/38afb96", author: jimbrub }
  - { type: feat, breaking: false, scope: telemetry, areas: [otel, sessions], title: "propagate OTel baggage context in Python", pr: 4840, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4840", commit: "900ad33", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/900ad33", author: liramon2 }
---
