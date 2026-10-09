# Python Middleware

This implementation follows the behavioral spec defined in `strands-ts/src/middleware/README.md` with the following intentional divergences:

## Scope

All three stages are implemented: `InvokeModelStage`, `ExecuteToolStage`, and `AgentStreamStage`.
`AgentStreamStage` is internal (`strands.middleware._agent_stream`, see "Public surface" below),
matching the TS SDK.

## Result encoding

TypeScript uses async generator `return` values propagated via `yield*`. Python async generators cannot `return` values.

Instead, the **result is an event in the stream**, recognized by type: `ModelStopReason` for
`InvokeModelStage`, `ToolResultEvent` for `ExecuteToolStage`, `EventLoopStopEvent` for the internal
`AgentStreamStage`. Each stage token records its result event class (`MiddlewareStage.result_event`),
and the registry's Output adapter and every call site select the result with `isinstance`, so a Wrap
handler may yield its own events before or after it (the TS spec's "inject events before or after
the inner chain's events"). When a chain yields more than one result event (a hook-driven retry
re-running the chain), the last one wins; a chain that yields none raises `RuntimeError` at the call
site. This matches the existing Python SDK convention where `ModelStopReason` is the last event from
`stream_messages()` and `ToolResultEvent` the last from tool execution.

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

Wrap handlers see the raw event stream; only **Output** handlers see a wrapper. The registry wraps
the result event in the stage's result type before calling the handler and yields the returned
wrapper's `result` back into the stream in its place, so the rest of the chain and the call site
still see a plain event:
```python
def output_handler(result: InvokeModelResult) -> InvokeModelResult:
    event = result.result
    return InvokeModelResult(
        result=ModelStopReason(stop_reason="custom", message=event.message, usage=event.usage, metrics=event.metrics),
    )
```

TS is symmetric (Wrap handlers return the wrapper too) because its generators carry a return value.
Python's asymmetry is inherent to the encoding above: Wrap-phase metadata would have to be yielded as
events, so only the Output wrapper can grow fields later (see the TS spec, "Metadata transport").

## Per-stage result types

Each stage has a result type with a single `result` field, matching the TS `InvokeModelResult` /
`ExecuteToolResult` / `AgentStreamResult` shape (`MiddlewareStage.result_type`). The field holds
the stage's result *event* rather than TS's `StreamAggregatedResult` / `ToolResultBlock` /
`AgentResult`, because the registry has to re-yield it into the stream:

- `InvokeModelStage` → `InvokeModelResult(result: ModelStopReason)`. `ModelStopReason` exposes
  `stop_reason`, `message`, `usage` and `metrics`, the fields of TS's `StreamAggregatedResult`.
- `ExecuteToolStage` → `ExecuteToolResult(result: ToolResultEvent)`. The event carries both
  `tool_result` and `exception`.
- `AgentStreamStage` → `AgentStreamResult(result: EventLoopStopEvent)` (internal). The event carries
  the full stop tuple the `AgentResult` is built from.

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
  interrupts via `_AgentAsTool`) flows through the chain as a normal event. It is not the stage's
  result event, so the Output adapter forwards it untouched and `_stream` registers its interrupts
  and short-circuits.

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
`options`, Python exposes `messages` (the input for this pass, appended by the terminal) +
`invocation_state` (the per-invocation state dict). The rename reflects what Python's `_run_loop`
actually threads through the pass. Note this drops the extra fields TS's `options` (`InvokeOptions`)
carries — `cancel_signal`, structured-output config, `limits` — from the agent-stream context;
those remain reachable on `agent` but are not surfaced as first-class context fields here. Since
the stage is internal, that surface is not yet finalized.

`ExecuteToolContext.cancel_signal` is executor-owned: middleware can observe it, but replacing it
via `dataclasses.replace()` does not change the signal the tool receives — the executor hands the
tool the agent's own signal, not the context's copy (matching TS, where the field is `readonly`).

### Transforming `messages` and `invocation_state`

Both agent-stream context fields are read by the terminal, so both are transformable via `replace()`:

- **`invocation_state`** — the terminal passes `ctx.invocation_state` to the event loop, so a handler
  returning `replace(context, invocation_state=...)` reaches the event loop and the model.
- **`messages`** — the terminal appends `ctx.messages` to `agent.messages` as the pass's input, so a
  handler returning `replace(context, messages=[...])` decides what enters history and reaches the
  model. In-place edits work too, since the same dict objects are appended.

Appending inside the terminal matches TS (`_streamCore` → `_stream` normalizes and appends
`ctx.args`) and has the same two consequences: the input's `MessageAddedEvent` fires inside the
chain (after Input handlers, within a Wrap handler's `next_fn`), and a short-circuit appends nothing,
so neither the user turn nor a response enters history and no `MessageAddedEvent` fires. Agents with
no agent-stream middleware observe no difference: the chain is the terminal, so the hook order
(`BeforeInvocationEvent` → `MessageAddedEvent` → model call) is unchanged. Continuation input
(`AfterInvocationEvent.resume`) was already appended inside the terminal; the pass-1 input now
follows the same path. `BeforeInvocationEvent`/`AfterInvocationEvent` bracket the chain from
outside and fire regardless, in both SDKs.

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

**Divergence from TS.** TS `addMiddleware` returns a cleanup function and its registry has
`remove()`. Python `add_middleware` returns `None` and middleware cannot be removed once registered,
matching the Python hook system, which also does not support removal.

## Public surface

The `middleware/` package is public. `agent.add_middleware(stage_or_phase, handler)` is the only
public entry point; it has per-phase `@overload`s that bind the stage token's generics through the
phase sub-tokens, so an annotated handler's `context`, result, and `next_fn` types are checked at
the call site (`tests_typing/test_middleware.py`). The handler type aliases (`MiddlewareHandler`,
`MiddlewareInputHandler`, `MiddlewareOutputHandler`, `MiddlewareNext`) are generic over the same
type parameters. Python async generators cannot carry a return type, so the Wrap-phase generic omits
`TResult` (the result is the last yielded event); only Output handlers, which receive the result
explicitly, are generic over it.

Type checkers differ on unannotated lambdas: pyright infers the lambda's parameter from the matched
overload, while mypy types it as `Any` (its overload resolution does not feed the phase token back
into lambda inference). Annotated handlers are fully checked by both.

`InvokeModelStage` and `ExecuteToolStage` are exported from `strands.middleware` together with
their contexts, the per-stage result event types `ModelStopReason` and `ToolResultEvent`, and the
stream event base `TypedEvent` (the stages' event type parameter), so a fully annotated handler
such as `MiddlewareHandler[InvokeModelContext, TypedEvent]` needs no private import. This mirrors
TS exporting `AgentStreamEvent` at the top level.
`AgentStreamStage`/`AgentStreamContext` stay internal in the private `strands.middleware._agent_stream`
module because their copy-vs-reference contract is not finalized (see "AgentStreamStage context
fields" above). TS marks them `@internal` and its typedoc build hides them; the Python API-docs
generator skips `_`-prefixed modules, so the private module is what keeps them off the generated
reference. The `MiddlewareRegistry` likewise lives in the private `strands.middleware._registry`
module and is only reached through `agent._middleware_registry` by the SDK's own executors.

## Custom stages are unsupported

`MiddlewareStage` is exported so handlers and helpers can be annotated, but constructing a stage
token is unsupported: the SDK only ever invokes `InvokeModelStage`, `ExecuteToolStage`, and the
internal `AgentStreamStage`, so a user-created token never runs. TS keeps `createStage` out of its
public API for the same reason; Python cannot export the type without the constructor.

## Tool exceptions are caught in the terminal

A raw exception from `tool.stream()` is converted to an error `ToolResultEvent` inside the
ExecuteToolStage terminal, so middleware always observes a *result*, not a thrown exception
(matching the TS SDK, which catches in `_executeToolCore`). `InterruptException` is re-raised so
a tool-raised interrupt still halts. In practice decorated `@tool` tools already self-convert
their exceptions; this only affects custom `AgentTool`s whose `stream()` raises directly.

Exceptions raised by ExecuteToolStage *middleware* are caught one layer further out, by
`ToolExecutor._stream`: they too become an error `ToolResult`, `AfterToolCallEvent` fires with the
`exception`, and the agent keeps running. TS's concurrent executor matches this; its sequential
executor rethrows.

## Telemetry records post-middleware state

The tool span and the tool metrics are recorded inside the ExecuteToolStage terminal, as the model
span is inside the InvokeModelStage terminal and as TS's `_executeToolCore` does. So the span
carries the `tool_use` and the tool spec the tool actually ran with (after `BeforeToolCallEvent`
rewrites and Input middleware), a hook cancel or a middleware short-circuit records no span and no
metrics, a background dispatch acknowledgement records nothing (the background run records its own),
and a hook-driven retry records one span per attempt. Direct `agent.tool.<name>()` calls record no
tool span, as in TS.

## Direct tool calls run through the chain

`agent.tool.<name>(...)` goes through `ToolExecutor._stream`, so ExecuteToolStage middleware runs
for direct calls exactly as for model-requested ones. TS bypasses middleware on that path
(`tool-caller.ts`). A direct call cannot pause for a human, so a middleware `interrupt()` on it
surfaces as `RuntimeError("cannot raise interrupt in direct tool call")`.

## Interrupting after `next_fn` re-runs the tool

`ExecuteToolContext.interrupt()` called *after* the tool ran discards the tool's result: the
`InterruptException` unwinds the chain, and on resume the whole tool call executes again. Gate
before `next_fn`, or make the tool idempotent. The same holds in TS.

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

Model state is snapshotted once per `InvokeModelStage` run, before the chain, and written back
after the chain completes. Two low-stakes differences from TS: the snapshot is written back even
when a Wrap handler short-circuits (TS only writes back when its terminal ran), and the one snapshot
is shared across `next_fn` retries within a run (TS wraps a fresh copy per attempt), so a provider's
writes during a failed attempt are visible to the retry.

## Per-call model

`InvokeModelContext.model` is the model the terminal invokes, initialized from `agent.model`. Middleware can point a single call at a different model via `replace()`, without mutating agent state; the terminal streams `context.model`, so the replacement also drives the trace span's `model_id`:
```python
modified = context.replace(model=other_model)
```

## Context transformation

Public contexts (`InvokeModelContext`, `ExecuteToolContext`) expose a typed `.replace()` method
(following the `datetime.replace()` precedent) so middleware transforms the context without
importing `dataclasses`:
```python
modified = context.replace(system_prompt="Injected")
```

`dataclasses.replace(context, ...)` still works and is equivalent; `.replace()` only adds
discoverability and a typed keyword surface.

## Generator cleanup

Python's `compose()` uses `try/finally` with explicit `aclose()`. TypeScript relies on `yield*` delegation which calls `.return()` automatically. Both correctly clean up generators.
