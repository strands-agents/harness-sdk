---
sdk: sdk
language: python
version: "1.34.0"
tag: python/v1.34.0
date: 2026-03-31
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.34.0
packageUrl: https://pypi.org/project/strands-agents/1.34.0/
entries:
  - { type: chore, breaking: false, scope: null, areas: [], title: "remove Cohere from required integ test providers", pr: 1967, prUrl: "https://github.com/strands-agents/sdk-python/pull/1967", commit: "a110149", commitUrl: "https://github.com/strands-agents/sdk-python/commit/a110149", author: zastrowm }
  - { type: feat, breaking: false, scope: null, areas: [], title: "add AgentAsTool", pr: 1932, prUrl: "https://github.com/strands-agents/sdk-python/pull/1932", commit: "6a35add", commitUrl: "https://github.com/strands-agents/sdk-python/commit/6a35add", author: notowen333 }
  - { type: feat, breaking: false, scope: null, areas: [tool], title: "auto-wrap Agent instances passed in tools list", pr: 1997, prUrl: "https://github.com/strands-agents/sdk-python/pull/1997", commit: "521c4d7", commitUrl: "https://github.com/strands-agents/sdk-python/commit/521c4d7", author: agent-of-mkmeral }
  - { type: feat, breaking: false, scope: telemetry, areas: [otel], title: "emit system prompt on chat spans per GenAI semconv", pr: 1818, prUrl: "https://github.com/strands-agents/sdk-python/pull/1818", commit: "194c69b", commitUrl: "https://github.com/strands-agents/sdk-python/commit/194c69b", author: sanjeed5 }
  - { type: feat, breaking: false, scope: mcp, areas: [mcp], title: "add support for MCP elicitation -32042 error handling", pr: 1745, prUrl: "https://github.com/strands-agents/sdk-python/pull/1745", commit: "e2b6036", commitUrl: "https://github.com/strands-agents/sdk-python/commit/e2b6036", author: Christian-kam }
  - { type: fix, breaking: false, scope: null, areas: [model], title: "ollama input/output token count", pr: 2008, prUrl: "https://github.com/strands-agents/sdk-python/pull/2008", commit: "424224d", commitUrl: "https://github.com/strands-agents/sdk-python/commit/424224d", author: lizradway }
  - { type: feat, breaking: false, scope: null, areas: [], title: "add stateful model support for server-side conversation management", pr: 2004, prUrl: "https://github.com/strands-agents/sdk-python/pull/2004", commit: "ae19308", commitUrl: "https://github.com/strands-agents/sdk-python/commit/ae19308", author: pgrayy }
  - { type: feat, breaking: false, scope: null, areas: [model], title: "add built-in tool support for OpenAI Responses API", pr: 2011, prUrl: "https://github.com/strands-agents/sdk-python/pull/2011", commit: "de9b149", commitUrl: "https://github.com/strands-agents/sdk-python/commit/de9b149", author: pgrayy }
  - { type: fix, breaking: false, scope: null, areas: [], title: "handle reasoning content in OpenAIResponsesModel request formatting", pr: 2013, prUrl: "https://github.com/strands-agents/sdk-python/pull/2013", commit: "e267a64", commitUrl: "https://github.com/strands-agents/sdk-python/commit/e267a64", author: pgrayy }
newContributors:
  - { login: sanjeed5, pr: 1818 }
  - { login: Christian-kam, pr: 1745 }
---
