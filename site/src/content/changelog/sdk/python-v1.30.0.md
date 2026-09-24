---
sdk: sdk
language: python
version: "1.30.0"
tag: python/v1.30.0
date: 2026-03-11
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.30.0
packageUrl: https://pypi.org/project/strands-agents/1.30.0/
entries:
  - { type: feat, breaking: false, scope: null, areas: [model], title: "add \"anthropic\" cache strategy to bypass model ID check", pr: 1808, prUrl: "https://github.com/strands-agents/sdk-python/pull/1808", commit: "32caa89", commitUrl: "https://github.com/strands-agents/sdk-python/commit/32caa89", author: kevmyung }
  - { type: feat, breaking: false, scope: null, areas: [tool], title: "serialize tool results as JSON when possible", pr: 1752, prUrl: "https://github.com/strands-agents/sdk-python/pull/1752", commit: "12fd856", commitUrl: "https://github.com/strands-agents/sdk-python/commit/12fd856", author: clareliguori }
  - { type: fix, breaking: false, scope: null, areas: [structured-output], title: "summary manager using structured output", pr: 1805, prUrl: "https://github.com/strands-agents/sdk-python/pull/1805", commit: "a7d19cc", commitUrl: "https://github.com/strands-agents/sdk-python/commit/a7d19cc", author: pgrayy }
  - { type: feat, breaking: false, scope: mcp, areas: [mcp], title: "expose server instructions from InitializeResult on MCPClient", pr: 1814, prUrl: "https://github.com/strands-agents/sdk-python/pull/1814", commit: "316f54e", commitUrl: "https://github.com/strands-agents/sdk-python/commit/316f54e", author: ShotaroKataoka }
  - { type: fix, breaking: false, scope: null, areas: [], title: "added LANGFUSE_BASE_URL check for additinoal attribute", pr: 1826, prUrl: "https://github.com/strands-agents/sdk-python/pull/1826", commit: "697e55c", commitUrl: "https://github.com/strands-agents/sdk-python/commit/697e55c", author: poshinchen }
  - { type: feat, breaking: false, scope: session, areas: [sessions], title: "add dirty flag to skip unnecessary agent state persistence", pr: 1803, prUrl: "https://github.com/strands-agents/sdk-python/pull/1803", commit: "2d766c4", commitUrl: "https://github.com/strands-agents/sdk-python/commit/2d766c4", author: Unshure }
  - { type: feat, breaking: false, scope: null, areas: [], title: "add public tool_spec setter", pr: 1822, prUrl: "https://github.com/strands-agents/sdk-python/pull/1822", commit: "98636ae", commitUrl: "https://github.com/strands-agents/sdk-python/commit/98636ae", author: mkmeral }
  - { type: feat, breaking: false, scope: null, areas: [agent], title: "add CancellationToken for graceful agent execution cancellation", pr: 1772, prUrl: "https://github.com/strands-agents/sdk-python/pull/1772", commit: "73fe9cc", commitUrl: "https://github.com/strands-agents/sdk-python/commit/73fe9cc", author: jgoyani1 }
  - { type: feat, breaking: false, scope: session, areas: [sessions], title: "optimize session manager initialization", pr: 1829, prUrl: "https://github.com/strands-agents/sdk-python/pull/1829", commit: "32d703c", commitUrl: "https://github.com/strands-agents/sdk-python/commit/32d703c", author: Unshure }
  - { type: fix, breaking: false, scope: mistral, areas: [model], title: "report usage metrics in streaming mode", pr: 1697, prUrl: "https://github.com/strands-agents/sdk-python/pull/1697", commit: "3406ef4", commitUrl: "https://github.com/strands-agents/sdk-python/commit/3406ef4", author: jackatorcflo }
  - { type: fix, breaking: false, scope: openai_responses, areas: [], title: "use output_text for assistant messages in multi-turn conversations", pr: 1851, prUrl: "https://github.com/strands-agents/sdk-python/pull/1851", commit: "021344b", commitUrl: "https://github.com/strands-agents/sdk-python/commit/021344b", author: giulio-leone }
  - { type: feat, breaking: false, scope: hooks, areas: [hooks], title: "add resume flag to AfterInvocationEvent", pr: 1767, prUrl: "https://github.com/strands-agents/sdk-python/pull/1767", commit: "bfe9d02", commitUrl: "https://github.com/strands-agents/sdk-python/commit/bfe9d02", author: mkmeral }
  - { type: fix, breaking: false, scope: null, areas: [], title: "place cache point on last user message instead of assistant", pr: 1821, prUrl: "https://github.com/strands-agents/sdk-python/pull/1821", commit: "b0fc796", commitUrl: "https://github.com/strands-agents/sdk-python/commit/b0fc796", author: kevmyung }
  - { type: feat, breaking: false, scope: skills, areas: [agent], title: "add agent skills as a plugin", pr: 1755, prUrl: "https://github.com/strands-agents/sdk-python/pull/1755", commit: "4a26f4a", commitUrl: "https://github.com/strands-agents/sdk-python/commit/4a26f4a", author: mkmeral }
  - { type: feat, breaking: false, scope: steering, areas: [], title: "move steering from experimental to production", pr: 1853, prUrl: "https://github.com/strands-agents/sdk-python/pull/1853", commit: "e7d3eb9", commitUrl: "https://github.com/strands-agents/sdk-python/commit/e7d3eb9", author: dbschmigelski }
  - { type: fix, breaking: false, scope: null, areas: [agent], title: "break circular references so Agent cleanup doesn't hang with MCPClient", pr: 1830, prUrl: "https://github.com/strands-agents/sdk-python/pull/1830", commit: "b9f5b90", commitUrl: "https://github.com/strands-agents/sdk-python/commit/b9f5b90", author: dbschmigelski }
  - { type: fix, breaking: false, scope: null, areas: [], title: "Set _is_new_session = False at the end of each initialize_* method", pr: 1859, prUrl: "https://github.com/strands-agents/sdk-python/pull/1859", commit: "2da3f7c", commitUrl: "https://github.com/strands-agents/sdk-python/commit/2da3f7c", author: mehtarac }
newContributors:
  - { login: ShotaroKataoka, pr: 1814 }
  - { login: jgoyani1, pr: 1772 }
  - { login: jackatorcflo, pr: 1697 }
  - { login: giulio-leone, pr: 1851 }
---
