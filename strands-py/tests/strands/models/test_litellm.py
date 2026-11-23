import copy
import json
import unittest.mock
import warnings
from types import SimpleNamespace
from unittest.mock import call

import httpx
import litellm
import pydantic
import pytest
from litellm import Usage
from litellm.exceptions import ContextWindowExceededError

import strands
from strands.agent import AgentMetadata
from strands.models import CacheConfig, ModelCapabilities, ModelInfo
from strands.models.litellm import LiteLLMModel
from strands.types.exceptions import ContextWindowOverflowException


@pytest.fixture
def litellm_acompletion():
    with unittest.mock.patch.object(strands.models.litellm.litellm, "acompletion") as mock_acompletion:
        yield mock_acompletion


@pytest.fixture
def api_key():
    return "a1"


@pytest.fixture
def model_id():
    return "m1"


@pytest.fixture
def model(litellm_acompletion, api_key, model_id):
    _ = litellm_acompletion

    return LiteLLMModel(client_args={"api_key": api_key}, model_id=model_id)


@pytest.fixture
def messages():
    return [{"role": "user", "content": [{"text": "test"}]}]


@pytest.fixture
def system_prompt():
    return "s1"


@pytest.fixture
def test_output_model_cls():
    class TestOutputModel(pydantic.BaseModel):
        name: str
        age: int

    return TestOutputModel


def test_update_config(model, model_id):
    model.update_config(model_id=model_id)

    tru_model_id = model.get_config().get("model_id")
    exp_model_id = model_id

    assert tru_model_id == exp_model_id


def test_cache_key_maps_to_prompt_cache_key(litellm_acompletion, model_id, messages):
    _ = litellm_acompletion
    model = LiteLLMModel(model_id=model_id, cache_config=CacheConfig(cache_key="tenant-42"))

    assert model.format_request(messages)["prompt_cache_key"] == "tenant-42"


def test_cache_key_derived_from_agent_metadata_session(litellm_acompletion, model_id, messages):
    _ = litellm_acompletion
    model = LiteLLMModel(model_id=model_id, cache_config=CacheConfig())

    request = model.format_request(messages, agent_metadata=AgentMetadata(session_id="s1"))

    assert request["prompt_cache_key"] == "strands-s1"


@pytest.mark.asyncio
async def test_stream_derives_prompt_cache_key_from_agent_session(litellm_acompletion, model_id, agenerator, alist):
    """stream threads agent_metadata so the outbound request carries the derived routing key."""
    model = LiteLLMModel(model_id=model_id, cache_config=CacheConfig())
    mock_delta = unittest.mock.Mock(content=None, tool_calls=None, reasoning_content=None)
    mock_event_1 = unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason="stop", delta=mock_delta)])
    mock_event_2 = unittest.mock.Mock(usage=None)
    litellm_acompletion.side_effect = unittest.mock.AsyncMock(
        return_value=agenerator([mock_event_1, mock_event_2]),
    )

    await alist(model.stream([{"role": "user", "content": []}], agent_metadata=AgentMetadata(session_id="s1")))

    assert litellm_acompletion.call_args.kwargs["prompt_cache_key"] == "strands-s1"


@pytest.fixture
def litellm_supported_params():
    """Pin what LiteLLM reports as supported, independent of the installed LiteLLM version."""
    with (
        unittest.mock.patch.object(
            strands.models.litellm.litellm, "OPENAI_CHAT_COMPLETION_PARAMS", ["prompt_cache_key"]
        ),
        unittest.mock.patch.object(strands.models.litellm.litellm, "get_supported_openai_params") as mock_supported,
    ):
        mock_supported.return_value = ["temperature"]
        yield mock_supported


def test_format_request_drops_session_cache_key_litellm_rejects(litellm_supported_params, messages):
    model = LiteLLMModel(client_args={"custom_llm_provider": "bedrock"}, model_id="m1", cache_config=CacheConfig())

    with warnings.catch_warnings():
        warnings.simplefilter("error")
        request = model.format_request(messages, agent_metadata=AgentMetadata(session_id="s1"))

    assert "prompt_cache_key" not in request
    litellm_supported_params.assert_called_once_with(model="m1", custom_llm_provider="bedrock")


def test_format_request_drops_configured_cache_key_litellm_rejects_with_warning(litellm_supported_params, messages):
    _ = litellm_supported_params
    model = LiteLLMModel(model_id="bedrock/claude", cache_config=CacheConfig(cache_key="tenant-42"))

    with pytest.warns(UserWarning, match="cache_config.cache_key has no effect on bedrock/claude"):
        request = model.format_request(messages)

    assert "prompt_cache_key" not in request


@pytest.mark.parametrize("supported_params", [["prompt_cache_key"], None])
def test_format_request_keeps_cache_key_litellm_accepts_or_does_not_map(
    litellm_supported_params, supported_params, messages
):
    litellm_supported_params.return_value = supported_params
    model = LiteLLMModel(model_id="openai/gpt-4o", cache_config=CacheConfig(cache_key="tenant-42"))

    assert model.format_request(messages)["prompt_cache_key"] == "tenant-42"


def test_format_request_keeps_cache_key_litellm_version_does_not_validate(litellm_supported_params, messages):
    _ = litellm_supported_params
    model = LiteLLMModel(model_id="openai/gpt-4o", cache_config=CacheConfig(cache_key="tenant-42"))

    with (
        unittest.mock.patch.object(strands.models.litellm.litellm, "OPENAI_CHAT_COMPLETION_PARAMS", []),
        unittest.mock.patch.object(
            strands.models.litellm.litellm.constants, "DEFAULT_CHAT_COMPLETION_PARAM_VALUES", {}
        ),
    ):
        request = model.format_request(messages)

    assert request["prompt_cache_key"] == "tenant-42"


def test_format_request_drops_cache_key_on_litellm_that_validates_it_before_listing_it(
    litellm_supported_params, messages
):
    _ = litellm_supported_params
    model = LiteLLMModel(model_id="gemini/gemini-3.5-flash", cache_config=CacheConfig())

    with (
        unittest.mock.patch.object(strands.models.litellm.litellm, "OPENAI_CHAT_COMPLETION_PARAMS", []),
        unittest.mock.patch.object(
            strands.models.litellm.litellm.constants,
            "DEFAULT_CHAT_COMPLETION_PARAM_VALUES",
            {"prompt_cache_key": None},
        ),
    ):
        request = model.format_request(messages, agent_metadata=AgentMetadata(session_id="s1"))

    assert "prompt_cache_key" not in request


def test_format_request_keeps_prompt_cache_key_set_in_params(litellm_supported_params, messages):
    _ = litellm_supported_params
    model = LiteLLMModel(model_id="bedrock/claude", params={"prompt_cache_key": "explicit"}, cache_config=CacheConfig())

    assert model.format_request(messages)["prompt_cache_key"] == "explicit"


def test_format_request_keeps_cache_key_allowed_in_client_args(litellm_supported_params, messages):
    _ = litellm_supported_params
    model = LiteLLMModel(
        client_args={"allowed_openai_params": ["prompt_cache_key"]},
        model_id="mistral/mistral-large-latest",
        cache_config=CacheConfig(cache_key="tenant-42"),
    )

    assert model.format_request(messages)["prompt_cache_key"] == "tenant-42"


@pytest.mark.parametrize("model_id", ["openai/gpt-4o", "azure/gpt-4o", "litellm_proxy/claude"])
def test_format_request_keeps_cache_key_for_openai_family(litellm_supported_params, model_id, messages):
    litellm_supported_params.return_value = ["prompt_cache_key"]
    model = LiteLLMModel(model_id=model_id, cache_config=CacheConfig(cache_key="tenant-42"))

    assert model.format_request(messages)["prompt_cache_key"] == "tenant-42"


@pytest.mark.parametrize("model_id", ["openai/gpt-4o", "azure/gpt-4o", "litellm_proxy/claude"])
def test_format_request_drops_cache_key_for_openai_family_litellm_does_not_list(
    litellm_supported_params, model_id, messages
):
    model = LiteLLMModel(model_id=model_id, cache_config=CacheConfig(cache_key="tenant-42"))

    with pytest.warns(UserWarning, match="cache_key has no effect"):
        request = model.format_request(messages)

    assert "prompt_cache_key" not in request


@pytest.mark.skipif(
    "prompt_cache_key" not in litellm.OPENAI_CHAT_COMPLETION_PARAMS,
    reason="this LiteLLM version forwards prompt_cache_key without validating it",
)
@pytest.mark.asyncio
async def test_stream_session_cache_key_passes_litellm_validation(messages, alist):
    """Runs LiteLLM's own parameter validation: only the HTTP transport is stubbed."""
    converse_response = {
        "output": {"message": {"role": "assistant", "content": [{"text": "ok"}]}},
        "stopReason": "end_turn",
        "usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2},
    }
    sent_requests = []

    async def send(_client, request, **_kwargs):
        sent_requests.append(request)
        return httpx.Response(200, json=converse_response, request=request)

    model = LiteLLMModel(
        client_args={"aws_access_key_id": "a1", "aws_secret_access_key": "s1", "aws_region_name": "us-west-2"},
        model_id="bedrock/converse/us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        stream=False,
        cache_config=CacheConfig(),
    )

    with unittest.mock.patch.object(httpx.AsyncClient, "send", send):
        events = await alist(model.stream(messages, agent_metadata=AgentMetadata(session_id="s1")))

    assert len(sent_requests) == 1
    assert b"prompt_cache_key" not in sent_requests[0].content
    assert {"contentBlockDelta": {"delta": {"text": "ok"}}} in events


@pytest.mark.parametrize(
    "client_args, model_id, expected_model_id",
    [
        ({"use_litellm_proxy": True}, "openai/gpt-4", "litellm_proxy/openai/gpt-4"),
        ({"use_litellm_proxy": False}, "openai/gpt-4", "openai/gpt-4"),
        ({"use_litellm_proxy": None}, "openai/gpt-4", "openai/gpt-4"),
        ({}, "openai/gpt-4", "openai/gpt-4"),
        (None, "openai/gpt-4", "openai/gpt-4"),
        ({"use_litellm_proxy": True}, "litellm_proxy/openai/gpt-4", "litellm_proxy/openai/gpt-4"),
        ({"use_litellm_proxy": False}, "litellm_proxy/openai/gpt-4", "litellm_proxy/openai/gpt-4"),
    ],
)
def test__init__use_litellm_proxy_prefix(client_args, model_id, expected_model_id):
    """Test litellm_proxy prefix behavior for various configurations."""
    model = LiteLLMModel(client_args=client_args, model_id=model_id)
    assert model.get_config()["model_id"] == expected_model_id


@pytest.mark.parametrize(
    "client_args, initial_model_id, new_model_id, expected_model_id",
    [
        ({"use_litellm_proxy": True}, "openai/gpt-4", "anthropic/claude-3", "litellm_proxy/anthropic/claude-3"),
        ({"use_litellm_proxy": False}, "openai/gpt-4", "anthropic/claude-3", "anthropic/claude-3"),
        (None, "openai/gpt-4", "anthropic/claude-3", "anthropic/claude-3"),
    ],
)
def test_update_config_proxy_prefix(client_args, initial_model_id, new_model_id, expected_model_id):
    """Test that update_config applies proxy prefix correctly."""
    model = LiteLLMModel(client_args=client_args, model_id=initial_model_id)
    model.update_config(model_id=new_model_id)
    assert model.get_config()["model_id"] == expected_model_id


@pytest.mark.parametrize(
    "content, exp_result",
    [
        # Case 1: Thinking
        (
            {
                "reasoningContent": {
                    "reasoningText": {
                        "signature": "reasoning_signature",
                        "text": "reasoning_text",
                    },
                },
            },
            {
                "signature": "reasoning_signature",
                "thinking": "reasoning_text",
                "type": "thinking",
            },
        ),
        # Case 2: Video
        (
            {
                "video": {
                    "source": {"bytes": "base64encodedvideo"},
                },
            },
            {
                "type": "video_url",
                "video_url": {
                    "detail": "auto",
                    "url": "base64encodedvideo",
                },
            },
        ),
        # Case 3: Text
        (
            {"text": "hello"},
            {"type": "text", "text": "hello"},
        ),
    ],
)
def test_format_request_message_content(content, exp_result):
    tru_result = LiteLLMModel.format_request_message_content(content)
    assert tru_result == exp_result


@pytest.mark.asyncio
async def test_stream(litellm_acompletion, api_key, model_id, model, agenerator, alist):
    mock_delta_1 = unittest.mock.Mock(
        reasoning_content="",
        content=None,
        tool_calls=None,
    )

    mock_delta_2 = unittest.mock.Mock(
        reasoning_content="\nI'm thinking",
        content=None,
        tool_calls=None,
    )
    mock_delta_3 = unittest.mock.Mock(
        reasoning_content=None,
        content="One second",
        tool_calls=None,
    )
    mock_delta_4 = unittest.mock.Mock(
        reasoning_content="\nI'm think",
        content=None,
        tool_calls=None,
    )
    mock_delta_5 = unittest.mock.Mock(
        reasoning_content="ing again",
        content=None,
        tool_calls=None,
    )

    mock_tool_call_1_part_1 = unittest.mock.Mock(index=0)
    mock_tool_call_2_part_1 = unittest.mock.Mock(index=1)
    mock_delta_6 = unittest.mock.Mock(
        content="I'll calculate", tool_calls=[mock_tool_call_1_part_1, mock_tool_call_2_part_1], reasoning_content=None
    )

    mock_tool_call_1_part_2 = unittest.mock.Mock(index=0)
    mock_tool_call_2_part_2 = unittest.mock.Mock(index=1)
    mock_delta_7 = unittest.mock.Mock(
        content="that for you", tool_calls=[mock_tool_call_1_part_2, mock_tool_call_2_part_2], reasoning_content=None
    )

    mock_delta_8 = unittest.mock.Mock(content="", tool_calls=None, reasoning_content=None)

    mock_event_1 = unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason=None, delta=mock_delta_1)])
    mock_event_2 = unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason=None, delta=mock_delta_2)])
    mock_event_3 = unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason=None, delta=mock_delta_3)])
    mock_event_4 = unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason=None, delta=mock_delta_4)])
    mock_event_5 = unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason=None, delta=mock_delta_5)])
    mock_event_6 = unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason=None, delta=mock_delta_6)])
    mock_event_7 = unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason=None, delta=mock_delta_7)])
    mock_event_8 = unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason="tool_calls", delta=mock_delta_8)])
    mock_event_9 = unittest.mock.Mock()
    mock_event_9.usage = Usage(
        prompt_tokens=100,
        completion_tokens=50,
        total_tokens=150,
        cache_read_input_tokens=10,
        cache_creation_input_tokens=10,
    )

    litellm_acompletion.side_effect = unittest.mock.AsyncMock(
        return_value=agenerator(
            [
                mock_event_1,
                mock_event_2,
                mock_event_3,
                mock_event_4,
                mock_event_5,
                mock_event_6,
                mock_event_7,
                mock_event_8,
                mock_event_9,
            ]
        )
    )

    messages = [{"role": "user", "content": [{"type": "text", "text": "calculate 2+2"}]}]
    response = model.stream(messages)
    tru_events = await alist(response)
    exp_events = [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockStart": {"start": {}}},
        {"contentBlockDelta": {"delta": {"reasoningContent": {"text": "\nI'm thinking"}}}},
        {"contentBlockStop": {}},
        {"contentBlockStart": {"start": {}}},
        {"contentBlockDelta": {"delta": {"text": "One second"}}},
        {"contentBlockStop": {}},
        {"contentBlockStart": {"start": {}}},
        {"contentBlockDelta": {"delta": {"reasoningContent": {"text": "\nI'm think"}}}},
        {"contentBlockDelta": {"delta": {"reasoningContent": {"text": "ing again"}}}},
        {"contentBlockStop": {}},
        {"contentBlockStart": {"start": {}}},
        {"contentBlockDelta": {"delta": {"text": "I'll calculate"}}},
        {"contentBlockDelta": {"delta": {"text": "that for you"}}},
        {"contentBlockStop": {}},
        {
            "contentBlockStart": {
                "start": {
                    "toolUse": {"name": mock_tool_call_1_part_1.function.name, "toolUseId": mock_tool_call_1_part_1.id}
                }
            }
        },
        {"contentBlockDelta": {"delta": {"toolUse": {"input": mock_tool_call_1_part_1.function.arguments}}}},
        {"contentBlockDelta": {"delta": {"toolUse": {"input": mock_tool_call_1_part_2.function.arguments}}}},
        {"contentBlockStop": {}},
        {
            "contentBlockStart": {
                "start": {
                    "toolUse": {"name": mock_tool_call_2_part_1.function.name, "toolUseId": mock_tool_call_2_part_1.id}
                }
            }
        },
        {"contentBlockDelta": {"delta": {"toolUse": {"input": mock_tool_call_2_part_1.function.arguments}}}},
        {"contentBlockDelta": {"delta": {"toolUse": {"input": mock_tool_call_2_part_2.function.arguments}}}},
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "tool_use"}},
        {
            "metadata": {
                "usage": {
                    "cacheReadInputTokens": 10,
                    "cacheWriteInputTokens": 10,
                    "inputTokens": mock_event_9.usage.prompt_tokens,
                    "outputTokens": mock_event_9.usage.completion_tokens,
                    "totalTokens": mock_event_9.usage.total_tokens,
                },
                "metrics": {"latencyMs": 0},
            }
        },
    ]

    assert tru_events == exp_events

    assert litellm_acompletion.call_args_list == [
        call(
            api_key=api_key,
            messages=[{"role": "user", "content": [{"text": "calculate 2+2", "type": "text"}]}],
            model=model_id,
            stream=True,
            stream_options={"include_usage": True},
            tools=[],
        )
    ]


@pytest.mark.asyncio
async def test_stream_empty(litellm_acompletion, api_key, model_id, model, agenerator, alist):
    mock_delta = unittest.mock.Mock(content=None, tool_calls=None, reasoning_content=None)

    mock_event_1 = unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason=None, delta=mock_delta)])
    mock_event_2 = unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason="stop", delta=mock_delta)])
    mock_event_3 = unittest.mock.Mock(usage=None)
    mock_event_4 = unittest.mock.Mock(usage=None)

    litellm_acompletion.side_effect = unittest.mock.AsyncMock(
        return_value=agenerator([mock_event_1, mock_event_2, mock_event_3, mock_event_4])
    )

    messages = [{"role": "user", "content": []}]
    response = model.stream(messages)

    tru_events = await alist(response)
    exp_events = [
        {"messageStart": {"role": "assistant"}},
        {"messageStop": {"stopReason": "end_turn"}},
    ]

    assert len(tru_events) == len(exp_events)
    expected_request = {
        "api_key": api_key,
        "model": model_id,
        "messages": [],
        "stream": True,
        "stream_options": {"include_usage": True},
        "tools": [],
    }
    litellm_acompletion.assert_called_once_with(**expected_request)


@pytest.mark.asyncio
async def test_structured_output(litellm_acompletion, model, test_output_model_cls, alist):
    messages = [{"role": "user", "content": [{"text": "Generate a person"}]}]

    mock_choice = unittest.mock.Mock()
    mock_choice.finish_reason = "tool_calls"
    mock_choice.message.content = '{"name": "John", "age": 30}'
    # PATCH START: mock tool_calls as list with .function.arguments
    tool_call_mock = unittest.mock.Mock()
    tool_call_function_mock = unittest.mock.Mock()
    tool_call_function_mock.arguments = '{"name": "John", "age": 30}'
    tool_call_mock.function = tool_call_function_mock
    mock_choice.message.tool_calls = [tool_call_mock]
    # PATCH END
    mock_response = unittest.mock.Mock()
    mock_response.choices = [mock_choice]

    litellm_acompletion.side_effect = unittest.mock.AsyncMock(return_value=mock_response)

    with unittest.mock.patch.object(strands.models.litellm, "supports_response_schema", return_value=True):
        stream = model.structured_output(test_output_model_cls, messages)
        events = await alist(stream)
        tru_result = events[-1]

    exp_result = {"output": test_output_model_cls(name="John", age=30)}
    assert tru_result == exp_result


@pytest.mark.asyncio
async def test_structured_output_unsupported_model(litellm_acompletion, model, test_output_model_cls, alist):
    messages = [{"role": "user", "content": [{"text": "Generate a person"}]}]

    mock_tool_call = unittest.mock.Mock()
    mock_tool_call.function.arguments = '{"name": "John", "age": 30}'

    mock_choice = unittest.mock.Mock()
    mock_choice.finish_reason = "tool_calls"
    mock_choice.message.tool_calls = [mock_tool_call]
    mock_response = unittest.mock.Mock()
    mock_response.choices = [mock_choice]

    litellm_acompletion.return_value = mock_response

    with unittest.mock.patch.object(strands.models.litellm, "supports_response_schema", return_value=False):
        stream = model.structured_output(test_output_model_cls, messages)
        events = await alist(stream)
        tru_result = events[-1]

    exp_result = {"output": test_output_model_cls(name="John", age=30)}
    assert tru_result == exp_result


def test_config_validation_warns_on_unknown_keys(litellm_acompletion, captured_warnings):
    """Test that unknown config keys emit a warning."""
    LiteLLMModel(client_args={"api_key": "test"}, model_id="test-model", invalid_param="test")

    assert len(captured_warnings) == 1
    assert "Invalid configuration parameters" in str(captured_warnings[0].message)
    assert "invalid_param" in str(captured_warnings[0].message)


def test_update_config_validation_warns_on_unknown_keys(model, captured_warnings):
    """Test that update_config warns on unknown keys."""
    model.update_config(wrong_param="test")

    assert len(captured_warnings) == 1
    assert "Invalid configuration parameters" in str(captured_warnings[0].message)
    assert "wrong_param" in str(captured_warnings[0].message)


def test_tool_choice_supported_no_warning(model, messages, captured_warnings):
    """Test that toolChoice doesn't emit warning for supported providers."""
    tool_choice = {"auto": {}}
    model.format_request(messages, tool_choice=tool_choice)

    assert len(captured_warnings) == 0


def test_tool_choice_none_no_warning(model, messages, captured_warnings):
    """Test that None toolChoice doesn't emit warning."""
    model.format_request(messages, tool_choice=None)

    assert len(captured_warnings) == 0


@pytest.mark.asyncio
async def test_context_window_maps_to_typed_exception(litellm_acompletion, model):
    """Test that a typed ContextWindowExceededError is mapped correctly."""
    litellm_acompletion.side_effect = ContextWindowExceededError(message="test error", model="x", llm_provider="y")

    with pytest.raises(ContextWindowOverflowException):
        async for _ in model.stream([{"role": "user", "content": [{"text": "x"}]}]):
            pass


def test_format_request_messages_with_system_prompt_content():
    """Test format_request_messages with system_prompt_content parameter."""
    messages = [{"role": "user", "content": [{"text": "Hello"}]}]
    system_prompt_content = [{"text": "You are a helpful assistant."}, {"cachePoint": {"type": "default"}}]

    result = LiteLLMModel.format_request_messages(messages, system_prompt_content=system_prompt_content)

    expected = [
        {
            "role": "system",
            "content": [
                {"type": "text", "text": "You are a helpful assistant.", "cache_control": {"type": "ephemeral"}}
            ],
        },
        {"role": "user", "content": [{"text": "Hello", "type": "text"}]},
    ]

    assert result == expected


def test_format_request_messages_backward_compatibility_system_prompt():
    """Test that system_prompt is converted to system_prompt_content when system_prompt_content is None."""
    messages = [{"role": "user", "content": [{"text": "Hello"}]}]
    system_prompt = "You are a helpful assistant."

    result = LiteLLMModel.format_request_messages(messages, system_prompt=system_prompt)

    expected = [
        {"role": "system", "content": [{"type": "text", "text": "You are a helpful assistant."}]},
        {"role": "user", "content": [{"text": "Hello", "type": "text"}]},
    ]

    assert result == expected


def test_format_request_messages_cache_point_support():
    """Test that cache points are properly applied to preceding content blocks."""
    messages = [{"role": "user", "content": [{"text": "Hello"}]}]
    system_prompt_content = [
        {"text": "First instruction."},
        {"text": "Second instruction."},
        {"cachePoint": {"type": "default"}},
        {"text": "Third instruction."},
    ]

    result = LiteLLMModel.format_request_messages(messages, system_prompt_content=system_prompt_content)

    expected = [
        {
            "role": "system",
            "content": [
                {"type": "text", "text": "First instruction."},
                {"type": "text", "text": "Second instruction.", "cache_control": {"type": "ephemeral"}},
                {"type": "text", "text": "Third instruction."},
            ],
        },
        {"role": "user", "content": [{"text": "Hello", "type": "text"}]},
    ]

    assert result == expected


@pytest.mark.asyncio
async def test_stream_non_streaming(litellm_acompletion, api_key, model_id, alist):
    """Test LiteLLM model with streaming disabled (stream=False).

    This test verifies that the LiteLLM model works correctly when streaming is disabled,
    which was the issue reported in GitHub issue #477.
    """

    mock_function = unittest.mock.Mock()
    mock_function.name = "calculator"
    mock_function.arguments = '{"expression": "123981723 + 234982734"}'

    mock_tool_call = unittest.mock.Mock(index=0, function=mock_function, id="tool_call_id_123")

    mock_message = unittest.mock.Mock()
    mock_message.content = "I'll calculate that for you"
    mock_message.reasoning_content = "Let me think about this calculation"
    mock_message.tool_calls = [mock_tool_call]

    mock_choice = unittest.mock.Mock()
    mock_choice.message = mock_message
    mock_choice.finish_reason = "tool_calls"

    mock_response = unittest.mock.Mock()
    mock_response.choices = [mock_choice]

    # Create a more explicit usage mock that doesn't have cache-related attributes
    mock_usage = unittest.mock.Mock()
    mock_usage.prompt_tokens = 10
    mock_usage.completion_tokens = 20
    mock_usage.total_tokens = 30
    mock_usage.prompt_tokens_details = None
    mock_usage.cache_creation_input_tokens = None
    mock_response.usage = mock_usage

    litellm_acompletion.side_effect = unittest.mock.AsyncMock(return_value=mock_response)

    model = LiteLLMModel(
        client_args={"api_key": api_key},
        model_id=model_id,
        params={"stream": False},  # This is the key setting that was causing the #477 isuue
    )

    messages = [{"role": "user", "content": [{"type": "text", "text": "What is 123981723 + 234982734?"}]}]
    response = model.stream(messages)

    tru_events = await alist(response)

    exp_events = [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockStart": {"start": {}}},
        {"contentBlockDelta": {"delta": {"reasoningContent": {"text": "Let me think about this calculation"}}}},
        {"contentBlockStop": {}},
        {"contentBlockStart": {"start": {}}},
        {"contentBlockDelta": {"delta": {"text": "I'll calculate that for you"}}},
        {"contentBlockStop": {}},
        {
            "contentBlockStart": {
                "start": {"toolUse": {"name": "calculator", "toolUseId": mock_message.tool_calls[0].id}}
            }
        },
        {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"expression": "123981723 + 234982734"}'}}}},
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "tool_use"}},
        {
            "metadata": {
                "usage": {
                    "inputTokens": 10,
                    "outputTokens": 20,
                    "totalTokens": 30,
                },
                "metrics": {"latencyMs": 0},
            }
        },
    ]

    assert len(tru_events) == len(exp_events)

    for i, (tru, exp) in enumerate(zip(tru_events, exp_events, strict=False)):
        assert tru == exp, f"Event {i} mismatch: {tru} != {exp}"

    expected_request = {
        "api_key": api_key,
        "model": model_id,
        "messages": [{"role": "user", "content": [{"text": "What is 123981723 + 234982734?", "type": "text"}]}],
        "stream": False,  # Verify that stream=False was passed to litellm
        # stream_options is only sent for streaming requests
        "tools": [],
    }
    litellm_acompletion.assert_called_once_with(**expected_request)


@pytest.mark.asyncio
async def test_stream_path_validation(litellm_acompletion, api_key, model_id, model, agenerator, alist):
    """Test that we're taking the correct streaming path and validate stream parameter."""
    mock_delta = unittest.mock.Mock(content=None, tool_calls=None, reasoning_content=None)
    mock_event_1 = unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason="stop", delta=mock_delta)])
    mock_event_2 = unittest.mock.Mock(usage=None)

    litellm_acompletion.side_effect = unittest.mock.AsyncMock(return_value=agenerator([mock_event_1, mock_event_2]))

    messages = [{"role": "user", "content": []}]
    response = model.stream(messages)

    # Consume the response
    await alist(response)

    # Validate that litellm.acompletion was called with the expected parameters
    call_args = litellm_acompletion.call_args
    assert call_args is not None, "litellm.acompletion should have been called"

    # Check if stream parameter is being set
    called_kwargs = call_args.kwargs

    # Validate we're going down the streaming path (should have stream=True)
    assert called_kwargs.get("stream") is True, f"Expected stream=True, got {called_kwargs.get('stream')}"


def test_format_request_message_content_reasoning():
    """Test formatting reasoning content."""
    content = {"reasoningContent": {"reasoningText": {"signature": "test_sig", "text": "test_thinking"}}}

    result = LiteLLMModel.format_request_message_content(content)
    expected = {"signature": "test_sig", "thinking": "test_thinking", "type": "thinking"}

    assert result == expected


def test_format_request_message_content_video():
    """Test formatting video content."""
    content = {"video": {"source": {"bytes": "base64videodata"}}}

    result = LiteLLMModel.format_request_message_content(content)
    expected = {"type": "video_url", "video_url": {"detail": "auto", "url": "base64videodata"}}

    assert result == expected


def test_apply_proxy_prefix_with_use_litellm_proxy():
    """Test _apply_proxy_prefix when use_litellm_proxy is True."""
    model = LiteLLMModel(client_args={"use_litellm_proxy": True}, model_id="openai/gpt-4")

    assert model.get_config()["model_id"] == "litellm_proxy/openai/gpt-4"


def test_apply_proxy_prefix_already_has_prefix():
    """Test _apply_proxy_prefix when model_id already has prefix."""
    model = LiteLLMModel(client_args={"use_litellm_proxy": True}, model_id="litellm_proxy/openai/gpt-4")

    # Should not add another prefix
    assert model.get_config()["model_id"] == "litellm_proxy/openai/gpt-4"


def test_apply_proxy_prefix_disabled():
    """Test _apply_proxy_prefix when use_litellm_proxy is False."""
    model = LiteLLMModel(client_args={"use_litellm_proxy": False}, model_id="openai/gpt-4")

    assert model.get_config()["model_id"] == "openai/gpt-4"


@pytest.mark.parametrize(
    ("usage_factory", "usage_fields", "exp_cache"),
    [
        (Usage, {}, {}),
        (Usage, {"prompt_tokens_details": None, "cache_creation_input_tokens": None}, {}),
        (Usage, {"cache_creation_input_tokens": 10}, {"cacheWriteInputTokens": 10}),
        (Usage, {"cache_creation_input_tokens": 0}, {"cacheWriteInputTokens": 0}),
        (
            Usage,
            {"cache_read_input_tokens": 25, "cache_creation_input_tokens": 10},
            {"cacheReadInputTokens": 25, "cacheWriteInputTokens": 10},
        ),
        (
            Usage,
            {"cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
            {"cacheReadInputTokens": 0, "cacheWriteInputTokens": 0},
        ),
        (
            Usage,
            {"prompt_tokens_details": {"cached_tokens": 25, "cache_write_tokens": 10}},
            {"cacheReadInputTokens": 25, "cacheWriteInputTokens": 10},
        ),
        (
            Usage,
            {"prompt_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 2713}},
            {"cacheReadInputTokens": 0, "cacheWriteInputTokens": 2713},
        ),
        (
            Usage,
            {"prompt_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 0}},
            {"cacheReadInputTokens": 0, "cacheWriteInputTokens": 0},
        ),
        (
            SimpleNamespace,
            {"prompt_tokens_details": None, "cache_creation_input_tokens": 10},
            {"cacheWriteInputTokens": 10},
        ),
        (
            SimpleNamespace,
            {"prompt_tokens_details": None, "cache_creation_input_tokens": 0},
            {"cacheWriteInputTokens": 0},
        ),
        (SimpleNamespace, {"prompt_tokens_details": None, "cache_creation_input_tokens": None}, {}),
        (SimpleNamespace, {"prompt_tokens_details": None, "cache_creation_input_tokens": "10"}, {}),
        (
            SimpleNamespace,
            {"prompt_tokens_details": SimpleNamespace(cached_tokens=25), "cache_creation_input_tokens": 10},
            {"cacheReadInputTokens": 25, "cacheWriteInputTokens": 10},
        ),
        (
            SimpleNamespace,
            {
                "prompt_tokens_details": SimpleNamespace(cached_tokens=25, cache_write_tokens=None),
                "cache_creation_input_tokens": 10,
            },
            {"cacheReadInputTokens": 25, "cacheWriteInputTokens": 10},
        ),
        (
            SimpleNamespace,
            {
                "prompt_tokens_details": SimpleNamespace(cached_tokens=25, cache_write_tokens=20),
                "cache_creation_input_tokens": 10,
            },
            {"cacheReadInputTokens": 25, "cacheWriteInputTokens": 20},
        ),
        (
            SimpleNamespace,
            {
                "prompt_tokens_details": SimpleNamespace(cached_tokens=0, cache_write_tokens=0),
                "cache_creation_input_tokens": 10,
            },
            {"cacheReadInputTokens": 0, "cacheWriteInputTokens": 0},
        ),
    ],
)
def test_format_chunk_metadata_with_cache_tokens(usage_factory, usage_fields, exp_cache, model):
    usage = usage_factory(prompt_tokens=100, completion_tokens=50, total_tokens=150, **usage_fields)
    tru_usage = model.format_chunk({"chunk_type": "metadata", "data": usage})["metadata"]["usage"]
    exp_usage = {"inputTokens": 100, "outputTokens": 50, "totalTokens": 150, **exp_cache}
    assert tru_usage == exp_usage


def test_stream_switch_content_same_type():
    """Test _stream_switch_content when data_type is the same as prev_data_type."""
    model = LiteLLMModel(model_id="test")

    chunks, data_type = model._stream_switch_content("text", "text")

    assert chunks == []
    assert data_type == "text"


def test_stream_switch_content_different_type_with_prev():
    """Test _stream_switch_content when switching from one type to another."""
    model = LiteLLMModel(model_id="test")

    chunks, data_type = model._stream_switch_content("text", "reasoning_content")

    assert len(chunks) == 2
    assert chunks[0]["contentBlockStop"] == {}
    assert chunks[1]["contentBlockStart"] == {"start": {}}
    assert data_type == "text"


def test_stream_switch_content_different_type_no_prev():
    """Test _stream_switch_content when switching to a type with no previous type."""
    model = LiteLLMModel(model_id="test")

    chunks, data_type = model._stream_switch_content("text", None)

    assert len(chunks) == 1
    assert chunks[0]["contentBlockStart"] == {"start": {}}
    assert data_type == "text"


@pytest.mark.asyncio
async def test_stream_with_events_missing_usage_attribute(
    litellm_acompletion, api_key, model_id, model, agenerator, alist
):
    """Test streaming handles events that don't have a usage attribute.

    This test verifies the fix for a bug where ModelResponseStream objects
    (which don't have a 'usage' attribute) would cause an AttributeError
    when the code tried to access event.usage directly instead of using getattr.

    The bug occurred because:
    1. ModelResponse (non-streaming) has a 'usage' attribute
    2. ModelResponseStream (streaming chunks) does NOT have a 'usage' attribute
    3. The code assumed all events would have the 'usage' attribute

    Regression test for: 'ModelResponseStream' object has no attribute 'usage'
    """

    # Use spec to ensure mock objects only have specified attributes
    # This mimics the real ModelResponseStream which doesn't have 'usage'
    class MockStreamChunk:
        """Mock that mimics ModelResponseStream - no usage attribute."""

        def __init__(self, choices=None):
            self.choices = choices or []

    mock_delta = unittest.mock.Mock(content="Hello", tool_calls=None, reasoning_content=None)
    mock_event_1 = MockStreamChunk(choices=[unittest.mock.Mock(finish_reason=None, delta=mock_delta)])
    mock_event_2 = MockStreamChunk(choices=[unittest.mock.Mock(finish_reason="stop", delta=mock_delta)])
    # After finish_reason is received, remaining events in the stream also don't have 'usage'
    mock_event_3 = MockStreamChunk(choices=[])
    mock_event_4 = MockStreamChunk(choices=[])

    litellm_acompletion.side_effect = unittest.mock.AsyncMock(
        return_value=agenerator([mock_event_1, mock_event_2, mock_event_3, mock_event_4])
    )

    messages = [{"role": "user", "content": [{"type": "text", "text": "Hello"}]}]
    response = model.stream(messages)

    # This should NOT raise AttributeError: 'MockStreamChunk' object has no attribute 'usage'
    tru_events = await alist(response)

    # Verify we got the expected events (no metadata since no usage was available)
    assert tru_events[0] == {"messageStart": {"role": "assistant"}}
    assert {"messageStop": {"stopReason": "end_turn"}} in tru_events
    # No metadata event since mock events don't have usage
    assert not any("metadata" in event for event in tru_events)


@pytest.mark.asyncio
async def test_stream_with_usage_in_final_event(litellm_acompletion, api_key, model_id, model, agenerator, alist):
    """Test streaming correctly extracts usage when it IS present in final events.

    This test ensures that when usage data IS available (e.g., with stream_options.include_usage=True),
    it is correctly extracted and included in the metadata event.
    """

    class MockStreamChunkWithoutUsage:
        """Mock streaming chunk without usage."""

        def __init__(self, choices=None):
            self.choices = choices or []

    class MockStreamChunkWithUsage:
        """Mock streaming chunk with usage (final event)."""

        def __init__(self, usage):
            self.choices = []
            self.usage = usage

    mock_delta = unittest.mock.Mock(content="Hi", tool_calls=None, reasoning_content=None)
    mock_event_1 = MockStreamChunkWithoutUsage(choices=[unittest.mock.Mock(finish_reason=None, delta=mock_delta)])
    mock_event_2 = MockStreamChunkWithoutUsage(choices=[unittest.mock.Mock(finish_reason="stop", delta=mock_delta)])

    # Final event with usage data
    mock_usage = unittest.mock.Mock()
    mock_usage.prompt_tokens = 10
    mock_usage.completion_tokens = 5
    mock_usage.total_tokens = 15
    mock_usage.prompt_tokens_details = None
    mock_usage.cache_creation_input_tokens = None
    mock_event_3 = MockStreamChunkWithUsage(usage=mock_usage)

    litellm_acompletion.side_effect = unittest.mock.AsyncMock(
        return_value=agenerator([mock_event_1, mock_event_2, mock_event_3])
    )

    messages = [{"role": "user", "content": [{"type": "text", "text": "Hi"}]}]
    response = model.stream(messages)

    tru_events = await alist(response)

    # Verify metadata event is present with correct usage
    metadata_events = [e for e in tru_events if "metadata" in e]
    assert len(metadata_events) == 1
    assert metadata_events[0]["metadata"]["usage"]["inputTokens"] == 10
    assert metadata_events[0]["metadata"]["usage"]["outputTokens"] == 5
    assert metadata_events[0]["metadata"]["usage"]["totalTokens"] == 15


def test_format_request_messages_with_tool_calls_no_content():
    """Test that assistant messages with only tool calls are included and have no content field."""
    messages = [
        {"role": "user", "content": [{"text": "Use the calculator"}]},
        {
            "role": "assistant",
            "content": [
                {
                    "toolUse": {
                        "input": {"expression": "2+2"},
                        "name": "calculator",
                        "toolUseId": "c1",
                    },
                },
            ],
        },
    ]

    tru_result = LiteLLMModel.format_request_messages(messages)

    exp_result = [
        {"role": "user", "content": [{"text": "Use the calculator", "type": "text"}]},
        {
            "role": "assistant",
            "tool_calls": [
                {
                    "function": {"arguments": '{"expression": "2+2"}', "name": "calculator"},
                    "id": "c1",
                    "type": "function",
                }
            ],
        },
    ]
    assert tru_result == exp_result


# --- Thought Signature Tests ---


def test_format_chunk_tool_start_extracts_thought_signature_from_id():
    """Test that format_chunk extracts thought_signature from LiteLLM-encoded tool call ID."""
    model = LiteLLMModel(model_id="test")

    mock_data = unittest.mock.Mock()
    mock_data.id = "call_abc123__thought__dGhpcy1pcy1hLXNpZw=="
    mock_data.function = unittest.mock.Mock()
    mock_data.function.name = "get_weather"
    mock_data.provider_specific_fields = None

    event = {"chunk_type": "content_start", "data_type": "tool", "data": mock_data}
    result = model.format_chunk(event)

    tool_use = result["contentBlockStart"]["start"]["toolUse"]
    assert tool_use["reasoningSignature"] == "dGhpcy1pcy1hLXNpZw=="
    # toolUseId keeps the full encoded string so tool result IDs match
    assert tool_use["toolUseId"] == "call_abc123__thought__dGhpcy1pcy1hLXNpZw=="


def test_format_chunk_tool_start_extracts_thought_signature_from_provider_specific_fields():
    """Test that format_chunk extracts thought_signature from provider_specific_fields."""
    model = LiteLLMModel(model_id="test")

    mock_data = unittest.mock.Mock()
    mock_data.id = "call_abc123"  # No __thought__ in ID
    mock_data.function = unittest.mock.Mock()
    mock_data.function.name = "get_weather"
    mock_data.function.provider_specific_fields = None
    mock_data.provider_specific_fields = {"thought_signature": "cHNmLXNpZw=="}

    event = {"chunk_type": "content_start", "data_type": "tool", "data": mock_data}
    result = model.format_chunk(event)

    tool_use = result["contentBlockStart"]["start"]["toolUse"]
    assert tool_use["reasoningSignature"] == "cHNmLXNpZw=="
    assert tool_use["toolUseId"] == "call_abc123"


def test_format_chunk_tool_start_no_thought_signature():
    """Test that format_chunk works normally when no thought_signature is present."""
    model = LiteLLMModel(model_id="test")

    mock_data = unittest.mock.Mock()
    mock_data.id = "call_plain123"
    mock_data.function = unittest.mock.Mock()
    mock_data.function.name = "get_weather"
    mock_data.provider_specific_fields = None
    mock_data.function.provider_specific_fields = None

    event = {"chunk_type": "content_start", "data_type": "tool", "data": mock_data}
    result = model.format_chunk(event)

    tool_use = result["contentBlockStart"]["start"]["toolUse"]
    assert tool_use["toolUseId"] == "call_plain123"
    assert "reasoningSignature" not in tool_use


def test_format_request_message_tool_call_encodes_thought_signature():
    """Test that format_request_message_tool_call encodes reasoningSignature into the tool call ID."""
    tool_use = {
        "toolUseId": "call_abc123",
        "name": "get_weather",
        "input": {"city": "Seattle"},
        "reasoningSignature": "dGhpcy1pcy1hLXNpZw==",
    }

    result = LiteLLMModel.format_request_message_tool_call(tool_use)

    assert result["id"] == "call_abc123__thought__dGhpcy1pcy1hLXNpZw=="
    assert result["function"]["name"] == "get_weather"
    assert result["function"]["arguments"] == '{"city": "Seattle"}'


def test_format_request_message_tool_call_skips_encoding_when_already_present():
    """Test that format_request_message_tool_call does not double-encode the signature."""
    tool_use = {
        "toolUseId": "call_abc123__thought__dGhpcy1pcy1hLXNpZw==",
        "name": "get_weather",
        "input": {"city": "Seattle"},
        "reasoningSignature": "dGhpcy1pcy1hLXNpZw==",
    }

    result = LiteLLMModel.format_request_message_tool_call(tool_use)

    # Should NOT double-encode
    assert result["id"] == "call_abc123__thought__dGhpcy1pcy1hLXNpZw=="


def test_format_request_message_tool_call_no_reasoning_signature():
    """Test that format_request_message_tool_call works normally without reasoningSignature."""
    tool_use = {
        "toolUseId": "call_plain123",
        "name": "get_weather",
        "input": {"city": "Seattle"},
    }

    result = LiteLLMModel.format_request_message_tool_call(tool_use)

    assert result["id"] == "call_plain123"
    assert "__thought__" not in result["id"]


def test_format_system_messages_preserves_cache_point_ttl():
    """CachePoint with ttl="1h" should produce cache_control with ttl field."""
    result = LiteLLMModel._format_system_messages(
        system_prompt_content=[
            {"text": "You are a helpful assistant."},
            {"cachePoint": {"type": "default", "ttl": "1h"}},
        ]
    )
    assert result[0]["content"][0]["cache_control"] == {"type": "ephemeral", "ttl": "1h"}


def test_format_system_messages_cache_point_without_ttl():
    """CachePoint without ttl should produce cache_control with no ttl key (backward compat)."""
    result = LiteLLMModel._format_system_messages(
        system_prompt_content=[
            {"text": "You are a helpful assistant."},
            {"cachePoint": {"type": "default"}},
        ]
    )
    assert result[0]["content"][0]["cache_control"] == {"type": "ephemeral"}
    assert "ttl" not in result[0]["content"][0]["cache_control"]


def test_format_system_messages_cache_point_with_no_preceding_content():
    """CachePoint with no preceding text block should be silently ignored."""
    result = LiteLLMModel._format_system_messages(
        system_prompt_content=[
            {"cachePoint": {"type": "default", "ttl": "1h"}},
        ]
    )
    assert result == []


def test_thought_signature_round_trip():
    """Test that thought signature is preserved through a full response -> internal -> request cycle."""
    model = LiteLLMModel(model_id="test")
    signature = "R2VtaW5pVGhvdWdodFNpZw=="
    tool_call_id = f"call_xyz789__thought__{signature}"

    # 1. Response path: format_chunk extracts the signature
    mock_data = unittest.mock.Mock()
    mock_data.id = tool_call_id
    mock_data.function = unittest.mock.Mock()
    mock_data.function.name = "current_time"
    mock_data.provider_specific_fields = None
    mock_data.function.provider_specific_fields = None

    event = {"chunk_type": "content_start", "data_type": "tool", "data": mock_data}
    chunk = model.format_chunk(event)
    tool_use_data = chunk["contentBlockStart"]["start"]["toolUse"]
    assert tool_use_data["reasoningSignature"] == signature

    # 2. Simulate internal storage (streaming layer stores reasoningSignature)
    internal_tool_use = {
        "toolUseId": tool_use_data["toolUseId"],
        "name": tool_use_data["name"],
        "input": {"timezone": "UTC"},
        "reasoningSignature": tool_use_data["reasoningSignature"],
    }

    # 3. Request path: format_request_message_tool_call re-encodes the signature
    tool_call = LiteLLMModel.format_request_message_tool_call(internal_tool_use)
    assert "__thought__" in tool_call["id"]
    assert signature in tool_call["id"]


@pytest.mark.asyncio
async def test_stream_generates_tool_call_id_when_null(litellm_acompletion, model, agenerator, alist):
    mock_tool_call = unittest.mock.Mock(index=0)
    mock_tool_call.id = None
    mock_tool_call.function.name = "test_tool"
    mock_tool_call.function.arguments = '{"arg": "value"}'

    mock_delta_1 = unittest.mock.Mock(content=None, tool_calls=[mock_tool_call], reasoning_content=None)
    mock_delta_2 = unittest.mock.Mock(content=None, tool_calls=None, reasoning_content=None)

    mock_event_1 = unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason=None, delta=mock_delta_1)])
    mock_event_2 = unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason="tool_calls", delta=mock_delta_2)])

    litellm_acompletion.side_effect = unittest.mock.AsyncMock(return_value=agenerator([mock_event_1, mock_event_2]))

    response = model.stream([{"role": "user", "content": [{"text": "test"}]}])
    events = await alist(response)

    start = next(e for e in events if "contentBlockStart" in e and "toolUse" in e["contentBlockStart"]["start"])
    tool_id = start["contentBlockStart"]["start"]["toolUse"]["toolUseId"]
    assert tool_id and tool_id.startswith("call_")


@pytest.mark.parametrize(
    ("model_id", "prompt_caching"),
    [
        ("anthropic/claude-haiku-4-5", "cache_points"),
        ("bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0", "cache_points"),
        ("openai/gpt-6-luna", "auto"),
        ("gemini/gemini-3.5-flash", None),
    ],
)
def test_model_info_reports_how_the_backend_caches(model_id, prompt_caching):
    assert LiteLLMModel(model_id=model_id).model_info.capabilities.prompt_caching == prompt_caching


def test_format_request_messages_turns_a_message_cache_point_into_cache_control_ahead_of_the_tail():
    messages = [
        {
            "role": "user",
            "content": [
                {"toolResult": {"toolUseId": "t1", "status": "success", "content": [{"text": "s1"}]}},
                {"cachePoint": {"type": "default", "ttl": "1h"}},
                {"text": "Current time: 1 ms"},
            ],
        }
    ]

    tru_messages = LiteLLMModel.format_request_messages(messages)

    exp_messages = [
        {
            "role": "tool",
            "tool_call_id": "t1",
            "content": [{"type": "text", "text": "s1", "cache_control": {"type": "ephemeral", "ttl": "1h"}}],
        },
        {"role": "user", "content": [{"text": "Current time: 1 ms", "type": "text"}]},
    ]
    assert tru_messages == exp_messages


def test_format_request_messages_keeps_tool_messages_together_around_a_cache_point():
    image = {"image": {"format": "png", "source": {"bytes": b"png"}}}
    messages = [
        {
            "role": "user",
            "content": [
                {"toolResult": {"toolUseId": "a", "status": "success", "content": [image]}},
                {"cachePoint": {"type": "default"}},
                {"toolResult": {"toolUseId": "b", "status": "success", "content": [{"text": "r"}]}},
            ],
        }
    ]

    tru_messages = LiteLLMModel.format_request_messages(messages)

    exp_messages = [
        {
            "role": "tool",
            "tool_call_id": "a",
            "content": [
                {
                    "type": "text",
                    "text": "Tool successfully returned an image. "
                    "The image is being provided in the following user message.",
                    "cache_control": {"type": "ephemeral"},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "b", "content": "r"},
        {
            "role": "user",
            "content": [
                {
                    "type": "image_url",
                    "image_url": {"detail": "auto", "format": "image/png", "url": "data:image/png;base64,cG5n"},
                }
            ],
        },
    ]
    assert tru_messages == exp_messages


@pytest.mark.parametrize(
    ("prompt_caching", "sends_key"), [("cache_points", False), (None, True)], ids=["declared_claude", "undeclared"]
)
def test_format_request_resolves_a_proxy_alias_session_key_from_model_info(
    litellm_supported_params, prompt_caching, sends_key
):
    from strands.models import ModelCapabilities, ModelInfo

    litellm_supported_params.return_value = ["prompt_cache_key"]

    model = LiteLLMModel(
        model_id="litellm_proxy/claude-alias",
        cache_config=CacheConfig(),
        model_info=ModelInfo(capabilities=ModelCapabilities(prompt_caching=prompt_caching)),
    )

    request = model.format_request(
        [{"role": "user", "content": [{"text": "hi"}]}], agent_metadata=AgentMetadata(session_id="s1")
    )

    assert ("prompt_cache_key" in request) is sends_key


def test_format_request_drops_the_session_key_for_a_cache_point_model_on_litellm_without_key_validation(
    monkeypatch,
):
    monkeypatch.setattr(
        strands.models.litellm.litellm,
        "OPENAI_CHAT_COMPLETION_PARAMS",
        [p for p in strands.models.litellm.litellm.OPENAI_CHAT_COMPLETION_PARAMS if p != "prompt_cache_key"],
    )
    model = LiteLLMModel(model_id="bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0", cache_config=CacheConfig())

    request = model.format_request(
        [{"role": "user", "content": [{"text": "hi"}]}], agent_metadata=AgentMetadata(session_id="s1")
    )

    assert "prompt_cache_key" not in request


@pytest.fixture
def read_tool_spec():
    return {"name": "read", "description": "read a section", "inputSchema": {"json": {"type": "object"}}}


@pytest.mark.parametrize(
    ("model_id", "tools_ttl", "exp_cache_control"),
    [
        ("anthropic/claude-haiku-4-5", True, {"type": "ephemeral"}),
        ("anthropic/claude-haiku-4-5", "1h", {"type": "ephemeral", "ttl": "1h"}),
        ("anthropic/claude-haiku-4-5", None, None),
        ("openai/gpt-6-luna", True, None),
    ],
)
def test_format_request_marks_the_last_tool_when_tools_ttl_asks(model_id, tools_ttl, exp_cache_control, read_tool_spec):
    model = LiteLLMModel(model_id=model_id, cache_config=CacheConfig(tools_ttl=tools_ttl))

    request = model.format_request([{"role": "user", "content": [{"text": "hi"}]}], [read_tool_spec])

    assert request["tools"][-1].get("cache_control") == exp_cache_control


def test_format_request_keeps_cache_points_within_the_limit_keeping_the_first_and_the_last():
    model = LiteLLMModel(model_id="anthropic/claude-haiku-4-5", cache_config=CacheConfig())
    point = {"cachePoint": {"type": "default"}}
    system_prompt_content = [{"text": "a"}, point, {"text": "b"}, point, {"text": "c"}, point, {"text": "d"}, point]

    tru_messages = model.format_request(
        [{"role": "user", "content": [{"text": "q"}, point]}], system_prompt_content=system_prompt_content
    )["messages"]

    marked = {"cache_control": {"type": "ephemeral"}}
    exp_messages = [
        {
            "role": "system",
            "content": [
                {"type": "text", "text": "a", **marked},
                {"type": "text", "text": "b", **marked},
                {"type": "text", "text": "c", **marked},
                {"type": "text", "text": "d"},
            ],
        },
        {"role": "user", "content": [{"text": "q", "type": "text", **marked}]},
    ]
    assert tru_messages == exp_messages


def test_format_request_drops_message_cache_points_for_a_backend_without_them():
    model = LiteLLMModel(model_id="openai/gpt-6-luna", cache_config=CacheConfig())
    messages = [{"role": "user", "content": [{"text": "q"}, {"cachePoint": {"type": "default"}}]}]

    request = model.format_request(messages)

    assert request["messages"] == [{"role": "user", "content": [{"type": "text", "text": "q"}]}]


@pytest.mark.parametrize(
    ("model_id", "warns"),
    [("anthropic/claude-haiku-4-5", False), ("openai/gpt-6-luna", True)],
    ids=["claude", "openai"],
)
def test_format_request_warns_only_about_cache_config_fields_the_backend_ignores(model_id, warns, captured_warnings):
    model = LiteLLMModel(model_id=model_id, cache_config=CacheConfig(ttl="1h", messages_ttl="1h", tools_ttl=True))

    model.format_request([{"role": "user", "content": [{"text": "hi"}]}])

    assert any("no effect on OpenAI" in str(warning.message) for warning in captured_warnings) is warns


@pytest.fixture
def injected_loop_messages():
    return [
        {"role": "user", "content": [{"text": "read section 1"}]},
        {"role": "assistant", "content": [{"toolUse": {"toolUseId": "t1", "name": "read", "input": {"n": 1}}}]},
        {
            "role": "user",
            "content": [
                {"toolResult": {"toolUseId": "t1", "status": "success", "content": [{"text": "s1"}]}},
                {"text": "Current time: 1 ms"},
            ],
        },
    ]


def _marked(request):
    return [
        (message["role"], part.get("text"))
        for message in request["messages"]
        if isinstance(message.get("content"), list)
        for part in message["content"]
        if "cache_control" in part
    ]


def test_format_request_places_cache_points_ahead_of_rebuilt_trailing_blocks(injected_loop_messages):
    model = LiteLLMModel(model_id="anthropic/claude-haiku-4-5", cache_config=CacheConfig())
    original = copy.deepcopy(injected_loop_messages)

    tru_messages = model.format_request(injected_loop_messages, system_prompt="s1", dynamic_trailing_blocks=1)[
        "messages"
    ]

    exp_messages = [
        {"role": "system", "content": [{"type": "text", "text": "s1", "cache_control": {"type": "ephemeral"}}]},
        {"role": "user", "content": [{"text": "read section 1", "type": "text"}]},
        {
            "role": "assistant",
            "tool_calls": [{"function": {"arguments": '{"n": 1}', "name": "read"}, "id": "t1", "type": "function"}],
        },
        {
            "role": "tool",
            "tool_call_id": "t1",
            "content": [{"type": "text", "text": "s1", "cache_control": {"type": "ephemeral"}}],
        },
        {"role": "user", "content": [{"text": "Current time: 1 ms", "type": "text"}]},
    ]
    assert tru_messages == exp_messages
    assert injected_loop_messages == original


@pytest.mark.parametrize("model_id", ["openai/gpt-6-luna", "gemini/gemini-3.5-flash", "m1"])
def test_format_request_places_no_cache_points_on_other_backends(model_id, injected_loop_messages):
    model = LiteLLMModel(model_id=model_id, cache_config=CacheConfig())

    assert _marked(model.format_request(injected_loop_messages, system_prompt="s1")) == []


def test_format_request_places_cache_points_for_a_proxy_alias_declared_through_model_info(injected_loop_messages):
    from strands.models import ModelCapabilities, ModelInfo

    model = LiteLLMModel(
        model_id="litellm_proxy/claude-alias",
        cache_config=CacheConfig(),
        model_info=ModelInfo(capabilities=ModelCapabilities(prompt_caching="cache_points")),
    )

    assert _marked(model.format_request(injected_loop_messages, system_prompt="s1"))[0] == ("system", "s1")


@pytest.mark.parametrize(
    ("model_id", "exp_marked"),
    [
        ("litellm_proxy/claude-alias", [("system", "s1"), ("tool", "s1")]),
        ("openrouter/anthropic/claude-sonnet-4.5", [("system", "s1"), ("tool", "s1")]),
        ("gemini/gemini-3.5-flash", []),
        ("openai/gpt-6-luna", []),
        ("openai/gpt-4o", []),
        ("azure/gpt-4o", []),
        ("groq/llama-3.3-70b-versatile", []),
        ("openrouter/openai/gpt-4o", []),
        ("vertex_ai/gemini-2.5-flash", []),
        ("bedrock/us.amazon.nova-pro-v1:0", []),
        ("bedrock/openai.gpt-oss-120b-1:0", []),
        ("vertex_ai/claude-sonnet-4@20250514", [("system", "s1"), ("tool", "s1")]),
    ],
    ids=[
        "proxy_alias",
        "gateway",
        "gemini",
        "openai",
        "openai_unlisted",
        "azure",
        "groq",
        "gateway_naming_openai",
        "vertex_gemini",
        "bedrock_nova",
        "bedrock_gpt_oss",
        "vertex_claude",
    ],
)
def test_format_request_anthropic_strategy_places_points_except_on_backends_that_take_none(
    model_id, exp_marked, injected_loop_messages
):
    model = LiteLLMModel(model_id=model_id, cache_config=CacheConfig(strategy="anthropic"))

    tru_marked = _marked(model.format_request(injected_loop_messages, system_prompt="s1", dynamic_trailing_blocks=1))

    assert tru_marked == exp_marked


def test_format_request_keeps_the_callers_cache_points_and_applies_ttls(injected_loop_messages):
    model = LiteLLMModel(model_id="anthropic/claude-haiku-4-5", cache_config=CacheConfig(ttl="1h"))
    system_prompt_content = [{"text": "a"}, {"cachePoint": {"type": "default"}}, {"text": "b"}]

    request = model.format_request(injected_loop_messages, system_prompt_content=system_prompt_content)

    assert [part.get("cache_control") for part in request["messages"][0]["content"]] == [
        {"type": "ephemeral", "ttl": "1h"},
        None,
    ]
    assert request["messages"][-1]["content"][-1]["cache_control"] == {"type": "ephemeral", "ttl": "1h"}


def test_format_request_honors_disabled_cache_sections(injected_loop_messages):
    model = LiteLLMModel(
        model_id="anthropic/claude-haiku-4-5", cache_config=CacheConfig(system_prompt_ttl=False, messages_ttl=False)
    )

    assert _marked(model.format_request(injected_loop_messages, system_prompt="s1")) == []


@pytest.mark.asyncio
async def test_stream_passes_dynamic_trailing_blocks_to_format_request(messages):
    model = LiteLLMModel(model_id="anthropic/claude-haiku-4-5")
    model.format_request = unittest.mock.Mock(side_effect=RuntimeError("stop"))

    with pytest.raises(RuntimeError):
        await anext(model.stream(messages, dynamic_trailing_blocks=2))

    assert model.format_request.call_args.kwargs["dynamic_trailing_blocks"] == 2


@pytest.mark.parametrize(
    ("model_id", "model_info"),
    [
        ("bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0", None),
        ("litellm_proxy/claude-alias", ModelInfo(capabilities=ModelCapabilities(prompt_caching="cache_points"))),
    ],
    ids=["bedrock", "declared_proxy_alias"],
)
def test_format_request_steps_the_point_back_over_a_trailing_non_pdf_document(model_id, model_info):
    extra = {"model_info": model_info} if model_info else {}
    model = LiteLLMModel(model_id=model_id, cache_config=CacheConfig(system_prompt_ttl=False), **extra)
    document = {"document": {"format": "txt", "name": "notes", "source": {"bytes": b"hello"}}}

    tru_messages = model.format_request([{"role": "user", "content": [{"text": "read this"}, document]}])["messages"]

    assert tru_messages[-1]["content"][0] == {
        "text": "read this",
        "type": "text",
        "cache_control": {"type": "ephemeral"},
    }
    assert "cache_control" not in tru_messages[-1]["content"][-1]


def test_format_request_keeps_the_anthropic_point_after_a_trailing_document():
    model = LiteLLMModel(model_id="anthropic/claude-haiku-4-5", cache_config=CacheConfig(system_prompt_ttl=False))
    document = {"document": {"format": "txt", "name": "notes", "source": {"bytes": b"hello"}}}

    tru_messages = model.format_request([{"role": "user", "content": [{"text": "read this"}, document]}])["messages"]

    assert tru_messages[-1]["content"][0] == {"text": "read this", "type": "text"}
    assert tru_messages[-1]["content"][-1]["cache_control"] == {"type": "ephemeral"}


def test_format_request_fills_the_ttl_into_the_callers_message_cache_points():
    model = LiteLLMModel(model_id="anthropic/claude-haiku-4-5", cache_config=CacheConfig(ttl="1h"))
    messages = [
        {"role": "user", "content": [{"text": "a"}, {"cachePoint": {"type": "default"}}]},
        {"role": "assistant", "content": [{"text": "b"}]},
        {"role": "user", "content": [{"text": "c"}]},
    ]

    tru_messages = model.format_request(messages, system_prompt="s1")["messages"]

    marked = {"cache_control": {"type": "ephemeral", "ttl": "1h"}}
    exp_messages = [
        {"role": "system", "content": [{"type": "text", "text": "s1", **marked}]},
        {"role": "user", "content": [{"text": "a", "type": "text", **marked}]},
        {"role": "assistant", "content": [{"text": "b", "type": "text"}]},
        {"role": "user", "content": [{"text": "c", "type": "text", **marked}]},
    ]
    assert tru_messages == exp_messages


@pytest.mark.parametrize(
    ("model_id", "client_args", "prompt_caching"),
    [
        ("claude-sonnet-4-5", {"custom_llm_provider": "openai", "api_base": "http://gateway"}, "auto"),
        ("anthropic/claude-haiku-4-5", {"use_litellm_proxy": True}, "cache_points"),
    ],
    ids=["openai_compatible_gateway", "use_litellm_proxy"],
)
def test_model_info_resolves_the_backend_from_the_client_args(model_id, client_args, prompt_caching):
    model = LiteLLMModel(model_id=model_id, client_args=client_args)

    assert model.model_info.capabilities.prompt_caching == prompt_caching


def test_format_request_logs_message_cache_points_it_drops(caplog):
    model = LiteLLMModel(model_id="openai/gpt-6-luna", cache_config=CacheConfig())

    with caplog.at_level("WARNING", logger="strands.models.litellm"):
        model.format_request([{"role": "user", "content": [{"text": "q"}, {"cachePoint": {"type": "default"}}]}])

    assert "cachePoint content block is not supported by this backend" in caplog.text


def test_format_request_marks_the_message_before_an_empty_tool_result():
    model = LiteLLMModel(model_id="anthropic/claude-haiku-4-5", cache_config=CacheConfig(system_prompt_ttl=False))
    messages = [
        {"role": "user", "content": [{"text": "read"}]},
        {"role": "assistant", "content": [{"toolUse": {"toolUseId": "t1", "name": "read", "input": {}}}]},
        {"role": "user", "content": [{"toolResult": {"toolUseId": "t1", "status": "success", "content": []}}]},
    ]

    tru_messages = model.format_request(messages)["messages"]

    exp_messages = [
        {"role": "user", "content": [{"text": "read", "type": "text", "cache_control": {"type": "ephemeral"}}]},
        {
            "role": "assistant",
            "tool_calls": [{"function": {"arguments": "{}", "name": "read"}, "id": "t1", "type": "function"}],
        },
        {"role": "tool", "tool_call_id": "t1", "content": ""},
    ]
    assert tru_messages == exp_messages


def test_format_request_does_not_mark_the_callers_tool_dicts(read_tool_spec):
    tool = {"type": "function", "function": {"name": "read", "parameters": {"type": "object"}}}
    model = LiteLLMModel(
        model_id="anthropic/claude-haiku-4-5", params={"tools": [tool]}, cache_config=CacheConfig(tools_ttl=True)
    )

    request = model.format_request([{"role": "user", "content": [{"text": "hi"}]}])

    assert "cache_control" in request["tools"][-1]
    assert "cache_control" not in tool


@pytest.mark.parametrize(
    ("model_id", "exp_prompt_caching"),
    [
        ("anthropic/claude-sonnet-4-0", "cache_points"),
        ("anthropic/claude-3-7-sonnet-latest", "cache_points"),
        ("vertex_ai/claude-sonnet-4@20250514", "cache_points"),
        ("openrouter/anthropic/claude-sonnet-4.5", None),
    ],
)
def test_model_info_treats_unlisted_claude_ids_on_cache_control_backends_as_taking_cache_points(
    model_id, exp_prompt_caching
):
    assert LiteLLMModel(model_id=model_id).model_info.capabilities.prompt_caching == exp_prompt_caching


@pytest.mark.parametrize("model_id", ["github_copilot/gpt-4.1", "chatgpt/gpt-5"])
def test_model_info_does_not_resolve_providers_whose_lookup_logs_in(model_id):
    with unittest.mock.patch.object(strands.models.litellm.litellm, "get_llm_provider") as get_llm_provider:
        _ = LiteLLMModel(model_id=model_id, cache_config=CacheConfig()).model_info

    get_llm_provider.assert_not_called()


def test_format_request_gives_the_callers_bedrock_message_points_the_messages_ttl_and_document_rule():
    model = LiteLLMModel(model_id="bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0", cache_config=CacheConfig())
    document = {"document": {"format": "txt", "name": "notes", "source": {"bytes": b"hello"}}}
    messages = [
        {"role": "user", "content": [{"text": "a"}, {"cachePoint": {"type": "default", "ttl": "1h"}}, {"text": "b"}]},
        {"role": "assistant", "content": [{"text": "ok"}]},
        {"role": "user", "content": [{"text": "c"}, document, {"cachePoint": {"type": "default"}}, {"text": "d"}]},
    ]

    tru_messages = model.format_request(messages, system_prompt="s1")["messages"]

    marked = {"cache_control": {"type": "ephemeral"}}
    assert tru_messages[1] == {
        "role": "user",
        "content": [{"text": "a", "type": "text", **marked}, {"text": "b", "type": "text"}],
    }
    assert tru_messages[3]["content"][0] == {"text": "c", "type": "text", **marked}
    assert all("cache_control" not in part for part in tru_messages[3]["content"][1:])


def test_format_request_drops_a_bedrock_message_point_with_only_documents_ahead_of_it(caplog):
    model = LiteLLMModel(model_id="bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0")
    document = {"document": {"format": "txt", "name": "notes", "source": {"bytes": b"hello"}}}

    with caplog.at_level("WARNING", logger="strands.models._cache_points"):
        tru_messages = model.format_request(
            [{"role": "user", "content": [document, {"cachePoint": {"type": "default"}}, {"text": "q"}]}]
        )["messages"]

    assert all("cache_control" not in part for part in tru_messages[0]["content"])
    assert "removed a cache point with no content ahead of it" in caplog.text


@pytest.mark.parametrize("model_id", ["openai/gpt-4o", "azure/gpt-4o"])
def test_format_request_anthropic_strategy_keeps_the_openai_routing_key(
    litellm_supported_params, model_id, captured_warnings
):
    litellm_supported_params.return_value = ["prompt_cache_key"]
    model = LiteLLMModel(model_id=model_id, cache_config=CacheConfig(strategy="anthropic", cache_key="k"))

    request = model.format_request([{"role": "user", "content": [{"text": "hi"}]}])

    assert request["prompt_cache_key"] == "k"
    assert not any("cache_key has no effect" in str(warning.message) for warning in captured_warnings)


def test_format_request_keeps_the_callers_message_ttl_without_cache_config():
    model = LiteLLMModel(model_id="anthropic/claude-sonnet-4-5")
    messages = [
        {"role": "user", "content": [{"text": "a"}, {"cachePoint": {"type": "default", "ttl": "1h"}}, {"text": "b"}]}
    ]

    tru_messages = model.format_request(messages)["messages"]

    exp_messages = [
        {
            "role": "user",
            "content": [
                {"text": "a", "type": "text", "cache_control": {"type": "ephemeral", "ttl": "1h"}},
                {"text": "b", "type": "text"},
            ],
        }
    ]
    assert tru_messages == exp_messages


@pytest.mark.parametrize(
    ("model_id", "client_args", "exp_points", "exp_key"),
    [
        ("litellm_proxy/claude-haiku-4-5", {}, True, False),
        ("claude-haiku-4-5", {"use_litellm_proxy": True}, True, False),
        ("azure_ai/claude-sonnet-4-5", {}, True, False),
        ("amazon.nova-lite-v1:0", {"use_litellm_proxy": True}, False, True),
        ("litellm_proxy/gpt-4o", {}, False, True),
        ("litellm_proxy/my-alias", {}, True, False),
    ],
    ids=["gateway_claude", "proxy_flag_claude", "azure_ai_claude", "proxy_flag_nova", "gateway_gpt", "unknown_alias"],
)
def test_format_request_anthropic_strategy_on_gateways_follows_the_named_model(
    litellm_supported_params, model_id, client_args, exp_points, exp_key
):
    litellm_supported_params.return_value = ["prompt_cache_key"]
    model = LiteLLMModel(
        model_id=model_id, client_args=client_args, cache_config=CacheConfig(strategy="anthropic", cache_key="k")
    )

    request = model.format_request([{"role": "user", "content": [{"text": "hi"}]}], system_prompt="s1")

    assert ("cache_control" in json.dumps(request)) is exp_points
    assert ("prompt_cache_key" in request) is exp_key
