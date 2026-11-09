Ollama model provider.

-   Docs: [https://ollama.com/](https://ollama.com/)

## OllamaModel

```python
class OllamaModel(Model)
```

Defined in: [src/strands/models/ollama.py:36](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/ollama.py#L36)

Ollama model provider implementation.

The implementation handles Ollama-specific features such as:

-   Local model invocation
-   Streaming responses
-   Tool/function calling

## OllamaConfig

```python
class OllamaConfig(BaseModelConfig)
```

Defined in: [src/strands/models/ollama.py:53](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/ollama.py#L53)

Configuration parameters for Ollama models.

**Attributes**:

-   `additional_args` - Any additional arguments to include in the request.
-   `cache_config` - Prompt caching settings. Ollama honors no cache fields, so any set field is ignored.
-   `keep_alive` - Controls how long the model will stay loaded into memory following the request (default: “5m”).
-   `max_tokens` - Maximum number of tokens to generate in the response.
-   `model_id` - Ollama model ID (e.g., “llama3”, “mistral”, “phi3”).
-   `options` - Additional model parameters (e.g., top\_k).
-   `stop_sequences` - List of sequences that will stop generation when encountered.
-   `temperature` - Controls randomness in generation (higher = more random).
-   `top_p` - Controls diversity via nucleus sampling (alternative to temperature).

#### \_\_init\_\_

```python
def __init__(host: str | None,
             *,
             ollama_client_args: dict[str, Any] | None = None,
             **model_config: Unpack[OllamaConfig]) -> None
```

Defined in: [src/strands/models/ollama.py:78](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/ollama.py#L78)

Initialize provider instance.

**Arguments**:

-   `host` - The address of the Ollama server hosting the model.
-   `ollama_client_args` - Additional arguments for the Ollama client.
-   `**model_config` - Configuration options for the Ollama model.

#### update\_config

```python
@override
def update_config(**model_config: Unpack[OllamaConfig]) -> None
```

Defined in: [src/strands/models/ollama.py:100](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/ollama.py#L100)

Update the Ollama Model configuration with the provided arguments.

**Arguments**:

-   `**model_config` - Configuration overrides.

#### model\_info

```python
@property
@override
def model_info() -> ModelInfo
```

Defined in: [src/strands/models/ollama.py:111](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/ollama.py#L111)

Reports server-side summary as off, which a `model_info` override still wins over.

Ollama has no server-side summary, including for Claude models served through it.

#### get\_config

```python
@override
def get_config() -> OllamaConfig
```

Defined in: [src/strands/models/ollama.py:119](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/ollama.py#L119)

Get the Ollama model configuration.

**Returns**:

The Ollama model configuration.

#### format\_request

```python
def format_request(messages: Messages,
                   tool_specs: list[ToolSpec] | None = None,
                   system_prompt: str | None = None) -> dict[str, Any]
```

Defined in: [src/strands/models/ollama.py:204](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/ollama.py#L204)

Format an Ollama chat streaming request.

**Arguments**:

-   `messages` - List of message objects to be processed by the model.
-   `tool_specs` - List of tool specifications to make available to the model.
-   `system_prompt` - System prompt to provide context to the model.

**Returns**:

An Ollama chat streaming request.

**Raises**:

-   `TypeError` - If a message contains a content block type that cannot be converted to an Ollama-compatible format.

#### format\_chunk

```python
def format_chunk(event: dict[str, Any]) -> StreamEvent
```

Defined in: [src/strands/models/ollama.py:260](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/ollama.py#L260)

Format the Ollama response events into standardized message chunks.

**Arguments**:

-   `event` - A response event from the Ollama model.

**Returns**:

The formatted chunk.

**Raises**:

-   `RuntimeError` - If chunk\_type is not recognized. This error should never be encountered as we control chunk\_type in the stream method.

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

Defined in: [src/strands/models/ollama.py:324](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/ollama.py#L324)

Stream conversation with the Ollama model.

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

#### structured\_output

```python
@override
async def structured_output(
        output_model: type[T],
        prompt: Messages,
        system_prompt: str | None = None,
        **kwargs: Any) -> AsyncGenerator[dict[str, T | Any], None]
```

Defined in: [src/strands/models/ollama.py:394](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/ollama.py#L394)

Get structured output from the model.

**Arguments**:

-   `output_model` - The output model to use for the agent.
-   `prompt` - The prompt messages to use for the agent.
-   `system_prompt` - System prompt to provide context to the model.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Yields**:

Model events with the last being the structured output.

**Raises**:

-   `ContextWindowOverflowException` - If the input exceeds the model’s context window.