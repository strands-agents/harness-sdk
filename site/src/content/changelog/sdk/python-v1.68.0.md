---
sdk: sdk
language: python
version: "1.68.0"
tag: python/v1.68.0
date: 2026-11-27
releaseUrl: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.68.0
packageUrl: https://pypi.org/project/strands-agents/1.68.0/
entries:
  - { type: docs, breaking: false, scope: background-tasks, areas: [harness], title: "document SDK lifecycle and harness defaults", pr: 6534, prUrl: "https://github.com/strands-agents/harness-sdk/pull/6534", commit: "8de6bce", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/8de6bce", author: gautamsirdeshmukh }
  - { type: fix, breaking: false, scope: python, areas: [model, agent], title: "interrupt retry backoff on cancellation", pr: 6577, prUrl: "https://github.com/strands-agents/harness-sdk/pull/6577", commit: "9f47319", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/9f47319", author: JackYPCOnline }
  - { type: docs, breaking: false, scope: team, areas: [community], title: "add DEFAULTS.md, the bar for changing default behavior", pr: 6318, prUrl: "https://github.com/strands-agents/harness-sdk/pull/6318", commit: "f8964be", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/f8964be", author: lizradway }
  - { type: fix, breaking: false, scope: bedrock, areas: [model], title: "cache the conversation when a non-PDF document leads the last user message", pr: 6538, prUrl: "https://github.com/strands-agents/harness-sdk/pull/6538", commit: "0c77a61", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/0c77a61", author: jimbrub }
  - { type: feat, breaking: false, scope: models, areas: [model], title: "add acceptedMimeTypes to model info and omit unaccepted media in ModelProxy", pr: 6585, prUrl: "https://github.com/strands-agents/harness-sdk/pull/6585", commit: "78855ca", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/78855ca", author: strandly-the-agent }
  - { type: fix, breaking: false, scope: openai, areas: [model], title: "keep Responses reasoning across stateless turns", pr: 6604, prUrl: "https://github.com/strands-agents/harness-sdk/pull/6604", commit: "aea1da0", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/aea1da0", author: strandly-the-agent }
  - { type: feat, breaking: false, scope: interventions, areas: [interventions], title: "add a Dogwood authorization handler (python)", pr: 6586, prUrl: "https://github.com/strands-agents/harness-sdk/pull/6586", commit: "fd92867", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/fd92867", author: lizradway }
  - { type: fix, breaking: false, scope: steering, areas: [model, interventions], title: "use provider-safe structured output name", pr: 6605, prUrl: "https://github.com/strands-agents/harness-sdk/pull/6605", commit: "b31419c", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/b31419c", author: JackYPCOnline }
  - { type: feat, breaking: false, scope: bedrock, areas: [model], title: "place cache points for GPT-5.6+ on Converse, falling back to implicit caching (Python)", pr: 6607, prUrl: "https://github.com/strands-agents/harness-sdk/pull/6607", commit: "c10861c", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/c10861c", author: strandly-the-agent }
  - { type: fix, breaking: false, scope: models, areas: [devx, model], title: "declare model_state and dynamic_trailing_blocks on Model.stream()", pr: 4208, prUrl: "https://github.com/strands-agents/harness-sdk/pull/4208", commit: "0ed25ce", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/0ed25ce", author: CarSanoja }
  - { type: fix, breaking: false, scope: models, areas: [model], title: "keep Claude and Gemini signed reasoning with its vendor", pr: 6608, prUrl: "https://github.com/strands-agents/harness-sdk/pull/6608", commit: "9950313", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/9950313", author: strandly-the-agent }
  - { type: fix, breaking: false, scope: openai, areas: [model], title: "send Responses tool outputs before user text in the same message", pr: 6610, prUrl: "https://github.com/strands-agents/harness-sdk/pull/6610", commit: "7e57221", commitUrl: "https://github.com/strands-agents/harness-sdk/commit/7e57221", author: strandly-the-agent }
---
