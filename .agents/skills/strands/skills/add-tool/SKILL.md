---
name: add-tool
description: Add a custom function tool to a Strands agent in Python or TypeScript. Use when the user asks to let a Strands agent call application code, an API, or another deterministic capability.
---

# Add a tool to a Strands agent

Read [the shared Strands skill](../../SKILL.md) and [the tool guide](../../references/add-tool.md) completely.

Inspect the existing agent and implement one narrow tool with a model-readable description and typed input schema. Keep secrets and caller identity out of model-visible parameters. Test the deterministic capability directly, then exercise an agent request that requires the tool when model credentials are available.
