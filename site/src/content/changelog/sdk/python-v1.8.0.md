---
sdk: sdk
language: python
version: "1.8.0"
tag: python/v1.8.0
date: 2025-09-10
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.8.0
packageUrl: https://pypi.org/project/strands-agents/1.8.0/
entries:
  - { type: other, breaking: false, scope: null, areas: [], title: "Moved tool_spec retrieval to after the before model invocation callback", pr: 786, prUrl: "https://github.com/strands-agents/sdk-python/pull/786", commit: "faeb21a", commitUrl: "https://github.com/strands-agents/sdk-python/commit/faeb21a", author: pghazanfari }
  - { type: fix, breaking: false, scope: graph, areas: [multiagent], title: "fix cyclic graph behavior", pr: 768, prUrl: "https://github.com/strands-agents/sdk-python/pull/768", commit: "b568864", commitUrl: "https://github.com/strands-agents/sdk-python/commit/b568864", author: mkmeral }
  - { type: fix, breaking: false, scope: models, areas: [model], title: "filter reasoningContent in Bedrock requests using DeepSeek", pr: 652, prUrl: "https://github.com/strands-agents/sdk-python/pull/652", commit: "8cb53d3", commitUrl: "https://github.com/strands-agents/sdk-python/commit/8cb53d3", author: aryan835-datainflexion }
  - { type: docs, breaking: false, scope: null, areas: [], title: "cleanup docs so the yields section renders correctly", pr: 820, prUrl: "https://github.com/strands-agents/sdk-python/pull/820", commit: "c142e7a", commitUrl: "https://github.com/strands-agents/sdk-python/commit/c142e7a", author: afarntrog }
  - { type: other, breaking: false, scope: null, areas: [], title: "Warn on unknown model configuration properties", pr: 819, prUrl: "https://github.com/strands-agents/sdk-python/pull/819", commit: "f185c52", commitUrl: "https://github.com/strands-agents/sdk-python/commit/f185c52", author: zastrowm }
  - { type: fix, breaking: false, scope: null, areas: [], title: "do not block asyncio event loop between retries", pr: 805, prUrl: "https://github.com/strands-agents/sdk-python/pull/805", commit: "1f27488", commitUrl: "https://github.com/strands-agents/sdk-python/commit/1f27488", author: osdemah }
  - { type: feat, breaking: false, scope: null, areas: [structured-output], title: "improve structured output tool circular reference handling", pr: 817, prUrl: "https://github.com/strands-agents/sdk-python/pull/817", commit: "5420679", commitUrl: "https://github.com/strands-agents/sdk-python/commit/5420679", author: afarntrog }
  - { type: fix, breaking: false, scope: tools/loader, areas: [tool], title: "load and register all decorated @tool functions from file path", pr: 742, prUrl: "https://github.com/strands-agents/sdk-python/pull/742", commit: "6ab1aca", commitUrl: "https://github.com/strands-agents/sdk-python/commit/6ab1aca", author: Ratish1 }
  - { type: fix, breaking: false, scope: models, areas: [model], title: "patch litellm bug to honor passing in use_litellm_proxy as client_args", pr: 808, prUrl: "https://github.com/strands-agents/sdk-python/pull/808", commit: "d66fcdb", commitUrl: "https://github.com/strands-agents/sdk-python/commit/d66fcdb", author: dbschmigelski }
  - { type: feat, breaking: false, scope: null, areas: [model], title: "add default read timeout to Bedrock config", pr: 829, prUrl: "https://github.com/strands-agents/sdk-python/pull/829", commit: "9213bc5", commitUrl: "https://github.com/strands-agents/sdk-python/commit/9213bc5", author: afarntrog }
  - { type: feat, breaking: false, scope: null, areas: [model], title: "add support for Bedrock/Anthropic ToolChoice to structured_output", pr: 720, prUrl: "https://github.com/strands-agents/sdk-python/pull/720", commit: "001aa93", commitUrl: "https://github.com/strands-agents/sdk-python/commit/001aa93", author: liushang1997 }
  - { type: feat, breaking: false, scope: multiagent, areas: [multiagent], title: "allow callers of swarm and graph to pass kwargs to executors", pr: 816, prUrl: "https://github.com/strands-agents/sdk-python/pull/816", commit: "7f58ce9", commitUrl: "https://github.com/strands-agents/sdk-python/commit/7f58ce9", author: dbschmigelski }
  - { type: feat, breaking: false, scope: null, areas: [model], title: "add region-aware default model ID for Bedrock", pr: 835, prUrl: "https://github.com/strands-agents/sdk-python/pull/835", commit: "64d61e0", commitUrl: "https://github.com/strands-agents/sdk-python/commit/64d61e0", author: afarntrog }
  - { type: other, breaking: false, scope: null, areas: [model], title: "llama.cpp model provider support", pr: 585, prUrl: "https://github.com/strands-agents/sdk-python/pull/585", commit: "ab125f5", commitUrl: "https://github.com/strands-agents/sdk-python/commit/ab125f5", author: westonbrown }
  - { type: other, breaking: false, scope: null, areas: [model], title: "fix(llama.cpp) - add ToolChoice and validation of model config values", pr: 838, prUrl: "https://github.com/strands-agents/sdk-python/pull/838", commit: "4fbe46a", commitUrl: "https://github.com/strands-agents/sdk-python/commit/4fbe46a", author: awsarron }
newContributors:
  - { login: pghazanfari, pr: 786 }
  - { login: aryan835-datainflexion, pr: 652 }
  - { login: afarntrog, pr: 820 }
  - { login: osdemah, pr: 805 }
  - { login: Ratish1, pr: 742 }
  - { login: liushang1997, pr: 720 }
  - { login: westonbrown, pr: 585 }
---
