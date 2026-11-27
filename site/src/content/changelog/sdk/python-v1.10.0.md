---
sdk: sdk
language: python
version: "1.10.0"
tag: python/v1.10.0
date: 2025-09-29
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.10.0
packageUrl: https://pypi.org/project/strands-agents/1.10.0/
entries:
  - { type: feat, breaking: false, scope: null, areas: [tool], title: "add optional outputSchema support for tool specifications", pr: 818, prUrl: "https://github.com/strands-agents/sdk-python/pull/818", commit: "6ea8f72", commitUrl: "https://github.com/strands-agents/sdk-python/commit/6ea8f72", author: vamgan }
  - { type: feat, breaking: false, scope: null, areas: [model], title: "add Gemini model provider", pr: 725, prUrl: "https://github.com/strands-agents/sdk-python/pull/725", commit: "54bc162", commitUrl: "https://github.com/strands-agents/sdk-python/commit/54bc162", author: notgitika }
  - { type: other, breaking: false, scope: null, areas: [model], title: "Improve OpenAI error handling", pr: 918, prUrl: "https://github.com/strands-agents/sdk-python/pull/918", commit: "f5e2070", commitUrl: "https://github.com/strands-agents/sdk-python/commit/f5e2070", author: mkmeral }
  - { type: other, breaking: false, scope: null, areas: [], title: "update sphinx-autodoc-typehints requirement from <2.0.0,>=1.12.0 to >=1.12.0,<4.0.0", pr: 903, prUrl: "https://github.com/strands-agents/sdk-python/pull/903", commit: "d1536b9", commitUrl: "https://github.com/strands-agents/sdk-python/commit/d1536b9", author: "dependabot[bot]" }
  - { type: other, breaking: false, scope: null, areas: [], title: "update sphinx requirement from <6.0.0,>=5.0.0 to >=5.0.0,<9.0.0", pr: 904, prUrl: "https://github.com/strands-agents/sdk-python/pull/904", commit: "fac0757", commitUrl: "https://github.com/strands-agents/sdk-python/commit/fac0757", author: "dependabot[bot]" }
  - { type: other, breaking: false, scope: null, areas: [model], title: "update openai requirement from <1.108.0,>=1.68.0 to >=1.68.0,<1.110.0", pr: 916, prUrl: "https://github.com/strands-agents/sdk-python/pull/916", commit: "c857970", commitUrl: "https://github.com/strands-agents/sdk-python/commit/c857970", author: "dependabot[bot]" }
  - { type: other, breaking: false, scope: null, areas: [], title: "update pytest-asyncio requirement from <1.2.0,>=1.0.0 to >=1.0.0,<1.3.0", pr: 861, prUrl: "https://github.com/strands-agents/sdk-python/pull/861", commit: "01d8fac", commitUrl: "https://github.com/strands-agents/sdk-python/commit/01d8fac", author: "dependabot[bot]" }
  - { type: fix, breaking: false, scope: gemini, areas: [model], title: "Fix event loop closed error from Gemini asyncio", pr: 932, prUrl: "https://github.com/strands-agents/sdk-python/pull/932", commit: "439653d", commitUrl: "https://github.com/strands-agents/sdk-python/commit/439653d", author: mkmeral }
  - { type: fix, breaking: false, scope: null, areas: [mcp], title: "Fix mcp timeout issue", pr: 922, prUrl: "https://github.com/strands-agents/sdk-python/pull/922", commit: "04669d8", commitUrl: "https://github.com/strands-agents/sdk-python/commit/04669d8", author: Unshure }
  - { type: feat, breaking: false, scope: null, areas: [], title: "add supports_hot_reload property to PythonAgentTool", pr: 928, prUrl: "https://github.com/strands-agents/sdk-python/pull/928", commit: "ecd9eab", commitUrl: "https://github.com/strands-agents/sdk-python/commit/ecd9eab", author: cagataycali }
  - { type: feat, breaking: false, scope: hooks, areas: [hooks], title: "Mark ModelCall and ToolCall events as non-experimental", pr: 926, prUrl: "https://github.com/strands-agents/sdk-python/pull/926", commit: "99cd49b", commitUrl: "https://github.com/strands-agents/sdk-python/commit/99cd49b", author: zastrowm }
  - { type: feat, breaking: false, scope: null, areas: [multiagent], title: "Create a new HookEvent for Multiagent", pr: 925, prUrl: "https://github.com/strands-agents/sdk-python/pull/925", commit: "eef11cc", commitUrl: "https://github.com/strands-agents/sdk-python/commit/eef11cc", author: JackYPCOnline }
newContributors:
  - { login: notgitika, pr: 725 }
---
