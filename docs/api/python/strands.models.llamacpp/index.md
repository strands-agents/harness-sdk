llama.cpp model provider.

Provides integration with llama.cpp servers running in OpenAI-compatible mode, with support for advanced llama.cpp-specific features.

-   Docs: [https://github.com/ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp)
-   Server docs: [https://github.com/ggml-org/llama.cpp/tree/master/tools/server](https://github.com/ggml-org/llama.cpp/tree/master/tools/server)
-   OpenAI API compatibility: [https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#api-endpoints](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#api-endpoints)

## LlamaCppModel

```python
class LlamaCppModel(Model)
```

Defined in: [src/strands/models/llamacpp.py:85](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/llamacpp.py#L85)

llama.cpp model provider implementation.

Connects to a llama.cpp server running in OpenAI-compatible mode with support for advanced llama.cpp-specific features like grammar constraints, Mirostat sampling, native JSON schema validation, and native multimodal support for audio and image content.

The llama.cpp server must be started with the OpenAI-compatible API enabled: llama-server -m model.gguf —host 0.0.0.0 —port 8080

**Example**:

Basic usage:

> > > model = LlamaCppModel(base\_url=“[http://localhost:8080](http://localhost:8080)”) model.update\_config(params={“temperature”: 0.7, “top\_k”: 40})

Grammar constraints via params:

> > > model.update\_config(params={ … “grammar”: ''' … root ::= answer … answer ::= “yes” | “no” … ''' … })

Advanced sampling:

> > > model.update\_config(params={ … “mirostat”: 2, … “mirostat\_lr”: 0.1, … “tfs\_z”: 0.95, … “repeat\_penalty”: 1.1 … })

Multimodal usage (requires multimodal model like Qwen2.5-Omni):

> > > # Audio analysis
> > > 
> > > audio\_content = \[{ … “audio”: {“source”: {“bytes”: audio\_bytes}, “format”: “wav”}, … “text”: “What do you hear in this audio?” … }\] response = agent(audio\_content)

> > > # Image analysis
> > > 
> > > image\_content = \[{ … “image”: {“source”: {“bytes”: image\_bytes}, “format”: “png”}, … “text”: “Describe this image” … }\] response = agent(image\_content)

## LlamaCppConfig

```python
class LlamaCppConfig(BaseModelConfig)
```

Defined in: [src/strands/models/llamacpp.py:133](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/llamacpp.py#L133)

Configuration options for llama.cpp models.

**Attributes**:

-   `model_id` - Model identifier for the loaded model in llama.cpp server. Default is “default” as llama.cpp typically loads a single model.
    
-   `params` - Model parameters supporting both OpenAI and llama.cpp-specific options.
    
    OpenAI-compatible parameters:
    
    -   max\_tokens: Maximum number of tokens to generate
    -   temperature: Sampling temperature (0.0 to 2.0)
    -   top\_p: Nucleus sampling parameter (0.0 to 1.0)
    -   frequency\_penalty: Frequency penalty (-2.0 to 2.0)
    -   presence\_penalty: Presence penalty (-2.0 to 2.0)
    -   stop: List of stop sequences
    -   seed: Random seed for reproducibility
    -   n: Number of completions to generate
    -   logprobs: Include log probabilities in output
    -   top\_logprobs: Number of top log probabilities to include
    
    llama.cpp-specific parameters:
    
    -   repeat\_penalty: Penalize repeat tokens (1.0 = no penalty)
    -   top\_k: Top-k sampling (0 = disabled)
    -   min\_p: Min-p sampling threshold (0.0 to 1.0)
    -   typical\_p: Typical-p sampling (0.0 to 1.0)
    -   tfs\_z: Tail-free sampling parameter (0.0 to 1.0)
    -   top\_a: Top-a sampling parameter
    -   mirostat: Mirostat sampling mode (0, 1, or 2)
    -   mirostat\_lr: Mirostat learning rate
    -   mirostat\_ent: Mirostat target entropy
    -   grammar: GBNF grammar string for constrained generation
    -   json\_schema: JSON schema for structured output
    -   penalty\_last\_n: Number of tokens to consider for penalties
    -   n\_probs: Number of probabilities to return per token
    -   min\_keep: Minimum tokens to keep in sampling
    -   ignore\_eos: Ignore end-of-sequence token
    -   logit\_bias: Token ID to bias mapping
    -   cache\_prompt: Cache the prompt for faster generation
    -   slot\_id: Slot ID for parallel inference
    -   samplers: Custom sampler order
-   `use_native_token_count` - Whether to use the native llama.cpp /tokenize endpoint. When True, count\_tokens() calls the server’s tokenize endpoint for accurate counts. When False (default), skips the API call and uses the local estimator.
    
-   `cache_config` - Prompt-caching configuration. llama.cpp reuses the shared prompt prefix server-side by default. A CacheConfig pins `cache_prompt: true` on each request. An explicit `params["cache_prompt"]` takes precedence. llama.cpp has no per-field cache controls, so every other CacheConfig field is ignored.
    

#### \_\_init\_\_

```python
def __init__(base_url: str = "http://localhost:8080",
             timeout: float | tuple[float, float] | None = None,
             **model_config: Unpack[LlamaCppConfig]) -> None
```

Defined in: [src/strands/models/llamacpp.py:187](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/llamacpp.py#L187)

Initialize llama.cpp provider instance.

**Arguments**:

-   `base_url` - Base URL for the llama.cpp server. Default is “[http://localhost:8080](http://localhost:8080)” for local server.
-   `timeout` - Request timeout in seconds. Can be float or tuple of (connect, read) timeouts.
-   `**model_config` - Configuration options for the llama.cpp model.

#### update\_config

```python
@override
def update_config(**model_config: Unpack[LlamaCppConfig]) -> None
```

Defined in: [src/strands/models/llamacpp.py:230](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/llamacpp.py#L230)

Update the llama.cpp model configuration with provided arguments.

**Arguments**:

-   `**model_config` - Configuration overrides.

#### model\_info

```python
@property
@override
def model_info() -> ModelInfo
```

Defined in: [src/strands/models/llamacpp.py:241](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/llamacpp.py#L241)

Reports server-side summary as off, which a `model_info` override still wins over.

The llama.cpp server has no server-side summary, including for Claude models served through it.

#### get\_config

```python
@override
def get_config() -> LlamaCppConfig
```

Defined in: [src/strands/models/llamacpp.py:249](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/llamacpp.py#L249)

Get the llama.cpp model configuration.

**Returns**:

The llama.cpp model configuration.

#### count\_tokens

```python
@override
async def count_tokens(
        messages: Messages,
        tool_specs: list[ToolSpec] | None = None,
        system_prompt: str | None = None,
        system_prompt_content: list[SystemContentBlock] | None = None) -> int
```

Defined in: [src/strands/models/llamacpp.py:571](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/llamacpp.py#L571)

Count tokens using llama.cpp’s native /tokenize endpoint.

Sends the formatted prompt to the llama.cpp server’s tokenization endpoint to get an accurate token count. Requires a llama.cpp server version that supports chat-template-aware tokenization via the `messages` field in /tokenize requests. Older server versions that only accept `\{"content": "string"}` are not supported and will fall back to estimation.

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
                 **kwargs: Any) -> AsyncGenerator[StreamEvent, None]
```

Defined in: [src/strands/models/llamacpp.py:628](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/llamacpp.py#L628)

Stream conversation with the llama.cpp model.

**Arguments**:

-   `messages` - List of message objects to be processed by the model.
-   `tool_specs` - List of tool specifications to make available to the model.
-   `system_prompt` - System prompt to provide context to the model.
-   `tool_choice` - Selection strategy for tool invocation. **Note: This parameter is accepted for interface consistency but is currently ignored for this model provider.**
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Yields**:

Formatted message chunks from the model.

**Raises**:

-   `ContextWindowOverflowException` - When the context window is exceeded.
-   `ModelThrottledException` - When the llama.cpp server is overloaded.

#### structured\_output

```python
@override
async def structured_output(
        output_model: type[T],
        prompt: Messages,
        system_prompt: str | None = None,
        **kwargs: Any) -> AsyncGenerator[dict[str, T | Any], None]
```

Defined in: [src/strands/models/llamacpp.py:831](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/llamacpp.py#L831)

Get structured output using llama.cpp’s native JSON schema support.

This implementation uses llama.cpp’s json\_schema parameter to constrain the model output to valid JSON matching the provided schema.

**Arguments**:

-   `output_model` - The Pydantic model defining the expected output structure.
-   `prompt` - The prompt messages to use for generation.
-   `system_prompt` - System prompt to provide context to the model.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Yields**:

Model events with the last being the structured output.

**Raises**:

-   `json.JSONDecodeError` - If the model output is not valid JSON.
-   `pydantic.ValidationError` - If the output doesn’t match the model schema.