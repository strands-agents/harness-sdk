---
sdk: harness
language: python
version: "0.6.0"
tag: harness-python/v0.6.0
date: 2026-11-27
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/harness-python/v0.6.0
packageUrl: https://pypi.org/project/strands-harness/0.6.0/
entries:
  - { type: refactor, breaking: true, scope: harness, areas: [tool, harness], title: "use the SDK's vended subagent tool", pr: 6088, prUrl: "https://github.com/strands-agents/harness-sdk/pull/6088", commit: "d6c5fae", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/d6c5fae", author: strandly-the-agent }
  - { type: other, breaking: false, scope: null, areas: [community], title: "bump astral-sh/setup-uv from 10.0.1 to 10.4.0", pr: 6473, prUrl: "https://github.com/strands-agents/harness-sdk/pull/6473", commit: "0ddcc98", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/0ddcc98", author: "dependabot[bot]" }
  - { type: fix, breaking: false, scope: model-info, areas: [model], title: "resolve OpenAI dated snapshot ids to their model", pr: 6497, prUrl: "https://github.com/strands-agents/harness-sdk/pull/6497", commit: "fe877e2", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/fe877e2", author: JackYPCOnline }
  - { type: test, breaking: false, scope: harness, areas: [model, harness], title: "drop the dated OpenAI id from the SDK parity tests, with a TODO", pr: 6507, prUrl: "https://github.com/strands-agents/harness-sdk/pull/6507", commit: "0bfacb1", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/0bfacb1", author: JackYPCOnline }
  - { type: feat, breaking: false, scope: site, areas: [], title: "click to zoom docs images", pr: 6529, prUrl: "https://github.com/strands-agents/harness-sdk/pull/6529", commit: "199ff4c", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/199ff4c", author: zastrowm }
  - { type: feat, breaking: true, scope: context-manager, areas: [context], title: "graduate out of experimental and rename stash to archive (python)", pr: 6509, prUrl: "https://github.com/strands-agents/harness-sdk/pull/6509", commit: "f055982", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/f055982", author: lizradway }
  - { type: feat, breaking: false, scope: site, areas: [], title: "centred docs layout with automatically wider tables and images", pr: 6439, prUrl: "https://github.com/strands-agents/harness-sdk/pull/6439", commit: "887a14c", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/887a14c", author: zastrowm }
  - { type: fix, breaking: false, scope: docs, areas: [], title: "fetch upstream content from main", pr: 6485, prUrl: "https://github.com/strands-agents/harness-sdk/pull/6485", commit: "acad9d7", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/acad9d7", author: tmoreton }
  - { type: feat, breaking: true, scope: harness, areas: [async, harness], title: "use manage_background_task by default", pr: 6528, prUrl: "https://github.com/strands-agents/harness-sdk/pull/6528", commit: "d77ebb8", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/d77ebb8", author: gautamsirdeshmukh }
  - { type: docs, breaking: false, scope: background-tasks, areas: [harness], title: "document SDK lifecycle and harness defaults", pr: 6534, prUrl: "https://github.com/strands-agents/harness-sdk/pull/6534", commit: "8de6bce", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/8de6bce", author: gautamsirdeshmukh }
  - { type: docs, breaking: false, scope: team, areas: [community], title: "add DEFAULTS.md, the bar for changing default behavior", pr: 6318, prUrl: "https://github.com/strands-agents/harness-sdk/pull/6318", commit: "f8964be", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/f8964be", author: lizradway }
---
