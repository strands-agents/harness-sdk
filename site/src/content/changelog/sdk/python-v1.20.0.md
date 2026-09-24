---
sdk: sdk
language: python
version: "1.20.0"
tag: python/v1.20.0
date: 2025-12-15
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.20.0
packageUrl: https://pypi.org/project/strands-agents/1.20.0/
entries:
  - { type: other, breaking: false, scope: null, areas: [sessions], title: "Remove toolResult message when toolUse is missing due to pagination in session management", pr: 1274, prUrl: "https://github.com/strands-agents/sdk-python/pull/1274", commit: "5ea97f9", commitUrl: "https://github.com/strands-agents/sdk-python/commit/5ea97f9", author: afarntrog }
  - { type: other, breaking: false, scope: null, areas: [multiagent], title: "interrupts - swarm", pr: 1193, prUrl: "https://github.com/strands-agents/sdk-python/pull/1193", commit: "25f1ce6", commitUrl: "https://github.com/strands-agents/sdk-python/commit/25f1ce6", author: pgrayy }
  - { type: fix, breaking: false, scope: agent, areas: [agent], title: "Return structured output JSON when AgentResult has no text", pr: 1290, prUrl: "https://github.com/strands-agents/sdk-python/pull/1290", commit: "911a1c7", commitUrl: "https://github.com/strands-agents/sdk-python/commit/911a1c7", author: afarntrog }
  - { type: other, breaking: false, scope: null, areas: [tool], title: "bidi - fix record direct tool call", pr: 1300, prUrl: "https://github.com/strands-agents/sdk-python/pull/1300", commit: "d1b523c", commitUrl: "https://github.com/strands-agents/sdk-python/commit/d1b523c", author: pgrayy }
  - { type: other, breaking: false, scope: null, areas: [], title: "Update doc strings to eliminate warnings in doc build", pr: 1284, prUrl: "https://github.com/strands-agents/sdk-python/pull/1284", commit: "2944abf", commitUrl: "https://github.com/strands-agents/sdk-python/commit/2944abf", author: zastrowm }
  - { type: fix, breaking: false, scope: null, areas: [tool], title: "fix broken tool spec with composition keywords", pr: 1301, prUrl: "https://github.com/strands-agents/sdk-python/pull/1301", commit: "45dd597", commitUrl: "https://github.com/strands-agents/sdk-python/commit/45dd597", author: mkmeral }
  - { type: other, breaking: false, scope: null, areas: [], title: "bidi - tests - lint", pr: 1307, prUrl: "https://github.com/strands-agents/sdk-python/pull/1307", commit: "6543097", commitUrl: "https://github.com/strands-agents/sdk-python/commit/6543097", author: pgrayy }
  - { type: other, breaking: false, scope: null, areas: [], title: "bidi - fix mypy errors", pr: 1308, prUrl: "https://github.com/strands-agents/sdk-python/pull/1308", commit: "e692133", commitUrl: "https://github.com/strands-agents/sdk-python/commit/e692133", author: pgrayy }
  - { type: feat, breaking: false, scope: hooks, areas: [hooks], title: "add AgentResult to AfterInvocationEvent", pr: 1125, prUrl: "https://github.com/strands-agents/sdk-python/pull/1125", commit: "9f70298", commitUrl: "https://github.com/strands-agents/sdk-python/commit/9f70298", author: Ratish1 }
  - { type: feat, breaking: false, scope: docs, areas: [agent], title: "Create agent.md and docs folder", pr: 1312, prUrl: "https://github.com/strands-agents/sdk-python/pull/1312", commit: "a64a851", commitUrl: "https://github.com/strands-agents/sdk-python/commit/a64a851", author: mkmeral }
  - { type: other, breaking: false, scope: null, areas: [], title: "bidi - remove python 3.11+ features", pr: 1302, prUrl: "https://github.com/strands-agents/sdk-python/pull/1302", commit: "60bd291", commitUrl: "https://github.com/strands-agents/sdk-python/commit/60bd291", author: pgrayy }
  - { type: fix, breaking: false, scope: null, areas: [mcp], title: "close mcp client event loop", pr: 1321, prUrl: "https://github.com/strands-agents/sdk-python/pull/1321", commit: "2a02388", commitUrl: "https://github.com/strands-agents/sdk-python/commit/2a02388", author: davidpadbury }
newContributors:
  - { login: davidpadbury, pr: 1321 }
---
