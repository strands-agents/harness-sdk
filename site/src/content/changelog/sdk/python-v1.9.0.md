---
sdk: sdk
language: python
version: "1.9.0"
tag: python/v1.9.0
date: 2025-09-17
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.9.0
packageUrl: https://pypi.org/project/strands-agents/1.9.0/
entries:
  - { type: feat, breaking: false, scope: telemetry, areas: [otel], title: "add cache usage metrics to OpenTelemetry spans", pr: 825, prUrl: "https://github.com/strands-agents/sdk-python/pull/825", commit: "bf4e3e4", commitUrl: "https://github.com/strands-agents/sdk-python/commit/bf4e3e4", author: vamgan }
  - { type: docs, breaking: false, scope: null, areas: [], title: "improve docstring formatting", pr: 846, prUrl: "https://github.com/strands-agents/sdk-python/pull/846", commit: "7f77a59", commitUrl: "https://github.com/strands-agents/sdk-python/commit/7f77a59", author: waitasecant }
  - { type: other, breaking: false, scope: null, areas: [], title: "bump actions/setup-python from 5 to 6", pr: 796, prUrl: "https://github.com/strands-agents/sdk-python/pull/796", commit: "7d1bdbf", commitUrl: "https://github.com/strands-agents/sdk-python/commit/7d1bdbf", author: "dependabot[bot]" }
  - { type: other, breaking: false, scope: null, areas: [], title: "bump actions/github-script from 7 to 8", pr: 801, prUrl: "https://github.com/strands-agents/sdk-python/pull/801", commit: "eace0ec", commitUrl: "https://github.com/strands-agents/sdk-python/commit/eace0ec", author: "dependabot[bot]" }
  - { type: other, breaking: false, scope: null, areas: [], title: "bump aws-actions/configure-aws-credentials from 4 to 5", pr: 795, prUrl: "https://github.com/strands-agents/sdk-python/pull/795", commit: "fe7a700", commitUrl: "https://github.com/strands-agents/sdk-python/commit/fe7a700", author: "dependabot[bot]" }
  - { type: fix, breaking: false, scope: null, areas: [], title: "Add type to tool_input", pr: 854, prUrl: "https://github.com/strands-agents/sdk-python/pull/854", commit: "f12fee8", commitUrl: "https://github.com/strands-agents/sdk-python/commit/f12fee8", author: Unshure }
  - { type: feat, breaking: false, scope: swarm, areas: [multiagent], title: "Make entry point configurable", pr: 851, prUrl: "https://github.com/strands-agents/sdk-python/pull/851", commit: "cbdab32", commitUrl: "https://github.com/strands-agents/sdk-python/commit/cbdab32", author: mkmeral }
  - { type: other, breaking: false, scope: null, areas: [], title: "update ruff requirement from <0.13.0,>=0.12.0 to >=0.12.0,<0.14.0", pr: 840, prUrl: "https://github.com/strands-agents/sdk-python/pull/840", commit: "5790a9c", commitUrl: "https://github.com/strands-agents/sdk-python/commit/5790a9c", author: "dependabot[bot]" }
  - { type: other, breaking: false, scope: null, areas: [model], title: "update openai requirement from <1.102.0,>=1.68.0 to >=1.68.0,<1.108.0", pr: 827, prUrl: "https://github.com/strands-agents/sdk-python/pull/827", commit: "6a1b2d4", commitUrl: "https://github.com/strands-agents/sdk-python/commit/6a1b2d4", author: "dependabot[bot]" }
  - { type: feat, breaking: false, scope: null, areas: [], title: "add automated issue auto-close workflows with dry-run testing", pr: 832, prUrl: "https://github.com/strands-agents/sdk-python/pull/832", commit: "066a427", commitUrl: "https://github.com/strands-agents/sdk-python/commit/066a427", author: yonib05 }
  - { type: fix, breaking: false, scope: null, areas: [], title: "Clean up pyproject.toml", pr: 844, prUrl: "https://github.com/strands-agents/sdk-python/pull/844", commit: "500d01a", commitUrl: "https://github.com/strands-agents/sdk-python/commit/500d01a", author: Unshure }
  - { type: fix, breaking: false, scope: null, areas: [], title: "Updating documentation in decorator.py", pr: 852, prUrl: "https://github.com/strands-agents/sdk-python/pull/852", commit: "69d3910", commitUrl: "https://github.com/strands-agents/sdk-python/commit/69d3910", author: prabhuteja12 }
  - { type: other, breaking: false, scope: null, areas: [model], title: "models - openai - use client context", pr: 856, prUrl: "https://github.com/strands-agents/sdk-python/pull/856", commit: "6ccc8e7", commitUrl: "https://github.com/strands-agents/sdk-python/commit/6ccc8e7", author: pgrayy }
  - { type: other, breaking: false, scope: null, areas: [model], title: "Feature: Handle Bedrock redactedContent", pr: 848, prUrl: "https://github.com/strands-agents/sdk-python/pull/848", commit: "8122453", commitUrl: "https://github.com/strands-agents/sdk-python/commit/8122453", author: afarntrog }
  - { type: fix, breaking: false, scope: null, areas: [tool], title: "correctly label tool result messages in OpenTelemetry events", pr: 839, prUrl: "https://github.com/strands-agents/sdk-python/pull/839", commit: "7226025", commitUrl: "https://github.com/strands-agents/sdk-python/commit/7226025", author: vamgan }
  - { type: other, breaking: false, scope: null, areas: [model], title: "models - openai - client context comment", pr: 864, prUrl: "https://github.com/strands-agents/sdk-python/pull/864", commit: "4b29edc", commitUrl: "https://github.com/strands-agents/sdk-python/commit/4b29edc", author: pgrayy }
  - { type: fix, breaking: false, scope: null, areas: [model], title: "litellm structured_output test with more descriptive model", pr: 871, prUrl: "https://github.com/strands-agents/sdk-python/pull/871", commit: "8805021", commitUrl: "https://github.com/strands-agents/sdk-python/commit/8805021", author: dbschmigelski }
  - { type: fix, breaking: false, scope: mcp, areas: [mcp], title: "auto cleanup on exceptions occurring in __enter__", pr: 833, prUrl: "https://github.com/strands-agents/sdk-python/pull/833", commit: "03c62f7", commitUrl: "https://github.com/strands-agents/sdk-python/commit/03c62f7", author: dbschmigelski }
  - { type: fix, breaking: false, scope: mcp, areas: [mcp], title: "do not verify _background_session is present in stop()", pr: 876, prUrl: "https://github.com/strands-agents/sdk-python/pull/876", commit: "2a5f0f1", commitUrl: "https://github.com/strands-agents/sdk-python/commit/2a5f0f1", author: dbschmigelski }
  - { type: docs, breaking: false, scope: README, areas: [], title: "fix links and imports", pr: 837, prUrl: "https://github.com/strands-agents/sdk-python/pull/837", commit: "1f25512", commitUrl: "https://github.com/strands-agents/sdk-python/commit/1f25512", author: awsarron }
newContributors:
  - { login: vamgan, pr: 825 }
  - { login: waitasecant, pr: 846 }
  - { login: prabhuteja12, pr: 852 }
---
