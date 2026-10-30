AWS Bedrock model provider.

-   Docs: [https://aws.amazon.com/bedrock/](https://aws.amazon.com/bedrock/)

## BedrockModel

```python
class BedrockModel(Model)
```

Defined in: [src/strands/models/bedrock.py:205](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/bedrock.py#L205)

AWS Bedrock model provider implementation.

The implementation handles Bedrock-specific features such as:

-   Tool configuration for function calling
-   Guardrails integration
-   Caching points for system prompts and tools
-   Streaming responses
-   Context window overflow detection

## BedrockConfig

```python
class BedrockConfig(BaseModelConfig)
```

Defined in: [src/strands/models/bedrock.py:219](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/bedrock.py#L219)

Configuration options for Bedrock models.

**Attributes**:

-   `additional_args` - Any additional arguments to include in the request
-   `additional_request_fields` - Additional fields to include in the Bedrock request
-   `additional_response_field_paths` - Additional response field paths to extract
-   `cache_prompt` - Cache point type for the system prompt (deprecated, use cache\_config)
-   `cache_config` - Configuration for prompt caching. Use CacheConfig(strategy=“auto”) for automatic caching.
-   `cache_tools` - Cache point type for tools (deprecated, use CacheConfig(tools\_ttl=…)). Pass a string (e.g. “default”) to cache the tools with no explicit TTL, or a CacheToolsConfig instance to set both type and TTL (e.g. “1h”). Inherits cache\_config.ttl if specified, otherwise it takes the Bedrock default. Superseded by an explicitly set cache\_config.tools\_ttl.
-   `guardrail_id` - ID of the guardrail to apply
-   `guardrail_trace` - Guardrail trace mode. Defaults to enabled.
-   `guardrail_version` - Version of the guardrail to apply
-   `guardrail_stream_processing_mode` - The guardrail processing mode
-   `guardrail_redact_input` - Flag to redact input if a guardrail is triggered. Defaults to True.
-   `guardrail_redact_input_message` - If a Bedrock Input guardrail triggers, replace the input with this message.
-   `guardrail_redact_output` - Flag to redact output if guardrail is triggered. Defaults to False.
-   `guardrail_redact_output_message` - If a Bedrock Output guardrail triggers, replace output with this message.
-   `guardrail_latest_message` - Flag to send only the lastest user message to guardrails. Defaults to False.
-   `max_tokens` - Maximum number of tokens to generate in the response
-   `model_id` - The Bedrock model ID (e.g., “global.anthropic.claude-sonnet-4-6”)
-   `include_tool_result_status` - Flag to include status field in tool results. True includes status, False removes status, “auto” determines based on model\_id. Defaults to “auto”.
-   `service_tier` - Service tier for the request, controlling the trade-off between latency and cost. Valid values: “default” (standard), “priority” (faster, premium), “flex” (cheaper, slower). Please check [https://docs.aws.amazon.com/bedrock/latest/userguide/service-tiers-inference.html](https://docs.aws.amazon.com/bedrock/latest/userguide/service-tiers-inference.html) for supported service tiers, models, and regions
-   `stop_sequences` - List of sequences that will stop generation when encountered
-   `streaming` - Flag to enable/disable streaming. Defaults to True.
-   `strict_tools` - Flag to enable structured output enforcement on tool definitions. When True, adds strict: true to each tool spec and automatically injects
-   `"additionalProperties"` - false into all object types in tool input schemas. Bedrock’s strict mode compiles tool schemas into a constrained-decoding grammar and restricts which JSON Schema features tool input schemas may use (for example, “oneOf” is unsupported and optional parameters are capped across all tools in the request). A schema that uses an unsupported feature fails at request time with a ValidationException. See [https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html](https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html)
-   `temperature` - Controls randomness in generation (higher = more random)
-   `top_p` - Controls diversity via nucleus sampling (alternative to temperature)
-   `use_native_token_count` - Whether to use the native Bedrock CountTokens API. When True, count\_tokens() calls the Bedrock API for accurate counts. When False (default), skips the API call and uses the local estimator.

#### \_\_init\_\_

```python
def __init__(*,
             boto_session: boto3.Session | None = None,
             boto_client_config: BotocoreConfig | None = None,
             region_name: str | None = None,
             endpoint_url: str | None = None,
             api_key: str | None = None,
             **model_config: Unpack[BedrockConfig])
```

Defined in: [src/strands/models/bedrock.py:294](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/bedrock.py#L294)

Initialize provider instance.

**Arguments**:

-   `boto_session` - Boto Session to use when calling the Bedrock Model.
-   `boto_client_config` - Configuration to use when creating the Bedrock-Runtime Boto Client.
-   `region_name` - AWS region to use for the Bedrock service. Defaults to the AWS\_REGION environment variable if set, or “us-west-2” if not set.
-   `endpoint_url` - Custom endpoint URL for VPC endpoints (PrivateLink)
-   `api_key` - Amazon Bedrock API key for bearer token authentication. When provided, requests use the API key instead of SigV4 signing.
-   `**model_config` - Configuration options for the Bedrock model.

#### update\_config

```python
@override
def update_config(**model_config: Unpack[BedrockConfig]) -> None
```

Defined in: [src/strands/models/bedrock.py:389](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/bedrock.py#L389)

Update the Bedrock Model configuration with the provided arguments.

**Arguments**:

-   `**model_config` - Configuration overrides.

#### get\_config

```python
@override
def get_config() -> BedrockConfig
```

Defined in: [src/strands/models/bedrock.py:401](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/bedrock.py#L401)

Get the current Bedrock Model configuration.

**Returns**:

The Bedrock model configuration.

#### format\_request

```python
def format_request(messages: Messages,
                   tool_specs: list[ToolSpec] | None = None,
                   system_prompt_content: list[SystemContentBlock]
                   | None = None,
                   tool_choice: ToolChoice | None = None,
                   dynamic_trailing_blocks: int = 0,
                   **kwargs: Any) -> dict[str, Any]
```

Defined in: [src/strands/models/bedrock.py:409](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/bedrock.py#L409)

Format a Bedrock converse stream request.

**Arguments**:

-   `messages` - List of message objects to be processed by the model.
-   `tool_specs` - List of tool specifications to make available to the model.
-   `tool_choice` - Selection strategy for tool invocation.
-   `system_prompt_content` - System prompt content blocks to provide context to the model.
-   `dynamic_trailing_blocks` - How many trailing blocks of the last user message are rebuilt on every call, so the cache point goes ahead of them.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Returns**:

A Bedrock converse stream request.

#### count\_tokens

```python
@override
async def count_tokens(
        messages: Messages,
        tool_specs: list[ToolSpec] | None = None,
        system_prompt: str | None = None,
        system_prompt_content: list[SystemContentBlock] | None = None) -> int
```

Defined in: [src/strands/models/bedrock.py:1433](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/bedrock.py#L1433)

Count tokens using Bedrock’s native CountTokens API.

Uses the same message format as the Converse API to get accurate token counts directly from the Bedrock service.

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
                 cancel_signal: threading.Event | None = None,
                 structured_output_model: type[BaseModel] | None = None,
                 **kwargs: Any) -> AsyncGenerator[StreamEvent, None]
```

Defined in: [src/strands/models/bedrock.py:1515](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/bedrock.py#L1515)

Stream conversation with the Bedrock model.

This method calls either the Bedrock converse\_stream API or the converse API based on the streaming parameter in the configuration.

**Arguments**:

-   `messages` - List of message objects to be processed by the model.
-   `tool_specs` - List of tool specifications to make available to the model.
-   `system_prompt` - System prompt to provide context to the model.
-   `tool_choice` - Selection strategy for tool invocation.
-   `system_prompt_content` - System prompt content blocks to provide context to the model.
-   `cancel_signal` - Event that aborts an in-flight streaming request. The caller stops receiving events as soon as it is set, and the HTTP response is closed at the next chunk boundary. A non-streaming request (`streaming=False`) is not abortable.
-   `structured_output_model` - Output model the call must produce; the request is then sent with the strongest structured output mechanism the model supports.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Yields**:

Model events.

**Raises**:

-   `ContextWindowOverflowException` - If the input exceeds the model’s context window.
-   `ModelThrottledException` - If the model service is throttling requests.

#### convert\_non\_streaming\_to\_streaming

```python
def convert_non_streaming_to_streaming(response: dict[str, Any],
                                       **kwargs: Any) -> Iterable[StreamEvent]
```

Defined in: [src/strands/models/bedrock.py:1767](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/bedrock.py#L1767)

Convert a non-streaming response to the streaming format.

**Arguments**:

-   `response` - The non-streaming response from the Bedrock model.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Returns**:

An iterable of response events in the streaming format.

#### structured\_output

```python
@override
async def structured_output(
        output_model: type[T],
        prompt: Messages,
        system_prompt: str | None = None,
        **kwargs: Any) -> AsyncGenerator[dict[str, T | Any], None]
```

Defined in: [src/strands/models/bedrock.py:1893](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/bedrock.py#L1893)

Get structured output from the model.

**Arguments**:

-   `output_model` - The output model to use for the agent.
-   `prompt` - The prompt messages to use for the agent.
-   `system_prompt` - System prompt to provide context to the model.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Yields**:

Model events with the last being the structured output.