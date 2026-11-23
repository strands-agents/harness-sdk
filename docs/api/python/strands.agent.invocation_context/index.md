Handle to the request an agent call belongs to, carrying its limits and usage.

## InvocationContextUsage

```python
class InvocationContextUsage(Usage)
```

Defined in: [src/strands/agent/invocation\_context.py:17](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/invocation_context.py#L17)

What the work in an :class:`InvocationContext` has used.

Its turns and the token usage of every model call, including nested and auxiliary calls. The token keys keep the provider casing of :class:`~strands.types.event_loop.Usage`.

**Attributes**:

-   `turns_taken` - Turns taken in the context, including its nested calls.

## ModelUsage

```python
@dataclass(frozen=True, kw_only=True)
class ModelUsage()
```

Defined in: [src/strands/agent/invocation\_context.py:31](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/invocation_context.py#L31)

Token usage of one model in a request.

**Attributes**:

-   `provider_name` - Name of the model’s provider. For the SDK’s own model classes it is one of `anthropic`, `bedrock`, `google`, `litellm`, `llamaapi`, `llamacpp`, `mistral`, `ollama`, `openai`, `sagemaker`, or `writer`. A decision model reports the provider name from its own metadata, or its wrapped model’s name when it has one. `None` when the SDK cannot tell. Existing names do not change, more may be added, and a `None` may later get a name. It is not the OpenTelemetry provider value.
-   `model_id` - The model id the calls were made with, or the endpoint name for a SageMaker model; `None` when not known.
-   `usage` - The summed usage of every call to this model.

## InvocationContext

```python
class InvocationContext()
```

Defined in: [src/strands/agent/invocation\_context.py:55](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/invocation_context.py#L55)

Handle to the request an object belongs to.

A top-level `invoke_async()` / `stream_async()` call starts a request, and the SDK attaches its handle to the hook events, tool contexts, and extension points it hands out and to the call’s result. Pass it as `invocation_context` to a later call to run that call as a nested call in the same request, sharing its limits and usage, for example to continue a previous call’s budget.

Every nested call that joins the request shares one instance. A nested call that sets its own `limits`, and an auxiliary call, get a child instance instead. A child adds its usage to its parent; a nested call’s child is also bound by the parent’s limits, while no limits apply to an auxiliary call.

**Notes**:

Only the SDK creates instances; pass `limits=` to a top-level call to start a limited request. Treat `usage` as read-only: mutating it is unsupported.

#### \_\_init\_\_

```python
def __init__() -> None
```

Defined in: [src/strands/agent/invocation\_context.py:81](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/invocation_context.py#L81)

Reject direct construction.

**Raises**:

-   `TypeError` - Always; the SDK creates every instance.

#### usage

```python
@property
def usage() -> InvocationContextUsage
```

Defined in: [src/strands/agent/invocation\_context.py:90](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/invocation_context.py#L90)

What the work in this context has used so far.

It keeps growing while that work runs, including background tasks the request started.

#### usage\_by\_model

```python
@property
def usage_by_model() -> list[ModelUsage]
```

Defined in: [src/strands/agent/invocation\_context.py:98](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/invocation_context.py#L98)

The token usage in :attr:`usage`, split by the model that produced it.

One record per distinct `(provider_name, model_id)`, in the order they first recorded usage. Each is a snapshot taken when this property is read. Their token counts add up to :attr:`usage`. Usage whose model is not known is under a record whose `provider_name` and `model_id` are `None`.