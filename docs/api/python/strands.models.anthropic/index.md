Anthropic Claude model provider.

-   Docs: [https://docs.anthropic.com/claude/reference/getting-started-with-the-api](https://docs.anthropic.com/claude/reference/getting-started-with-the-api)
-   Server tools: [https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview)

#### COMPACTION\_BETA

Beta that enables on-demand compaction, and compaction blocks in later requests.

#### TURN\_SCOPED\_SYSTEM\_BETA

Beta that lets a mid-conversation system message carry `clear_at`.

See [https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages)

## AnthropicModel

```python
class AnthropicModel(Model)
```

Defined in: [src/strands/models/anthropic.py:223](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/anthropic.py#L223)

Anthropic model provider implementation.

## AnthropicConfig

```python
class AnthropicConfig(BaseModelConfig)
```

Defined in: [src/strands/models/anthropic.py:243](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/anthropic.py#L243)

Configuration options for Anthropic models.

**Attributes**:

-   `cache_config` - Configuration for prompt caching. Adds a cache point to the last user message, caching everything before it. Caching is off when unset.
-   `cache_tools` - Caches the tool definitions (deprecated, use CacheConfig(tools\_ttl=…)). Superseded by an explicitly set cache\_config.tools\_ttl.
-   `max_tokens` - Maximum number of tokens to generate.
-   `model_id` - Calude model ID (e.g., “claude-3-7-sonnet-latest”). For a complete list of supported models, see [https://docs.anthropic.com/en/docs/about-claude/models/all-models](https://docs.anthropic.com/en/docs/about-claude/models/all-models).
-   `params` - Additional model parameters (e.g., metadata, stop\_sequences). For a complete list of supported parameters, see [https://docs.anthropic.com/en/api/messages](https://docs.anthropic.com/en/api/messages). Sampling parameters (temperature, top\_k, top\_p) are rejected from API version 2026-10-21 on; pin 2023-06-01 with client\_args={“default\_headers”: {“anthropic-version”: “2023-06-01”}} (or the same default\_headers on a client passed as client=).
-   `anthropic_tools` - Anthropic-specific server-side tools that are not function tools (e.g., web\_search, web\_fetch, code\_execution). Appended alongside the agent’s function tools. Use the standard tools interface for function calling tools. For a complete list of supported tools, see [https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview)
-   `use_native_token_count` - Whether to use the native Anthropic count\_tokens API. When True, count\_tokens() calls the Anthropic API for accurate counts. When False (default), skips the API call and uses the local estimator.

#### \_\_init\_\_

```python
def __init__(*,
             client: "_AsyncClient | None" = None,
             client_args: dict[str, Any] | None = None,
             **model_config: Unpack[AnthropicConfig])
```

Defined in: [src/strands/models/anthropic.py:278](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/anthropic.py#L278)

Initialize provider instance.

**Arguments**:

-   `client` - A pre-configured Anthropic-compatible async client, e.g. `anthropic.AsyncAnthropicBedrock()`, `anthropic.AsyncAnthropicBedrockMantle()` (anthropic>=0.91) or `anthropic.AsyncAnthropicVertex()`. The model does not close it.
-   `client_args` - Arguments for the underlying Anthropic client (e.g., api\_key). For a complete list of supported arguments, see [https://docs.anthropic.com/en/api/client-sdks](https://docs.anthropic.com/en/api/client-sdks).
-   `**model_config` - Configuration options for the Anthropic model.

**Raises**:

-   `ValueError` - If both `client` and `client_args` are provided.

#### update\_config

```python
@override
def update_config(**model_config: Unpack[AnthropicConfig]) -> None
```

Defined in: [src/strands/models/anthropic.py:314](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/anthropic.py#L314)

Update the Anthropic model configuration with the provided arguments.

**Arguments**:

-   `**model_config` - Configuration overrides.

#### model\_info

```python
@property
@override
def model_info() -> ModelInfo
```

Defined in: [src/strands/models/anthropic.py:330](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/anthropic.py#L330)

Everything the SDK knows about the configured model, with `temporary_messages` on for supported Claude.

`temporary_messages` follows the model id, not the client, so it is also on through the Bedrock and Vertex clients. If those reject the turn-scoped system messages, set `model_info=ModelInfo(capabilities=ModelCapabilities(temporary_messages=False))`. See :attr:`strands.models.Model.model_info`.

#### get\_config

```python
@override
def get_config() -> AnthropicConfig
```

Defined in: [src/strands/models/anthropic.py:346](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/anthropic.py#L346)

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

Defined in: [src/strands/models/anthropic.py:710](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/anthropic.py#L710)

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
-   `ValueError` - If params sets a sampling parameter both directly and in extra\_body, or sets one while the request uses API version 2026-10-21 or later.

#### format\_chunk

```python
def format_chunk(event: dict[str, Any]) -> StreamEvent
```

Defined in: [src/strands/models/anthropic.py:1036](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/anthropic.py#L1036)

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

Defined in: [src/strands/models/anthropic.py:1158](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/anthropic.py#L1158)

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

Defined in: [src/strands/models/anthropic.py:1211](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/anthropic.py#L1211)

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
-   `ValueError` - If params sets a sampling parameter both directly and in extra\_body, or sets one while the request uses API version 2026-10-21 or later.

#### summarize

```python
@override
async def summarize(messages: Messages,
                    *,
                    tool_specs: list[ToolSpec] | None = None,
                    system_prompt: str | None = None,
                    system_prompt_content: list[SystemContentBlock]
                    | None = None,
                    instructions: str | None = None,
                    cancel_signal: threading.Event | None = None,
                    agent_metadata: "AgentMetadata | None" = None,
                    **kwargs: Any) -> SummarizeResult
```

Defined in: [src/strands/models/anthropic.py:1414](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/anthropic.py#L1414)

Summarize `messages` with Anthropic on-demand compaction.

Sends the request unchanged under beta `compact-2026-09-04`, so the thinking kept after a summary of the live conversation stays valid. The returned compaction block is stored as a `summary` block holding its text and signature; later requests from a model with `server_side_summary` rebuild the compaction block from it and start from it, and requests without it send the summary text. Uses the base :meth:`Model.summarize` when `model_info.capabilities.server_side_summary` is not True, when the compaction request fails with an API error (a rejection, an overload, a timeout or a connection error), or when the response holds no compaction block.

**Arguments**:

-   `messages` - The request to summarize, left unmodified.
-   `tool_specs` - The request’s tool specifications.
-   `system_prompt` - The request’s plain string system prompt.
-   `system_prompt_content` - The request’s structured system prompt.
-   `instructions` - Summarization instructions replacing the API’s own prompt.
-   `cancel_signal` - Event that aborts the base implementation’s call.
-   `agent_metadata` - Stable identity of the invoking agent, passed to the base implementation.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Returns**:

The summary and the usage of every call made for it.

#### structured\_output

```python
@override
async def structured_output(
        output_model: type[T],
        prompt: Messages,
        system_prompt: str | None = None,
        **kwargs: Any) -> AsyncGenerator[dict[str, T | Any], None]
```

Defined in: [src/strands/models/anthropic.py:1550](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/anthropic.py#L1550)

Get structured output from the model.

**Arguments**:

-   `output_model` - The output model to use for the agent.
-   `prompt` - The prompt messages to use for the agent.
-   `system_prompt` - System prompt to provide context to the model.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Yields**:

Model events with the last being the structured output.