---
sdk: sdk
language: python
version: "1.7.1"
tag: python/v1.7.1
date: 2025-09-05
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.7.1
packageUrl: https://pypi.org/project/strands-agents/1.7.1/
entries:
  - { type: fix, breaking: false, scope: null, areas: [], title: "don't emit ToolStream events for non generator functions", pr: 773, prUrl: "https://github.com/strands-agents/sdk-python/pull/773", commit: "237e188", commitUrl: "https://github.com/strands-agents/sdk-python/commit/237e188", author: zastrowm }
  - { type: fix, breaking: false, scope: tests, areas: [], title: "adjust test_bedrock_guardrails to account for async behavior", pr: 785, prUrl: "https://github.com/strands-agents/sdk-python/pull/785", commit: "4dee33b", commitUrl: "https://github.com/strands-agents/sdk-python/commit/4dee33b", author: dbschmigelski }
  - { type: fix, breaking: false, scope: doc, areas: [hooks], title: "replace invalid Hook names in doc comment with BeforeInvocationEvent & AfterInvocationEvent", pr: 782, prUrl: "https://github.com/strands-agents/sdk-python/pull/782", commit: "2db5226", commitUrl: "https://github.com/strands-agents/sdk-python/commit/2db5226", author: deepyes02 }
  - { type: fix, breaking: false, scope: null, areas: [model], title: "Remove status field from toolResult for non-claude 3 models in Bedrock model provider", pr: 686, prUrl: "https://github.com/strands-agents/sdk-python/pull/686", commit: "1e6d12d", commitUrl: "https://github.com/strands-agents/sdk-python/commit/1e6d12d", author: mehtarac }
  - { type: fix, breaking: false, scope: null, areas: [], title: "filter 'SDK_UNKNOWN_MEMBER' from response content", pr: 798, prUrl: "https://github.com/strands-agents/sdk-python/pull/798", commit: "ed33868", commitUrl: "https://github.com/strands-agents/sdk-python/commit/ed33868", author: JackYPCOnline }
  - { type: feat, breaking: false, scope: null, areas: [tool], title: "Implement async generator tools", pr: 788, prUrl: "https://github.com/strands-agents/sdk-python/pull/788", commit: "d07629f", commitUrl: "https://github.com/strands-agents/sdk-python/commit/d07629f", author: zastrowm }
  - { type: other, breaking: false, scope: null, areas: [model], title: "update openai requirement from <1.100.0 to <1.102.0", pr: 722, prUrl: "https://github.com/strands-agents/sdk-python/pull/722", commit: "ec000b8", commitUrl: "https://github.com/strands-agents/sdk-python/commit/ec000b8", author: "dependabot[bot]" }
  - { type: fix, breaking: false, scope: null, areas: [], title: "only add signature to reasoning blocks if signature is provided", pr: 806, prUrl: "https://github.com/strands-agents/sdk-python/pull/806", commit: "d77f08b", commitUrl: "https://github.com/strands-agents/sdk-python/commit/d77f08b", author: zastrowm }
newContributors:
  - { login: deepyes02, pr: 782 }
---
