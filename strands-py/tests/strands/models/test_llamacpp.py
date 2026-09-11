"""Unit tests for llama.cpp model provider."""

import base64
import json
import logging
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from pydantic import BaseModel

from strands.models.llamacpp import LlamaCppModel
from strands.models.model import CacheConfig
from strands.types.exceptions import (
    ContextWindowOverflowException,
    ModelThrottledException,
)


def test_init_default_config() -> None:
    """Test initialization with default configuration."""
    model = LlamaCppModel()

    assert model.config["model_id"] == "default"
    assert isinstance(model.client, httpx.AsyncClient)
    assert model.base_url == "http://localhost:8080"


def test_init_custom_config() -> None:
    """Test initialization with custom configuration."""
    model = LlamaCppModel(
        base_url="http://example.com:8081",
        model_id="llama-3-8b",
        params={"temperature": 0.7, "max_tokens": 100},
    )

    assert model.config["model_id"] == "llama-3-8b"
    assert model.config["params"]["temperature"] == 0.7
    assert model.config["params"]["max_tokens"] == 100
    assert model.base_url == "http://example.com:8081"


def test_format_request_basic() -> None:
    """Test basic request formatting."""
    model = LlamaCppModel(model_id="test-model")

    messages = [
        {"role": "user", "content": [{"text": "Hello"}]},
    ]

    request = model._format_request(messages)

    assert request["model"] == "test-model"
    assert request["messages"][0]["role"] == "user"
    assert request["messages"][0]["content"][0]["type"] == "text"
    assert request["messages"][0]["content"][0]["text"] == "Hello"
    assert request["stream"] is True
    assert "extra_body" not in request


def test_format_request_with_system_prompt() -> None:
    """Test request formatting with system prompt."""
    model = LlamaCppModel()

    messages = [
        {"role": "user", "content": [{"text": "Hello"}]},
    ]

    request = model._format_request(messages, system_prompt="You are a helpful assistant")

    assert request["messages"][0]["role"] == "system"
    assert request["messages"][0]["content"] == "You are a helpful assistant"
    assert request["messages"][1]["role"] == "user"


def test_format_request_with_llamacpp_params() -> None:
    """Test request formatting with llama.cpp specific parameters."""
    model = LlamaCppModel(
        params={
            "temperature": 0.8,
            "max_tokens": 50,
            "repeat_penalty": 1.1,
            "top_k": 40,
            "min_p": 0.05,
            "grammar": "root ::= 'yes' | 'no'",
        }
    )

    messages = [
        {"role": "user", "content": [{"text": "Is the sky blue?"}]},
    ]

    request = model._format_request(messages)

    # Standard OpenAI params
    assert request["temperature"] == 0.8
    assert request["max_tokens"] == 50

    # Grammar and json_schema go directly in request for llama.cpp
    assert request["grammar"] == "root ::= 'yes' | 'no'"

    # Other llama.cpp specific params go directly in the request body (the server
    # reads them at the top level; there is no OpenAI SDK to flatten extra_body).
    assert "extra_body" not in request
    assert request["repeat_penalty"] == 1.1
    assert request["top_k"] == 40
    assert request["min_p"] == 0.05


def test_format_request_with_all_new_params() -> None:
    """Test request formatting with all new llama.cpp parameters."""
    model = LlamaCppModel(
        params={
            # OpenAI params
            "temperature": 0.7,
            "max_tokens": 100,
            "top_p": 0.9,
            "seed": 42,
            # All llama.cpp specific params
            "repeat_penalty": 1.1,
            "top_k": 40,
            "min_p": 0.05,
            "typical_p": 0.95,
            "tfs_z": 0.97,
            "top_a": 0.1,
            "mirostat": 2,
            "mirostat_lr": 0.1,
            "mirostat_ent": 5.0,
            "grammar": "root ::= answer",
            "json_schema": {"type": "object"},
            "penalty_last_n": 256,
            "n_probs": 5,
            "min_keep": 1,
            "ignore_eos": False,
            "logit_bias": {100: 5.0, 200: -5.0},
            "cache_prompt": True,
            "slot_id": 1,
            "samplers": ["top_k", "tfs_z", "typical_p"],
        }
    )

    messages = [{"role": "user", "content": [{"text": "Test"}]}]
    request = model._format_request(messages)

    # Check OpenAI params are in root
    assert request["temperature"] == 0.7
    assert request["max_tokens"] == 100
    assert request["top_p"] == 0.9
    assert request["seed"] == 42

    # Grammar and json_schema go directly in request for llama.cpp
    assert request["grammar"] == "root ::= answer"
    assert request["json_schema"] == {"type": "object"}

    # All other llama.cpp params go directly in the request body, not nested under
    # an OpenAI-SDK-only extra_body object.
    assert "extra_body" not in request
    assert request["repeat_penalty"] == 1.1
    assert request["top_k"] == 40
    assert request["min_p"] == 0.05
    assert request["typical_p"] == 0.95
    assert request["tfs_z"] == 0.97
    assert request["top_a"] == 0.1
    assert request["mirostat"] == 2
    assert request["mirostat_lr"] == 0.1
    assert request["mirostat_ent"] == 5.0
    assert request["penalty_last_n"] == 256
    assert request["n_probs"] == 5
    assert request["min_keep"] == 1
    assert request["ignore_eos"] is False
    assert request["logit_bias"] == {100: 5.0, 200: -5.0}
    assert request["cache_prompt"] is True
    assert request["slot_id"] == 1
    assert request["samplers"] == ["top_k", "tfs_z", "typical_p"]


def test_format_request_llamacpp_params_are_top_level_not_extra_body() -> None:
    """llama.cpp sampling params are placed at the top level of the request body,
    not under extra_body. Regression test for #3422.
    """
    model = LlamaCppModel(
        params={
            "top_k": 40,
            "repeat_penalty": 1.1,
            "mirostat": 2,
            "samplers": ["top_k", "min_p"],
        }
    )

    request = model._format_request([{"role": "user", "content": [{"text": "hi"}]}])

    assert "extra_body" not in request
    assert request["top_k"] == 40
    assert request["repeat_penalty"] == 1.1
    assert request["mirostat"] == 2
    assert request["samplers"] == ["top_k", "min_p"]


def test_format_tool_call_preserves_non_ascii() -> None:
    """Tool-call arguments must keep non-ASCII text (no \\uXXXX escaping)."""
    model = LlamaCppModel()
    tool_use = {"toolUseId": "c1", "name": "search", "input": {"query": "東京"}}

    tru_result = model._format_tool_call(tool_use)
    exp_result = {
        "function": {
            "arguments": '{"query": "東京"}',
            "name": "search",
        },
        "id": "c1",
        "type": "function",
    }
    assert tru_result == exp_result


def test_format_tool_message_preserves_non_ascii() -> None:
    """Tool-result JSON content must keep non-ASCII text (no \\uXXXX escaping)."""
    model = LlamaCppModel()
    tool_result = {
        "toolUseId": "c1",
        "status": "success",
        "content": [{"json": {"city": "東京"}}],
    }

    tru_result = model._format_tool_message(tool_result)
    exp_result = {
        "role": "tool",
        "tool_call_id": "c1",
        "content": [{"text": '{"city": "東京"}', "type": "text"}],
    }
    assert tru_result == exp_result


def test_format_request_with_tools() -> None:
    """Test request formatting with tool specifications."""
    model = LlamaCppModel()

    messages = [
        {"role": "user", "content": [{"text": "What's the weather?"}]},
    ]

    tool_specs = [
        {
            "name": "get_weather",
            "description": "Get current weather",
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "location": {"type": "string"},
                    },
                    "required": ["location"],
                }
            },
        }
    ]

    request = model._format_request(messages, tool_specs=tool_specs)

    assert "tools" in request
    assert len(request["tools"]) == 1
    assert request["tools"][0]["function"]["name"] == "get_weather"


def test_update_config() -> None:
    """Test configuration update."""
    model = LlamaCppModel(model_id="initial-model")

    assert model.config["model_id"] == "initial-model"

    model.update_config(model_id="updated-model", params={"temperature": 0.5})

    assert model.config["model_id"] == "updated-model"
    assert model.config["params"]["temperature"] == 0.5


def test_get_config() -> None:
    """Test configuration retrieval."""
    config = {
        "model_id": "test-model",
        "params": {"temperature": 0.9},
    }
    model = LlamaCppModel(**config)

    retrieved_config = model.get_config()

    assert retrieved_config["model_id"] == "test-model"
    assert retrieved_config["params"]["temperature"] == 0.9


def test_cache_config_enables_cache_prompt_when_params_absent(captured_warnings) -> None:
    """A CacheConfig turns on server-side prompt caching even when no params are configured."""
    model = LlamaCppModel(cache_config=CacheConfig())

    request = model._format_request([{"role": "user", "content": [{"text": "Test"}]}])

    assert request["cache_prompt"] is True
    assert not any("have no effect" in str(warning.message) for warning in captured_warnings)


def test_cache_config_enables_cache_prompt_alongside_other_params(captured_warnings) -> None:
    """Enabling caching does not clobber other configured params."""
    model = LlamaCppModel(params={"temperature": 0.7}, cache_config=CacheConfig())

    request = model._format_request([{"role": "user", "content": [{"text": "Test"}]}])

    assert request["cache_prompt"] is True
    assert request["temperature"] == 0.7
    assert not any("have no effect" in str(warning.message) for warning in captured_warnings)


def test_cache_config_default_enables_without_warning(captured_warnings) -> None:
    """A CacheConfig whose fields are all default (strategy="auto" is the default) warns about nothing."""
    model = LlamaCppModel(cache_config=CacheConfig(strategy="auto"))

    request = model._format_request([{"role": "user", "content": [{"text": "Test"}]}])

    assert request["cache_prompt"] is True
    assert not any("have no effect" in str(warning.message) for warning in captured_warnings)


@pytest.mark.parametrize(
    ("cache_config", "field"),
    [
        (CacheConfig(strategy="anthropic"), "strategy"),
        (CacheConfig(system_prompt_ttl="1h"), "system_prompt_ttl"),
        (CacheConfig(tools_ttl=True), "tools_ttl"),
    ],
)
def test_cache_config_unsupported_field_warns_and_still_enables(cache_config, field) -> None:
    """A non-default field llama.cpp cannot honor warns (naming the provider) and still enables caching."""
    model = LlamaCppModel(cache_config=cache_config)

    with pytest.warns(UserWarning, match=rf"fields \['{field}'\] have no effect on llama\.cpp"):
        request = model._format_request([{"role": "user", "content": [{"text": "Test"}]}])

    assert request["cache_prompt"] is True


def test_explicit_cache_prompt_false_preserved() -> None:
    """An explicit params["cache_prompt"] wins over the CacheConfig enable signal."""
    model = LlamaCppModel(params={"cache_prompt": False}, cache_config=CacheConfig())

    request = model._format_request([{"role": "user", "content": [{"text": "Test"}]}])

    assert request["cache_prompt"] is False


def test_cache_prompt_absent_without_cache_config() -> None:
    """Without a CacheConfig, cache_prompt is left unset so the server default applies."""
    model = LlamaCppModel()

    request = model._format_request([{"role": "user", "content": [{"text": "Test"}]}])

    assert "cache_prompt" not in request


def test_cache_config_round_trips(captured_warnings) -> None:
    """cache_config is a valid config field and survives get_config/update_config unchanged."""
    cache_config = CacheConfig()
    model = LlamaCppModel(cache_config=cache_config)

    assert model.get_config()["cache_config"] is cache_config

    updated = CacheConfig()
    model.update_config(cache_config=updated)
    assert model.get_config()["cache_config"] is updated

    assert not any("Invalid configuration parameters" in str(warning.message) for warning in captured_warnings)


def test_cache_config_unsupported_ttl_warns_and_still_enables() -> None:
    """llama.cpp has no retention control: ttl is a no-op that warns, and caching is still enabled."""
    model = LlamaCppModel(cache_config=CacheConfig(ttl="1h"))

    with pytest.warns(UserWarning, match=r"fields \['ttl'\] have no effect on llama\.cpp"):
        request = model._format_request([{"role": "user", "content": [{"text": "Test"}]}])

    assert request["cache_prompt"] is True


def test_cache_config_cache_key_warns_and_is_not_routed() -> None:
    """llama.cpp has no key-based cache routing: cache_key warns and is never placed on the request."""
    model = LlamaCppModel(cache_config=CacheConfig(cache_key="tenant-42"))

    with pytest.warns(UserWarning, match=r"fields \['cache_key'\] have no effect on llama\.cpp"):
        request = model._format_request([{"role": "user", "content": [{"text": "Test"}]}])

    assert request["cache_prompt"] is True
    assert "prompt_cache_key" not in request
    assert "cache_key" not in request
    assert "slot_id" not in request
    assert "id_slot" not in request


@pytest.mark.asyncio
async def test_stream_basic() -> None:
    """Test basic streaming functionality."""
    model = LlamaCppModel()

    # Mock HTTP response with Server-Sent Events format
    mock_response_lines = [
        'data: {"choices": [{"delta": {"content": "Hello"}}]}',
        'data: {"choices": [{"delta": {"content": " world"}, "finish_reason": "stop"}]}',
        'data: {"usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}',
        "data: [DONE]",
    ]

    async def mock_aiter_lines():
        for line in mock_response_lines:
            yield line

    mock_response = AsyncMock()
    mock_response.aiter_lines = mock_aiter_lines
    mock_response.raise_for_status = MagicMock()

    with patch.object(model.client, "post", return_value=mock_response):
        messages = [{"role": "user", "content": [{"text": "Hi"}]}]

        chunks = []
        async for chunk in model.stream(messages):
            chunks.append(chunk)

        # Verify we got the expected chunks
        assert any("messageStart" in chunk for chunk in chunks)
        assert any(
            "contentBlockDelta" in chunk and chunk["contentBlockDelta"]["delta"]["text"] == "Hello" for chunk in chunks
        )
        assert any(
            "contentBlockDelta" in chunk and chunk["contentBlockDelta"]["delta"]["text"] == " world" for chunk in chunks
        )
        assert any("messageStop" in chunk for chunk in chunks)
        # Verify usage metadata is yielded after the trailing usage SSE line
        # (regression: previously the loop broke on finish_reason and dropped this)
        metadata_chunks = [c for c in chunks if "metadata" in c]
        assert len(metadata_chunks) == 1, f"Expected exactly one metadata chunk, got {len(metadata_chunks)}"
        assert "usage" in metadata_chunks[0]["metadata"]


@pytest.mark.asyncio
async def test_stream_surfaces_cache_read_tokens() -> None:
    """A reused KV prefix is surfaced as cacheReadInputTokens, like the other cache-aware providers.

    llama.cpp reports the reused prefix length in usage.prompt_tokens_details.cached_tokens.
    """
    model = LlamaCppModel()

    mock_response_lines = [
        'data: {"choices": [{"delta": {"content": "Hi"}, "finish_reason": "stop"}]}',
        'data: {"usage": {"prompt_tokens": 100, "completion_tokens": 5, "total_tokens": 105, '
        '"prompt_tokens_details": {"cached_tokens": 91}}}',
        "data: [DONE]",
    ]

    async def mock_aiter_lines():
        for line in mock_response_lines:
            yield line

    mock_response = AsyncMock()
    mock_response.aiter_lines = mock_aiter_lines
    mock_response.raise_for_status = MagicMock()

    with patch.object(model.client, "post", return_value=mock_response):
        chunks = []
        async for chunk in model.stream([{"role": "user", "content": [{"text": "Hi"}]}]):
            chunks.append(chunk)

    usage = next(chunk["metadata"]["usage"] for chunk in chunks if "metadata" in chunk)
    assert usage == {"inputTokens": 100, "outputTokens": 5, "totalTokens": 105, "cacheReadInputTokens": 91}


_NO_REUSE_TOKENS = {"prompt_tokens": 100, "completion_tokens": 5, "total_tokens": 105}


@pytest.mark.parametrize(
    "usage_payload",
    [
        {**_NO_REUSE_TOKENS, "prompt_tokens_details": {"cached_tokens": 0}},
        {**_NO_REUSE_TOKENS, "prompt_tokens_details": None},
        _NO_REUSE_TOKENS,
    ],
    ids=["cached_zero", "details_null", "details_absent"],
)
@pytest.mark.asyncio
async def test_stream_omits_cache_read_tokens_when_prefix_not_reused(usage_payload) -> None:
    """No reuse — cached zero, a null details object, or the field absent — yields usage with no cache-read key.

    The whole-dict assertion pins the ``or {}`` guard in stream() and the ``getattr(..., 0)`` default in
    _format_usage: a fabricated non-zero default would add a phantom cacheReadInputTokens and fail here.
    """
    model = LlamaCppModel()

    mock_response_lines = [
        'data: {"choices": [{"delta": {"content": "Hi"}, "finish_reason": "stop"}]}',
        "data: " + json.dumps({"usage": usage_payload}),
        "data: [DONE]",
    ]

    async def mock_aiter_lines():
        for line in mock_response_lines:
            yield line

    mock_response = AsyncMock()
    mock_response.aiter_lines = mock_aiter_lines
    mock_response.raise_for_status = MagicMock()

    with patch.object(model.client, "post", return_value=mock_response):
        chunks = []
        async for chunk in model.stream([{"role": "user", "content": [{"text": "Hi"}]}]):
            chunks.append(chunk)

    usage = next(chunk["metadata"]["usage"] for chunk in chunks if "metadata" in chunk)
    assert usage == {"inputTokens": 100, "outputTokens": 5, "totalTokens": 105}


@pytest.mark.asyncio
async def test_structured_output() -> None:
    """Test structured output functionality."""

    class TestOutput(BaseModel):
        """Test output model for structured output testing."""

        answer: str
        confidence: float

    model = LlamaCppModel()

    # Mock successful JSON response using the new structured_output implementation
    mock_response_text = '{"answer": "yes", "confidence": 0.95}'

    # Create mock stream that returns JSON
    async def mock_stream(*_args, **_kwargs):
        # Verify json_schema was set
        assert "json_schema" in model.config.get("params", {})

        yield {"messageStart": {"role": "assistant"}}
        yield {"contentBlockStart": {"start": {}}}
        yield {"contentBlockDelta": {"delta": {"text": mock_response_text}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}

    with patch.object(model, "stream", side_effect=mock_stream):
        messages = [{"role": "user", "content": [{"text": "Is the earth round?"}]}]

        events = []
        async for event in model.structured_output(TestOutput, messages):
            events.append(event)

        # Check we got the output
        output_event = next((e for e in events if "output" in e), None)
        assert output_event is not None
        assert output_event["output"].answer == "yes"
        assert output_event["output"].confidence == 0.95


def test_timeout_configuration() -> None:
    """Test timeout configuration."""
    # Test that timeout configuration is accepted without error
    model = LlamaCppModel(timeout=30.0)
    assert model.client.timeout is not None

    # Test with tuple timeout
    model2 = LlamaCppModel(timeout=(10.0, 60.0))
    assert model2.client.timeout is not None


def test_max_retries_configuration() -> None:
    """Test max retries configuration is handled gracefully."""
    # Since httpx doesn't use max_retries in the same way,
    # we just test that the model initializes without error
    model = LlamaCppModel()
    assert model.config["model_id"] == "default"


def test_grammar_constraint_via_params() -> None:
    """Test grammar constraint via params."""
    grammar = """
    root ::= answer
    answer ::= "yes" | "no"
    """
    model = LlamaCppModel(params={"grammar": grammar})

    assert model.config["params"]["grammar"] == grammar

    # Update grammar via update_config
    new_grammar = "root ::= [0-9]+"
    model.update_config(params={"grammar": new_grammar})

    assert model.config["params"]["grammar"] == new_grammar


def test_json_schema_via_params() -> None:
    """Test JSON schema constraint via params."""
    schema = {
        "type": "object",
        "properties": {"name": {"type": "string"}, "age": {"type": "integer"}},
        "required": ["name", "age"],
    }
    model = LlamaCppModel(params={"json_schema": schema})

    assert model.config["params"]["json_schema"] == schema


@pytest.mark.asyncio
async def test_stream_with_context_overflow_error() -> None:
    """Test stream handling of context overflow errors."""
    model = LlamaCppModel()

    # Create HTTP error response
    error_response = httpx.Response(
        status_code=400,
        json={"error": {"message": "Context window exceeded. Max context length is 4096 tokens"}},
        request=httpx.Request("POST", "http://test.com"),
    )
    error = httpx.HTTPStatusError("Bad Request", request=error_response.request, response=error_response)

    # Mock the client to raise the error
    with patch.object(model.client, "post", side_effect=error):
        messages = [{"role": "user", "content": [{"text": "Very long message"}]}]

        with pytest.raises(ContextWindowOverflowException) as exc_info:
            async for _ in model.stream(messages):
                pass

        assert "Context window exceeded" in str(exc_info.value)


@pytest.mark.asyncio
async def test_stream_with_server_overload_error() -> None:
    """Test stream handling of server overload errors."""
    model = LlamaCppModel()

    # Create HTTP error response for 503
    error_response = httpx.Response(
        status_code=503,
        text="Server is busy",
        request=httpx.Request("POST", "http://test.com"),
    )
    error = httpx.HTTPStatusError(
        "Service Unavailable",
        request=error_response.request,
        response=error_response,
    )

    # Mock the client to raise the error
    with patch.object(model.client, "post", side_effect=error):
        messages = [{"role": "user", "content": [{"text": "Test"}]}]

        with pytest.raises(ModelThrottledException) as exc_info:
            async for _ in model.stream(messages):
                pass

        assert "server is busy or overloaded" in str(exc_info.value)


@pytest.mark.asyncio
async def test_structured_output_with_json_schema() -> None:
    """Test structured output using JSON schema."""

    class TestOutput(BaseModel):
        """Test output model for JSON schema testing."""

        answer: str
        confidence: float

    model = LlamaCppModel()

    # Mock successful JSON response
    mock_response_text = '{"answer": "yes", "confidence": 0.95}'

    # Create mock stream that returns JSON
    async def mock_stream(*_args, **_kwargs):
        # Check that json_schema was set correctly
        assert model.config["params"]["json_schema"] == TestOutput.model_json_schema()

        yield {"messageStart": {"role": "assistant"}}
        yield {"contentBlockStart": {"start": {}}}
        yield {"contentBlockDelta": {"delta": {"text": mock_response_text}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}

    with patch.object(model, "stream", side_effect=mock_stream):
        messages = [{"role": "user", "content": [{"text": "Is the earth round?"}]}]

        events = []
        async for event in model.structured_output(TestOutput, messages):
            events.append(event)

        # Check we got the output
        output_event = next((e for e in events if "output" in e), None)
        assert output_event is not None
        assert output_event["output"].answer == "yes"
        assert output_event["output"].confidence == 0.95


@pytest.mark.asyncio
async def test_structured_output_invalid_json_error() -> None:
    """Test structured output raises error for invalid JSON."""

    class TestOutput(BaseModel):
        """Test output model for invalid JSON testing."""

        value: int

    model = LlamaCppModel()

    # Mock stream that returns invalid JSON
    async def mock_stream(*_args, **_kwargs):
        # Check that json_schema was set correctly
        assert model.config["params"]["json_schema"] == TestOutput.model_json_schema()

        yield {"messageStart": {"role": "assistant"}}
        yield {"contentBlockStart": {"start": {}}}
        yield {"contentBlockDelta": {"delta": {"text": "This is not valid JSON"}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}

    with patch.object(model, "stream", side_effect=mock_stream):
        messages = [{"role": "user", "content": [{"text": "Give me a number"}]}]

        with pytest.raises(json.JSONDecodeError):
            async for _ in model.structured_output(TestOutput, messages):
                pass


def test_format_audio_content() -> None:
    """Test formatting of audio content for llama.cpp multimodal models."""
    model = LlamaCppModel()

    # Create test audio data
    audio_bytes = b"fake audio data"
    audio_content = {"audio": {"source": {"bytes": audio_bytes}, "format": "wav"}}

    # Format the content
    result = model._format_message_content(audio_content)

    # Verify the structure
    assert result["type"] == "input_audio"
    assert "input_audio" in result
    assert "data" in result["input_audio"]
    assert "format" in result["input_audio"]

    # Verify the data is base64 encoded
    decoded = base64.b64decode(result["input_audio"]["data"])
    assert decoded == audio_bytes

    # Verify format is preserved
    assert result["input_audio"]["format"] == "wav"


def test_format_audio_content_default_format() -> None:
    """Test backward-compatible WAV default for untyped audio content."""
    model = LlamaCppModel()

    audio_content = {"audio": {"source": {"bytes": b"test audio"}}}

    result = model._format_message_content(audio_content)

    assert result["input_audio"]["format"] == "wav"


def test_format_messages_with_audio() -> None:
    """Test that _format_messages properly handles audio content."""
    model = LlamaCppModel()

    # Create messages with audio content
    messages = [
        {
            "role": "user",
            "content": [
                {"text": "Listen to this audio:"},
                {"audio": {"source": {"bytes": b"audio data"}, "format": "mp3"}},
            ],
        }
    ]

    # Format the messages
    result = model._format_messages(messages)

    # Check structure
    assert len(result) == 1
    assert result[0]["role"] == "user"
    assert len(result[0]["content"]) == 2

    # Check text content
    assert result[0]["content"][0]["type"] == "text"
    assert result[0]["content"][0]["text"] == "Listen to this audio:"

    # Check audio content
    assert result[0]["content"][1]["type"] == "input_audio"
    assert "input_audio" in result[0]["content"][1]
    assert result[0]["content"][1]["input_audio"]["format"] == "mp3"


def test_format_messages_with_system_prompt() -> None:
    """Test _format_messages includes system prompt."""
    model = LlamaCppModel()

    messages = [{"role": "user", "content": [{"text": "Hello"}]}]
    system_prompt = "You are a helpful assistant"

    result = model._format_messages(messages, system_prompt)

    # Should have system message first
    assert len(result) == 2
    assert result[0]["role"] == "system"
    assert result[0]["content"] == system_prompt
    assert result[1]["role"] == "user"


def test_format_messages_with_image() -> None:
    """Test that _format_messages properly handles image content."""
    model = LlamaCppModel()

    # Create messages with image content
    messages = [
        {
            "role": "user",
            "content": [
                {"text": "Describe this image:"},
                {"image": {"source": {"bytes": b"image data"}, "format": "png"}},
            ],
        }
    ]

    # Format the messages
    result = model._format_messages(messages)

    # Check structure
    assert len(result) == 1
    assert result[0]["role"] == "user"
    assert len(result[0]["content"]) == 2

    # Check text content
    assert result[0]["content"][0]["type"] == "text"
    assert result[0]["content"][0]["text"] == "Describe this image:"

    # Check image content uses standard format
    assert result[0]["content"][1]["type"] == "image_url"
    assert "image_url" in result[0]["content"][1]
    assert "url" in result[0]["content"][1]["image_url"]
    assert result[0]["content"][1]["image_url"]["url"].startswith("data:image/png;base64,")


def test_format_messages_with_mixed_content() -> None:
    """Test that _format_messages handles mixed audio and image content correctly."""
    model = LlamaCppModel()

    # Create messages with both audio and image content
    messages = [
        {
            "role": "user",
            "content": [
                {"text": "Analyze this media:"},
                {"audio": {"source": {"bytes": b"audio data"}, "format": "wav"}},
                {"image": {"source": {"bytes": b"image data"}, "format": "jpg"}},
            ],
        }
    ]

    # Format the messages
    result = model._format_messages(messages)

    # Check structure
    assert len(result) == 1
    assert result[0]["role"] == "user"
    assert len(result[0]["content"]) == 3

    # Check text content
    assert result[0]["content"][0]["type"] == "text"
    assert result[0]["content"][0]["text"] == "Analyze this media:"

    # Check audio content uses llama.cpp specific format
    assert result[0]["content"][1]["type"] == "input_audio"
    assert "input_audio" in result[0]["content"][1]
    assert result[0]["content"][1]["input_audio"]["format"] == "wav"

    # Check image content uses standard OpenAI format
    assert result[0]["content"][2]["type"] == "image_url"
    assert "image_url" in result[0]["content"][2]
    assert result[0]["content"][2]["image_url"]["url"].startswith("data:image/jpeg;base64,")


def test_format_request_filters_s3_source_image(caplog) -> None:
    """Test that images with Location sources are filtered out with warning."""
    model = LlamaCppModel()
    caplog.set_level(logging.WARNING, logger="strands.models.llamacpp")

    messages = [
        {
            "role": "user",
            "content": [
                {"text": "look at this image"},
                {
                    "image": {
                        "format": "png",
                        "source": {"location": {"type": "s3", "uri": "s3://my-bucket/image.png"}},
                    },
                },
            ],
        },
    ]

    request = model._format_request(messages)

    # Image with S3 source should be filtered, text should remain
    formatted_messages = request["messages"]
    user_content = formatted_messages[0]["content"]
    assert len(user_content) == 1
    assert user_content[0]["type"] == "text"
    assert "Location sources are not supported by llama.cpp" in caplog.text


def test_format_request_filters_location_source_document(caplog) -> None:
    """Test that documents with Location sources are filtered out with warning."""
    model = LlamaCppModel()
    caplog.set_level(logging.WARNING, logger="strands.models.llamacpp")

    messages = [
        {
            "role": "user",
            "content": [
                {"text": "analyze this document"},
                {
                    "document": {
                        "format": "pdf",
                        "name": "report.pdf",
                        "source": {"location": {"type": "s3", "uri": "s3://my-bucket/report.pdf"}},
                    },
                },
                {
                    "document": {
                        "format": "pdf",
                        "name": "report.pdf",
                        "source": {"location": {"type": "s3", "uri": "s3://my-bucket/report.pdf"}},
                    },
                },
            ],
        },
    ]

    request = model._format_request(messages)

    # Document with S3 source should be filtered, text should remain
    formatted_messages = request["messages"]
    user_content = formatted_messages[0]["content"]
    assert len(user_content) == 1
    assert user_content[0]["type"] == "text"
    assert "Location sources are not supported by llama.cpp" in caplog.text


class TestCountTokens:
    """Tests for LlamaCppModel.count_tokens native token counting."""

    @pytest.fixture
    def model(self):
        return LlamaCppModel(base_url="http://localhost:8080", use_native_token_count=True)

    @pytest.fixture
    def messages(self):
        return [{"role": "user", "content": [{"text": "hello"}]}]

    @pytest.fixture
    def tool_specs(self):
        return [
            {
                "name": "test_tool",
                "description": "A test tool",
                "inputSchema": {"json": {"type": "object", "properties": {}}},
            }
        ]

    @pytest.mark.asyncio
    async def test_native_count_tokens_success(self, model, messages):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"tokens": [1, 2, 3, 4, 5]}
        mock_response.raise_for_status = MagicMock()
        model.client.post = AsyncMock(return_value=mock_response)

        result = await model.count_tokens(messages=messages)

        assert result == 5
        model.client.post.assert_called_once()
        call_args = model.client.post.call_args
        assert call_args[0][0] == "/tokenize"

    @pytest.mark.asyncio
    async def test_native_count_tokens_with_system_prompt(self, model, messages):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"tokens": list(range(10))}
        mock_response.raise_for_status = MagicMock()
        model.client.post = AsyncMock(return_value=mock_response)

        result = await model.count_tokens(messages=messages, system_prompt="Be helpful.")

        assert result == 10
        call_kwargs = model.client.post.call_args[1]
        payload = call_kwargs["json"]
        assert payload["messages"][0]["role"] == "system"
        assert payload["messages"][0]["content"] == "Be helpful."

    @pytest.mark.asyncio
    async def test_native_count_tokens_with_tool_specs(self, model, messages, tool_specs):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"tokens": list(range(20))}
        mock_response.raise_for_status = MagicMock()
        model.client.post = AsyncMock(return_value=mock_response)

        result = await model.count_tokens(messages=messages, tool_specs=tool_specs)

        assert result == 20
        call_kwargs = model.client.post.call_args[1]
        payload = call_kwargs["json"]
        assert "tools" in payload

    @pytest.mark.asyncio
    async def test_fallback_on_http_error(self, model, messages):
        model.client.post = AsyncMock(
            side_effect=httpx.HTTPStatusError("Server error", request=MagicMock(), response=MagicMock(status_code=500))
        )

        result = await model.count_tokens(messages=messages)

        assert isinstance(result, int)
        assert result >= 0

    @pytest.mark.asyncio
    async def test_fallback_on_connection_error(self, model, messages):
        model.client.post = AsyncMock(side_effect=httpx.ConnectError("Connection refused"))

        result = await model.count_tokens(messages=messages)

        assert isinstance(result, int)
        assert result >= 0

    @pytest.mark.asyncio
    async def test_fallback_logs_debug(self, model, messages, caplog):
        model.client.post = AsyncMock(side_effect=RuntimeError("Server down"))

        with caplog.at_level(logging.DEBUG, logger="strands.models.llamacpp"):
            await model.count_tokens(messages=messages)

        assert any("native token counting failed" in record.message for record in caplog.records)

    @pytest.mark.asyncio
    async def test_skip_native_api_when_use_native_token_count_false(self, messages):
        model = LlamaCppModel(base_url="http://localhost:8080", use_native_token_count=False)
        model.client.post = AsyncMock()

        result = await model.count_tokens(messages=messages)

        model.client.post.assert_not_called()
        assert isinstance(result, int)
        assert result >= 0

    @pytest.mark.asyncio
    async def test_skip_native_api_by_default(self, messages):
        model = LlamaCppModel(base_url="http://localhost:8080")
        model.client.post = AsyncMock()

        result = await model.count_tokens(messages=messages)

        model.client.post.assert_not_called()
        assert isinstance(result, int)
        assert result >= 0
