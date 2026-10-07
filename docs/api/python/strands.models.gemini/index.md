Google Gemini model provider.

-   Docs: [https://ai.google.dev/api](https://ai.google.dev/api)

## GeminiModel

```python
class GeminiModel(Model)
```

Defined in: [src/strands/models/gemini.py:32](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/gemini.py#L32)

Google Gemini model provider implementation.

-   Docs: [https://ai.google.dev/api](https://ai.google.dev/api)

## GeminiConfig

```python
class GeminiConfig(BaseModelConfig)
```

Defined in: [src/strands/models/gemini.py:38](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/gemini.py#L38)

Configuration options for Gemini models.

**Attributes**:

-   `model_id` - Gemini model ID (e.g., “gemini-2.5-flash”). For a complete list of supported models, see [https://ai.google.dev/gemini-api/docs/models](https://ai.google.dev/gemini-api/docs/models)
-   `params` - Additional model parameters (e.g., temperature). For a complete list of supported parameters, see [https://ai.google.dev/api/generate-content#generationconfig](https://ai.google.dev/api/generate-content#generationconfig).
-   `gemini_tools` - Gemini-specific tools that are not FunctionDeclarations (e.g., GoogleSearch, CodeExecution, ComputerUse, UrlContext, FileSearch). Use the standard tools interface for function calling tools. For a complete list of supported tools, see [https://ai.google.dev/api/caching#Tool](https://ai.google.dev/api/caching#Tool)
-   `use_native_token_count` - Whether to use the native Gemini count\_tokens API. When True, count\_tokens() calls the Gemini API for accurate counts. When False (default), skips the API call and uses the local estimator.

#### \_\_init\_\_

```python
def __init__(*,
             client: genai.Client | None = None,
             client_args: dict[str, Any] | None = None,
             **model_config: Unpack[GeminiConfig]) -> None
```

Defined in: [src/strands/models/gemini.py:63](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/gemini.py#L63)

Initialize provider instance.

**Arguments**:

-   `client` - Pre-configured Gemini client to reuse across requests. When provided, this client will be reused for all requests and will NOT be closed by the model. The caller is responsible for managing the client lifecycle. This is useful for:
    -   Injecting custom client wrappers
    -   Reusing connection pools within a single event loop/worker
    -   Centralizing observability, retries, and networking policy
-   `Note` - The client should not be shared across different asyncio event loops.
-   `client_args` - Arguments for the underlying Gemini client (e.g., api\_key). For a complete list of supported arguments, see [https://googleapis.github.io/python-genai/](https://googleapis.github.io/python-genai/).
-   `**model_config` - Configuration options for the Gemini model.

**Raises**:

-   `ValueError` - If both `client` and `client_args` are provided.

#### update\_config

```python
@override
def update_config(**model_config: Unpack[GeminiConfig]) -> None
```

Defined in: [src/strands/models/gemini.py:105](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/gemini.py#L105)

Update the Gemini model configuration with the provided arguments.

**Arguments**:

-   `**model_config` - Configuration overrides.

#### get\_config

```python
@override
def get_config() -> GeminiConfig
```

Defined in: [src/strands/models/gemini.py:118](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/gemini.py#L118)

Get the Gemini model configuration.

**Returns**:

The Gemini model configuration.

#### count\_tokens

```python
@override
async def count_tokens(
        messages: Messages,
        tool_specs: list[ToolSpec] | None = None,
        system_prompt: str | None = None,
        system_prompt_content: list[SystemContentBlock] | None = None) -> int
```

Defined in: [src/strands/models/gemini.py:522](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/gemini.py#L522)

Count tokens using Gemini’s native count\_tokens API.

Uses the Gemini count\_tokens API for message contents. The Gemini API does not support counting system\_instruction or tools, so those are estimated via the base class heuristic.

**Arguments**:

-   `messages` - List of message objects to count tokens for.
-   `tool_specs` - List of tool specifications to include in the count.
-   `system_prompt` - Plain string system prompt.
-   `system_prompt_content` - Structured system prompt content blocks.

**Returns**:

Total input token count.

#### stream

```python
async def stream(messages: Messages,
                 tool_specs: list[ToolSpec] | None = None,
                 system_prompt: str | None = None,
                 *,
                 tool_choice: ToolChoice | None = None,
                 **kwargs: Any) -> AsyncGenerator[StreamEvent, None]
```

Defined in: [src/strands/models/gemini.py:583](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/gemini.py#L583)

Stream conversation with the Gemini model.

**Arguments**:

-   `messages` - List of message objects to be processed by the model.
-   `tool_specs` - List of tool specifications to make available to the model.
-   `system_prompt` - System prompt to provide context to the model.
-   `tool_choice` - Selection strategy for tool invocation. Applied only when tool specs are provided, since there is nothing to choose from without them, and only when params sets no tool config of its own - an explicit tool config takes precedence.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Yields**:

Formatted message chunks from the model.

**Raises**:

-   `ModelThrottledException` - If the request is throttled by Gemini.

#### structured\_output

```python
@override
async def structured_output(
        output_model: type[T],
        prompt: Messages,
        system_prompt: str | None = None,
        **kwargs: Any) -> AsyncGenerator[dict[str, T | Any], None]
```

Defined in: [src/strands/models/gemini.py:697](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/gemini.py#L697)

Get structured output from the model using Gemini’s native structured output.

-   Docs: [https://ai.google.dev/gemini-api/docs/structured-output](https://ai.google.dev/gemini-api/docs/structured-output)

**Arguments**:

-   `output_model` - The output model to use for the agent.
-   `prompt` - The prompt messages to use for the agent.
-   `system_prompt` - System prompt to provide context to the model.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Yields**:

Model events with the last being the structured output.