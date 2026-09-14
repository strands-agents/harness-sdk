---
sdk: harness
language: typescript
version: "1.16.0"
tag: typescript/v1.16.0
date: 2026-08-31
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/typescript/v1.16.0
packageUrl: https://www.npmjs.com/package/@strands-agents/sdk/v/1.16.0
entries:
  - { type: feat, breaking: false, scope: ts, areas: [async, multiagent], title: "add internal BackgroundTaskManager interface + InProcessTaskManager impl", pr: 3876, prUrl: "https://github.com/strands-agents/harness-sdk/pull/3876", commit: "45bcea8", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/45bcea8", author: gautamsirdeshmukh }
  - { type: fix, breaking: false, scope: file-editor, areas: [tool], title: "stop str_replace and insert from rewriting untouched bytes", pr: 4014, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4014", commit: "e448bea", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/e448bea", author: lizradway }
  - { type: feat, breaking: false, scope: storage, areas: [persistence], title: "add QmdSearchStrategy with BM25 full-text search", pr: 3897, prUrl: "https://github.com/strands-agents/harness-sdk/pull/3897", commit: "3d15419", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/3d15419", author: lizradway }
  - { type: docs, breaking: false, scope: design, areas: [], title: "align 0016 with shipped ClassifierStrategy", pr: 4046, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4046", commit: "717f7e4", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/717f7e4", author: JackYPCOnline }
  - { type: feat, breaking: false, scope: ts, areas: [async, agent], title: "add backgroundTasks to Agent", pr: 4026, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4026", commit: "c1d5e4e", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/c1d5e4e", author: gautamsirdeshmukh }
  - { type: fix, breaking: false, scope: ts-telemetry, areas: [otel], title: "close cycle telemetry when the stream iterator exits early", pr: 4054, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4054", commit: "d51ad20", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/d51ad20", author: poshinchen }
---
