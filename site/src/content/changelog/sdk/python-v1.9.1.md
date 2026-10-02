---
sdk: sdk
language: python
version: "1.9.1"
tag: python/v1.9.1
date: 2025-09-19
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.9.1
packageUrl: https://pypi.org/project/strands-agents/1.9.1/
entries:
  - { type: feat, breaking: false, scope: null, areas: [], title: "decouple Strands ContentBlock and BedrockModel", pr: 836, prUrl: "https://github.com/strands-agents/sdk-python/pull/836", commit: "406458d", commitUrl: "https://github.com/strands-agents/sdk-python/commit/406458d", author: dbschmigelski }
  - { type: fix, breaking: false, scope: null, areas: [structured-output], title: "Invoke callback handler for structured_output", pr: 857, prUrl: "https://github.com/strands-agents/sdk-python/pull/857", commit: "a36255d", commitUrl: "https://github.com/strands-agents/sdk-python/commit/a36255d", author: zastrowm }
  - { type: fix, breaking: false, scope: null, areas: [], title: "Update prepare to use format instead of test-format", pr: 858, prUrl: "https://github.com/strands-agents/sdk-python/pull/858", commit: "4b10c93", commitUrl: "https://github.com/strands-agents/sdk-python/commit/4b10c93", author: zastrowm }
  - { type: fix, breaking: false, scope: null, areas: [], title: "add explicit permissions to auto-close workflow", pr: 893, prUrl: "https://github.com/strands-agents/sdk-python/pull/893", commit: "68103f6", commitUrl: "https://github.com/strands-agents/sdk-python/commit/68103f6", author: Unshure }
  - { type: fix, breaking: false, scope: null, areas: [], title: "make mcp_instrumentation idempotent to prevent recursion errors", pr: 892, prUrl: "https://github.com/strands-agents/sdk-python/pull/892", commit: "337c43e", commitUrl: "https://github.com/strands-agents/sdk-python/commit/337c43e", author: Unshure }
  - { type: fix, breaking: false, scope: null, areas: [], title: "Fix github workflow to use fmt instead of hatch run", pr: 898, prUrl: "https://github.com/strands-agents/sdk-python/pull/898", commit: "98f7cde", commitUrl: "https://github.com/strands-agents/sdk-python/commit/98f7cde", author: Unshure }
  - { type: fix, breaking: false, scope: models, areas: [model], title: "make tool_choice an optional keyword arg instead positional", pr: 899, prUrl: "https://github.com/strands-agents/sdk-python/pull/899", commit: "00a1f28", commitUrl: "https://github.com/strands-agents/sdk-python/commit/00a1f28", author: dbschmigelski }
---
