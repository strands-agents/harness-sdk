---
sdk: harness
language: python
version: "0.5.0"
tag: harness-python/v0.5.0
date: 2026-11-23
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/harness-python/v0.5.0
packageUrl: https://pypi.org/project/strands-harness/0.5.0/
entries:
  - { type: other, breaking: false, scope: cli, areas: [community, cli], title: "record the process list before a hung Windows test run is killed", pr: 6131, prUrl: "https://github.com/strands-agents/harness-sdk/pull/6131", commit: "7f75a32", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/7f75a32", author: yonib05 }
  - { type: other, breaking: false, scope: typescript, areas: [community], title: "cap the test job at 30 minutes and tolerate artifact upload failures", pr: 6130, prUrl: "https://github.com/strands-agents/harness-sdk/pull/6130", commit: "7733955", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/7733955", author: yonib05 }
  - { type: fix, breaking: false, scope: harness, areas: [server, harness], title: "give the sandbox shell probe 30 seconds", pr: 6128, prUrl: "https://github.com/strands-agents/harness-sdk/pull/6128", commit: "7f860e0", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/7f860e0", author: yonib05 }
  - { type: other, breaking: false, scope: cli, areas: [community, cli], title: "split the Windows test leg into two shards", pr: 6132, prUrl: "https://github.com/strands-agents/harness-sdk/pull/6132", commit: "c7838ee", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/c7838ee", author: yonib05 }
  - { type: feat, breaking: false, scope: null, areas: [context, harness, catalog], title: "vend the todos plugin in the SDK and deprecate the harness built-in", pr: 6084, prUrl: "https://github.com/strands-agents/harness-sdk/pull/6084", commit: "76f2f44", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/76f2f44", author: lizradway }
  - { type: other, breaking: false, scope: null, areas: [community], title: "run the SDK and harness suites when shared/ changes", pr: 6135, prUrl: "https://github.com/strands-agents/harness-sdk/pull/6135", commit: "c8e1351", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/c8e1351", author: yonib05 }
  - { type: feat, breaking: true, scope: harness, areas: [model], title: "default to Claude Opus 5.5 on Anthropic's Bedrock client", pr: 4683, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4683", commit: "5a3d25d", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/5a3d25d", author: strandly-the-agent }
  - { type: fix, breaking: false, scope: models, areas: [model], title: "add GPT-6.2 Astra and Sol model info (py + ts)", pr: 6265, prUrl: "https://github.com/strands-agents/harness-sdk/pull/6265", commit: "a4c8c9c", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/a4c8c9c", author: strandly-the-agent }
  - { type: feat, breaking: false, scope: harness, areas: [tool, harness], title: "serve web_search from AgentCore InvokeWebSearch on Bedrock (py + ts)", pr: 5997, prUrl: "https://github.com/strands-agents/harness-sdk/pull/5997", commit: "dd92a16", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/dd92a16", author: strandly-the-agent }
  - { type: feat, breaking: true, scope: context, areas: [context], title: "offload conditions decide granularity (python)", pr: 6101, prUrl: "https://github.com/strands-agents/harness-sdk/pull/6101", commit: "84d814b", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/84d814b", author: lizradway }
  - { type: fix, breaking: false, scope: null, areas: [model, harness], title: "stop defaulting to Llama 3.2, which reached end of life on Bedrock", pr: 6421, prUrl: "https://github.com/strands-agents/harness-sdk/pull/6421", commit: "26978f2", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/26978f2", author: JackYPCOnline }
---
