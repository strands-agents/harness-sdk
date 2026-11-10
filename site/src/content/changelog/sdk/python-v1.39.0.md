---
sdk: sdk
language: python
version: "1.39.0"
tag: python/v1.39.0
date: 2026-05-08
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.39.0
packageUrl: https://pypi.org/project/strands-agents/1.39.0/
entries:
  - { type: feat, breaking: false, scope: null, areas: [model], title: "enable openai provider use aws profile", pr: 2230, prUrl: "https://github.com/strands-agents/sdk-python/pull/2230", commit: "a245e6d", commitUrl: "https://github.com/strands-agents/sdk-python/commit/a245e6d", author: JackYPCOnline }
  - { type: fix, breaking: false, scope: null, areas: [], title: "include root cause in MCPClientInitializationError message", pr: 2238, prUrl: "https://github.com/strands-agents/sdk-python/pull/2238", commit: "8638fc2", commitUrl: "https://github.com/strands-agents/sdk-python/commit/8638fc2", author: aidandaly24 }
  - { type: feat, breaking: false, scope: null, areas: [context], title: "add context window limit lookup table", pr: 2249, prUrl: "https://github.com/strands-agents/sdk-python/pull/2249", commit: "559b2a0", commitUrl: "https://github.com/strands-agents/sdk-python/commit/559b2a0", author: opieter-aws }
  - { type: fix, breaking: false, scope: null, areas: [model], title: "fix count tokens for bedrock models", pr: 2254, prUrl: "https://github.com/strands-agents/sdk-python/pull/2254", commit: "d94d516", commitUrl: "https://github.com/strands-agents/sdk-python/commit/d94d516", author: mehtarac }
  - { type: fix, breaking: false, scope: null, areas: [], title: "cache unsupported models for bedrocks token counting", pr: 2250, prUrl: "https://github.com/strands-agents/sdk-python/pull/2250", commit: "6b0df9a", commitUrl: "https://github.com/strands-agents/sdk-python/commit/6b0df9a", author: opieter-aws }
  - { type: feat, breaking: false, scope: null, areas: [], title: "add useNativeTokenCount flag to skip token counting API calls", pr: 2255, prUrl: "https://github.com/strands-agents/sdk-python/pull/2255", commit: "800e7c4", commitUrl: "https://github.com/strands-agents/sdk-python/commit/800e7c4", author: opieter-aws }
  - { type: fix, breaking: false, scope: null, areas: [], title: "correct MCPClient.__exit__ and stop() type annotations", pr: 2248, prUrl: "https://github.com/strands-agents/sdk-python/pull/2248", commit: "980bc91", commitUrl: "https://github.com/strands-agents/sdk-python/commit/980bc91", author: cogwirrel }
  - { type: feat, breaking: false, scope: a2a, areas: [a2a], title: "implement full A2A task lifecycle state support", pr: 2245, prUrl: "https://github.com/strands-agents/sdk-python/pull/2245", commit: "fc386a3", commitUrl: "https://github.com/strands-agents/sdk-python/commit/fc386a3", author: agent-of-mkmeral }
  - { type: fix, breaking: false, scope: null, areas: [], title: "integration test updates", pr: 2262, prUrl: "https://github.com/strands-agents/sdk-python/pull/2262", commit: "ead3179", commitUrl: "https://github.com/strands-agents/sdk-python/commit/ead3179", author: mehtarac }
newContributors:
  - { login: aidandaly24, pr: 2238 }
---
