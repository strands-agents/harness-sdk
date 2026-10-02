---
sdk: sdk
language: python
version: "1.22.0"
tag: python/v1.22.0
date: 2026-01-13
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.22.0
packageUrl: https://pypi.org/project/strands-agents/1.22.0/
entries:
  - { type: docs, breaking: false, scope: null, areas: [agent], title: "update github agent action to reference S3_SESSION_BUCKET", pr: 1418, prUrl: "https://github.com/strands-agents/sdk-python/pull/1418", commit: "695ca66", commitUrl: "https://github.com/strands-agents/sdk-python/commit/695ca66", author: dbschmigelski }
  - { type: feat, breaking: false, scope: null, areas: [agent], title: "provide extra command content as the the prompt to the agent", pr: 1419, prUrl: "https://github.com/strands-agents/sdk-python/pull/1419", commit: "50e5e74", commitUrl: "https://github.com/strands-agents/sdk-python/commit/50e5e74", author: zastrowm }
  - { type: other, breaking: false, scope: null, areas: [mcp], title: "[FEATURE] add MCP resource operations in MCP Tools", pr: 1117, prUrl: "https://github.com/strands-agents/sdk-python/pull/1117", commit: "3bc34ac", commitUrl: "https://github.com/strands-agents/sdk-python/commit/3bc34ac", author: xiehust }
  - { type: fix, breaking: false, scope: null, areas: [], title: "import errors for models with optional imports", pr: 1384, prUrl: "https://github.com/strands-agents/sdk-python/pull/1384", commit: "514f402", commitUrl: "https://github.com/strands-agents/sdk-python/commit/514f402", author: mehtarac }
  - { type: other, breaking: false, scope: null, areas: [], title: "add BidiGeminiLiveModel and BidiOpenAIRealtimeModel to the init", pr: 1383, prUrl: "https://github.com/strands-agents/sdk-python/pull/1383", commit: "9fd22d1", commitUrl: "https://github.com/strands-agents/sdk-python/commit/9fd22d1", author: mehtarac }
  - { type: other, breaking: false, scope: null, areas: [], title: "bidi - async - remove cancelling call", pr: 1357, prUrl: "https://github.com/strands-agents/sdk-python/pull/1357", commit: "2b1cf6b", commitUrl: "https://github.com/strands-agents/sdk-python/commit/2b1cf6b", author: pgrayy }
  - { type: feat, breaking: false, scope: bedrock, areas: [model], title: "add guardrail_latest_message option", pr: 1224, prUrl: "https://github.com/strands-agents/sdk-python/pull/1224", commit: "08bf563", commitUrl: "https://github.com/strands-agents/sdk-python/commit/08bf563", author: aiancheruk }
  - { type: fix, breaking: false, scope: gemini, areas: [model], title: "UnboundLocal Exception Fix", pr: 1420, prUrl: "https://github.com/strands-agents/sdk-python/pull/1420", commit: "1e27d79", commitUrl: "https://github.com/strands-agents/sdk-python/commit/1e27d79", author: emattiza }
  - { type: other, breaking: false, scope: null, areas: [model], title: "fix! Litellm handle non streaming response fix for issue #477", pr: 512, prUrl: "https://github.com/strands-agents/sdk-python/pull/512", commit: "2f04bc0", commitUrl: "https://github.com/strands-agents/sdk-python/commit/2f04bc0", author: schleidl }
  - { type: feat, breaking: false, scope: agent-interface, areas: [agent], title: "introduce AgentBase Protocol as the interface for agent classes to implement", pr: 1126, prUrl: "https://github.com/strands-agents/sdk-python/pull/1126", commit: "0ef2288", commitUrl: "https://github.com/strands-agents/sdk-python/commit/0ef2288", author: awsarron }
  - { type: other, breaking: false, scope: null, areas: [], title: "update pytest requirement from <9.0.0,>=8.0.0 to >=8.0.0,<10.0.0 in the dev-dependencies group", pr: 1161, prUrl: "https://github.com/strands-agents/sdk-python/pull/1161", commit: "10a8e4a", commitUrl: "https://github.com/strands-agents/sdk-python/commit/10a8e4a", author: "dependabot[bot]" }
  - { type: feat, breaking: false, scope: null, areas: [], title: "pass invocation_state to model providers", pr: 1414, prUrl: "https://github.com/strands-agents/sdk-python/pull/1414", commit: "cd6570b", commitUrl: "https://github.com/strands-agents/sdk-python/commit/cd6570b", author: tirth14 }
  - { type: other, breaking: false, scope: null, areas: [], title: "Add Security.md file", pr: 1454, prUrl: "https://github.com/strands-agents/sdk-python/pull/1454", commit: "37d0e47", commitUrl: "https://github.com/strands-agents/sdk-python/commit/37d0e47", author: yonib05 }
  - { type: chore, breaking: false, scope: null, areas: [], title: "Update release notes sop", pr: 1456, prUrl: "https://github.com/strands-agents/sdk-python/pull/1456", commit: "845c6f7", commitUrl: "https://github.com/strands-agents/sdk-python/commit/845c6f7", author: zastrowm }
  - { type: fix, breaking: false, scope: integ, areas: [tool], title: "make calculator tool more robust to LLM output variations", pr: 1445, prUrl: "https://github.com/strands-agents/sdk-python/pull/1445", commit: "3ffc327", commitUrl: "https://github.com/strands-agents/sdk-python/commit/3ffc327", author: cagataycali }
  - { type: fix, breaking: false, scope: null, areas: [mcp], title: "resolve string formatting error in MCP client error handling", pr: 1446, prUrl: "https://github.com/strands-agents/sdk-python/pull/1446", commit: "56676c1", commitUrl: "https://github.com/strands-agents/sdk-python/commit/56676c1", author: cagataycali }
  - { type: other, breaking: false, scope: null, areas: [], title: "bidi - move 3.12 check to nova sonic module", pr: 1439, prUrl: "https://github.com/strands-agents/sdk-python/pull/1439", commit: "318573d", commitUrl: "https://github.com/strands-agents/sdk-python/commit/318573d", author: pgrayy }
  - { type: other, breaking: false, scope: null, areas: [], title: "update sphinx requirement from <9.0.0,>=5.0.0 to >=5.0.0,<10.0.0", pr: 1426, prUrl: "https://github.com/strands-agents/sdk-python/pull/1426", commit: "68257a3", commitUrl: "https://github.com/strands-agents/sdk-python/commit/68257a3", author: "dependabot[bot]" }
  - { type: fix, breaking: false, scope: null, areas: [agent], title: "add concurrency protection to prevent parallel invocations from corrupting agent state", pr: 1453, prUrl: "https://github.com/strands-agents/sdk-python/pull/1453", commit: "0273801", commitUrl: "https://github.com/strands-agents/sdk-python/commit/0273801", author: zastrowm }
  - { type: fix, breaking: false, scope: mcp, areas: [mcp], title: "propagate contextvars to background thread", pr: 1444, prUrl: "https://github.com/strands-agents/sdk-python/pull/1444", commit: "c098b3d", commitUrl: "https://github.com/strands-agents/sdk-python/commit/c098b3d", author: cagataycali }
  - { type: other, breaking: false, scope: null, areas: [], title: "Update to opus 4.5", pr: 1471, prUrl: "https://github.com/strands-agents/sdk-python/pull/1471", commit: "06c3297", commitUrl: "https://github.com/strands-agents/sdk-python/commit/06c3297", author: Unshure }
newContributors:
  - { login: aiancheruk, pr: 1224 }
  - { login: emattiza, pr: 1420 }
  - { login: schleidl, pr: 512 }
  - { login: tirth14, pr: 1414 }
---
