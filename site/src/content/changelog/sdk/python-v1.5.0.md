---
sdk: sdk
language: python
version: "1.5.0"
tag: python/v1.5.0
date: 2025-08-19
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.5.0
packageUrl: https://pypi.org/project/strands-agents/1.5.0/
entries:
  - { type: other, breaking: false, scope: null, areas: [multiagent], title: "feature(graph): Allow cyclic graphs", pr: 497, prUrl: "https://github.com/strands-agents/sdk-python/pull/497", commit: "99963b6", commitUrl: "https://github.com/strands-agents/sdk-python/commit/99963b6", author: mkmeral }
  - { type: chore, breaking: false, scope: null, areas: [], title: "request to include code snippet section", pr: 654, prUrl: "https://github.com/strands-agents/sdk-python/pull/654", commit: "72709cf", commitUrl: "https://github.com/strands-agents/sdk-python/commit/72709cf", author: poshinchen }
  - { type: feat, breaking: false, scope: null, areas: [mcp], title: "Add configuration option to MCP Client for server init timeout", pr: 657, prUrl: "https://github.com/strands-agents/sdk-python/pull/657", commit: "8434409", commitUrl: "https://github.com/strands-agents/sdk-python/commit/8434409", author: fhwilton55 }
  - { type: fix, breaking: false, scope: null, areas: [agent], title: "Properly handle prompt=None & avoid agent hanging", pr: 643, prUrl: "https://github.com/strands-agents/sdk-python/pull/643", commit: "49ff226", commitUrl: "https://github.com/strands-agents/sdk-python/commit/49ff226", author: zastrowm }
  - { type: feat, breaking: false, scope: null, areas: [], title: "add structured_output_span", pr: 655, prUrl: "https://github.com/strands-agents/sdk-python/pull/655", commit: "0455756", commitUrl: "https://github.com/strands-agents/sdk-python/commit/0455756", author: poshinchen }
  - { type: other, breaking: false, scope: null, areas: [model], title: "litellm - set 1.73.1 as minimum version", pr: 668, prUrl: "https://github.com/strands-agents/sdk-python/pull/668", commit: "1c7257b", commitUrl: "https://github.com/strands-agents/sdk-python/commit/1c7257b", author: pgrayy }
  - { type: feat, breaking: false, scope: null, areas: [tool], title: "expose tool_use and agent through ToolContext to decorated tools", pr: 557, prUrl: "https://github.com/strands-agents/sdk-python/pull/557", commit: "606f657", commitUrl: "https://github.com/strands-agents/sdk-python/commit/606f657", author: dbschmigelski }
  - { type: other, breaking: false, scope: null, areas: [sessions], title: "session manager - prevent file path injection", pr: 680, prUrl: "https://github.com/strands-agents/sdk-python/pull/680", commit: "8c63d75", commitUrl: "https://github.com/strands-agents/sdk-python/commit/8c63d75", author: pgrayy }
  - { type: fix, breaking: false, scope: null, areas: [], title: "only set signature in message if signature was provided by the model", pr: 682, prUrl: "https://github.com/strands-agents/sdk-python/pull/682", commit: "fbd598a", commitUrl: "https://github.com/strands-agents/sdk-python/commit/fbd598a", author: clareliguori }
  - { type: fix, breaking: false, scope: null, areas: [model], title: "Add openai dependency to sagemaker dependency group", pr: 678, prUrl: "https://github.com/strands-agents/sdk-python/pull/678", commit: "ae74aa3", commitUrl: "https://github.com/strands-agents/sdk-python/commit/ae74aa3", author: zastrowm }
  - { type: other, breaking: false, scope: null, areas: [], title: "Have [all] group reference the other optional dependency groups by name", pr: 674, prUrl: "https://github.com/strands-agents/sdk-python/pull/674", commit: "980a988", commitUrl: "https://github.com/strands-agents/sdk-python/commit/980a988", author: zastrowm }
  - { type: fix, breaking: false, scope: null, areas: [], title: "append blank text content if assistant content is empty", pr: 677, prUrl: "https://github.com/strands-agents/sdk-python/pull/677", commit: "b1df148", commitUrl: "https://github.com/strands-agents/sdk-python/commit/b1df148", author: poshinchen }
  - { type: feat, breaking: false, scope: null, areas: [model], title: "add cached token metrics support for Amazon Bedrock", pr: 531, prUrl: "https://github.com/strands-agents/sdk-python/pull/531", commit: "cfcf93d", commitUrl: "https://github.com/strands-agents/sdk-python/commit/cfcf93d", author: oaltagar-aws }
newContributors:
  - { login: fhwilton55, pr: 657 }
  - { login: oaltagar-aws, pr: 531 }
---
