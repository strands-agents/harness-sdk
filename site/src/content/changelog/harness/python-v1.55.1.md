---
sdk: harness
language: python
version: "1.55.1"
tag: python/v1.55.1
date: 2026-09-09
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.55.1
packageUrl: https://pypi.org/project/strands-agents/1.55.1/
entries:
  - { type: fix, breaking: false, scope: context, areas: [context], title: "fix various context manager parity items", pr: 4228, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4228", commit: "bebf3e8", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/bebf3e8", author: lizradway }
  - { type: fix, breaking: false, scope: models, areas: [model], title: "resolve nested Bedrock model prefixes", pr: 4221, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4221", commit: "21b27d4", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/21b27d4", author: arnnv }
  - { type: feat, breaking: false, scope: python, areas: [async, agent], title: "add backgroundTasks to Agent", pr: 4226, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4226", commit: "42e5a61", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/42e5a61", author: gautamsirdeshmukh }
  - { type: feat, breaking: false, scope: bidi, areas: [model, bidirectional-streaming], title: "simplify Google and OpenAI model configs", pr: 4189, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4189", commit: "6d4f61f", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/6d4f61f", author: pgrayy }
  - { type: fix, breaking: false, scope: telemetry, areas: [otel, agent], title: "use semantic system instructions for agent spans", pr: 4222, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4222", commit: "e5ebbd6", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/e5ebbd6", author: arnnv }
  - { type: fix, breaking: false, scope: session, areas: [persistence], title: "filter malformed immutable snapshot IDs", pr: 4199, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4199", commit: "6d6c8fc", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/6d6c8fc", author: waitasecant }
  - { type: feat, breaking: false, scope: vended-tools, areas: [tool], title: "port notebook tool to Python", pr: 4132, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4132", commit: "545d9ed", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/545d9ed", author: liramon2 }
---
