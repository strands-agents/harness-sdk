---
sdk: sdk
language: typescript
version: "1.18.0"
tag: typescript/v1.18.0
date: 2026-09-15
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/typescript/v1.18.0
packageUrl: https://www.npmjs.com/package/@strands-agents/sdk/v/1.18.0
entries:
  - { type: fix, breaking: false, scope: openai, areas: [model], title: "emit tool results before user text to preserve tool_use/tool_result adjacency", pr: 4234, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4234", commit: "5f636bb", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/5f636bb", author: opieter-aws }
  - { type: fix, breaking: false, scope: context, areas: [context], title: "fix various context manager parity items", pr: 4228, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4228", commit: "bebf3e8", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/bebf3e8", author: lizradway }
  - { type: feat, breaking: false, scope: vended-tools, areas: [tool, server], title: "include exit_code in shell tool result", pr: 4269, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4269", commit: "1efa1ee", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/1efa1ee", author: strandly-the-agent }
  - { type: fix, breaking: false, scope: models, areas: [model], title: "route Bedrock Mantle openai.gpt-6-* to /openai/v1", pr: 4267, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4267", commit: "056f325", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/056f325", author: strandly-the-agent }
  - { type: feat, breaking: false, scope: null, areas: [model, sessions], title: "automatically use openAI prompt-cache keys from session id", pr: 4083, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4083", commit: "7462908", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/7462908", author: opieter-aws }
  - { type: feat, breaking: false, scope: vended-tools, areas: [tool], title: "add web_fetch tool for TypeScript", pr: 4153, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4153", commit: "f800228", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/f800228", author: liramon2 }
  - { type: docs, breaking: false, scope: null, areas: [], title: "ai usage reflection blog", pr: 4148, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4148", commit: "1ede04b", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/1ede04b", author: Unshure }
  - { type: feat, breaking: false, scope: context-ts, areas: [context, language], title: "add context strategy presets + rewire defaults to use class", pr: 4256, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4256", commit: "a8b1b90", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/a8b1b90", author: lizradway }
  - { type: feat, breaking: false, scope: vended-tools, areas: [tool], title: "port Python notebook improvements to TS", pr: 4281, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4281", commit: "6c79888", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/6c79888", author: liramon2 }
  - { type: feat, breaking: false, scope: sandbox, areas: [tool, server], title: "include partial output in shell timeout errors", pr: 4325, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4325", commit: "bd4020f", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/bd4020f", author: strandly-the-agent }
  - { type: feat, breaking: false, scope: storage, areas: [persistence], title: "add bm25 search strategy", pr: 4079, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4079", commit: "495d154", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/495d154", author: lizradway }
---
