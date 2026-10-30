Mistral AI model provider.

-   Docs: [https://docs.mistral.ai/](https://docs.mistral.ai/)

## MistralModel

```python
class MistralModel(Model)
```

Defined in: [src/strands/models/mistral.py:63](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/mistral.py#L63)

Mistral API model provider implementation.

The implementation handles Mistral-specific features such as:

-   Chat and text completions
-   Streaming responses
-   Tool/function calling
-   System prompts

## MistralConfig

```python
class MistralConfig(BaseModelConfig)
```

Defined in: [src/strands/models/mistral.py:79](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/mistral.py#L79)

Configuration parameters for Mistral models.

**Attributes**:

-   `model_id` - Mistral model ID (e.g., “mistral-large-latest”, “mistral-medium-latest”).
-   `max_tokens` - Maximum number of tokens to generate in the response.
-   `temperature` - Controls randomness in generation (0.0 to 1.0).
-   `top_p` - Controls diversity via nucleus sampling.
-   `stream` - Whether to enable streaming responses.
-   `cache_config` - Prompt-caching configuration. Mistral routes cache reads on cache\_config.cache\_key (mapped to the request’s prompt\_cache\_key), falling back to `strands-<session_id>` when unset and a session manager is attached; it exposes no retention or placement controls, so other fields are ignored.

#### \_\_init\_\_

```python
def __init__(api_key: str | None = None,
             *,
             client_args: dict[str, Any] | None = None,
             **model_config: Unpack[MistralConfig]) -> None
```

Defined in: [src/strands/models/mistral.py:101](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/mistral.py#L101)

Initialize provider instance.

**Arguments**:

-   `api_key` - Mistral API key. If not provided, will use MISTRAL\_API\_KEY env var.
-   `client_args` - Additional arguments for the Mistral client.
-   `**model_config` - Configuration options for the Mistral model.

#### update\_config

```python
@override
def update_config(**model_config: Unpack[MistralConfig]) -> None
```

Defined in: [src/strands/models/mistral.py:146](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/mistral.py#L146)

Update the Mistral Model configuration with the provided arguments.

**Arguments**:

-   `**model_config` - Configuration overrides.

#### get\_config

```python
@override
def get_config() -> MistralConfig
```

Defined in: [src/strands/models/mistral.py:156](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/mistral.py#L156)

Get the Mistral model configuration.

**Returns**:

The Mistral model configuration.

#### format\_request

```python
def format_request(
        messages: Messages,
        tool_specs: list[ToolSpec] | None = None,
        system_prompt: str | None = None,
        agent_metadata: AgentMetadata | None = None) -> dict[str, Any]
```

Defined in: [src/strands/models/mistral.py:308](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/mistral.py#L308)

Format a Mistral chat streaming request.

**Arguments**:

-   `messages` - List of message objects to be processed by the model.
-   `tool_specs` - List of tool specifications to make available to the model.
-   `system_prompt` - System prompt to provide context to the model.
-   `agent_metadata` - Stable identity of the invoking agent, used to derive a prompt-cache routing key when `cache_config.cache_key` is unset.

**Returns**:

A Mistral chat streaming request.

**Raises**:

-   `TypeError` - If a message contains a content block type that cannot be converted to a Mistral-compatible format.

#### format\_chunk

```python
def format_chunk(event: dict[str, Any]) -> StreamEvent
```

Defined in: [src/strands/models/mistral.py:362](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/mistral.py#L362)

Format the Mistral response events into standardized message chunks.

**Arguments**:

-   `event` - A response event from the Mistral model.

**Returns**:

The formatted chunk.

**Raises**:

-   `RuntimeError` - If chunk\_type is not recognized.

#### stream

```python
@override
async def stream(messages: Messages,
                 tool_specs: list[ToolSpec] | None = None,
                 system_prompt: str | None = None,
                 *,
                 tool_choice: ToolChoice | None = None,
                 agent_metadata: AgentMetadata | None = None,
                 **kwargs: Any) -> AsyncGenerator[StreamEvent, None]
```

Defined in: [src/strands/models/mistral.py:521](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/mistral.py#L521)

Stream conversation with the Mistral model.

**Arguments**:

-   `messages` - List of message objects to be processed by the model.
-   `tool_specs` - List of tool specifications to make available to the model.
-   `system_prompt` - System prompt to provide context to the model.
-   `tool_choice` - Selection strategy for tool invocation. **Note: This parameter is accepted for interface consistency but is currently ignored for this model provider.**
-   `agent_metadata` - Stable identity of the invoking agent, used to derive a prompt-cache routing key when `cache_config.cache_key` is unset.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Yields**:

Formatted message chunks from the model.

**Raises**:

-   `ContextWindowOverflowException` - If the input exceeds the model’s context window.
-   `ModelThrottledException` - When the model service is throttling requests.

#### structured\_output

```python
@override
async def structured_output(
        output_model: type[T],
        prompt: Messages,
        system_prompt: str | None = None,
        **kwargs: Any) -> AsyncGenerator[dict[str, T | Any], None]
```

Defined in: [src/strands/models/mistral.py:629](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/mistral.py#L629)

Get structured output from the model.

**Arguments**:

-   `output_model` - The output model to use for the agent.
-   `prompt` - The prompt messages to use for the agent.
-   `system_prompt` - System prompt to provide context to the model.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Returns**:

An instance of the output model with the generated data.

**Raises**:

-   `ContextWindowOverflowException` - If the input exceeds the model’s context window.
-   `ValueError` - If the response cannot be parsed into the output model.