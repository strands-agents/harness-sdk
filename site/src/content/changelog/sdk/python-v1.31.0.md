---
sdk: sdk
language: python
version: "1.31.0"
tag: python/v1.31.0
date: 2026-03-19
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.31.0
packageUrl: https://pypi.org/project/strands-agents/1.31.0/
entries:
  - { type: feat, breaking: false, scope: null, areas: [a2a], title: "pass A2A request context metadata as invocation state", pr: 1854, prUrl: "https://github.com/strands-agents/sdk-python/pull/1854", commit: "fca208b", commitUrl: "https://github.com/strands-agents/sdk-python/commit/fca208b", author: mkmeral }
  - { type: fix, breaking: false, scope: null, areas: [sessions], title: "s3session manager bug", pr: 1915, prUrl: "https://github.com/strands-agents/sdk-python/pull/1915", commit: "39c8c19", commitUrl: "https://github.com/strands-agents/sdk-python/commit/39c8c19", author: mehtarac }
  - { type: fix, breaking: false, scope: graph, areas: [multiagent], title: "only evaluate outbound edges from completed nodes", pr: 1846, prUrl: "https://github.com/strands-agents/sdk-python/pull/1846", commit: "2e4c82b", commitUrl: "https://github.com/strands-agents/sdk-python/commit/2e4c82b", author: giulio-leone }
  - { type: fix, breaking: false, scope: openai, areas: [model], title: "always use string content for tool messages", pr: 1878, prUrl: "https://github.com/strands-agents/sdk-python/pull/1878", commit: "b66534b", commitUrl: "https://github.com/strands-agents/sdk-python/commit/b66534b", author: giulio-leone }
  - { type: feat, breaking: false, scope: null, areas: [model], title: "widen openai dependency to support 2.x for litellm compatibility", pr: 1793, prUrl: "https://github.com/strands-agents/sdk-python/pull/1793", commit: "d03311a", commitUrl: "https://github.com/strands-agents/sdk-python/commit/d03311a", author: BV-Venky }
  - { type: fix, breaking: false, scope: null, areas: [multiagent], title: "typeError when serializing multimodal prompts with binary content in Graph/Swarm session persistence", pr: 1870, prUrl: "https://github.com/strands-agents/sdk-python/pull/1870", commit: "566e5ad", commitUrl: "https://github.com/strands-agents/sdk-python/commit/566e5ad", author: JackYPCOnline }
  - { type: fix, breaking: false, scope: null, areas: [], title: "lowercase the python language in code snippet", pr: 1929, prUrl: "https://github.com/strands-agents/sdk-python/pull/1929", commit: "83ff4e0", commitUrl: "https://github.com/strands-agents/sdk-python/commit/83ff4e0", author: zastrowm }
  - { type: fix, breaking: false, scope: null, areas: [model], title: "openai repsonses api error handling", pr: 1931, prUrl: "https://github.com/strands-agents/sdk-python/pull/1931", commit: "1643a62", commitUrl: "https://github.com/strands-agents/sdk-python/commit/1643a62", author: Unshure }
newContributors:
  - { login: BV-Venky, pr: 1793 }
---
