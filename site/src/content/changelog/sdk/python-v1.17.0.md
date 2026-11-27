---
sdk: sdk
language: python
version: "1.17.0"
tag: python/v1.17.0
date: 2025-11-18
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.17.0
packageUrl: https://pypi.org/project/strands-agents/1.17.0/
entries:
  - { type: feat, breaking: false, scope: null, areas: [], title: "allow setting a timeout when creating MCPAgentTool", pr: 1184, prUrl: "https://github.com/strands-agents/sdk-python/pull/1184", commit: "cee5145", commitUrl: "https://github.com/strands-agents/sdk-python/commit/cee5145", author: AnirudhKonduru }
  - { type: fix, breaking: false, scope: litellm, areas: [model], title: "add validation for stream parameter in LiteLLM", pr: 1183, prUrl: "https://github.com/strands-agents/sdk-python/pull/1183", commit: "ded0934", commitUrl: "https://github.com/strands-agents/sdk-python/commit/ded0934", author: dbschmigelski }
  - { type: fix, breaking: false, scope: event_loop, areas: [otel], title: "handle MetadataEvents without optional usage and metrics", pr: 1187, prUrl: "https://github.com/strands-agents/sdk-python/pull/1187", commit: "77cb23f", commitUrl: "https://github.com/strands-agents/sdk-python/commit/77cb23f", author: dbschmigelski }
  - { type: other, breaking: false, scope: null, areas: [multiagent], title: "swarm - switch to handoff node only after current node stops", pr: 1147, prUrl: "https://github.com/strands-agents/sdk-python/pull/1147", commit: "b4efc9d", commitUrl: "https://github.com/strands-agents/sdk-python/commit/b4efc9d", author: pgrayy }
  - { type: fix, breaking: false, scope: a2a, areas: [a2a], title: "base64 decode byte data before placing in ContentBlocks", pr: 1195, prUrl: "https://github.com/strands-agents/sdk-python/pull/1195", commit: "95ac650", commitUrl: "https://github.com/strands-agents/sdk-python/commit/95ac650", author: dbschmigelski }
newContributors:
  - { login: AnirudhKonduru, pr: 1184 }
---
