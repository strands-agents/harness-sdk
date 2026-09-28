---
sdk: sdk
language: python
version: "1.24.0"
tag: python/v1.24.0
date: 2026-01-29
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.24.0
packageUrl: https://pypi.org/project/strands-agents/1.24.0/
entries:
  - { type: test, breaking: false, scope: null, areas: [model], title: "fix flaky openai structured output test by adding Field guidance", pr: 1534, prUrl: "https://github.com/strands-agents/sdk-python/pull/1534", commit: "78a1c28", commitUrl: "https://github.com/strands-agents/sdk-python/commit/78a1c28", author: dbschmigelski }
  - { type: other, breaking: false, scope: null, areas: [multiagent], title: "interrupts - multiagent - do not emit AfterNodeCallEvent on interrupt", pr: 1539, prUrl: "https://github.com/strands-agents/sdk-python/pull/1539", commit: "70b1d10", commitUrl: "https://github.com/strands-agents/sdk-python/commit/70b1d10", author: pgrayy }
  - { type: other, breaking: false, scope: null, areas: [], title: "add workflow for lambda layer publish", pr: 870, prUrl: "https://github.com/strands-agents/sdk-python/pull/870", commit: "66d3db2", commitUrl: "https://github.com/strands-agents/sdk-python/commit/66d3db2", author: dbschmigelski }
  - { type: fix, breaking: false, scope: null, areas: [], title: "Populate tool_args correctly for steering", pr: 1531, prUrl: "https://github.com/strands-agents/sdk-python/pull/1531", commit: "612b07e", commitUrl: "https://github.com/strands-agents/sdk-python/commit/612b07e", author: clareliguori }
  - { type: other, breaking: false, scope: null, areas: [multiagent], title: "interrupts - graph - agent based", pr: 1533, prUrl: "https://github.com/strands-agents/sdk-python/pull/1533", commit: "fa86444", commitUrl: "https://github.com/strands-agents/sdk-python/commit/fa86444", author: pgrayy }
  - { type: chore, breaking: false, scope: null, areas: [], title: "refactor use_span to be closed automatically", pr: 1293, prUrl: "https://github.com/strands-agents/sdk-python/pull/1293", commit: "fdd9482", commitUrl: "https://github.com/strands-agents/sdk-python/commit/fdd9482", author: poshinchen }
  - { type: other, breaking: false, scope: null, areas: [], title: "limit permission scope on lambda layer github action", pr: 1555, prUrl: "https://github.com/strands-agents/sdk-python/pull/1555", commit: "1cedaed", commitUrl: "https://github.com/strands-agents/sdk-python/commit/1cedaed", author: dbschmigelski }
  - { type: chore, breaking: false, scope: null, areas: [], title: "Enable Auto-close labels on Pull requests as well.", pr: 1552, prUrl: "https://github.com/strands-agents/sdk-python/pull/1552", commit: "98fcc2c", commitUrl: "https://github.com/strands-agents/sdk-python/commit/98fcc2c", author: yonib05 }
  - { type: other, breaking: false, scope: null, areas: [], title: "Use devtools actions", pr: 1554, prUrl: "https://github.com/strands-agents/sdk-python/pull/1554", commit: "ee31947", commitUrl: "https://github.com/strands-agents/sdk-python/commit/ee31947", author: Unshure }
  - { type: feat, breaking: false, scope: bedrock, areas: [model], title: "add automatic prompt caching support", pr: 1438, prUrl: "https://github.com/strands-agents/sdk-python/pull/1438", commit: "138750c", commitUrl: "https://github.com/strands-agents/sdk-python/commit/138750c", author: kevmyung }
  - { type: feat, breaking: false, scope: hooks, areas: [hooks], title: "add retry mechanism for tool calls", pr: 1556, prUrl: "https://github.com/strands-agents/sdk-python/pull/1556", commit: "27b9bc3", commitUrl: "https://github.com/strands-agents/sdk-python/commit/27b9bc3", author: dbschmigelski }
  - { type: feat, breaking: false, scope: tools, areas: [tool], title: "move ToolProvider out of experimental namespace", pr: 1567, prUrl: "https://github.com/strands-agents/sdk-python/pull/1567", commit: "4d0ffe8", commitUrl: "https://github.com/strands-agents/sdk-python/commit/4d0ffe8", author: Unshure }
  - { type: other, breaking: false, scope: null, areas: [model], title: "[FIX] models - gemini - start and stop reasoningContent", pr: 1557, prUrl: "https://github.com/strands-agents/sdk-python/pull/1557", commit: "62cc949", commitUrl: "https://github.com/strands-agents/sdk-python/commit/62cc949", author: JackYPCOnline }
  - { type: feat, breaking: false, scope: agent, areas: [agent], title: "update AgentResult __str__ priority order", pr: 1553, prUrl: "https://github.com/strands-agents/sdk-python/pull/1553", commit: "694c4a7", commitUrl: "https://github.com/strands-agents/sdk-python/commit/694c4a7", author: afarntrog }
  - { type: other, breaking: false, scope: null, areas: [tool], title: "callback handler - fix reporting of tool when missing delta", pr: 1573, prUrl: "https://github.com/strands-agents/sdk-python/pull/1573", commit: "e8fc991", commitUrl: "https://github.com/strands-agents/sdk-python/commit/e8fc991", author: pgrayy }
  - { type: feat, breaking: false, scope: hooks, areas: [hooks], title: "Add invocation state", pr: 1550, prUrl: "https://github.com/strands-agents/sdk-python/pull/1550", commit: "f814458", commitUrl: "https://github.com/strands-agents/sdk-python/commit/f814458", author: mkmeral }
  - { type: test, breaking: false, scope: steering, areas: [], title: "Fix failing integ tests", pr: 1580, prUrl: "https://github.com/strands-agents/sdk-python/pull/1580", commit: "4e4534e", commitUrl: "https://github.com/strands-agents/sdk-python/commit/4e4534e", author: mkmeral }
newContributors:
  - { login: kevmyung, pr: 1438 }
---
