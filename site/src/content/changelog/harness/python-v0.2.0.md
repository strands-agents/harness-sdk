---
sdk: harness
language: python
version: "0.2.0"
tag: harness-python/v0.2.0
date: 2026-10-08
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/harness-python/v0.2.0
packageUrl: https://pypi.org/project/strands-harness/0.2.0/
entries:
  - { type: feat, breaking: false, scope: agent, areas: [devx, agent], title: "add Agent.shutdown() for scope-based cleanup", pr: 4519, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4519", commit: "fec0427", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/fec0427", author: opieter-aws }
  - { type: docs, breaking: false, scope: harness, areas: [], title: "add versioning policy for Strands harness and the CLI", pr: 4535, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4535", commit: "2c49c9c", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/2c49c9c", author: strandly-the-agent }
  - { type: other, breaking: false, scope: null, areas: [devx], title: "add Python lint/format gate to pre-commit hook", pr: 4528, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4528", commit: "219dbf6", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/219dbf6", author: opieter-aws }
  - { type: fix, breaking: false, scope: harness, areas: [devx, model], title: "reject caching values other than 'auto', a bool, or None", pr: 4631, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4631", commit: "d7fbb2a", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/d7fbb2a", author: Vivek0712 }
  - { type: docs, breaking: false, scope: harness, areas: [], title: "update default model", pr: 4661, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4661", commit: "b7900ae", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/b7900ae", author: opieter-aws }
  - { type: docs, breaking: false, scope: null, areas: [community], title: "add Human Overview sections to templates per AI usage reflection", pr: 4696, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4696", commit: "303a2be", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/303a2be", author: Unshure }
  - { type: fix, breaking: false, scope: harness, areas: [community], title: "remove context offloader plugin from harness in favor of context manager's stash", pr: 4701, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4701", commit: "c73253d", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/c73253d", author: opieter-aws }
  - { type: docs, breaking: false, scope: null, areas: [otel], title: "add Observability catalog type", pr: 4772, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4772", commit: "79bfd80", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/79bfd80", author: opieter-aws }
  - { type: feat, breaking: false, scope: skills, areas: [agent], title: "add Strands coding-agent skill", pr: 4739, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4739", commit: "8404ebb", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/8404ebb", author: tmoreton }
  - { type: fix, breaking: false, scope: harness, areas: [devx, server], title: "log at info when the default web_search is unavailable", pr: 4786, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4786", commit: "bc4cec4", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/bc4cec4", author: agent-of-mkmeral }
  - { type: feat, breaking: false, scope: stop, areas: [tool, agent], title: "use agent.cancel() to stop the event loop", pr: 3506, prUrl: "https://github.com/strands-agents/harness-sdk/pull/3506", commit: "5e82809", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/5e82809", author: Unshure }
  - { type: other, breaking: false, scope: deps-dev, areas: [community], title: "bump browserslist from 4.28.2 to 4.28.8 in /test-infra in the npm_and_yarn group across 1 directory", pr: 4110, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4110", commit: "59f126f", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/59f126f", author: "dependabot[bot]" }
  - { type: fix, breaking: false, scope: harness-py, areas: [persistence, sessions], title: "require SDK 1.57.2 for session restore", pr: 4974, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4974", commit: "6f23cba", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/6f23cba", author: pgrayy }
---
