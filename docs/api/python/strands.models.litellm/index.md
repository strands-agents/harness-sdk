LiteLLM model provider.

-   Docs: [https://docs.litellm.ai/](https://docs.litellm.ai/)

## LiteLLMModel

```python
class LiteLLMModel(OpenAIModel)
```

Defined in: [src/strands/models/litellm.py:68](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/litellm.py#L68)

LiteLLM model provider implementation.

## LiteLLMConfig

```python
class LiteLLMConfig(BaseModelConfig)
```

Defined in: [src/strands/models/litellm.py:71](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/litellm.py#L71)

Configuration options for LiteLLM models.

**Attributes**:

-   `model_id` - Model ID (e.g., “openai/gpt-4o”, “anthropic/claude-3-sonnet”). For a complete list of supported models, see [https://docs.litellm.ai/docs/providers](https://docs.litellm.ai/docs/providers).
-   `params` - Model parameters (e.g., max\_tokens). For a complete list of supported parameters, see [https://docs.litellm.ai/docs/completion/input#input-params-1](https://docs.litellm.ai/docs/completion/input#input-params-1).
-   `stream` - Whether to use streaming. Defaults to True.
-   `cache_config` - Prompt-caching configuration. LiteLLM’s OpenAI-compatible request path consumes it as `OpenAIModel` does, except that the routing key is sent only to models LiteLLM accepts `prompt_cache_key` for. When `model_info` says the backend’s model takes cache points (Anthropic, Bedrock and Vertex AI Claude), it also places them on the system prompt and the latest user message. For a proxy alias, whose backend the id does not name, declare it with `model_info=ModelInfo(capabilities=ModelCapabilities(prompt_caching="cache_points"))`.

#### \_\_init\_\_

```python
def __init__(client_args: dict[str, Any] | None = None,
             **model_config: Unpack[LiteLLMConfig]) -> None
```

Defined in: [src/strands/models/litellm.py:94](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/litellm.py#L94)

Initialize provider instance.

**Arguments**:

-   `client_args` - Arguments for the LiteLLM client. For a complete list of supported arguments, see [https://github.com/BerriAI/litellm/blob/main/litellm/main.py](https://github.com/BerriAI/litellm/blob/main/litellm/main.py).
-   `**model_config` - Configuration options for the LiteLLM model.

#### update\_config

```python
@override
def update_config(**model_config: Unpack[LiteLLMConfig]) -> None
```

Defined in: [src/strands/models/litellm.py:111](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/litellm.py#L111)

Update the LiteLLM model configuration with the provided arguments.

**Arguments**:

-   `**model_config` - Configuration overrides.

#### get\_config

```python
@override
def get_config() -> LiteLLMConfig
```

Defined in: [src/strands/models/litellm.py:122](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/litellm.py#L122)

Get the LiteLLM model configuration.

**Returns**:

The LiteLLM model configuration.

#### model\_info

```python
@property
@override
def model_info() -> ModelInfo
```

Defined in: [src/strands/models/litellm.py:136](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/litellm.py#L136)

What the SDK knows about the backend model LiteLLM routes to.

`prompt_caching` comes from the shared model info for the id without its LiteLLM provider prefix. A backend that does not take `cache_control` reports `auto` instead of `cache_points`, since no cache point reaches it.

#### format\_request\_message\_content

```python
@override
@classmethod
def format_request_message_content(cls, content: ContentBlock,
                                   **kwargs: Any) -> dict[str, Any]
```

Defined in: [src/strands/models/litellm.py:151](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/litellm.py#L151)

Format a LiteLLM content block.

**Arguments**:

-   `content` - Message content.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Returns**:

LiteLLM formatted content block.

**Raises**:

-   `TypeError` - If the content block type cannot be converted to a LiteLLM-compatible format.

#### format\_request\_message\_tool\_call

```python
@override
@classmethod
def format_request_message_tool_call(cls, tool_use: ToolUse,
                                     **kwargs: Any) -> dict[str, Any]
```

Defined in: [src/strands/models/litellm.py:184](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/litellm.py#L184)

Format a LiteLLM compatible tool call, encoding thought signatures into the tool call ID.

Gemini thinking models attach a thought\_signature to each function call. LiteLLM’s OpenAI-compatible interface embeds this signature inside the tool call ID using the `__thought__` separator. When `reasoningSignature` is present and the tool call ID does not already contain the separator, this method encodes it so LiteLLM can reconstruct the Gemini-native format on the next request.

**Arguments**:

-   `tool_use` - Tool use requested by the model.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Returns**:

LiteLLM compatible tool call dict with thought signature encoded in the ID when present.

#### format\_request\_messages

```python
@override
@classmethod
def format_request_messages(cls,
                            messages: Messages,
                            system_prompt: str | None = None,
                            *,
                            system_prompt_content: list[SystemContentBlock]
                            | None = None,
                            **kwargs: Any) -> list[dict[str, Any]]
```

Defined in: [src/strands/models/litellm.py:295](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/litellm.py#L295)

Format a LiteLLM compatible messages array with cache point support.

**Arguments**:

-   `messages` - List of message objects to be processed by the model.
-   `system_prompt` - System prompt to provide context to the model (for legacy compatibility).
-   `system_prompt_content` - System prompt content blocks to provide context to the model.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Returns**:

A LiteLLM compatible messages array.

#### format\_chunk

```python
@override
def format_chunk(event: dict[str, Any], **kwargs: Any) -> StreamEvent
```

Defined in: [src/strands/models/litellm.py:362](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/litellm.py#L362)

Format a LiteLLM response event into a standardized message chunk.

Extends OpenAI’s format\_chunk to support legacy Anthropic cache usage and extract thought signatures that LiteLLM embeds in tool call IDs for Gemini thinking models.

**Arguments**:

-   `event` - A response event from the LiteLLM model.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Returns**:

The formatted chunk.

**Raises**:

-   `RuntimeError` - If chunk\_type is not recognized.

#### format\_request

```python
@override
def format_request(messages: Messages,
                   tool_specs: list[ToolSpec] | None = None,
                   system_prompt: str | None = None,
                   tool_choice: ToolChoice | None = None,
                   *,
                   system_prompt_content: list[SystemContentBlock]
                   | None = None,
                   agent_metadata: AgentMetadata | None = None,
                   dynamic_trailing_blocks: int = 0,
                   **kwargs: Any) -> dict[str, Any]
```

Defined in: [src/strands/models/litellm.py:398](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/litellm.py#L398)

Format a LiteLLM chat request.

Builds the request as `OpenAIModel` does. For a backend that takes cache points, with `cache_config` set, it first places cache points on the system prompt and the latest user message, ahead of its rebuilt trailing blocks. It also marks the last tool when `cache_config.tools_ttl` asks for it and keeps the request within the backend’s cache point limit; for any other backend it drops message cache points, which only those backends accept. It then leaves out the `prompt_cache_key` resolved from `cache_config` when LiteLLM would reject it for the model.

**Arguments**:

-   `messages` - List of message objects to be processed by the model.
-   `tool_specs` - List of tool specifications to make available to the model.
-   `system_prompt` - System prompt to provide context to the model.
-   `tool_choice` - Selection strategy for tool invocation.
-   `system_prompt_content` - System prompt content blocks to provide context to the model.
-   `agent_metadata` - Invoking agent’s metadata.
-   `dynamic_trailing_blocks` - How many trailing blocks of the latest user message are rebuilt on every call, so the conversation cache point stays ahead of them.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Returns**:

A LiteLLM chat request.

**Raises**:

-   `TypeError` - If a message contains a content block type that cannot be converted to a LiteLLM-compatible format.

#### stream

```python
@override
async def stream(messages: Messages,
                 tool_specs: list[ToolSpec] | None = None,
                 system_prompt: str | None = None,
                 *,
                 tool_choice: ToolChoice | None = None,
                 system_prompt_content: list[SystemContentBlock] | None = None,
                 agent_metadata: AgentMetadata | None = None,
                 **kwargs: Any) -> AsyncGenerator[StreamEvent, None]
```

Defined in: [src/strands/models/litellm.py:537](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/litellm.py#L537)

Stream conversation with the LiteLLM model.

**Arguments**:

-   `messages` - List of message objects to be processed by the model.
-   `tool_specs` - List of tool specifications to make available to the model.
-   `system_prompt` - System prompt to provide context to the model.
-   `tool_choice` - Selection strategy for tool invocation.
-   `system_prompt_content` - System prompt content blocks to provide context to the model.
-   `agent_metadata` - Invoking agent’s metadata.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Yields**:

Formatted message chunks from the model.

#### structured\_output

```python
@override
async def structured_output(
        output_model: type[T],
        prompt: Messages,
        system_prompt: str | None = None,
        **kwargs: Any) -> AsyncGenerator[dict[str, T | Any], None]
```

Defined in: [src/strands/models/litellm.py:596](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/litellm.py#L596)

Get structured output from the model.

Some models do not support native structured output via response\_format. In cases of proxies, we may not have a way to determine support, so we fallback to using tool calling to achieve structured output.

**Arguments**:

-   `output_model` - The output model to use for the agent.
-   `prompt` - The prompt messages to use for the agent.
-   `system_prompt` - System prompt to provide context to the model.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Yields**:

Model events with the last being the structured output.