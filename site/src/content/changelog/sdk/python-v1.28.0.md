---
sdk: sdk
language: python
version: "1.28.0"
tag: python/v1.28.0
date: 2026-02-25
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.28.0
packageUrl: https://pypi.org/project/strands-agents/1.28.0/
entries:
  - { type: fix, breaking: false, scope: null, areas: [], title: "update region for agentcore in our new account", pr: 1715, prUrl: "https://github.com/strands-agents/sdk-python/pull/1715", commit: "df98ee1", commitUrl: "https://github.com/strands-agents/sdk-python/commit/df98ee1", author: afarntrog }
  - { type: fix, breaking: false, scope: null, areas: [], title: "remove test that fails for python 3.14", pr: 1717, prUrl: "https://github.com/strands-agents/sdk-python/pull/1717", commit: "db6cd98", commitUrl: "https://github.com/strands-agents/sdk-python/commit/db6cd98", author: Unshure }
  - { type: feat, breaking: false, scope: hooks, areas: [hooks], title: "support union types and list of types for add_hook", pr: 1719, prUrl: "https://github.com/strands-agents/sdk-python/pull/1719", commit: "2456b71", commitUrl: "https://github.com/strands-agents/sdk-python/commit/2456b71", author: Unshure }
  - { type: feat, breaking: false, scope: null, areas: [], title: "make pyaudio an optional dependency by lazy loading", pr: 1731, prUrl: "https://github.com/strands-agents/sdk-python/pull/1731", commit: "a5d26e7", commitUrl: "https://github.com/strands-agents/sdk-python/commit/a5d26e7", author: mehtarac }
  - { type: feat, breaking: false, scope: hooks, areas: [hooks], title: "add Plugin Protocol for agent extensibility", pr: 1733, prUrl: "https://github.com/strands-agents/sdk-python/pull/1733", commit: "029c77a", commitUrl: "https://github.com/strands-agents/sdk-python/commit/029c77a", author: Unshure }
  - { type: feat, breaking: false, scope: null, areas: [agent], title: "add plugins parameter to Agent", pr: 1734, prUrl: "https://github.com/strands-agents/sdk-python/pull/1734", commit: "30e3020", commitUrl: "https://github.com/strands-agents/sdk-python/commit/30e3020", author: Unshure }
  - { type: refactor, breaking: false, scope: plugins, areas: [], title: "convert Plugin from Protocol to ABC", pr: 1741, prUrl: "https://github.com/strands-agents/sdk-python/pull/1741", commit: "881acc0", commitUrl: "https://github.com/strands-agents/sdk-python/commit/881acc0", author: Unshure }
  - { type: feat, breaking: false, scope: steering, areas: [], title: "migrate SteeringHandler from HookProvider to Plugin", pr: 1738, prUrl: "https://github.com/strands-agents/sdk-python/pull/1738", commit: "d66a54c", commitUrl: "https://github.com/strands-agents/sdk-python/commit/d66a54c", author: Unshure }
  - { type: chore, breaking: false, scope: null, areas: [model], title: "switch to Sonnet 4.6 for Anthropic provider integ tests", pr: 1754, prUrl: "https://github.com/strands-agents/sdk-python/pull/1754", commit: "42e18b8", commitUrl: "https://github.com/strands-agents/sdk-python/commit/42e18b8", author: clareliguori }
  - { type: fix, breaking: false, scope: null, areas: [], title: "rename init_plugin to init_agent", pr: 1765, prUrl: "https://github.com/strands-agents/sdk-python/pull/1765", commit: "37938da", commitUrl: "https://github.com/strands-agents/sdk-python/commit/37938da", author: Unshure }
---
