---
sdk: sdk
language: python
version: "1.16.0"
tag: python/v1.16.0
date: 2025-11-12
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.16.0
packageUrl: https://pypi.org/project/strands-agents/1.16.0/
entries:
  - { type: fix, breaking: false, scope: models/gemini, areas: [model], title: "handle non-JSON error messages from Gemini API", pr: 1062, prUrl: "https://github.com/strands-agents/sdk-python/pull/1062", commit: "89bab98", commitUrl: "https://github.com/strands-agents/sdk-python/commit/89bab98", author: Ratish1 }
  - { type: fix, breaking: false, scope: null, areas: [model], title: "Handle \"prompt is too long\" from Anthropic", pr: 1137, prUrl: "https://github.com/strands-agents/sdk-python/pull/1137", commit: "e844b30", commitUrl: "https://github.com/strands-agents/sdk-python/commit/e844b30", author: zastrowm }
  - { type: feat, breaking: false, scope: telemetry, areas: [otel], title: "Add tool definitions to traces via semconv opt-in", pr: 1113, prUrl: "https://github.com/strands-agents/sdk-python/pull/1113", commit: "1df45be", commitUrl: "https://github.com/strands-agents/sdk-python/commit/1df45be", author: Ratish1 }
  - { type: fix, breaking: false, scope: null, areas: [], title: "Strip argument sections out of inputSpec top-level description", pr: 1142, prUrl: "https://github.com/strands-agents/sdk-python/pull/1142", commit: "28fea41", commitUrl: "https://github.com/strands-agents/sdk-python/commit/28fea41", author: zastrowm }
  - { type: other, breaking: false, scope: null, areas: [context], title: "share thread context", pr: 1146, prUrl: "https://github.com/strands-agents/sdk-python/pull/1146", commit: "c250fc0", commitUrl: "https://github.com/strands-agents/sdk-python/commit/c250fc0", author: pgrayy }
  - { type: other, breaking: false, scope: null, areas: [hooks], title: "async hooks", pr: 1119, prUrl: "https://github.com/strands-agents/sdk-python/pull/1119", commit: "2b0c6e6", commitUrl: "https://github.com/strands-agents/sdk-python/commit/2b0c6e6", author: pgrayy }
  - { type: feat, breaking: false, scope: tools, areas: [tool], title: "Support string descriptions in Annotated parameters", pr: 1089, prUrl: "https://github.com/strands-agents/sdk-python/pull/1089", commit: "3061116", commitUrl: "https://github.com/strands-agents/sdk-python/commit/3061116", author: Ratish1 }
  - { type: chore, breaking: false, scope: telemetry, areas: [otel], title: "updated opt-in attributes to internal", pr: 1152, prUrl: "https://github.com/strands-agents/sdk-python/pull/1152", commit: "e930243", commitUrl: "https://github.com/strands-agents/sdk-python/commit/e930243", author: poshinchen }
  - { type: feat, breaking: false, scope: models, areas: [model], title: "allow SystemContentBlocks in LiteLLMModel", pr: 1141, prUrl: "https://github.com/strands-agents/sdk-python/pull/1141", commit: "bbe765d", commitUrl: "https://github.com/strands-agents/sdk-python/commit/bbe765d", author: dbschmigelski }
  - { type: other, breaking: false, scope: null, areas: [], title: "share interrupt state", pr: 1148, prUrl: "https://github.com/strands-agents/sdk-python/pull/1148", commit: "ccc3a8b", commitUrl: "https://github.com/strands-agents/sdk-python/commit/ccc3a8b", author: pgrayy }
  - { type: fix, breaking: false, scope: null, areas: [mcp], title: "Don't hang when MCP server returns 5xx", pr: 1169, prUrl: "https://github.com/strands-agents/sdk-python/pull/1169", commit: "57e2081", commitUrl: "https://github.com/strands-agents/sdk-python/commit/57e2081", author: zastrowm }
  - { type: fix, breaking: false, scope: models, areas: [model], title: "allow setter on system_prompt and system_prompt_content", pr: 1171, prUrl: "https://github.com/strands-agents/sdk-python/pull/1171", commit: "8cae18c", commitUrl: "https://github.com/strands-agents/sdk-python/commit/8cae18c", author: dbschmigelski }
---
