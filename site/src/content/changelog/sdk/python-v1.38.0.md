---
sdk: sdk
language: python
version: "1.38.0"
tag: python/v1.38.0
date: 2026-04-30
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.38.0
packageUrl: https://pypi.org/project/strands-agents/1.38.0/
entries:
  - { type: feat, breaking: false, scope: mcp, areas: [mcp], title: "preserve CallToolResult.isError flag in MCPToolResult", pr: 2118, prUrl: "https://github.com/strands-agents/sdk-python/pull/2118", commit: "3e08d5e", commitUrl: "https://github.com/strands-agents/sdk-python/commit/3e08d5e", author: Zelys-DFKH }
  - { type: feat, breaking: false, scope: null, areas: [context], title: "add `count_token` method to model with naive estimation using tiktoken", pr: 2031, prUrl: "https://github.com/strands-agents/sdk-python/pull/2031", commit: "5a6df59", commitUrl: "https://github.com/strands-agents/sdk-python/commit/5a6df59", author: lizradway }
  - { type: chore, breaking: false, scope: log, areas: [], title: "added warning for default model awareness and is subject to change", pr: 2164, prUrl: "https://github.com/strands-agents/sdk-python/pull/2164", commit: "4e9ed26", commitUrl: "https://github.com/strands-agents/sdk-python/commit/4e9ed26", author: poshinchen }
  - { type: fix, breaking: false, scope: litellm, areas: [model], title: "forward ttl field from CachePoint in _format_system_messages", pr: 2153, prUrl: "https://github.com/strands-agents/sdk-python/pull/2153", commit: "b207e03", commitUrl: "https://github.com/strands-agents/sdk-python/commit/b207e03", author: ElliottJW }
  - { type: fix, breaking: false, scope: skills, areas: [], title: "preserve cache points in system prompt during skills inj…", pr: 2134, prUrl: "https://github.com/strands-agents/sdk-python/pull/2134", commit: "2eaff9c", commitUrl: "https://github.com/strands-agents/sdk-python/commit/2eaff9c", author: mattdai01 }
  - { type: fix, breaking: false, scope: ollama, areas: [model], title: "generate unique toolUseId instead of reusing tool name", pr: 2053, prUrl: "https://github.com/strands-agents/sdk-python/pull/2053", commit: "513e67d", commitUrl: "https://github.com/strands-agents/sdk-python/commit/513e67d", author: Ratansairohith }
  - { type: feat, breaking: false, scope: cache, areas: [], title: "add TTL support to CachePoint for prompt caching", pr: 1660, prUrl: "https://github.com/strands-agents/sdk-python/pull/1660", commit: "da4c44e", commitUrl: "https://github.com/strands-agents/sdk-python/commit/da4c44e", author: kpx-dev }
  - { type: fix, breaking: false, scope: null, areas: [], title: "use non-interactive flag for Nova Sonic history and system promp…", pr: 2188, prUrl: "https://github.com/strands-agents/sdk-python/pull/2188", commit: "22b3aaf", commitUrl: "https://github.com/strands-agents/sdk-python/commit/22b3aaf", author: prettyprettyprettygood }
  - { type: other, breaking: false, scope: null, areas: [model], title: "update litellm requirement from <=1.82.6,>=1.75.9 to >=1.75.9,<=1.83.13", pr: 2197, prUrl: "https://github.com/strands-agents/sdk-python/pull/2197", commit: "609723a", commitUrl: "https://github.com/strands-agents/sdk-python/commit/609723a", author: "dependabot[bot]" }
  - { type: other, breaking: false, scope: null, areas: [], title: "update pre-commit requirement from <4.6.0,>=3.2.0 to >=3.2.0,<4.7.0", pr: 2185, prUrl: "https://github.com/strands-agents/sdk-python/pull/2185", commit: "5b6aa56", commitUrl: "https://github.com/strands-agents/sdk-python/commit/5b6aa56", author: "dependabot[bot]" }
  - { type: feat, breaking: false, scope: null, areas: [tool], title: "large tool result offload", pr: 2162, prUrl: "https://github.com/strands-agents/sdk-python/pull/2162", commit: "33b25cb", commitUrl: "https://github.com/strands-agents/sdk-python/commit/33b25cb", author: lizradway }
  - { type: feat, breaking: false, scope: null, areas: [], title: "override count_tokens with native token counting for supported providers", pr: 2189, prUrl: "https://github.com/strands-agents/sdk-python/pull/2189", commit: "a49dc33", commitUrl: "https://github.com/strands-agents/sdk-python/commit/a49dc33", author: opieter-aws }
  - { type: fix, breaking: false, scope: bedrock, areas: [model], title: "upgrade default model to Claude Sonnet 4.5", pr: 2193, prUrl: "https://github.com/strands-agents/sdk-python/pull/2193", commit: "ce64c3a", commitUrl: "https://github.com/strands-agents/sdk-python/commit/ce64c3a", author: afarntrog }
  - { type: chore, breaking: false, scope: null, areas: [tool], title: "update style guide for tool spec navigation", pr: 2203, prUrl: "https://github.com/strands-agents/sdk-python/pull/2203", commit: "b340dc4", commitUrl: "https://github.com/strands-agents/sdk-python/commit/b340dc4", author: lizradway }
  - { type: feat, breaking: false, scope: null, areas: [], title: "add ProviderTokenCountError for native token counting failures", pr: 2211, prUrl: "https://github.com/strands-agents/sdk-python/pull/2211", commit: "009374f", commitUrl: "https://github.com/strands-agents/sdk-python/commit/009374f", author: opieter-aws }
  - { type: fix, breaking: false, scope: conversation-manager, areas: [], title: "handle window_size=0 and reject negative values", pr: 2208, prUrl: "https://github.com/strands-agents/sdk-python/pull/2208", commit: "bab08db", commitUrl: "https://github.com/strands-agents/sdk-python/commit/bab08db", author: SuperMarioYL }
  - { type: fix, breaking: false, scope: null, areas: [], title: "change token counting fallback log from warning to debug", pr: 2220, prUrl: "https://github.com/strands-agents/sdk-python/pull/2220", commit: "52cdb9d", commitUrl: "https://github.com/strands-agents/sdk-python/commit/52cdb9d", author: opieter-aws }
  - { type: fix, breaking: false, scope: null, areas: [tool], title: "do not synthesize exception for cancelled tools", pr: 2106, prUrl: "https://github.com/strands-agents/sdk-python/pull/2106", commit: "e12ac9d", commitUrl: "https://github.com/strands-agents/sdk-python/commit/e12ac9d", author: Gastly }
  - { type: feat, breaking: false, scope: null, areas: [], title: "estimate input tokens before model calls", pr: 2221, prUrl: "https://github.com/strands-agents/sdk-python/pull/2221", commit: "888c98c", commitUrl: "https://github.com/strands-agents/sdk-python/commit/888c98c", author: opieter-aws }
  - { type: feat, breaking: false, scope: offloader, areas: [], title: "return explicit paths in preview and auto-enable retrieval", pr: 2222, prUrl: "https://github.com/strands-agents/sdk-python/pull/2222", commit: "e88b276", commitUrl: "https://github.com/strands-agents/sdk-python/commit/e88b276", author: lizradway }
  - { type: fix, breaking: false, scope: null, areas: [], title: "update tests to use non-EOL'd model", pr: 2226, prUrl: "https://github.com/strands-agents/sdk-python/pull/2226", commit: "771a86a", commitUrl: "https://github.com/strands-agents/sdk-python/commit/771a86a", author: zastrowm }
  - { type: feat, breaking: false, scope: bedrock, areas: [model], title: "add strict_tools config with auto-inject of additional…", pr: 2213, prUrl: "https://github.com/strands-agents/sdk-python/pull/2213", commit: "6e208a8", commitUrl: "https://github.com/strands-agents/sdk-python/commit/6e208a8", author: kaghatim }
newContributors:
  - { login: Zelys-DFKH, pr: 2118 }
  - { login: ElliottJW, pr: 2153 }
  - { login: Ratansairohith, pr: 2053 }
  - { login: kpx-dev, pr: 1660 }
  - { login: prettyprettyprettygood, pr: 2188 }
  - { login: SuperMarioYL, pr: 2208 }
  - { login: Gastly, pr: 2106 }
  - { login: kaghatim, pr: 2213 }
---
