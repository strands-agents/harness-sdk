import time
import uuid

import pydantic
import pytest

import strands
from strands import Agent, tool
from strands.models import BedrockModel, CacheConfig, CacheToolsConfig
from strands.types.content import ContentBlock, Messages

# Model ID used for prompt-caching TTL integration tests. Per
# https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html
# the models that officially support 1h TTL on CachePoint are Claude Opus 4.5,
# Claude Haiku 4.5, and Claude Sonnet 4.5. Haiku 4.5 is the newest Haiku
# available and is preferred for CI due to lower latency and cost relative to
# the same-version Sonnet 4.5. Bump this when a newer Haiku is released that
# supports CachePoint TTL.
_CACHE_TTL_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0"


def _durable_prefix() -> str:
    """Salted per run so a rerun cannot read an earlier run's entry, and sized past the cache minimum."""
    return f"Dossier {uuid.uuid4()}. " + ("The subject prefers concise written answers. " * 600)


@strands.tool
def echo(value: str) -> str:
    """Echo the given value back."""
    return value


@pytest.fixture
def system_prompt():
    return "You are an AI assistant that uses & instead of ."


@pytest.fixture
def streaming_model():
    return BedrockModel(
        streaming=True,
    )


@pytest.fixture
def non_streaming_model():
    return BedrockModel(
        streaming=False,
    )


@pytest.fixture
def streaming_agent(streaming_model, system_prompt):
    return Agent(
        model=streaming_model,
        system_prompt=system_prompt,
        load_tools_from_directory=False,
    )


@pytest.fixture
def non_streaming_agent(non_streaming_model, system_prompt):
    return Agent(
        model=non_streaming_model,
        system_prompt=system_prompt,
        load_tools_from_directory=False,
    )


@pytest.fixture
def yellow_color():
    class Color(pydantic.BaseModel):
        """Describes a color."""

        name: str

        @pydantic.field_validator("name", mode="after")
        @classmethod
        def lower(_, value):
            return value.lower()

    return Color(name="yellow")


def test_streaming_agent(streaming_agent):
    """Test agent with streaming model."""
    result = streaming_agent("Hello!")

    assert len(str(result)) > 0


def test_non_streaming_agent(non_streaming_agent):
    """Test agent with non-streaming model."""
    result = non_streaming_agent("Hello!")

    assert len(str(result)) > 0


def test_bedrock_service_tier_flex_invocation_succeeds():
    """Bedrock accepts serviceTier when model and region support Priority/Flex tiers.

    Tier support is model- and region-specific. See:
    https://docs.aws.amazon.com/bedrock/latest/userguide/service-tiers-inference.html

    CI runs integ tests with AWS_REGION=us-east-1; amazon.nova-pro-v1:0 is listed for
    that region under Priority and Flex tiers.
    """
    model = BedrockModel(
        model_id="amazon.nova-pro-v1:0",
        region_name="us-east-1",
        service_tier="flex",
    )
    agent = Agent(model=model, load_tools_from_directory=False)
    result = agent("Reply with exactly the word: ok")

    assert result.stop_reason == "end_turn"
    assert len(str(result).strip()) > 0


@pytest.mark.asyncio
async def test_streaming_model_events(streaming_model, alist):
    """Test streaming model events."""
    messages = [{"role": "user", "content": [{"text": "Hello"}]}]

    # Call stream and collect events
    events = await alist(streaming_model.stream(messages))

    # Verify basic structure of events
    assert any("messageStart" in event for event in events)
    assert any("contentBlockDelta" in event for event in events)
    assert any("messageStop" in event for event in events)


@pytest.mark.asyncio
async def test_non_streaming_model_events(non_streaming_model, alist):
    """Test non-streaming model events."""
    messages = [{"role": "user", "content": [{"text": "Hello"}]}]

    # Call stream and collect events
    events = await alist(non_streaming_model.stream(messages))

    # Verify basic structure of events
    assert any("messageStart" in event for event in events)
    assert any("contentBlockDelta" in event for event in events)
    assert any("messageStop" in event for event in events)


def test_tool_use_streaming(streaming_model):
    """Test tool use with streaming model."""

    tool_was_called = False

    @strands.tool
    def calculator(expression: str) -> float:
        """Calculate the result of a mathematical expression."""

        nonlocal tool_was_called
        tool_was_called = True
        return eval(expression)

    agent = Agent(model=streaming_model, tools=[calculator], load_tools_from_directory=False)
    result = agent("What is 123 + 456?")

    # Print the full message content for debugging
    print("\nFull message content:")
    import json

    print(json.dumps(result.message["content"], indent=2))

    assert tool_was_called


def test_tool_use_non_streaming(non_streaming_model):
    """Test tool use with non-streaming model."""

    tool_was_called = False

    @strands.tool
    def calculator(expression: str) -> float:
        """Calculate the result of a mathematical expression."""

        nonlocal tool_was_called
        tool_was_called = True
        return eval(expression)

    agent = Agent(model=non_streaming_model, tools=[calculator], load_tools_from_directory=False)
    agent("What is 123 + 456?")

    assert tool_was_called


def test_structured_output_streaming(streaming_model):
    """Test structured output with streaming model."""

    class Weather(pydantic.BaseModel):
        time: str
        weather: str

    agent = Agent(model=streaming_model)

    result = agent.structured_output(Weather, "The time is 12:00 and the weather is sunny")
    assert isinstance(result, Weather)
    assert result.time == "12:00"
    assert result.weather == "sunny"


def test_structured_output_non_streaming(non_streaming_model):
    """Test structured output with non-streaming model."""

    class Weather(pydantic.BaseModel):
        time: str
        weather: str

    agent = Agent(model=non_streaming_model)

    result = agent.structured_output(Weather, "The time is 12:00 and the weather is sunny")
    assert isinstance(result, Weather)
    assert result.time == "12:00"
    assert result.weather == "sunny"


def test_invoke_multi_modal_input(streaming_agent, yellow_img):
    content = [
        {"text": "what is in this image"},
        {
            "image": {
                "format": "png",
                "source": {
                    "bytes": yellow_img,
                },
            },
        },
    ]
    result = streaming_agent(content)
    text = result.message["content"][0]["text"].lower()

    assert "yellow" in text


def test_invoke_audio_input(pineapple_audio):
    model = BedrockModel(
        model_id="mistral.voxtral-small-24b-2507",
        region_name="us-east-1",
        temperature=0,
        max_tokens=20,
    )
    agent = Agent(model=model, load_tools_from_directory=False)
    content = [
        {"text": "Transcribe the final word spoken in the audio. Output only that word."},
        {"audio": {"format": "mp3", "source": {"bytes": pineapple_audio}}},
    ]

    result = agent(content)
    text = result.message["content"][0]["text"].lower()

    assert "pineapple" in text


def test_document_citations(non_streaming_agent, letter_pdf):
    content: list[ContentBlock] = [
        {
            "document": {
                "name": "letter to shareholders",
                "source": {"bytes": letter_pdf},
                "citations": {"enabled": True},
                "context": "This is a letter to shareholders",
                "format": "pdf",
            },
        },
        {"text": "What does the document say about artificial intelligence? Use citations to back up your answer."},
    ]
    non_streaming_agent(content)

    assert any("citationsContent" in content for content in non_streaming_agent.messages[-1]["content"])

    # Validate message structure is valid in multi-turn
    non_streaming_agent("What is your favorite part?")


def test_document_citations_streaming(streaming_agent, letter_pdf):
    content: list[ContentBlock] = [
        {
            "document": {
                "name": "letter to shareholders",
                "source": {"bytes": letter_pdf},
                "citations": {"enabled": True},
                "context": "This is a letter to shareholders",
                "format": "pdf",
            },
        },
        {"text": "What does the document say about artificial intelligence? Use citations to back up your answer."},
    ]
    streaming_agent(content)

    assert any("citationsContent" in content for content in streaming_agent.messages[-1]["content"])

    # Validate message structure is valid in multi-turn
    streaming_agent("What is your favorite part?")


def test_structured_output_multi_modal_input(streaming_agent, yellow_img, yellow_color):
    content = [
        {"text": "Is this image red, blue, or yellow?"},
        {
            "image": {
                "format": "png",
                "source": {
                    "bytes": yellow_img,
                },
            },
        },
    ]
    tru_color = streaming_agent.structured_output(type(yellow_color), content)
    exp_color = yellow_color
    assert tru_color == exp_color


def test_reasoning_content_in_messages_with_thinking_disabled():
    """Test that messages with reasoningContent are accepted when thinking is explicitly disabled."""
    # First, get a real reasoning response with thinking enabled
    thinking_model = BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-20250514-v1:0",
        additional_request_fields={
            "thinking": {
                "type": "enabled",
                "budget_tokens": 1024,
            }
        },
    )
    agent_with_thinking = Agent(model=thinking_model)
    result_with_thinking = agent_with_thinking("What is 2+2?")

    # Verify we got reasoning content
    assert "reasoningContent" in result_with_thinking.message["content"][0]

    # Now create a model with thinking disabled and use the messages from the thinking session
    disabled_model = BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-20250514-v1:0",
        additional_request_fields={
            "thinking": {
                "type": "disabled",
            }
        },
    )

    # Use the conversation history that includes reasoning content
    messages = agent_with_thinking.messages

    agent_disabled = Agent(model=disabled_model, messages=messages)
    result = agent_disabled("What about 3+3?")

    assert result.stop_reason == "end_turn"


def test_multi_prompt_system_content():
    """Test multi-prompt system content blocks."""
    system_prompt_content = [
        {"text": "You are a helpful assistant."},
        {"text": "Always be concise."},
        {"text": "End responses with 'Done.'"},
    ]

    agent = Agent(system_prompt=system_prompt_content, load_tools_from_directory=False)
    # just verifying there is no failure
    agent("Hello!")


def test_prompt_caching_with_5m_ttl(quiet_strands_logging):
    """Test prompt caching with 5 minute TTL and verify cache metrics.

    This test verifies:
    1. First call creates cache (cacheWriteInputTokens > 0)
    2. Second call reads from cache (cacheReadInputTokens > 0)
    """
    model = BedrockModel(
        model_id="us.anthropic.claude-haiku-4-5-20251001-v1:0",
        streaming=False,
    )

    large_context = _durable_prefix()

    system_prompt_with_cache = [
        {"text": large_context},
        {"cachePoint": {"type": "default", "ttl": "5m"}},
        {"text": "You are a helpful assistant."},
    ]

    agent = Agent(
        model=model,
        system_prompt=system_prompt_with_cache,
        load_tools_from_directory=False,
    )

    # First call should create the cache (cache write)
    result1 = agent("What is 2+2?")
    assert len(str(result1)) > 0

    # Verify cache write occurred on first call
    assert result1.metrics.accumulated_usage.get("cacheWriteInputTokens", 0) > 0, (
        "Expected cacheWriteInputTokens > 0 on first call"
    )

    # Second call should use the cached content (cache read)
    result2 = agent("What is 3+3?")
    assert len(str(result2)) > 0

    # Verify cache read occurred on second call
    assert result2.metrics.accumulated_usage.get("cacheReadInputTokens", 0) > 0, (
        "Expected cacheReadInputTokens > 0 on second call"
    )


def test_prompt_caching_with_1h_ttl(quiet_strands_logging):
    """Test prompt caching with 1 hour TTL and verify cache metrics."""
    model = BedrockModel(
        model_id="us.anthropic.claude-haiku-4-5-20251001-v1:0",
        streaming=False,
    )

    # Use timestamp to ensure unique content per test run (avoids CI conflicts)
    unique_id = str(int(time.time() * 1000000))  # microsecond timestamp
    # Minimum 4096 tokens required for caching with Haiku 4.5
    large_context = f"Background information for test {unique_id}: " + ("This is important context. " * 1000)

    system_prompt_with_cache = [
        {"text": large_context},
        {"cachePoint": {"type": "default", "ttl": "1h"}},
        {"text": "You are a helpful assistant."},
    ]

    agent = Agent(
        model=model,
        system_prompt=system_prompt_with_cache,
        load_tools_from_directory=False,
    )

    # First call should create the cache
    result1 = agent("What is 2+2?")
    assert len(str(result1)) > 0

    # Verify cache write occurred
    assert result1.metrics.accumulated_usage.get("cacheWriteInputTokens", 0) > 0, (
        "Expected cacheWriteInputTokens > 0 on first call with 1h TTL"
    )

    # Second call should use the cached content
    result2 = agent("What is 3+3?")
    assert len(str(result2)) > 0

    # Verify cache read occurred
    assert result2.metrics.accumulated_usage.get("cacheReadInputTokens", 0) > 0, (
        "Expected cacheReadInputTokens > 0 on second call with 1h TTL"
    )


def test_prompt_caching_with_ttl_in_messages(quiet_strands_logging):
    """Test prompt caching with TTL in message content and verify cache metrics.

    Uses Claude Haiku 4.5 which supports TTL in CachePointBlock on Bedrock.
    Older models (e.g. Claude Sonnet 4) reject the TTL field with a ValidationException.
    """
    model = BedrockModel(
        model_id="us.anthropic.claude-haiku-4-5-20251001-v1:0",
        streaming=False,
    )
    agent = Agent(model=model, load_tools_from_directory=False)

    large_text = _durable_prefix()

    content_with_cache = [
        {"text": large_text},
        {"cachePoint": {"type": "default", "ttl": "5m"}},
        {"text": "Based on the context above, what is 5+5?"},
    ]

    # First call creates cache
    result1 = agent(content_with_cache)
    assert len(str(result1)) > 0

    # Verify cache write in message content
    assert result1.metrics.accumulated_usage.get("cacheWriteInputTokens", 0) > 0, (
        "Expected cacheWriteInputTokens > 0 when caching message content"
    )

    # Subsequent call should use cache
    result2 = agent("What about 10+10?")
    assert len(str(result2)) > 0

    # Verify cache read on subsequent call
    assert result2.metrics.accumulated_usage.get("cacheReadInputTokens", 0) > 0, (
        "Expected cacheReadInputTokens > 0 on subsequent call"
    )


def test_prompt_caching_backward_compatibility_no_ttl(quiet_strands_logging):
    """Test that prompt caching works without TTL (backward compatibility).

    Verifies that cache points work correctly when TTL is not specified,
    maintaining backward compatibility with existing code.

    Uses Claude Haiku 4.5 which supports prompt caching on Bedrock.
    Minimum 4096 tokens required for caching with Haiku 4.5.
    """
    model = BedrockModel(
        model_id="us.anthropic.claude-haiku-4-5-20251001-v1:0",
        streaming=False,
    )

    large_context = _durable_prefix()

    system_prompt_with_cache = [
        {"text": large_context},
        {"cachePoint": {"type": "default"}},  # No TTL specified
        {"text": "You are a helpful assistant."},
    ]

    agent = Agent(
        model=model,
        system_prompt=system_prompt_with_cache,
        load_tools_from_directory=False,
    )

    result = agent("Hello!")
    assert len(str(result)) > 0

    # Verify cache write occurred even without TTL
    assert result.metrics.accumulated_usage.get("cacheWriteInputTokens", 0) > 0, (
        "Expected cacheWriteInputTokens > 0 even without TTL specified"
    )


class TestCountTokens:
    @pytest.fixture
    def model(self):
        return BedrockModel(model_id="anthropic.claude-sonnet-4-20250514-v1:0", use_native_token_count=True)

    @pytest.fixture
    def messages(self):
        return [{"role": "user", "content": [{"text": "What is the capital of France? Explain in detail."}]}]

    @pytest.fixture
    def tool_specs(self):
        return [
            {
                "name": "get_weather",
                "description": "Get the current weather for a location",
                "inputSchema": {"json": {"type": "object", "properties": {"location": {"type": "string"}}}},
            }
        ]

    @pytest.mark.asyncio
    async def test_count_tokens_messages_only(self, model, messages, caplog):
        with caplog.at_level("DEBUG"):
            result = await model.count_tokens(messages=messages)
        assert isinstance(result, int)
        assert result > 0
        assert "native token count" in caplog.text
        assert "falling back" not in caplog.text

    @pytest.mark.asyncio
    async def test_count_tokens_with_tools_greater_than_without(self, model, messages, tool_specs):
        without = await model.count_tokens(messages=messages)
        with_tools = await model.count_tokens(messages=messages, tool_specs=tool_specs, system_prompt="Be helpful.")
        assert with_tools > without


def test_strict_tools_with_complex_schema():
    """Test strict_tools=True with tools that have complex schemas including arrays and optional params."""

    tools_called = set()

    @strands.tool
    def search(query: str, tags: list[str], max_results: int = 5) -> str:
        """Search for items matching query and tags."""
        tools_called.add("search")
        return f"Found results for '{query}' with tags {tags} (limit {max_results})"

    @strands.tool
    def calculator(expression: str) -> float:
        """Calculate the result of a mathematical expression."""
        tools_called.add("calculator")
        return eval(expression)

    model = BedrockModel(strict_tools=True)
    agent = Agent(model=model, tools=[search, calculator], load_tools_from_directory=False)
    agent('Search for "python" with tags ["programming", "language"] using the search tool.')

    assert "search" in tools_called


def test_prompt_caching_cache_tools_ttl():
    """Test that CacheToolsConfig(ttl=...) propagates into the auto-injected toolConfig cache point.

    Verifies that BedrockModel(cache_tools=CacheToolsConfig(type="default", ttl="5m")) produces a
    Bedrock request with cachePoint.ttl on the toolConfig checkpoint, and that the call
    completes without a ValidationException on the TTL field.

    Note: we intentionally do not assert specific cacheWriteInputTokens on the toolConfig
    prefix because Bedrock's tool-prefix cache threshold varies by model and region.
    The critical behavior under test here is that the TTL field is accepted end-to-end.
    """
    model = BedrockModel(
        model_id=_CACHE_TTL_MODEL_ID,
        streaming=False,
        cache_tools=CacheToolsConfig(type="default", ttl="5m"),
    )

    @strands.tool
    def lookup_fact(topic: str) -> str:
        """Look up a fact about the given topic.

        This tool is useful when you need authoritative information.
        """
        return f"Fact about {topic}: example"

    agent = Agent(
        model=model,
        tools=[lookup_fact],
        load_tools_from_directory=False,
    )

    # The call must succeed — Bedrock must accept cachePoint.ttl on the toolConfig checkpoint
    # without raising a ValidationException. The loop only returns on a terminal stop reason, so
    # this proves completion without depending on the model emitting text.
    result = agent("Use the lookup_fact tool to look up 'python'.")
    assert result.stop_reason == "end_turn"


def test_prompt_caching_cache_config_auto_with_ttl(quiet_strands_logging):
    """Test that CacheConfig(strategy="auto", ttl="5m") propagates TTL to the auto-injected message cache point.

    Verifies that the cache point appended to the last user message by _inject_cache_point
    carries the configured TTL, and that Bedrock accepts the request.
    """
    model = BedrockModel(
        model_id=_CACHE_TTL_MODEL_ID,
        streaming=False,
        cache_config=CacheConfig(strategy="auto", ttl="5m"),
    )

    large_message = f"{_durable_prefix()} What is 2+2?"

    agent = Agent(
        model=model,
        load_tools_from_directory=False,
    )

    # First call: auto-injected cache point on the last user message must include ttl and be accepted
    result1 = agent(large_message)
    assert len(str(result1)) > 0

    # Verify cache write occurred with auto-inject + ttl
    assert result1.metrics.accumulated_usage.get("cacheWriteInputTokens", 0) > 0, (
        "Expected cacheWriteInputTokens > 0 with CacheConfig(strategy='auto', ttl='5m')"
    )


def test_prompt_caching_aligned_1h_ttl_across_checkpoints(quiet_strands_logging):
    """Regression test for Bedrock TTL non-increasing ordering rule (Issue #2121).

    Bedrock processes cache checkpoints in order: toolConfig -> system -> messages,
    and requires TTLs to be non-increasing. Before this change, cache_tools hardcoded
    an implicit 5m TTL, so any 1h TTL on a later checkpoint would raise a
    ValidationException.

    This test sets 1h TTL on all three checkpoints simultaneously and verifies the
    call succeeds.
    """
    model = BedrockModel(
        model_id=_CACHE_TTL_MODEL_ID,
        streaming=False,
        cache_tools=CacheToolsConfig(type="default", ttl="1h"),
        cache_config=CacheConfig(strategy="auto", ttl="1h"),
    )

    # Timestamp-based uniqueness to avoid cache conflicts across CI runs
    unique_id = str(int(time.time() * 1000000))
    large_context = f"Background context for test {unique_id}: " + ("This is important context. " * 1000)

    # User-supplied 1h cache point on system prompt — third checkpoint also at 1h
    system_prompt_with_cache = [
        {"text": large_context},
        {"cachePoint": {"type": "default", "ttl": "1h"}},
        {"text": "You are a helpful assistant."},
    ]

    agent = Agent(
        model=model,
        system_prompt=system_prompt_with_cache,
        tools=[echo],
        load_tools_from_directory=False,
    )

    # Must succeed without ValidationException on the non-increasing TTL rule. The large context
    # exceeds the cache minimum, so a cache write reliably confirms the request was accepted.
    result = agent("What is 2+2?")
    assert result.metrics.accumulated_usage.get("cacheWriteInputTokens", 0) > 0


def test_prompt_caching_untimed_cache_tools_inherits_the_configured_ttl(quiet_strands_logging):
    """An untimed cache_tools takes the Bedrock default, which a configured ttl on the message point exceeds.

    Bedrock processes cache checkpoints in order toolConfig -> system -> messages and requires their TTLs
    to be non-increasing. A bare-string cache_tools="default" emits no TTL, so the tools point sat at the
    5m default while the auto-injected message point carried the configured 1h - an increasing sequence
    Bedrock rejects. The tools point now inherits the configured ttl, keeping the sequence in step.
    """
    model = BedrockModel(
        model_id=_CACHE_TTL_MODEL_ID,
        streaming=False,
        cache_tools="default",
        cache_config=CacheConfig(strategy="auto", ttl="1h"),
    )

    agent = Agent(
        model=model,
        system_prompt=_durable_prefix(),
        tools=[echo],
        load_tools_from_directory=False,
    )

    # The durable prefix exceeds the cache minimum, so a cache write reliably confirms Bedrock
    # accepted the aligned-TTL request without a ValidationException.
    result = agent("What is 2+2?")
    assert result.metrics.accumulated_usage.get("cacheWriteInputTokens", 0) > 0


def test_bedrock_cache_point(quiet_strands_logging):
    messages: Messages = [
        {
            "role": "user",
            "content": [
                {"text": _durable_prefix()},
                {"cachePoint": {"type": "default"}},
            ],
        },
        {"role": "assistant", "content": [{"text": "Blue!"}]},
    ]

    cache_point_usage = 0

    def cache_point_callback_handler(**kwargs):
        nonlocal cache_point_usage
        if "event" in kwargs and kwargs["event"] and "metadata" in kwargs["event"] and kwargs["event"]["metadata"]:
            metadata = kwargs["event"]["metadata"]
            if "usage" in metadata and metadata["usage"]:
                if "cacheReadInputTokens" in metadata["usage"] or "cacheWriteInputTokens" in metadata["usage"]:
                    cache_point_usage += 1

    agent = Agent(
        model=BedrockModel(model_id=_CACHE_TTL_MODEL_ID),
        messages=messages,
        callback_handler=cache_point_callback_handler,
        load_tools_from_directory=False,
    )
    agent("What is favorite color?")
    assert cache_point_usage > 0


def test_bedrock_multi_prompt_and_duplicate_cache_point(quiet_strands_logging):
    """Test multi-prompt system with cache point."""
    system_prompt_content = [
        {"text": "You are a helpful assistant." * 800},  # Long text for cache; must clear Haiku 4.5's 4096-token min
        {"cachePoint": {"type": "default"}},
        {"text": "Always respond with enthusiasm!"},
    ]

    cache_point_usage = 0

    def cache_point_callback_handler(**kwargs):
        nonlocal cache_point_usage
        if "event" in kwargs and kwargs["event"] and "metadata" in kwargs["event"] and kwargs["event"]["metadata"]:
            metadata = kwargs["event"]["metadata"]
            if "usage" in metadata and metadata["usage"]:
                if "cacheReadInputTokens" in metadata["usage"] or "cacheWriteInputTokens" in metadata["usage"]:
                    cache_point_usage += 1

    agent = Agent(
        model=BedrockModel(model_id=_CACHE_TTL_MODEL_ID, cache_prompt="default"),
        system_prompt=system_prompt_content,
        callback_handler=cache_point_callback_handler,
        load_tools_from_directory=False,
    )
    agent("Hello!")
    assert cache_point_usage > 0


def test_a_cache_boundary_keeps_per_call_content_out_of_the_cached_prefix(quiet_strands_logging):
    """Content behind a caller's boundary stays uncached instead of being folded into the prefix.

    A read alone does not show this: relocating the point to the end of the message also earns a read,
    because everything including the per-call tail gets cached. The tail's tokens are what tell the
    two apart - they are billed as ordinary input when the boundary is honored, and swallowed into
    cacheWriteInputTokens when it is not.
    """
    tail = f"Addendum {uuid.uuid4()}. " + ("Disregard this filler sentence entirely. " * 600)
    model = BedrockModel(model_id=_CACHE_TTL_MODEL_ID, cache_config=CacheConfig(strategy="auto"))
    agent = Agent(model=model, load_tools_from_directory=False, callback_handler=None)

    first = agent([{"text": _durable_prefix()}, {"cachePoint": {"type": "default"}}, {"text": tail}])
    first_usage = first.metrics.latest_agent_invocation.usage
    assert first_usage.get("cacheWriteInputTokens", 0) > 0, "first turn should have written the prefix"
    assert first_usage.get("inputTokens", 0) > 1000, (
        f"per-call tail was folded into the cached prefix instead of billed as input: {dict(first_usage)}"
    )

    fresh_tail = f"Addendum {uuid.uuid4()}. " + ("Disregard this filler sentence entirely. " * 600)
    second = agent([{"text": "Anything else?"}, {"cachePoint": {"type": "default"}}, {"text": fresh_tail}])
    assert second.metrics.latest_agent_invocation.usage.get("cacheReadInputTokens", 0) > 0, (
        "second turn rewrote the prefix instead of reading it"
    )


def test_a_leading_cache_point_is_accepted(quiet_strands_logging):
    """A cache point with nothing ahead of it is replaced by automatic placement.

    Bedrock rejects the shape outright with "There is nothing available to cache", so the point has to
    be dropped and re-placed for the request to survive at all.
    """
    model = BedrockModel(model_id=_CACHE_TTL_MODEL_ID, cache_config=CacheConfig(strategy="auto"))
    agent = Agent(model=model, load_tools_from_directory=False, callback_handler=None)

    result = agent([{"cachePoint": {"type": "default"}}, {"text": _durable_prefix()}])

    assert result.metrics.latest_agent_invocation.usage.get("cacheWriteInputTokens", 0) > 0


@pytest.mark.parametrize("configured_ttl", [None, "5m"])
def test_a_caller_ttl_does_not_conflict_with_the_tools_ttl(quiet_strands_logging, configured_ttl):
    """A caller's TTL is normalized so it cannot invert the TTL order Bedrock requires.

    Bedrock reads cache points in toolConfig, system, messages order and rejects a longer TTL that
    follows a shorter one, so a caller's ``1h`` behind tools at ``5m`` is what has to be neutralized.
    Both configurations reach the API: the caller's TTL is dropped when none is configured and replaced
    by the configured one otherwise. A tool cache point only reaches the request when a tool is
    registered, so the conflicting order this guards against needs one.
    """

    @tool
    def current_time() -> str:
        """Get the current time."""
        return "12:00"

    model = BedrockModel(
        model_id=_CACHE_TTL_MODEL_ID,
        cache_config=CacheConfig(strategy="auto", ttl=configured_ttl),
        cache_tools=CacheToolsConfig(ttl="5m"),
    )
    agent = Agent(model=model, tools=[current_time], load_tools_from_directory=False, callback_handler=None)

    result = agent(
        [
            {"text": _durable_prefix()},
            {"cachePoint": {"type": "default", "ttl": "1h"}},
            {"text": "Reply OK."},
        ]
    )

    assert result.stop_reason == "end_turn"
    assert result.metrics.latest_agent_invocation.usage.get("cacheWriteInputTokens", 0) > 0


# A ~100 KB PDF plus the SDK's throttling backoff can outlast the global 90s timeout.
@pytest.mark.timeout(300)
@pytest.mark.parametrize("document_format", ["csv", "pdf"])
def test_a_cache_point_after_a_document_is_accepted(quiet_strands_logging, letter_pdf, document_format):
    """Bedrock refuses a cache point directly after a non-PDF document but allows one after a PDF.

    The point steps back over an adjacent non-PDF document and stays put after a PDF, so both shapes
    have to reach the API intact.
    """
    sources = {"csv": b"a,b\n1,2\n", "pdf": letter_pdf}
    document: ContentBlock = {
        "document": {
            "format": document_format,
            "name": "attachment",
            "source": {"bytes": sources[document_format]},
        }
    }
    model = BedrockModel(model_id=_CACHE_TTL_MODEL_ID, cache_config=CacheConfig(strategy="auto"))
    agent = Agent(model=model, load_tools_from_directory=False, callback_handler=None)

    result = agent([{"text": _durable_prefix()}, document, {"cachePoint": {"type": "default"}}, {"text": "Reply OK."}])

    assert result.stop_reason == "end_turn"
