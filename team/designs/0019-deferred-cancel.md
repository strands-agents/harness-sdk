# Unified Agent Cancellation

**Date**: 2026-07-27

## Overview

Give tools a public, first-class way to say "stop the agent loop", with an optional way to do so after the current tool batch finishes. This will ultimately deprecate all of the other mechanisms to stopping the agent loop, and be the unified way of doing so going forward.

The `stop` experimental tool is the immediate consumer, but the mechanism generalizes to any custom tool/hook/plugin.

## Problem

The SDK needs a way for a tool to signal "end the loop gracefully after this batch." The experimental `stop` tool is the primary consumer today. Neither of the two existing termination primitives fits:

- `agent.cancel()` is an immediate abort — sibling tools in the same batch get error results, and the loop exits at the next pre-tool checkpoint.
- The `stop_event_loop` flag (Python) and `AfterToolsEvent.endTurn` marker (TypeScript) are cooperative but live in `invocationState`, an untyped shared bag. Tools that want cooperative stop have to reverse-engineer undocumented internal keys.

This affects anyone building agents that need graceful termination from inside the agent (tool call, hook, plugin, middleware, etc).

### Current State

Two termination primitives ship today:

1. **`agent.cancel()`** — sets a flag (Python `threading.Event`, TS `AbortController`). Checked before tool execution, during model streaming, and between iterations. Pending tools in the batch receive "Tool execution cancelled" errors; the loop exits with `stopReason: 'cancelled'`. Designed for external callers (timeouts, disconnects).

2. **`invocation_state` flags** — the `stop` tool writes `request_state["stop_event_loop"] = True` (Python) or `invocationState[STOP_INVOCATION_STATE_KEY] = marker` (TypeScript). The event loop checks these only after the full batch completes, so siblings finish normally.

## Proposal

### Recommended: Consolidate agent loop stopping on `cancel()`

Add an optional flag `after_current_tools` to `agent.cancel()` that defers the cancellation until the current tool batch completes, plus an optional `message` argument that flows to the final `AgentResult` text. This will allow `agent.cancel()` to handle all of the existing use cases for stopping the agentic loop.

```python
# Python
def cancel(self, message: str | None = None, *, after_current_tools: bool = False) -> None:
```

```typescript
// TypeScript
public cancel(options?: { message?: string, afterCurrentTools?: boolean }): void
```

When the deferred flag is set, the agent stores the message and a `_deferred_cancel` bit, but does **not** trip the cancel signal / abort controller. The event loop's existing post-batch checkpoint (where `stop_event_loop` / `endTurn` are read today) checks `_deferred_cancel` instead, then falls through to the normal cancel path so termination produces `stopReason: 'cancelled'` with the stored message. When the flag is unset, `cancel()` behaves exactly as today.

The `stop` tool becomes a one-liner: `tool_context.agent.cancel(message, after_current_tools=True)`. The `stop_event_loop` / `STOP_INVOCATION_STATE_KEY` internal contracts are deleted, along with the TypeScript `WeakSet` + `AfterToolsEvent` hook.

**Pros:**
- Single public API for cancellation
- Sibling tools in the batch can complete normally.
- Cancel state lives on the agent, not in an untyped `invocationState` bag.
- Simplifies the TypeScript stop tool substantially (no hook installation, no marker tracking).

**Cons:**
- `cancel()` now has two modes, a small conceptual burden.
- Calling with the flag outside of a tool execution context silently behaves like immediate cancel at the next post-batch check, which may confuse callers.

### Alternative: dedicated `stop_after_tools()` method

Add a separate method — `stop_after_tools(message)` / `stopAfterTools(message)` — instead of overloading `cancel()`.

- **Pros:** Clear separation of intent; `cancel()` keeps its "always immediate" meaning.
- **Cons:** Two public methods for closely related behavior; users must discover a second name; "cancel is for external, stopAfterTools is for tools" is a leaky abstraction since either can be called from anywhere; grows the `LocalAgent` interface surface.

### Alternative: keep `invocationState` flags as internal plumbing

Leave `stop_event_loop` / `AfterToolsEvent.endTurn` in place and treat them as private.

- **Pros:** Already works and is tested; no public API change.
- **Cons:** Undocumented contract that custom tools still can't reuse cleanly; the TypeScript `WeakSet` + hook bridge stays; the `invocationState` bag continues to accumulate control-flow signals.

## Developer Experience

Basic usage — the shipped `stop` tool:

```python
from strands import Agent
from strands.experimental.tools.stop import stop

agent = Agent(model=model, tools=[stop, other_tools])
result = await agent.invoke_async("Complete this task and stop when done.")
# result.stop_reason == "cancelled"
# result.message contains the model's final assistant message
```

Custom "finish" tool:

```python
from strands.tools.decorator import tool
from strands.types.tools import ToolContext

@tool
async def finish(tool_context: ToolContext, summary: str) -> str:
    """Signal that all work is complete."""
    tool_context.agent.cancel(summary, after_current_tools=True)
    return summary
```

External cancellation (unchanged):

```python
agent.cancel()  # immediate — no after_current_tools flag
```

Sibling-tool behavior when the model requests `[save_file(...), stop("done")]` under the sequential executor: `save_file` runs to completion, then `stop` calls `cancel(msg, after_current_tools=True)`, then the batch completes, then the deferred cancel fires and the loop exits with `stopReason: 'cancelled'`.

## Additional Details

<details>
<summary>Extended context (optional)</summary>

**Migration.** The Python event loop check at `event_loop.py:842` (currently reads `request_state["stop_event_loop"]`) becomes a check of `agent._deferred_cancel` at the same location. The TypeScript post-batch path that today looks up `STOP_INVOCATION_STATE_KEY` on `invocationState` reads the equivalent agent field instead. In TypeScript, the post-batch check can either (a) directly build an `AgentResult` with `stopReason: 'cancelled'` and return, or (b) call `this.cancel(message)` to trip the abort controller and rely on the next iteration's `_throwIfCancelled` → `CancelledError` → catch. Option (a) avoids an extra round-trip and is preferred.

**Composition.** If two tools in the same batch both call the deferred cancel, the last write wins for the message. That policy matches how `invocationState` markers behave today and keeps the mental model simple; a first-wins policy would need the field to be written-once, which is only meaningful if the SDK ever runs tool batches in parallel.

</details>
