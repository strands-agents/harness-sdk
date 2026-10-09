---
sdk: sdk
language: python
version: "1.6.0"
tag: python/v1.6.0
date: 2025-08-26
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.6.0
packageUrl: https://pypi.org/project/strands-agents/1.6.0/
entries:
  - { type: fix, breaking: false, scope: null, areas: [agent], title: "fix non-serializable parameter of agent from toolUse block", pr: 568, prUrl: "https://github.com/strands-agents/sdk-python/pull/568", commit: "c087f18", commitUrl: "https://github.com/strands-agents/sdk-python/commit/c087f18", author: JackYPCOnline }
  - { type: other, breaking: false, scope: null, areas: [], title: "Add .DS_Store to .gitignore", pr: 681, prUrl: "https://github.com/strands-agents/sdk-python/pull/681", commit: "17ccdd2", commitUrl: "https://github.com/strands-agents/sdk-python/commit/17ccdd2", author: vawsgit }
  - { type: feat, breaking: false, scope: a2a, areas: [a2a], title: "support A2A FileParts and DataParts", pr: 596, prUrl: "https://github.com/strands-agents/sdk-python/pull/596", commit: "ef18a25", commitUrl: "https://github.com/strands-agents/sdk-python/commit/ef18a25", author: jer96 }
  - { type: other, breaking: false, scope: null, areas: [], title: "update pre-commit requirement from <4.2.0,>=3.2.0 to >=3.2.0,<4.4.0", pr: 706, prUrl: "https://github.com/strands-agents/sdk-python/pull/706", commit: "60dcb45", commitUrl: "https://github.com/strands-agents/sdk-python/commit/60dcb45", author: "dependabot[bot]" }
  - { type: other, breaking: false, scope: null, areas: [], title: "update ruff requirement from <0.5.0,>=0.4.4 to >=0.4.4,<0.13.0", pr: 704, prUrl: "https://github.com/strands-agents/sdk-python/pull/704", commit: "b61a064", commitUrl: "https://github.com/strands-agents/sdk-python/commit/b61a064", author: "dependabot[bot]" }
  - { type: other, breaking: false, scope: null, areas: [], title: "update pytest-asyncio requirement from <0.27.0,>=0.26.0 to >=0.26.0,<1.2.0", pr: 708, prUrl: "https://github.com/strands-agents/sdk-python/pull/708", commit: "93d3ac8", commitUrl: "https://github.com/strands-agents/sdk-python/commit/93d3ac8", author: "dependabot[bot]" }
  - { type: fix, breaking: false, scope: null, areas: [], title: "add system_prompt to structured_output_span before adding input_messages", pr: 709, prUrl: "https://github.com/strands-agents/sdk-python/pull/709", commit: "9397f58", commitUrl: "https://github.com/strands-agents/sdk-python/commit/9397f58", author: chengweitsai }
  - { type: feat, breaking: false, scope: multiagent, areas: [multiagent], title: "Add __call__ implementation to MultiAgentBase", pr: 645, prUrl: "https://github.com/strands-agents/sdk-python/pull/645", commit: "6ef6447", commitUrl: "https://github.com/strands-agents/sdk-python/commit/6ef6447", author: mkmeral }
  - { type: chore, breaking: false, scope: null, areas: [], title: "Update pydantic minimum version", pr: 723, prUrl: "https://github.com/strands-agents/sdk-python/pull/723", commit: "e4879e1", commitUrl: "https://github.com/strands-agents/sdk-python/commit/e4879e1", author: mehtarac }
  - { type: other, breaking: false, scope: null, areas: [tool], title: "tool executors", pr: 658, prUrl: "https://github.com/strands-agents/sdk-python/pull/658", commit: "c18ef93", commitUrl: "https://github.com/strands-agents/sdk-python/commit/c18ef93", author: pgrayy }
  - { type: feat, breaking: false, scope: null, areas: [agent], title: "Add support for agent invoke with no input, or Message input", pr: 653, prUrl: "https://github.com/strands-agents/sdk-python/pull/653", commit: "dbe0fea", commitUrl: "https://github.com/strands-agents/sdk-python/commit/dbe0fea", author: Unshure }
  - { type: other, breaking: false, scope: null, areas: [], title: "bump actions/checkout from 4 to 5", pr: 711, prUrl: "https://github.com/strands-agents/sdk-python/pull/711", commit: "b156ea6", commitUrl: "https://github.com/strands-agents/sdk-python/commit/b156ea6", author: "dependabot[bot]" }
  - { type: other, breaking: false, scope: null, areas: [], title: "bump actions/download-artifact from 4 to 5", pr: 712, prUrl: "https://github.com/strands-agents/sdk-python/pull/712", commit: "0283169", commitUrl: "https://github.com/strands-agents/sdk-python/commit/0283169", author: "dependabot[bot]" }
  - { type: other, breaking: false, scope: null, areas: [], title: "update pytest-cov requirement from <5.0.0,>=4.1.0 to >=4.1.0,<7.0.0", pr: 705, prUrl: "https://github.com/strands-agents/sdk-python/pull/705", commit: "e5e308f", commitUrl: "https://github.com/strands-agents/sdk-python/commit/e5e308f", author: "dependabot[bot]" }
  - { type: fix, breaking: false, scope: null, areas: [], title: "prevent path traversal for message_id in file_session_manager", pr: 728, prUrl: "https://github.com/strands-agents/sdk-python/pull/728", commit: "918f094", commitUrl: "https://github.com/strands-agents/sdk-python/commit/918f094", author: mehtarac }
  - { type: fix, breaking: false, scope: null, areas: [], title: "Add AgentInput TypeAlias", pr: 738, prUrl: "https://github.com/strands-agents/sdk-python/pull/738", commit: "f028dc9", commitUrl: "https://github.com/strands-agents/sdk-python/commit/f028dc9", author: Unshure }
  - { type: fix, breaking: false, scope: null, areas: [], title: "Move AgentInput to types submodule", pr: 746, prUrl: "https://github.com/strands-agents/sdk-python/pull/746", commit: "0fac648", commitUrl: "https://github.com/strands-agents/sdk-python/commit/0fac648", author: Unshure }
  - { type: other, breaking: false, scope: null, areas: [], title: "@dependabot[bot] made their first contribution", pr: 706, prUrl: "https://github.com/strands-agents/sdk-python/pull/706", commit: "60dcb45", commitUrl: "https://github.com/strands-agents/sdk-python/commit/60dcb45", author: "dependabot[bot]" }
newContributors:
  - { login: vawsgit, pr: 681 }
  - { login: chengweitsai, pr: 709 }
---
