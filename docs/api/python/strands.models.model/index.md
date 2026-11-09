Abstract base class for Agent model providers.

## BaseModelConfig

```python
class BaseModelConfig(TypedDict)
```

Defined in: [src/strands/models/model.py:129](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/model.py#L129)

Base configuration shared by all model providers.

**Attributes**:

-   `context_window_limit` - Maximum context window size in tokens for the model. The same fact as `model_info.limits.context_window`; setting it here is shorthand for setting it through `model_info`, and it wins over the shared model info. When both are set, `model_info` wins. When not provided, vended providers still populate it from the shared model info for callers that read `get_config()`; `model_info` is the resolved view to read.
-   `model_info` - Overrides for what the SDK knows about the model. Fields set here win over the shared model info and the provider; `capabilities.stateful` changes how the agent loop sends history, so set it only for a provider that keeps state server-side. `update_config(model_info=...)` replaces the previous override entirely, it does not merge into it.

## CacheConfig

```python
@dataclass
class CacheConfig()
```

Defined in: [src/strands/models/model.py:151](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/model.py#L151)

Configuration for prompt caching.

Providers consume only the fields they support.

**Attributes**:

-   `strategy` - Caching strategy to use.
    -   “auto”: Automatically detect model support and inject cachePoint to maximize cache coverage
    -   “anthropic”: Inject cachePoint in Anthropic-compatible format without model support check
-   `ttl` - Optional TTL duration for cache entries (e.g. “5m”, “1h”). When specified, auto-injected cache points will include this TTL value. Bedrock requires checkpoint TTLs to be non-increasing across toolConfig, system and messages, and rejects a longer TTL that follows a shorter one. This TTL also fills in for a cache point that carries none of its own.
-   `system_prompt_ttl` - Cache the system prompt, auto-injecting a cache point at its end so repeated calls with the same static system prefix hit the cache. A TTL string (e.g. “1h”) sets this section’s own duration and is honored as written; True derives the duration from `ttl`; False disables it. A hand-placed system cache point is honored rather than doubled.
-   `messages_ttl` - Cache the conversation prefix, placing a cache point on durable user content. A TTL string sets this section’s own duration; True or None derives it from `ttl`; False disables the message cache point. Mirrors the TypeScript `messagesTTL`. Read by `BedrockModel`, `AnthropicModel` and, on models that take cache points, `OpenAIResponsesModel`, which accepts only the OpenAI lifetimes `"30m"` and `"12h"`.
-   `cache_key` - Stable identity a prompt-cache-routing provider (OpenAI, LiteLLM, Mistral) uses as its cache key. Left unset, it is derived per request as `strands-<session_id>` if the agent has a session manager, so repeat runs of a session share a cache prefix with no key management. Set it to a string to pin your own key, or `False` to opt out of routing entirely. The resolved key (whether set or derived from the session id) is transmitted to the provider.
-   `tools_ttl` - Cache the tool definitions, auto-injecting a cache point on the tool block so repeated calls with the same tools hit the cache. A TTL string (e.g. “1h”) sets this section’s own duration and is honored as written; True derives the duration from `ttl`; False disables it. None (the default) leaves it unset, deferring to the deprecated model-level `cache_tools`; any explicit value — including False — takes precedence over `cache_tools`.

## CacheToolsConfig

```python
@dataclass
class CacheToolsConfig()
```

Defined in: [src/strands/models/model.py:202](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/model.py#L202)

Configuration for the toolConfig cache point.

**Attributes**:

-   `type` - Cache point type (e.g. “default”).
-   `ttl` - Optional TTL duration for the cache entry (e.g. “5m”, “1h”).

## Model

```python
class Model(abc.ABC)
```

Defined in: [src/strands/models/model.py:214](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/model.py#L214)

Abstract base class for Agent model providers.

This class defines the interface for all model implementations in the Strands Agents SDK. It provides a standardized way to configure and process requests for different AI model providers.

#### stateful

```python
@property
def stateful() -> bool
```

Defined in: [src/strands/models/model.py:226](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/model.py#L226)

Whether the model manages conversation state server-side.

Reads `model_info.capabilities.stateful`, so a provider that keeps state server-side sets it there (see :attr:`model_info`) and a `model_info` config override can change it.

**Returns**:

False when unknown.

#### model\_info

```python
@property
def model_info() -> ModelInfo
```

Defined in: [src/strands/models/model.py:238](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/model.py#L238)

Everything the SDK knows about the configured model, resolved on each read.

Layers, later ones winning: the shared model info for the configured model id, the `context_window_limit` config value, and the `model_info` config override. Each read returns a new record, so do not compare reads by identity.

A provider that knows better than the shared model info overrides this property: put its facts over `super().model_info`, then the user’s `self.get_config().get("model_info")` over those so the override still wins::

from strands.models import ModelCapabilities, ModelInfo

ModelInfo.merge( super().model\_info, ModelInfo(capabilities=ModelCapabilities(prompt\_caching=“auto”)), self.get\_config().get(“model\_info”), )

Do not read :attr:`stateful` inside the override; it reads this property.

**Returns**:

What the SDK knows about the model; empty when it knows nothing.

#### context\_window\_limit

```python
@property
def context_window_limit() -> int | None
```

Defined in: [src/strands/models/model.py:279](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/model.py#L279)

Maximum context window size in tokens, or None if not known.

#### update\_config

```python
@abc.abstractmethod
def update_config(**model_config: Any) -> None
```

Defined in: [src/strands/models/model.py:285](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/model.py#L285)

Update the model configuration with the provided arguments.

**Arguments**:

-   `**model_config` - Configuration overrides.

#### get\_config

```python
@abc.abstractmethod
def get_config() -> Any
```

Defined in: [src/strands/models/model.py:295](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/model.py#L295)

Return the model configuration.

**Returns**:

The model’s configuration.

#### structured\_output

```python
@abc.abstractmethod
def structured_output(
        output_model: type[T],
        prompt: Messages,
        system_prompt: str | None = None,
        **kwargs: Any) -> AsyncGenerator[dict[str, T | Any], None]
```

Defined in: [src/strands/models/model.py:305](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/model.py#L305)

Get structured output from the model.

**Arguments**:

-   `output_model` - The output model to use for the agent.
-   `prompt` - The prompt messages to use for the agent.
-   `system_prompt` - System prompt to provide context to the model.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Yields**:

Model events with the last being the structured output.

**Raises**:

-   `ValidationException` - The response format from the model does not match the output\_model

#### stream

```python
@abc.abstractmethod
def stream(messages: Messages,
           tool_specs: list[ToolSpec] | None = None,
           system_prompt: str | None = None,
           *,
           tool_choice: ToolChoice | None = None,
           system_prompt_content: list[SystemContentBlock] | None = None,
           invocation_state: dict[str, Any] | None = None,
           cancel_signal: threading.Event | None = None,
           agent_metadata: "AgentMetadata | None" = None,
           structured_output_model: type[BaseModel] | None = None,
           **kwargs: Any) -> AsyncIterable[StreamEvent]
```

Defined in: [src/strands/models/model.py:326](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/model.py#L326)

Stream conversation with the model.

This method handles the full lifecycle of conversing with the model:

1.  Format the messages, tool specs, and configuration into a streaming request
2.  Send the request to the model
3.  Yield the formatted message chunks

**Arguments**:

-   `messages` - List of message objects to be processed by the model.
-   `tool_specs` - List of tool specifications to make available to the model.
-   `system_prompt` - System prompt to provide context to the model.
-   `tool_choice` - Selection strategy for tool invocation.
-   `system_prompt_content` - System prompt content blocks for advanced features like caching.
-   `invocation_state` - Caller-provided state/context that was passed to the agent when it was invoked.
-   `cancel_signal` - Event a provider can observe to abort an in-flight request. Support is provider-dependent; a provider that ignores it still cancels at the SDK’s between-chunk checkpoint.
-   `agent_metadata` - Stable identity of the invoking agent (e.g. its session id), supplied per request. A provider may consult it to derive a prompt-cache routing key; None when the model is streamed directly without an agent.
-   `structured_output_model` - Output model this call must produce, passed by the agent on its structured output retry to providers that enforce structured output themselves. The response must then be either a call to the tool named in `tool_choice` or a final text response whose text is exactly one JSON object that validates against this model.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Yields**:

Formatted message chunks from the model.

**Raises**:

-   `ModelThrottledException` - When the model service is throttling requests from the client.

#### count\_tokens

```python
async def count_tokens(
        messages: Messages,
        tool_specs: list[ToolSpec] | None = None,
        system_prompt: str | None = None,
        system_prompt_content: list[SystemContentBlock] | None = None) -> int
```

Defined in: [src/strands/models/model.py:375](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/model.py#L375)

Estimate token count for the given input before sending to the model.

Used for proactive context management (e.g., triggering compression at a threshold). Uses tiktoken’s cl100k\_base encoding when available, otherwise falls back to a heuristic (characters / 4 for text, characters / 2 for JSON). Accuracy varies by model provider. Not intended for billing or precise quota calculations.

Subclasses may override this method to provide model-specific token counting using native APIs for improved accuracy.

**Arguments**:

-   `messages` - List of message objects to estimate tokens for.
-   `tool_specs` - List of tool specifications to include in the estimate.
-   `system_prompt` - Plain string system prompt. Ignored if system\_prompt\_content is provided.
-   `system_prompt_content` - Structured system prompt content blocks. Takes priority over system\_prompt.

**Returns**:

Estimated total input tokens.

#### summarize

```python
async def summarize(messages: Messages,
                    *,
                    tool_specs: list[ToolSpec] | None = None,
                    system_prompt: str | None = None,
                    system_prompt_content: list[SystemContentBlock]
                    | None = None,
                    instructions: str | None = None,
                    **kwargs: Any) -> ContentBlock
```

Defined in: [src/strands/models/model.py:403](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/model.py#L403)

Summarize the conversation’s opening `messages` server-side.

The summarize strategy calls this instead of its client-side summary when `model_info.capabilities.server_side_summary` is True, with the messages from message 0 through the last one it summarizes. Providers with server-side summaries override it. When this raises, the strategy summarizes client-side instead.

**Arguments**:

-   `messages` - The opening messages to summarize, from message 0, left unmodified.
-   `tool_specs` - The live conversation’s tool specifications.
-   `system_prompt` - The live conversation’s plain string system prompt.
-   `system_prompt_content` - The live conversation’s structured system prompt.
-   `instructions` - Summarization instructions replacing the provider’s own prompt.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Returns**:

A `summary` block that takes the summarized messages’ place.

**Raises**:

-   `NotImplementedError` - If the model has no server-side summary.

#### estimate\_utilization

```python
def estimate_utilization(input_tokens: int) -> float
```

Defined in: [src/strands/models/model.py:436](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/model.py#L436)

Estimate the fraction of the model’s context window consumed by the given input token count.

Resolves the model’s context window limit (falling back to :data:`DEFAULT_CONTEXT_WINDOW_LIMIT` with a warning when not configured) and returns `input_tokens / context_window_limit`.

**Arguments**:

-   `input_tokens` - Total input token count (e.g. from a model event’s projected input tokens).

**Returns**:

Token usage ratio (0–1+; above 1.0 means overflow).

## \_ModelPlugin

```python
class _ModelPlugin(Plugin)
```

Defined in: [src/strands/models/model.py:462](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/model.py#L462)

Plugin that manages model-related lifecycle hooks.

#### name

```python
@property
def name() -> str
```

Defined in: [src/strands/models/model.py:466](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/model.py#L466)

A stable string identifier for this plugin.

#### init\_agent

```python
def init_agent(agent: "Agent") -> None
```

Defined in: [src/strands/models/model.py:484](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/model.py#L484)

Register model lifecycle hooks with the agent.

**Arguments**:

-   `agent` - The agent instance to register hooks with.