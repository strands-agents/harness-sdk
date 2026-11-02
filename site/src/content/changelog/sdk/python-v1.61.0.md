---
sdk: sdk
language: python
version: "1.61.0"
tag: python/v1.61.0
date: 2026-10-14
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.61.0
packageUrl: https://pypi.org/project/strands-agents/1.61.0/
entries:
  - { type: feat, breaking: false, scope: mcp, areas: [mcp], title: "support client-level request metadata (_meta) on tool calls", pr: 4660, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4660", commit: "ce9b113", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/ce9b113", author: SuperMarioYL }
  - { type: fix, breaking: false, scope: openai, areas: [model, interventions], title: "map content_filter finish reason to content_filtered", pr: 5072, prUrl: "https://github.com/strands-agents/harness-sdk/pull/5072", commit: "c75eb15", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/c75eb15", author: SergeevDmitry }
  - { type: fix, breaking: false, scope: openai, areas: [model], title: "map a content-filtered Responses API run to content_filtered", pr: 5074, prUrl: "https://github.com/strands-agents/harness-sdk/pull/5074", commit: "80ed9a0", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/80ed9a0", author: chrikrah }
  - { type: fix, breaking: false, scope: python, areas: [multiagent, persistence], title: "serialize multi-agent snapshot saves", pr: 4673, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4673", commit: "1494d5b", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/1494d5b", author: nicolas-m-romero }
  - { type: fix, breaking: false, scope: graph, areas: [multiagent], title: "map cancelled agent results to FAILED and stop downstream routing", pr: 4753, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4753", commit: "109c15b", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/109c15b", author: liramon2 }
  - { type: other, breaking: false, scope: python, areas: [community], title: "update ruff requirement from <0.17.0,>=0.16.0 to >=0.16.0,<0.18.0 in /strands-py", pr: 5100, prUrl: "https://github.com/strands-agents/harness-sdk/pull/5100", commit: "1a47163", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/1a47163", author: "dependabot[bot]" }
  - { type: fix, breaking: false, scope: google, areas: [model], title: "set include_server_side_tool_invocations when mixing function declarations with built-in tools", pr: 4754, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4754", commit: "d485c14", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/d485c14", author: liramon2 }
  - { type: other, breaking: false, scope: null, areas: [community], title: "bump codecov/codecov-action from 7.0.0 to 7.1.1", pr: 4430, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4430", commit: "19d3be2", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/19d3be2", author: "dependabot[bot]" }
  - { type: feat, breaking: false, scope: skills, areas: [devx], title: "package Strands for Claude, Codex, and Cursor", pr: 5123, prUrl: "https://github.com/strands-agents/harness-sdk/pull/5123", commit: "5e84caf", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/5e84caf", author: tmoreton }
---
