---
sdk: sdk
language: python
version: "1.19.0"
tag: python/v1.19.0
date: 2025-12-03
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.19.0
packageUrl: https://pypi.org/project/strands-agents/1.19.0/
entries:
  - { type: fix, breaking: false, scope: null, areas: [tool], title: "avoid KeyError in direct tool calls with context", pr: 1213, prUrl: "https://github.com/strands-agents/sdk-python/pull/1213", commit: "aaf9715", commitUrl: "https://github.com/strands-agents/sdk-python/commit/aaf9715", author: qmays-phdata }
  - { type: fix, breaking: false, scope: null, areas: [], title: "attached custom attributes to all spans", pr: 1235, prUrl: "https://github.com/strands-agents/sdk-python/pull/1235", commit: "8e6f48a", commitUrl: "https://github.com/strands-agents/sdk-python/commit/8e6f48a", author: poshinchen }
  - { type: other, breaking: false, scope: null, areas: [hooks], title: "hooks - before node call - cancel node", pr: 1203, prUrl: "https://github.com/strands-agents/sdk-python/pull/1203", commit: "f3cee8c", commitUrl: "https://github.com/strands-agents/sdk-python/commit/f3cee8c", author: pgrayy }
  - { type: other, breaking: false, scope: null, areas: [], title: "interrupts - support falsey responses", pr: 1256, prUrl: "https://github.com/strands-agents/sdk-python/pull/1256", commit: "f8c3008", commitUrl: "https://github.com/strands-agents/sdk-python/commit/f8c3008", author: pgrayy }
  - { type: other, breaking: false, scope: null, areas: [bidirectional-streaming], title: "Bidirectional Streaming Agent", pr: 1276, prUrl: "https://github.com/strands-agents/sdk-python/pull/1276", commit: "01b821c", commitUrl: "https://github.com/strands-agents/sdk-python/commit/01b821c", author: mehtarac }
  - { type: other, breaking: false, scope: null, areas: [mcp], title: "mcp - elicitation - fix server request test", pr: 1281, prUrl: "https://github.com/strands-agents/sdk-python/pull/1281", commit: "9fa818e", commitUrl: "https://github.com/strands-agents/sdk-python/commit/9fa818e", author: pgrayy }
  - { type: feat, breaking: false, scope: steering, areas: [], title: "add experimental steering for modular prompting", pr: 1280, prUrl: "https://github.com/strands-agents/sdk-python/pull/1280", commit: "50969a4", commitUrl: "https://github.com/strands-agents/sdk-python/commit/50969a4", author: dbschmigelski }
  - { type: test, breaking: false, scope: steering, areas: [], title: "adjust integ test system prompts to reduce flakiness", pr: 1282, prUrl: "https://github.com/strands-agents/sdk-python/pull/1282", commit: "62534de", commitUrl: "https://github.com/strands-agents/sdk-python/commit/62534de", author: dbschmigelski }
newContributors:
  - { login: qmays-phdata, pr: 1213 }
---
