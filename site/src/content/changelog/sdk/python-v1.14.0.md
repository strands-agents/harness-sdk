---
sdk: sdk
language: python
version: "1.14.0"
tag: python/v1.14.0
date: 2025-10-29
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.14.0
packageUrl: https://pypi.org/project/strands-agents/1.14.0/
entries:
  - { type: other, breaking: false, scope: null, areas: [model], title: "models - litellm - start and stop reasoning", pr: 947, prUrl: "https://github.com/strands-agents/sdk-python/pull/947", commit: "3a7af77", commitUrl: "https://github.com/strands-agents/sdk-python/commit/3a7af77", author: pgrayy }
  - { type: feat, breaking: false, scope: null, areas: [tool], title: "add experimental AgentConfig with comprehensive tool management", pr: 935, prUrl: "https://github.com/strands-agents/sdk-python/pull/935", commit: "b69478b", commitUrl: "https://github.com/strands-agents/sdk-python/commit/b69478b", author: mr-lee }
  - { type: fix, breaking: false, scope: telemetry, areas: [otel], title: "make strands agent invoke_agent span as INTERNAL spanKind", pr: 1055, prUrl: "https://github.com/strands-agents/sdk-python/pull/1055", commit: "78c59b9", commitUrl: "https://github.com/strands-agents/sdk-python/commit/78c59b9", author: poshinchen }
  - { type: feat, breaking: false, scope: null, areas: [multiagent], title: "add multiagent hooks, add serialize & deserialize function to multiagent base & agent result", pr: 1070, prUrl: "https://github.com/strands-agents/sdk-python/pull/1070", commit: "8a89d91", commitUrl: "https://github.com/strands-agents/sdk-python/commit/8a89d91", author: JackYPCOnline }
  - { type: feat, breaking: false, scope: null, areas: [structured-output], title: "Add Structured Output as part of the agent loop", pr: 943, prUrl: "https://github.com/strands-agents/sdk-python/pull/943", commit: "648af22", commitUrl: "https://github.com/strands-agents/sdk-python/commit/648af22", author: afarntrog }
  - { type: other, breaking: false, scope: null, areas: [], title: "integ tests - interrupts - remove asyncio marker", pr: 1045, prUrl: "https://github.com/strands-agents/sdk-python/pull/1045", commit: "de802fb", commitUrl: "https://github.com/strands-agents/sdk-python/commit/de802fb", author: pgrayy }
  - { type: other, breaking: false, scope: null, areas: [], title: "interrupt - docstring - fix formatting", pr: 1074, prUrl: "https://github.com/strands-agents/sdk-python/pull/1074", commit: "d4ef8bf", commitUrl: "https://github.com/strands-agents/sdk-python/commit/d4ef8bf", author: pgrayy }
  - { type: other, breaking: false, scope: null, areas: [], title: "add pr size labeler", pr: 1082, prUrl: "https://github.com/strands-agents/sdk-python/pull/1082", commit: "1544384", commitUrl: "https://github.com/strands-agents/sdk-python/commit/1544384", author: dbschmigelski }
  - { type: fix, breaking: false, scope: null, areas: [], title: "Don't bail out if there are no tool_uses", pr: 1087, prUrl: "https://github.com/strands-agents/sdk-python/pull/1087", commit: "999e654", commitUrl: "https://github.com/strands-agents/sdk-python/commit/999e654", author: zastrowm }
  - { type: feat, breaking: false, scope: mcp, areas: [mcp], title: "add experimental agent managed connection via ToolProvider", pr: 895, prUrl: "https://github.com/strands-agents/sdk-python/pull/895", commit: "3446938", commitUrl: "https://github.com/strands-agents/sdk-python/commit/3446938", author: dbschmigelski }
  - { type: other, breaking: false, scope: null, areas: [model], title: "fix (bug): retry on varying Bedrock throttlingexception cases", pr: 1096, prUrl: "https://github.com/strands-agents/sdk-python/pull/1096", commit: "73865d3", commitUrl: "https://github.com/strands-agents/sdk-python/commit/73865d3", author: mehtarac }
  - { type: feat, breaking: false, scope: null, areas: [], title: "skip model invocation when latest message contains ToolUse", pr: 1068, prUrl: "https://github.com/strands-agents/sdk-python/pull/1068", commit: "2147920", commitUrl: "https://github.com/strands-agents/sdk-python/commit/2147920", author: Unshure }
  - { type: other, breaking: false, scope: null, areas: [tool], title: "direct tool call - interrupt not allowed", pr: 1097, prUrl: "https://github.com/strands-agents/sdk-python/pull/1097", commit: "071f89f", commitUrl: "https://github.com/strands-agents/sdk-python/commit/071f89f", author: pgrayy }
  - { type: other, breaking: false, scope: null, areas: [mcp], title: "mcp elicitation", pr: 1094, prUrl: "https://github.com/strands-agents/sdk-python/pull/1094", commit: "49e432d", commitUrl: "https://github.com/strands-agents/sdk-python/commit/49e432d", author: pgrayy }
  - { type: fix, breaking: false, scope: litellm, areas: [model], title: "enhance structured output handling", pr: 1021, prUrl: "https://github.com/strands-agents/sdk-python/pull/1021", commit: "104ecb5", commitUrl: "https://github.com/strands-agents/sdk-python/commit/104ecb5", author: Arindam200 }
  - { type: other, breaking: false, scope: null, areas: [tool], title: "Transform invalid tool usages on sending, not on initial detection", pr: 1091, prUrl: "https://github.com/strands-agents/sdk-python/pull/1091", commit: "c2ba0f7", commitUrl: "https://github.com/strands-agents/sdk-python/commit/c2ba0f7", author: zastrowm }
newContributors:
  - { login: mr-lee, pr: 935 }
  - { login: Arindam200, pr: 1021 }
---
