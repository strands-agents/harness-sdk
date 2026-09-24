---
sdk: sdk
language: python
version: "1.15.0"
tag: python/v1.15.0
date: 2025-11-04
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.15.0
packageUrl: https://pypi.org/project/strands-agents/1.15.0/
entries:
  - { type: fix, breaking: false, scope: null, areas: [], title: "(bug): Drop reasoningContent from request", pr: 1099, prUrl: "https://github.com/strands-agents/sdk-python/pull/1099", commit: "4e49d9a", commitUrl: "https://github.com/strands-agents/sdk-python/commit/4e49d9a", author: mehtarac }
  - { type: fix, breaking: false, scope: null, areas: [multiagent], title: "Dont initialize an agent on swarm init", pr: 1107, prUrl: "https://github.com/strands-agents/sdk-python/pull/1107", commit: "c302a8a", commitUrl: "https://github.com/strands-agents/sdk-python/commit/c302a8a", author: Unshure }
  - { type: feat, breaking: false, scope: null, areas: [multiagent], title: "add multiagent session/repository management.", pr: 1071, prUrl: "https://github.com/strands-agents/sdk-python/pull/1071", commit: "95906fa", commitUrl: "https://github.com/strands-agents/sdk-python/commit/95906fa", author: JackYPCOnline }
  - { type: feat, breaking: false, scope: multiagent, areas: [multiagent], title: "Add stream_async", pr: 961, prUrl: "https://github.com/strands-agents/sdk-python/pull/961", commit: "111e77c", commitUrl: "https://github.com/strands-agents/sdk-python/commit/111e77c", author: mkmeral }
  - { type: other, breaking: false, scope: null, areas: [], title: "Fix #1077: properly redact toolResult blocks to avoid corrupting the conversation", pr: 1080, prUrl: "https://github.com/strands-agents/sdk-python/pull/1080", commit: "ce5c662", commitUrl: "https://github.com/strands-agents/sdk-python/commit/ce5c662", author: leotac }
  - { type: other, breaking: false, scope: null, areas: [], title: "linting", pr: 1120, prUrl: "https://github.com/strands-agents/sdk-python/pull/1120", commit: "3b00110", commitUrl: "https://github.com/strands-agents/sdk-python/commit/3b00110", author: pgrayy }
  - { type: other, breaking: false, scope: null, areas: [], title: "Fix input/output message not redacted when guardrails_trace=\"enabled_full\"", pr: 1072, prUrl: "https://github.com/strands-agents/sdk-python/pull/1072", commit: "db671ba", commitUrl: "https://github.com/strands-agents/sdk-python/commit/db671ba", author: leotac }
  - { type: fix, breaking: false, scope: null, areas: [structured-output], title: "Allow none structured output context in tool executors", pr: 1128, prUrl: "https://github.com/strands-agents/sdk-python/pull/1128", commit: "bed1b68", commitUrl: "https://github.com/strands-agents/sdk-python/commit/bed1b68", author: mkmeral }
  - { type: fix, breaking: false, scope: null, areas: [], title: "Fix broken converstaion with orphaned toolUse", pr: 1123, prUrl: "https://github.com/strands-agents/sdk-python/pull/1123", commit: "417ebea", commitUrl: "https://github.com/strands-agents/sdk-python/commit/417ebea", author: Unshure }
  - { type: feat, breaking: false, scope: null, areas: [multiagent], title: "Enable multiagent session persistent in Graph/Swarm", pr: 1110, prUrl: "https://github.com/strands-agents/sdk-python/pull/1110", commit: "5981d36", commitUrl: "https://github.com/strands-agents/sdk-python/commit/5981d36", author: JackYPCOnline }
  - { type: feat, breaking: false, scope: models, areas: [model], title: "add SystemContentBlock support for provider-agnostic caching", pr: 1112, prUrl: "https://github.com/strands-agents/sdk-python/pull/1112", commit: "9f10595", commitUrl: "https://github.com/strands-agents/sdk-python/commit/9f10595", author: dbschmigelski }
newContributors:
  - { login: leotac, pr: 1080 }
---
