---
sdk: sdk
language: python
version: "1.50.2"
tag: python/v1.50.2
date: 2026-07-27
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.50.2
packageUrl: https://pypi.org/project/strands-agents/1.50.2/
entries:
  - { type: feat, breaking: false, scope: python, areas: [mcp, hil], title: "add per-call MCP tool cancellation", pr: 3402, prUrl: "https://github.com/strands-agents/harness-sdk/pull/3402", commit: "67693b7", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/67693b7", author: strandly-the-agent }
  - { type: chore, breaking: false, scope: bidi, areas: [model, bidirectional-streaming], title: "bump google-genai floor to >=1.67.0", pr: 3478, prUrl: "https://github.com/strands-agents/harness-sdk/pull/3478", commit: "ec1c0db", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/ec1c0db", author: mehtarac }
  - { type: fix, breaking: false, scope: bidi, areas: [model, bidirectional-streaming], title: "gemini live mp to use updated api", pr: 3424, prUrl: "https://github.com/strands-agents/harness-sdk/pull/3424", commit: "1531f73", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/1531f73", author: mehtarac }
  - { type: fix, breaking: false, scope: mcp, areas: [mcp], title: "deduplicate inverted-index postings", pr: 3417, prUrl: "https://github.com/strands-agents/harness-sdk/pull/3417", commit: "0e517d6", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/0e517d6", author: March-77 }
  - { type: fix, breaking: false, scope: streaming, areas: [model, agent], title: "consume reasoning signature per content block", pr: 3472, prUrl: "https://github.com/strands-agents/harness-sdk/pull/3472", commit: "be30def", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/be30def", author: arielnabavian }
  - { type: docs, breaking: false, scope: mcp, areas: [mcp], title: "correct search tool contracts", pr: 3456, prUrl: "https://github.com/strands-agents/harness-sdk/pull/3456", commit: "50b583f", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/50b583f", author: March-77 }
  - { type: feat, breaking: false, scope: null, areas: [context], title: "add context manager class design doc", pr: 3307, prUrl: "https://github.com/strands-agents/harness-sdk/pull/3307", commit: "cb3bffb", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/cb3bffb", author: lizradway }
  - { type: chore, breaking: false, scope: null, areas: [persistence], title: "update context offloader comments to deprecate legacy storage", pr: 3476, prUrl: "https://github.com/strands-agents/harness-sdk/pull/3476", commit: "58a501c", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/58a501c", author: lizradway }
  - { type: fix, breaking: false, scope: context, areas: [persistence], title: "legacy file storage accepts bare filenames and stems", pr: 3495, prUrl: "https://github.com/strands-agents/harness-sdk/pull/3495", commit: "2828e44", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/2828e44", author: lizradway }
  - { type: refactor, breaking: false, scope: http_request, areas: [devx, tool], title: "remove security features, accept httpx.AsyncClient", pr: 3491, prUrl: "https://github.com/strands-agents/harness-sdk/pull/3491", commit: "fa63da5", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/fa63da5", author: Unshure }
---
