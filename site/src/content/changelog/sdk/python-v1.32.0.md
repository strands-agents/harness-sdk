---
sdk: sdk
language: python
version: "1.32.0"
tag: python/v1.32.0
date: 2026-03-20
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.32.0
packageUrl: https://pypi.org/project/strands-agents/1.32.0/
entries:
  - { type: fix, breaking: false, scope: event-loop, areas: [otel], title: "ensure all cycle metrics include end time and duration", pr: 1903, prUrl: "https://github.com/strands-agents/sdk-python/pull/1903", commit: "adfeb97", commitUrl: "https://github.com/strands-agents/sdk-python/commit/adfeb97", author: stephentreacy }
  - { type: fix, breaking: false, scope: null, areas: [], title: "pin upper bound for mistralai dependency", pr: 1935, prUrl: "https://github.com/strands-agents/sdk-python/pull/1935", commit: "ae28397", commitUrl: "https://github.com/strands-agents/sdk-python/commit/ae28397", author: mkmeral }
  - { type: fix, breaking: false, scope: null, areas: [bidirectional-streaming], title: "override end_turn stop reason when streaming response contains toolUse blocks", pr: 1827, prUrl: "https://github.com/strands-agents/sdk-python/pull/1827", commit: "38c1ab6", commitUrl: "https://github.com/strands-agents/sdk-python/commit/38c1ab6", author: atian8179 }
newContributors:
  - { login: stephentreacy, pr: 1903 }
  - { login: atian8179, pr: 1827 }
---
