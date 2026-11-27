---
sdk: sdk
language: python
version: "1.26.0"
tag: python/v1.26.0
date: 2026-02-11
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.26.0
packageUrl: https://pypi.org/project/strands-agents/1.26.0/
entries:
  - { type: other, breaking: false, scope: null, areas: [], title: "bump aws-actions/configure-aws-credentials from 5 to 6", pr: 1632, prUrl: "https://github.com/strands-agents/sdk-python/pull/1632", commit: "42f15c2", commitUrl: "https://github.com/strands-agents/sdk-python/commit/42f15c2", author: "dependabot[bot]" }
  - { type: docs, breaking: false, scope: null, areas: [], title: "add guidance on using Protocol instead of Callable for extensible interfaces", pr: 1637, prUrl: "https://github.com/strands-agents/sdk-python/pull/1637", commit: "cc4afb3", commitUrl: "https://github.com/strands-agents/sdk-python/commit/cc4afb3", author: dbschmigelski }
  - { type: feat, breaking: false, scope: mcp, areas: [mcp], title: "Implement basic support for Tasks", pr: 1475, prUrl: "https://github.com/strands-agents/sdk-python/pull/1475", commit: "ecfb864", commitUrl: "https://github.com/strands-agents/sdk-python/commit/ecfb864", author: LucaButBoring }
  - { type: fix, breaking: false, scope: multiagent, areas: [multiagent], title: "set empty text part data in `parts` for `Artifact`", pr: 1643, prUrl: "https://github.com/strands-agents/sdk-python/pull/1643", commit: "3348099", commitUrl: "https://github.com/strands-agents/sdk-python/commit/3348099", author: punkyoon }
  - { type: fix, breaking: false, scope: summarizing_conversation_manager, areas: [bidirectional-streaming], title: "use model stream to generate summary", pr: 1653, prUrl: "https://github.com/strands-agents/sdk-python/pull/1653", commit: "18a349c", commitUrl: "https://github.com/strands-agents/sdk-python/commit/18a349c", author: mkmeral }
  - { type: fix, breaking: false, scope: bedrock, areas: [model], title: "add 'prompt is too long' to context window overflow mes…", pr: 1663, prUrl: "https://github.com/strands-agents/sdk-python/pull/1663", commit: "66fb308", commitUrl: "https://github.com/strands-agents/sdk-python/commit/66fb308", author: eladb3 }
  - { type: fix, breaking: false, scope: null, areas: [mcp], title: "fix mcp tests", pr: 1664, prUrl: "https://github.com/strands-agents/sdk-python/pull/1664", commit: "a43e936", commitUrl: "https://github.com/strands-agents/sdk-python/commit/a43e936", author: afarntrog }
newContributors:
  - { login: punkyoon, pr: 1643 }
  - { login: eladb3, pr: 1663 }
---
