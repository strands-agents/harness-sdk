---
name: port-from-langgraph
description: Migrate a LangGraph application to Strands Agents while preserving its external entrypoint, routing, persistence, interrupts, limits, and tracing. Use when the user asks to port, rewrite, compare, or plan a migration from LangGraph to Strands.
---

# Port a LangGraph application to Strands

Read [the shared Strands skill](../../SKILL.md) and [the LangGraph migration guide](../../references/port-from-langgraph.md) completely.

Inspect the existing graph before editing. Map model-calling nodes to agents, keep deterministic nodes deterministic, preserve caller-visible interfaces and IDs, and verify routing, resumption, interrupts, limits, and traces with representative cases. Call out any graph-join semantic difference that requires a design choice.
