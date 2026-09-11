"""Integration tests for llama.cpp model provider.

These tests require a running llama.cpp server instance.
To run these tests:
1. Start llama.cpp server: llama-server -m model.gguf --host 0.0.0.0 --port 8080
2. Run: pytest tests_integ/models/test_model_llamacpp.py

Set LLAMACPP_TEST_URL environment variable to use a different server URL.
"""

import os
import uuid

import pytest
from pydantic import BaseModel

from strands.models.llamacpp import LlamaCppModel
from strands.models.model import CacheConfig
from strands.types.content import Message

# Get server URL from environment or use default
LLAMACPP_URL = os.environ.get("LLAMACPP_TEST_URL", "http://localhost:8080/v1")

# Skip these tests if LLAMACPP_SKIP_TESTS is set
pytestmark = pytest.mark.skipif(
    os.environ.get("LLAMACPP_SKIP_TESTS", "true").lower() == "true",
    reason="llama.cpp integration tests disabled (set LLAMACPP_SKIP_TESTS=false to enable)",
)


class WeatherOutput(BaseModel):
    """Test output model for structured responses."""

    temperature: float
    condition: str
    location: str


@pytest.fixture
async def llamacpp_model() -> LlamaCppModel:
    """Fixture to create a llama.cpp model instance."""
    return LlamaCppModel(base_url=LLAMACPP_URL)


# Integration tests for LlamaCppModel with a real server


@pytest.mark.asyncio
async def test_basic_completion(llamacpp_model: LlamaCppModel) -> None:
    """Test basic text completion."""
    messages: list[Message] = [
        {"role": "user", "content": [{"text": "Say 'Hello, World!' and nothing else."}]},
    ]

    response_text = ""
    async for event in llamacpp_model.stream(messages):
        if "contentBlockDelta" in event:
            delta = event["contentBlockDelta"]["delta"]
            if "text" in delta:
                response_text += delta["text"]

    assert "Hello, World!" in response_text


@pytest.mark.asyncio
async def test_system_prompt(llamacpp_model: LlamaCppModel) -> None:
    """Test completion with system prompt."""
    messages: list[Message] = [
        {"role": "user", "content": [{"text": "Who are you?"}]},
    ]

    system_prompt = "You are a helpful AI assistant named Claude."

    response_text = ""
    async for event in llamacpp_model.stream(messages, system_prompt=system_prompt):
        if "contentBlockDelta" in event:
            delta = event["contentBlockDelta"]["delta"]
            if "text" in delta:
                response_text += delta["text"]

    # Response should reflect the system prompt
    assert len(response_text) > 0
    assert "assistant" in response_text.lower() or "claude" in response_text.lower()


@pytest.mark.asyncio
async def test_streaming_chunks(llamacpp_model: LlamaCppModel) -> None:
    """Test that streaming returns proper chunk sequence."""
    messages: list[Message] = [
        {"role": "user", "content": [{"text": "Count from 1 to 3."}]},
    ]

    chunk_types = []
    async for event in llamacpp_model.stream(messages):
        chunk_types.append(next(iter(event.keys())))

    # Verify proper chunk sequence
    assert chunk_types[0] == "messageStart"
    assert chunk_types[1] == "contentBlockStart"
    assert "contentBlockDelta" in chunk_types
    assert chunk_types[-3] == "contentBlockStop"
    assert chunk_types[-2] == "messageStop"
    assert chunk_types[-1] == "metadata"


@pytest.mark.asyncio
async def test_temperature_parameter(llamacpp_model: LlamaCppModel) -> None:
    """Test temperature parameter affects randomness."""
    messages: list[Message] = [
        {"role": "user", "content": [{"text": "Generate a random word."}]},
    ]

    # Low temperature should give more consistent results
    llamacpp_model.update_config(params={"temperature": 0.1, "seed": 42})

    response1 = ""
    async for event in llamacpp_model.stream(messages):
        if "contentBlockDelta" in event:
            delta = event["contentBlockDelta"]["delta"]
            if "text" in delta:
                response1 += delta["text"]

    # Same seed and low temperature should give similar result
    response2 = ""
    async for event in llamacpp_model.stream(messages):
        if "contentBlockDelta" in event:
            delta = event["contentBlockDelta"]["delta"]
            if "text" in delta:
                response2 += delta["text"]

    # With low temperature and same seed, responses should be very similar
    assert len(response1) > 0
    assert len(response2) > 0


@pytest.mark.asyncio
async def test_max_tokens_limit(llamacpp_model: LlamaCppModel) -> None:
    """Test max_tokens parameter limits response length."""
    messages: list[Message] = [
        {"role": "user", "content": [{"text": "Tell me a very long story about dragons."}]},
    ]

    # Set very low token limit
    llamacpp_model.update_config(params={"max_tokens": 10})

    token_count = 0
    async for event in llamacpp_model.stream(messages):
        if "metadata" in event:
            usage = event["metadata"]["usage"]
            token_count = usage["outputTokens"]
        if "messageStop" in event:
            stop_reason = event["messageStop"]["stopReason"]

    # Should stop due to max_tokens
    assert token_count <= 15  # Allow small overage due to tokenization
    assert stop_reason == "max_tokens"


@pytest.mark.asyncio
async def test_structured_output(llamacpp_model: LlamaCppModel) -> None:
    """Test structured output generation."""
    messages: list[Message] = [
        {
            "role": "user",
            "content": [
                {
                    "text": "What's the weather like in Paris? "
                    "Respond with temperature in Celsius, condition, and location."
                }
            ],
        },
    ]

    # Enable JSON response format for structured output
    llamacpp_model.update_config(params={"response_format": {"type": "json_object"}})

    result = None
    async for event in llamacpp_model.structured_output(WeatherOutput, messages):
        if "output" in event:
            result = event["output"]

    assert result is not None
    assert isinstance(result, WeatherOutput)
    assert isinstance(result.temperature, float)
    assert isinstance(result.condition, str)
    assert result.location.lower() == "paris"


@pytest.mark.asyncio
async def test_llamacpp_specific_params(llamacpp_model: LlamaCppModel) -> None:
    """Test llama.cpp specific parameters."""
    messages: list[Message] = [
        {"role": "user", "content": [{"text": "Say 'test' five times."}]},
    ]

    # Use llama.cpp specific parameters
    llamacpp_model.update_config(
        params={
            "repeat_penalty": 1.5,  # Penalize repetition
            "top_k": 10,  # Limit vocabulary
            "min_p": 0.1,  # Min-p sampling
        }
    )

    response_text = ""
    async for event in llamacpp_model.stream(messages):
        if "contentBlockDelta" in event:
            delta = event["contentBlockDelta"]["delta"]
            if "text" in delta:
                response_text += delta["text"]

    # Response should contain "test" but with repetition penalty it might vary
    assert "test" in response_text.lower()


@pytest.mark.asyncio
async def test_advanced_sampling_params(llamacpp_model: LlamaCppModel) -> None:
    """Test advanced sampling parameters."""
    messages: list[Message] = [
        {"role": "user", "content": [{"text": "Generate a random sentence about space."}]},
    ]

    # Test advanced sampling parameters
    llamacpp_model.update_config(
        params={
            "temperature": 0.8,
            "tfs_z": 0.95,  # Tail-free sampling
            "top_a": 0.1,  # Top-a sampling
            "typical_p": 0.9,  # Typical-p sampling
            "penalty_last_n": 64,  # Penalty context window
            "min_keep": 1,  # Minimum tokens to keep
            "samplers": ["top_k", "tfs_z", "typical_p", "top_p", "min_p", "temperature"],
        }
    )

    response_text = ""
    async for event in llamacpp_model.stream(messages):
        if "contentBlockDelta" in event:
            delta = event["contentBlockDelta"]["delta"]
            if "text" in delta:
                response_text += delta["text"]

    # Should generate something about space
    assert len(response_text) > 0
    assert any(word in response_text.lower() for word in ["space", "star", "planet", "galaxy", "universe"])


@pytest.mark.asyncio
async def test_mirostat_sampling(llamacpp_model: LlamaCppModel) -> None:
    """Test Mirostat sampling modes."""
    messages: list[Message] = [
        {"role": "user", "content": [{"text": "Write a short poem."}]},
    ]

    # Test Mirostat v2
    llamacpp_model.update_config(
        params={
            "mirostat": 2,
            "mirostat_lr": 0.1,
            "mirostat_ent": 5.0,
            "seed": 42,  # For reproducibility
        }
    )

    response_text = ""
    async for event in llamacpp_model.stream(messages):
        if "contentBlockDelta" in event:
            delta = event["contentBlockDelta"]["delta"]
            if "text" in delta:
                response_text += delta["text"]

    # Should generate a poem
    assert len(response_text) > 20
    assert "\n" in response_text  # Poems typically have line breaks


@pytest.mark.asyncio
async def test_grammar_constraint(llamacpp_model: LlamaCppModel) -> None:
    """Test grammar constraint feature (llama.cpp specific)."""
    messages: list[Message] = [
        {"role": "user", "content": [{"text": "Is the sky blue? Answer yes or no."}]},
    ]

    # Set grammar constraint via params
    grammar = """
        root ::= answer
        answer ::= "yes" | "no"
        """
    llamacpp_model.update_config(params={"grammar": grammar})

    response_text = ""
    async for event in llamacpp_model.stream(messages):
        if "contentBlockDelta" in event:
            delta = event["contentBlockDelta"]["delta"]
            if "text" in delta:
                response_text += delta["text"]

    # Response should be exactly "yes" or "no"
    assert response_text.strip().lower() in ["yes", "no"]


@pytest.mark.asyncio
async def test_json_schema_constraint(llamacpp_model: LlamaCppModel) -> None:
    """Test JSON schema constraint feature."""
    messages: list[Message] = [
        {
            "role": "user",
            "content": [{"text": "Describe the weather in JSON format with temperature and description."}],
        },
    ]

    # Set JSON schema constraint via params
    schema = {
        "type": "object",
        "properties": {"temperature": {"type": "number"}, "description": {"type": "string"}},
        "required": ["temperature", "description"],
    }
    llamacpp_model.update_config(params={"json_schema": schema})

    response_text = ""
    async for event in llamacpp_model.stream(messages):
        if "contentBlockDelta" in event:
            delta = event["contentBlockDelta"]["delta"]
            if "text" in delta:
                response_text += delta["text"]

    # Should be valid JSON matching the schema
    import json

    data = json.loads(response_text.strip())
    assert "temperature" in data
    assert "description" in data
    assert isinstance(data["temperature"], (int, float))
    assert isinstance(data["description"], str)


@pytest.mark.asyncio
async def test_logit_bias(llamacpp_model: LlamaCppModel) -> None:
    """Test logit bias feature."""
    messages: list[Message] = [
        {"role": "user", "content": [{"text": "Choose between 'cat' and 'dog'."}]},
    ]

    # This is a simplified test - in reality you'd need to know the actual token IDs
    # for "cat" and "dog" in the model's vocabulary
    llamacpp_model.update_config(
        params={
            "logit_bias": {
                # These are placeholder token IDs - real implementation would need actual token IDs
                1234: 10.0,  # Strong positive bias (hypothetical "cat" token)
                5678: -10.0,  # Strong negative bias (hypothetical "dog" token)
            },
            "seed": 42,  # For reproducibility
        }
    )

    response_text = ""
    async for event in llamacpp_model.stream(messages):
        if "contentBlockDelta" in event:
            delta = event["contentBlockDelta"]["delta"]
            if "text" in delta:
                response_text += delta["text"]

    # Should generate text (exact behavior depends on actual token IDs)
    assert len(response_text) > 0


@pytest.mark.asyncio
async def test_cache_prompt(llamacpp_model: LlamaCppModel) -> None:
    """Test prompt caching feature."""
    messages: list[Message] = [
        {"role": "system", "content": [{"text": "You are a helpful assistant. Always be concise."}]},
        {"role": "user", "content": [{"text": "What is 2+2?"}]},
    ]

    # Enable prompt caching
    llamacpp_model.update_config(
        params={
            "cache_prompt": True,
            "slot_id": 0,  # Use specific slot for caching
        }
    )

    # First request
    response1 = ""
    async for event in llamacpp_model.stream(messages):
        if "contentBlockDelta" in event:
            delta = event["contentBlockDelta"]["delta"]
            if "text" in delta:
                response1 += delta["text"]

    # Second request with same system prompt should use cache
    messages2 = [
        {"role": "system", "content": [{"text": "You are a helpful assistant. Always be concise."}]},
        {"role": "user", "content": [{"text": "What is 3+3?"}]},
    ]

    response2 = ""
    async for event in llamacpp_model.stream(messages2):
        if "contentBlockDelta" in event:
            delta = event["contentBlockDelta"]["delta"]
            if "text" in delta:
                response2 += delta["text"]

    # Both should give valid responses
    assert "4" in response1
    assert "6" in response2


@pytest.mark.asyncio
async def test_cache_read_tokens_are_surfaced() -> None:
    """llama.cpp's reused prompt prefix is surfaced end to end as cacheReadInputTokens.

    A first request over a unique long prefix has nothing to read back; a second request over the same
    prefix reuses it, so its cacheReadInputTokens is positive and larger. A control model that forces
    ``cache_prompt=False`` reuses nothing — proving the flag, not just the server's default, drives reuse.
    """
    # Unique so a rerun cannot read a prior run's cache entry; long enough that the reused count clearly
    # exceeds the chat-template prefix.
    system_prompt = f"Session {uuid.uuid4()}. " + ("You are a helpful assistant. Always be concise. " * 40)

    async def cache_read_tokens(model: LlamaCppModel, user_text: str) -> int:
        messages: list[Message] = [{"role": "user", "content": [{"text": user_text}]}]
        reads = 0
        async for event in model.stream(messages, system_prompt=system_prompt):
            if "metadata" in event:
                reads = event["metadata"]["usage"].get("cacheReadInputTokens", 0)
        return reads

    cached = LlamaCppModel(base_url=LLAMACPP_URL, cache_config=CacheConfig())
    cold_reads = await cache_read_tokens(cached, "What is 2+2?")
    warm_reads = await cache_read_tokens(cached, "What is 3+3?")

    assert warm_reads > 0, "second request should reuse the cached prefix (cacheReadInputTokens > 0)"
    assert warm_reads > cold_reads, "second request should reuse more of the prefix than the first"

    # Control: cache_prompt=False suppresses reuse, so the feature — not the server default — is what gates it.
    uncached = LlamaCppModel(base_url=LLAMACPP_URL, params={"cache_prompt": False})
    await cache_read_tokens(uncached, "What is 2+2?")
    assert await cache_read_tokens(uncached, "What is 3+3?") == 0, "cache_prompt=False should reuse nothing"


@pytest.mark.asyncio
async def test_concurrent_requests(llamacpp_model: LlamaCppModel) -> None:
    """Test handling multiple concurrent requests."""
    import asyncio

    async def make_request(prompt: str) -> str:
        messages: list[Message] = [
            {"role": "user", "content": [{"text": prompt}]},
        ]

        response = ""
        async for event in llamacpp_model.stream(messages):
            if "contentBlockDelta" in event:
                delta = event["contentBlockDelta"]["delta"]
                if "text" in delta:
                    response += delta["text"]
        return response

    # Make concurrent requests
    prompts = [
        "Say 'one'",
        "Say 'two'",
        "Say 'three'",
    ]

    responses = await asyncio.gather(*[make_request(p) for p in prompts])

    # Each response should contain the expected number
    assert "one" in responses[0].lower()
    assert "two" in responses[1].lower()
    assert "three" in responses[2].lower()


@pytest.mark.asyncio
async def test_enhanced_structured_output(llamacpp_model: LlamaCppModel) -> None:
    """Test enhanced structured output with native JSON schema support."""

    class BookInfo(BaseModel):
        title: str
        author: str
        year: int
        genres: list[str]

    messages: list[Message] = [
        {
            "role": "user",
            "content": [
                {
                    "text": "Create information about a fictional science fiction book. "
                    "Include title, author, publication year, and 2-3 genres."
                }
            ],
        },
    ]

    result = None
    events = []
    async for event in llamacpp_model.structured_output(BookInfo, messages):
        events.append(event)
        if "output" in event:
            result = event["output"]

    # Verify we got structured output
    assert result is not None
    assert isinstance(result, BookInfo)
    assert isinstance(result.title, str) and len(result.title) > 0
    assert isinstance(result.author, str) and len(result.author) > 0
    assert isinstance(result.year, int) and 1900 <= result.year <= 2100
    assert isinstance(result.genres, list) and len(result.genres) >= 2
    assert all(isinstance(genre, str) for genre in result.genres)

    # Should have streamed events before the output
    assert len(events) > 1


@pytest.mark.asyncio
async def test_context_overflow_handling(llamacpp_model: LlamaCppModel, quiet_strands_logging) -> None:
    """Test proper handling of context window overflow."""
    # Create a very long message that might exceed context
    long_text = "This is a test sentence. " * 1000
    messages: list[Message] = [
        {"role": "user", "content": [{"text": f"Summarize this text: {long_text}"}]},
    ]

    try:
        response_text = ""
        async for event in llamacpp_model.stream(messages):
            if "contentBlockDelta" in event:
                delta = event["contentBlockDelta"]["delta"]
                if "text" in delta:
                    response_text += delta["text"]

        # If it succeeds, we got a response
        assert len(response_text) > 0
    except Exception as e:
        # If it fails, it should be our custom error
        from strands.types.exceptions import ContextWindowOverflowException

        if isinstance(e, ContextWindowOverflowException):
            assert "context" in str(e).lower()
        else:
            # Some other error - re-raise to see what it was
            raise
