---
sdk: sdk
language: python
version: "1.37.0"
tag: python/v1.37.0
date: 2026-04-22
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.37.0
packageUrl: https://pypi.org/project/strands-agents/1.37.0/
entries:
  - { type: fix, breaking: false, scope: null, areas: [tool], title: "add fallback trim point for tool-heavy conversations in SlidingWindowConversationManager", pr: 2174, prUrl: "https://github.com/strands-agents/sdk-python/pull/2174", commit: "7b0337b", commitUrl: "https://github.com/strands-agents/sdk-python/commit/7b0337b", author: lufecadu }
  - { type: feat, breaking: false, scope: null, areas: [persistence], title: "introduce checkpoint in experimental", pr: 2181, prUrl: "https://github.com/strands-agents/sdk-python/pull/2181", commit: "724b591", commitUrl: "https://github.com/strands-agents/sdk-python/commit/724b591", author: JackYPCOnline }
  - { type: feat, breaking: false, scope: null, areas: [], title: "add context_window_limit to model configs", pr: 2176, prUrl: "https://github.com/strands-agents/sdk-python/pull/2176", commit: "c723e52", commitUrl: "https://github.com/strands-agents/sdk-python/commit/c723e52", author: opieter-aws }
  - { type: fix, breaking: false, scope: mcp, areas: [mcp], title: "skip MCPClient cleanup during interpreter finalization", pr: 2144, prUrl: "https://github.com/strands-agents/sdk-python/pull/2144", commit: "255b767", commitUrl: "https://github.com/strands-agents/sdk-python/commit/255b767", author: minorun365 }
  - { type: fix, breaking: false, scope: tests, areas: [], title: "update retired claude-3-haiku model in integration tests", pr: 2186, prUrl: "https://github.com/strands-agents/sdk-python/pull/2186", commit: "50439e0", commitUrl: "https://github.com/strands-agents/sdk-python/commit/50439e0", author: afarntrog }
newContributors:
  - { login: lufecadu, pr: 2174 }
---
