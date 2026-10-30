Writer model provider.

-   Docs: [https://dev.writer.com/home/introduction](https://dev.writer.com/home/introduction)

## WriterModel

```python
class WriterModel(Model)
```

Defined in: [src/strands/models/writer.py:36](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/writer.py#L36)

Writer API model provider implementation.

## WriterConfig

```python
class WriterConfig(BaseModelConfig)
```

Defined in: [src/strands/models/writer.py:48](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/writer.py#L48)

Configuration options for Writer API.

**Attributes**:

-   `model_id` - Model name to use (e.g. palmyra-x5, palmyra-x4, etc.).
-   `max_tokens` - Maximum number of tokens to generate.
-   `cache_config` - Prompt caching settings. Writer honors no cache fields, so any set field is ignored.
-   `stop` - Default stop sequences.
-   `stream_options` - Additional options for streaming.
-   `temperature` - What sampling temperature to use.
-   `top_p` - Threshold for ‘nucleus sampling’

#### \_\_init\_\_

```python
def __init__(client_args: dict[str, Any] | None = None,
             **model_config: Unpack[WriterConfig])
```

Defined in: [src/strands/models/writer.py:69](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/writer.py#L69)

Initialize provider instance.

**Arguments**:

-   `client_args` - Arguments for the Writer client (e.g., api\_key, base\_url, timeout, etc.).
-   `**model_config` - Configuration options for the Writer model.

#### update\_config

```python
@override
def update_config(**model_config: Unpack[WriterConfig]) -> None
```

Defined in: [src/strands/models/writer.py:85](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/writer.py#L85)

Update the Writer Model configuration with the provided arguments.

**Arguments**:

-   `**model_config` - Configuration overrides.

#### get\_config

```python
@override
def get_config() -> WriterConfig
```

Defined in: [src/strands/models/writer.py:95](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/writer.py#L95)

Get the Writer model configuration.

**Returns**:

The Writer model configuration.

#### format\_request

```python
def format_request(messages: Messages,
                   tool_specs: list[ToolSpec] | None = None,
                   system_prompt: str | None = None) -> Any
```

Defined in: [src/strands/models/writer.py:281](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/writer.py#L281)

Format a streaming request to the underlying model.

**Arguments**:

-   `messages` - List of message objects to be processed by the model.
-   `tool_specs` - List of tool specifications to make available to the model.
-   `system_prompt` - System prompt to provide context to the model.

**Returns**:

The formatted request.

#### format\_chunk

```python
def format_chunk(event: Any) -> StreamEvent
```

Defined in: [src/strands/models/writer.py:324](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/writer.py#L324)

Format the model response events into standardized message chunks.

**Arguments**:

-   `event` - A response event from the model.

**Returns**:

The formatted chunk.

#### stream

```python
@override
async def stream(messages: Messages,
                 tool_specs: list[ToolSpec] | None = None,
                 system_prompt: str | None = None,
                 *,
                 tool_choice: ToolChoice | None = None,
                 **kwargs: Any) -> AsyncGenerator[StreamEvent, None]
```

Defined in: [src/strands/models/writer.py:391](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/writer.py#L391)

Stream conversation with the Writer model.

**Arguments**:

-   `messages` - List of message objects to be processed by the model.
-   `tool_specs` - List of tool specifications to make available to the model.
-   `system_prompt` - System prompt to provide context to the model.
-   `tool_choice` - Selection strategy for tool invocation. **Note: This parameter is accepted for interface consistency but is currently ignored for this model provider.**
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Yields**:

Formatted message chunks from the model.

**Raises**:

-   `ContextWindowOverflowException` - If the input exceeds the model’s context window.
-   `ModelThrottledException` - When the model service is throttling requests from the client.

#### structured\_output

```python
@override
async def structured_output(
        output_model: type[T],
        prompt: Messages,
        system_prompt: str | None = None,
        **kwargs: Any) -> AsyncGenerator[dict[str, T | Any], None]
```

Defined in: [src/strands/models/writer.py:476](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/writer.py#L476)

Get structured output from the model.

**Arguments**:

-   `output_model` - The output model to use for the agent.
-   `prompt` - The prompt messages to use for the agent.
-   `system_prompt` - System prompt to provide context to the model.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Raises**:

-   `ContextWindowOverflowException` - If the input exceeds the model’s context window.