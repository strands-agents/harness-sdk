---
sdk: sdk
language: python
version: "1.18.0"
tag: python/v1.18.0
date: 2025-11-21
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.18.0
packageUrl: https://pypi.org/project/strands-agents/1.18.0/
entries:
  - { type: other, breaking: false, scope: null, areas: [agent], title: "multi agent input", pr: 1196, prUrl: "https://github.com/strands-agents/sdk-python/pull/1196", commit: "ab5f8ee", commitUrl: "https://github.com/strands-agents/sdk-python/commit/ab5f8ee", author: pgrayy }
  - { type: other, breaking: false, scope: null, areas: [context], title: "interrupt - activate - set context separately", pr: 1194, prUrl: "https://github.com/strands-agents/sdk-python/pull/1194", commit: "432d269", commitUrl: "https://github.com/strands-agents/sdk-python/commit/432d269", author: pgrayy }
  - { type: other, breaking: false, scope: null, areas: [], title: "In PrintingCallbackHandler, make the verbose description and counting…", pr: 1211, prUrl: "https://github.com/strands-agents/sdk-python/pull/1211", commit: "fb8a861", commitUrl: "https://github.com/strands-agents/sdk-python/commit/fb8a861", author: marcbrooker }
  - { type: fix, breaking: false, scope: null, areas: [multiagent], title: "fix swarm session management integ test.", pr: 1155, prUrl: "https://github.com/strands-agents/sdk-python/pull/1155", commit: "f554cca", commitUrl: "https://github.com/strands-agents/sdk-python/commit/f554cca", author: JackYPCOnline }
  - { type: other, breaking: false, scope: null, areas: [tool], title: "move tool caller definition out of agent module", pr: 1215, prUrl: "https://github.com/strands-agents/sdk-python/pull/1215", commit: "a4837d4", commitUrl: "https://github.com/strands-agents/sdk-python/commit/a4837d4", author: pgrayy }
  - { type: other, breaking: false, scope: null, areas: [hooks], title: "interrupt - interruptible multi agent hook interface", pr: 1207, prUrl: "https://github.com/strands-agents/sdk-python/pull/1207", commit: "93997f0", commitUrl: "https://github.com/strands-agents/sdk-python/commit/93997f0", author: pgrayy }
  - { type: other, breaking: false, scope: null, areas: [tool], title: "security(tool_loader): prevent tool name and sys modules collisions i…", pr: 1214, prUrl: "https://github.com/strands-agents/sdk-python/pull/1214", commit: "87e0f34", commitUrl: "https://github.com/strands-agents/sdk-python/commit/87e0f34", author: dbschmigelski }
  - { type: fix, breaking: false, scope: mcp, areas: [mcp], title: "protect connection on non-fatal client side timeout error", pr: 1231, prUrl: "https://github.com/strands-agents/sdk-python/pull/1231", commit: "efeba7b", commitUrl: "https://github.com/strands-agents/sdk-python/commit/efeba7b", author: dbschmigelski }
  - { type: fix, breaking: false, scope: litellm, areas: [model], title: "populate cacheWriteInputTokens from cache_creation_input_token not cache_creation_tokens", pr: 1233, prUrl: "https://github.com/strands-agents/sdk-python/pull/1233", commit: "3efc9c0", commitUrl: "https://github.com/strands-agents/sdk-python/commit/3efc9c0", author: dbschmigelski }
  - { type: fix, breaking: false, scope: null, areas: [mcp], title: "fix integ test for mcp elicitation_server", pr: 1234, prUrl: "https://github.com/strands-agents/sdk-python/pull/1234", commit: "eaa6efb", commitUrl: "https://github.com/strands-agents/sdk-python/commit/eaa6efb", author: JackYPCOnline }
newContributors:
  - { login: marcbrooker, pr: 1211 }
---
