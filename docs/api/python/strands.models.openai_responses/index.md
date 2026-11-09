OpenAI model provider using the Responses API.

Built-in tools (e.g. web\_search, file\_search, code\_interpreter) can be passed via the `params` configuration and will be merged with any agent function tools in the request.

All built-in tools produce text responses that stream correctly. Limitations on tool-specific metadata:

-   web\_search (supported): Full support including URL citations.
-   file\_search (partial): File citation annotations not emitted (no matching CitationLocation variant).
-   code\_interpreter (partial): Executed code and stdout/stderr not surfaced.
-   mcp (partial): Approval flow and `mcp_list_tools`/`mcp_call` events not surfaced.
-   shell (partial): Local (client-executed) mode not supported.
-   tool\_search (not supported): Requires `defer_loading` on function tools, which is not supported.
-   image\_generation (not supported): Requires image content block delta support in the event loop.
-   computer\_use\_preview (not supported): Requires a developer-managed screenshot/action loop.

Docs: [https://platform.openai.com/docs/api-reference/responses](https://platform.openai.com/docs/api-reference/responses)

## Client

```python
class Client(Protocol)
```

Defined in: [src/strands/models/openai\_responses.py:128](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/openai_responses.py#L128)

Protocol defining the OpenAI Responses API interface for the underlying provider client.

#### responses

```python
@property
def responses() -> Any
```

Defined in: [src/strands/models/openai\_responses.py:133](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/openai_responses.py#L133)

Responses interface.

## OpenAIResponsesModel

```python
class OpenAIResponsesModel(Model)
```

Defined in: [src/strands/models/openai\_responses.py:138](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/openai_responses.py#L138)

OpenAI Responses API model provider implementation.

## OpenAIResponsesConfig

```python
class OpenAIResponsesConfig(BaseModelConfig)
```

Defined in: [src/strands/models/openai\_responses.py:144](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/openai_responses.py#L144)

Configuration options for OpenAI Responses API models.

**Attributes**:

-   `model_id` - Model ID (e.g., “gpt-4o”). For a complete list of supported models, see [https://platform.openai.com/docs/models](https://platform.openai.com/docs/models).
-   `params` - Model parameters (e.g., max\_output\_tokens, temperature, etc.). For a complete list of supported parameters, see [https://platform.openai.com/docs/api-reference/responses/create](https://platform.openai.com/docs/api-reference/responses/create).
-   `stateful` - Whether to enable server-side conversation state management. When True, the server stores conversation history and the client does not need to send the full message history with each request. Defaults to False.
-   `use_native_token_count` - Whether to use the native OpenAI input\_tokens.count API. When True, count\_tokens() calls the OpenAI API for accurate counts. When False (default), skips the API call and uses the local estimator.
-   `cache_config` - Prompt-caching configuration. OpenAI routes cache reads on `cache_key` (mapped to `prompt_cache_key`) and honors `ttl` when it names an OpenAI retention value (`prompt_cache_retention`). On models whose `model_info` says they take cache points (GPT-5.6 and later), message checkpoints keep per-call injected content out of the cache; `strategy="auto"` or `"anthropic"` places them and `messages_ttl=False` disables them. There, a `"30m"`/`"12h"` `messages_ttl` sets each checkpoint’s `ttl` and such a `ttl` sets `prompt_cache_options.ttl`. `tools_ttl` and `system_prompt_ttl` have no effect. Native caching fields in `params` take precedence.

#### \_\_init\_\_

```python
def __init__(client_args: dict[str, Any] | None = None,
             bedrock_mantle_config: BedrockMantleConfig | None = None,
             *,
             client: Client | None = None,
             **model_config: Unpack[OpenAIResponsesConfig]) -> None
```

Defined in: [src/strands/models/openai\_responses.py:176](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/openai_responses.py#L176)

Initialize provider instance.

**Arguments**:

-   `client_args` - Arguments for the OpenAI client. For a complete list of supported arguments, see [https://pypi.org/project/openai/](https://pypi.org/project/openai/). May be combined with `bedrock_mantle_config`; when both are set, the config derives `base_url` and `api_key` (which must not appear in `client_args`).
-   `bedrock_mantle_config` - Route requests through one of Amazon Bedrock’s OpenAI-compatible endpoints, `bedrock-mantle` (the default) or `bedrock-runtime` via the config’s `endpoint` key. See :class:`BedrockMantleConfig` for accepted keys. When set, a fresh bearer token is minted on every request. Cannot be combined with `client`.
-   `client` - Pre-configured OpenAI-compatible async client to reuse across requests, e.g. an `openai.AsyncOpenAI` pointed at an Amazon Bedrock endpoint. The model does not close it, and it should not be shared across asyncio event loops.
-   `**model_config` - Configuration options for the OpenAI Responses API model.

**Raises**:

-   `ValueError` - If `client` is combined with `client_args` or `bedrock_mantle_config`.

#### model\_info

```python
@property
@override
def model_info() -> ModelInfo
```

Defined in: [src/strands/models/openai\_responses.py:248](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/openai_responses.py#L248)

Adds whether server-side conversation storage is enabled, and reports server-side summary as off.

Storage is taken from the `stateful` configuration option; a `model_info` override still wins over both.

#### update\_config

```python
@override
def update_config(**model_config: Unpack[OpenAIResponsesConfig]) -> None
```

Defined in: [src/strands/models/openai\_responses.py:261](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/openai_responses.py#L261)

Update the OpenAI Responses API model configuration with the provided arguments.

**Arguments**:

-   `**model_config` - Configuration overrides.

#### get\_config

```python
@override
def get_config() -> OpenAIResponsesConfig
```

Defined in: [src/strands/models/openai\_responses.py:271](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/openai_responses.py#L271)

Get the OpenAI Responses API model configuration.

**Returns**:

The OpenAI Responses API model configuration.

#### count\_tokens

```python
@override
async def count_tokens(
        messages: Messages,
        tool_specs: list[ToolSpec] | None = None,
        system_prompt: str | None = None,
        system_prompt_content: list[SystemContentBlock] | None = None) -> int
```

Defined in: [src/strands/models/openai\_responses.py:283](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/openai_responses.py#L283)

Count tokens using the OpenAI Responses API input\_tokens.count endpoint.

Uses the same message format as the Responses API to get accurate token counts directly from the OpenAI service.

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
                 model_state: dict[str, Any] | None = None,
                 agent_metadata: AgentMetadata | None = None,
                 **kwargs: Any) -> AsyncGenerator[StreamEvent, None]
```

Defined in: [src/strands/models/openai\_responses.py:335](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/openai_responses.py#L335)

Stream conversation with the OpenAI Responses API model.

**Arguments**:

-   `messages` - List of message objects to be processed by the model.
-   `tool_specs` - List of tool specifications to make available to the model.
-   `system_prompt` - System prompt to provide context to the model.
-   `tool_choice` - Selection strategy for tool invocation.
-   `model_state` - Runtime state for model providers (e.g., server-side response ids).
-   `agent_metadata` - Invoking agent’s metadata.
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

Defined in: [src/strands/models/openai\_responses.py:557](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/openai_responses.py#L557)

Get structured output from the OpenAI Responses API model.

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