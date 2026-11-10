# Middleware Design Decisions

## Hooks fire outside middleware

Hooks always fire outside the middleware chain. This means:

1. **Hooks always fire, even when middleware short-circuits.** If a middleware returns a cached result without calling `next()`, the Before/After hook pair for that stage still fires.

2. **Middleware retries are not observable to hooks.** If a middleware calls `next()` multiple times (e.g., retry-on-throttle), hooks see one invocation — not three. Internal retries are an implementation detail that should be observed using middleware.

### Ordering

First registered = outermost. Within each phase, handlers execute in registration order. Phases are fixed: all Input → all Output → all Wrap → terminal.

Phases partially solve the ordering problem by giving concrete semantics to each position (transform input, transform output, wrap execution). But since middleware is contributed by plugins, plugin registration order is still significant within a phase.

Long-term, if plugin ordering becomes a pain point, two approaches are on the table:

1. An explicit priority/order field on `addMiddleware` for fine-grained control.
2. Internal SDK phases (e.g., a retry phase) that the SDK uses but doesn't expose to customers.

Both are valid; which path(s) we take depends on whether we revisit "built-in SDK functionality built on plugins" as a pattern.

### Execution model

```
BeforeHookEvent          ← always fires
  → Input phase          ← transforms context
    → Output phase       ← wraps Wrap, transforms result on the way out
      → Wrap phase       ← full wrap, may retry/short-circuit
        → terminal       ← actual operation
AfterHookEvent           ← always fires (even on short-circuit)
```

### Functional style over mutation

Middleware is designed around passing transformed values forward rather than mutating shared state in place. Input handlers return a new context, Output handlers return a new result, and Wrap handlers pass a (potentially modified) context to `next()`. This contrasts with hooks, which mutate event properties in place.

We don't prevent mutation — the `agent` reference on the context is an escape hatch for advanced use cases — but the API nudges toward a functional style where each layer's effect is explicit in what it passes downstream.

### Consequences

- A rate-limiter middleware that short-circuits still triggers Before/After hooks — consumers monitoring call volume see the attempt even though the model was never called.
- A retry middleware that calls `next()` three times produces one hook pair, not three. If consumers need per-attempt observability, they register middleware (not hooks) at the same stage.
- Resume logic (calling `next()` with different args) is invisible to hooks by design. Hooks see the outermost call/result boundary.

## Telemetry records post-middleware state

Trace spans record the data _after_ middleware has transformed it — not the original pre-middleware input. For example, the model invoke span records the messages and system prompt that the model actually received, reflecting any transformations applied by `InvokeModelStage` middleware. This is intentional: spans should reflect what actually happened, not what was requested before middleware intervened.

## Middleware replaces hooks long-term

Middleware is intended to supersede hooks. The Input/Output phases already cover the same use cases as Before/After hook pairs but within a unified model. For one-off events without a before/after pair (e.g., MessageAdded), the migration path is less clear — but the goal is to consolidate on middleware where possible.

## Custom stages are internal

`createStage` is not exported from the public API. Only the three built-in stages are public.

## Middleware cannot access or modify model state

`modelState` is intentionally excluded from `InvokeModelContext`. The agent snapshots model state before the middleware chain runs and writes back the model provider's changes after the entire chain completes. Any mutations middleware makes to `agent.modelState` — whether before or after `next()` — are overwritten by this writeback.

We may revisit this later.

## Per-call model

`InvokeModelContext.model` is the model the terminal invokes, initialized from `agent.model`. Middleware can replace it for one call without mutating agent state; the selected model also determines the model ID recorded on the trace span:

```typescript
const modified = { ...context, model: otherModel }
```

## Metadata transport (future)

No metadata fields exist today, but the wrappers are designed to carry them. This section documents the intent so implementations stay consistent when metadata is added.

Middleware handlers could use metadata on the context and result wrappers to communicate across phases — for example, an Input handler annotating a request so that an Output handler can act on it. The context object carries Input-phase metadata; the result wrapper (`InvokeModelResult`, `MiddlewareResult`) carries Output-phase metadata.

## `AgentStreamStage` is internal

`AgentStreamStage` is not exported from the public API. The context for this stage passes `args` and `options` by reference, but the correct contract (copy vs. reference, readonly enforcement) hasn't been finalized. Rather than ship an inconsistent surface, we're keeping it internal until we decide whether `args` should be deep-copied (consistent with `InvokeModelStage.messages`) or remain a reference (simpler, but surprising given the other stages' guarantees).

## `invocationState` is shared by reference

`invocationState` is not copied. Tools and hooks write to it, and those mutations must appear on `AgentResult.invocationState`. The SDK should never write to it directly — the key space belongs to the caller.

## Middleware cannot resume interrupts

`AgentStreamStage` middleware cannot currently resume tool-level interrupts. Interrupt resolution (`_interruptState.resume()`) runs in `stream()`'s outer loop, outside the middleware chain. When a tool-level interrupt fires, `_stream` catches the `InterruptError` internally and returns a normal `AgentResult` with `stopReason: 'interrupt'` — the middleware sees the result but cannot re-enter the stream with interrupt responses.

To programmatically resume interrupts within a single invocation, use `AfterInvocationEvent.resume` in a hook. A future enhancement could add a resume mechanism to `AgentStreamResult` or `AgentStreamContext` so middleware can signal re-entry with interrupt responses.

---

# Behavioral Requirements

Each requirement below is verified by tests and should hold across language implementations.

## Registry Composition

### No handlers (fast path)

- When no handlers are registered for a stage, the terminal runs directly
- Events and result from the terminal pass through unchanged

### Wrap handlers

- A passthrough handler forwards all events and the result unchanged
- Handlers can modify the context before calling `next`; the terminal receives the modified context
- Multiple handlers each modifying context accumulate changes (chained modification)
- Handlers can short-circuit by producing a result without calling `next`; the terminal is never invoked
- Handlers can transform the result
- Handlers can filter events (yield only events matching a predicate)
- Handlers can inject events before or after the inner chain's events
- Handlers can retry by calling `next` multiple times (e.g., on transient errors)

### Composition order

- First registered = outermost (executes first on the way in, last on the way out)
- Multiple handlers all observe events flowing through the chain

### Input phase

- Input handlers transform the context before the Wrap chain runs
- Input handlers can be sync or async
- Input runs before Wrap regardless of registration order
- Multiple Input handlers compose in registration order (each sees the previous output)

### Output phase

- Output handlers transform the result after the Wrap chain completes
- Output handlers can be sync or async
- Output handlers do not affect streaming events (only the result)
- Output runs after Wrap regardless of registration order

### Phase ordering

- Execution order is always: Input → Wrap → Output, regardless of registration order

### Removal

- `remove()` stops a handler from firing on subsequent invocations
- `remove()` only removes the first occurrence when a handler is registered multiple times
- `remove()` is a no-op for a handler that was never registered
- Removing an adapted Input/Output handler works via the reference returned at registration

### Error propagation

- Errors from the terminal propagate through middleware to the caller
- Errors from middleware propagate to the caller
- Middleware can catch and re-throw a different error (error transformation)
- `InterruptError`/`InterruptException` propagates through passthrough middleware without being swallowed

### Generator cleanup (finally guarantees)

- When the terminal throws, middleware `finally` blocks run
- When multiple middleware are stacked, all `finally` blocks run in reverse order (inner first)
- When the consumer abandons iteration (close/aclose), middleware `finally` blocks run
- Multi-layer `finally` blocks all run on close (not just the outermost)

---

## InvokeModelStage

### Basic behavior

- Middleware handler is invoked on every model call
- Handler receives context with correct fields (agent, messages, systemPrompt, toolSpecs, toolChoice, invocationState)
- A passthrough handler does not alter agent behavior
- Multiple middleware compose in registration order

### Context transformation

- Middleware can modify `systemPrompt` and inner layers see the modification
- Middleware can modify `toolSpecs` and inner layers see the modification
- Context modification does not mutate the original context object

### Short-circuit

- Middleware can return a synthetic result without calling `next`
- When middleware short-circuits, the model is NOT called
- The short-circuited result is used as the model call result

### Hooks boundary

- `BeforeModelCallEvent` fires before middleware executes
- `AfterModelCallEvent` fires after middleware completes
- Both hooks fire even when middleware short-circuits

### Result transformation

- Output middleware can transform the result (stopReason, message, usage, metrics)
- The transformed result is authoritative — it is what `AgentResult` returns to the caller
- The transformed result is what gets appended to `agent.messages`
- A middleware that changes `stopReason` from `tool_use` to `end_turn` prevents tool dispatch

### Model state isolation

- `modelState` is not exposed on the middleware context
- The agent snapshots model state before the chain and writes back provider changes after
- Middleware cannot read or write model state, even via the `agent` escape hatch (writes are overwritten)

### Phase ordering at agent level

- Input → Wrap → Output execution order holds regardless of registration order at the agent level

### Use cases

- Retry on transient error (middleware catches error, calls `next` again)
- Plugin can register middleware via `initAgent`/`init_agent`

---

## ExecuteToolStage

### Basic behavior

- Middleware handler is invoked on every tool execution
- Handler receives context with correct fields (agent, tool, toolUse, invocationState)
- A passthrough handler does not alter agent behavior
- Multiple middleware compose in registration order

### Context transformation

- Middleware can modify tool input and the tool receives modified arguments
- Context modification does not mutate the original context object

### Short-circuit

- Middleware can return a mock result without calling `next`
- When middleware short-circuits, the real tool function is NOT called
- The short-circuited result is used in the conversation

### Hooks boundary

- `BeforeToolCallEvent` fires before middleware executes
- `AfterToolCallEvent` fires after middleware completes
- Both hooks fire even when middleware short-circuits
- `AfterToolCallEvent.result` contains the middleware-provided result on short-circuit

### Input/Output phases

- Input phase transforms the tool context before execution
- Output phase transforms the tool result after execution

### Error handling

- Errors from the tool propagate through middleware

### Use cases

- Caching plugin: first call executes, second call with same input returns cached result

---

## Middleware-Initiated Interrupts

### ExecuteToolStage interrupts

- Calling `context.interrupt(name)` with no prior response throws/raises and halts the agent
- On resume (user provides response), `context.interrupt(name)` returns the response (wrapped for forward-compat)
- Providing a preemptive response parameter skips the interrupt entirely
- When middleware interrupts, the tool does NOT execute
- Interrupt ID includes the tool use ID (deterministic and scoped)
- The interrupt source is `'middleware'` (distinguishes from hook/tool interrupts)
- The interrupt is registered in the agent's interrupt state
- Copying/spreading the context preserves the `interrupt()` function

### AgentStreamStage interrupts

- Calling `context.interrupt(name)` with no prior response throws/raises and halts the agent
- On resume, `context.interrupt(name)` returns the response
- Interrupt ID uses the `agentStream` namespace
- The interrupt source is `'middleware'`
- InterruptEvent is yielded on the stream
- After resuming to a non-tool completion, the interrupt state is cleared so the next fresh invocation is accepted
- Resuming does not clobber a pending tool interrupt: if a tool interrupt is outstanding and its resume is cancelled before the tool runs, that interrupt survives and stays resumable
- The stop reports every still-unanswered interrupt, not only the one just raised (so a partially-answered set is fully visible to the caller)
