# SDK Python v1.64.0

Released 2026-11-04
Release: https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.64.0 · Package: https://pypi.org/project/strands-agents/1.64.0/

## Features
- add S3 Vectors search strategy for S3Storage in Python [persistence] (https://github.com/strands-agents/harness-sdk/pull/5552)
- render samples as documentation guides (https://github.com/strands-agents/harness-sdk/pull/5337)
- add SystemOneDecisionModel for Jev and decisionapi.net [model] (https://github.com/strands-agents/harness-sdk/pull/5590)
- add a product-aware docs footer and last-updated dates (https://github.com/strands-agents/harness-sdk/pull/5432)
- import versioned external docs (https://github.com/strands-agents/harness-sdk/pull/5666)
- place explicit cache points on GPT-5.6+ by default [context, model] (https://github.com/strands-agents/harness-sdk/pull/5418)

## Fixes
- send toolResult status to Amazon Nova models (Python) [model] (https://github.com/strands-agents/harness-sdk/pull/5747)
- raise ModelThrottledException when the model container returns 429 [model] (https://github.com/strands-agents/harness-sdk/pull/5750)
- detect Nova and OpenAI-style Bedrock context overflow errors (py + ts) [context, model] (https://github.com/strands-agents/harness-sdk/pull/5746)

## Other
- load samples in documentation previews (https://github.com/strands-agents/harness-sdk/pull/5725)
- link box discussions and the box repo from the issue chooser (https://github.com/strands-agents/harness-sdk/pull/5729)
- bump astral-sh/setup-uv from 10.3.2 to 10.3.3 (https://github.com/strands-agents/harness-sdk/pull/5717)
