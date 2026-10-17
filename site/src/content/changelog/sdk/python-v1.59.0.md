---
sdk: sdk
language: python
version: "1.59.0"
tag: python/v1.59.0
date: 2026-10-08
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.59.0
packageUrl: https://pypi.org/project/strands-agents/1.59.0/
entries:
  - { type: fix, breaking: false, scope: gemini, areas: [], title: "map RECITATION finish reason to content_filtered", pr: 4898, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4898", commit: "2bd213d", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/2bd213d", author: charan-rathore }
  - { type: feat, breaking: false, scope: null, areas: [multiagent, tool], title: "add vended subagent tool", pr: 4841, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4841", commit: "f076964", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/f076964", author: liramon2 }
  - { type: fix, breaking: false, scope: agent, areas: [multiagent, hil], title: "resume nested agent-as-tool interrupts across rehydration", pr: 3675, prUrl: "https://github.com/strands-agents/harness-sdk/pull/3675", commit: "79cd735", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/79cd735", author: strandly-the-agent }
  - { type: fix, breaking: false, scope: harness-py, areas: [persistence, sessions], title: "require SDK 1.57.2 for session restore", pr: 4974, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4974", commit: "6f23cba", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/6f23cba", author: pgrayy }
  - { type: fix, breaking: false, scope: cli, areas: [server], title: "handle sandbox clipboard failures", pr: 4959, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4959", commit: "c1ca227", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/c1ca227", author: ferdingler }
  - { type: docs, breaking: false, scope: designs, areas: [], title: "decision model primitive (TS-first rework of 0020)", pr: 4891, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4891", commit: "13e02c8", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/13e02c8", author: Unshure }
  - { type: fix, breaking: false, scope: gemini, areas: [model], title: "classify every 429 as throttling regardless of body format", pr: 4524, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4524", commit: "1db454f", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/1db454f", author: tylerganter }
  - { type: fix, breaking: false, scope: injection, areas: [model, interventions], title: "drop the leading blank line on tool-result turns (py)", pr: 4828, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4828", commit: "d8f4b7f", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/d8f4b7f", author: arielnabavian }
  - { type: fix, breaking: false, scope: models, areas: [model], title: "support Anthropic cache writes on older LiteLLM", pr: 4979, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4979", commit: "925067c", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/925067c", author: pgrayy }
---
