Llama API model provider.

Deprecated: The Llama API service has been deprecated by Meta. This provider will be removed in v2.0.0. Migrate to another provider (BedrockModel, OllamaModel, or OpenAIModel) that hosts Llama or comparable models.

## LlamaAPIModel

```python
@deprecated(
    "LlamaAPIModel is deprecated and will be removed in v2.0.0. "
    "The underlying Llama API service has been deprecated by Meta. "
    "Use BedrockModel, OllamaModel, or OpenAIModel instead."
)
class LlamaAPIModel(Model)
```

Defined in: [src/strands/models/llamaapi.py:45](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/llamaapi.py#L45)

Llama API model provider implementation.

Deprecated: The Llama API service has been deprecated by Meta. This class will be removed in v2.0.0. Use BedrockModel, OllamaModel, or OpenAIModel instead.

## LlamaConfig

```python
class LlamaConfig(BaseModelConfig)
```

Defined in: [src/strands/models/llamaapi.py:61](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/llamaapi.py#L61)

Configuration options for Llama API models.

**Attributes**:

-   `model_id` - Model ID (e.g., “Llama-4-Maverick-17B-128E-Instruct-FP8”).
-   `repetition_penalty` - Repetition penalty.
-   `temperature` - Temperature.
-   `top_p` - Top-p.
-   `max_completion_tokens` - Maximum completion tokens.
-   `top_k` - Top-k.

#### \_\_init\_\_

```python
def __init__(*,
             client_args: dict[str, Any] | None = None,
             **model_config: Unpack[LlamaConfig]) -> None
```

Defined in: [src/strands/models/llamaapi.py:80](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/llamaapi.py#L80)

Initialize provider instance.

**Arguments**:

-   `client_args` - Arguments for the Llama API client.
-   `**model_config` - Configuration options for the Llama API model.

#### update\_config

```python
@override
def update_config(**model_config: Unpack[LlamaConfig]) -> None
```

Defined in: [src/strands/models/llamaapi.py:102](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/llamaapi.py#L102)

Update the Llama API Model configuration with the provided arguments.

**Arguments**:

-   `**model_config` - Configuration overrides.

#### model\_info

```python
@property
@override
def model_info() -> ModelInfo
```

Defined in: [src/strands/models/llamaapi.py:113](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/llamaapi.py#L113)

Reports server-side summary as off, which a `model_info` override still wins over.

The Llama API has no server-side summary, including for Claude models served through it.

#### get\_config

```python
@override
def get_config() -> LlamaConfig
```

Defined in: [src/strands/models/llamaapi.py:121](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/llamaapi.py#L121)

Get the Llama API model configuration.

**Returns**:

The Llama API model configuration.

#### format\_request

```python
def format_request(messages: Messages,
                   tool_specs: list[ToolSpec] | None = None,
                   system_prompt: str | None = None) -> dict[str, Any]
```

Defined in: [src/strands/models/llamaapi.py:253](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/llamaapi.py#L253)

Format a Llama API chat streaming request.

**Arguments**:

-   `messages` - List of message objects to be processed by the model.
-   `tool_specs` - List of tool specifications to make available to the model.
-   `system_prompt` - System prompt to provide context to the model.

**Returns**:

An Llama API chat streaming request.

**Raises**:

-   `TypeError` - If a message contains a content block type that cannot be converted to a LlamaAPI-compatible format.

#### format\_chunk

```python
def format_chunk(event: dict[str, Any]) -> StreamEvent
```

Defined in: [src/strands/models/llamaapi.py:299](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/llamaapi.py#L299)

Format the Llama API model response events into standardized message chunks.

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

Defined in: [src/strands/models/llamaapi.py:373](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/llamaapi.py#L373)

Stream conversation with the LlamaAPI model.

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
def structured_output(
        output_model: type[T],
        prompt: Messages,
        system_prompt: str | None = None,
        **kwargs: Any) -> AsyncGenerator[dict[str, T | Any], None]
```

Defined in: [src/strands/models/llamaapi.py:468](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/llamaapi.py#L468)

Get structured output from the model.

**Arguments**:

-   `output_model` - The output model to use for the agent.
-   `prompt` - The prompt messages to use for the agent.
-   `system_prompt` - System prompt to provide context to the model.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Yields**:

Model events with the last being the structured output.

**Raises**:

-   `NotImplementedError` - Structured output is not currently supported for LlamaAPI models.