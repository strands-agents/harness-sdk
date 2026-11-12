OpenTelemetry integration.

This module provides tracing capabilities using OpenTelemetry, enabling trace data to be sent to OTLP endpoints.

## JSONEncoder

```python
class JSONEncoder(json.JSONEncoder)
```

Defined in: [src/strands/telemetry/tracer.py:36](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/telemetry/tracer.py#L36)

Custom JSON encoder that handles non-serializable types.

#### encode

```python
def encode(obj: Any) -> str
```

Defined in: [src/strands/telemetry/tracer.py:39](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/telemetry/tracer.py#L39)

Recursively encode objects, preserving structure and only replacing unserializable values.

**Arguments**:

-   `obj` - The object to encode

**Returns**:

JSON string representation of the object

## Tracer

```python
class Tracer()
```

Defined in: [src/strands/telemetry/tracer.py:84](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/telemetry/tracer.py#L84)

Handles OpenTelemetry tracing.

This class provides a simple interface for creating and managing traces, with support for sending to OTLP endpoints.

When the OTEL\_EXPORTER\_OTLP\_ENDPOINT environment variable is set, traces are sent to the OTLP endpoint.

Both attributes are controlled by including “gen\_ai\_latest\_experimental”, “gen\_ai\_tool\_definitions”, or “gen\_ai\_use\_latest\_invocation\_tokens”, respectively, in the OTEL\_SEMCONV\_STABILITY\_OPT\_IN environment variable.

Including “gen\_ai\_span\_attributes\_only” records message content directly as span attributes instead of span events, for backends that cannot read span events. This applies to the aggregated content events (latest-convention “gen\_ai.\*” messages and the “memory.query”/“memory.content” events); the legacy per-message events are always emitted as events. The default (token absent, non-Langfuse) emits span events for backward compatibility. Independent of this token, tool spans under the latest conventions additionally record `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result` as span attributes per the execute\_tool span convention.

Span attribute redaction is opt-in via the `gen_ai_unredacted_attributes=<list>` token in the same environment variable. The list uses `;` as a separator and supports trailing-`*` glob patterns. When the token is absent, all attributes are emitted unredacted (backward compatible).

Note: only a single trailing `*` is honored (e.g. `gen_ai.output.*`). A mid-string wildcard such as `gen_ai.*.messages` will not match anything at the moment — it is treated as an exact name.

Sensitive attributes subject to the redaction policy are: `gen_ai.input.messages` (user messages and tool inputs/results being fed into the model), `gen_ai.output.messages` (agent/model responses and tool call responses), `gen_ai.system_instructions` (system prompts), and, on execute\_tool spans under the latest conventions, `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result` (tool inputs/outputs).

#### \_\_init\_\_

```python
def __init__() -> None
```

Defined in: [src/strands/telemetry/tracer.py:116](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/telemetry/tracer.py#L116)

Initialize the tracer.

#### is\_langfuse

```python
@property
def is_langfuse() -> bool
```

Defined in: [src/strands/telemetry/tracer.py:198](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/telemetry/tracer.py#L198)

Check if Langfuse is configured as the OTLP endpoint.

**Returns**:

True if Langfuse is the OTLP endpoint, False otherwise.

#### end\_span\_with\_error

```python
def end_span_with_error(span: Span,
                        error_message: str,
                        exception: Exception | None = None) -> None
```

Defined in: [src/strands/telemetry/tracer.py:323](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/telemetry/tracer.py#L323)

End a span with error status.

**Arguments**:

-   `span` - The span to end.
-   `error_message` - Error message to set in the span status.
-   `exception` - Optional exception to record in the span.

#### end\_span\_with\_cancellation

```python
def end_span_with_cancellation(span: Span,
                               cancellation: BaseException) -> None
```

Defined in: [src/strands/telemetry/tracer.py:337](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/telemetry/tracer.py#L337)

End a span that was cancelled without marking it as success or failure.

Leaves the span status at its default UNSET (never sets OK or ERROR) and records the cancellation type as an attribute so trace consumers can distinguish cancellation from incomplete instrumentation.

**Arguments**:

-   `span` - The span to end.
-   `cancellation` - The BaseException that cancelled the operation.

#### start\_model\_invoke\_span

```python
def start_model_invoke_span(messages: Messages,
                            parent_span: Span | None = None,
                            model_id: str | None = None,
                            custom_trace_attributes: Mapping[str,
                                                             AttributeValue]
                            | None = None,
                            system_prompt: str | None = None,
                            system_prompt_content: list | None = None,
                            **kwargs: Any) -> Span
```

Defined in: [src/strands/telemetry/tracer.py:408](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/telemetry/tracer.py#L408)

Start a new span for a model invocation.

**Arguments**:

-   `messages` - Messages being sent to the model.
-   `parent_span` - Optional parent span to link this span to.
-   `model_id` - Optional identifier for the model being invoked.
-   `custom_trace_attributes` - Optional mapping of custom trace attributes to include in the span.
-   `system_prompt` - Optional system prompt string provided to the model.
-   `system_prompt_content` - Optional list of system prompt content blocks.
-   `**kwargs` - Additional attributes to add to the span.

**Returns**:

The created span, or None if tracing is not enabled.

#### end\_model\_invoke\_span

```python
def end_model_invoke_span(span: Span, message: Message, usage: Usage,
                          metrics: Metrics, stop_reason: StopReason) -> None
```

Defined in: [src/strands/telemetry/tracer.py:449](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/telemetry/tracer.py#L449)

End a model invocation span with results and metrics.

**Arguments**:

-   `span` - The span to end.
-   `message` - The message response from the model.
-   `usage` - Token usage information from the model call.
-   `metrics` - Metrics from the model call.
-   `stop_reason` - The reason the model stopped generating.

#### start\_tool\_call\_span

```python
def start_tool_call_span(tool: ToolUse,
                         parent_span: Span | None = None,
                         custom_trace_attributes: Mapping[str, AttributeValue]
                         | None = None,
                         **kwargs: Any) -> Span
```

Defined in: [src/strands/telemetry/tracer.py:509](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/telemetry/tracer.py#L509)

Start a new span for a tool call.

**Arguments**:

-   `tool` - The tool being used.
-   `parent_span` - Optional parent span to link this span to.
-   `custom_trace_attributes` - Optional mapping of custom trace attributes to include in the span.
-   `**kwargs` - Additional attributes to add to the span.

**Returns**:

The created span, or None if tracing is not enabled.

#### end\_tool\_call\_span

```python
def end_tool_call_span(span: Span,
                       tool_result: ToolResult | None,
                       error: Exception | None = None) -> None
```

Defined in: [src/strands/telemetry/tracer.py:585](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/telemetry/tracer.py#L585)

End a tool call span with results.

**Arguments**:

-   `span` - The span to end.
-   `tool_result` - The result from the tool execution.
-   `error` - Optional exception if the tool call failed.

#### start\_event\_loop\_cycle\_span

```python
def start_event_loop_cycle_span(
        invocation_state: Any,
        messages: Messages,
        parent_span: Span | None = None,
        custom_trace_attributes: Mapping[str, AttributeValue] | None = None,
        **kwargs: Any) -> Span
```

Defined in: [src/strands/telemetry/tracer.py:645](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/telemetry/tracer.py#L645)

Start a new span for an event loop cycle.

**Arguments**:

-   `invocation_state` - Arguments for the event loop cycle.
-   `parent_span` - Optional parent span to link this span to.
-   `messages` - Messages being processed in this cycle.
-   `custom_trace_attributes` - Optional mapping of custom trace attributes to include in the span.
-   `**kwargs` - Additional attributes to add to the span.

**Returns**:

The created span, or None if tracing is not enabled.

#### end\_event\_loop\_cycle\_span

```python
def end_event_loop_cycle_span(
        span: Span,
        message: Message,
        tool_result_message: Message | None = None) -> None
```

Defined in: [src/strands/telemetry/tracer.py:686](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/telemetry/tracer.py#L686)

End an event loop cycle span with results.

**Arguments**:

-   `span` - The span to end.
-   `message` - The message response from this cycle.
-   `tool_result_message` - Optional tool result message if a tool was called.

#### start\_agent\_span

```python
def start_agent_span(messages: Messages,
                     agent_name: str,
                     model_id: str | None = None,
                     tools: list | None = None,
                     custom_trace_attributes: Mapping[str, AttributeValue]
                     | None = None,
                     tools_config: dict | None = None,
                     system_prompt: str | None = None,
                     system_prompt_content: list | None = None,
                     **kwargs: Any) -> Span
```

Defined in: [src/strands/telemetry/tracer.py:733](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/telemetry/tracer.py#L733)

Start a new span for an agent invocation.

**Arguments**:

-   `messages` - List of messages being sent to the agent.
-   `agent_name` - Name of the agent.
-   `model_id` - Optional model identifier.
-   `tools` - Optional list of tools being used.
-   `custom_trace_attributes` - Optional mapping of custom trace attributes to include in the span.
-   `tools_config` - Optional dictionary of tool configurations.
-   `system_prompt` - Optional system prompt string.
-   `system_prompt_content` - Optional list of system prompt content blocks.
-   `**kwargs` - Additional attributes to add to the span.

**Returns**:

The created span, or None if tracing is not enabled.

#### end\_agent\_span

```python
def end_agent_span(span: Span,
                   response: AgentResult | None = None,
                   error: Exception | None = None) -> None
```

Defined in: [src/strands/telemetry/tracer.py:804](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/telemetry/tracer.py#L804)

End an agent span with results and metrics.

**Arguments**:

-   `span` - The span to end.
-   `response` - The response from the agent.
-   `error` - Any error that occurred.

#### start\_multiagent\_span

```python
def start_multiagent_span(
    task: MultiAgentInput,
    instance: str,
    custom_trace_attributes: Mapping[str, AttributeValue] | None = None
) -> Span
```

Defined in: [src/strands/telemetry/tracer.py:895](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/telemetry/tracer.py#L895)

Start a new span for swarm invocation.

#### end\_swarm\_span

```python
def end_swarm_span(span: Span, result: str | None = None) -> None
```

Defined in: [src/strands/telemetry/tracer.py:933](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/telemetry/tracer.py#L933)

End a swarm span with results.

#### start\_memory\_search\_span

```python
def start_memory_search_span(query: str,
                             store_names: list[str],
                             max_search_results: int | None = None,
                             parent_span: Span | None = None,
                             custom_trace_attributes: Mapping[str,
                                                              AttributeValue]
                             | None = None,
                             **kwargs: Any) -> Span
```

Defined in: [src/strands/telemetry/tracer.py:997](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/telemetry/tracer.py#L997)

Start a new span for a memory search.

The query is recorded verbatim as a span event, consistent with how model and tool spans record their inputs. Memory payloads may contain user PII; suppress span content at the exporter or processor when that is a concern.

**Arguments**:

-   `query` - The search query.
-   `store_names` - Names of the stores being searched.
-   `max_search_results` - Optional cap on results per store.
-   `parent_span` - Optional parent span to link this span to.
-   `custom_trace_attributes` - Optional mapping of custom trace attributes to include in the span.
-   `**kwargs` - Additional attributes to add to the span.

**Returns**:

The created span.

#### end\_memory\_search\_span

```python
def end_memory_search_span(span: Span,
                           entries: "list[MemoryEntry] | None" = None,
                           store_failure_count: int = 0,
                           error: Exception | None = None) -> None
```

Defined in: [src/strands/telemetry/tracer.py:1038](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/telemetry/tracer.py#L1038)

End a memory search span with results.

**Arguments**:

-   `span` - The span to end.
-   `entries` - The retrieved memory entries (each with `content`, `store_name`, `metadata`).
-   `store_failure_count` - Number of stores whose search raised (logged and skipped).
-   `error` - Optional exception if the search failed outright.

#### start\_memory\_add\_span

```python
def start_memory_add_span(content: str,
                          store_names: list[str],
                          parent_span: Span | None = None,
                          custom_trace_attributes: Mapping[str, AttributeValue]
                          | None = None,
                          force_root: bool = False,
                          **kwargs: Any) -> Span
```

Defined in: [src/strands/telemetry/tracer.py:1083](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/telemetry/tracer.py#L1083)

Start a new span for a memory add.

The content is recorded verbatim as a span event, consistent with how model and tool spans record their inputs. Memory payloads may contain user PII; suppress span content at the exporter or processor when that is a concern.

**Arguments**:

-   `content` - The content being written.
-   `store_names` - Names of the writable stores being targeted.
-   `parent_span` - Optional parent span to link this span to.
-   `custom_trace_attributes` - Optional mapping of custom trace attributes to include in the span.
-   `force_root` - Start the span as a trace root (for detached fire-and-forget writes).
-   `**kwargs` - Additional attributes to add to the span.

**Returns**:

The created span.

#### end\_memory\_add\_span

```python
def end_memory_add_span(span: Span,
                        store_failure_count: int = 0,
                        error: Exception | None = None) -> None
```

Defined in: [src/strands/telemetry/tracer.py:1122](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/telemetry/tracer.py#L1122)

End a memory add span.

**Arguments**:

-   `span` - The span to end.
-   `store_failure_count` - Number of targeted stores whose write failed.
-   `error` - Optional exception if the add failed.

#### start\_memory\_inject\_span

```python
def start_memory_inject_span(max_entries: int | None = None,
                             parent_span: Span | None = None,
                             custom_trace_attributes: Mapping[str,
                                                              AttributeValue]
                             | None = None,
                             **kwargs: Any) -> Span
```

Defined in: [src/strands/telemetry/tracer.py:1141](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/telemetry/tracer.py#L1141)

Start a new span for memory context injection.

**Arguments**:

-   `max_entries` - Optional cap on entries injected for this model call.
-   `parent_span` - Optional parent span to link this span to.
-   `custom_trace_attributes` - Optional mapping of custom trace attributes to include in the span.
-   `**kwargs` - Additional attributes to add to the span.

**Returns**:

The created span.

#### end\_memory\_inject\_span

```python
def end_memory_inject_span(span: Span,
                           injected: bool,
                           entry_count: int = 0,
                           format_error: bool = False) -> None
```

Defined in: [src/strands/telemetry/tracer.py:1168](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/telemetry/tracer.py#L1168)

End a memory injection span.

Injection fails open, so a format failure ends the span OK with a flag rather than an error status (the agent did not fail).

**Arguments**:

-   `span` - The span to end.
-   `injected` - Whether memory context was injected for this model call.
-   `entry_count` - Number of entries injected.
-   `format_error` - Whether the format callback raised (injection skipped).

#### start\_memory\_extract\_span

```python
def start_memory_extract_span(store_name: str,
                              message_count: int,
                              filtered_count: int = 0,
                              extractor: str | None = None,
                              agent_span_context: SpanContext | None = None,
                              **kwargs: Any) -> Span
```

Defined in: [src/strands/telemetry/tracer.py:1198](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/telemetry/tracer.py#L1198)

Start a new root span for a background memory extraction.

Extraction runs detached from the agent invocation that scheduled it (the agent span has typically ended by the time the save runs), so the span is a trace root, optionally linked back to the agent span for causality.

**Arguments**:

-   `store_name` - Name of the store being saved to.
-   `message_count` - Number of messages written, i.e. after the message filter ran (recorded as `memory.message.count`). The pre-filter input count is `message_count + filtered_count`.
-   `filtered_count` - Number of messages dropped by the message filter.
-   `extractor` - The extractor class name, or None for the `add_messages` path.
-   `agent_span_context` - Optional span context of the agent run that scheduled this extraction, attached as a link.
-   `**kwargs` - Additional attributes to add to the span.

**Returns**:

The created span.

#### end\_memory\_extract\_span

```python
def end_memory_extract_span(span: Span,
                            entry_count: int | None = None,
                            error: Exception | None = None) -> None
```

Defined in: [src/strands/telemetry/tracer.py:1248](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/telemetry/tracer.py#L1248)

End a memory extraction span.

**Arguments**:

-   `span` - The span to end.
-   `entry_count` - Number of entries written to the store.
-   `error` - Optional exception if the extraction failed (saving never raises; failures are recorded here and swallowed by the coordinator).

#### get\_tracer

```python
def get_tracer() -> Tracer
```

Defined in: [src/strands/telemetry/tracer.py:1437](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/telemetry/tracer.py#L1437)

Get or create the global tracer.

**Returns**:

The global tracer instance.

#### serialize

```python
def serialize(obj: Any) -> str
```

Defined in: [src/strands/telemetry/tracer.py:1451](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/telemetry/tracer.py#L1451)

Serialize an object to JSON with consistent settings.

**Arguments**:

-   `obj` - The object to serialize

**Returns**:

JSON string representation of the object