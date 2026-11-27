---
sdk: sdk
language: python
version: "1.40.0"
tag: python/v1.40.0
date: 2026-05-14
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.40.0
packageUrl: https://pypi.org/project/strands-agents/1.40.0/
entries:
  - { type: feat, breaking: false, scope: null, areas: [context], title: "add proactive context compression to conversation managers", pr: 2239, prUrl: "https://github.com/strands-agents/sdk-python/pull/2239", commit: "f862185", commitUrl: "https://github.com/strands-agents/sdk-python/commit/f862185", author: opieter-aws }
  - { type: feat, breaking: false, scope: null, areas: [], title: "cache AccessDenied error for count tokens", pr: 2279, prUrl: "https://github.com/strands-agents/sdk-python/pull/2279", commit: "1847fae", commitUrl: "https://github.com/strands-agents/sdk-python/commit/1847fae", author: opieter-aws }
  - { type: fix, breaking: false, scope: ollama, areas: [model], title: "update return type of latencyMs metric for ollama model provider", pr: 2236, prUrl: "https://github.com/strands-agents/sdk-python/pull/2236", commit: "b1a3f03", commitUrl: "https://github.com/strands-agents/sdk-python/commit/b1a3f03", author: paliwalvimal }
  - { type: feat, breaking: false, scope: null, areas: [], title: "add official Discord link", pr: 2285, prUrl: "https://github.com/strands-agents/sdk-python/pull/2285", commit: "6b53928", commitUrl: "https://github.com/strands-agents/sdk-python/commit/6b53928", author: Albertozhao }
  - { type: fix, breaking: false, scope: null, areas: [], title: "set use_native_token_count default to false", pr: 2284, prUrl: "https://github.com/strands-agents/sdk-python/pull/2284", commit: "305a005", commitUrl: "https://github.com/strands-agents/sdk-python/commit/305a005", author: opieter-aws }
  - { type: fix, breaking: false, scope: null, areas: [multiagent], title: "swarm bug \"Failed to detach context\" with opentelemetry", pr: 2281, prUrl: "https://github.com/strands-agents/sdk-python/pull/2281", commit: "fa74d80", commitUrl: "https://github.com/strands-agents/sdk-python/commit/fa74d80", author: mehtarac }
newContributors:
  - { login: paliwalvimal, pr: 2236 }
---
