---
sdk: sdk
language: typescript
version: "1.10.0"
tag: typescript/v1.10.0
date: 2026-07-17
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/typescript/v1.10.0
packageUrl: https://www.npmjs.com/package/@strands-agents/sdk/v/1.10.0
entries:
  - { type: other, breaking: false, scope: changelog, areas: [community], title: "sync bot fork with upstream before opening PRs", pr: 3179, prUrl: "https://github.com/strands-agents/harness-sdk/pull/3179", commit: "381091f", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/381091f", author: yonib05 }
  - { type: other, breaking: false, scope: release, areas: [community], title: "trigger changelog sync directly from the release workflows", pr: 3193, prUrl: "https://github.com/strands-agents/harness-sdk/pull/3193", commit: "6a01417", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/6a01417", author: yonib05 }
  - { type: feat, breaking: false, scope: null, areas: [hooks, persistence], title: "add unified storage interface", pr: 3099, prUrl: "https://github.com/strands-agents/harness-sdk/pull/3099", commit: "60fc443", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/60fc443", author: lizradway }
  - { type: feat, breaking: false, scope: null, areas: [otel], title: "added gen_ai_span_attributes_only var to skip event attributes", pr: 3194, prUrl: "https://github.com/strands-agents/harness-sdk/pull/3194", commit: "9dfc2ed", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/9dfc2ed", author: poshinchen }
  - { type: fix, breaking: false, scope: bedrock, areas: [model], title: "place cache point before non-PDF document blocks", pr: 2001, prUrl: "https://github.com/strands-agents/harness-sdk/pull/2001", commit: "beddc3f", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/beddc3f", author: kevmyung }
  - { type: feat, breaking: false, scope: context-offloader, areas: [context, persistence], title: "auto-namespace unified Storage under offloader", pr: 3258, prUrl: "https://github.com/strands-agents/harness-sdk/pull/3258", commit: "d6a2636", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/d6a2636", author: lizradway }
  - { type: refactor, breaking: false, scope: ts, areas: [async, multiagent], title: "extract generic async Queue from multiagent", pr: 3262, prUrl: "https://github.com/strands-agents/harness-sdk/pull/3262", commit: "abd9f07", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/abd9f07", author: gautamsirdeshmukh }
  - { type: other, breaking: false, scope: changelog, areas: [community], title: "guard sync job to upstream; document workflow-scope requirement", pr: 3278, prUrl: "https://github.com/strands-agents/harness-sdk/pull/3278", commit: "37dc28a", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/37dc28a", author: yonib05 }
  - { type: other, breaking: false, scope: null, areas: [community], title: "bump actions/setup-node from 6 to 7", pr: 3229, prUrl: "https://github.com/strands-agents/harness-sdk/pull/3229", commit: "4330a23", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/4330a23", author: "dependabot[bot]" }
  - { type: chore, breaking: false, scope: typescript, areas: [community], title: "remove dead barrel and obsolete types package", pr: 3285, prUrl: "https://github.com/strands-agents/harness-sdk/pull/3285", commit: "d81803b", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/d81803b", author: yonib05 }
  - { type: fix, breaking: false, scope: models/openai, areas: [model], title: "use /openai/v1 Mantle base URL for the Responses API", pr: 3280, prUrl: "https://github.com/strands-agents/harness-sdk/pull/3280", commit: "d1fbd75", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/d1fbd75", author: niklas-palm }
  - { type: docs, breaking: false, scope: null, areas: [], title: "deduplicate pr guidelines summary in sdk agents files", pr: 3293, prUrl: "https://github.com/strands-agents/harness-sdk/pull/3293", commit: "13c4325", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/13c4325", author: yonib05 }
  - { type: docs, breaking: false, scope: typescript, areas: [], title: "deduplicate testing guide and agents file", pr: 3291, prUrl: "https://github.com/strands-agents/harness-sdk/pull/3291", commit: "8a292d9", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/8a292d9", author: yonib05 }
---
