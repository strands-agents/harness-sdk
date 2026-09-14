# Copyright (c) Meta Platforms, Inc. and affiliates
import logging
import unittest.mock

import llama_api_client
import pytest

import strands
from strands.models.llamaapi import LlamaAPIModel
from strands.types.exceptions import ContextWindowOverflowException


@pytest.fixture
def llamaapi_client():
    with unittest.mock.patch.object(strands.models.llamaapi, "LlamaAPIClient") as mock_client_cls:
        yield mock_client_cls.return_value


@pytest.fixture
def model_id():
    return "Llama-4-Maverick-17B-128E-Instruct-FP8"


@pytest.fixture
def model(llamaapi_client, model_id):
    _ = llamaapi_client

    return LlamaAPIModel(model_id=model_id)


@pytest.fixture
def messages():
    return [{"role": "user", "content": [{"text": "test"}]}]


@pytest.fixture
def system_prompt():
    return "s1"


def test__init__model_configs(llamaapi_client, model_id):
    _ = llamaapi_client

    model = LlamaAPIModel(model_id=model_id, temperature=1)

    tru_temperature = model.get_config().get("temperature")
    exp_temperature = 1

    assert tru_temperature == exp_temperature


def test__init__emits_deprecation_warning(llamaapi_client, model_id):
    _ = llamaapi_client

    with pytest.warns(DeprecationWarning, match="LlamaAPIModel is deprecated"):
        LlamaAPIModel(model_id=model_id)


def test_update_config(model, model_id):
    model.update_config(model_id=model_id)

    tru_model_id = model.get_config().get("model_id")
    exp_model_id = model_id

    assert tru_model_id == exp_model_id


def test_format_request_default(model, messages, model_id):
    tru_request = model.format_request(messages)
    exp_request = {
        "messages": [{"role": "user", "content": [{"type": "text", "text": "test"}]}],
        "model": model_id,
        "tools": [],
        "stream": True,
    }

    assert tru_request == exp_request


def test_format_request_with_params(model, messages, model_id):
    model.update_config(temperature=1)

    tru_request = model.format_request(messages)
    exp_request = {
        "messages": [{"role": "user", "content": [{"type": "text", "text": "test"}]}],
        "model": model_id,
        "tools": [],
        "temperature": 1,
        "stream": True,
    }

    assert tru_request == exp_request


def test_format_request_with_system_prompt(model, messages, model_id, system_prompt):
    tru_request = model.format_request(messages, system_prompt=system_prompt)
    exp_request = {
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": [{"type": "text", "text": "test"}]},
        ],
        "model": model_id,
        "tools": [],
        "stream": True,
    }

    assert tru_request == exp_request


def test_format_request_with_image(model, model_id):
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "image": {
                        "format": "jpg",
                        "source": {"bytes": b"base64encodedimage"},
                    },
                },
            ],
        },
    ]

    tru_request = model.format_request(messages)
    exp_request = {
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "image_url": {
                            "url": "data:image/jpeg;base64,YmFzZTY0ZW5jb2RlZGltYWdl",
                        },
                        "type": "image_url",
                    },
                ],
            },
        ],
        "model": model_id,
        "stream": True,
        "tools": [],
    }

    assert tru_request == exp_request


def test_format_request_with_tool_use_preserves_non_ascii(model, model_id):
    messages = [
        {
            "role": "assistant",
            "content": [{"toolUse": {"toolUseId": "c1", "name": "search", "input": {"query": "東京"}}}],
        },
    ]

    tru_request = model.format_request(messages)
    exp_request = {
        "messages": [
            {
                "content": "",
                "role": "assistant",
                "tool_calls": [
                    {
                        "function": {
                            "name": "search",
                            "arguments": '{"query": "東京"}',
                        },
                        "id": "c1",
                    }
                ],
            }
        ],
        "model": model_id,
        "stream": True,
        "tools": [],
    }

    assert tru_request == exp_request


def test_format_request_with_tool_result_preserves_non_ascii(model, model_id):
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

    tru_request = model.format_request(messages)
    exp_request = {
        "messages": [
            {
                "content": [{"text": '{"city": "東京"}', "type": "text"}],
                "role": "tool",
                "tool_call_id": "c1",
            },
        ],
        "model": model_id,
        "stream": True,
        "tools": [],
    }

    assert tru_request == exp_request


def test_format_request_with_tool_result(model, model_id):
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "c1",
                        "status": "success",
                        "content": [{"text": "4"}, {"json": ["4"]}],
                    }
                }
            ],
        }
    ]

    tru_request = model.format_request(messages)
    exp_request = {
        "messages": [
            {
                "content": [{"text": "4", "type": "text"}, {"text": '["4"]', "type": "text"}],
                "role": "tool",
                "tool_call_id": "c1",
            },
        ],
        "model": model_id,
        "stream": True,
        "tools": [],
    }

    assert tru_request == exp_request


def test_format_request_with_tool_use(model, model_id):
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

    tru_request = model.format_request(messages)
    exp_request = {
        "messages": [
            {
                "content": "",
                "role": "assistant",
                "tool_calls": [
                    {
                        "function": {
                            "name": "calculator",
                            "arguments": '{"expression": "2+2"}',
                        },
                        "id": "c1",
                    }
                ],
            }
        ],
        "model": model_id,
        "stream": True,
        "tools": [],
    }

    assert tru_request == exp_request


def test_format_request_with_empty_content(model, model_id):
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
        "tools": [],
        "stream": True,
    }

    assert tru_request == exp_request


def test_format_request_with_unsupported_type(model):
    messages = [
        {
            "role": "user",
            "content": [{"unsupported": {}}],
        },
    ]

    with pytest.raises(TypeError, match="content_type=<unsupported> | unsupported type"):
        model.format_request(messages)


def test_format_chunk_message_start(model):
    event = {"chunk_type": "message_start"}

    tru_chunk = model.format_chunk(event)
    exp_chunk = {"messageStart": {"role": "assistant"}}

    assert tru_chunk == exp_chunk


def test_format_chunk_content_start_text(model):
    event = {"chunk_type": "content_start", "data_type": "text"}

    tru_chunk = model.format_chunk(event)
    exp_chunk = {"contentBlockStart": {"start": {}}}

    assert tru_chunk == exp_chunk


def test_format_chunk_content_start_tool(model):
    mock_tool_use = unittest.mock.Mock()
    mock_tool_use.function.name = "calculator"
    mock_tool_use.id = "c1"

    event = {"chunk_type": "content_start", "data_type": "tool", "data": mock_tool_use}

    tru_chunk = model.format_chunk(event)
    exp_chunk = {"contentBlockStart": {"start": {"toolUse": {"name": "calculator", "toolUseId": "c1"}}}}

    assert tru_chunk == exp_chunk


def test_format_chunk_content_delta_text(model):
    event = {"chunk_type": "content_delta", "data_type": "text", "data": "Hello"}

    tru_chunk = model.format_chunk(event)
    exp_chunk = {"contentBlockDelta": {"delta": {"text": "Hello"}}}

    assert tru_chunk == exp_chunk


def test_format_chunk_content_delta_tool(model):
    event = {
        "chunk_type": "content_delta",
        "data_type": "tool",
        "data": unittest.mock.Mock(function=unittest.mock.Mock(arguments='{"expression": "2+2"}')),
    }

    tru_chunk = model.format_chunk(event)
    exp_chunk = {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"expression": "2+2"}'}}}}

    assert tru_chunk == exp_chunk


def test_format_chunk_content_stop(model):
    event = {"chunk_type": "content_stop"}

    tru_chunk = model.format_chunk(event)
    exp_chunk = {"contentBlockStop": {}}

    assert tru_chunk == exp_chunk


def test_format_chunk_message_stop_end_turn(model):
    event = {"chunk_type": "message_stop", "data": "stop"}

    tru_chunk = model.format_chunk(event)
    exp_chunk = {"messageStop": {"stopReason": "end_turn"}}

    assert tru_chunk == exp_chunk


def test_format_chunk_message_stop_tool_use(model):
    event = {"chunk_type": "message_stop", "data": "tool_calls"}

    tru_chunk = model.format_chunk(event)
    exp_chunk = {"messageStop": {"stopReason": "tool_use"}}

    assert tru_chunk == exp_chunk


def test_format_chunk_message_stop_max_tokens(model):
    event = {"chunk_type": "message_stop", "data": "length"}

    tru_chunk = model.format_chunk(event)
    exp_chunk = {"messageStop": {"stopReason": "max_tokens"}}

    assert tru_chunk == exp_chunk


def test_format_chunk_metadata(model):
    event = {
        "chunk_type": "metadata",
        "data": [
            unittest.mock.Mock(metric="num_prompt_tokens", value=100),
            unittest.mock.Mock(metric="num_completion_tokens", value=50),
            unittest.mock.Mock(metric="num_total_tokens", value=150),
        ],
    }

    tru_chunk = model.format_chunk(event)
    exp_chunk = {
        "metadata": {
            "usage": {
                "inputTokens": 100,
                "outputTokens": 50,
                "totalTokens": 150,
            },
            "metrics": {
                "latencyMs": 0,
            },
        },
    }

    assert tru_chunk == exp_chunk


def test_format_chunk_other(model):
    event = {"chunk_type": "other"}

    with pytest.raises(RuntimeError, match="chunk_type=<other> | unknown type"):
        model.format_chunk(event)


def test_config_validation_warns_on_unknown_keys(llamaapi_client, captured_warnings):
    """Test that unknown config keys emit a warning."""
    LlamaAPIModel(model_id="test-model", invalid_param="test")

    user_warnings = [warning for warning in captured_warnings if issubclass(warning.category, UserWarning)]
    assert len(user_warnings) == 1
    assert "Invalid configuration parameters" in str(user_warnings[0].message)
    assert "invalid_param" in str(user_warnings[0].message)


def test_update_config_validation_warns_on_unknown_keys(model, captured_warnings):
    """Test that update_config warns on unknown keys."""
    model.update_config(wrong_param="test")

    assert len(captured_warnings) == 1
    assert "Invalid configuration parameters" in str(captured_warnings[0].message)
    assert "wrong_param" in str(captured_warnings[0].message)


@pytest.mark.asyncio
async def test_tool_choice_not_supported_warns(model, messages, captured_warnings, alist):
    """Test that non-None toolChoice emits warning for unsupported providers."""
    tool_choice = {"auto": {}}

    with unittest.mock.patch.object(model.client.chat.completions, "create") as mock_create:
        mock_chunk = unittest.mock.Mock()
        mock_chunk.event.event_type = "start"
        mock_chunk.event.stop_reason = "stop"

        mock_create.return_value = [mock_chunk]

        response = model.stream(messages, tool_choice=tool_choice)
        await alist(response)

    assert len(captured_warnings) == 1
    assert "ToolChoice was provided to this provider but is not supported" in str(captured_warnings[0].message)


@pytest.mark.asyncio
async def test_tool_choice_none_no_warning(model, messages, captured_warnings, alist):
    """Test that None toolChoice doesn't emit warning."""
    with unittest.mock.patch.object(model.client.chat.completions, "create") as mock_create:
        mock_chunk = unittest.mock.Mock()
        mock_chunk.event.event_type = "start"
        mock_chunk.event.stop_reason = "stop"

        mock_create.return_value = [mock_chunk]

        response = model.stream(messages, tool_choice=None)
        await alist(response)

    assert len(captured_warnings) == 0


def test_format_request_filters_s3_source_image(model, caplog):
    """Test that images with Location sources are filtered out with warning."""
    caplog.set_level(logging.WARNING, logger="strands.models.llamaapi")

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
    assert "Location sources are not supported by LlamaAPI" in caplog.text


def test_format_request_filters_location_source_document(model, caplog):
    """Test that documents with Location sources are filtered out with warning."""
    caplog.set_level(logging.WARNING, logger="strands.models.llamaapi")

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
    assert "Location sources are not supported by LlamaAPI" in caplog.text


@pytest.mark.parametrize(
    "overflow_message",
    [
        "This model's maximum context length is 128000 tokens",
        "prompt is too long",
        "too many tokens in request",
    ],
)
@pytest.mark.asyncio
async def test_stream_context_overflow_error(overflow_message, model, messages, alist):
    error = llama_api_client.BadRequestError(overflow_message, response=unittest.mock.Mock(), body=None)
    with unittest.mock.patch.object(model.client.chat.completions, "create", side_effect=error):
        with pytest.raises(ContextWindowOverflowException) as exc_info:
            await alist(model.stream(messages))

    assert overflow_message in str(exc_info.value)
    assert exc_info.value.__cause__ == error


@pytest.mark.asyncio
async def test_stream_non_overflow_bad_request_propagates(model, messages, alist):
    error = llama_api_client.BadRequestError("invalid 'model' parameter", response=unittest.mock.Mock(), body=None)
    with unittest.mock.patch.object(model.client.chat.completions, "create", side_effect=error):
        with pytest.raises(llama_api_client.BadRequestError, match="invalid 'model' parameter"):
            await alist(model.stream(messages))
