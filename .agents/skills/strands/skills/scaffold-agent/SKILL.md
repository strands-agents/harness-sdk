---
name: scaffold-agent
description: Scaffold a new Strands agent or add Strands to an existing Python or TypeScript project. Use when the user asks to create, initialize, or start an agent with Strands, including choosing between Strands harness and the lower-level SDK.
---

# Scaffold a Strands agent

Read [the shared Strands skill](../../SKILL.md) and [the scaffold guide](../../references/scaffold-agent.md) completely, then create the smallest runnable agent that matches the project's language, package manager, model provider, and existing conventions.

Do not add tools, persistence, deployment, or infrastructure unless the requested first behavior needs them. Run the entrypoint when credentials are available; otherwise validate imports, types, and configuration without making a billable model call.
