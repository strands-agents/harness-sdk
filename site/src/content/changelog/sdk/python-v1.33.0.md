---
sdk: sdk
language: python
version: "1.33.0"
tag: python/v1.33.0
date: 2026-03-24
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.33.0
packageUrl: https://pypi.org/project/strands-agents/1.33.0/
entries:
  - { type: fix, breaking: false, scope: null, areas: [], title: "summarization conversation manager sometimes returns empty response", pr: 1947, prUrl: "https://github.com/strands-agents/sdk-python/pull/1947", commit: "80fdd94", commitUrl: "https://github.com/strands-agents/sdk-python/commit/80fdd94", author: Unshure }
  - { type: fix, breaking: false, scope: null, areas: [multiagent], title: "remove agent from swarm test to get more consistency out of it", pr: 1946, prUrl: "https://github.com/strands-agents/sdk-python/pull/1946", commit: "fd8168a", commitUrl: "https://github.com/strands-agents/sdk-python/commit/fd8168a", author: Unshure }
  - { type: fix, breaking: false, scope: null, areas: [model], title: "CRITICAL: Hard pin `litellm<=1.82.6` to mitigate supply chain attack", pr: 1961, prUrl: "https://github.com/strands-agents/sdk-python/pull/1961", commit: "0a723bc", commitUrl: "https://github.com/strands-agents/sdk-python/commit/0a723bc", author: udaymehta }
newContributors:
  - { login: udaymehta, pr: 1961 }
---
