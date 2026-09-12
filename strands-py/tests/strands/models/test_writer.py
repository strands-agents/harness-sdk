import logging
import unittest.mock
from typing import Any

import pydantic
import pytest
import writerai

import strands
from strands.models.model import CacheConfig
from strands.models.writer import WriterModel
from strands.types.exceptions import ContextWindowOverflowException


@pytest.fixture
def writer_client_cls():
    with unittest.mock.patch.object(strands.models.writer.writerai, "AsyncClient") as mock_client_cls:
        yield mock_client_cls


@pytest.fixture
def writer_client(writer_client_cls):
    return writer_client_cls.return_value


@pytest.fixture
def client_args():
    return {"api_key": "writer_api_key"}


@pytest.fixture
def model_id():
    return "palmyra-x5"


@pytest.fixture
def stream_options():
    return {"include_usage": True}


@pytest.fixture
def model(writer_client, model_id, stream_options, client_args):
    _ = writer_client

    return WriterModel(client_args, model_id=model_id, stream_options=stream_options)


@pytest.fixture
def messages():
    return [{"role": "user", "content": [{"text": "test"}]}]


@pytest.fixture
def system_prompt():
    return "System prompt"


@pytest.fixture
def test_output_model_cls():
    class TestOutputModel(pydantic.BaseModel):
        name: str

    return TestOutputModel


def test__init__(writer_client_cls, model_id, stream_options, client_args):
    model = WriterModel(client_args=client_args, model_id=model_id, stream_options=stream_options)

    config = model.get_config()
    exp_config = {"stream_options": stream_options, "model_id": model_id}

    assert config == exp_config

    writer_client_cls.assert_called_once_with(api_key=client_args.get("api_key", ""))


def test_update_config(model):
    model.update_config(model_id="palmyra-x4")

    model_id = model.get_config().get("model_id")

    assert model_id == "palmyra-x4"


def test_format_request_basic(model, messages, model_id, stream_options):
    request = model.format_request(messages)

    exp_request = {
        "stream": True,
        "messages": [{"role": "user", "content": [{"type": "text", "text": "test"}]}],
        "model": model_id,
        "stream_options": stream_options,
    }

    assert request == exp_request


def test_format_request_with_params(model, messages, model_id, stream_options):
    model.update_config(temperature=0.19)

    request = model.format_request(messages)
    exp_request = {
        "messages": [{"role": "user", "content": [{"type": "text", "text": "test"}]}],
        "model": model_id,
        "stream_options": stream_options,
        "temperature": 0.19,
        "stream": True,
    }

    assert request == exp_request


def test_format_request_with_system_prompt(model, messages, model_id, stream_options, system_prompt):
    request = model.format_request(messages, system_prompt=system_prompt)

    exp_request = {
        "messages": [
            {"content": "System prompt", "role": "system"},
            {"content": [{"text": "test", "type": "text"}], "role": "user"},
        ],
        "model": model_id,
        "stream_options": stream_options,
        "stream": True,
    }

    assert request == exp_request


def test_format_request_with_tool_use_preserves_non_ascii(model, model_id, stream_options):
    messages = [
        {
            "role": "assistant",
            "content": [{"toolUse": {"toolUseId": "c1", "name": "search", "input": {"query": "東京"}}}],
        },
    ]

    request = model.format_request(messages)
    exp_request = {
        "messages": [
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "function": {"arguments": '{"query": "東京"}', "name": "search"},
                        "id": "c1",
                        "type": "function",
                    }
                ],
            },
        ],
        "model": model_id,
        "stream_options": stream_options,
        "stream": True,
    }

    assert request == exp_request


def test_format_request_with_tool_result_preserves_non_ascii(model, model_id, stream_options):
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "c1",
                        "status": "success",
                        "content": [{"json": {"city": "東京"}}],
                    }
                }
            ],
        }
    ]

    request = model.format_request(messages)
    exp_request = {
        "messages": [
            {
                "role": "tool",
                "content": [{"text": '{"city": "東京"}', "type": "text"}],
                "tool_call_id": "c1",
            },
        ],
        "model": model_id,
        "stream_options": stream_options,
        "stream": True,
    }

    assert request == exp_request


def test_format_request_with_tool_use(model, model_id, stream_options):
    messages = [
        {
            "role": "assistant",
            "content": [
                {
                    "toolUse": {
                        "toolUseId": "c1",
                        "name": "calculator",
                        "input": {"expression": "2+2"},
                    },
                },
            ],
        },
    ]

    request = model.format_request(messages)
    exp_request = {
        "messages": [
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "function": {"arguments": '{"expression": "2+2"}', "name": "calculator"},
                        "id": "c1",
                        "type": "function",
                    }
                ],
            },
        ],
        "model": model_id,
        "stream_options": stream_options,
        "stream": True,
    }

    assert request == exp_request


def test_format_request_with_tool_results(model, model_id, stream_options):
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "c1",
                        "status": "success",
                        "content": [
                            {"text": "answer is 4"},
                        ],
                    }
                }
            ],
        }
    ]

    request = model.format_request(messages)
    exp_request = {
        "messages": [
            {
                "role": "tool",
                "content": [{"text": "answer is 4", "type": "text"}],
                "tool_call_id": "c1",
            },
        ],
        "model": model_id,
        "stream_options": stream_options,
        "stream": True,
    }

    assert request == exp_request


def test_format_request_with_image(model, model_id, stream_options):
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "image": {
                        "format": "png",
                        "source": {"bytes": b"lovely sunny day"},
                    },
                },
            ],
        },
    ]

    request = model.format_request(messages)
    exp_request = {
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "image_url": {
                            "url": "data:image/png;base64,bG92ZWx5IHN1bm55IGRheQ==",
                        },
                        "type": "image_url",
                    },
                ],
            },
        ],
        "model": model_id,
        "stream": True,
        "stream_options": stream_options,
    }

    assert request == exp_request


def test_format_request_with_empty_content(model, model_id, stream_options):
    messages = [
        {
            "role": "user",
            "content": [],
        },
    ]

    tru_request = model.format_request(messages)
    exp_request = {
        "messages": [],
        "model": model_id,
        "stream_options": stream_options,
        "stream": True,
    }

    assert tru_request == exp_request


@pytest.mark.parametrize(
    ("content", "content_type"),
    [
        ({"video": {}}, "video"),
        ({"document": {}}, "document"),
        ({"reasoningContent": {}}, "reasoningContent"),
        ({"other": {}}, "other"),
    ],
)
def test_format_request_with_unsupported_type(model, content, content_type):
    messages = [
        {
            "role": "user",
            "content": [content],
        },
    ]

    with pytest.raises(TypeError, match=f"content_type=<{content_type}> | unsupported type"):
        model.format_request(messages)


class AsyncStreamWrapper:
    def __init__(self, items: list[Any]):
        self.items = items

    def __aiter__(self):
        return self._generator()

    async def _generator(self):
        for item in self.items:
            yield item


async def mock_streaming_response(items: list[Any]):
    return AsyncStreamWrapper(items)


@pytest.mark.asyncio
async def test_stream(writer_client, model, model_id):
    mock_tool_call_1_part_1 = unittest.mock.Mock(index=0)
    mock_tool_call_2_part_1 = unittest.mock.Mock(index=1)
    mock_delta_1 = unittest.mock.Mock(
        content="I'll calculate", tool_calls=[mock_tool_call_1_part_1, mock_tool_call_2_part_1]
    )

    mock_tool_call_1_part_2 = unittest.mock.Mock(index=0)
    mock_tool_call_2_part_2 = unittest.mock.Mock(index=1)
    mock_delta_2 = unittest.mock.Mock(
        content="that for you", tool_calls=[mock_tool_call_1_part_2, mock_tool_call_2_part_2]
    )

    mock_delta_3 = unittest.mock.Mock(content="", tool_calls=None)

    mock_event_1 = unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason=None, delta=mock_delta_1)])
    mock_event_2 = unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason=None, delta=mock_delta_2)])
    mock_event_3 = unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason="tool_calls", delta=mock_delta_3)])
    mock_event_4 = unittest.mock.Mock()

    writer_client.chat.chat.return_value = mock_streaming_response(
        [mock_event_1, mock_event_2, mock_event_3, mock_event_4]
    )

    messages = [{"role": "user", "content": [{"type": "text", "text": "calculate 2+2"}]}]
    response = model.stream(messages, None, None)

    # Consume the response
    [event async for event in response]

    # The events should be formatted through format_chunk, so they should be StreamEvent objects
    expected_request = {
        "model": model_id,
        "messages": [{"role": "user", "content": [{"type": "text", "text": "calculate 2+2"}]}],
        "stream": True,
        "stream_options": {"include_usage": True},
    }

    writer_client.chat.chat.assert_called_once_with(**expected_request)


@pytest.mark.asyncio
async def test_stream_empty(writer_client, model, model_id):
    mock_delta = unittest.mock.Mock(content=None, tool_calls=None)
    mock_usage = unittest.mock.Mock(prompt_tokens=0, completion_tokens=0, total_tokens=0)

    mock_event_1 = unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason=None, delta=mock_delta)])
    mock_event_2 = unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason="stop", delta=mock_delta)])
    mock_event_3 = unittest.mock.Mock()
    mock_event_4 = unittest.mock.Mock(usage=mock_usage)

    writer_client.chat.chat.return_value = mock_streaming_response(
        [mock_event_1, mock_event_2, mock_event_3, mock_event_4]
    )

    messages = [{"role": "user", "content": []}]
    response = model.stream(messages, None, None)

    # Consume the response
    [event async for event in response]

    expected_request = {
        "model": model_id,
        "messages": [],
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    writer_client.chat.chat.assert_called_once_with(**expected_request)


@pytest.mark.asyncio
async def test_stream_with_empty_choices(writer_client, model, model_id, captured_warnings):
    mock_delta = unittest.mock.Mock(content="content", tool_calls=None)
    mock_usage = unittest.mock.Mock(prompt_tokens=10, completion_tokens=20, total_tokens=30)

    mock_event_1 = unittest.mock.Mock(spec=[])
    mock_event_2 = unittest.mock.Mock(choices=[])
    mock_event_3 = unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason=None, delta=mock_delta)])
    mock_event_4 = unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason="stop", delta=mock_delta)])
    mock_event_5 = unittest.mock.Mock(usage=mock_usage)

    writer_client.chat.chat.return_value = mock_streaming_response(
        [mock_event_1, mock_event_2, mock_event_3, mock_event_4, mock_event_5]
    )

    messages = [{"role": "user", "content": [{"text": "test"}]}]
    response = model.stream(messages, None, None)

    # Consume the response
    [event async for event in response]

    expected_request = {
        "model": model_id,
        "messages": [{"role": "user", "content": [{"text": "test", "type": "text"}]}],
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    writer_client.chat.chat.assert_called_once_with(**expected_request)

    # Ensure no warnings emitted
    assert len(captured_warnings) == 0


@pytest.mark.asyncio
async def test_tool_choice_not_supported_warns(writer_client, model, model_id, captured_warnings, alist):
    mock_delta = unittest.mock.Mock(content="content", tool_calls=None)
    mock_usage = unittest.mock.Mock(prompt_tokens=10, completion_tokens=20, total_tokens=30)

    mock_event_1 = unittest.mock.Mock(spec=[])
    mock_event_2 = unittest.mock.Mock(choices=[])
    mock_event_3 = unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason=None, delta=mock_delta)])
    mock_event_4 = unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason="stop", delta=mock_delta)])
    mock_event_5 = unittest.mock.Mock(usage=mock_usage)

    writer_client.chat.chat.return_value = mock_streaming_response(
        [mock_event_1, mock_event_2, mock_event_3, mock_event_4, mock_event_5]
    )

    messages = [{"role": "user", "content": [{"text": "test"}]}]
    response = model.stream(messages, None, None, tool_choice={"auto": {}})

    # Consume the response
    await alist(response)

    expected_request = {
        "model": model_id,
        "messages": [{"role": "user", "content": [{"text": "test", "type": "text"}]}],
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    writer_client.chat.chat.assert_called_once_with(**expected_request)

    # Ensure expected warning is invoked
    assert len(captured_warnings) == 1
    assert "ToolChoice was provided to this provider but is not supported" in str(captured_warnings[0].message)


def test_config_validation_warns_on_unknown_keys(writer_client, captured_warnings):
    """Test that unknown config keys emit a warning."""
    WriterModel({"api_key": "test"}, model_id="test-model", invalid_param="test")

    assert len(captured_warnings) == 1
    assert "Invalid configuration parameters" in str(captured_warnings[0].message)
    assert "invalid_param" in str(captured_warnings[0].message)


def test_update_config_validation_warns_on_unknown_keys(model, captured_warnings):
    """Test that update_config warns on unknown keys."""
    model.update_config(wrong_param="test")

    assert len(captured_warnings) == 1
    assert "Invalid configuration parameters" in str(captured_warnings[0].message)
    assert "wrong_param" in str(captured_warnings[0].message)


def test_format_request_filters_s3_source_image(model, caplog):
    """Test that images with Location sources are filtered out with warning."""
    caplog.set_level(logging.WARNING, logger="strands.models.writer")

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

    request = model.format_request(messages)

    # Image with S3 source should be filtered, text should remain
    formatted_messages = request["messages"]
    user_content = formatted_messages[0]["content"]
    assert len(user_content) == 1
    assert user_content[0]["type"] == "text"
    assert "Location sources are not supported by Writer" in caplog.text


def test_format_request_filters_location_source_document(model, caplog):
    """Test that documents with Location sources are filtered out with warning."""
    caplog.set_level(logging.WARNING, logger="strands.models.writer")

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

    request = model.format_request(messages)

    # Document with S3 source should be filtered, text should remain
    formatted_messages = request["messages"]
    user_content = formatted_messages[0]["content"]
    assert len(user_content) == 1
    assert user_content[0]["type"] == "text"
    assert "Location sources are not supported by Writer" in caplog.text


@pytest.mark.parametrize(
    "overflow_message",
    [
        "This model's maximum context length is 32768 tokens",
        "prompt is too long",
        "too many tokens in request",
    ],
)
@pytest.mark.asyncio
async def test_stream_context_overflow_error(overflow_message, writer_client, model, alist):
    error = writerai.BadRequestError(overflow_message, response=unittest.mock.Mock(), body=None)
    writer_client.chat.chat = unittest.mock.AsyncMock(side_effect=error)

    messages = [{"role": "user", "content": [{"text": "test"}]}]
    with pytest.raises(ContextWindowOverflowException) as exc_info:
        await alist(model.stream(messages))

    assert overflow_message in str(exc_info.value)
    assert exc_info.value.__cause__ == error


@pytest.mark.asyncio
async def test_stream_non_overflow_bad_request_propagates(writer_client, model, alist):
    error = writerai.BadRequestError("invalid 'model' parameter", response=unittest.mock.Mock(), body=None)
    writer_client.chat.chat = unittest.mock.AsyncMock(side_effect=error)

    messages = [{"role": "user", "content": [{"text": "test"}]}]
    with pytest.raises(writerai.BadRequestError, match="invalid 'model' parameter"):
        await alist(model.stream(messages))


@pytest.mark.asyncio
async def test_structured_output_context_overflow_error(writer_client, model, test_output_model_cls, alist):
    error = writerai.BadRequestError(
        "This model's maximum context length is 32768 tokens", response=unittest.mock.Mock(), body=None
    )
    writer_client.chat.chat = unittest.mock.AsyncMock(side_effect=error)

    messages = [{"role": "user", "content": [{"text": "test"}]}]
    with pytest.raises(ContextWindowOverflowException) as exc_info:
        await alist(model.structured_output(test_output_model_cls, messages))

    assert "maximum context length" in str(exc_info.value)
    assert exc_info.value.__cause__ == error


@pytest.mark.asyncio
async def test_structured_output_non_overflow_bad_request_propagates(
    writer_client, model, test_output_model_cls, alist
):
    error = writerai.BadRequestError("invalid 'model' parameter", response=unittest.mock.Mock(), body=None)
    writer_client.chat.chat = unittest.mock.AsyncMock(side_effect=error)

    messages = [{"role": "user", "content": [{"text": "test"}]}]
    with pytest.raises(writerai.BadRequestError, match="invalid 'model' parameter"):
        await alist(model.structured_output(test_output_model_cls, messages))


def test_cache_config_round_trips(writer_client, model_id, captured_warnings):
    """cache_config is a valid config field and survives get_config/update_config unchanged."""
    _ = writer_client
    cache_config = CacheConfig()
    model = WriterModel(model_id=model_id, cache_config=cache_config)

    assert model.get_config()["cache_config"] is cache_config

    updated = CacheConfig()
    model.update_config(cache_config=updated)
    assert model.get_config()["cache_config"] is updated

    assert not any("Invalid configuration parameters" in str(warning.message) for warning in captured_warnings)


def test_cache_config_default_is_silent_and_not_routed(writer_client, model_id, messages, captured_warnings):
    """A CacheConfig whose fields are all default warns about nothing and never reaches the request."""
    _ = writer_client
    model = WriterModel(model_id=model_id, cache_config=CacheConfig(strategy="auto"))

    request = model.format_request(messages)

    assert "cache_config" not in request
    assert not any("have no effect" in str(warning.message) for warning in captured_warnings)


@pytest.mark.parametrize(
    ("cache_config", "field"),
    [
        (CacheConfig(strategy="anthropic"), "strategy"),
        (CacheConfig(ttl="1h"), "ttl"),
        (CacheConfig(system_prompt_ttl="1h"), "system_prompt_ttl"),
        (CacheConfig(cache_key="tenant-42"), "cache_key"),
        (CacheConfig(tools_ttl=True), "tools_ttl"),
    ],
)
def test_cache_config_unsupported_field_warns_and_is_not_routed(writer_client, model_id, messages, cache_config, field):
    """Writer honors no cache field: a non-default field warns (naming the provider) and never reaches the request."""
    _ = writer_client
    model = WriterModel(model_id=model_id, cache_config=cache_config)

    with pytest.warns(UserWarning, match=rf"fields \['{field}'\] have no effect on Writer"):
        request = model.format_request(messages)

    assert "cache_config" not in request
