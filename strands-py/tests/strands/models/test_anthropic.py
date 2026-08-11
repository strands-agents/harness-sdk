import logging
import mimetypes
import types
import unittest.mock
import warnings

import anthropic
import pydantic
import pytest

import strands
from strands.models.anthropic import AnthropicModel
from strands.types.exceptions import ContextWindowOverflowException, ModelThrottledException


@pytest.fixture
def anthropic_client():
    with unittest.mock.patch.object(strands.models.anthropic.anthropic, "AsyncAnthropic") as mock_client_cls:
        yield mock_client_cls.return_value


@pytest.fixture
def model_id():
    return "m1"


@pytest.fixture
def max_tokens():
    return 1


@pytest.fixture
def model(anthropic_client, model_id, max_tokens):
    _ = anthropic_client

    return AnthropicModel(model_id=model_id, max_tokens=max_tokens)


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


def generate_mock_stream_context(events, final_message=None):
    mock_stream = unittest.mock.AsyncMock()

    async def mock_aiter(self):
        for event in events:
            yield event

    mock_stream.__aiter__ = mock_aiter
    if isinstance(final_message, Exception):
        mock_stream.get_final_message.side_effect = final_message
    elif final_message:
        mock_stream.get_final_message.return_value = final_message

    mock_context = unittest.mock.AsyncMock()
    mock_context.__aenter__.return_value = mock_stream
    return mock_context


def test__init__model_configs(anthropic_client, model_id, max_tokens):
    _ = anthropic_client

    model = AnthropicModel(model_id=model_id, max_tokens=max_tokens, params={"temperature": 1})

    tru_temperature = model.get_config().get("params")
    exp_temperature = {"temperature": 1}

    assert tru_temperature == exp_temperature


def test__init__auto_populates_context_window_limit(anthropic_client):
    _ = anthropic_client

    model = AnthropicModel(model_id="claude-sonnet-4-20250514", max_tokens=1)

    assert model.get_config().get("context_window_limit") == 1_000_000


def test__init__explicit_context_window_limit_not_overridden(anthropic_client):
    _ = anthropic_client

    model = AnthropicModel(model_id="claude-sonnet-4-20250514", max_tokens=1, context_window_limit=100_000)

    assert model.get_config().get("context_window_limit") == 100_000


def test__init__unknown_model_no_context_window_limit(anthropic_client):
    _ = anthropic_client

    model = AnthropicModel(model_id="unknown-model", max_tokens=1)

    assert model.get_config().get("context_window_limit") is None


def test_update_config(model, model_id):
    model.update_config(model_id=model_id)

    tru_model_id = model.get_config().get("model_id")
    exp_model_id = model_id

    assert tru_model_id == exp_model_id


def test_format_request_default(model, messages, model_id, max_tokens):
    tru_request = model.format_request(messages)
    exp_request = {
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": [{"type": "text", "text": "test"}]}],
        "model": model_id,
        "tools": [],
    }

    assert tru_request == exp_request


def test_format_request_with_params(model, messages, model_id, max_tokens):
    model.update_config(params={"temperature": 1})

    tru_request = model.format_request(messages)
    exp_request = {
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": [{"type": "text", "text": "test"}]}],
        "model": model_id,
        "tools": [],
        "temperature": 1,
    }

    assert tru_request == exp_request


def test_format_request_with_system_prompt(model, messages, model_id, max_tokens, system_prompt):
    tru_request = model.format_request(messages, system_prompt=system_prompt)
    exp_request = {
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": [{"type": "text", "text": "test"}]}],
        "model": model_id,
        "system": system_prompt,
        "tools": [],
    }

    assert tru_request == exp_request


@pytest.mark.parametrize(
    ("content", "formatted_content"),
    [
        # PDF
        (
            {
                "document": {"format": "pdf", "name": "test doc", "source": {"bytes": b"pdf"}},
            },
            {
                "source": {
                    "data": "cGRm",
                    "media_type": "application/pdf",
                    "type": "base64",
                },
                "title": "test doc",
                "type": "document",
            },
        ),
        # Plain text
        (
            {
                "document": {"format": "txt", "name": "test doc", "source": {"bytes": b"txt"}},
            },
            {
                "source": {
                    "data": "txt",
                    "media_type": "text/plain",
                    "type": "text",
                },
                "title": "test doc",
                "type": "document",
            },
        ),
    ],
)
def test_format_request_with_document(content, formatted_content, model, model_id, max_tokens):
    messages = [
        {
            "role": "user",
            "content": [content],
        },
    ]

    tru_request = model.format_request(messages)
    exp_request = {
        "max_tokens": max_tokens,
        "messages": [
            {
                "role": "user",
                "content": [formatted_content],
            },
        ],
        "model": model_id,
        "tools": [],
    }

    assert tru_request == exp_request


def test_format_request_with_image(model, model_id, max_tokens):
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
        "max_tokens": max_tokens,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "source": {
                            "data": "YmFzZTY0ZW5jb2RlZGltYWdl",
                            "media_type": "image/jpeg",
                            "type": "base64",
                        },
                        "type": "image",
                    },
                ],
            },
        ],
        "model": model_id,
        "tools": [],
    }

    assert tru_request == exp_request


def test_format_request_with_webp_image_does_not_depend_on_mimetypes(model, model_id, max_tokens, monkeypatch):
    monkeypatch.delitem(mimetypes.types_map, ".webp", raising=False)

    messages = [
        {
            "role": "user",
            "content": [{"image": {"format": "webp", "source": {"bytes": b"webpimage"}}}],
        },
    ]

    tru_request = model.format_request(messages)

    assert tru_request["messages"][0]["content"][0]["source"]["media_type"] == "image/webp"


def test_format_request_with_reasoning(model, model_id, max_tokens):
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "reasoningContent": {
                        "reasoningText": {
                            "signature": "reasoning_signature",
                            "text": "reasoning_text",
                        },
                    },
                },
            ],
        },
    ]

    tru_request = model.format_request(messages)
    exp_request = {
        "max_tokens": max_tokens,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "signature": "reasoning_signature",
                        "thinking": "reasoning_text",
                        "type": "thinking",
                    },
                ],
            },
        ],
        "model": model_id,
        "tools": [],
    }

    assert tru_request == exp_request


def test_format_request_with_tool_result_preserves_non_ascii(model, model_id, max_tokens):
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
        "max_tokens": max_tokens,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "content": [{"text": '{"city": "東京"}', "type": "text"}],
                        "is_error": False,
                        "tool_use_id": "c1",
                        "type": "tool_result",
                    }
                ],
            }
        ],
        "model": model_id,
        "tools": [],
    }

    assert tru_request == exp_request


def test_format_request_with_tool_use(model, model_id, max_tokens):
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
        "max_tokens": max_tokens,
        "messages": [
            {
                "role": "assistant",
                "content": [
                    {
                        "id": "c1",
                        "input": {"expression": "2+2"},
                        "name": "calculator",
                        "type": "tool_use",
                    },
                ],
            },
        ],
        "model": model_id,
        "tools": [],
    }

    assert tru_request == exp_request


def test_format_request_with_tool_results(model, model_id, max_tokens):
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "c1",
                        "status": "success",
                        "content": [
                            {"text": "see image"},
                            {"json": ["see image"]},
                            {
                                "image": {
                                    "format": "jpg",
                                    "source": {"bytes": b"base64encodedimage"},
                                },
                            },
                        ],
                    }
                }
            ],
        }
    ]

    tru_request = model.format_request(messages)
    exp_request = {
        "max_tokens": max_tokens,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "content": [
                            {
                                "text": "see image",
                                "type": "text",
                            },
                            {
                                "text": '["see image"]',
                                "type": "text",
                            },
                            {
                                "source": {
                                    "data": "YmFzZTY0ZW5jb2RlZGltYWdl",
                                    "media_type": "image/jpeg",
                                    "type": "base64",
                                },
                                "type": "image",
                            },
                        ],
                        "is_error": False,
                        "tool_use_id": "c1",
                        "type": "tool_result",
                    },
                ],
            },
        ],
        "model": model_id,
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


def test_format_request_with_cache_point(model, model_id, max_tokens):
    messages = [
        {
            "role": "user",
            "content": [
                {"text": "cache me"},
                {"cachePoint": {"type": "default"}},
            ],
        },
    ]

    tru_request = model.format_request(messages)
    exp_request = {
        "max_tokens": max_tokens,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "cache_control": {"type": "ephemeral"},
                        "text": "cache me",
                        "type": "text",
                    },
                ],
            },
        ],
        "model": model_id,
        "tools": [],
    }

    assert tru_request == exp_request


def test_format_request_with_empty_content(model, model_id, max_tokens):
    messages = [
        {
            "role": "user",
            "content": [],
        },
    ]

    tru_request = model.format_request(messages)
    exp_request = {
        "max_tokens": max_tokens,
        "messages": [],
        "model": model_id,
        "tools": [],
    }

    assert tru_request == exp_request


def test_format_request_tool_choice_auto(model, messages, model_id, max_tokens):
    tool_specs = [{"description": "test tool", "name": "test_tool", "inputSchema": {"json": {"key": "value"}}}]
    tool_choice = {"auto": {}}

    tru_request = model.format_request(messages, tool_specs, tool_choice=tool_choice)
    exp_request = {
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": [{"type": "text", "text": "test"}]}],
        "model": model_id,
        "tools": [
            {
                "name": "test_tool",
                "description": "test tool",
                "input_schema": {"key": "value"},
            }
        ],
        "tool_choice": {"type": "auto"},
    }

    assert tru_request == exp_request


def test_format_request_tool_choice_any(model, messages, model_id, max_tokens):
    tool_specs = [{"description": "test tool", "name": "test_tool", "inputSchema": {"json": {"key": "value"}}}]
    tool_choice = {"any": {}}

    tru_request = model.format_request(messages, tool_specs, tool_choice=tool_choice)
    exp_request = {
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": [{"type": "text", "text": "test"}]}],
        "model": model_id,
        "tools": [
            {
                "name": "test_tool",
                "description": "test tool",
                "input_schema": {"key": "value"},
            }
        ],
        "tool_choice": {"type": "any"},
    }

    assert tru_request == exp_request


def test_format_request_tool_choice_tool(model, messages, model_id, max_tokens):
    tool_specs = [{"description": "test tool", "name": "test_tool", "inputSchema": {"json": {"key": "value"}}}]
    tool_choice = {"tool": {"name": "test_tool"}}

    tru_request = model.format_request(messages, tool_specs, tool_choice=tool_choice)
    exp_request = {
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": [{"type": "text", "text": "test"}]}],
        "model": model_id,
        "tools": [
            {
                "name": "test_tool",
                "description": "test tool",
                "input_schema": {"key": "value"},
            }
        ],
        "tool_choice": {"name": "test_tool", "type": "tool"},
    }

    assert tru_request == exp_request


def test_format_chunk_message_start(model):
    event = {"type": "message_start"}

    tru_chunk = model.format_chunk(event)
    exp_chunk = {"messageStart": {"role": "assistant"}}

    assert tru_chunk == exp_chunk


def test_format_chunk_content_block_start_tool_use(model):
    event = {
        "content_block": {
            "id": "c1",
            "name": "calculator",
            "type": "tool_use",
        },
        "index": 0,
        "type": "content_block_start",
    }

    tru_chunk = model.format_chunk(event)
    exp_chunk = {
        "contentBlockStart": {
            "contentBlockIndex": 0,
            "start": {"toolUse": {"name": "calculator", "toolUseId": "c1"}},
        },
    }

    assert tru_chunk == exp_chunk


def test_format_chunk_content_block_start_other(model):
    event = {
        "content_block": {
            "type": "text",
        },
        "index": 0,
        "type": "content_block_start",
    }

    tru_chunk = model.format_chunk(event)
    exp_chunk = {
        "contentBlockStart": {
            "contentBlockIndex": 0,
            "start": {},
        },
    }

    assert tru_chunk == exp_chunk


def test_format_chunk_content_block_delta_signature_delta(model):
    event = {
        "delta": {
            "type": "signature_delta",
            "signature": "s1",
        },
        "index": 0,
        "type": "content_block_delta",
    }

    tru_chunk = model.format_chunk(event)
    exp_chunk = {
        "contentBlockDelta": {
            "contentBlockIndex": 0,
            "delta": {
                "reasoningContent": {
                    "signature": "s1",
                },
            },
        },
    }

    assert tru_chunk == exp_chunk


def test_format_chunk_content_block_delta_thinking_delta(model):
    event = {
        "delta": {
            "type": "thinking_delta",
            "thinking": "t1",
        },
        "index": 0,
        "type": "content_block_delta",
    }

    tru_chunk = model.format_chunk(event)
    exp_chunk = {
        "contentBlockDelta": {
            "contentBlockIndex": 0,
            "delta": {
                "reasoningContent": {
                    "text": "t1",
                },
            },
        },
    }

    assert tru_chunk == exp_chunk


def test_format_chunk_content_block_delta_input_json_delta_delta(model):
    event = {
        "delta": {
            "type": "input_json_delta",
            "partial_json": "{",
        },
        "index": 0,
        "type": "content_block_delta",
    }

    tru_chunk = model.format_chunk(event)
    exp_chunk = {
        "contentBlockDelta": {
            "contentBlockIndex": 0,
            "delta": {
                "toolUse": {
                    "input": "{",
                },
            },
        },
    }

    assert tru_chunk == exp_chunk


def test_format_chunk_content_block_delta_text_delta(model):
    event = {
        "delta": {
            "type": "text_delta",
            "text": "hello",
        },
        "index": 0,
        "type": "content_block_delta",
    }

    tru_chunk = model.format_chunk(event)
    exp_chunk = {
        "contentBlockDelta": {
            "contentBlockIndex": 0,
            "delta": {"text": "hello"},
        },
    }

    assert tru_chunk == exp_chunk


def test_format_chunk_content_block_delta_unknown(model):
    event = {
        "delta": {
            "type": "unknown",
        },
        "type": "content_block_delta",
    }

    with pytest.raises(RuntimeError, match="chunk_type=<content_block_delta>, delta=<unknown> | unknown type"):
        model.format_chunk(event)


def test_format_chunk_content_block_stop(model):
    event = {"type": "content_block_stop", "index": 0}

    tru_chunk = model.format_chunk(event)
    exp_chunk = {"contentBlockStop": {"contentBlockIndex": 0}}

    assert tru_chunk == exp_chunk


def test_format_chunk_message_stop(model):
    event = {"type": "message_stop", "message": {"stop_reason": "end_turn"}}

    tru_chunk = model.format_chunk(event)
    exp_chunk = {"messageStop": {"stopReason": "end_turn"}}

    assert tru_chunk == exp_chunk


def test_format_chunk_metadata(model):
    event = {
        "type": "metadata",
        "usage": {"input_tokens": 1, "output_tokens": 2},
    }

    tru_chunk = model.format_chunk(event)
    exp_chunk = {
        "metadata": {
            "usage": {
                "inputTokens": 1,
                "outputTokens": 2,
                "totalTokens": 3,
            },
            "metrics": {
                "latencyMs": 0,
            },
        },
    }

    assert tru_chunk == exp_chunk


def test_format_chunk_metadata_with_cache_tokens(model):
    """When prompt caching is active, Anthropic returns cache_read_input_tokens
    and cache_creation_input_tokens alongside input_tokens; surface them so
    downstream cost accounting reflects what the user is billed for."""
    event = {
        "type": "metadata",
        "usage": {
            "input_tokens": 5,
            "output_tokens": 7,
            "cache_read_input_tokens": 100,
            "cache_creation_input_tokens": 50,
        },
    }

    tru_chunk = model.format_chunk(event)
    exp_chunk = {
        "metadata": {
            "usage": {
                "inputTokens": 5,
                "outputTokens": 7,
                "totalTokens": 12,
                "cacheReadInputTokens": 100,
                "cacheWriteInputTokens": 50,
            },
            "metrics": {
                "latencyMs": 0,
            },
        },
    }

    assert tru_chunk == exp_chunk


def test_format_chunk_metadata_omits_zero_cache_tokens(model):
    """When cache fields are absent or zero, keep the legacy chunk shape so
    consumers expecting only inputTokens/outputTokens keep working."""
    event = {
        "type": "metadata",
        "usage": {
            "input_tokens": 5,
            "output_tokens": 7,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
        },
    }

    tru_chunk = model.format_chunk(event)

    assert "cacheReadInputTokens" not in tru_chunk["metadata"]["usage"]
    assert "cacheWriteInputTokens" not in tru_chunk["metadata"]["usage"]
    assert tru_chunk["metadata"]["usage"]["totalTokens"] == 12


def test_format_chunk_unknown(model):
    event = {"type": "unknown"}

    with pytest.raises(RuntimeError, match="chunk_type=<unknown> | unknown type"):
        model.format_chunk(event)


@pytest.mark.asyncio
async def test_stream(anthropic_client, model, alist):
    mock_event_1 = unittest.mock.Mock(
        type="message_start",
        dict=lambda: {"type": "message_start"},
        model_dump=lambda: {"type": "message_start"},
    )
    mock_event_2 = unittest.mock.Mock(
        type="unknown",
        dict=lambda: {"type": "unknown"},
        model_dump=lambda: {"type": "unknown"},
    )
    mock_event_3 = unittest.mock.Mock(
        type="metadata",
        message=unittest.mock.Mock(
            usage=unittest.mock.Mock(
                dict=lambda: {"input_tokens": 1, "output_tokens": 2},
                model_dump=lambda: {"input_tokens": 1, "output_tokens": 2},
            )
        ),
    )

    anthropic_client.messages.stream.return_value = generate_mock_stream_context(
        [mock_event_1, mock_event_2, mock_event_3],
        final_message=unittest.mock.Mock(
            usage=unittest.mock.Mock(
                model_dump=lambda: {"input_tokens": 1, "output_tokens": 2},
            )
        ),
    )

    messages = [{"role": "user", "content": [{"text": "hello"}]}]
    response = model.stream(messages, None, None)

    tru_events = await alist(response)
    exp_events = [
        {"messageStart": {"role": "assistant"}},
        {"metadata": {"usage": {"inputTokens": 1, "outputTokens": 2, "totalTokens": 3}, "metrics": {"latencyMs": 0}}},
    ]

    assert tru_events == exp_events

    # Check that the formatted request was passed to the client
    expected_request = {
        "max_tokens": 1,
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hello"}]}],
        "model": "m1",
        "tools": [],
    }
    anthropic_client.messages.stream.assert_called_once_with(**expected_request)


@pytest.mark.asyncio
async def test_stream_early_termination(anthropic_client, model, alist, caplog):
    caplog.set_level(logging.WARNING, logger="strands.models.anthropic")
    mock_event = unittest.mock.Mock(
        type="message_start",
        model_dump=lambda: {"type": "message_start"},
    )

    anthropic_client.messages.stream.return_value = generate_mock_stream_context(
        [mock_event],
        final_message=AssertionError("message snapshot is not available"),
    )

    messages = [{"role": "user", "content": [{"text": "hello"}]}]
    tru_events = await alist(model.stream(messages, None, None))

    assert len(tru_events) == 1
    assert "messageStart" in tru_events[0]
    assert "failed to retrieve message snapshot, usage metadata unavailable" in caplog.text


@pytest.mark.asyncio
async def test_stream_empty(anthropic_client, model, alist, caplog):
    caplog.set_level(logging.WARNING, logger="strands.models.anthropic")
    anthropic_client.messages.stream.return_value = generate_mock_stream_context(
        [],
        final_message=AssertionError("message snapshot is not available"),
    )

    messages = [{"role": "user", "content": [{"text": "hello"}]}]
    tru_events = await alist(model.stream(messages, None, None))

    assert tru_events == []
    assert "failed to retrieve message snapshot, usage metadata unavailable" in caplog.text


@pytest.mark.asyncio
async def test_stream_rate_limit_error(anthropic_client, model, alist):
    anthropic_client.messages.stream.side_effect = anthropic.RateLimitError(
        "rate limit", response=unittest.mock.Mock(), body=None
    )

    messages = [{"role": "user", "content": [{"text": "hello"}]}]
    with pytest.raises(ModelThrottledException, match="rate limit"):
        await alist(model.stream(messages))


@pytest.mark.parametrize(
    "overflow_message",
    [
        "...input is too long...",
        "...input length exceeds context window...",
        "...input and output tokens exceed your context limit...",
    ],
)
@pytest.mark.asyncio
async def test_stream_bad_request_overflow_error(overflow_message, anthropic_client, model):
    anthropic_client.messages.stream.side_effect = anthropic.BadRequestError(
        overflow_message, response=unittest.mock.Mock(), body=None
    )

    messages = [{"role": "user", "content": [{"text": "hello"}]}]
    with pytest.raises(ContextWindowOverflowException):
        await anext(model.stream(messages))


@pytest.mark.asyncio
async def test_stream_bad_request_error(anthropic_client, model):
    anthropic_client.messages.stream.side_effect = anthropic.BadRequestError(
        "bad", response=unittest.mock.Mock(), body=None
    )

    messages = [{"role": "user", "content": [{"text": "hello"}]}]
    with pytest.raises(anthropic.BadRequestError, match="bad"):
        await anext(model.stream(messages))


@pytest.mark.asyncio
async def test_structured_output(anthropic_client, model, test_output_model_cls, alist):
    messages = [{"role": "user", "content": [{"text": "Generate a person"}]}]

    events = [
        unittest.mock.Mock(type="message_start", model_dump=unittest.mock.Mock(return_value={"type": "message_start"})),
        unittest.mock.Mock(
            type="content_block_start",
            model_dump=unittest.mock.Mock(
                return_value={
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {"type": "tool_use", "id": "123", "name": "TestOutputModel"},
                }
            ),
        ),
        unittest.mock.Mock(
            type="content_block_delta",
            model_dump=unittest.mock.Mock(
                return_value={
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "input_json_delta", "partial_json": '{"name": "John", "age": 30}'},
                },
            ),
        ),
        unittest.mock.Mock(
            type="content_block_stop",
            model_dump=unittest.mock.Mock(return_value={"type": "content_block_stop", "index": 0}),
        ),
        unittest.mock.Mock(
            type="message_stop",
            message=unittest.mock.Mock(stop_reason="tool_use"),
            model_dump=unittest.mock.Mock(
                return_value={"type": "message_stop", "message": {"stop_reason": "tool_use"}}
            ),
        ),
    ]

    anthropic_client.messages.stream.return_value = generate_mock_stream_context(
        events,
        final_message=unittest.mock.Mock(
            usage=unittest.mock.Mock(
                model_dump=unittest.mock.Mock(return_value={"input_tokens": 0, "output_tokens": 0})
            ),
        ),
    )

    stream = model.structured_output(test_output_model_cls, messages)
    events = await alist(stream)

    tru_result = events[-1]
    exp_result = {"output": test_output_model_cls(name="John", age=30)}
    assert tru_result == exp_result


def test_config_validation_warns_on_unknown_keys(anthropic_client, captured_warnings):
    """Test that unknown config keys emit a warning."""
    AnthropicModel(model_id="test-model", max_tokens=100, invalid_param="test")

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


def test_format_request_filters_s3_source_image(model, model_id, max_tokens, caplog):
    """Test that images with Location sources are filtered out with warning."""
    caplog.set_level(logging.WARNING, logger="strands.models.anthropic")

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

    tru_request = model.format_request(messages)

    # Image with S3 source should be filtered, text should remain
    exp_messages = [
        {"role": "user", "content": [{"type": "text", "text": "look at this image"}]},
    ]
    assert tru_request["messages"] == exp_messages
    assert "Location sources are not supported by Anthropic" in caplog.text


def test_format_request_filters_location_source_document(model, model_id, max_tokens, caplog):
    """Test that documents with Location sources are filtered out with warning."""
    caplog.set_level(logging.WARNING, logger="strands.models.anthropic")

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

    tru_request = model.format_request(messages)

    # Document with S3 source should be filtered, text should remain
    exp_messages = [
        {"role": "user", "content": [{"type": "text", "text": "analyze this document"}]},
    ]
    assert tru_request["messages"] == exp_messages
    assert "Location sources are not supported by Anthropic" in caplog.text


@pytest.mark.asyncio
async def test_stream_message_stop_no_pydantic_warnings(anthropic_client, model, alist):
    """Verify no Pydantic serialization warnings are emitted for message_stop events.

    Regression test for https://github.com/strands-agents/harness-sdk/issues/1746.
    """
    # Create a mock message_stop event where model_dump() would emit warnings
    # The key is that the event has a .message attribute with .stop_reason
    mock_message_stop = unittest.mock.Mock()
    mock_message_stop.type = "message_stop"
    mock_message_stop.message = unittest.mock.Mock()
    mock_message_stop.message.stop_reason = "end_turn"

    # Make model_dump() emit a warning to simulate the problematic behavior
    def model_dump_with_warning():
        warnings.warn(
            "PydanticSerializationUnexpectedValue(Expected `ParsedTextBlock[TypeVar]`)",
            UserWarning,
            stacklevel=2,
        )
        return {"type": mock_message_stop.type, "message": {"stop_reason": mock_message_stop.message.stop_reason}}

    mock_message_stop.model_dump = model_dump_with_warning

    final_message = unittest.mock.Mock()
    final_message.usage = unittest.mock.Mock(
        model_dump=lambda: {"input_tokens": 1, "output_tokens": 2},
    )

    mock_context = generate_mock_stream_context([mock_message_stop], final_message=final_message)
    anthropic_client.messages.stream.return_value = mock_context

    messages = [{"role": "user", "content": [{"text": "hello"}]}]

    # Capture warnings during streaming
    with warnings.catch_warnings(record=True) as caught_warnings:
        warnings.simplefilter("always")
        response = model.stream(messages, None, None)
        events = await alist(response)

    # Verify no Pydantic serialization warnings were emitted
    pydantic_warnings = [w for w in caught_warnings if "PydanticSerializationUnexpectedValue" in str(w.message)]
    assert len(pydantic_warnings) == 0, f"Unexpected Pydantic warnings: {pydantic_warnings}"

    # Verify the message_stop event was still processed correctly
    assert {"messageStop": {"stopReason": mock_message_stop.message.stop_reason}} in events


@pytest.mark.asyncio
async def test_stream_content_block_stop_no_pydantic_warnings(anthropic_client, model, alist):
    """Regression test for https://github.com/strands-agents/harness-sdk/issues/1865."""
    mock_event = unittest.mock.Mock()
    mock_event.type = "content_block_stop"
    mock_event.index = 0

    def model_dump_with_warning():
        warnings.warn(
            "PydanticSerializationUnexpectedValue(Expected `ParsedTextBlock[TypeVar]`)",
            UserWarning,
            stacklevel=2,
        )
        return {"type": mock_event.type, "index": mock_event.index}

    mock_event.model_dump = model_dump_with_warning

    final_message = unittest.mock.Mock()
    final_message.usage = unittest.mock.Mock(model_dump=lambda: {"input_tokens": 1, "output_tokens": 2})

    mock_context = generate_mock_stream_context([mock_event], final_message=final_message)
    anthropic_client.messages.stream.return_value = mock_context

    with warnings.catch_warnings(record=True) as caught_warnings:
        warnings.simplefilter("always")
        response = model.stream([{"role": "user", "content": [{"text": "hello"}]}], None, None)
        events = await alist(response)

    pydantic_warnings = [w for w in caught_warnings if "PydanticSerializationUnexpectedValue" in str(w.message)]
    assert len(pydantic_warnings) == 0, f"Unexpected Pydantic warnings: {pydantic_warnings}"
    assert {"contentBlockStop": {"contentBlockIndex": 0}} in events


class TestCountTokens:
    """Tests for AnthropicModel.count_tokens native token counting."""

    @pytest.fixture
    def model_with_client(self, anthropic_client, model_id, max_tokens):
        _ = anthropic_client
        return AnthropicModel(model_id=model_id, max_tokens=max_tokens, use_native_token_count=True)

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
    async def test_native_count_tokens_success(self, model_with_client, anthropic_client, messages):
        mock_response = unittest.mock.MagicMock()
        mock_response.input_tokens = 42
        anthropic_client.messages.count_tokens = unittest.mock.AsyncMock(return_value=mock_response)

        result = await model_with_client.count_tokens(messages=messages)

        assert result == 42
        anthropic_client.messages.count_tokens.assert_called_once()

    @pytest.mark.asyncio
    async def test_native_count_tokens_with_system_prompt(self, model_with_client, anthropic_client, messages):
        mock_response = unittest.mock.MagicMock()
        mock_response.input_tokens = 55
        anthropic_client.messages.count_tokens = unittest.mock.AsyncMock(return_value=mock_response)

        result = await model_with_client.count_tokens(messages=messages, system_prompt="Be helpful.")

        assert result == 55
        call_kwargs = anthropic_client.messages.count_tokens.call_args[1]
        assert call_kwargs["system"] == "Be helpful."

    @pytest.mark.asyncio
    async def test_native_count_tokens_with_tool_specs(self, model_with_client, anthropic_client, messages, tool_specs):
        mock_response = unittest.mock.MagicMock()
        mock_response.input_tokens = 100
        anthropic_client.messages.count_tokens = unittest.mock.AsyncMock(return_value=mock_response)

        result = await model_with_client.count_tokens(messages=messages, tool_specs=tool_specs)

        assert result == 100
        call_kwargs = anthropic_client.messages.count_tokens.call_args[1]
        assert "tools" in call_kwargs

    @pytest.mark.asyncio
    async def test_max_tokens_stripped_from_request(self, model_with_client, anthropic_client, messages):
        mock_response = unittest.mock.MagicMock()
        mock_response.input_tokens = 10
        anthropic_client.messages.count_tokens = unittest.mock.AsyncMock(return_value=mock_response)

        await model_with_client.count_tokens(messages=messages)

        call_kwargs = anthropic_client.messages.count_tokens.call_args[1]
        assert "max_tokens" not in call_kwargs

    @pytest.mark.asyncio
    async def test_fallback_on_api_error(self, model_with_client, anthropic_client, messages):
        anthropic_client.messages.count_tokens = unittest.mock.AsyncMock(
            side_effect=anthropic.APIError(message="Unsupported", request=unittest.mock.MagicMock(), body=None)
        )

        result = await model_with_client.count_tokens(messages=messages)

        assert isinstance(result, int)
        assert result >= 0

    @pytest.mark.asyncio
    async def test_fallback_on_generic_exception(self, model_with_client, anthropic_client, messages):
        anthropic_client.messages.count_tokens = unittest.mock.AsyncMock(side_effect=RuntimeError("Connection failed"))

        result = await model_with_client.count_tokens(messages=messages)

        assert isinstance(result, int)
        assert result >= 0

    @pytest.mark.asyncio
    async def test_fallback_logs_debug(self, model_with_client, anthropic_client, messages, caplog):
        anthropic_client.messages.count_tokens = unittest.mock.AsyncMock(side_effect=RuntimeError("API down"))

        with caplog.at_level(logging.DEBUG, logger="strands.models.anthropic"):
            await model_with_client.count_tokens(messages=messages)

        assert any("native token counting failed" in record.message for record in caplog.records)

    @pytest.mark.asyncio
    async def test_skip_native_api_when_use_native_token_count_false(
        self, anthropic_client, model_id, max_tokens, messages
    ):
        _ = anthropic_client
        model = AnthropicModel(model_id=model_id, max_tokens=max_tokens, use_native_token_count=False)

        result = await model.count_tokens(messages=messages)

        anthropic_client.messages.count_tokens.assert_not_called()
        assert isinstance(result, int)
        assert result >= 0

    @pytest.mark.asyncio
    async def test_skip_native_api_by_default(self, anthropic_client, model_id, max_tokens, messages):
        _ = anthropic_client
        model = AnthropicModel(model_id=model_id, max_tokens=max_tokens)

        result = await model.count_tokens(messages=messages)

        anthropic_client.messages.count_tokens.assert_not_called()
        assert isinstance(result, int)
        assert result >= 0


# ---------------------------------------------------------------------------------------------------
# Anthropic server-side tools (web search)
#
# Versioned tool type strings below are from the Anthropic tool catalog:
# https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-search-tool
# ---------------------------------------------------------------------------------------------------

WEB_SEARCH_TOOL = {"type": "web_search_20260318", "name": "web_search", "max_uses": 3}
WEB_FETCH_TOOL = {"type": "web_fetch_20260318", "name": "web_fetch"}


@pytest.fixture
def tool_spec():
    return {
        "description": "description",
        "name": "name",
        "inputSchema": {"json": {"key": "val"}},
    }


def mock_final_message():
    return unittest.mock.Mock(
        usage=unittest.mock.Mock(model_dump=lambda: {"input_tokens": 1, "output_tokens": 2}),
    )


@pytest.fixture
def server_tool_stream_events():
    """A realistic Anthropic stream for one server-side web search followed by a cited answer."""

    def event(payload, **attrs):
        return unittest.mock.Mock(model_dump=lambda: payload, **attrs)

    search_result = types.SimpleNamespace(
        type="web_search_result",
        url="https://docs.example.com/agents",
        title="Agents guide",
        encrypted_content="enc",
        page_age="1 day ago",
    )

    server_tool_use_block = types.SimpleNamespace(type="server_tool_use", id="srvtoolu_1", name="web_search", input={})
    search_result_block = types.SimpleNamespace(
        type="web_search_tool_result", tool_use_id="srvtoolu_1", content=[search_result]
    )
    text_block = types.SimpleNamespace(type="text", text="")

    return [
        event({"type": "message_start"}, type="message_start"),
        # Anthropic runs the search itself; this block and its input deltas describe a tool the agent
        # never executes.
        event(
            {"type": "content_block_start", "index": 0, "content_block": {"type": "server_tool_use"}},
            type="content_block_start",
            index=0,
            content_block=server_tool_use_block,
        ),
        event(
            {"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": '{"q"'}},
            type="content_block_delta",
            index=0,
        ),
        event({"type": "content_block_stop", "index": 0}, type="content_block_stop", index=0),
        event(
            {"type": "content_block_start", "index": 1, "content_block": {"type": "web_search_tool_result"}},
            type="content_block_start",
            index=1,
            content_block=search_result_block,
        ),
        event({"type": "content_block_stop", "index": 1}, type="content_block_stop", index=1),
        event(
            {"type": "content_block_start", "index": 2, "content_block": {"type": "text", "text": ""}},
            type="content_block_start",
            index=2,
            content_block=text_block,
        ),
        event(
            {"type": "content_block_delta", "index": 2, "delta": {"type": "text_delta", "text": "Agents are "}},
            type="content_block_delta",
            index=2,
        ),
        event(
            {
                "type": "content_block_delta",
                "index": 2,
                "delta": {
                    "type": "citations_delta",
                    "citation": {
                        "type": "web_search_result_location",
                        "url": "https://docs.example.com/agents",
                        "title": "Agents guide",
                        "cited_text": "Agents are autonomous programs.",
                        "encrypted_index": "idx",
                    },
                },
            },
            type="content_block_delta",
            index=2,
        ),
        event(
            {"type": "content_block_delta", "index": 2, "delta": {"type": "text_delta", "text": "autonomous."}},
            type="content_block_delta",
            index=2,
        ),
        event({"type": "content_block_stop", "index": 2}, type="content_block_stop", index=2),
        event(
            {"type": "message_stop"},
            type="message_stop",
            message=unittest.mock.Mock(stop_reason="end_turn"),
        ),
    ]


def test_format_request_anthropic_tools_are_additive(anthropic_client, model_id, max_tokens, messages, tool_spec):
    _ = anthropic_client

    model = AnthropicModel(model_id=model_id, max_tokens=max_tokens, anthropic_tools=[WEB_SEARCH_TOOL])

    request = model.format_request(messages, [tool_spec])

    assert request["tools"] == [
        {
            "name": tool_spec["name"],
            "description": tool_spec["description"],
            "input_schema": tool_spec["inputSchema"]["json"],
        },
        WEB_SEARCH_TOOL,
    ]


def test_format_request_anthropic_tools_regression_keeps_every_function_tool(
    anthropic_client, model_id, max_tokens, messages, tool_spec
):
    """An agent with N function tools plus a server-side tool still has all N in request["tools"]."""
    _ = anthropic_client

    tool_specs = [{**tool_spec, "name": f"tool_{index}"} for index in range(5)]
    model = AnthropicModel(model_id=model_id, max_tokens=max_tokens, anthropic_tools=[WEB_SEARCH_TOOL, WEB_FETCH_TOOL])

    request = model.format_request(messages, tool_specs)

    assert [tool["name"] for tool in request["tools"]] == [
        "tool_0",
        "tool_1",
        "tool_2",
        "tool_3",
        "tool_4",
        "web_search",
        "web_fetch",
    ]
    assert all("input_schema" in tool for tool in request["tools"][:5])


def test_format_request_anthropic_tools_without_function_tools(anthropic_client, model_id, max_tokens, messages):
    _ = anthropic_client

    model = AnthropicModel(model_id=model_id, max_tokens=max_tokens, anthropic_tools=[WEB_SEARCH_TOOL])

    assert model.format_request(messages)["tools"] == [WEB_SEARCH_TOOL]


def test_format_request_unset_anthropic_tools_is_unchanged(anthropic_client, model_id, max_tokens, messages, tool_spec):
    _ = anthropic_client

    model = AnthropicModel(model_id=model_id, max_tokens=max_tokens)

    with warnings.catch_warnings():
        warnings.simplefilter("error")
        request = model.format_request(messages, [tool_spec])

    assert request["tools"] == [
        {
            "name": tool_spec["name"],
            "description": tool_spec["description"],
            "input_schema": tool_spec["inputSchema"]["json"],
        }
    ]


def test_format_request_params_tools_warns_and_does_not_clobber(
    anthropic_client, model_id, max_tokens, messages, tool_spec
):
    _ = anthropic_client

    model = AnthropicModel(
        model_id=model_id,
        max_tokens=max_tokens,
        params={"temperature": 0.5, "tools": [WEB_SEARCH_TOOL]},
    )

    with pytest.warns(UserWarning, match="anthropic_tools"):
        request = model.format_request(messages, [tool_spec])

    assert [tool["name"] for tool in request["tools"]] == [tool_spec["name"], "web_search"]
    assert request["temperature"] == 0.5


def test_format_request_params_tools_does_not_mutate_config(
    anthropic_client, model_id, max_tokens, messages, tool_spec
):
    """Repeated calls must not accumulate tools into the stored config."""
    _ = anthropic_client

    params = {"tools": [WEB_SEARCH_TOOL]}
    model = AnthropicModel(model_id=model_id, max_tokens=max_tokens, params=params)

    with pytest.warns(UserWarning):
        first = model.format_request(messages, [tool_spec])
    with pytest.warns(UserWarning):
        second = model.format_request(messages, [tool_spec])

    assert first["tools"] == second["tools"]
    assert model.get_config()["params"] == {"tools": [WEB_SEARCH_TOOL]}


def test_anthropic_tools_validation_rejects_function_tools(anthropic_client, model_id, max_tokens):
    _ = anthropic_client

    function_tool = {"name": "my_tool", "description": "d", "input_schema": {"type": "object"}}

    with pytest.raises(ValueError, match="anthropic_tools should not contain function tool definitions"):
        AnthropicModel(model_id=model_id, max_tokens=max_tokens, anthropic_tools=[function_tool])


def test_anthropic_tools_validation_requires_versioned_type(anthropic_client, model_id, max_tokens):
    _ = anthropic_client

    with pytest.raises(ValueError, match="versioned `type` string"):
        AnthropicModel(model_id=model_id, max_tokens=max_tokens, anthropic_tools=[{"name": "web_search"}])


def test_anthropic_tools_validation_rejects_non_mapping(anthropic_client, model_id, max_tokens):
    _ = anthropic_client

    with pytest.raises(ValueError, match="must be Anthropic tool dicts"):
        AnthropicModel(model_id=model_id, max_tokens=max_tokens, anthropic_tools=["web_search"])


def test_anthropic_tools_validation_allows_server_side_tools(anthropic_client, model_id, max_tokens):
    _ = anthropic_client

    model = AnthropicModel(model_id=model_id, max_tokens=max_tokens, anthropic_tools=[WEB_SEARCH_TOOL])

    assert model.get_config()["anthropic_tools"] == [WEB_SEARCH_TOOL]


def test_anthropic_tools_validation_on_update_config(model):
    function_tool = {"name": "my_tool", "description": "d", "input_schema": {"type": "object"}}

    with pytest.raises(ValueError, match="anthropic_tools should not contain function tool definitions"):
        model.update_config(anthropic_tools=[function_tool])

    model.update_config(anthropic_tools=[WEB_SEARCH_TOOL])
    assert model.get_config()["anthropic_tools"] == [WEB_SEARCH_TOOL]


def test_format_chunk_citations_delta_web_search_result_location(model):
    event = {
        "type": "content_block_delta",
        "index": 2,
        "delta": {
            "type": "citations_delta",
            "citation": {
                "type": "web_search_result_location",
                "url": "https://docs.example.com/agents?x=1",
                "title": "Agents guide",
                "cited_text": "Agents are autonomous programs.",
                "encrypted_index": "idx",
            },
        },
    }

    assert model.format_chunk(event) == {
        "contentBlockDelta": {
            "contentBlockIndex": 2,
            "delta": {
                "citation": {
                    "title": "Agents guide",
                    "sourceContent": [{"text": "Agents are autonomous programs."}],
                    "location": {"web": {"url": "https://docs.example.com/agents?x=1", "domain": "docs.example.com"}},
                }
            },
        }
    }


def test_format_chunk_citations_delta_search_result_location(model):
    event = {
        "type": "content_block_delta",
        "index": 0,
        "delta": {
            "type": "citations_delta",
            "citation": {
                "type": "search_result_location",
                "source": "s1",
                "title": "T",
                "cited_text": "c",
                "search_result_index": 2,
                "start_block_index": 0,
                "end_block_index": 1,
            },
        },
    }

    assert model.format_chunk(event)["contentBlockDelta"]["delta"]["citation"]["location"] == {
        "searchResultLocation": {"searchResultIndex": 2, "start": 0, "end": 1}
    }


def test_format_chunk_citations_delta_document_locations(model):
    char_citation = {
        "type": "char_location",
        "document_index": 1,
        "document_title": "Doc",
        "cited_text": "c",
        "start_char_index": 5,
        "end_char_index": 9,
    }
    formatted = model.format_chunk(
        {"type": "content_block_delta", "index": 0, "delta": {"type": "citations_delta", "citation": char_citation}}
    )

    citation = formatted["contentBlockDelta"]["delta"]["citation"]
    assert citation["title"] == "Doc"
    assert citation["location"] == {"documentChar": {"documentIndex": 1, "start": 5, "end": 9}}


def test_format_chunk_citations_delta_unknown_location_is_kept_without_location(model, caplog):
    caplog.set_level(logging.WARNING, logger="strands.models.anthropic")

    formatted = model.format_chunk(
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": {"type": "citations_delta", "citation": {"type": "new_location", "cited_text": "c"}},
        }
    )

    assert formatted["contentBlockDelta"]["delta"]["citation"] == {"sourceContent": [{"text": "c"}]}
    assert "unsupported citation location" in caplog.text


def test_format_chunk_message_stop_pause_turn_maps_to_end_turn(model, caplog):
    caplog.set_level(logging.WARNING, logger="strands.models.anthropic")

    chunk = model.format_chunk({"type": "message_stop", "message": {"stop_reason": "pause_turn"}})

    assert chunk == {"messageStop": {"stopReason": "end_turn"}}
    assert "pause_turn" in caplog.text


@pytest.mark.asyncio
async def test_stream_server_side_web_search_round_trips_into_content_blocks(
    anthropic_client, model, alist, server_tool_stream_events
):
    """Search citations reach the message content, and the cited text is not dropped."""
    anthropic_client.messages.stream.return_value = generate_mock_stream_context(
        server_tool_stream_events, final_message=mock_final_message()
    )

    stream = model.stream([{"role": "user", "content": [{"text": "hi"}]}])
    events = await alist(strands.event_loop.streaming.process_stream(stream))
    stop_reason, message, _, _ = events[-1]["stop"]

    assert stop_reason == "end_turn"
    assert message["content"] == [
        {
            "citationsContent": {
                "citations": [
                    {
                        "title": "Agents guide",
                        "sourceContent": [{"text": "Agents are autonomous programs."}],
                        "location": {"web": {"url": "https://docs.example.com/agents", "domain": "docs.example.com"}},
                    }
                ],
                "content": [{"text": "Agents are autonomous."}],
            }
        }
    ]


@pytest.mark.asyncio
async def test_stream_server_tool_use_input_deltas_do_not_leak_into_tool_use(
    anthropic_client, model, alist, server_tool_stream_events, caplog
):
    """The server tool's input_json_delta must not be replayed as a function tool input."""
    caplog.set_level(logging.WARNING, logger="strands.event_loop.streaming")

    anthropic_client.messages.stream.return_value = generate_mock_stream_context(
        server_tool_stream_events, final_message=mock_final_message()
    )

    events = await alist(model.stream([{"role": "user", "content": [{"text": "hi"}]}]))

    assert not any("toolUse" in event.get("contentBlockDelta", {}).get("delta", {}) for event in events)
    assert not any("toolUse" in event.get("contentBlockStart", {}).get("start", {}) for event in events)
    assert "incomplete tool use block" not in caplog.text


@pytest.mark.asyncio
async def test_stream_server_tool_result_error_is_logged(anthropic_client, model, alist, caplog):
    caplog.set_level(logging.WARNING, logger="strands.models.anthropic")

    error_block = types.SimpleNamespace(
        type="web_search_tool_result",
        tool_use_id="srvtoolu_1",
        content=types.SimpleNamespace(type="web_search_tool_result_error", error_code="max_uses_exceeded"),
    )
    event = unittest.mock.Mock(
        type="content_block_start",
        index=0,
        content_block=error_block,
        model_dump=lambda: {
            "type": "content_block_start",
            "index": 0,
            "content_block": {"type": "web_search_tool_result"},
        },
    )

    anthropic_client.messages.stream.return_value = generate_mock_stream_context(
        [event], final_message=mock_final_message()
    )

    await alist(model.stream([{"role": "user", "content": [{"text": "hi"}]}]))

    assert "max_uses_exceeded" in caplog.text


def test_format_request_citations_content_round_trips_as_text(model):
    """A cited answer from a previous turn must survive back into the request."""
    messages = [
        {"role": "user", "content": [{"text": "hi"}]},
        {
            "role": "assistant",
            "content": [
                {
                    "citationsContent": {
                        "citations": [
                            {
                                "title": "Agents guide",
                                "sourceContent": [{"text": "Agents are autonomous programs."}],
                                "location": {"web": {"url": "https://docs.example.com/agents"}},
                            }
                        ],
                        "content": [{"text": "Agents are autonomous."}],
                    }
                }
            ],
        },
        {"role": "user", "content": [{"text": "and?"}]},
    ]

    request = model.format_request(messages)

    assert request["messages"][1] == {
        "role": "assistant",
        "content": [{"type": "text", "text": "Agents are autonomous."}],
    }


@pytest.mark.asyncio
async def test_stream_server_tool_block_index_is_released_on_stop(anthropic_client, model, alist):
    """Anthropic reuses block indexes across turns; a real tool_use at a recycled index must stream."""

    def event(payload, **attrs):
        return unittest.mock.Mock(model_dump=lambda: payload, **attrs)

    server_block = types.SimpleNamespace(type="server_tool_use", id="srvtoolu_1", name="web_search", input={})
    tool_block = types.SimpleNamespace(type="tool_use", id="tu1", name="calc", input={})

    events = [
        event(
            {"type": "content_block_start", "index": 0, "content_block": {"type": "server_tool_use"}},
            type="content_block_start",
            index=0,
            content_block=server_block,
        ),
        event(
            {"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": "{}"}},
            type="content_block_delta",
            index=0,
        ),
        event({"type": "content_block_stop", "index": 0}, type="content_block_stop", index=0),
        # Same index, now a genuine function tool call.
        event(
            {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "tool_use", "name": "calc", "id": "tu1"},
            },
            type="content_block_start",
            index=0,
            content_block=tool_block,
        ),
        event(
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "input_json_delta", "partial_json": '{"a": 1}'},
            },
            type="content_block_delta",
            index=0,
        ),
        event({"type": "content_block_stop", "index": 0}, type="content_block_stop", index=0),
    ]

    anthropic_client.messages.stream.return_value = generate_mock_stream_context(
        events, final_message=mock_final_message()
    )

    chunks = await alist(model.stream([{"role": "user", "content": [{"text": "hi"}]}]))

    tool_starts = [c for c in chunks if "toolUse" in c.get("contentBlockStart", {}).get("start", {})]
    tool_deltas = [c for c in chunks if "toolUse" in c.get("contentBlockDelta", {}).get("delta", {})]

    assert len(tool_starts) == 1
    assert tool_starts[0]["contentBlockStart"]["start"]["toolUse"] == {"name": "calc", "toolUseId": "tu1"}
    assert len(tool_deltas) == 1
    assert tool_deltas[0]["contentBlockDelta"]["delta"]["toolUse"] == {"input": '{"a": 1}'}


def test_format_chunk_citations_delta_malformed_url_omits_domain(model):
    """A url the parser cannot resolve must still yield a usable citation."""
    formatted = model.format_chunk(
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": {
                "type": "citations_delta",
                "citation": {"type": "web_search_result_location", "url": "not a url", "cited_text": "t"},
            },
        }
    )

    assert formatted["contentBlockDelta"]["delta"]["citation"]["location"] == {"web": {"url": "not a url"}}


# --- fixes from adversarial review of PR #3568 -------------------------------------------------------


def test_format_request_skips_citations_block_with_no_generated_text(model):
    """Anthropic rejects empty text blocks, so a content-less citations block must be dropped.

    Reachable in practice: BedrockModel streams citation deltas with an empty `content`, so replaying
    a Bedrock-produced history through AnthropicModel would otherwise be a guaranteed 400.
    """
    messages = [
        {"role": "user", "content": [{"text": "hi"}]},
        {
            "role": "assistant",
            "content": [
                {"citationsContent": {"citations": [{"title": "A"}], "content": []}},
                {"text": "real answer"},
            ],
        },
    ]

    request = model.format_request(messages)

    assert request["messages"][1] == {"role": "assistant", "content": [{"type": "text", "text": "real answer"}]}


def test_format_request_drops_message_that_is_only_an_empty_citations_block(model):
    """The whole message goes away rather than becoming an empty content list."""
    messages = [
        {"role": "user", "content": [{"text": "hi"}]},
        {"role": "assistant", "content": [{"citationsContent": {"citations": [{"title": "A"}], "content": []}}]},
    ]

    request = model.format_request(messages)

    assert request["messages"] == [{"role": "user", "content": [{"type": "text", "text": "hi"}]}]


@pytest.mark.parametrize(
    "bad_tools",
    [
        "web_search",
        123,
    ],
)
def test_format_request_params_tools_rejects_values_that_would_be_exploded(
    anthropic_client, model_id, max_tokens, messages, bad_tools
):
    """`extend()` on a str/int would spray characters or raise; name the option instead."""
    _ = anthropic_client

    model = AnthropicModel(model_id=model_id, max_tokens=max_tokens, params={"tools": bad_tools})

    with pytest.warns(UserWarning), pytest.raises(ValueError, match=r"params\[.tools.\] must be a list"):
        model.format_request(messages)


def test_format_request_params_tools_wraps_a_bare_mapping(anthropic_client, model_id, max_tokens, messages, tool_spec):
    """A single tool dict is unambiguous, so wrap it rather than iterating its keys."""
    _ = anthropic_client

    model = AnthropicModel(model_id=model_id, max_tokens=max_tokens, params={"tools": WEB_SEARCH_TOOL})

    with pytest.warns(UserWarning):
        request = model.format_request(messages, [tool_spec])

    assert request["tools"] == [
        {
            "name": tool_spec["name"],
            "description": tool_spec["description"],
            "input_schema": tool_spec["inputSchema"]["json"],
        },
        WEB_SEARCH_TOOL,
    ]


def test_anthropic_tools_rejects_a_bare_string(anthropic_client, model_id, max_tokens):
    _ = anthropic_client

    with pytest.raises(ValueError, match="anthropic_tools must be a list"):
        AnthropicModel(model_id=model_id, max_tokens=max_tokens, anthropic_tools="web_search")


def test_update_config_anthropic_tools_none_resets_without_raising(model, messages):
    """`None` is a plausible reset value and must not raise TypeError."""
    model.update_config(anthropic_tools=[WEB_SEARCH_TOOL])
    model.update_config(anthropic_tools=None)

    assert model.format_request(messages)["tools"] == []


def test_format_chunk_citations_delta_web_location_domain_excludes_port(model):
    """Must match the TS provider, which uses URL().hostname."""
    formatted = model.format_chunk(
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": {
                "type": "citations_delta",
                "citation": {
                    "type": "web_search_result_location",
                    "url": "https://example.com:8443/a",
                    "cited_text": "c",
                },
            },
        }
    )

    assert formatted["contentBlockDelta"]["delta"]["citation"]["location"] == {
        "web": {"url": "https://example.com:8443/a", "domain": "example.com"}
    }


def test_format_chunk_citations_delta_page_location(model):
    formatted = model.format_chunk(
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": {
                "type": "citations_delta",
                "citation": {
                    "type": "page_location",
                    "document_index": 2,
                    "document_title": "Doc",
                    "cited_text": "c",
                    "start_page_number": 3,
                    "end_page_number": 4,
                },
            },
        }
    )

    assert formatted["contentBlockDelta"]["delta"]["citation"] == {
        "title": "Doc",
        "sourceContent": [{"text": "c"}],
        "location": {"documentPage": {"documentIndex": 2, "start": 3, "end": 4}},
    }


def test_format_chunk_citations_delta_content_block_location(model):
    formatted = model.format_chunk(
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": {
                "type": "citations_delta",
                "citation": {
                    "type": "content_block_location",
                    "document_index": 1,
                    "document_title": "Doc",
                    "cited_text": "c",
                    "start_block_index": 0,
                    "end_block_index": 2,
                },
            },
        }
    )

    assert formatted["contentBlockDelta"]["delta"]["citation"]["location"] == {
        "documentChunk": {"documentIndex": 1, "start": 0, "end": 2}
    }


@pytest.mark.asyncio
async def test_stream_suppresses_mcp_tool_use_input_deltas(anthropic_client, model, alist, caplog):
    """The suppression list must cover every server-resolved block, not just web search."""
    caplog.set_level(logging.WARNING, logger="strands.event_loop.streaming")

    def event(payload, **attrs):
        return unittest.mock.Mock(model_dump=lambda: payload, **attrs)

    mcp_block = types.SimpleNamespace(type="mcp_tool_use", id="mcptoolu_1", name="remote_tool", input={})
    events = [
        event(
            {"type": "content_block_start", "index": 0, "content_block": {"type": "mcp_tool_use"}},
            type="content_block_start",
            index=0,
            content_block=mcp_block,
        ),
        event(
            {"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": "{}"}},
            type="content_block_delta",
            index=0,
        ),
        event({"type": "content_block_stop", "index": 0}, type="content_block_stop", index=0),
    ]

    anthropic_client.messages.stream.return_value = generate_mock_stream_context(
        events, final_message=mock_final_message()
    )

    chunks = await alist(model.stream([{"role": "user", "content": [{"text": "hi"}]}]))

    assert not any("toolUse" in c.get("contentBlockDelta", {}).get("delta", {}) for c in chunks)
    assert "incomplete tool use block" not in caplog.text


@pytest.mark.asyncio
async def test_stream_forwards_unrecognized_block_types_with_a_warning(anthropic_client, model, alist, caplog):
    """A block type we do not know must not vanish; losing content silently is the worse failure."""
    caplog.set_level(logging.WARNING, logger="strands.models.anthropic")

    def event(payload, **attrs):
        return unittest.mock.Mock(model_dump=lambda: payload, **attrs)

    unknown = types.SimpleNamespace(type="brand_new_block_20991231")
    events = [
        event(
            {"type": "content_block_start", "index": 0, "content_block": {"type": "brand_new_block_20991231"}},
            type="content_block_start",
            index=0,
            content_block=unknown,
        ),
        event(
            {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "hello"}},
            type="content_block_delta",
            index=0,
        ),
        event({"type": "content_block_stop", "index": 0}, type="content_block_stop", index=0),
    ]

    anthropic_client.messages.stream.return_value = generate_mock_stream_context(
        events, final_message=mock_final_message()
    )

    chunks = await alist(model.stream([{"role": "user", "content": [{"text": "hi"}]}]))

    assert {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": "hello"}}} in chunks
    assert "unrecognized content block type" in caplog.text
    assert "brand_new_block_20991231" in caplog.text


@pytest.mark.asyncio
async def test_stream_server_tool_blocks_leave_no_empty_content_block(
    anthropic_client, model, alist, server_tool_stream_events
):
    """Suppressed blocks are skipped whole - no stray start/stop pair per web search."""
    anthropic_client.messages.stream.return_value = generate_mock_stream_context(
        server_tool_stream_events, final_message=mock_final_message()
    )

    chunks = await alist(model.stream([{"role": "user", "content": [{"text": "hi"}]}]))

    # One text block only: the server_tool_use and web_search_tool_result blocks are gone.
    assert len([c for c in chunks if "contentBlockStart" in c]) == 1
    assert len([c for c in chunks if "contentBlockStop" in c]) == 1


@pytest.mark.asyncio
async def test_stream_forwards_initial_text_attached_to_content_block_start(anthropic_client, model, alist):
    """Anthropic can put the first characters on content_block_start; TS forwards them, so must we."""

    def event(payload, **attrs):
        return unittest.mock.Mock(model_dump=lambda: payload, **attrs)

    text_block = types.SimpleNamespace(type="text", text="Hello")
    events = [
        event(
            {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": "Hello"}},
            type="content_block_start",
            index=0,
            content_block=text_block,
        ),
        event(
            {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": " world"}},
            type="content_block_delta",
            index=0,
        ),
        event({"type": "content_block_stop", "index": 0}, type="content_block_stop", index=0),
        event({"type": "message_stop"}, type="message_stop", message=unittest.mock.Mock(stop_reason="end_turn")),
    ]

    anthropic_client.messages.stream.return_value = generate_mock_stream_context(
        events, final_message=mock_final_message()
    )

    stream = model.stream([{"role": "user", "content": [{"text": "hi"}]}])
    stream_events = await alist(strands.event_loop.streaming.process_stream(stream))
    _, message, _, _ = stream_events[-1]["stop"]

    assert message["content"] == [{"text": "Hello world"}]
