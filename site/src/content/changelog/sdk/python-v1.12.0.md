---
sdk: sdk
language: python
version: "1.12.0"
tag: python/v1.12.0
date: 2025-10-10
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.12.0
packageUrl: https://pypi.org/project/strands-agents/1.12.0/
entries:
  - { type: feat, breaking: false, scope: null, areas: [tool], title: "Refactor and update tool loading to support modules", pr: 989, prUrl: "https://github.com/strands-agents/sdk-python/pull/989", commit: "171779a", commitUrl: "https://github.com/strands-agents/sdk-python/commit/171779a", author: Unshure }
  - { type: other, breaking: false, scope: null, areas: [], title: "Adding Development Tenets to CONTRIBUTING.md", pr: 1009, prUrl: "https://github.com/strands-agents/sdk-python/pull/1009", commit: "1790b2d", commitUrl: "https://github.com/strands-agents/sdk-python/commit/1790b2d", author: Unshure }
  - { type: other, breaking: false, scope: null, areas: [sessions], title: "Revert \"feat: implement concurrent message reading for session managers (#897)\"", pr: 1013, prUrl: "https://github.com/strands-agents/sdk-python/pull/1013", commit: "92da544", commitUrl: "https://github.com/strands-agents/sdk-python/commit/92da544", author: pgrayy }
  - { type: feat, breaking: false, scope: models, areas: [model], title: "use tool for litellm structured_output when supports_response_schema=false", pr: 957, prUrl: "https://github.com/strands-agents/sdk-python/pull/957", commit: "2f04758", commitUrl: "https://github.com/strands-agents/sdk-python/commit/2f04758", author: dbschmigelski }
  - { type: other, breaking: false, scope: null, areas: [mcp], title: "Add EmbeddedResource support to mcp (read GitHub file contents blocker)", pr: 726, prUrl: "https://github.com/strands-agents/sdk-python/pull/726", commit: "aada326", commitUrl: "https://github.com/strands-agents/sdk-python/commit/aada326", author: KyMidd }
  - { type: other, breaking: false, scope: null, areas: [tool], title: "conversation manager - summarization - noop tool", pr: 1003, prUrl: "https://github.com/strands-agents/sdk-python/pull/1003", commit: "9632ed5", commitUrl: "https://github.com/strands-agents/sdk-python/commit/9632ed5", author: pgrayy }
  - { type: other, breaking: false, scope: null, areas: [], title: "Fix additional_args passing in SageMakerAIModel", pr: 983, prUrl: "https://github.com/strands-agents/sdk-python/pull/983", commit: "419de19", commitUrl: "https://github.com/strands-agents/sdk-python/commit/419de19", author: athewsey }
newContributors:
  - { login: KyMidd, pr: 726 }
  - { login: athewsey, pr: 983 }
---
