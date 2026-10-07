OpenAI model provider.

-   Docs: [https://platform.openai.com/docs/overview](https://platform.openai.com/docs/overview)

## Client

```python
class Client(Protocol)
```

Defined in: [src/strands/models/openai.py:37](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/openai.py#L37)

Protocol defining the OpenAI-compatible interface for the underlying provider client.

#### chat

```python
@property
def chat() -> Any
```

Defined in: [src/strands/models/openai.py:42](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/openai.py#L42)

Chat completions interface.

## OpenAIModel

```python
class OpenAIModel(Model)
```

Defined in: [src/strands/models/openai.py:47](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/openai.py#L47)

OpenAI model provider implementation.

## OpenAIConfig

```python
class OpenAIConfig(BaseModelConfig)
```

Defined in: [src/strands/models/openai.py:52](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/openai.py#L52)

Configuration options for OpenAI models.

**Attributes**:

-   `model_id` - Model ID (e.g., “gpt-4o”). For a complete list of supported models, see [https://platform.openai.com/docs/models](https://platform.openai.com/docs/models).
-   `params` - Model parameters (e.g., max\_tokens). For a complete list of supported parameters, see [https://platform.openai.com/docs/api-reference/chat/create](https://platform.openai.com/docs/api-reference/chat/create).
-   `stream` - Whether to use OpenAI chat completion streaming. Defaults to True.
-   `cache_config` - Prompt-caching configuration. OpenAI routes cache reads on `cache_key` (mapped to `prompt_cache_key`) and honors `ttl` only when it names an OpenAI retention value; other fields have no effect. An explicit `prompt_cache_key`/`prompt_cache_retention` in `params` takes precedence.

#### \_\_init\_\_

```python
def __init__(client: Client | None = None,
             client_args: dict[str, Any] | None = None,
             bedrock_mantle_config: BedrockMantleConfig | None = None,
             **model_config: Unpack[OpenAIConfig]) -> None
```

Defined in: [src/strands/models/openai.py:73](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/openai.py#L73)

Initialize provider instance.

**Arguments**:

-   `client` - Pre-configured OpenAI-compatible client to reuse across requests. When provided, this client will be reused for all requests and will NOT be closed by the model. The caller is responsible for managing the client lifecycle. This is useful for:
    -   Injecting custom client wrappers (e.g., GuardrailsAsyncOpenAI)
    -   Reusing connection pools within a single event loop/worker
    -   Centralizing observability, retries, and networking policy
    -   Pointing to custom model gateways
-   `Note` - The client should not be shared across different asyncio event loops.
-   `client_args` - Arguments for the OpenAI client (legacy approach). For a complete list of supported arguments, see [https://pypi.org/project/openai/](https://pypi.org/project/openai/). May be combined with `bedrock_mantle_config`; when both are set, `bedrock_mantle_config` derives `base_url` and `api_key` (which must not appear in `client_args`).
-   `bedrock_mantle_config` - Route requests through one of Amazon Bedrock’s OpenAI-compatible endpoints, `bedrock-mantle` (the default) or `bedrock-runtime` via the config’s `endpoint` key. See :class:`BedrockMantleConfig` for accepted keys. When set, a fresh bearer token is minted on every request. Cannot be combined with a pre-built `client`.
-   `**model_config` - Configuration options for the OpenAI model.

**Raises**:

-   `ValueError` - If `client` is combined with `client_args` or `bedrock_mantle_config`.

#### update\_config

```python
@override
def update_config(**model_config: Unpack[OpenAIConfig]) -> None
```

Defined in: [src/strands/models/openai.py:143](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/openai.py#L143)

Update the OpenAI model configuration with the provided arguments.

**Arguments**:

-   `**model_config` - Configuration overrides.

#### get\_config

```python
@override
def get_config() -> OpenAIConfig
```

Defined in: [src/strands/models/openai.py:153](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/openai.py#L153)

Get the OpenAI model configuration.

**Returns**:

The OpenAI model configuration.

#### format\_request\_message\_content

```python
@classmethod
def format_request_message_content(cls, content: ContentBlock,
                                   **kwargs: Any) -> dict[str, Any]
```

Defined in: [src/strands/models/openai.py:164](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/openai.py#L164)

Format an OpenAI compatible content block.

**Arguments**:

-   `content` - Message content.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Returns**:

OpenAI compatible content block.

**Raises**:

-   `TypeError` - If the content block type cannot be converted to an OpenAI-compatible format.

#### format\_request\_message\_tool\_call

```python
@classmethod
def format_request_message_tool_call(cls, tool_use: ToolUse,
                                     **kwargs: Any) -> dict[str, Any]
```

Defined in: [src/strands/models/openai.py:207](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/openai.py#L207)

Format an OpenAI compatible tool call.

**Arguments**:

-   `tool_use` - Tool use requested by the model.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Returns**:

OpenAI compatible tool call.

#### format\_request\_tool\_message

```python
@classmethod
def format_request_tool_message(cls, tool_result: ToolResult,
                                **kwargs: Any) -> dict[str, Any]
```

Defined in: [src/strands/models/openai.py:227](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/openai.py#L227)

Format an OpenAI compatible tool message.

**Arguments**:

-   `tool_result` - Tool result collected from a tool execution.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Returns**:

OpenAI compatible tool message.

#### format\_request\_messages

```python
@classmethod
def format_request_messages(cls,
                            messages: Messages,
                            system_prompt: str | None = None,
                            *,
                            system_prompt_content: list[SystemContentBlock]
                            | None = None,
                            **kwargs: Any) -> list[dict[str, Any]]
```

Defined in: [src/strands/models/openai.py:460](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/openai.py#L460)

Format an OpenAI compatible messages array.

**Arguments**:

-   `messages` - List of message objects to be processed by the model.
-   `system_prompt` - System prompt to provide context to the model.
-   `system_prompt_content` - System prompt content blocks to provide context to the model.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Returns**:

An OpenAI compatible messages array.

#### format\_request

```python
def format_request(messages: Messages,
                   tool_specs: list[ToolSpec] | None = None,
                   system_prompt: str | None = None,
                   tool_choice: ToolChoice | None = None,
                   *,
                   system_prompt_content: list[SystemContentBlock]
                   | None = None,
                   agent_metadata: AgentMetadata | None = None,
                   **kwargs: Any) -> dict[str, Any]
```

Defined in: [src/strands/models/openai.py:484](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/openai.py#L484)

Format an OpenAI compatible chat streaming request.

**Arguments**:

-   `messages` - List of message objects to be processed by the model.
-   `tool_specs` - List of tool specifications to make available to the model.
-   `system_prompt` - System prompt to provide context to the model.
-   `tool_choice` - Selection strategy for tool invocation.
-   `system_prompt_content` - System prompt content blocks to provide context to the model.
-   `agent_metadata` - Invoking agent’s metadata.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Returns**:

An OpenAI compatible chat streaming request.

**Raises**:

-   `TypeError` - If a message contains a content block type that cannot be converted to an OpenAI-compatible format.

#### format\_chunk

```python
def format_chunk(event: dict[str, Any], **kwargs: Any) -> StreamEvent
```

Defined in: [src/strands/models/openai.py:545](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/openai.py#L545)

Format an OpenAI response event into a standardized message chunk.

**Arguments**:

-   `event` - A response event from the OpenAI compatible model.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Returns**:

The formatted chunk.

**Raises**:

-   `RuntimeError` - If chunk\_type is not recognized. This error should never be encountered as chunk\_type is controlled in the stream method.

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

Defined in: [src/strands/models/openai.py:698](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/openai.py#L698)

Stream conversation with the OpenAI model.

**Arguments**:

-   `messages` - List of message objects to be processed by the model.
-   `tool_specs` - List of tool specifications to make available to the model.
-   `system_prompt` - System prompt to provide context to the model.
-   `tool_choice` - Selection strategy for tool invocation.
-   `agent_metadata` - Invoking agent’s identity, used to derive a prompt-cache routing key.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Yields**:

Formatted message chunks from the model.

**Raises**:

-   `ContextWindowOverflowException` - If the input exceeds the model’s context window.
-   `ModelThrottledException` - If the request is throttled by OpenAI (rate limits).

#### structured\_output

```python
@override
async def structured_output(
        output_model: type[T],
        prompt: Messages,
        system_prompt: str | None = None,
        **kwargs: Any) -> AsyncGenerator[dict[str, T | Any], None]
```

Defined in: [src/strands/models/openai.py:841](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/openai.py#L841)

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
-   `ModelThrottledException` - If the request is throttled by OpenAI (rate limits).