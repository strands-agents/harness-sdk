---
sdk: sdk
language: python
version: "1.13.0"
tag: python/v1.13.0
date: 2025-10-17
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.13.0
packageUrl: https://pypi.org/project/strands-agents/1.13.0/
entries:
  - { type: feat, breaking: false, scope: null, areas: [agent], title: "replace kwargs with invocation_state in agent APIs", pr: 966, prUrl: "https://github.com/strands-agents/sdk-python/pull/966", commit: "7fbc9dc", commitUrl: "https://github.com/strands-agents/sdk-python/commit/7fbc9dc", author: JackYPCOnline }
  - { type: feat, breaking: false, scope: telemetry, areas: [otel], title: "updated semantic conventions, added timeToFirstByteMs into spans and metrics", pr: 997, prUrl: "https://github.com/strands-agents/sdk-python/pull/997", commit: "355b3bb", commitUrl: "https://github.com/strands-agents/sdk-python/commit/355b3bb", author: poshinchen }
  - { type: chore, breaking: false, scope: telemetry, areas: [otel], title: "added gen_ai.tool.description and gen_ai.tool.json_schema", pr: 1027, prUrl: "https://github.com/strands-agents/sdk-python/pull/1027", commit: "c3e5f6b", commitUrl: "https://github.com/strands-agents/sdk-python/commit/c3e5f6b", author: poshinchen }
  - { type: fix, breaking: false, scope: tool/decorator, areas: [], title: "validate ToolContext parameter name and raise clear error", pr: 1028, prUrl: "https://github.com/strands-agents/sdk-python/pull/1028", commit: "6cf4f7e", commitUrl: "https://github.com/strands-agents/sdk-python/commit/6cf4f7e", author: Ratish1 }
  - { type: other, breaking: false, scope: null, areas: [structured-output], title: "integ tests - fix flaky structured output test", pr: 1030, prUrl: "https://github.com/strands-agents/sdk-python/pull/1030", commit: "f7931c5", commitUrl: "https://github.com/strands-agents/sdk-python/commit/f7931c5", author: pgrayy }
  - { type: other, breaking: false, scope: null, areas: [tool], title: "hooks - before tool call event - interrupt", pr: 987, prUrl: "https://github.com/strands-agents/sdk-python/pull/987", commit: "dbf6200", commitUrl: "https://github.com/strands-agents/sdk-python/commit/dbf6200", author: pgrayy }
  - { type: other, breaking: false, scope: null, areas: [], title: "multiagents - temporarily raise exception when interrupted", pr: 1038, prUrl: "https://github.com/strands-agents/sdk-python/pull/1038", commit: "61e41da", commitUrl: "https://github.com/strands-agents/sdk-python/commit/61e41da", author: pgrayy }
  - { type: feat, breaking: false, scope: null, areas: [], title: "Support adding exception notes for Python 3.10", pr: 1034, prUrl: "https://github.com/strands-agents/sdk-python/pull/1034", commit: "7cd10b9", commitUrl: "https://github.com/strands-agents/sdk-python/commit/7cd10b9", author: zastrowm }
  - { type: other, breaking: false, scope: null, areas: [tool], title: "interrupts - decorated tools", pr: 1041, prUrl: "https://github.com/strands-agents/sdk-python/pull/1041", commit: "26862e4", commitUrl: "https://github.com/strands-agents/sdk-python/commit/26862e4", author: pgrayy }
---
