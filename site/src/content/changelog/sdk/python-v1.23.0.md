---
sdk: sdk
language: python
version: "1.23.0"
tag: python/v1.23.0
date: 2026-01-21
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.23.0
packageUrl: https://pypi.org/project/strands-agents/1.23.0/
entries:
  - { type: fix, breaking: false, scope: mcp, areas: [mcp], title: "prevent agent hang by checking session closure state", pr: 1396, prUrl: "https://github.com/strands-agents/sdk-python/pull/1396", commit: "c43dfa9", commitUrl: "https://github.com/strands-agents/sdk-python/commit/c43dfa9", author: Ratish1 }
  - { type: other, breaking: false, scope: null, areas: [], title: "update sphinx-rtd-theme requirement from <2.0.0,>=1.0.0 to >=1.0.0,<4.0.0", pr: 1466, prUrl: "https://github.com/strands-agents/sdk-python/pull/1466", commit: "368bb0f", commitUrl: "https://github.com/strands-agents/sdk-python/commit/368bb0f", author: "dependabot[bot]" }
  - { type: other, breaking: false, scope: null, areas: [], title: "update websockets requirement from <16.0.0,>=15.0.0 to >=15.0.0,<17.0.0", pr: 1451, prUrl: "https://github.com/strands-agents/sdk-python/pull/1451", commit: "c029831", commitUrl: "https://github.com/strands-agents/sdk-python/commit/c029831", author: "dependabot[bot]" }
  - { type: other, breaking: false, scope: null, areas: [], title: "Update ruff configuration to apply pyupgrade to modernize python syntax", pr: 1336, prUrl: "https://github.com/strands-agents/sdk-python/pull/1336", commit: "2546aa0", commitUrl: "https://github.com/strands-agents/sdk-python/commit/2546aa0", author: maxrabin }
  - { type: fix, breaking: false, scope: agent, areas: [agent], title: "extract text from citationsContent in AgentResult.__str__", pr: 1489, prUrl: "https://github.com/strands-agents/sdk-python/pull/1489", commit: "c23090f", commitUrl: "https://github.com/strands-agents/sdk-python/commit/c23090f", author: tmokmss }
  - { type: other, breaking: false, scope: null, areas: [hooks], title: "Expose input messages to BeforeInvocationEvent hook", pr: 1474, prUrl: "https://github.com/strands-agents/sdk-python/pull/1474", commit: "dfe3ec7", commitUrl: "https://github.com/strands-agents/sdk-python/commit/dfe3ec7", author: Unshure }
  - { type: other, breaking: false, scope: null, areas: [multiagent], title: "interrupts - graph - hook based", pr: 1478, prUrl: "https://github.com/strands-agents/sdk-python/pull/1478", commit: "058c03a", commitUrl: "https://github.com/strands-agents/sdk-python/commit/058c03a", author: pgrayy }
  - { type: fix, breaking: false, scope: null, areas: [], title: "Swap unit test sleeps with explicit signaling", pr: 1497, prUrl: "https://github.com/strands-agents/sdk-python/pull/1497", commit: "bb3052b", commitUrl: "https://github.com/strands-agents/sdk-python/commit/bb3052b", author: zastrowm }
  - { type: other, breaking: false, scope: null, areas: [tool], title: "Fix PEP 563 incompatibility with @tool decorated tools", pr: 1494, prUrl: "https://github.com/strands-agents/sdk-python/pull/1494", commit: "25c46a1", commitUrl: "https://github.com/strands-agents/sdk-python/commit/25c46a1", author: zastrowm }
  - { type: feat, breaking: false, scope: null, areas: [], title: "override service name by OTEL_SERVICE_NAME env", pr: 1400, prUrl: "https://github.com/strands-agents/sdk-python/pull/1400", commit: "5e733ef", commitUrl: "https://github.com/strands-agents/sdk-python/commit/5e733ef", author: okamototk }
  - { type: fix, breaking: false, scope: bedrock, areas: [model], title: "disable thinking mode when forcing tool_choice", pr: 1495, prUrl: "https://github.com/strands-agents/sdk-python/pull/1495", commit: "bce2464", commitUrl: "https://github.com/strands-agents/sdk-python/commit/bce2464", author: strands-agent }
  - { type: fix, breaking: false, scope: a2a, areas: [a2a], title: "use a2a artifact update event", pr: 1401, prUrl: "https://github.com/strands-agents/sdk-python/pull/1401", commit: "e4bd3bc", commitUrl: "https://github.com/strands-agents/sdk-python/commit/e4bd3bc", author: brycewcole }
  - { type: other, breaking: false, scope: null, areas: [], title: "Add parallel reading support to S3SessionManager.list_messages()", pr: 1186, prUrl: "https://github.com/strands-agents/sdk-python/pull/1186", commit: "51cbe7b", commitUrl: "https://github.com/strands-agents/sdk-python/commit/51cbe7b", author: CrysisDeu }
  - { type: feat, breaking: false, scope: steering, areas: [], title: "allow steering on AfterModelCallEvents", pr: 1429, prUrl: "https://github.com/strands-agents/sdk-python/pull/1429", commit: "8b7f6cc", commitUrl: "https://github.com/strands-agents/sdk-python/commit/8b7f6cc", author: dbschmigelski }
  - { type: fix, breaking: false, scope: null, areas: [model], title: "provide unique toolUseId for gemini models", pr: 1201, prUrl: "https://github.com/strands-agents/sdk-python/pull/1201", commit: "63e58aa", commitUrl: "https://github.com/strands-agents/sdk-python/commit/63e58aa", author: AirswitchAsa }
  - { type: other, breaking: false, scope: null, areas: [model], title: "gemini - tool_use_id_to_name - local", pr: 1521, prUrl: "https://github.com/strands-agents/sdk-python/pull/1521", commit: "456b70a", commitUrl: "https://github.com/strands-agents/sdk-python/commit/456b70a", author: pgrayy }
  - { type: fix, breaking: false, scope: litellm, areas: [model], title: "handle missing usage attribute on ModelResponseStream", pr: 1520, prUrl: "https://github.com/strands-agents/sdk-python/pull/1520", commit: "6dcd247", commitUrl: "https://github.com/strands-agents/sdk-python/commit/6dcd247", author: dbschmigelski }
  - { type: feat, breaking: false, scope: agent, areas: [agent], title: "add configurable retry_strategy for model calls", pr: 1424, prUrl: "https://github.com/strands-agents/sdk-python/pull/1424", commit: "64e1bb2", commitUrl: "https://github.com/strands-agents/sdk-python/commit/64e1bb2", author: zastrowm }
  - { type: fix, breaking: false, scope: swarm, areas: [multiagent], title: "accumulate execution_time across interrupt/resume cycles", pr: 1502, prUrl: "https://github.com/strands-agents/sdk-python/pull/1502", commit: "7604e98", commitUrl: "https://github.com/strands-agents/sdk-python/commit/7604e98", author: pgrayy }
  - { type: feat, breaking: false, scope: null, areas: [multiagent], title: "graduate multiagent hook events from experimental", pr: 1498, prUrl: "https://github.com/strands-agents/sdk-python/pull/1498", commit: "2e23d75", commitUrl: "https://github.com/strands-agents/sdk-python/commit/2e23d75", author: JackYPCOnline }
  - { type: other, breaking: false, scope: null, areas: [], title: "Nova Sonic 2 support for BidiAgent", pr: 1476, prUrl: "https://github.com/strands-agents/sdk-python/pull/1476", commit: "b41a99b", commitUrl: "https://github.com/strands-agents/sdk-python/commit/b41a99b", author: lanazhang }
  - { type: fix, breaking: false, scope: tests, areas: [], title: "reduce flakiness in guardrail redact output test", pr: 1505, prUrl: "https://github.com/strands-agents/sdk-python/pull/1505", commit: "f87925b", commitUrl: "https://github.com/strands-agents/sdk-python/commit/f87925b", author: dbschmigelski }
newContributors:
  - { login: maxrabin, pr: 1336 }
  - { login: tmokmss, pr: 1489 }
  - { login: okamototk, pr: 1400 }
  - { login: strands-agent, pr: 1495 }
  - { login: brycewcole, pr: 1401 }
  - { login: CrysisDeu, pr: 1186 }
  - { login: AirswitchAsa, pr: 1201 }
  - { login: lanazhang, pr: 1476 }
---
