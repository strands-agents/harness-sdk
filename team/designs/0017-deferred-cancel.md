# Deferred Cancellation

**Status**: Proposed

**Date**: 2026-07-27

**Issue**: TBD

## Problem

The SDK needs a mechanism for tools to signal that the agent loop should stop after the current tool batch completes. The `stop` experimental tool is the primary consumer: it allows a model to gracefully end the loop with an optional final message. The question is how to implement this without introducing a one-off flag that only one tool uses, while preserving cooperative semantics (sibling tools in the same batch run to completion).

### Current State

There are two termination primitives in the SDK today:

1. **`agent.cancel()`** — an immediate abort signal. Sets a flag (Python `threading.Event` / TypeScript `AbortController`) that the event loop checks at multiple points:
   - Before tool execution (per-tool in sequential executor)
   - During model streaming
   - After tool execution, before the next model call

   When triggered, pending tools in the batch receive error results ("Tool execution cancelled") and the loop exits with `stopReason: 'cancelled'`. This is designed for external callers (timeouts, user-initiated abort, web request disconnects).

2. **`invocation_state` flags** — the `stop_event_loop` flag (Python) and `AfterToolsEvent.endTurn` marker (TypeScript) are checked only after the entire tool batch completes. They provide cooperative semantics: all tools finish, then the loop exits. However, they require tools to write to `invocationState` (a mutable shared bag) and the event loop to check a one-off key.

Neither is right for a tool-initiated graceful stop:

- `cancel()` is too aggressive — it aborts sibling tools mid-batch and uses pre-tool-execution checkpoints that break cooperative guarantees.
- `invocationState` flags work cooperatively but are ad-hoc internal machinery that the `stop` tool shouldn't depend on. They couple the tool to undocumented event loop internals and don't compose (what if two tools both want to signal "stop after this batch"?).

### Paper cuts

- **`stop_event_loop` / `STOP_INVOCATION_STATE_KEY` are undocumented internal state.** They only exist to serve the stop tool but live in the general-purpose `invocationState` bag, polluting it. TypeScript additionally needed a `WeakSet`-tracked hook installation pattern to bridge from `invocationState` to `endTurn`.
- **No way for a tool to say "stop after the batch" without touching internals.** A user writing a custom "done" tool must reverse-engineer the same flag pattern.
- **`cancel()` lacks gradation.** It's all-or-nothing — there's no way to cancel cooperatively through the public API.

## Goals and Non-Goals

**Goals:**
- A single public API for tool-initiated graceful stop: `agent.cancel(message, { afterCurrentTools: true })`
- Cooperative semantics: sibling tools in the same batch run to completion
- The cancel message flows through to the `AgentResult` as the final assistant text
- Cross-SDK parity (Python and TypeScript)
- Remove the need for `stop_event_loop` / `STOP_INVOCATION_STATE_KEY` internal flags
- Composable: multiple tools calling deferred cancel in the same batch produces one stop (last message wins, or first — pick a policy)

**Non-Goals:**
- Changing the behavior of immediate `cancel()` (no deferred flag) — it stays an aggressive abort
- Providing a way to "un-cancel" a deferred cancel from another tool in the same batch
- Cancellation with custom `stopReason` values (it remains `'cancelled'`)

## Proposal

### Recommended: `afterCurrentTools` option on `cancel()`

Add an optional second parameter to `agent.cancel()` that defers the cancellation until after the current tool batch completes.

#### Python

```python
def cancel(self, message: str | None = None, *, after_current_tools: bool = False) -> None:
```

When `after_current_tools=True`:
- Stores `message` in `self._deferred_cancel_message: str | None`
- Sets `self._deferred_cancel: bool = True`
- Does **not** set `self._cancel_signal`

The event loop checks `agent._deferred_cancel` at the post-batch point (where `stop_event_loop` is currently checked). When found:
- Clears `_deferred_cancel`
- Calls `self.cancel(self._deferred_cancel_message)` to set the immediate signal
- The existing `_cancel_signal.is_set()` check (immediately after) fires and exits with `stopReason: 'cancelled'`

When `after_current_tools=False` (default, the current behavior):
- Sets `_cancel_signal` immediately as today
- Stores the message for use in cancellation text

#### TypeScript

```typescript
public cancel(message?: string, options?: { afterCurrentTools?: boolean }): void
```

When `afterCurrentTools: true`:
- Stores the message in `private _deferredCancelMessage: string | undefined`
- Sets `private _deferredCancel = true`
- Does **not** abort the `AbortController`

The agent loop checks `this._deferredCancel` after the `AfterToolsEvent` fires (the same position where `endTurn` is currently checked). When found:
- Clears `_deferredCancel`
- Calls `this.cancel(this._deferredCancelMessage)` to abort immediately
- The next loop iteration's `_throwIfCancelled()` fires and the `CancelledError` catch block produces the result with `stopReason: 'cancelled'`

Actually, a simpler path for TypeScript: at the post-batch check, directly build the `AgentResult` with `stopReason: 'cancelled'` and return (mirroring what the `endTurn` path does today but with `'cancelled'` instead of `'endTurn'`). This avoids a round-trip through abort → next-cycle → throw → catch.

#### Stop tool usage

```python
# Python
async def stop_tool(tool_context: ToolContext, message: str | None = None) -> str:
    final_message = _validate_message(message, max_message_length)
    tool_context.agent.cancel(final_message, after_current_tools=True)
    return final_message
```

```typescript
// TypeScript
callback: (input, context) => {
  const message = input.message ?? DEFAULT_STOP_MESSAGE
  context.agent.cancel(message, { afterCurrentTools: true })
  return message
}
```

**Pros:**
- Single public API surface — tools call `cancel()` with an option, no internal flags
- Cooperative semantics preserved: sibling tools complete normally
- Composable with existing cancel infrastructure (the deferred cancel eventually becomes an immediate cancel)
- Clean separation: the `cancel()` method owns all cancellation state, not `invocationState`
- Easily discoverable: autocomplete on `cancel()` shows the option

**Cons:**
- Adds complexity to `cancel()` — it now has two modes
- The deferred state (`_deferredCancel` + `_deferredCancelMessage`) is additional agent-level mutable state
- The event loop still needs a check at the post-batch point (just checking a different field)
- `afterCurrentTools` is only meaningful during tool execution — calling it outside that context silently behaves like immediate cancel on the next invocation

### Alternative: Dedicated `stopAfterTools()` method

Instead of overloading `cancel()`, add a separate method:

```python
def stop_after_tools(self, message: str | None = None) -> None:
```

```typescript
public stopAfterTools(message?: string): void
```

**Pros:**
- Clear separation of intent — `cancel()` is always immediate, `stopAfterTools()` is always deferred
- No confusion about what `cancel()` does

**Cons:**
- Two public methods for conceptually related behavior (both terminate the loop)
- Users must discover a second method rather than seeing options on the one they already know
- Harder to explain when to use which — "cancel is for external, stopAfterTools is for tools" is a leaky abstraction since either could be called from anywhere
- Adds to `LocalAgent` interface surface area

### Alternative: Keep `invocationState` flags as an internal mechanism

Leave the current `stop_event_loop` / `AfterToolsEvent.endTurn` approach in place and accept it as internal plumbing.

**Pros:**
- Already works and is tested
- No changes to the public `cancel()` API
- Proven cooperative semantics

**Cons:**
- Undocumented internal contract — tools depend on specific `invocationState` keys
- TypeScript needed a `WeakSet` + hook pattern to bridge the gap — complex for what should be "set flag, loop stops"
- Not composable or discoverable — a user writing a custom stop tool must copy the same internal pattern
- The `invocationState` bag becomes a dumping ground for control flow signals

## Developer Experience

### Basic usage — stop tool

```python
from strands import Agent
from strands.experimental.tools.stop import stop

agent = Agent(model=model, tools=[stop, other_tools])
result = await agent.invoke_async("Complete this task and stop when done.")
# result.stop_reason == "cancelled"
# result.message contains the model's final assistant message
```

### Custom stop tool

```python
from strands.tools.decorator import tool
from strands.types.tools import ToolContext

@tool
async def finish(tool_context: ToolContext, summary: str) -> str:
    """Signal that all work is complete."""
    tool_context.agent.cancel(summary, after_current_tools=True)
    return summary
```

### External cancellation (unchanged)

```python
# Still immediate — no after_current_tools flag
agent.cancel()  # or agent.cancel("Timeout reached")
```

### Sibling tools complete

```python
# Model requests: [save_file(...), stop("All done")]
# With sequential executor:
#   1. save_file runs to completion ✓
#   2. stop runs, calls cancel(msg, after_current_tools=True) ✓
#   3. Batch completes, deferred cancel fires
#   4. Loop exits with stopReason='cancelled'
```

## Consequences

**What becomes easier:**
- Writing custom "done" / "stop" / "finish" tools — just call `cancel(msg, after_current_tools=True)`
- Understanding the stop mechanism — it's one method with an option, not hidden flags
- Maintaining the stop tool — no hook installation, no WeakSet tracking, no marker keys

**What becomes harder or riskier:**
- `cancel()` now has two modes, which adds a small conceptual burden
- The deferred cancel state must be cleared correctly on invocation boundaries (same as today's flag, just on a different field)
- If a tool calls `cancel(msg, after_current_tools=True)` outside of a tool execution context (e.g., in a hook), the deferred cancel just fires at the next post-batch check — which might be confusing if there are no tools running

**Migration:**
- The existing `stop_event_loop` check in Python can be replaced with a `_deferred_cancel` check at the same location
- The TypeScript `endTurn` path can be replaced similarly
- The stop tool's tests simplify to verifying that `cancel()` is called with the right arguments

## Willingness to Implement

Yes — the implementation is straightforward and localized to the agent class, event loop post-batch checks, and the stop tool itself.
