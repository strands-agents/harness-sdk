import os
import uuid

import pydantic
import pytest

import strands
from strands import Agent
from strands.agent import NullConversationManager
from strands.models import CacheConfig, CacheToolsConfig
from strands.models.anthropic import AnthropicModel
from strands.types.content import ContentBlock, Message
from strands.types.exceptions import ContextWindowOverflowException
from tests_integ.models import providers

# these tests only run if we have the anthropic api key
pytestmark = providers.anthropic.mark

MODEL_ID = "claude-sonnet-4-6"


@pytest.fixture
def model():
    return AnthropicModel(
        client_args={
            "api_key": os.getenv("ANTHROPIC_API_KEY"),
        },
        model_id=MODEL_ID,
        max_tokens=512,
    )


@pytest.fixture
def tools():
    @strands.tool
    def tool_time() -> str:
        return "12:00"

    @strands.tool
    def tool_weather() -> str:
        return "sunny"

    return [tool_time, tool_weather]


@pytest.fixture
def system_prompt():
    return "You are an AI assistant."


@pytest.fixture
def agent(model, tools, system_prompt):
    return Agent(model=model, tools=tools, system_prompt=system_prompt)


@pytest.fixture
def weather():
    class Weather(pydantic.BaseModel):
        """Extracts the time and weather from the user's message with the exact strings."""

        time: str
        weather: str

    return Weather(time="12:00", weather="sunny")


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


def test_agent_invoke(agent):
    result = agent("What is the time and weather in New York?")
    text = result.message["content"][0]["text"].lower()

    assert all(string in text for string in ["12:00", "sunny"])


@pytest.mark.asyncio
async def test_agent_invoke_async(agent):
    result = await agent.invoke_async("What is the time and weather in New York?")
    text = result.message["content"][0]["text"].lower()

    assert all(string in text for string in ["12:00", "sunny"])


@pytest.mark.asyncio
async def test_agent_stream_async(agent):
    stream = agent.stream_async("What is the time and weather in New York?")
    async for event in stream:
        _ = event

    result = event["result"]
    text = result.message["content"][0]["text"].lower()

    assert all(string in text for string in ["12:00", "sunny"])


def test_structured_output(agent, weather):
    tru_weather = agent.structured_output(type(weather), "The time is 12:00 and the weather is sunny")
    exp_weather = weather
    assert tru_weather == exp_weather


@pytest.mark.asyncio
async def test_agent_structured_output_async(agent, weather):
    tru_weather = await agent.structured_output_async(type(weather), "The time is 12:00 and the weather is sunny")
    exp_weather = weather
    assert tru_weather == exp_weather


def test_invoke_multi_modal_input(agent, yellow_img):
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
    result = agent(content)
    text = result.message["content"][0]["text"].lower()

    assert "yellow" in text


def test_structured_output_multi_modal_input(agent, yellow_img, yellow_color):
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
    tru_color = agent.structured_output(type(yellow_color), content)
    exp_color = yellow_color
    assert tru_color == exp_color


@pytest.mark.asyncio
def test_input_and_max_tokens_exceed_context_limit(quiet_strands_logging):
    """Test that triggers 'input length and max_tokens exceed context limit' error."""

    # Note that this test is written specifically in a style that allows us to swap out conversation_manager and
    # verify behavior

    model = AnthropicModel(
        model_id=MODEL_ID,
        max_tokens=64000,
    )

    large_message = "This is a very long text. " * 60000

    messages = [
        Message(role="user", content=[ContentBlock(text=large_message)]),
        Message(role="assistant", content=[ContentBlock(text=large_message)]),
        Message(role="user", content=[ContentBlock(text=large_message)]),
    ]

    # NullConversationManager will propagate ContextWindowOverflowException directly instead of handling it
    agent = Agent(model=model, conversation_manager=NullConversationManager())

    with pytest.raises(ContextWindowOverflowException):
        agent(messages)


def test_cache_config_earns_a_read_on_the_second_turn():
    """Automatic cache-point placement produces a reusable prefix rather than rewriting it every turn."""
    # Salted so a rerun cannot read an entry an earlier run wrote, and sized past the model's cache minimum.
    prefix = f"Dossier {uuid.uuid4()}. " + ("The subject prefers concise written answers. " * 600)
    model = AnthropicModel(
        client_args={"api_key": os.getenv("ANTHROPIC_API_KEY")},
        model_id=MODEL_ID,
        max_tokens=256,
        cache_config=CacheConfig(strategy="auto"),
    )
    agent = Agent(model=model, load_tools_from_directory=False, callback_handler=None)

    first = agent(f"{prefix}\n\nReply ALPHA.")
    assert first.metrics.latest_agent_invocation.usage.get("cacheWriteInputTokens", 0) > 0, (
        "first turn should have written the prefix"
    )

    second = agent("Reply BETA.")
    assert second.metrics.latest_agent_invocation.usage.get("cacheReadInputTokens", 0) > 0, (
        "second turn rewrote the prefix instead of reading it"
    )


def test_cache_tools_earns_a_read_on_the_second_turn():
    """A cached tool block is accepted by the API and read back on a later turn."""
    # Salted so a rerun within the TTL cannot read the block an earlier run wrote
    long_description = f"Look up a reference entry {uuid.uuid4()}. " + (
        "The catalog is exhaustive and stable across requests. " * 600
    )

    @strands.tool(description=long_description)
    def lookup_reference(topic: str) -> str:
        return f"No entry for {topic}."

    model = AnthropicModel(
        client_args={"api_key": os.getenv("ANTHROPIC_API_KEY")},
        model_id=MODEL_ID,
        max_tokens=256,
        cache_tools=CacheToolsConfig(ttl="5m"),
    )
    agent = Agent(model=model, tools=[lookup_reference], load_tools_from_directory=False, callback_handler=None)

    first = agent("Reply ALPHA. Do not call any tool.")
    assert first.metrics.latest_agent_invocation.usage.get("cacheWriteInputTokens", 0) > 0, (
        "first turn should have written the tool block"
    )

    second = agent("Reply BETA. Do not call any tool.")
    assert second.metrics.latest_agent_invocation.usage.get("cacheReadInputTokens", 0) > 0, (
        "second turn rewrote the tool block instead of reading it"
    )


def test_anthropic_tools_web_search_alongside_function_tools(tools):
    """A server-side web search runs next to the agent's function tools and its citations round-trip."""
    model = AnthropicModel(
        client_args={"api_key": os.getenv("ANTHROPIC_API_KEY")},
        model_id=MODEL_ID,
        max_tokens=1024,
        # "direct" so citations are attached; the dynamic-filtering default runs the search inside code execution
        anthropic_tools=[
            {"type": "web_search_20260318", "name": "web_search", "max_uses": 2, "allowed_callers": ["direct"]}
        ],
    )
    agent = Agent(model=model, tools=tools, load_tools_from_directory=False, callback_handler=None)

    first = agent("Call tool_weather, then use web_search to find the current Python release. Answer in one sentence.")
    assert first.stop_reason == "end_turn"
    assert any(
        "toolUse" in block and block["toolUse"]["name"] == "tool_weather"
        for message in agent.messages
        for block in message["content"]
    ), "function tool was dropped from the request"
    citations = [
        citation
        for block in first.message["content"]
        if "citationsContent" in block
        for citation in block["citationsContent"]["citations"]
    ]
    assert citations and citations[0]["location"]["web"]["url"].startswith("http")

    second = agent("Reply DONE.")
    assert "DONE" in str(second)


class TestCountTokens:
    @pytest.fixture
    def model(self):
        return AnthropicModel(
            model_id=MODEL_ID,
            max_tokens=1024,
            use_native_token_count=True,
            client_args={"api_key": os.environ["ANTHROPIC_API_KEY"]},
        )

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
