import os
import uuid

import pydantic
import pytest
from google import genai

import strands
from strands import Agent
from strands.models.gemini import GeminiModel
from strands.models.model import CacheConfig
from tests_integ.models import providers

# these tests only run if we have the gemini api key
pytestmark = providers.gemini.mark


@pytest.fixture
def model():
    return GeminiModel(
        client_args={"api_key": os.getenv("GOOGLE_API_KEY")},
        model_id="gemini-2.5-flash",
        params={"temperature": 0.15},  # Lower temperature for consistent test behavior
    )


@pytest.fixture
def gemini_tool_model():
    return GeminiModel(
        client_args={"api_key": os.getenv("GOOGLE_API_KEY")},
        model_id="gemini-2.5-flash",
        params={"temperature": 0.15},  # Lower temperature for consistent test behavior
        gemini_tools=[genai.types.Tool(code_execution=genai.types.ToolCodeExecution())],
    )


@pytest.fixture
def tools():
    @strands.tool
    def tool_time(city: str) -> str:
        return "12:00"

    @strands.tool
    def tool_weather(city: str) -> str:
        return "sunny"

    return [tool_time, tool_weather]


@pytest.fixture
def system_prompt():
    return "You are a helpful AI assistant."


@pytest.fixture
def assistant_agent(model, system_prompt):
    return Agent(model=model, system_prompt=system_prompt)


@pytest.fixture
def tool_agent(model, tools, system_prompt):
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


@pytest.fixture(scope="module")
def test_image_path(request):
    return request.config.rootpath / "tests_integ" / "test_image.png"


def test_agent_invoke(tool_agent):
    result = tool_agent("What is the current time and weather in New York?")
    text = result.message["content"][0]["text"].lower()

    assert all(string in text for string in ["12:00", "sunny"])


@pytest.mark.asyncio
async def test_agent_invoke_async(tool_agent):
    result = await tool_agent.invoke_async("What is the current time and weather in New York?")
    text = result.message["content"][0]["text"].lower()

    assert all(string in text for string in ["12:00", "sunny"])


@pytest.mark.asyncio
async def test_agent_stream_async(tool_agent):
    stream = tool_agent.stream_async("What is the current time and weather in New York?")
    async for event in stream:
        _ = event

    result = event["result"]
    text = result.message["content"][0]["text"].lower()

    assert all(string in text for string in ["12:00", "sunny"])


def test_agent_invoke_multiturn(assistant_agent):
    assistant_agent("What color is the sky?")
    assistant_agent("What color is lava?")
    result = assistant_agent("What was the answer to my first question?")
    text = result.message["content"][0]["text"].lower()

    assert "blue" in text


def test_agent_invoke_image_input(assistant_agent, yellow_img):
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
    result = assistant_agent(content)
    text = result.message["content"][0]["text"].lower()

    assert "yellow" in text


def test_agent_invoke_document_input(assistant_agent, letter_pdf):
    content = [
        {"text": "summarize this document"},
        {"document": {"format": "pdf", "source": {"bytes": letter_pdf}}},
    ]
    result = assistant_agent(content)
    text = result.message["content"][0]["text"].lower()

    assert "shareholder" in text


def test_agent_structured_output(assistant_agent, weather):
    tru_weather = assistant_agent.structured_output(type(weather), "The time is 12:00 and the weather is sunny")
    exp_weather = weather
    assert tru_weather == exp_weather


@pytest.mark.asyncio
async def test_agent_structured_output_async(assistant_agent, weather):
    tru_weather = await assistant_agent.structured_output_async(
        type(weather), "The time is 12:00 and the weather is sunny"
    )
    exp_weather = weather
    assert tru_weather == exp_weather


def test_agent_structured_output_image_input(assistant_agent, yellow_img, yellow_color):
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
    tru_color = assistant_agent.structured_output(type(yellow_color), content)
    exp_color = yellow_color
    assert tru_color == exp_color


def test_agent_with_gemini_code_execution_tool(gemini_tool_model):
    system_prompt = "Generate and run code for all calculations"
    agent = Agent(model=gemini_tool_model, system_prompt=system_prompt)
    # sample prompt taken from https://ai.google.dev/gemini-api/docs/code-execution
    result_turn1 = agent(
        "What is the sum of the first 50 prime numbers? Generate and run code for the calculation, "
        "and make sure you get all 50."
    )

    # NOTE: We don't verify tool history because built-in tools are currently represented in message history
    assert "5117" in str(result_turn1)

    result_turn2 = agent("Summarize that into a single number")
    assert "5117" in str(result_turn2)


@pytest.fixture
def tool_specs():
    return [
        {
            "name": "tool_time",
            "description": "Get the current time for a city",
            "inputSchema": {"json": {"type": "object", "properties": {"city": {"type": "string"}}}},
        },
        {
            "name": "tool_weather",
            "description": "Get the current weather for a city",
            "inputSchema": {"json": {"type": "object", "properties": {"city": {"type": "string"}}}},
        },
    ]


@pytest.mark.asyncio
async def test_model_stream_tool_choice_any_forces_a_tool_use(model, tool_specs, alist):
    messages = [{"role": "user", "content": [{"text": "Hello there!"}]}]

    events = await alist(model.stream(messages, tool_specs=tool_specs, tool_choice={"any": {}}))

    tru_stop_reason = next(event["messageStop"]["stopReason"] for event in events if "messageStop" in event)
    exp_stop_reason = "tool_use"
    assert tru_stop_reason == exp_stop_reason


@pytest.mark.asyncio
async def test_model_stream_tool_choice_tool_forces_the_named_tool(model, tool_specs, alist):
    messages = [{"role": "user", "content": [{"text": "What is the weather in New York?"}]}]

    events = await alist(
        model.stream(messages, tool_specs=tool_specs, tool_choice={"tool": {"name": "tool_time"}}),
    )

    # ANY mode may emit more than one call, so only the narrowing to tool_time is guaranteed.
    tru_tool_names = {
        event["contentBlockStart"]["start"]["toolUse"]["name"]
        for event in events
        if "contentBlockStart" in event and "toolUse" in event["contentBlockStart"]["start"]
    }
    exp_tool_names = {"tool_time"}
    assert tru_tool_names == exp_tool_names


def test_agent_with_reasoning_content(model, assistant_agent):
    """Test that reasoning content is captured in message history."""

    model.update_config(
        params={
            "thinking_config": {
                "thinking_budget": 1024,
                "include_thoughts": True,
            },
        },
    )

    result = assistant_agent("Think about what 2+2 is")
    assert "reasoningContent" in result.message["content"][0]
    assert result.message["content"][0]["reasoningContent"]["reasoningText"]["text"]


def test_agent_usage_tokens_hold_total_invariant(tool_agent):
    result = tool_agent("What is the current time and weather in New York?")

    usage = result.metrics.accumulated_usage
    assert usage["inputTokens"] > 0
    assert usage["outputTokens"] > 0
    assert usage["totalTokens"] == usage["inputTokens"] + usage["outputTokens"]


class TestCountTokens:
    @pytest.fixture
    def model(self):
        return GeminiModel(
            model_id="gemini-3.1-flash-lite",
            client_args={"api_key": os.environ["GOOGLE_API_KEY"]},
            use_native_token_count=True,
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


# A system prompt large enough to clear Gemini's minimum cacheable-token threshold for explicit
# CachedContent; a shorter prefix is declined and silently falls back to implicit caching.
_CACHEABLE_INTRO = "You are a meticulous assistant. Follow these standing guidelines on every turn."
_CACHEABLE_GUIDELINES = "\n".join(
    f"Guideline {index}: be accurate, state any assumptions you make, and keep your answers concise."
    for index in range(600)
)
_CACHEABLE_SYSTEM_PROMPT = f"{_CACHEABLE_INTRO}\n{_CACHEABLE_GUIDELINES}"


def _stream_usage(events):
    return next(event["metadata"]["usage"] for event in events if "metadata" in event)


class TestPromptCaching:
    @pytest.fixture
    def caching_messages(self):
        return [{"role": "user", "content": [{"text": "In one sentence, what do your guidelines ask of you?"}]}]

    def _model(self, cache_config):
        return GeminiModel(
            client_args={"api_key": os.getenv("GOOGLE_API_KEY")},
            model_id="gemini-2.5-flash",
            params={"temperature": 0},
            cache_config=cache_config,
        )

    @pytest.mark.asyncio
    async def test_managed_cache_created_once_and_reused_across_models(self, caching_messages, alist):
        # A unique cache_key makes this run own its resource, so reuse is proven, not inherited.
        cache_config = CacheConfig(ttl="5m", cache_key=f"strands-integ-{uuid.uuid4()}")

        creator = self._model(cache_config)
        creator_events = await alist(creator.stream(caching_messages, system_prompt=_CACHEABLE_SYSTEM_PROMPT))
        assert _stream_usage(creator_events).get("cacheReadInputTokens", 0) > 0

        # A fresh model instance with the identical prefix reuses the resource created above.
        reuser = self._model(cache_config)
        reuser_events = await alist(reuser.stream(caching_messages, system_prompt=_CACHEABLE_SYSTEM_PROMPT))
        assert _stream_usage(reuser_events).get("cacheReadInputTokens", 0) > 0

        # Identity is content-derived, never session-derived, so the two models share one resource.
        client = genai.Client(api_key=os.getenv("GOOGLE_API_KEY"))
        display_name = cache_config.cache_key
        matching = [cached async for cached in await client.aio.caches.list() if cached.display_name == display_name]
        assert len(matching) == 1
