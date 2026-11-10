---
sdk: sdk
language: typescript
version: "0.2.1"
tag: v0.2.1
date: 2026-02-05
releaseUrl: https://github.com/strands-agents/sdk-typescript/releases/tag/v0.2.1
packageUrl: https://www.npmjs.com/package/@strands-agents/sdk/v/0.2.1
entries:
  - { type: other, breaking: false, scope: null, areas: [], title: "add sqs arn from secret", pr: 459, prUrl: "https://github.com/strands-agents/sdk-typescript/pull/459", commit: "4e7494c", commitUrl: "https://github.com/strands-agents/sdk-typescript/commit/4e7494c", author: afarntrog }
  - { type: other, breaking: false, scope: null, areas: [], title: "Add always condition to finalize step, fix audit, and update bash test to use real path", pr: 465, prUrl: "https://github.com/strands-agents/sdk-typescript/pull/465", commit: "3a991c6", commitUrl: "https://github.com/strands-agents/sdk-typescript/commit/3a991c6", author: Unshure }
  - { type: other, breaking: false, scope: null, areas: [], title: "Add sqs arn", pr: 470, prUrl: "https://github.com/strands-agents/sdk-typescript/pull/470", commit: "6556e63", commitUrl: "https://github.com/strands-agents/sdk-typescript/commit/6556e63", author: afarntrog }
  - { type: feat, breaking: false, scope: model, areas: [], title: "add text only implementation of gemini model", pr: 426, prUrl: "https://github.com/strands-agents/sdk-typescript/pull/426", commit: "ebe5f30", commitUrl: "https://github.com/strands-agents/sdk-typescript/commit/ebe5f30", author: dbschmigelski }
  - { type: feat, breaking: true, scope: hooks, areas: [], title: "add retry property to AfterToolCallEvent", pr: 493, prUrl: "https://github.com/strands-agents/sdk-typescript/pull/493", commit: "d5d6e8f", commitUrl: "https://github.com/strands-agents/sdk-typescript/commit/d5d6e8f", author: dbschmigelski }
  - { type: fix, breaking: false, scope: null, areas: [], title: "add @google/genai to devDependencies for TypeScript compilation", pr: 502, prUrl: "https://github.com/strands-agents/sdk-typescript/pull/502", commit: "7363419", commitUrl: "https://github.com/strands-agents/sdk-typescript/commit/7363419", author: mkmeral }
---

## Major Features

### Google Gemini Model Provider - [PR#426](https://github.com/strands-agents/sdk-typescript/pull/426)

A new `GeminiModel` provider brings native Google Gemini support to the TypeScript SDK. It integrates with the `@google/genai` SDK and supports streaming text responses with the standard `ModelStreamEvent` interface, configurable model parameters, and API key authentication via constructor option or the `GEMINI_API_KEY` environment variable. You can also pass a pre-configured `GoogleGenAI` client instance. The default model is `gemini-2.5-flash`. This initial release supports text content streaming, with tool calling planned for a follow-up.

```typescript
import { GeminiModel } from 'strands-agents/models/gemini'
import { Agent } from 'strands-agents'

// With API key (or set GEMINI_API_KEY env var)
const model = new GeminiModel({
  apiKey: 'your-api-key',
  modelId: 'gemini-2.5-flash',
  params: { temperature: 0.7, maxOutputTokens: 1024 },
})

const agent = new Agent({ model })
const result = await agent.invoke('What is the capital of France?')

// Or pass a pre-configured client
import { GoogleGenAI } from '@google/genai'
const client = new GoogleGenAI({ apiKey: 'your-api-key' })
const model2 = new GeminiModel({ client })
```

### Tool Call Retry via Hooks - [PR#493](https://github.com/strands-agents/sdk-typescript/pull/493)

Hooks can now request tool execution retries through a new `retry` property on `AfterToolCallEvent`, bringing feature parity with the Python SDK. When a hook sets `event.retry = true`, the agent discards the current result from conversation history and re-executes the tool, emitting a fresh `BeforeToolCallEvent` on each attempt. Retries work both for error recovery and for success-based re-evaluation when the result doesn't meet criteria. **Breaking change:** `AfterModelCallEvent.retryModelCall` has been renamed to `AfterModelCallEvent.retry` for consistency.

```typescript
import { Agent } from 'strands-agents'
import { AfterToolCallEvent } from 'strands-agents/hooks/events'

const agent = new Agent({ model, tools: [myTool] })

let attempts = 0
agent.hooks.addCallback(AfterToolCallEvent, (event: AfterToolCallEvent) => {
  attempts++
  if (event.error && attempts < 3) {
    event.retry = true // Tool will be re-executed
  }
})
```

> **Migration note:** Rename `afterModelCallEvent.retryModelCall = true` to `afterModelCallEvent.retry = true`.

---

## Bug Fixes

* **Add `@google/genai` to devDependencies** - [PR#502](https://github.com/strands-agents/sdk-typescript/pull/502)
  Fixed CI build failures by adding the `@google/genai` package to devDependencies, ensuring TypeScript compilation succeeds for the new Gemini model provider.

---
