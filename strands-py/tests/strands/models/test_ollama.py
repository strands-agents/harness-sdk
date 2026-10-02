import json
import logging
import re
import unittest.mock

import ollama
import pydantic
import pytest

import strands
from strands.models.model import CacheConfig
from strands.models.ollama import OllamaModel
from strands.types.content import Messages
from strands.types.exceptions import ContextWindowOverflowException


@pytest.fixture
def ollama_client():
    with unittest.mock.patch.object(strands.models.ollama.ollama, "AsyncClient") as mock_client_cls:
        yield mock_client_cls.return_value


@pytest.fixture
def model_id():
    return "m1"


@pytest.fixture
def host():
    return "h1"


@pytest.fixture
def model(model_id, host):
    return OllamaModel(host, model_id=model_id)


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


def test__init__model_configs(ollama_client, model_id, host):
    _ = ollama_client

    model = OllamaModel(host, model_id=model_id, max_tokens=1)

    tru_max_tokens = model.get_config().get("max_tokens")
    exp_max_tokens = 1

    assert tru_max_tokens == exp_max_tokens


def test_update_config(model, model_id):
    model.update_config(model_id=model_id)

    tru_model_id = model.get_config().get("model_id")
    exp_model_id = model_id

    assert tru_model_id == exp_model_id


def test_format_request_default(model, messages, model_id):
    tru_request = model.format_request(messages)
    exp_request = {
        "messages": [{"role": "user", "content": "test"}],
        "model": model_id,
        "options": {},
        "stream": True,
        "tools": [],
    }

    assert tru_request == exp_request


def test_format_request_with_override(model, messages, model_id):
    model.update_config(model_id=model_id)
    tru_request = model.format_request(messages, tool_specs=None)
    exp_request = {
        "messages": [{"role": "user", "content": "test"}],
        "model": model_id,
        "options": {},
        "stream": True,
        "tools": [],
    }

    assert tru_request == exp_request


def test_format_request_with_system_prompt(model, messages, model_id, system_prompt):
    tru_request = model.format_request(messages, system_prompt=system_prompt)
    exp_request = {
        "messages": [{"role": "system", "content": system_prompt}, {"role": "user", "content": "test"}],
        "model": model_id,
        "options": {},
        "stream": True,
        "tools": [],
    }

    assert tru_request == exp_request


def test_format_request_with_image(model, model_id):
    messages = [{"role": "user", "content": [{"image": {"source": {"bytes": "base64encodedimage"}}}]}]

    tru_request = model.format_request(messages)
    exp_request = {
        "messages": [{"role": "user", "images": ["base64encodedimage"]}],
        "model": model_id,
        "options": {},
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
                "role": "tool",
                "content": '{"city": "東京"}',
            },
        ],
        "model": model_id,
        "options": {},
        "stream": True,
        "tools": [],
    }

    assert tru_request == exp_request


def test_format_request_with_tool_use(model, model_id):
    messages = [
        {
            "role": "assistant",
            "content": [
                {"toolUse": {"toolUseId": "tool-use-id-123", "name": "calculator", "input": '{"expression": "2+2"}'}}
            ],
        }
    ]

    tru_request = model.format_request(messages)
    exp_request = {
        "messages": [
            {
                "role": "assistant",
                "tool_calls": [
                    {
                        "function": {
                            "name": "calculator",
                            "arguments": '{"expression": "2+2"}',
                        }
                    }
                ],
            }
        ],
        "model": model_id,
        "options": {},
        "stream": True,
        "tools": [],
    }

    assert tru_request == exp_request


def test_format_request_with_tool_result(model, model_id):
    messages: Messages = [
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "calculator",
                        "status": "success",
                        "content": [
                            {"text": "4"},
                            {"image": {"source": {"bytes": b"image"}}},
                            {"json": ["4"]},
                        ],
                    },
                },
                {
                    "text": "see results",
                },
            ],
        },
    ]

    tru_request = model.format_request(messages)
    exp_request = {
        "messages": [
            {
                "role": "tool",
                "content": "4",
            },
            {
                "role": "tool",
                "images": [b"image"],
            },
            {
                "role": "tool",
                "content": '["4"]',
            },
            {
                "role": "user",
                "content": "see results",
            },
        ],
        "model": model_id,
        "options": {},
        "stream": True,
        "tools": [],
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


def test_format_request_with_tool_specs(model, messages, model_id):
    tool_specs = [
        {
            "name": "calculator",
            "description": "Calculate mathematical expressions",
            "inputSchema": {
                "json": {"type": "object", "properties": {"expression": {"type": "string"}}, "required": ["expression"]}
            },
        }
    ]

    tru_request = model.format_request(messages, tool_specs)
    exp_request = {
        "messages": [{"role": "user", "content": "test"}],
        "model": model_id,
        "options": {},
        "stream": True,
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "calculator",
                    "description": "Calculate mathematical expressions",
                    "parameters": {
                        "type": "object",
                        "properties": {"expression": {"type": "string"}},
                        "required": ["expression"],
                    },
                },
            }
        ],
    }

    assert tru_request == exp_request


def test_format_request_with_inference_config(model, messages, model_id):
    inference_config = {
        "max_tokens": 1,
        "stop_sequences": ["stop"],
        "temperature": 1,
        "top_p": 1,
    }

    model.update_config(**inference_config)
    tru_request = model.format_request(messages)
    exp_request = {
        "messages": [{"role": "user", "content": "test"}],
        "model": model_id,
        "options": {
            "num_predict": inference_config["max_tokens"],
            "temperature": inference_config["temperature"],
            "top_p": inference_config["top_p"],
            "stop": inference_config["stop_sequences"],
        },
        "stream": True,
        "tools": [],
    }

    assert tru_request == exp_request


def test_format_request_with_options(model, messages, model_id):
    options = {"o1": 1}

    model.update_config(options=options)
    tru_request = model.format_request(messages)
    exp_request = {
        "messages": [{"role": "user", "content": "test"}],
        "model": model_id,
        "options": {"o1": 1},
        "stream": True,
        "tools": [],
    }

    assert tru_request == exp_request


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
    mock_function = unittest.mock.Mock()
    mock_function.function.name = "calculator"

    event = {"chunk_type": "content_start", "data_type": "tool", "data": mock_function}

    tru_chunk = model.format_chunk(event)
    tool_use = tru_chunk["contentBlockStart"]["start"]["toolUse"]

    assert tool_use["name"] == "calculator"
    assert tool_use["toolUseId"] != "calculator"
    assert len(tool_use["toolUseId"]) > 0


def test_format_chunk_content_delta_text(model):
    event = {"chunk_type": "content_delta", "data_type": "text", "data": "Hello"}

    tru_chunk = model.format_chunk(event)
    exp_chunk = {"contentBlockDelta": {"delta": {"text": "Hello"}}}

    assert tru_chunk == exp_chunk


def test_format_chunk_content_delta_tool(model):
    event = {
        "chunk_type": "content_delta",
        "data_type": "tool",
        "data": unittest.mock.Mock(function=unittest.mock.Mock(arguments={"expression": "2+2"})),
    }

    tru_chunk = model.format_chunk(event)
    exp_chunk = {"contentBlockDelta": {"delta": {"toolUse": {"input": json.dumps({"expression": "2+2"})}}}}

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
    event = {"chunk_type": "message_stop", "data": "tool_use"}

    tru_chunk = model.format_chunk(event)
    exp_chunk = {"messageStop": {"stopReason": "tool_use"}}

    assert tru_chunk == exp_chunk


def test_format_chunk_message_stop_length(model):
    event = {"chunk_type": "message_stop", "data": "length"}

    tru_chunk = model.format_chunk(event)
    exp_chunk = {"messageStop": {"stopReason": "max_tokens"}}

    assert tru_chunk == exp_chunk


def test_format_chunk_metadata(model):
    event = {
        "chunk_type": "metadata",
        "data": unittest.mock.Mock(eval_count=100, prompt_eval_count=50, total_duration=1000000),
    }

    tru_chunk = model.format_chunk(event)
    exp_chunk = {
        "metadata": {
            "usage": {
                "inputTokens": 50,
                "outputTokens": 100,
                "totalTokens": 150,
            },
            "metrics": {
                "latencyMs": 1,
            },
        },
    }

    assert tru_chunk == exp_chunk


def test_format_chunk_other(model):
    event = {"chunk_type": "other"}

    with pytest.raises(RuntimeError, match="chunk_type=<other> | unknown type"):
        model.format_chunk(event)


@pytest.mark.asyncio
async def test_stream(ollama_client, model, agenerator, alist, captured_warnings):
    mock_event = unittest.mock.Mock()
    mock_event.message.tool_calls = None
    mock_event.message.content = "Hello"
    mock_event.done_reason = "stop"
    mock_event.eval_count = 10
    mock_event.prompt_eval_count = 5
    mock_event.total_duration = 1000000  # 1ms in nanoseconds

    ollama_client.chat = unittest.mock.AsyncMock(return_value=agenerator([mock_event]))

    messages = [{"role": "user", "content": [{"text": "Hello"}]}]
    response = model.stream(messages)

    tru_events = await alist(response)
    exp_events = [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockStart": {"start": {}}},
        {"contentBlockDelta": {"delta": {"text": "Hello"}}},
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "end_turn"}},
        {
            "metadata": {
                "usage": {"inputTokens": 5, "outputTokens": 10, "totalTokens": 15},
                "metrics": {"latencyMs": 1},
            }
        },
    ]

    assert tru_events == exp_events
    expected_request = {
        "model": "m1",
        "messages": [{"role": "user", "content": "Hello"}],
        "options": {},
        "stream": True,
        "tools": [],
    }
    ollama_client.chat.assert_called_once_with(**expected_request)

    # Ensure no warnings emitted
    assert len(captured_warnings) == 0


@pytest.mark.asyncio
async def test_stream_empty_response(ollama_client, model, agenerator, alist):
    ollama_client.chat = unittest.mock.AsyncMock(return_value=agenerator([]))

    messages = [{"role": "user", "content": [{"text": "Hello"}]}]
    response = model.stream(messages)

    tru_events = await alist(response)
    exp_events = [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockStart": {"start": {}}},
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "end_turn"}},
    ]

    assert tru_events == exp_events


@pytest.mark.asyncio
async def test_tool_choice_not_supported_warns(ollama_client, model, agenerator, alist, captured_warnings):
    """Test that non-None toolChoice emits warning for unsupported providers."""
    tool_choice = {"auto": {}}

    mock_event = unittest.mock.Mock()
    mock_event.message.tool_calls = None
    mock_event.message.content = "Hello"
    mock_event.done_reason = "stop"
    mock_event.eval_count = 10
    mock_event.prompt_eval_count = 5
    mock_event.total_duration = 1000000  # 1ms in nanoseconds

    ollama_client.chat = unittest.mock.AsyncMock(return_value=agenerator([mock_event]))

    messages = [{"role": "user", "content": [{"text": "Hello"}]}]
    await alist(model.stream(messages, tool_choice=tool_choice))

    assert len(captured_warnings) == 1
    assert "ToolChoice was provided to this provider but is not supported" in str(captured_warnings[0].message)


@pytest.mark.asyncio
async def test_stream_with_tool_calls(ollama_client, model, agenerator, alist):
    mock_event = unittest.mock.Mock()
    mock_tool_call = unittest.mock.Mock()
    mock_tool_call.function.name = "calculator"
    mock_tool_call.function.arguments = {"expression": "2+2"}
    mock_event.message.tool_calls = [mock_tool_call]
    mock_event.message.content = "I'll calculate that for you"
    mock_event.done_reason = "stop"
    mock_event.eval_count = 15
    mock_event.prompt_eval_count = 8
    mock_event.total_duration = 2000000  # 2ms in nanoseconds

    ollama_client.chat = unittest.mock.AsyncMock(return_value=agenerator([mock_event]))

    messages = [{"role": "user", "content": [{"text": "Calculate 2+2"}]}]
    response = model.stream(messages)

    tru_events = await alist(response)

    # Verify the tool use event has a unique ID (not equal to the tool name)
    tool_start_event = tru_events[2]
    tool_use = tool_start_event["contentBlockStart"]["start"]["toolUse"]
    assert tool_use["name"] == "calculator"
    assert tool_use["toolUseId"] != "calculator"

    # Verify all other events
    assert tru_events[0] == {"messageStart": {"role": "assistant"}}
    assert tru_events[1] == {"contentBlockStart": {"start": {}}}
    assert tru_events[3] == {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"expression": "2+2"}'}}}}
    assert tru_events[4] == {"contentBlockStop": {}}
    assert tru_events[5] == {"contentBlockDelta": {"delta": {"text": "I'll calculate that for you"}}}
    assert tru_events[6] == {"contentBlockStop": {}}
    assert tru_events[7] == {"messageStop": {"stopReason": "tool_use"}}
    assert tru_events[8] == {
        "metadata": {
            "usage": {"inputTokens": 8, "outputTokens": 15, "totalTokens": 23},
            "metrics": {"latencyMs": 2},
        }
    }
    expected_request = {
        "model": "m1",
        "messages": [{"role": "user", "content": "Calculate 2+2"}],
        "options": {},
        "stream": True,
        "tools": [],
    }
    ollama_client.chat.assert_called_once_with(**expected_request)


@pytest.mark.asyncio
async def test_structured_output(ollama_client, model, test_output_model_cls, alist):
    messages = [{"role": "user", "content": [{"text": "Generate a person"}]}]

    mock_response = unittest.mock.Mock()
    mock_response.message.content = '{"name": "John", "age": 30}'

    ollama_client.chat = unittest.mock.AsyncMock(return_value=mock_response)

    stream = model.structured_output(test_output_model_cls, messages)
    events = await alist(stream)

    tru_result = events[-1]
    exp_result = {"output": test_output_model_cls(name="John", age=30)}
    assert tru_result == exp_result


def test_config_validation_warns_on_unknown_keys(ollama_client, captured_warnings):
    """Test that unknown config keys emit a warning."""
    OllamaModel("http://localhost:11434", model_id="test-model", invalid_param="test")

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
    caplog.set_level(logging.WARNING, logger="strands.models.ollama")

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
    user_message = formatted_messages[0]
    assert user_message["content"] == "look at this image"
    assert "images" not in user_message or user_message.get("images") == []
    assert "Location sources are not supported by Ollama" in caplog.text


def test_format_request_filters_location_source_document(model, caplog):
    """Test that documents with Location sources are filtered out with warning."""
    caplog.set_level(logging.WARNING, logger="strands.models.ollama")

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
    user_message = formatted_messages[0]
    assert user_message["content"] == "analyze this document"
    assert "Location sources are not supported by Ollama" in caplog.text


def test_tool_use_id_is_unique_and_not_tool_name(model):
    """Test that toolUseId is a unique UUID, not the tool name."""
    mock_function = unittest.mock.Mock()
    mock_function.function.name = "calculator"

    event = {"chunk_type": "content_start", "data_type": "tool", "data": mock_function}

    chunk1 = model.format_chunk(event)
    chunk2 = model.format_chunk(event)

    tool_use1 = chunk1["contentBlockStart"]["start"]["toolUse"]
    tool_use2 = chunk2["contentBlockStart"]["start"]["toolUse"]

    # toolUseId should not equal the tool name
    assert tool_use1["toolUseId"] != "calculator"
    assert tool_use2["toolUseId"] != "calculator"

    # toolUseId should be unique across calls
    assert tool_use1["toolUseId"] != tool_use2["toolUseId"]

    # toolUseId should follow the tooluse_<24-hex> convention used by other providers
    assert re.fullmatch(r"tooluse_[0-9a-f]{24}", tool_use1["toolUseId"])
    assert re.fullmatch(r"tooluse_[0-9a-f]{24}", tool_use2["toolUseId"])

    # name should still be correct
    assert tool_use1["name"] == "calculator"
    assert tool_use2["name"] == "calculator"


def test_format_request_uses_tool_name_not_tool_use_id(model, model_id):
    """Test that format_request uses the 'name' field, not 'toolUseId', for the function name."""
    messages = [
        {
            "role": "assistant",
            "content": [
                {
                    "toolUse": {
                        "toolUseId": "unique-id-abc-123",
                        "name": "calculator",
                        "input": '{"expression": "1+1"}',
                    }
                }
            ],
        }
    ]

    request = model.format_request(messages)
    tool_call = request["messages"][0]["tool_calls"][0]

    # The function name in the request must come from "name", not "toolUseId"
    assert tool_call["function"]["name"] == "calculator"
    assert tool_call["function"]["name"] != "unique-id-abc-123"


@pytest.mark.asyncio
async def test_stream_context_overflow_error_on_request(ollama_client, model, alist):
    error = ollama.ResponseError("request exceeds the available context size (2048 tokens), try increasing it")
    ollama_client.chat = unittest.mock.AsyncMock(side_effect=error)

    messages = [{"role": "user", "content": [{"text": "test"}]}]
    with pytest.raises(ContextWindowOverflowException) as exc_info:
        await alist(model.stream(messages))

    assert "exceeds the available context size" in str(exc_info.value)
    assert exc_info.value.__cause__ == error


@pytest.mark.asyncio
async def test_stream_context_overflow_error_during_iteration(ollama_client, model, alist):
    error = ollama.ResponseError("the prompt is longer than the context length currently available to the model")

    async def overflowing_stream():
        raise error
        yield  # pragma: no cover - generator never yields

    ollama_client.chat = unittest.mock.AsyncMock(return_value=overflowing_stream())

    messages = [{"role": "user", "content": [{"text": "test"}]}]
    with pytest.raises(ContextWindowOverflowException) as exc_info:
        await alist(model.stream(messages))

    assert "the prompt is longer than the context length" in str(exc_info.value)
    assert exc_info.value.__cause__ == error


@pytest.mark.asyncio
async def test_stream_non_overflow_response_error_propagates(ollama_client, model, alist):
    error = ollama.ResponseError("model 'm1' not found")
    ollama_client.chat = unittest.mock.AsyncMock(side_effect=error)

    messages = [{"role": "user", "content": [{"text": "test"}]}]
    with pytest.raises(ollama.ResponseError, match="not found"):
        await alist(model.stream(messages))


@pytest.mark.asyncio
async def test_structured_output_context_overflow_error(ollama_client, model, test_output_model_cls, alist):
    error = ollama.ResponseError("request exceeds the available context size (2048 tokens), try increasing it")
    ollama_client.chat = unittest.mock.AsyncMock(side_effect=error)

    messages = [{"role": "user", "content": [{"text": "test"}]}]
    with pytest.raises(ContextWindowOverflowException) as exc_info:
        await alist(model.structured_output(test_output_model_cls, messages))

    assert "exceeds the available context size" in str(exc_info.value)
    assert exc_info.value.__cause__ == error


@pytest.mark.asyncio
async def test_structured_output_non_overflow_response_error_propagates(
    ollama_client, model, test_output_model_cls, alist
):
    error = ollama.ResponseError("model 'm1' not found")
    ollama_client.chat = unittest.mock.AsyncMock(side_effect=error)

    messages = [{"role": "user", "content": [{"text": "test"}]}]
    with pytest.raises(ollama.ResponseError, match="not found"):
        await alist(model.structured_output(test_output_model_cls, messages))


def test_cache_config_round_trips(host, model_id, captured_warnings):
    """cache_config is a valid config field and survives get_config/update_config unchanged."""
    cache_config = CacheConfig()
    model = OllamaModel(host, model_id=model_id, cache_config=cache_config)

    assert model.get_config()["cache_config"] is cache_config

    updated = CacheConfig()
    model.update_config(cache_config=updated)
    assert model.get_config()["cache_config"] is updated

    assert not any("Invalid configuration parameters" in str(warning.message) for warning in captured_warnings)


def test_cache_config_default_is_silent_and_not_routed(host, model_id, messages, captured_warnings):
    """A CacheConfig whose fields are all default warns about nothing and never reaches the request."""
    model = OllamaModel(host, model_id=model_id, cache_config=CacheConfig(strategy="auto"))

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
def test_cache_config_unsupported_field_warns_and_is_not_routed(host, model_id, messages, cache_config, field):
    """Ollama honors no cache field: a non-default field warns (naming the provider) and never reaches the request."""
    model = OllamaModel(host, model_id=model_id, cache_config=cache_config)

    with pytest.warns(UserWarning, match=rf"fields \['{field}'\] have no effect on Ollama"):
        request = model.format_request(messages)

    assert "cache_config" not in request
