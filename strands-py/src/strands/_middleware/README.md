# Python Middleware

This implementation follows the behavioral spec defined in `strands-ts/src/middleware/README.md` with the following intentional divergences:

## Scope

All three stages are implemented: `InvokeModelStage`, `ExecuteToolStage`, and `AgentStreamStage`.
`AgentStreamStage` is internal (see below), matching the TS SDK.

## Result encoding

TypeScript uses async generator `return` values propagated via `yield*`. Python async generators cannot `return` values.

Instead, the **last yielded event IS the result**. This matches the existing Python SDK convention where `ModelStopReason` is the last event from `stream_messages()`, `ToolResultEvent` is the last from tool execution, etc. The middleware chain is transparent — events (including the result event) flow through naturally. There is no separate sentinel type.

Pass-through is:
```python
async def passthrough(context, next_fn):
    async for event in next_fn(context):
        yield event
```

Short-circuit yields the result event directly:
```python
async def cached(context, next_fn):
    yield ModelStopReason(stop_reason="end_turn", message=cached_msg, usage=usage, metrics=metrics)
```

Output phase handlers take and return a `MiddlewareResult` wrapping the result event.
The registry wraps the result event before calling the handler and unwraps the returned
wrapper back into the stream, so Wrap handlers and the event-loop integration still see a
plain result event. Use `result.replace(value=...)` to produce the modified wrapper:
```python
def output_handler(result):  # result: MiddlewareResult
    stop_reason, message, usage, metrics = result.value["stop"]
    return result.replace(
        value=ModelStopReason(stop_reason="custom", message=message, usage=usage, metrics=metrics),
    )
```

Only the **Output** phase uses the wrapper. Wrap and Input handlers deal in raw
events/contexts.

The wrapper currently holds only `value`. Input already has a wrapper (the context
dataclass), so `MiddlewareResult` gives Output the same extensibility surface for future
metadata. Since Python async generators cannot return values, Wrap-phase metadata would
be yielded as events into the stream rather than attached to a return value. See the TS
spec ("Metadata transport") for rationale.

If we later want per-stage typed results (e.g., `InvokeModelResult` with named fields
instead of an opaque `.value`), those can derive from `MiddlewareResult`. Existing Output
handlers that accept `MiddlewareResult` continue to work; new handlers can narrow to the
subclass for typed access. This is a two-way door — no migration required.

## Per-stage result types

Each stage's result is the last event its chain yields. TypeScript wraps these in named
result objects (`InvokeModelResult`, `ExecuteToolResult`); Python uses the underlying event
directly, so there is no equivalent wrapper class:

- `InvokeModelStage` → `ModelStopReason` (the last event from `stream_messages()`).
- `ExecuteToolStage` → `ToolResultEvent` (the last event from tool execution). It already
  carries both `tool_result` and `exception`, so a separate `ExecuteToolResult` is redundant.
- `AgentStreamStage` → `EventLoopStopEvent` (the last event from an invocation pass). It carries
  the full stop tuple (`stop_reason`, `message`, `metrics`, ...) the `AgentResult` is built from,
  so a separate `AgentStreamResult` is redundant. Since middleware may yield trailing events
  *after* the stop event, `stream_async` selects the last `EventLoopStopEvent` — not the last
  event overall — and raises `RuntimeError` if the chain drops it entirely.

Short-circuiting a tool call yields a `ToolResultEvent` directly:
```python
async def cached(context, next_fn):
    yield ToolResultEvent({"toolUseId": context.tool_use["toolUseId"], "status": "success", ...})
```

## Middleware-initiated interrupts (ExecuteToolStage + AgentStreamStage)

`ExecuteToolContext.interrupt(name, reason=..., response=...)` and
`AgentStreamContext.interrupt(...)` let middleware gate execution behind a human-in-the-loop
approval, mirroring the TS `MiddlewareInterruptible` contract. Both return a
`MiddlewareInterruptResult` (a wrapper around `response`, kept for forward-compatibility with
TS) on resume, and raise `InterruptException` on first call. `InvokeModelStage` does **not**
support interrupts, matching TS (only `ExecuteToolContext` and `AgentStreamContext` are
`MiddlewareInterruptible`).

`interrupt()` is **read-only** with respect to interrupt state — it inspects prior responses
but never registers the interrupt itself. The executor's `InterruptException` handler (the tool
executor for `ExecuteToolStage`, the agent run loop for `AgentStreamStage`) is the single
registration site. This matches TS, where middleware interrupts deliberately never write to
interrupt state (unlike hook/tool interrupts, which self-register). The read-only resolution
logic is shared by both contexts (`_resolve_middleware_interrupt`).

A halted (or partially executed) tool call has no result, so interrupts must not be treated as
the stage result:

- **Middleware-initiated** (`context.interrupt()`) raises `InterruptException`, which unwinds
  the chain past the Output adapter; `ToolExecutor._stream` catches it and registers the
  interrupt.
- **Tool-originated** (a `ToolInterruptEvent` from `tool.stream()`, including sub-agent
  interrupts via `_AgentAsTool`) flows through the chain as a normal event. The Output adapter
  skips any event matching the `InterruptControlEvent` protocol (a truthy `is_interrupt`) when
  picking the positional result, so it is never mistaken for the result; `_stream` registers
  its interrupts and short-circuits. The protocol keeps the stage-agnostic registry from
  importing tool-specific event types.

Either way `_stream` surfaces a single `ToolInterruptEvent` to the event loop.

For **`AgentStreamStage`**, `Agent._run_loop` catches the `InterruptException`, registers and
activates the interrupt, and yields a terminal `EventLoopStopEvent("interrupt", ...)` — so the
`AgentResult` looks identical to a tool interrupt. (TS yields a distinct `InterruptEvent`; Python
has no per-interrupt event, so this reuses how tool interrupts already surface.)

**Hazard: `except Exception` swallows interrupts.** `InterruptException` subclasses `Exception`
(not `BaseException`). A middleware that wraps `next_fn` or `interrupt()` in a broad
`try/except Exception` — common in error-transforming or retry middleware — will silently
catch the interrupt and turn a human-in-the-loop pause into a caught error, with no diagnostic.
This is inherent to the SDK-wide interrupt design (the same is true for hooks/tools). Middleware
that must catch tool errors should re-raise `InterruptException` (and `CancelledError`, a
`BaseException` that a bare `except Exception` already lets through).

Interrupt IDs are `v1:middleware_execute_tool:<toolUseId>:<uuid5(name)>` for tool middleware and
`v1:middleware_agent_stream:<uuid5(name)>` for agent-stream middleware — deterministic across
resumes so a resumed response resolves the same interrupt. This follows Python's `v1:`
interrupt-id scheme (`v1:tool_call:...`, `v1:before_tool_call:...`) and its convention of hashing
the name with `uuid5`. (TS uses a different, unversioned literal — id *strings* are opaque per-SDK
handles and are not compared across SDKs, so only the within-SDK scheme matters.)

The tool id embeds the `toolUseId`, so it is unique per tool call. The agent-stream id has **no**
scoping component — it is a pure hash of `name`, identical in every pass and in every agent. What
keeps it collision-safe within one agent is the lifecycle, not the id: only one agent-stream
interrupt is live at a time and the state is deactivated (clearing `interrupts`) before the next
pass could reuse the name. **Across agents it is not safe**: two agents (e.g. `Graph`/`Swarm`
nodes) running the same reusable gate middleware produce the same id, and an orchestrator that
aggregates interrupts into a flat id-keyed dict can cross-wire one human approval to both. This is
an identity-layer gap the middleware can't resolve on its own (a plain `Agent`'s `agent_id`
defaults to `"default"`), tracked as a follow-up rather than fixed here. Until then, a reusable
agent-stream gate should not be shared across multiple agents that interrupt on the same `name`.

### No interrupt `source`

The TS spec tags middleware interrupts with `source='middleware'` (distinguishing them from
`hook`/`tool` interrupts). Python's `Interrupt` type has no `source` field at all — not for
hooks, tools, or middleware — so there is nothing for the middleware path to set. This is a
pre-existing, SDK-wide gap in the Python interrupt system rather than a middleware-specific
choice; adding it means changing the core `Interrupt` type and every hook/tool call site, which
is out of scope here. Consumers currently disambiguate by the interrupt id prefix
(`v1:middleware_execute_tool:...` / `v1:middleware_agent_stream:...`) instead.

## AgentStreamStage context fields

Unlike `InvokeModelContext`/`ExecuteToolContext`, which mirror their TS counterparts field-for-field
(modulo `camelCase`↔`snake_case`), `AgentStreamContext` genuinely renames: TS exposes `args` +
`options`, Python exposes `messages` (the input for this pass, already appended to history) +
`invocation_state` (the per-invocation state dict). The rename reflects what Python's `_run_loop`
actually threads through the pass. Note this drops the extra fields TS's `options` (`InvokeOptions`)
carries — `cancel_signal`, structured-output config, `limits` — from the agent-stream context;
those remain reachable on `agent` but are not surfaced as first-class context fields here. Since
the stage is internal, that surface is not yet finalized.

`ExecuteToolContext.cancel_signal` is executor-owned: middleware can observe it, but replacing it
via `dataclasses.replace()` does not change the signal the tool receives — the executor hands the
tool the agent's own signal, not the context's copy (matching TS, where the field is `readonly`).

### Transforming `messages` vs `invocation_state`

The two agent-stream context fields have **different** transform semantics, and only one is fully
transformable via `dataclasses.replace()`:

- **`invocation_state`** — fully transformable. The terminal reads `ctx.invocation_state`, so a
  handler returning `replace(context, invocation_state=...)` reaches the event loop and the model.
- **`messages`** — shared by reference for **in-place** edits only. Mutating a message in place
  (`context.messages[0]["content"] = ...`) is visible to the model because those same dict objects
  are already in `agent.messages`. But `replace(context, messages=[...])` is **silently dropped**:
  the pass's input messages are appended to `agent.messages` *before* the middleware chain runs,
  and the terminal streams against `agent.messages`, not `ctx.messages`.

This asymmetry is deliberate, and it is a consequence of *when* history is appended, which is a
lifecycle event — not just a middleware concern. Appending the input fires `MessageAddedEvent`
**before** the AgentStreamStage chain, and it fires **even when a middleware short-circuits** (the
user turn always lands in history and hooks always observe it). Moving the append into the terminal
to make `replace(messages=...)` work would change that hook timing for *every* agent (middleware or
not) and would stop `MessageAddedEvent` firing on short-circuit — an observable behavior change we
chose not to make. Middleware that must rewrite the input for the model should mutate `messages` in
place, or use an `InvokeModelStage` Input handler (whose `messages` *are* transformable via
`replace()`, since that stage's terminal reads them from the context).

**Divergence from TS.** TypeScript makes the opposite trade-off: it appends the input *inside*
the chain terminal (`_streamCore` → `_stream` normalizes and appends `ctx.args`), so there a
`{...ctx, args}` swap *does* reach the model — but as a direct consequence, TS's short-circuit
does **not** append the user message and does **not** fire its `MessageAddedEvent` (the terminal
never runs), and that hook fires *inside* the chain rather than before it. Python keeps the append
before the chain so the user turn and its `MessageAddedEvent` are unconditional (including on
short-circuit), at the cost of `replace(messages=...)` not being honored. Both SDKs keep
`AgentStreamStage` internal partly because this input contract is not yet finalized. (In both,
`BeforeInvocationEvent`/`AfterInvocationEvent` bracket the chain from outside and fire regardless.)

## AgentStreamStage interrupt resume

Python interrupts were tool-only: the event loop keyed resume behavior on interrupt state being
`activated` alone. Tool replay state now lives in the typed `PendingToolExecution` field. An
`AgentStreamStage` interrupt activates interrupt state **without** a pending tool execution, so an
agent-stream resume falls through to a normal model call while the middleware resolves its own
interrupt (returning the response) before calling `next()`.

Because an agent-stream interrupt has no tool cycle to deactivate the state afterward, the run
loop deactivates interrupt state when the pass completes without one. The guard is narrow — it
fires only when the state is activated, the pass did not stop on an interrupt, **and** no tool
execution is pending (`pending_tool_execution is None`). That last condition is essential: a
pending *tool* interrupt also leaves the state activated, and some non-interrupt endings keep it
that way on purpose — e.g. cancelling a resumed tool interrupt ends the pass `"cancelled"` while
the interrupt is still owed a resume. Without the pending-execution check the run loop would wipe that
pending tool interrupt. Scoped this way, the run-loop deactivation only ever clears agent-stream
interrupts (which never store pending tool execution); the event loop remains the sole owner of
tool-interrupt state.

A cancelled pass keeps that tool interrupt because the event loop only completes the tool resume
when the tools actually ran: cancellation (`agent.cancel()` or a `BeforeToolsEvent` cancel) produces
cancel tool results without executing anything, so the stored tool-use message and the human's
answer are left in place for a later resume (a cancel mid-execution refreshes the stored results so
completed tools aren't re-run). Clearing them would strand the caller holding interrupt responses
for state that no longer exists.

(TypeScript mirrors this: its AgentStreamStage wrapper deactivates on a non-interrupt completion
when no pending tool execution is stored, so an agent-stream interrupt that resumes to a plain
`end_turn` clears the `activated` flag and the next fresh invocation is not rejected. Both SDKs
likewise preserve a pending *tool* interrupt across a cancelled resume by not clearing it until the
tools actually run.)

### Interrupt response lifetime

An answered agent-stream response lives for exactly one **interrupt cycle**: the span from the
interrupt that asked the human through to the pass that completes with nothing owed a resume. A
cycle can span multiple `agent(...)` calls (one per resume round trip). Three coordinated rules
keep that window exact.

`_InterruptState.end_tool_cycle` clears per-tool-cycle interrupts and context but retains answered
agent-stream responses (matched by the `_AGENT_STREAM_INTERRUPT_ID_PREFIX`). The agent-stream
context reads a snapshot taken at pass start, so a gate answered in one pass and re-read in a later
pass of the same cycle still resolves — even though the tool cycle that separated them cleared the
live dict.

`_InterruptState.end_interrupt_cycle` releases those retained responses when the cycle is over (a
pass ends with nothing pending). Without this, an answer becomes a standing approval: ids are
deterministic, so a later cycle's gate resolves against the stale response and never asks. The
release runs before `AfterInvocationEvent` (session sync) and before `apply_management`, so the
released state is what gets persisted and a failure in either cannot strand a response.

The pass-start snapshot is only populated while interrupt state is activated. A resume always
arrives activated, so a live cycle reads normally. Outside one — a cycle abandoned mid-flight
because the caller stopped consuming the stream — there is nothing to read and a leftover response
cannot resolve a gate that should be asking.

Net effect: a gate asks the human once per interrupt cycle and never inherits an approval from a
previous one. Because the id is derived from the name alone, the **name identifies what is being
approved for the whole cycle**. Reusing one name for two different decisions in a cycle means the
second inherits the first's approval, so give each decision its own stable name.

(TypeScript does not implement this lifetime yet: its `deactivate()` clears everything, so an
answered agent-stream response does not survive a tool cycle. Tracked as a follow-up.)

### Interrupt before the pass produces its result

An agent-stream interrupt must fire before the pass produces its model turn. Once the assistant
turn is in history, if nothing was stored for a resume to replay, the resumed pass calls the model
a second time — duplicate assistant turn, non-alternating history, re-fired tool side effects. The
run loop refuses the part of this it can detect precisely — an interrupt raised after the pass
produced its EventLoopStopEvent — by clearing interrupt state and raising RuntimeError naming the
interrupt. Interrupts in the window between the model turn and the stop event are not caught.

A *tool* interrupt is exempt: its pending tool execution is replayed on resume, so no second
model call happens, and gating on top of a tool interrupt keeps working.

This makes the Output phase unsuitable for gating. The Output adapter drains the whole inner chain
before the handler runs, so the stop event has already been produced. A post-hoc approval gate
("inspect the finished stream, then ask a human") must be a Wrap handler that interrupts *before*
`next()` on the following pass.

The refusal only catches the case it can detect precisely. Interrupting mid-drain *after* the model
turn has landed (e.g. from a `ModelMessageEvent`) is past the point where the assistant message
entered history, so resuming re-calls the model exactly as above — the run loop cannot distinguish
that from a legitimate mid-drain interrupt. Treat "before the model turn is produced" as the safe
interrupt position, not merely before the stop event.

## Hook-initiated retries re-run the middleware chain

The ExecuteToolStage chain is invoked *inside* the tool-execution retry loop. If an
`AfterToolCallEvent` sets `retry = True`, the whole chain is rebuilt and re-invoked — so a
stateful middleware (cache, rate-limiter, telemetry counter) runs once per attempt, not once per
logical tool call. This is the reverse of the "middleware retries are invisible to hooks"
property (a middleware calling `next_fn` N times is still one hook pair): here, N hook-driven
retries are N middleware runs. Middleware that must be idempotent across hook retries has to
guard for it explicitly.

## No removal / cleanup

Once registered, middleware cannot be removed. This matches the Python hook system which also does not support removal.

## Private module

The `_middleware/` package is not part of the public API. Internal consumers access it via `agent._middleware_registry.add_middleware(...)`.

**When this goes public**, `add_middleware` and the handler type aliases should be typed so an
IDE helps the author: `add_middleware` takes `handler: Any` and every adapter types the context
as `Any`, so the `MiddlewareStage[TContext, TResult, TEvent]` generics do not currently flow to
handlers (unlike the TS SDK, whose per-phase overloads give full inference on `context`/result).
The public surface should add `@overload`s per phase token and bind real generics through the
phase sub-tokens so context fields, the result type, and the `next_fn` signature are checked
statically rather than only at runtime.

## Tool exceptions are caught in the terminal

A raw exception from `tool.stream()` is converted to an error `ToolResultEvent` inside the
ExecuteToolStage terminal, so middleware always observes a *result*, not a thrown exception
(matching the TS SDK, which catches in `_executeToolCore`). `InterruptException` is re-raised so
a tool-raised interrupt still halts. In practice decorated `@tool` tools already self-convert
their exceptions; this only affects custom `AgentTool`s whose `stream()` raises directly.

## Unknown tools run through the chain

When the model calls a tool that isn't in the registry, the middleware chain still runs — with
`ExecuteToolContext.tool` set to `None` — and the terminal produces the "Unknown tool" error
result (matching TS `_executeToolCore`, which runs the chain with `context.tool === undefined`).
This lets middleware observe or mock a tool the registry doesn't have, rather than the executor
short-circuiting before the chain. `ExecuteToolContext.tool` is therefore `AgentTool | None`.

## System prompt as a union type

`InvokeModelContext.system_prompt` is `str | list[SystemContentBlock] | None` (a single union field). The terminal decomposes this into the two-param form needed by `Model.stream()` via `split_system_prompt()`.

## Defensive copies

Context fields (`messages`, `system_prompt`, `tool_specs`, `tool_choice`) are deep-copied when building the middleware context. `invocation_state` is shared by reference. `model_state` is excluded from the context entirely — middleware cannot access or modify it. The terminal reads it directly from the agent at invocation time.

## Per-call model

`InvokeModelContext.model` is the model the terminal invokes, initialized from `agent.model`. Middleware can point a single call at a different model via `replace()`, without mutating agent state; the terminal streams `context.model`, so the replacement also drives the trace span's `model_id`:
```python
modified = replace(context, model=other_model)
```

## Context transformation

Middleware creates modified contexts via `dataclasses.replace()`:
```python
from dataclasses import replace
modified = replace(context, system_prompt="Injected")
```

When this goes public, we should add a typed `.replace()` method to context dataclasses for better discoverability and ergonomics (following `datetime.replace()` precedent).

## Generator cleanup

Python's `compose()` uses `try/finally` with explicit `aclose()`. TypeScript relies on `yield*` delegation which calls `.return()` automatically. Both correctly clean up generators.
