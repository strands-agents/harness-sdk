import copy
import logging
import mimetypes
import re
import unittest.mock
import warnings

import anthropic
import pydantic
import pytest

import strands
from strands.models.anthropic import AnthropicModel
from strands.models.model import CacheConfig, CacheToolsConfig
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


def test_cache_key_round_trips_through_config(model):
    """Anthropic accepts and preserves cache_config.cache_key through update_config/get_config."""
    model.update_config(cache_config=CacheConfig(cache_key="tenant-42"))

    assert model.get_config()["cache_config"].cache_key == "tenant-42"


def test_cache_key_does_not_change_request_shape(anthropic_client, messages, model_id, max_tokens):
    """Anthropic ignores cache_key: two configs differing only in cache_key format identically."""
    _ = anthropic_client
    without_key = AnthropicModel(model_id=model_id, max_tokens=max_tokens, cache_config=CacheConfig())
    with_key = AnthropicModel(model_id=model_id, max_tokens=max_tokens, cache_config=CacheConfig(cache_key="tenant-42"))

    assert with_key.format_request(messages) == without_key.format_request(messages)


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
        # Text-file format delivered as plain text
        (
            {
                "document": {"format": "csv", "name": "test doc", "source": {"bytes": b"a,b\n1,2"}},
            },
            {
                "source": {
                    "data": "a,b\n1,2",
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


# Guards against https://github.com/strands-agents/harness-sdk/issues/3789: formats Anthropic cannot
# accept must raise client-side instead of being sent in a request shape the API rejects.
@pytest.mark.parametrize("document_format", ["doc", "docx", "xls", "xlsx"])
def test_format_request_with_unsupported_document_format(document_format, model):
    messages = [
        {
            "role": "user",
            "content": [
                {"document": {"format": document_format, "name": "test doc", "source": {"bytes": b"content"}}},
            ],
        },
    ]

    expected_message = f"content_type=<document>, format=<{document_format}> | unsupported format"
    with pytest.raises(TypeError, match=re.escape(expected_message)):
        model.format_request(messages)


def test_format_request_with_non_utf8_text_document(model):
    messages = [
        {
            "role": "user",
            "content": [
                {"document": {"format": "csv", "name": "test doc", "source": {"bytes": b"caf\xe9"}}},
            ],
        },
    ]

    expected_message = "content_type=<document>, format=<csv> | document is not valid utf-8 text"
    with pytest.raises(TypeError, match=re.escape(expected_message)):
        model.format_request(messages)


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


# Guards against https://github.com/strands-agents/harness-sdk/issues/3789: formats Anthropic cannot
# accept must raise client-side instead of being sent with a media type the API rejects.
def test_format_request_with_unsupported_image_format(model):
    messages = [
        {
            "role": "user",
            "content": [{"image": {"format": "bmp", "source": {"bytes": b"bmpimage"}}}],
        },
    ]

    expected_message = "content_type=<image>, format=<bmp> | unsupported format"
    with pytest.raises(TypeError, match=re.escape(expected_message)):
        model.format_request(messages)


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
    async def test_native_count_tokens_renders_system_prompt_content(
        self, model_with_client, anthropic_client, messages
    ):
        """The count matches what stream() sends: system_prompt_content is rendered, not the plain string."""
        model_with_client.update_config(cache_config=CacheConfig(strategy="auto"))
        mock_response = unittest.mock.MagicMock()
        mock_response.input_tokens = 42
        anthropic_client.messages.count_tokens = unittest.mock.AsyncMock(return_value=mock_response)

        result = await model_with_client.count_tokens(
            messages=messages,
            system_prompt="Be helpful.",
            system_prompt_content=[{"text": "Be helpful."}],
        )

        assert result == 42
        call_kwargs = anthropic_client.messages.count_tokens.call_args[1]
        assert call_kwargs["system"] == [
            {"type": "text", "text": "Be helpful.", "cache_control": {"type": "ephemeral"}}
        ]

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


@pytest.mark.filterwarnings("ignore:cache_tools is deprecated:DeprecationWarning")
class TestPromptCaching:
    """Prompt caching via ``cache_config`` / ``cache_tools``.

    Anthropic accepts at most 4 cache breakpoints per request and ``ephemeral`` is the only cache type.
    https://docs.claude.com/en/docs/build-with-claude/prompt-caching
    """

    MAX_BREAKPOINTS = 4

    @staticmethod
    def _breakpoints(request):
        """Every cache_control in a formatted request, across tools, system and messages."""
        found = []
        for tool in request.get("tools", []):
            if "cache_control" in tool:
                found.append(("tools", tool["name"], tool["cache_control"]))
        system = request.get("system")
        if isinstance(system, list):
            for block in system:
                if "cache_control" in block:
                    found.append(("system", block.get("type"), block["cache_control"]))
        for msg_idx, message in enumerate(request["messages"]):
            for block in message["content"]:
                if "cache_control" in block:
                    found.append(("messages", msg_idx, block["cache_control"]))
        return found

    @pytest.fixture
    def tool_specs(self):
        return [
            {"description": "tool one", "name": "t1", "inputSchema": {"json": {"type": "object"}}},
            {"description": "tool two", "name": "t2", "inputSchema": {"json": {"type": "object"}}},
        ]

    def test_off_when_unset(self, model, messages, tool_specs):
        """Caching is opt-in: no config means no cache_control anywhere in the request."""
        request = model.format_request(messages, tool_specs)

        assert self._breakpoints(request) == []

    def test_cache_config_adds_breakpoint_to_last_user_message(self, model, messages, model_id, max_tokens):
        model.update_config(cache_config=CacheConfig(strategy="auto"))

        assert model.format_request(messages) == {
            "max_tokens": max_tokens,
            "messages": [
                {"role": "user", "content": [{"type": "text", "text": "test", "cache_control": {"type": "ephemeral"}}]}
            ],
            "model": model_id,
            "tools": [],
        }

    def test_auto_and_anthropic_strategies_coincide(self, model, messages, tool_specs):
        """Documented behavior: the Anthropic API caches on every active Claude model, so ``auto`` has no
        model-support check to apply and the two strategies produce the same request."""
        model.update_config(cache_config=CacheConfig(strategy="auto"))
        auto_request = model.format_request(messages, tool_specs)

        model.update_config(cache_config=CacheConfig(strategy="anthropic"))
        anthropic_request = model.format_request(messages, tool_specs)

        assert auto_request == anthropic_request

    def test_cache_config_ttl_is_carried_onto_cache_control(self, model, messages):
        model.update_config(cache_config=CacheConfig(strategy="auto", ttl="1h"))

        request = model.format_request(messages)

        assert self._breakpoints(request) == [("messages", 0, {"type": "ephemeral", "ttl": "1h"})]

    def test_cache_tools_caches_only_the_last_tool(self, model, messages, tool_specs):
        """One cache_control on the final tool caches the whole tool block, so one breakpoint is enough."""
        model.update_config(cache_tools="default")

        request = model.format_request(messages, tool_specs)

        assert self._breakpoints(request) == [("tools", "t2", {"type": "ephemeral"})]
        assert "cache_control" not in request["tools"][0]

    def test_cache_tools_ttl(self, model, messages, tool_specs):
        model.update_config(cache_tools=CacheToolsConfig(ttl="1h"))

        request = model.format_request(messages, tool_specs)

        assert self._breakpoints(request) == [("tools", "t2", {"type": "ephemeral", "ttl": "1h"})]

    def test_cache_tools_normalizes_bedrock_cache_point_type(self, model, messages, tool_specs):
        """``ephemeral`` is Anthropic's only cache type; Bedrock's ``type`` has no equivalent."""
        model.update_config(cache_tools=CacheToolsConfig(type="default"))

        request = model.format_request(messages, tool_specs)

        assert self._breakpoints(request) == [("tools", "t2", {"type": "ephemeral"})]

    def test_cache_tools_without_tools_is_a_noop(self, model, messages):
        model.update_config(cache_tools="default")

        request = model.format_request(messages, tool_specs=None)

        assert request["tools"] == []
        assert self._breakpoints(request) == []

    def test_cache_tools_is_independent_of_cache_config(self, model, messages, tool_specs):
        """Mirrors Bedrock: ``cache_tools`` applies on its own, without ``cache_config``."""
        model.update_config(cache_tools="default")

        assert self._breakpoints(model.format_request(messages, tool_specs)) == [("tools", "t2", {"type": "ephemeral"})]

    def test_cache_tools_emits_deprecation_warning(self, model, messages, tool_specs):
        """cache_tools is deprecated in favor of CacheConfig(tools_ttl=...); setting it warns."""
        with pytest.warns(DeprecationWarning, match="cache_tools is deprecated. Use CacheConfig"):
            model.update_config(cache_tools="default")

    def test_tools_ttl_true_derives_from_shared_ttl(self, model, messages, tool_specs):
        """tools_ttl=True mirrors system_prompt_ttl: it derives the tools section duration from cache_config.ttl."""
        model.update_config(cache_config=CacheConfig(strategy="auto", ttl="1h", tools_ttl=True))

        breakpoints = self._breakpoints(model.format_request(messages, tool_specs))

        assert breakpoints == [
            ("tools", "t2", {"type": "ephemeral", "ttl": "1h"}),
            ("messages", 0, {"type": "ephemeral", "ttl": "1h"}),
        ]

    def test_tools_ttl_string_sets_the_section_duration(self, model, messages, tool_specs):
        """A tools_ttl string sets the tools section's own duration rather than deriving from the shared ttl."""
        model.update_config(cache_config=CacheConfig(strategy="auto", ttl="1h", tools_ttl="5m"))

        breakpoints = self._breakpoints(model.format_request(messages, tool_specs))

        assert breakpoints == [
            ("tools", "t2", {"type": "ephemeral", "ttl": "5m"}),
            ("messages", 0, {"type": "ephemeral", "ttl": "1h"}),
        ]

    def test_tools_ttl_true_without_shared_ttl_stays_untimed(self, model, messages, tool_specs):
        """With nothing to derive from, tools_ttl=True still caches the tools but at the API default."""
        model.update_config(cache_config=CacheConfig(strategy="auto", tools_ttl=True))

        breakpoints = self._breakpoints(model.format_request(messages, tool_specs))

        assert breakpoints == [
            ("tools", "t2", {"type": "ephemeral"}),
            ("messages", 0, {"type": "ephemeral"}),
        ]

    def test_tools_ttl_false_disables_the_tools_cache_point(self, model, messages, tool_specs):
        """tools_ttl=False disables tool caching even when the shared ttl is set."""
        model.update_config(cache_config=CacheConfig(strategy="auto", ttl="1h", tools_ttl=False))

        breakpoints = self._breakpoints(model.format_request(messages, tool_specs))

        assert not any(bp[0] == "tools" for bp in breakpoints)

    def test_tools_ttl_defaults_to_off(self, model, messages, tool_specs):
        """tools_ttl defaults to None (unset), so cache_config alone does not cache the tools yet."""
        model.update_config(cache_config=CacheConfig(strategy="auto", ttl="1h"))

        breakpoints = self._breakpoints(model.format_request(messages, tool_specs))

        assert not any(bp[0] == "tools" for bp in breakpoints)

    def test_tools_ttl_takes_precedence_over_deprecated_cache_tools(self, model, messages, tool_specs):
        """An explicitly set tools_ttl wins over the deprecated cache_tools when both are set."""
        with pytest.warns(DeprecationWarning, match="cache_tools is deprecated"):
            model.update_config(
                cache_config=CacheConfig(strategy="auto", ttl="1h", tools_ttl="5m"),
                cache_tools=CacheToolsConfig(ttl="1h"),
            )

        breakpoints = self._breakpoints(model.format_request(messages, tool_specs))

        assert breakpoints == [
            ("tools", "t2", {"type": "ephemeral", "ttl": "5m"}),
            ("messages", 0, {"type": "ephemeral", "ttl": "1h"}),
        ]

    def test_tools_ttl_false_overrides_deprecated_cache_tools(self, model, messages, tool_specs):
        """tools_ttl=False disables tool caching even when the deprecated cache_tools is set."""
        with pytest.warns(DeprecationWarning, match="cache_tools is deprecated"):
            model.update_config(
                cache_config=CacheConfig(strategy="auto", ttl="1h", tools_ttl=False),
                cache_tools=CacheToolsConfig(ttl="1h"),
            )

        breakpoints = self._breakpoints(model.format_request(messages, tool_specs))

        assert not any(bp[0] == "tools" for bp in breakpoints)

    def test_both_options_produce_two_breakpoints(self, model, messages, tool_specs):
        model.update_config(cache_config=CacheConfig(strategy="auto"), cache_tools="default")

        breakpoints = self._breakpoints(model.format_request(messages, tool_specs))

        assert breakpoints == [
            ("tools", "t2", {"type": "ephemeral"}),
            ("messages", 0, {"type": "ephemeral"}),
        ]
        assert len(breakpoints) <= self.MAX_BREAKPOINTS

    def test_breakpoints_do_not_accumulate_across_turns(self, model, tool_specs):
        """A cache point per turn would blow the 4-breakpoint limit on the 5th turn.

        Simulates a long tool-using conversation whose history already carries a cache point on every
        turn, as it would if each turn appended one. Exactly one must survive.
        """
        messages = []
        for turn in range(25):
            messages.append(
                {
                    "role": "user",
                    "content": [{"text": f"question {turn}"}, {"cachePoint": {"type": "default"}}],
                }
            )
            messages.append(
                {
                    "role": "assistant",
                    "content": [{"toolUse": {"toolUseId": f"t{turn}", "name": "t1", "input": {}}}],
                }
            )
            messages.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "toolResult": {
                                "toolUseId": f"t{turn}",
                                "content": [{"text": f"result {turn}"}],
                                "status": "success",
                            }
                        },
                        {"cachePoint": {"type": "default"}},
                    ],
                }
            )

        model.update_config(cache_config=CacheConfig(strategy="auto"), cache_tools="default")
        breakpoints = self._breakpoints(model.format_request(messages, tool_specs))

        assert len(breakpoints) <= self.MAX_BREAKPOINTS
        message_breakpoints = [bp for bp in breakpoints if bp[0] == "messages"]
        assert len(message_breakpoints) == 1
        # The surviving breakpoint is on the final tool result, the last cacheable block of the last turn.
        assert message_breakpoints[0][1] == len(messages) - 1

    def test_cache_points_in_earlier_messages_are_stripped(self, model, tool_specs):
        """Only the newest turn keeps a cache point, so points cannot accumulate one per turn."""
        messages = [
            {"role": "user", "content": [{"text": "one"}, {"cachePoint": {"type": "default"}}]},
            {"role": "assistant", "content": [{"text": "two"}]},
            {"role": "user", "content": [{"text": "three"}]},
        ]
        model.update_config(cache_config=CacheConfig(strategy="auto"))

        request = model.format_request(messages, tool_specs)

        assert self._breakpoints(request) == [("messages", 2, {"type": "ephemeral"})]

    def test_honors_a_cache_point_in_the_last_user_message(self, model, caplog):
        """A caller marks where their reusable prefix ends; moving that boundary is what breaks caching.

        With the boundary moved past the per-call block, the cached prefix contains content that differs
        on every request, so every request writes a new entry and none ever reads one. Since a cache write
        costs more than an uncached token, that is worse than not caching at all.

        The mirror of this test is "honors a cache point in the last user message" in
        strands-ts/src/models/__tests__/anthropic.test.ts.
        """
        caplog.set_level(logging.WARNING, logger="strands.models.anthropic")
        messages = [
            {
                "role": "user",
                "content": [
                    {"text": "stable prefix"},
                    {"cachePoint": {"type": "default"}},
                    {"text": "volatile per-call content"},
                ],
            }
        ]
        model.update_config(cache_config=CacheConfig(strategy="auto"))

        request = model.format_request(messages)

        content = request["messages"][0]["content"]
        assert self._breakpoints(request) == [("messages", 0, {"type": "ephemeral"})]
        assert content[0]["cache_control"] == {"type": "ephemeral"}
        assert "cache_control" not in content[1]
        # Nothing was discarded, so the strip warning must stay silent.
        assert "stripped extra cache points" not in caplog.text

    def test_extra_cache_points_in_the_last_user_message_are_stripped(self, model, caplog):
        """One boundary per message: the first marks the prefix, the rest would spend the shared budget."""
        caplog.set_level(logging.WARNING, logger="strands.models.anthropic")
        messages = [
            {
                "role": "user",
                "content": [
                    {"text": "a"},
                    {"cachePoint": {"type": "default"}},
                    {"text": "b"},
                    {"cachePoint": {"type": "default"}},
                    {"text": "c"},
                    {"cachePoint": {"type": "default"}},
                ],
            }
        ]
        model.update_config(cache_config=CacheConfig(strategy="auto"))

        request = model.format_request(messages)

        content = request["messages"][0]["content"]
        assert self._breakpoints(request) == [("messages", 0, {"type": "ephemeral"})]
        assert content[0]["cache_control"] == {"type": "ephemeral"}
        assert "count=<2>" in caplog.text
        assert "stripped extra cache points" in caplog.text

    def test_stripping_cache_points_outside_the_honored_one_warns(self, model, caplog):
        """Discarding a point the caller placed can cost them caching, so it must not be silent."""
        caplog.set_level(logging.WARNING, logger="strands.models.anthropic")
        messages = [
            {"role": "user", "content": [{"text": "stable"}, {"cachePoint": {"type": "default"}}]},
            {"role": "assistant", "content": [{"text": "reply"}]},
            {"role": "user", "content": [{"text": "newest"}, {"cachePoint": {"type": "default"}}]},
        ]
        model.update_config(cache_config=CacheConfig(strategy="auto"))

        request = model.format_request(messages)

        assert self._breakpoints(request) == [("messages", 2, {"type": "ephemeral"})]
        assert "count=<1>" in caplog.text
        assert "stripped extra cache points" in caplog.text

    def test_no_warning_when_the_caller_placed_no_cache_points(self, model, caplog):
        """The strip warning must not fire on the ordinary managed path, where nothing was discarded."""
        caplog.set_level(logging.WARNING, logger="strands.models.anthropic")
        messages = [{"role": "user", "content": [{"text": "no hand-placed points here"}]}]
        model.update_config(cache_config=CacheConfig(strategy="auto"))

        model.format_request(messages)

        assert "stripped extra cache points" not in caplog.text

    def test_honored_point_inherits_the_configured_ttl(self, model):
        """A point carrying no TTL gets the configured one, so ``ttl`` is not lost by placing it yourself."""
        model.update_config(cache_config=CacheConfig(strategy="auto", ttl="1h"))
        messages = [
            {"role": "user", "content": [{"text": "stable"}, {"cachePoint": {"type": "default"}}, {"text": "volatile"}]}
        ]

        request = model.format_request(messages)

        assert self._breakpoints(request) == [("messages", 0, {"type": "ephemeral", "ttl": "1h"})]

    def test_hand_placed_ttl_wins_over_the_configured_one(self, model):
        """The TTL written on the point is the more specific instruction."""
        model.update_config(cache_config=CacheConfig(strategy="auto", ttl="1h"))
        messages = [
            {
                "role": "user",
                "content": [{"text": "stable"}, {"cachePoint": {"type": "default", "ttl": "5m"}}, {"text": "volatile"}],
            }
        ]

        request = model.format_request(messages)

        assert self._breakpoints(request) == [("messages", 0, {"type": "ephemeral", "ttl": "5m"})]

    def test_honored_point_lands_on_the_nearest_acceptable_block_ahead_of_it(self, model):
        """Honoring scans back from the point, never forward: a boundary is where the prefix *ends*."""
        model.update_config(cache_config=CacheConfig(strategy="auto"))
        messages = [
            {
                "role": "user",
                "content": [
                    {"text": "stable"},
                    {"reasoningContent": {"reasoningText": {"text": "r", "signature": "s"}}},
                    {"cachePoint": {"type": "default"}},
                    {"text": "volatile"},
                ],
            }
        ]

        request = model.format_request(messages)

        content = request["messages"][0]["content"]
        assert self._breakpoints(request) == [("messages", 0, {"type": "ephemeral"})]
        assert content[0]["cache_control"] == {"type": "ephemeral"}
        assert content[1]["type"] == "thinking"
        assert "cache_control" not in content[1]
        assert "cache_control" not in content[2]

    def test_leading_cache_point_falls_back_to_automatic_placement(self, model, caplog):
        """With nothing ahead of it there is no prefix to cache, so the boundary cannot be honored.

        Automatic placement then applies, which is what the request would have carried without the point.
        The mirror of this test is "falls back to automatic placement for a leading cache point" in
        strands-ts/src/models/__tests__/anthropic.test.ts.
        """
        caplog.set_level(logging.WARNING, logger="strands.models.anthropic")
        model.update_config(cache_config=CacheConfig(strategy="auto"))
        messages = [{"role": "user", "content": [{"cachePoint": {"type": "default"}}, {"text": "one"}]}]

        request = model.format_request(messages)

        assert self._breakpoints(request) == [("messages", 0, {"type": "ephemeral"})]
        assert "falling back to automatic placement" in caplog.text

    def test_honored_point_falls_back_when_everything_ahead_is_dropped_in_translation(self, model):
        """An image with a location source is an accepted carrier by block type but never reaches the API,
        so a point behind one has nothing to mark and automatic placement applies instead."""
        model.update_config(cache_config=CacheConfig(strategy="auto"))
        messages = [
            {
                "role": "user",
                "content": [
                    {"image": {"format": "png", "source": {"location": {"uri": "s3://b/k"}}}},
                    {"cachePoint": {"type": "default"}},
                    {"text": "volatile"},
                ],
            }
        ]

        request = model.format_request(messages)

        assert request["messages"][0]["content"] == [
            {"type": "text", "text": "volatile", "cache_control": {"type": "ephemeral"}}
        ]

    def test_honored_point_falls_back_when_only_a_reasoning_block_is_ahead_of_it(self, model):
        """The API rejects ``cache_control`` on a thinking block, so it cannot carry an honored boundary."""
        model.update_config(cache_config=CacheConfig(strategy="auto"))
        messages = [
            {
                "role": "user",
                "content": [
                    {"reasoningContent": {"reasoningText": {"text": "r", "signature": "s"}}},
                    {"cachePoint": {"type": "default"}},
                    {"text": "volatile"},
                ],
            }
        ]

        request = model.format_request(messages)

        content = request["messages"][0]["content"]
        assert self._breakpoints(request) == [("messages", 0, {"type": "ephemeral"})]
        assert content[0]["type"] == "thinking"
        assert "cache_control" not in content[0]
        assert content[1]["cache_control"] == {"type": "ephemeral"}

    def test_a_cache_point_only_last_user_message_is_not_the_target(self, model, caplog):
        """A message of nothing but cache points reaches the API as no message at all, so the newest turn
        that does reach it owns the breakpoint. Its point is stripped like any other extra one.

        The mirror of this test is "does not treat a cache-point-only last user message as the target" in
        strands-ts/src/models/__tests__/anthropic.test.ts.
        """
        caplog.set_level(logging.WARNING, logger="strands.models.anthropic")
        model.update_config(cache_config=CacheConfig(strategy="auto"))
        messages = [
            {"role": "user", "content": [{"text": "stable"}]},
            {"role": "user", "content": [{"cachePoint": {"type": "default"}}]},
        ]

        request = model.format_request(messages)

        assert self._breakpoints(request) == [("messages", 0, {"type": "ephemeral"})]
        assert "count=<1>" in caplog.text

    def test_honoring_never_exceeds_one_message_breakpoint(self, model):
        """The whole point of the strip: an honored point replaces automatic placement, it does not add to it."""
        model.update_config(cache_config=CacheConfig(strategy="auto"))
        messages = [
            {
                "role": "user",
                "content": [{"text": "a"}, {"cachePoint": {"type": "default"}}, {"text": "b"}, {"text": "c"}],
            }
        ]

        request = model.format_request(messages)

        assert len(self._breakpoints(request)) == 1

    def test_hand_placed_cache_points_are_honored_without_cache_config(self, model):
        """Leaving cache_config unset is the documented way to keep control of placement."""
        messages = [
            {
                "role": "user",
                "content": [
                    {"text": "stable prefix"},
                    {"cachePoint": {"type": "default"}},
                    {"text": "volatile per-call content"},
                ],
            }
        ]

        request = model.format_request(messages)

        content = request["messages"][0]["content"]
        assert content[0]["cache_control"] == {"type": "ephemeral"}
        assert "cache_control" not in content[1]

    def test_caller_messages_are_not_mutated(self, model):
        messages = [{"role": "user", "content": [{"text": "one"}, {"cachePoint": {"type": "default"}}]}]
        before = copy.deepcopy(messages)
        model.update_config(cache_config=CacheConfig(strategy="auto"))

        model.format_request(messages)

        assert messages == before

    def test_breakpoint_lands_after_last_cacheable_block(self, model):
        """Anthropic rejects cache_control on a thinking block, so the cache point skips back past it."""
        messages = [
            {
                "role": "user",
                "content": [
                    {"text": "question"},
                    {"reasoningContent": {"reasoningText": {"text": "thinking", "signature": "sig"}}},
                ],
            }
        ]
        model.update_config(cache_config=CacheConfig(strategy="auto"))

        request = model.format_request(messages)

        content = request["messages"][0]["content"]
        assert content[0] == {"type": "text", "text": "question", "cache_control": {"type": "ephemeral"}}
        assert "cache_control" not in content[1]

    def test_no_cacheable_content_is_skipped(self, model, caplog):
        caplog.set_level(logging.DEBUG, logger="strands.models.anthropic")
        messages = [
            {
                "role": "user",
                "content": [{"reasoningContent": {"reasoningText": {"text": "thinking", "signature": "sig"}}}],
            }
        ]
        model.update_config(cache_config=CacheConfig(strategy="auto"))

        request = model.format_request(messages)

        assert self._breakpoints(request) == []
        assert "skipped cache point" in caplog.text

    def test_assistant_only_history_is_skipped(self, model):
        messages = [{"role": "assistant", "content": [{"text": "hello"}]}]
        model.update_config(cache_config=CacheConfig(strategy="auto"))

        assert self._breakpoints(model.format_request(messages)) == []

    def test_existing_cache_points_are_stripped_even_with_nothing_to_cache(self, model):
        """cache_config owns message breakpoints whenever it is set, not only when it found a block to mark.

        The mirror of this test is "strips hand-placed cache points even when there is nothing to cache"
        in strands-ts/src/models/__tests__/anthropic.test.ts.
        """
        messages = [{"role": "assistant", "content": [{"text": "hello"}, {"cachePoint": {"type": "default"}}]}]
        model.update_config(cache_config=CacheConfig(strategy="auto"))

        assert self._breakpoints(model.format_request(messages)) == []

    def test_unknown_strategy_disables_caching(self, model, messages, caplog):
        caplog.set_level(logging.WARNING, logger="strands.models.anthropic")
        model.update_config(cache_config=CacheConfig(strategy="nonsense"))

        request = model.format_request(messages)

        assert self._breakpoints(request) == []
        assert "unknown cache strategy" in caplog.text

    def test_manual_cache_point_ttl_is_honored(self, model):
        """A hand-placed cache point carries its own TTL; ``cache_config`` need not be set."""
        messages = [{"role": "user", "content": [{"text": "one"}, {"cachePoint": {"type": "default", "ttl": "1h"}}]}]

        request = model.format_request(messages)

        assert self._breakpoints(request) == [("messages", 0, {"type": "ephemeral", "ttl": "1h"})]

    def test_leading_cache_point_is_skipped(self, model, caplog):
        """A cache point marks the preceding block; with none there is no prefix to cache."""
        caplog.set_level(logging.WARNING, logger="strands.models.anthropic")
        messages = [{"role": "user", "content": [{"cachePoint": {"type": "default"}}, {"text": "one"}]}]

        request = model.format_request(messages)

        assert self._breakpoints(request) == []
        assert "no preceding block accepts a cache point" in caplog.text

    def test_breakpoint_survives_a_block_dropped_in_translation(self, model):
        """An image with a location source is an accepted cache carrier by block type but is dropped when
        the request is formatted. The breakpoint has to fall back to the block before it rather than
        vanish, or enabling caching would remove the caching that worked without it."""
        model.update_config(cache_config=CacheConfig(strategy="auto"))
        messages = [
            {
                "role": "user",
                "content": [
                    {"text": "long prefix"},
                    {"image": {"format": "png", "source": {"location": {"uri": "s3://b/k"}}}},
                ],
            }
        ]

        request = model.format_request(messages)

        assert self._breakpoints(request) == [("messages", 0, {"type": "ephemeral"})]
        assert request["messages"][0]["content"] == [
            {"type": "text", "text": "long prefix", "cache_control": {"type": "ephemeral"}}
        ]

    def test_breakpoint_never_lands_on_a_reasoning_block(self, model):
        """The API rejects ``cache_control`` on a thinking block, so a request that would only be able to
        place one there must emit no breakpoint at all."""
        model.update_config(cache_config=CacheConfig(strategy="auto"))
        messages = [
            {
                "role": "user",
                "content": [
                    {"reasoningContent": {"reasoningText": {"text": "thinking", "signature": "sig"}}},
                    {"image": {"format": "png", "source": {"location": {"uri": "s3://b/k"}}}},
                ],
            }
        ]

        request = model.format_request(messages)

        assert self._breakpoints(request) == []
        assert "cache_control" not in request["messages"][0]["content"][0]

    def test_no_fallback_to_an_earlier_turn(self, model):
        """Caching a prefix that has stopped growing would pin every later turn to a stale entry."""
        model.update_config(cache_config=CacheConfig(strategy="auto"))
        messages = [
            {"role": "user", "content": [{"text": "turn one"}]},
            {"role": "assistant", "content": [{"text": "reply"}]},
            {"role": "user", "content": [{"reasoningContent": {"reasoningText": {"text": "r", "signature": "s"}}}]},
        ]

        request = model.format_request(messages)

        assert self._breakpoints(request) == []

    def test_breakpoint_lands_on_the_last_of_several_cacheable_blocks(self, model):
        """Placement on the *last* cacheable block is what makes the cached prefix cover the whole turn."""
        model.update_config(cache_config=CacheConfig(strategy="auto"))
        messages = [
            {
                "role": "user",
                "content": [
                    {"text": "first"},
                    {"toolResult": {"toolUseId": "x", "content": [{"text": "second"}], "status": "success"}},
                ],
            }
        ]

        request = model.format_request(messages)

        content = request["messages"][0]["content"]
        assert self._breakpoints(request) == [("messages", 0, {"type": "ephemeral"})]
        assert "cache_control" not in content[0]
        assert content[1]["type"] == "tool_result"
        assert content[1]["cache_control"] == {"type": "ephemeral"}

    def test_empty_cache_tools_is_treated_as_unset(self, model, messages, tool_specs):
        """``cache_tools=""`` is what an unset environment variable produces; it must not enable caching."""
        model.update_config(cache_tools="")

        assert self._breakpoints(model.format_request(messages, tool_specs)) == []

    def test_manual_cache_point_attaches_to_nearest_acceptable_block(self, model):
        """A hand-placed cache point after a reasoning block skips back to the text block rather than
        producing a request the API rejects."""
        messages = [
            {
                "role": "user",
                "content": [
                    {"text": "question"},
                    {"reasoningContent": {"reasoningText": {"text": "thinking", "signature": "sig"}}},
                    {"cachePoint": {"type": "default"}},
                ],
            }
        ]

        content = model.format_request(messages)["messages"][0]["content"]

        assert content[0]["cache_control"] == {"type": "ephemeral"}
        assert "cache_control" not in content[1]

    def test_cross_sdk_media_request_parity(self, model):
        """Mirror of ``pins the media request body shared with strands-py`` in
        strands-ts/src/models/__tests__/anthropic.test.ts. Update both together or the SDKs will drift.

        Text-only parity cannot catch a breakpoint lost while translating a media block, which is exactly
        what regressed in the TypeScript implementation.
        """
        model.update_config(cache_config=CacheConfig(strategy="auto"))
        messages = [
            {
                "role": "user",
                "content": [
                    {"text": "prefix"},
                    {"image": {"format": "png", "source": {"bytes": bytes([1, 2, 3])}}},
                    # Dropped in translation: the breakpoint must fall back to the image above.
                    {"image": {"format": "png", "source": {"location": {"uri": "s3://b/k"}}}},
                ],
            }
        ]

        request = model.format_request(messages)

        assert request["messages"] == [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "prefix"},
                    {
                        "type": "image",
                        "source": {"type": "base64", "media_type": "image/png", "data": "AQID"},
                        "cache_control": {"type": "ephemeral"},
                    },
                ],
            }
        ]

    def test_cross_sdk_request_parity(self, model, tool_specs):
        """Pins the exact request body strands-ts must produce for the same config.

        The mirror of this test lives in strands-ts/src/models/__tests__/anthropic.test.ts. Update both
        together or the two SDKs will drift.
        """
        model.update_config(cache_config=CacheConfig(strategy="auto", ttl="1h"), cache_tools=CacheToolsConfig(ttl="1h"))
        messages = [
            {"role": "user", "content": [{"text": "hello"}]},
            {"role": "assistant", "content": [{"text": "hi"}]},
            {"role": "user", "content": [{"text": "again"}]},
        ]

        request = model.format_request(messages, tool_specs)

        assert request["tools"] == [
            {"name": "t1", "description": "tool one", "input_schema": {"type": "object"}},
            {
                "name": "t2",
                "description": "tool two",
                "input_schema": {"type": "object"},
                "cache_control": {"type": "ephemeral", "ttl": "1h"},
            },
        ]
        assert request["messages"] == [
            {"role": "user", "content": [{"type": "text", "text": "hello"}]},
            {"role": "assistant", "content": [{"type": "text", "text": "hi"}]},
            {
                "role": "user",
                "content": [{"type": "text", "text": "again", "cache_control": {"type": "ephemeral", "ttl": "1h"}}],
            },
        ]

    def test_dynamic_trailing_blocks_keeps_the_cache_point_ahead_of_per_call_content(self, model):
        """The reusable prefix ends where per-call content begins, so the cache point precedes it."""
        model.update_config(cache_config=CacheConfig(strategy="auto"))
        messages = [{"role": "user", "content": [{"text": "durable ask"}, {"text": "per-call"}]}]

        request = model.format_request(messages, dynamic_trailing_blocks=1)

        blocks = request["messages"][0]["content"]
        assert [("cache_control" in block, block["text"]) for block in blocks] == [
            (True, "durable ask"),
            (False, "per-call"),
        ]

    def test_dynamic_trailing_blocks_covers_every_block_of_a_multi_block_tail(self, model):
        model.update_config(cache_config=CacheConfig(strategy="auto"))
        messages = [{"role": "user", "content": [{"text": "durable ask"}, {"text": "injected"}, {"text": "status"}]}]

        request = model.format_request(messages, dynamic_trailing_blocks=2)

        blocks = request["messages"][0]["content"]
        assert [("cache_control" in block, block["text"]) for block in blocks] == [
            (True, "durable ask"),
            (False, "injected"),
            (False, "status"),
        ]

    def test_dynamic_trailing_blocks_skips_the_cache_point_when_nothing_durable_precedes_it(self, model):
        """With no durable prefix there is nothing worth a cache point, so none is emitted."""
        model.update_config(cache_config=CacheConfig(strategy="auto"))
        messages = [{"role": "user", "content": [{"text": "per-call only"}]}]

        request = model.format_request(messages, dynamic_trailing_blocks=1)

        assert self._breakpoints(request) == []

    def test_dynamic_trailing_blocks_carries_the_configured_ttl(self, model):
        model.update_config(cache_config=CacheConfig(strategy="auto", ttl="1h"))
        messages = [{"role": "user", "content": [{"text": "durable ask"}, {"text": "per-call"}]}]

        request = model.format_request(messages, dynamic_trailing_blocks=1)

        assert self._breakpoints(request) == [("messages", 0, {"type": "ephemeral", "ttl": "1h"})]

    def test_no_dynamic_trailing_blocks_places_the_cache_point_on_the_last_block(self, model):
        model.update_config(cache_config=CacheConfig(strategy="auto"))
        messages = [{"role": "user", "content": [{"text": "durable ask"}, {"text": "also durable"}]}]

        request = model.format_request(messages)

        blocks = request["messages"][0]["content"]
        assert [("cache_control" in block, block["text"]) for block in blocks] == [
            (False, "durable ask"),
            (True, "also durable"),
        ]

    def test_dynamic_trailing_blocks_emits_no_cache_point_without_cache_config(self, model):
        """A per-call tail says where a cache point would go, never that one should exist."""
        messages = [{"role": "user", "content": [{"text": "durable ask"}, {"text": "per-call"}]}]

        request = model.format_request(messages, dynamic_trailing_blocks=1)

        assert self._breakpoints(request) == []

    def test_string_system_prompt_is_promoted_to_a_cached_block(self, model, messages):
        """A plain string carries no cache_control, so it is rendered to a block that can."""
        model.update_config(cache_config=CacheConfig(strategy="auto"))

        request = model.format_request(messages, system_prompt="static prompt")

        assert request["system"] == [{"type": "text", "text": "static prompt", "cache_control": {"type": "ephemeral"}}]

    def test_auto_injects_a_system_cache_point_on_the_last_block(self, model, messages):
        model.update_config(cache_config=CacheConfig(strategy="auto"))
        system_prompt_content = [{"text": "Heavy context"}, {"text": "More context"}]

        request = model.format_request(messages, system_prompt_content=system_prompt_content)

        # The default messages section also caches the last user message, so both points are present.
        assert self._breakpoints(request) == [
            ("system", "text", {"type": "ephemeral"}),
            ("messages", 0, {"type": "ephemeral"}),
        ]
        assert "cache_control" not in request["system"][0]
        assert request["system"][1]["cache_control"] == {"type": "ephemeral"}

    def test_auto_injected_system_cache_point_inherits_cache_config_ttl(self, model, messages):
        model.update_config(cache_config=CacheConfig(strategy="auto", ttl="1h"))

        request = model.format_request(messages, system_prompt="static prompt")

        assert request["system"][0]["cache_control"] == {"type": "ephemeral", "ttl": "1h"}

    def test_system_prompt_ttl_false_leaves_the_system_prompt_uncached(self, model, messages):
        model.update_config(cache_config=CacheConfig(strategy="auto", system_prompt_ttl=False))

        request = model.format_request(messages, system_prompt="static prompt")

        assert request["system"] == "static prompt"

    def test_system_prompt_ttl_string_sets_the_section_duration(self, model, messages):
        """A system_prompt_ttl string sets the system section's own duration rather than deriving from shared ttl."""
        model.update_config(cache_config=CacheConfig(strategy="auto", ttl="5m", system_prompt_ttl="1h"))

        request = model.format_request(messages, system_prompt="static prompt")

        assert request["system"][0]["cache_control"] == {"type": "ephemeral", "ttl": "1h"}

    def test_hand_placed_system_cache_point_is_not_doubled(self, model, messages):
        model.update_config(cache_config=CacheConfig(strategy="auto"))
        system_prompt_content = [
            {"text": "Heavy context"},
            {"cachePoint": {"type": "default"}},
            {"text": "Light context"},
        ]

        request = model.format_request(messages, system_prompt_content=system_prompt_content)

        # The placed point on the first block is honored; the last block is not also cached.
        assert self._breakpoints(request) == [
            ("system", "text", {"type": "ephemeral"}),
            ("messages", 0, {"type": "ephemeral"}),
        ]
        assert request["system"][0]["cache_control"] == {"type": "ephemeral"}
        assert "cache_control" not in request["system"][1]

    def test_hand_placed_system_cache_point_inherits_cache_config_ttl(self, model, messages):
        """Parity with the messages path: a placed point with no TTL fills in ``cache_config.ttl``."""
        model.update_config(cache_config=CacheConfig(strategy="auto", ttl="1h"))
        system_prompt_content = [{"text": "Heavy context"}, {"cachePoint": {"type": "default"}}]

        request = model.format_request(messages, system_prompt_content=system_prompt_content)

        assert request["system"][0]["cache_control"] == {"type": "ephemeral", "ttl": "1h"}

    def test_hand_placed_system_cache_point_keeps_its_own_ttl(self, model, messages):
        """A TTL the caller wrote is more specific than the configured one."""
        model.update_config(cache_config=CacheConfig(strategy="auto", ttl="1h"))
        system_prompt_content = [{"text": "Heavy context"}, {"cachePoint": {"type": "default", "ttl": "5m"}}]

        request = model.format_request(messages, system_prompt_content=system_prompt_content)

        assert request["system"][0]["cache_control"] == {"type": "ephemeral", "ttl": "5m"}

    def test_hand_placed_system_cache_point_is_honored_without_cache_config(self, model, messages):
        """Mirrors the messages path: a placed point is honored even with caching unconfigured."""
        system_prompt_content = [{"text": "Heavy context"}, {"cachePoint": {"type": "default"}}]

        request = model.format_request(messages, system_prompt_content=system_prompt_content)

        assert self._breakpoints(request) == [("system", "text", {"type": "ephemeral"})]

    def test_system_prompt_content_without_a_placed_point_is_uncached_without_cache_config(self, model, messages):
        system_prompt_content = [{"text": "Heavy context"}]

        request = model.format_request(messages, system_prompt_content=system_prompt_content)

        assert request["system"] == [{"type": "text", "text": "Heavy context"}]
        assert self._breakpoints(request) == []

    def test_adjacent_system_cache_points_keep_the_first_and_warn(self, model, messages, caplog):
        """First-wins parity with the messages path: a second point on a block already carrying one is
        dropped, not applied over the first. Swapping the two TTLs swaps which value survives."""
        caplog.set_level(logging.WARNING, logger="strands.models.anthropic")

        def system_points(system_prompt_content):
            request = model.format_request(messages, system_prompt_content=system_prompt_content)
            return [point for point in self._breakpoints(request) if point[0] == "system"]

        first_wins = system_points(
            [{"text": "ctx"}, {"cachePoint": {"type": "default", "ttl": "1h"}}, {"cachePoint": {"type": "default"}}]
        )
        swapped = system_points(
            [{"text": "ctx"}, {"cachePoint": {"type": "default"}}, {"cachePoint": {"type": "default", "ttl": "1h"}}]
        )

        assert first_wins == [("system", "text", {"type": "ephemeral", "ttl": "1h"})]
        assert swapped == [("system", "text", {"type": "ephemeral"})]
        assert "stripped an extra system cache point" in caplog.text

    def test_tool_choice_and_dynamic_trailing_blocks_stay_positional(self, model, messages, tool_specs):
        """tool_choice and dynamic_trailing_blocks keep their released positional slots so an existing
        positional call still routes them; only system_prompt_content is keyword-only."""
        request = model.format_request(messages, tool_specs, "SYSTEM", {"any": {}}, 1)

        assert request["tool_choice"] == {"type": "any"}

    def test_system_prompt_content_is_keyword_only(self, model, messages, tool_specs):
        """system_prompt_content is keyword-only so a sixth positional argument fails loudly rather than
        landing silently in it."""
        with pytest.raises(TypeError):
            model.format_request(messages, tool_specs, "SYSTEM", {"any": {}}, 1, [{"text": "ctx"}])

    def test_untimed_cache_tools_inherits_cache_config_ttl(self, model, messages, tool_specs):
        """Mirrors the Bedrock tools point: an untimed cache_tools inherits cache_config.ttl so it is not
        the lone 5m point ahead of the 1h system/messages points, which the API rejects."""
        model.update_config(cache_config=CacheConfig(strategy="anthropic", ttl="1h"), cache_tools="default")

        breakpoints = self._breakpoints(model.format_request(messages, tool_specs))

        assert breakpoints == [
            ("tools", "t2", {"type": "ephemeral", "ttl": "1h"}),
            ("messages", 0, {"type": "ephemeral", "ttl": "1h"}),
        ]

    def test_leading_system_cache_point_falls_through_to_automatic_placement(self, model, messages):
        """A point ahead of every text block cannot attach; auto-injection still caches the last block."""
        model.update_config(cache_config=CacheConfig(strategy="auto"))
        system_prompt_content = [{"cachePoint": {"type": "default"}}, {"text": "ctx"}]

        request = model.format_request(messages, system_prompt_content=system_prompt_content)

        assert request["system"] == [{"type": "text", "text": "ctx", "cache_control": {"type": "ephemeral"}}]

    def test_system_prompt_content_with_no_renderable_blocks_omits_the_system_field(self, model, messages):
        """Blocks carrying neither text nor a cache point render nothing, so no system field is sent."""
        request = model.format_request(messages, system_prompt_content=[{}])

        assert "system" not in request
