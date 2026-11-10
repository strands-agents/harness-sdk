---
sdk: sdk
language: python
version: "1.29.0"
tag: python/v1.29.0
date: 2026-03-04
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.29.0
packageUrl: https://pypi.org/project/strands-agents/1.29.0/
entries:
  - { type: test, breaking: false, scope: null, areas: [], title: "pin virtualenv to <21 for hatch bug", pr: 1771, prUrl: "https://github.com/strands-agents/sdk-python/pull/1771", commit: "1df2438", commitUrl: "https://github.com/strands-agents/sdk-python/commit/1df2438", author: clareliguori }
  - { type: fix, breaking: false, scope: telemetry, areas: [otel], title: "added latest semantic conventions as span attributes for langfuse", pr: 1768, prUrl: "https://github.com/strands-agents/sdk-python/pull/1768", commit: "2c83216", commitUrl: "https://github.com/strands-agents/sdk-python/commit/2c83216", author: poshinchen }
  - { type: fix, breaking: false, scope: null, areas: [tool], title: "preserve guardrail_latest_message wrapping after tool execution", pr: 1658, prUrl: "https://github.com/strands-agents/sdk-python/pull/1658", commit: "c50457d", commitUrl: "https://github.com/strands-agents/sdk-python/commit/c50457d", author: austinmw }
  - { type: feat, breaking: false, scope: conversation-manager, areas: [tool], title: "improve tool result truncation strategy", pr: 1756, prUrl: "https://github.com/strands-agents/sdk-python/pull/1756", commit: "1a3b429", commitUrl: "https://github.com/strands-agents/sdk-python/commit/1a3b429", author: kevmyung }
  - { type: feat, breaking: false, scope: plugins, areas: [tool], title: "improve plugin creation devex with @hook and @tool decorators", pr: 1740, prUrl: "https://github.com/strands-agents/sdk-python/pull/1740", commit: "faad564", commitUrl: "https://github.com/strands-agents/sdk-python/commit/faad564", author: Unshure }
  - { type: other, breaking: false, scope: null, areas: [], title: "bump actions/upload-artifact from 6 to 7", pr: 1777, prUrl: "https://github.com/strands-agents/sdk-python/pull/1777", commit: "9143e23", commitUrl: "https://github.com/strands-agents/sdk-python/commit/9143e23", author: "dependabot[bot]" }
  - { type: other, breaking: false, scope: null, areas: [], title: "bump actions/download-artifact from 7 to 8", pr: 1776, prUrl: "https://github.com/strands-agents/sdk-python/pull/1776", commit: "4cd7eeb", commitUrl: "https://github.com/strands-agents/sdk-python/commit/4cd7eeb", author: "dependabot[bot]" }
  - { type: fix, breaking: false, scope: null, areas: [], title: "throw exceptions from ConcurrentToolExecutor (#1796)", pr: 1797, prUrl: "https://github.com/strands-agents/sdk-python/pull/1797", commit: "3625d7d", commitUrl: "https://github.com/strands-agents/sdk-python/commit/3625d7d", author: charles-dyfis-net }
  - { type: feat, breaking: false, scope: null, areas: [model], title: "add OpenAI Responses API model implementation", pr: 975, prUrl: "https://github.com/strands-agents/sdk-python/pull/975", commit: "31f1e64", commitUrl: "https://github.com/strands-agents/sdk-python/commit/31f1e64", author: notgitika }
newContributors:
  - { login: austinmw, pr: 1658 }
---
