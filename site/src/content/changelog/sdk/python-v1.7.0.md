---
sdk: sdk
language: python
version: "1.7.0"
tag: python/v1.7.0
date: 2025-09-02
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.7.0
packageUrl: https://pypi.org/project/strands-agents/1.7.0/
entries:
  - { type: feat, breaking: false, scope: null, areas: [], title: "Implement typed events internally", pr: 745, prUrl: "https://github.com/strands-agents/sdk-python/pull/745", commit: "aa03b3d", commitUrl: "https://github.com/strands-agents/sdk-python/commit/aa03b3d", author: zastrowm }
  - { type: other, breaking: false, scope: null, areas: [], title: "summarization manager - add summary prompt to messages", pr: 698, prUrl: "https://github.com/strands-agents/sdk-python/pull/698", commit: "d9f8d8a", commitUrl: "https://github.com/strands-agents/sdk-python/commit/d9f8d8a", author: pgrayy }
  - { type: feat, breaking: false, scope: null, areas: [], title: "Use TypedEvent inheritance for callback behavior", pr: 755, prUrl: "https://github.com/strands-agents/sdk-python/pull/755", commit: "6dadbce", commitUrl: "https://github.com/strands-agents/sdk-python/commit/6dadbce", author: zastrowm }
  - { type: feat, breaking: false, scope: null, areas: [model], title: "claude citation support with BedrockModel", pr: 631, prUrl: "https://github.com/strands-agents/sdk-python/pull/631", commit: "47faba0", commitUrl: "https://github.com/strands-agents/sdk-python/commit/47faba0", author: theagenticguy }
  - { type: feat, breaking: false, scope: null, areas: [hooks], title: "Enable hooks for MultiAgents", pr: 760, prUrl: "https://github.com/strands-agents/sdk-python/pull/760", commit: "94b41b4", commitUrl: "https://github.com/strands-agents/sdk-python/commit/94b41b4", author: zastrowm }
  - { type: other, breaking: false, scope: null, areas: [], title: "Add invocation_state to ToolContext", pr: 761, prUrl: "https://github.com/strands-agents/sdk-python/pull/761", commit: "b008cf5", commitUrl: "https://github.com/strands-agents/sdk-python/commit/b008cf5", author: zastrowm }
  - { type: other, breaking: false, scope: null, areas: [model], title: "Add VPC endpoint support to BedrockModel class - Add optional endpoin…", pr: 502, prUrl: "https://github.com/strands-agents/sdk-python/pull/502", commit: "ae9d5ad", commitUrl: "https://github.com/strands-agents/sdk-python/commit/ae9d5ad", author: dbavro19 }
  - { type: fix, breaking: false, scope: null, areas: [model], title: "fix stop reason for bedrock model when stop_reason", pr: 767, prUrl: "https://github.com/strands-agents/sdk-python/pull/767", commit: "7a5caad", commitUrl: "https://github.com/strands-agents/sdk-python/commit/7a5caad", author: JackYPCOnline }
  - { type: fix, breaking: false, scope: null, areas: [tool], title: "Return tool result message as part of event + expand unit test coverage", pr: 771, prUrl: "https://github.com/strands-agents/sdk-python/pull/771", commit: "cb4b7fb", commitUrl: "https://github.com/strands-agents/sdk-python/commit/cb4b7fb", author: zastrowm }
  - { type: fix, breaking: false, scope: null, areas: [tool], title: "fix loading tools with same tool name", pr: 772, prUrl: "https://github.com/strands-agents/sdk-python/pull/772", commit: "e7d95d6", commitUrl: "https://github.com/strands-agents/sdk-python/commit/e7d95d6", author: JackYPCOnline }
newContributors:
  - { login: dbavro19, pr: 502 }
---
