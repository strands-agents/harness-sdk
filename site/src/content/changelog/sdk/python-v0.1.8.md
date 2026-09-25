---
sdk: sdk
language: python
version: "0.1.8"
tag: python/v0.1.8
date: 2025-06-18
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v0.1.8
packageUrl: https://pypi.org/project/strands-agents/0.1.8/
entries:
  - { type: fix, breaking: false, scope: null, areas: [], title: "Enable underscores in direct method invocations to match hyphens", pr: 178, prUrl: "https://github.com/strands-agents/sdk-python/pull/178", commit: "aff928c", commitUrl: "https://github.com/strands-agents/sdk-python/commit/aff928c", author: zastrowm }
  - { type: feat, breaking: false, scope: null, areas: [], title: "implement summarizing conversation manager", pr: 112, prUrl: "https://github.com/strands-agents/sdk-python/pull/112", commit: "c28737c", commitUrl: "https://github.com/strands-agents/sdk-python/commit/c28737c", author: stefanoamorelli }
  - { type: chore, breaking: false, scope: null, areas: [], title: "moved truncation logic to conversation manager and added should_truncate_results", pr: 192, prUrl: "https://github.com/strands-agents/sdk-python/pull/192", commit: "7c7f91e", commitUrl: "https://github.com/strands-agents/sdk-python/commit/7c7f91e", author: poshinchen }
  - { type: refactor, breaking: false, scope: null, areas: [tool], title: "Disallow similar tool names in the tool registry", pr: 193, prUrl: "https://github.com/strands-agents/sdk-python/pull/193", commit: "264f511", commitUrl: "https://github.com/strands-agents/sdk-python/commit/264f511", author: zastrowm }
  - { type: other, breaking: false, scope: null, areas: [], title: "add integration test workflow", pr: 201, prUrl: "https://github.com/strands-agents/sdk-python/pull/201", commit: "4b44410", commitUrl: "https://github.com/strands-agents/sdk-python/commit/4b44410", author: dbschmigelski }
  - { type: fix, breaking: false, scope: null, areas: [model], title: "add inference profile to litellm test and remove ownership check…", pr: 209, prUrl: "https://github.com/strands-agents/sdk-python/pull/209", commit: "7c5f7a7", commitUrl: "https://github.com/strands-agents/sdk-python/commit/7c5f7a7", author: dbschmigelski }
  - { type: chore, breaking: false, scope: null, areas: [agent], title: "allow custom tracer provider to Agent", pr: 207, prUrl: "https://github.com/strands-agents/sdk-python/pull/207", commit: "68740c5", commitUrl: "https://github.com/strands-agents/sdk-python/commit/68740c5", author: poshinchen }
  - { type: other, breaking: false, scope: a2a, areas: [a2a], title: "add a2a deps and mitigate otel conflict", pr: 232, prUrl: "https://github.com/strands-agents/sdk-python/pull/232", commit: "5fab010", commitUrl: "https://github.com/strands-agents/sdk-python/commit/5fab010", author: jer96 }
  - { type: chore, breaking: false, scope: otel, areas: [otel], title: "raise exception if exporter unavailable", pr: 234, prUrl: "https://github.com/strands-agents/sdk-python/pull/234", commit: "e12bc2f", commitUrl: "https://github.com/strands-agents/sdk-python/commit/e12bc2f", author: jer96 }
  - { type: fix, breaking: false, scope: null, areas: [], title: "Update PR Integration Test Workflow", pr: 237, prUrl: "https://github.com/strands-agents/sdk-python/pull/237", commit: "756a027", commitUrl: "https://github.com/strands-agents/sdk-python/commit/756a027", author: AdnaneKhan }
  - { type: fix, breaking: false, scope: null, areas: [], title: "remove unused dependency swagger-parser", pr: 220, prUrl: "https://github.com/strands-agents/sdk-python/pull/220", commit: "4dd0819", commitUrl: "https://github.com/strands-agents/sdk-python/commit/4dd0819", author: zastrowm }
  - { type: fix, breaking: false, scope: null, areas: [], title: "Update throttling logic to use exponential back-off", pr: 223, prUrl: "https://github.com/strands-agents/sdk-python/pull/223", commit: "52c68aa", commitUrl: "https://github.com/strands-agents/sdk-python/commit/52c68aa", author: zastrowm }
  - { type: feat, breaking: false, scope: null, areas: [], title: "Simplify contribution template + pr scripts to run", pr: 221, prUrl: "https://github.com/strands-agents/sdk-python/pull/221", commit: "eb50073", commitUrl: "https://github.com/strands-agents/sdk-python/commit/eb50073", author: zastrowm }
  - { type: other, breaking: false, scope: null, areas: [], title: "docstring parser", pr: 239, prUrl: "https://github.com/strands-agents/sdk-python/pull/239", commit: "cc5be12", commitUrl: "https://github.com/strands-agents/sdk-python/commit/cc5be12", author: dbschmigelski }
newContributors:
  - { login: stefanoamorelli, pr: 112 }
  - { login: poshinchen, pr: 192 }
  - { login: jer96, pr: 232 }
  - { login: AdnaneKhan, pr: 237 }
---
