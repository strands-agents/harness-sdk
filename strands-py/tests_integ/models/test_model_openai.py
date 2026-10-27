import os
import tempfile
import time
from urllib.parse import urlparse

import openai as openai_sdk
import pydantic
import pytest

import strands
from strands import Agent, tool
from strands.models.openai import OpenAIModel
from strands.types.exceptions import ContextWindowOverflowException
from tests_integ.models import providers
from tests_integ.models.providers import _openai_responses_available

if _openai_responses_available:
    from strands.models.openai_responses import OpenAIResponsesModel

# these tests only run if we have the openai api key
pytestmark = providers.openai.mark


def _model_params():
    params = [(OpenAIModel, "gpt-4o")]
    if _openai_responses_available:
        params.append((OpenAIResponsesModel, "gpt-4o"))
    return params


@pytest.fixture(params=_model_params())
def model(request):
    model_class, model_id = request.param
    return model_class(
        model_id=model_id,
        client_args={
            "api_key": os.getenv("OPENAI_API_KEY"),
        },
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
def agent(model, tools):
    return Agent(model=model, tools=tools)


@pytest.fixture
def weather():
    class Weather(pydantic.BaseModel):
        """Extract time and weather values."""

        time: str = pydantic.Field(description="The time value only, e.g. '14:30' not 'The time is 14:30'")
        weather: str = pydantic.Field(description="The weather condition only, e.g. 'rainy' not 'the weather is rainy'")

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
def openai_vector_store():
    """Create a vector store with a test file for file_search tests."""
    client = openai_sdk.OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt") as f:
        f.write("The secret code is ALPHA-7742.")
        f.flush()
        file_obj = client.files.create(file=open(f.name, "rb"), purpose="assistants")

    vector_store = client.vector_stores.create(name="test-builtin-tools")
    try:
        client.vector_stores.files.create(vector_store_id=vector_store.id, file_id=file_obj.id)

        for _ in range(30):
            if client.vector_stores.retrieve(vector_store.id).file_counts.completed > 0:
                break
            time.sleep(1)

        yield vector_store.id
    finally:
        client.vector_stores.delete(vector_store.id)
        client.files.delete(file_obj.id)


@pytest.fixture(scope="module")
def test_image_path(request):
    return request.config.rootpath / "tests_integ" / "test_image.png"


def test_agent_invoke(agent, model):
    result = agent("What is the time and weather in New York?")
    text = result.message["content"][0]["text"].lower()

    assert all(string in text for string in ["12:00", "sunny"])


@pytest.mark.asyncio
async def test_agent_invoke_async(agent, model):
    result = await agent.invoke_async("What is the time and weather in New York?")
    text = result.message["content"][0]["text"].lower()

    assert all(string in text for string in ["12:00", "sunny"])


def test_agent_invoke_non_streaming_with_tools(tools):
    """Integration test for non-streaming (stream=False) chat completions that invoke tools.

    Verifies that when streaming is disabled, the OpenAI provider converts the completion
    into Strands stream events and that tool calls still execute end-to-end.
    """
    model = OpenAIModel(
        model_id="gpt-4o",
        client_args={"api_key": os.getenv("OPENAI_API_KEY")},
        stream=False,
    )
    agent = Agent(model=model, tools=tools)

    result = agent("What is the time and weather in New York?")
    text = result.message["content"][0]["text"].lower()

    assert all(string in text for string in ["12:00", "sunny"])


@pytest.mark.asyncio
async def test_agent_stream_async(agent, model):
    stream = agent.stream_async("What is the time and weather in New York?")
    async for event in stream:
        _ = event

    result = event["result"]
    text = result.message["content"][0]["text"].lower()

    assert all(string in text for string in ["12:00", "sunny"])


def test_agent_structured_output(agent, weather):
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


def test_tool_returning_images(model, yellow_img):
    @tool
    def tool_with_image_return():
        return {
            "status": "success",
            "content": [
                {
                    "image": {
                        "format": "png",
                        "source": {"bytes": yellow_img},
                    }
                },
            ],
        }

    agent = Agent(model, tools=[tool_with_image_return])
    # NOTE - this currently fails with: "Invalid 'messages[3]'. Image URLs are only allowed for messages with role
    # 'user', but this message with role 'tool' contains an image URL."
    # See https://github.com/strands-agents/harness-sdk/issues/320 for additional details
    agent("Run the the tool and analyze the image")


def _mini_model_params():
    params = [(OpenAIModel, "gpt-4o-mini-2024-07-18")]
    if _openai_responses_available:
        params.append((OpenAIResponsesModel, "gpt-4o-mini-2024-07-18"))
    return params


@pytest.mark.parametrize("model_class,model_id", _mini_model_params())
def test_context_window_overflow_integration(model_class, model_id, quiet_strands_logging):
    """Integration test for context window overflow with OpenAI.

    This test verifies that when a request exceeds the model's context window,
    the OpenAI model properly raises a ContextWindowOverflowException.
    """
    # Use gpt-4o-mini which has a smaller context window to make this test more reliable
    mini_model = model_class(
        model_id=model_id,
        client_args={
            "api_key": os.getenv("OPENAI_API_KEY"),
        },
    )

    agent = Agent(model=mini_model)

    # Create a very long text that should exceed context window
    # This text is designed to be long enough to exceed context but not hit token rate limits
    long_text = (
        "This text is longer than context window, but short enough to not get caught in token rate limit. " * 6800
    )

    # This should raise ContextWindowOverflowException which gets handled by conversation manager
    # The agent should attempt to reduce context and retry
    with pytest.raises(ContextWindowOverflowException):
        agent(long_text)


def test_content_blocks_handling(model):
    """Test that content blocks are handled properly without failures."""
    content = [{"text": "What is 2+2?"}, {"text": "Please be brief."}]

    agent = Agent(model=model, load_tools_from_directory=False)
    result = agent(content)

    assert "4" in result.message["content"][0]["text"]


def test_system_prompt_content_integration(model):
    """Integration test for system_prompt_content parameter."""
    from strands.types.content import SystemContentBlock

    system_prompt_content: list[SystemContentBlock] = [
        {"text": "You are a helpful assistant that always responds with 'SYSTEM_TEST_RESPONSE'."}
    ]

    agent = Agent(model=model, system_prompt=system_prompt_content)
    result = agent("Hello")

    # The response should contain our specific system prompt instruction
    assert "SYSTEM_TEST_RESPONSE" in result.message["content"][0]["text"]


def test_system_prompt_backward_compatibility_integration(model):
    """Integration test for backward compatibility with system_prompt parameter."""
    system_prompt = "You are a helpful assistant that always responds with 'BACKWARD_COMPAT_TEST'."

    agent = Agent(model=model, system_prompt=system_prompt)
    result = agent("Hello")

    # The response should contain our specific system prompt instruction
    assert "BACKWARD_COMPAT_TEST" in result.message["content"][0]["text"]


@pytest.mark.skipif(not _openai_responses_available, reason="OpenAI Responses API not available")
def test_responses_server_side_conversation():
    """Integration test for server-side conversation state management.

    Verifies that when stateful=True, the model tracks conversation across turns
    via previous_response_id and the agent clears messages between invocations.
    """
    model = OpenAIResponsesModel(
        model_id="gpt-4o-mini",
        stateful=True,
        client_args={"api_key": os.getenv("OPENAI_API_KEY")},
    )
    agent = Agent(model=model, system_prompt="Reply in one short sentence.")

    agent("My name is Alice.")
    assert len(agent.messages) == 0

    result = agent("What is my name?")
    assert "alice" in result.message["content"][0]["text"].lower()


@pytest.mark.skipif(not _openai_responses_available, reason="OpenAI Responses API not available")
def test_responses_builtin_tool_web_search():
    """Test that web_search produces text with citation content."""
    model = OpenAIResponsesModel(
        model_id="gpt-4o",
        params={"tools": [{"type": "web_search"}]},
        client_args={"api_key": os.getenv("OPENAI_API_KEY")},
    )
    agent = Agent(model=model, system_prompt="Answer concisely.", callback_handler=None)

    result = agent("Search https://strandsagents.com/ and tell me what Strands Agents is.")
    content = result.message["content"][0]

    assert "citationsContent" in content
    citations = content["citationsContent"]["citations"]

    def _is_strands_host(url: str) -> bool:
        host = urlparse(url).hostname or ""
        return host == "strandsagents.com" or host.endswith(".strandsagents.com")

    assert any(_is_strands_host(c["location"]["web"]["url"]) for c in citations)


@pytest.mark.skipif(not _openai_responses_available, reason="OpenAI Responses API not available")
def test_responses_builtin_tool_file_search(openai_vector_store):
    """Test that file_search produces text output from uploaded files."""
    model = OpenAIResponsesModel(
        model_id="gpt-4o",
        params={"tools": [{"type": "file_search", "vector_store_ids": [openai_vector_store]}]},
        client_args={"api_key": os.getenv("OPENAI_API_KEY")},
    )
    agent = Agent(model=model, system_prompt="Answer based on the files.", callback_handler=None)

    result = agent("What is the secret code?")
    text = result.message["content"][0]["text"]
    assert "ALPHA-7742" in text


@pytest.mark.skipif(not _openai_responses_available, reason="OpenAI Responses API not available")
def test_responses_builtin_tool_code_interpreter():
    """Test that code_interpreter produces correct results via text output."""
    model = OpenAIResponsesModel(
        model_id="gpt-4o",
        params={"tools": [{"type": "code_interpreter", "container": {"type": "auto"}}]},
        client_args={"api_key": os.getenv("OPENAI_API_KEY")},
    )
    agent = Agent(model=model, system_prompt="Answer concisely.", callback_handler=None)

    # SHA-256 of "strands" requires actual computation
    result = agent("Compute the SHA-256 hash of the string 'strands'. Return only the hex digest.")
    text = result.message["content"][0]["text"]
    assert "11e0e34bd35e12185cfacd5e5a256ab4292bfa3616d8d5b74e20eca36feed228" in text


@pytest.mark.skipif(not _openai_responses_available, reason="OpenAI Responses API not available")
def test_responses_builtin_tool_shell():
    """Test that the shell built-in tool executes commands in a hosted container."""
    model = OpenAIResponsesModel(
        model_id="gpt-5.4-mini",
        params={"tools": [{"type": "shell", "environment": {"type": "container_auto"}}]},
        client_args={"api_key": os.getenv("OPENAI_API_KEY")},
    )
    agent = Agent(model=model, system_prompt="Answer concisely.", callback_handler=None)

    result = agent("Use the shell to compute the md5sum of the string 'strands-test'. Return only the hash.")
    text = result.message["content"][0]["text"]
    assert "d82f373f079b00a1db7ef1eec7f15c68" in text


class TestOpenAIResponsesCountTokens:
    @pytest.fixture
    def model(self):
        return OpenAIResponsesModel(
            model_id="gpt-4o",
            client_args={"api_key": os.environ["OPENAI_API_KEY"]},
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
