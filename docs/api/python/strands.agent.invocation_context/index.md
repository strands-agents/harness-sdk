Handle to the request an agent call belongs to, carrying its limits and usage.

## InvocationContextUsage

```python
class InvocationContextUsage(Usage)
```

Defined in: [src/strands/agent/invocation\_context.py:16](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/invocation_context.py#L16)

What the work in an :class:`InvocationContext` has used.

Its turns and the token usage of every model call, including nested and auxiliary calls. The token keys keep the provider casing of :class:`~strands.types.event_loop.Usage`.

**Attributes**:

-   `turns_taken` - Turns taken in the context, including its nested calls.

## InvocationContext

```python
class InvocationContext()
```

Defined in: [src/strands/agent/invocation\_context.py:33](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/invocation_context.py#L33)

Handle to the request an object belongs to.

A top-level `invoke_async()` / `stream_async()` call starts a request, and the SDK attaches its handle to the hook events, tool contexts, and extension points it hands out and to the call’s result. Pass it as `invocation_context` to a later call to run that call as a nested call in the same request, sharing its limits and usage, for example to continue a previous call’s budget.

Every nested call that joins the request shares one instance. A nested call that sets its own `limits`, and an auxiliary call, get a child instance instead. A child adds its usage to its parent; a nested call’s child is also bound by the parent’s limits, while no limits apply to an auxiliary call.

**Notes**:

Only the SDK creates instances; pass `limits=` to a top-level call to start a limited request. Treat `usage` as read-only: mutating it is unsupported.

#### \_\_init\_\_

```python
def __init__() -> None
```

Defined in: [src/strands/agent/invocation\_context.py:58](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/invocation_context.py#L58)

Reject direct construction.

**Raises**:

-   `TypeError` - Always; the SDK creates every instance.

#### usage

```python
@property
def usage() -> InvocationContextUsage
```

Defined in: [src/strands/agent/invocation\_context.py:67](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/invocation_context.py#L67)

What the work in this context has used so far.

It keeps growing while that work runs, including background tasks the request started.