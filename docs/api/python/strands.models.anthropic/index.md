Anthropic Claude model provider.

-   Docs: [https://docs.anthropic.com/claude/reference/getting-started-with-the-api](https://docs.anthropic.com/claude/reference/getting-started-with-the-api)
-   Server tools: [https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview)

## AnthropicModel

```python
class AnthropicModel(Model)
```

Defined in: [src/strands/models/anthropic.py:133](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/anthropic.py#L133)

Anthropic model provider implementation.

## AnthropicConfig

```python
class AnthropicConfig(BaseModelConfig)
```

Defined in: [src/strands/models/anthropic.py:153](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/anthropic.py#L153)

Configuration options for Anthropic models.

**Attributes**:

-   `cache_config` - Configuration for prompt caching. Adds a cache point to the last user message, caching everything before it. Caching is off when unset.
-   `cache_tools` - Caches the tool definitions (deprecated, use CacheConfig(tools\_ttl=…)). Superseded by an explicitly set cache\_config.tools\_ttl.
-   `max_tokens` - Maximum number of tokens to generate.
-   `model_id` - Calude model ID (e.g., “claude-3-7-sonnet-latest”). For a complete list of supported models, see [https://docs.anthropic.com/en/docs/about-claude/models/all-models](https://docs.anthropic.com/en/docs/about-claude/models/all-models).
-   `params` - Additional model parameters (e.g., metadata, stop\_sequences). For a complete list of supported parameters, see [https://docs.anthropic.com/en/api/messages](https://docs.anthropic.com/en/api/messages). Sampling parameters (temperature, top\_k, top\_p) are accepted only by API version 2023-06-01; pin it with client\_args={“default\_headers”: {“anthropic-version”: “2023-06-01”}}.
-   `anthropic_tools` - Anthropic-specific server-side tools that are not function tools (e.g., web\_search, web\_fetch, code\_execution). Appended alongside the agent’s function tools. Use the standard tools interface for function calling tools. For a complete list of supported tools, see [https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview)
-   `use_native_token_count` - Whether to use the native Anthropic count\_tokens API. When True, count\_tokens() calls the Anthropic API for accurate counts. When False (default), skips the API call and uses the local estimator.

#### \_\_init\_\_

```python
def __init__(*,
             client_args: dict[str, Any] | None = None,
             **model_config: Unpack[AnthropicConfig])
```

Defined in: [src/strands/models/anthropic.py:187](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/anthropic.py#L187)

Initialize provider instance.

**Arguments**:

-   `client_args` - Arguments for the underlying Anthropic client (e.g., api\_key). For a complete list of supported arguments, see [https://docs.anthropic.com/en/api/client-sdks](https://docs.anthropic.com/en/api/client-sdks).
-   `**model_config` - Configuration options for the Anthropic model.

#### update\_config

```python
@override
def update_config(**model_config: Unpack[AnthropicConfig]) -> None
```

Defined in: [src/strands/models/anthropic.py:209](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/anthropic.py#L209)

Update the Anthropic model configuration with the provided arguments.

**Arguments**:

-   `**model_config` - Configuration overrides.

#### get\_config

```python
@override
def get_config() -> AnthropicConfig
```

Defined in: [src/strands/models/anthropic.py:224](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/anthropic.py#L224)

Get the Anthropic model configuration.

**Returns**:

The Anthropic model configuration.

#### format\_request

```python
def format_request(
    messages: Messages,
    tool_specs: list[ToolSpec] | None = None,
    system_prompt: str | None = None,
    tool_choice: ToolChoice | None = None,
    dynamic_trailing_blocks: int = 0,
    *,
    system_prompt_content: list[SystemContentBlock] | None = None
) -> dict[str, Any]
```

Defined in: [src/strands/models/anthropic.py:582](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/anthropic.py#L582)

Format an Anthropic streaming request.

**Arguments**:

-   `messages` - List of message objects to be processed by the model.
-   `tool_specs` - List of tool specifications to make available to the model.
-   `system_prompt` - Plain string system prompt. Ignored when system\_prompt\_content is provided.
-   `tool_choice` - Selection strategy for tool invocation.
-   `dynamic_trailing_blocks` - How many trailing blocks of the last user message are rebuilt on every call, so the cache point stays ahead of them.
-   `system_prompt_content` - Structured system prompt content blocks, which can carry a cache point.

**Returns**:

An Anthropic streaming request.

**Raises**:

-   `TypeError` - If a message contains a content block type that cannot be converted to an Anthropic-compatible format.
-   `ValueError` - If params sets a sampling parameter both directly and in extra\_body, or sets one while the request uses an API version other than 2023-06-01.

#### format\_chunk

```python
def format_chunk(event: dict[str, Any]) -> StreamEvent
```

Defined in: [src/strands/models/anthropic.py:882](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/anthropic.py#L882)

Format the Anthropic response events into standardized message chunks.

**Arguments**:

-   `event` - A response event from the Anthropic model.

**Returns**:

The formatted chunk.

**Raises**:

-   `RuntimeError` - If chunk\_type is not recognized. This error should never be encountered as we control chunk\_type in the stream method.

#### count\_tokens

```python
@override
async def count_tokens(
        messages: Messages,
        tool_specs: list[ToolSpec] | None = None,
        system_prompt: str | None = None,
        system_prompt_content: list[SystemContentBlock] | None = None) -> int
```

Defined in: [src/strands/models/anthropic.py:1021](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/anthropic.py#L1021)

Count tokens using Anthropic’s native count\_tokens API.

Uses the same message format as the Messages API to get accurate token counts directly from the Anthropic service.

**Arguments**:

-   `messages` - List of message objects to count tokens for.
-   `tool_specs` - List of tool specifications to include in the count.
-   `system_prompt` - Plain string system prompt. Ignored if system\_prompt\_content is provided.
-   `system_prompt_content` - Structured system prompt content blocks.

**Returns**:

Total input token count.

#### stream

```python
@override
async def stream(messages: Messages,
                 tool_specs: list[ToolSpec] | None = None,
                 system_prompt: str | None = None,
                 *,
                 tool_choice: ToolChoice | None = None,
                 system_prompt_content: list[SystemContentBlock] | None = None,
                 structured_output_model: type[BaseModel] | None = None,
                 **kwargs: Any) -> AsyncGenerator[StreamEvent, None]
```

Defined in: [src/strands/models/anthropic.py:1071](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/anthropic.py#L1071)

Stream conversation with the Anthropic model.

**Arguments**:

-   `messages` - List of message objects to be processed by the model.
-   `tool_specs` - List of tool specifications to make available to the model.
-   `system_prompt` - Plain string system prompt. Ignored when system\_prompt\_content is provided.
-   `tool_choice` - Selection strategy for tool invocation.
-   `system_prompt_content` - Structured system prompt content blocks, which can carry a cache point.
-   `structured_output_model` - Output model the call must produce; the request is then sent with the strongest structured output mechanism the model supports.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Yields**:

Formatted message chunks from the model.

A server-side tool turn that Anthropic pauses is resumed with follow-up requests inside this call, so an error raised by one of those requests can surface after earlier chunks were already yielded.

**Raises**:

-   `ContextWindowOverflowException` - If the input exceeds the model’s context window.
-   `ModelThrottledException` - If the request is throttled by Anthropic.
-   `RuntimeError` - If a paused server-side tool turn is still paused after the continuation limit.
-   `ValueError` - If params sets a sampling parameter both directly and in extra\_body, or sets one while the request uses an API version other than 2023-06-01.

#### structured\_output

```python
@override
async def structured_output(
        output_model: type[T],
        prompt: Messages,
        system_prompt: str | None = None,
        **kwargs: Any) -> AsyncGenerator[dict[str, T | Any], None]
```

Defined in: [src/strands/models/anthropic.py:1285](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/anthropic.py#L1285)

Get structured output from the model.

**Arguments**:

-   `output_model` - The output model to use for the agent.
-   `prompt` - The prompt messages to use for the agent.
-   `system_prompt` - System prompt to provide context to the model.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Yields**:

Model events with the last being the structured output.