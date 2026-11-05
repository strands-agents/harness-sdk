# SDK TypeScript v1.24.0

Released 2026-11-04
Release: https://github.com/strands-agents/harness-sdk/releases/tag/typescript/v1.24.0 · Package: https://www.npmjs.com/package/@strands-agents/sdk/v/1.24.0

## Features
- expose messages to BeforeInvocationEvent [hooks, language] (https://github.com/strands-agents/harness-sdk/pull/4370)
- render samples as documentation guides (https://github.com/strands-agents/harness-sdk/pull/5337)
- add a product-aware docs footer and last-updated dates (https://github.com/strands-agents/harness-sdk/pull/5432)
- let ClassifierStrategy route with any DecisionModel [multiagent, language] (https://github.com/strands-agents/harness-sdk/pull/5219)
- import versioned external docs (https://github.com/strands-agents/harness-sdk/pull/5666)
- place explicit cache points on GPT-5.6+ by default [context, model] (https://github.com/strands-agents/harness-sdk/pull/5418)

## Fixes
- send toolResult status to Amazon Nova models (TypeScript) [model] (https://github.com/strands-agents/harness-sdk/pull/5748)
- load @modelcontextprotocol/ext-tasks lazily so CommonJS loaders can import the SDK [mcp] (https://github.com/strands-agents/harness-sdk/pull/5732)
- retry transient request failures in VercelModel and GoogleModel [model] (https://github.com/strands-agents/harness-sdk/pull/5663)
- return an empty assistant message when a stream ends without a message start [model] (https://github.com/strands-agents/harness-sdk/pull/5762)
- detect Nova and OpenAI-style Bedrock context overflow errors (py + ts) [context, model] (https://github.com/strands-agents/harness-sdk/pull/5746)
- classify any HTTP 429 as throttling (TypeScript) [model] (https://github.com/strands-agents/harness-sdk/pull/5751)
- report maxTokens instead of toolUse when a Responses tool call is cut off (TypeScript) [model] (https://github.com/strands-agents/harness-sdk/pull/5749)

## Other
- load samples in documentation previews (https://github.com/strands-agents/harness-sdk/pull/5725)
- add S3VectorSearchStrategy integration test (TypeScript) [persistence] (https://github.com/strands-agents/harness-sdk/pull/5547)
- link box discussions and the box repo from the issue chooser (https://github.com/strands-agents/harness-sdk/pull/5729)
- bump @hono/node-server from 1.19.17 to 2.1.6 (https://github.com/strands-agents/harness-sdk/pull/5728)
- bump astral-sh/setup-uv from 10.3.2 to 10.3.3 (https://github.com/strands-agents/harness-sdk/pull/5717)
