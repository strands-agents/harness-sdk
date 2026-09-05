import logging
import os
import unittest.mock

import httpx
import openai
import pydantic
import pytest
from openai.types.responses import Response, ResponseErrorEvent, ResponseFailedEvent
from openai.types.responses.response_error import ResponseError

import strands
from strands.models import CacheConfig
from strands.models.openai_responses import _MAX_MEDIA_SIZE_BYTES, OpenAIResponsesModel
from strands.types.exceptions import ContextWindowOverflowException, ModelThrottledException


@pytest.fixture
def openai_client():
    with unittest.mock.patch.object(strands.models.openai_responses.openai, "AsyncOpenAI") as mock_client_cls:
        mock_client = unittest.mock.AsyncMock()
        mock_client_cls.return_value.__aenter__.return_value = mock_client
        yield mock_client


@pytest.fixture
def model_id():
    return "gpt-4o"


@pytest.fixture
def model(openai_client, model_id):
    _ = openai_client
    return OpenAIResponsesModel(model_id=model_id, params={"max_output_tokens": 100})


@pytest.fixture
def messages():
    return [{"role": "user", "content": [{"text": "test"}]}]


@pytest.fixture
def tool_specs():
    return [
        {
            "name": "test_tool",
            "description": "A test tool",
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "input": {"type": "string"},
                    },
                    "required": ["input"],
                },
            },
        },
    ]


@pytest.fixture
def system_prompt():
    return "s1"


@pytest.fixture
def test_output_model_cls():
    class TestOutputModel(pydantic.BaseModel):
        name: str
        age: int

    return TestOutputModel


def test__init__(model_id):
    model = OpenAIResponsesModel(model_id=model_id, params={"max_output_tokens": 100})

    tru_config = model.get_config()
    exp_config = {"model_id": "gpt-4o", "params": {"max_output_tokens": 100}, "context_window_limit": 128_000}

    assert tru_config == exp_config


def test__init__auto_populates_context_window_limit():
    model = OpenAIResponsesModel(model_id="gpt-4o")

    assert model.get_config().get("context_window_limit") == 128_000


def test__init__explicit_context_window_limit_not_overridden():
    model = OpenAIResponsesModel(model_id="gpt-4o", context_window_limit=50_000)

    assert model.get_config().get("context_window_limit") == 50_000


def test__init__unknown_model_no_context_window_limit():
    model = OpenAIResponsesModel(model_id="unknown-model")

    assert model.get_config().get("context_window_limit") is None


def test_update_config(model, model_id):
    model.update_config(model_id=model_id)

    tru_model_id = model.get_config().get("model_id")
    exp_model_id = model_id

    assert tru_model_id == exp_model_id


@pytest.mark.parametrize(
    "content, exp_result",
    [
        # Document content goes in file_data with a filename, never file_url (#3572)
        (
            {
                "document": {
                    "format": "pdf",
                    "name": "test doc",
                    "source": {"bytes": b"document"},
                },
            },
            {
                "type": "input_file",
                "filename": "test doc.pdf",
                "file_data": "data:application/pdf;base64,ZG9jdW1lbnQ=",
            },
        ),
        # A name that already ends with the format keeps a single extension
        (
            {
                "document": {
                    "format": "pdf",
                    "name": "test doc.pdf",
                    "source": {"bytes": b"document"},
                },
            },
            {
                "type": "input_file",
                "filename": "test doc.pdf",
                "file_data": "data:application/pdf;base64,ZG9jdW1lbnQ=",
            },
        ),
        # Document without the optional name falls back to a default filename
        (
            {
                "document": {
                    "format": "pdf",
                    "source": {"bytes": b"document"},
                },
            },
            {
                "type": "input_file",
                "filename": "document.pdf",
                "file_data": "data:application/pdf;base64,ZG9jdW1lbnQ=",
            },
        ),
        # Image
        (
            {
                "image": {
                    "format": "jpg",
                    "source": {"bytes": b"image"},
                },
            },
            {
                "type": "input_image",
                "image_url": "data:image/jpeg;base64,aW1hZ2U=",
            },
        ),
        # Text
        (
            {"text": "hello"},
            {"type": "input_text", "text": "hello"},
        ),
    ],
)
def test_format_request_message_content(content, exp_result):
    tru_result = OpenAIResponsesModel._format_request_message_content(content)
    assert tru_result == exp_result


def test_format_request_message_content_unsupported_type():
    content = {"unsupported": {}}

    with pytest.raises(TypeError, match="content_type=<unsupported> | unsupported type"):
        OpenAIResponsesModel._format_request_message_content(content)


def test_format_request_message_tool_call_preserves_non_ascii():
    tool_use = {
        "input": {"query": "東京"},
        "name": "search",
        "toolUseId": "c1",
    }

    tru_result = OpenAIResponsesModel._format_request_message_tool_call(tool_use)
    exp_result = {
        "type": "function_call",
        "call_id": "c1",
        "name": "search",
        "arguments": '{"query": "東京"}',
    }
    assert tru_result == exp_result


def test_format_request_tool_message_preserves_non_ascii():
    tool_result = {
        "content": [{"json": {"city": "東京"}}],
        "status": "success",
        "toolUseId": "c1",
    }

    tru_result = OpenAIResponsesModel._format_request_tool_message(tool_result)
    exp_result = {
        "type": "function_call_output",
        "call_id": "c1",
        "output": '{"city": "東京"}',
    }
    assert tru_result == exp_result


def test_format_request_message_tool_call():
    tool_use = {
        "input": {"expression": "2+2"},
        "name": "calculator",
        "toolUseId": "c1",
    }

    tru_result = OpenAIResponsesModel._format_request_message_tool_call(tool_use)
    exp_result = {
        "type": "function_call",
        "call_id": "c1",
        "name": "calculator",
        "arguments": '{"expression": "2+2"}',
    }
    assert tru_result == exp_result


def test_format_request_tool_message():
    tool_result = {
        "content": [{"text": "4"}, {"json": ["4"]}],
        "status": "success",
        "toolUseId": "c1",
    }

    tru_result = OpenAIResponsesModel._format_request_tool_message(tool_result)
    exp_result = {
        "type": "function_call_output",
        "call_id": "c1",
        "output": '4\n["4"]',
    }
    assert tru_result == exp_result


def test_format_request_tool_message_with_image():
    """Test that tool results with images return an array output."""
    tool_result = {
        "content": [
            {"text": "Here is the image:"},
            {"image": {"format": "png", "source": {"bytes": b"fake_image_data"}}},
        ],
        "status": "success",
        "toolUseId": "c2",
    }

    tru_result = OpenAIResponsesModel._format_request_tool_message(tool_result)

    assert tru_result["type"] == "function_call_output"
    assert tru_result["call_id"] == "c2"
    # When images are present, output should be an array
    assert isinstance(tru_result["output"], list)
    assert len(tru_result["output"]) == 2
    assert tru_result["output"][0]["type"] == "input_text"
    assert tru_result["output"][0]["text"] == "Here is the image:"
    assert tru_result["output"][1]["type"] == "input_image"
    assert "image_url" in tru_result["output"][1]


def test_format_request_tool_message_with_document():
    """Test that tool results with documents return an array output.

    Document content must be sent as ``file_data`` + ``filename``, not ``file_url`` —
    Azure OpenAI treats ``file_url`` as a URL to download and rejects a data URI.
    A document without the optional ``name`` falls back to a default filename.
    See: https://github.com/strands-agents/harness-sdk/issues/3572
    """
    tool_result = {
        "content": [
            {"document": {"format": "pdf", "name": "test.pdf", "source": {"bytes": b"fake_pdf_data"}}},
            {"document": {"format": "pdf", "source": {"bytes": b"fake_pdf_data"}}},
        ],
        "status": "success",
        "toolUseId": "c3",
    }

    tru_result = OpenAIResponsesModel._format_request_tool_message(tool_result)

    assert tru_result["type"] == "function_call_output"
    assert tru_result["call_id"] == "c3"
    # When documents are present, output should be an array
    assert isinstance(tru_result["output"], list)
    assert len(tru_result["output"]) == 2
    assert tru_result["output"][0]["type"] == "input_file"
    assert tru_result["output"][0]["filename"] == "test.pdf"
    assert "file_data" in tru_result["output"][0]
    assert "file_url" not in tru_result["output"][0]
    assert tru_result["output"][1]["filename"] == "document.pdf"


def test_format_request_messages(system_prompt):
    messages = [
        {
            "content": [],
            "role": "user",
        },
        {
            "content": [{"text": "hello"}],
            "role": "user",
        },
        {
            "content": [
                {"text": "call tool"},
                {
                    "toolUse": {
                        "input": {"expression": "2+2"},
                        "name": "calculator",
                        "toolUseId": "c1",
                    },
                },
            ],
            "role": "assistant",
        },
        {
            "content": [{"toolResult": {"toolUseId": "c1", "status": "success", "content": [{"text": "4"}]}}],
            "role": "user",
        },
    ]

    tru_result = OpenAIResponsesModel._format_request_messages(messages)
    exp_result = [
        {
            "role": "user",
            "content": [{"type": "input_text", "text": "hello"}],
        },
        {
            "role": "assistant",
            "content": "call tool",
        },
        {
            "type": "function_call",
            "call_id": "c1",
            "name": "calculator",
            "arguments": '{"expression": "2+2"}',
        },
        {
            "type": "function_call_output",
            "call_id": "c1",
            "output": "4",
        },
    ]
    assert tru_result == exp_result


def test_format_request_messages_assistant_text_uses_string_content():
    """Assistant history must use the string EasyInputMessage form.

    A bare ``{"role": "assistant", "content": [{"type": "output_text", ...}]}``
    is not a valid Responses API input item (it is neither a string-content
    EasyInputMessage nor a complete ResponseOutputMessage) and is rejected by
    strict backends such as Bedrock Mantle.
    See: https://github.com/strands-agents/harness-sdk/issues/3388
    """
    messages = [
        {
            "content": [{"text": "Say hello"}],
            "role": "user",
        },
        {
            "content": [{"text": "Hello!"}],
            "role": "assistant",
        },
        {
            "content": [{"text": "Say goodbye"}],
            "role": "user",
        },
    ]

    result = OpenAIResponsesModel._format_request_messages(messages)

    assert result[0] == {
        "role": "user",
        "content": [{"type": "input_text", "text": "Say hello"}],
    }
    assert result[1] == {
        "role": "assistant",
        "content": "Hello!",
    }
    assert result[2] == {
        "role": "user",
        "content": [{"type": "input_text", "text": "Say goodbye"}],
    }


def test_format_request_messages_assistant_multiple_text_blocks_join_with_newline():
    """Multiple assistant text blocks collapse into one newline-joined string."""
    messages = [
        {
            "content": [{"text": "First."}, {"text": "Second."}],
            "role": "assistant",
        },
    ]

    result = OpenAIResponsesModel._format_request_messages(messages)

    assert result == [{"role": "assistant", "content": "First.\nSecond."}]


def test_format_request_messages_assistant_non_text_content_dropped(caplog):
    """Assistant media has no valid Responses input shape and is dropped with a warning."""
    messages = [
        {
            "content": [
                {"text": "Here is the image."},
                {"image": {"format": "png", "source": {"bytes": b"fake-image-data"}}},
            ],
            "role": "assistant",
        },
    ]

    with caplog.at_level(logging.WARNING, logger="strands.models.openai_responses"):
        result = OpenAIResponsesModel._format_request_messages(messages)

    assert result == [{"role": "assistant", "content": "Here is the image."}]
    assert "content_type=<input_image>" in caplog.text


def test_format_request_messages_skips_message_cache_point(caplog):
    messages = [{"role": "user", "content": [{"text": "durable prefix"}, {"cachePoint": {"type": "default"}}]}]

    with caplog.at_level(logging.WARNING, logger="strands.models.openai_responses"):
        result = OpenAIResponsesModel._format_request_messages(messages)

    assert result == [{"role": "user", "content": [{"type": "input_text", "text": "durable prefix"}]}]
    assert "cachePoint content block is not supported by OpenAI Responses" in caplog.text


def test_format_request_messages_assistant_only_non_text_content_dropped_entirely(caplog):
    """An assistant turn with only non-text content collapses to nothing and is omitted."""
    messages = [
        {
            "content": [{"image": {"format": "png", "source": {"bytes": b"fake-image-data"}}}],
            "role": "assistant",
        },
    ]

    with caplog.at_level(logging.WARNING, logger="strands.models.openai_responses"):
        result = OpenAIResponsesModel._format_request_messages(messages)

    assert result == []
    assert "content_type=<input_image>" in caplog.text


def test_format_request_messages_assistant_history_items_are_valid_input_items():
    """Formatted assistant history validates against the OpenAI input item schema."""
    import openai

    messages = [
        {"content": [{"text": "What is 2+2?"}], "role": "user"},
        {"content": [{"text": "4"}], "role": "assistant"},
        {"content": [{"text": "What about 3+3?"}], "role": "user"},
    ]

    result = OpenAIResponsesModel._format_request_messages(messages)

    assistant_item = result[1]
    easy_message_fields = set(openai.types.responses.EasyInputMessageParam.__annotations__)
    assert set(assistant_item) <= easy_message_fields
    assert isinstance(assistant_item["content"], str)


def test_format_request_message_content_role_assistant():
    """_format_request_message_content uses output_text for assistant role."""
    content = {"text": "response text"}
    result = OpenAIResponsesModel._format_request_message_content(content, role="assistant")
    assert result == {"type": "output_text", "text": "response text"}


def test_format_request_message_content_role_user():
    """_format_request_message_content uses input_text for user role (default)."""
    content = {"text": "question"}
    result = OpenAIResponsesModel._format_request_message_content(content, role="user")
    assert result == {"type": "input_text", "text": "question"}


def test_format_request(model, messages, tool_specs, system_prompt):
    tru_request = model._format_request(messages, tool_specs, system_prompt)
    exp_request = {
        "model": "gpt-4o",
        "input": [
            {
                "role": "user",
                "content": [{"type": "input_text", "text": "test"}],
            }
        ],
        "stream": True,
        "store": False,
        "instructions": system_prompt,
        "tools": [
            {
                "type": "function",
                "name": "test_tool",
                "description": "A test tool",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "input": {"type": "string"},
                    },
                    "required": ["input"],
                },
            },
        ],
        "max_output_tokens": 100,
    }
    assert tru_request == exp_request


def test_cache_key_maps_to_prompt_cache_key(openai_client, model_id, messages):
    _ = openai_client
    model = OpenAIResponsesModel(model_id=model_id, cache_config=CacheConfig(cache_key="tenant-42"))

    assert model._format_request(messages)["prompt_cache_key"] == "tenant-42"


def test_cache_key_absent_when_unset(openai_client, model_id, messages):
    _ = openai_client
    model = OpenAIResponsesModel(model_id=model_id, cache_config=CacheConfig())

    assert "prompt_cache_key" not in model._format_request(messages)


def test_explicit_prompt_cache_key_in_params_wins(openai_client, model_id, messages):
    _ = openai_client
    model = OpenAIResponsesModel(
        model_id=model_id,
        params={"prompt_cache_key": "explicit"},
        cache_config=CacheConfig(cache_key="from-config"),
    )

    assert model._format_request(messages)["prompt_cache_key"] == "explicit"


@pytest.mark.parametrize("retention", ["24h", "in_memory"])
def test_translatable_ttl_maps_to_prompt_cache_retention(openai_client, model_id, messages, retention):
    _ = openai_client
    model = OpenAIResponsesModel(model_id=model_id, cache_config=CacheConfig(cache_key="k", ttl=retention))

    assert model._format_request(messages)["prompt_cache_retention"] == retention


def test_untranslatable_ttl_is_ignored_and_warned(openai_client, model_id, messages):
    _ = openai_client
    model = OpenAIResponsesModel(model_id=model_id, cache_config=CacheConfig(cache_key="k", ttl="5m"))

    with pytest.warns(UserWarning, match="not an openai retention value"):
        request = model._format_request(messages)

    assert "prompt_cache_retention" not in request


@pytest.mark.parametrize(
    ("event", "exp_chunk"),
    [
        # Message start
        (
            {"chunk_type": "message_start"},
            {"messageStart": {"role": "assistant"}},
        ),
        # Content Start - Tool Use
        (
            {
                "chunk_type": "content_start",
                "data_type": "tool",
                "data": unittest.mock.Mock(**{"function.name": "calculator", "id": "c1"}),
            },
            {"contentBlockStart": {"start": {"toolUse": {"name": "calculator", "toolUseId": "c1"}}}},
        ),
        # Content Start - Text
        (
            {"chunk_type": "content_start", "data_type": "text"},
            {"contentBlockStart": {"start": {}}},
        ),
        # Content Delta - Tool Use
        (
            {
                "chunk_type": "content_delta",
                "data_type": "tool",
                "data": unittest.mock.Mock(function=unittest.mock.Mock(arguments='{"expression": "2+2"}')),
            },
            {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"expression": "2+2"}'}}}},
        ),
        # Content Delta - Tool Use - None
        (
            {
                "chunk_type": "content_delta",
                "data_type": "tool",
                "data": unittest.mock.Mock(function=unittest.mock.Mock(arguments=None)),
            },
            {"contentBlockDelta": {"delta": {"toolUse": {"input": ""}}}},
        ),
        # Content Delta - Reasoning Text
        (
            {"chunk_type": "content_delta", "data_type": "reasoning_content", "data": "I'm thinking"},
            {"contentBlockDelta": {"delta": {"reasoningContent": {"text": "I'm thinking"}}}},
        ),
        # Content Delta - Citation
        (
            {
                "chunk_type": "content_delta",
                "data_type": "citation",
                "data": {"type": "url_citation", "title": "Example", "url": "https://example.com"},
            },
            {
                "contentBlockDelta": {
                    "delta": {"citation": {"title": "Example", "location": {"web": {"url": "https://example.com"}}}}
                }
            },
        ),
        # Content Delta - Text
        (
            {"chunk_type": "content_delta", "data_type": "text", "data": "hello"},
            {"contentBlockDelta": {"delta": {"text": "hello"}}},
        ),
        # Content Stop
        (
            {"chunk_type": "content_stop"},
            {"contentBlockStop": {}},
        ),
        # Message Stop - Tool Use
        (
            {"chunk_type": "message_stop", "data": "tool_calls"},
            {"messageStop": {"stopReason": "tool_use"}},
        ),
        # Message Stop - Max Tokens
        (
            {"chunk_type": "message_stop", "data": "length"},
            {"messageStop": {"stopReason": "max_tokens"}},
        ),
        # Message Stop - End Turn
        (
            {"chunk_type": "message_stop", "data": "stop"},
            {"messageStop": {"stopReason": "end_turn"}},
        ),
        # Metadata - no cache tokens
        (
            {
                "chunk_type": "metadata",
                "data": unittest.mock.Mock(
                    input_tokens=100, output_tokens=50, total_tokens=150, input_tokens_details=None
                ),
            },
            {
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
            },
        ),
        # Metadata - with cache read tokens
        (
            {
                "chunk_type": "metadata",
                "data": unittest.mock.Mock(
                    input_tokens=100,
                    output_tokens=50,
                    total_tokens=150,
                    input_tokens_details=unittest.mock.Mock(cached_tokens=80),
                ),
            },
            {
                "metadata": {
                    "usage": {
                        "inputTokens": 100,
                        "outputTokens": 50,
                        "totalTokens": 150,
                        "cacheReadInputTokens": 80,
                    },
                    "metrics": {
                        "latencyMs": 0,
                    },
                },
            },
        ),
    ],
)
def test_format_chunk(event, exp_chunk, model):
    tru_chunk = model._format_chunk(event)
    assert tru_chunk == exp_chunk


def test_format_chunk_unknown_type(model):
    event = {"chunk_type": "unknown"}

    with pytest.raises(RuntimeError, match="chunk_type=<unknown> | unknown type"):
        model._format_chunk(event)


def test_format_chunk_metadata_with_cache_tokens(model):
    """Test _format_chunk for metadata with cache tokens present."""
    mock_usage = unittest.mock.Mock()
    mock_usage.input_tokens = 100
    mock_usage.output_tokens = 50
    mock_usage.total_tokens = 150

    mock_tokens_details = unittest.mock.Mock()
    mock_tokens_details.cached_tokens = 25
    mock_usage.input_tokens_details = mock_tokens_details

    event = {"chunk_type": "metadata", "data": mock_usage}

    assert model._format_chunk(event) == {
        "metadata": {
            "usage": {
                "inputTokens": 100,
                "outputTokens": 50,
                "totalTokens": 150,
                "cacheReadInputTokens": 25,
            },
            "metrics": {"latencyMs": 0},
        },
    }


def test_format_chunk_metadata_with_cache_write_tokens(model):
    """cache_write_tokens maps to cacheWriteInputTokens.

    GPT-5.6 reports cache writes alongside reads and bills them at 1.25x the uncached input
    rate, so a dropped counter understates cost rather than merely losing detail.
    """
    mock_usage = unittest.mock.Mock()
    mock_usage.input_tokens = 100
    mock_usage.output_tokens = 50
    mock_usage.total_tokens = 150

    mock_tokens_details = unittest.mock.Mock()
    mock_tokens_details.cached_tokens = 25
    mock_tokens_details.cache_write_tokens = 40
    mock_usage.input_tokens_details = mock_tokens_details

    event = {"chunk_type": "metadata", "data": mock_usage}

    assert model._format_chunk(event) == {
        "metadata": {
            "usage": {
                "inputTokens": 100,
                "outputTokens": 50,
                "totalTokens": 150,
                "cacheReadInputTokens": 25,
                "cacheWriteInputTokens": 40,
            },
            "metrics": {"latencyMs": 0},
        },
    }


def test_format_chunk_metadata_with_zero_cache_write_tokens(model):
    """A zero write counter is omitted, matching how cached_tokens is handled."""
    mock_usage = unittest.mock.Mock()
    mock_usage.input_tokens = 100
    mock_usage.output_tokens = 50
    mock_usage.total_tokens = 150

    mock_tokens_details = unittest.mock.Mock()
    mock_tokens_details.cached_tokens = 25
    mock_tokens_details.cache_write_tokens = 0
    mock_usage.input_tokens_details = mock_tokens_details

    event = {"chunk_type": "metadata", "data": mock_usage}

    usage = model._format_chunk(event)["metadata"]["usage"]

    assert usage["cacheReadInputTokens"] == 25
    assert "cacheWriteInputTokens" not in usage


def test_format_chunk_metadata_on_an_sdk_pin_without_cache_write_tokens(model):
    """Pins predating the field report no write counter; the mapping stays silent."""

    class _TokensDetails:
        cached_tokens = 25

    mock_usage = unittest.mock.Mock()
    mock_usage.input_tokens = 100
    mock_usage.output_tokens = 50
    mock_usage.total_tokens = 150
    mock_usage.input_tokens_details = _TokensDetails()

    event = {"chunk_type": "metadata", "data": mock_usage}

    usage = model._format_chunk(event)["metadata"]["usage"]

    assert usage["cacheReadInputTokens"] == 25
    assert "cacheWriteInputTokens" not in usage


def test_format_chunk_metadata_with_zero_cached_tokens(model):
    """Test _format_chunk for metadata when cached_tokens is 0."""
    mock_usage = unittest.mock.Mock()
    mock_usage.input_tokens = 100
    mock_usage.output_tokens = 50
    mock_usage.total_tokens = 150

    mock_tokens_details = unittest.mock.Mock()
    mock_tokens_details.cached_tokens = 0
    mock_usage.input_tokens_details = mock_tokens_details

    event = {"chunk_type": "metadata", "data": mock_usage}

    assert model._format_chunk(event) == {
        "metadata": {
            "usage": {
                "inputTokens": 100,
                "outputTokens": 50,
                "totalTokens": 150,
            },
            "metrics": {"latencyMs": 0},
        },
    }


def test_format_chunk_metadata_without_token_details(model):
    """Test _format_chunk for metadata when input token details are absent."""
    mock_usage = unittest.mock.Mock()
    mock_usage.input_tokens = 100
    mock_usage.output_tokens = 50
    mock_usage.total_tokens = 150
    mock_usage.input_tokens_details = None

    event = {"chunk_type": "metadata", "data": mock_usage}

    assert model._format_chunk(event) == {
        "metadata": {
            "usage": {
                "inputTokens": 100,
                "outputTokens": 50,
                "totalTokens": 150,
            },
            "metrics": {"latencyMs": 0},
        },
    }


@pytest.mark.asyncio
async def test_stream(openai_client, model_id, model, agenerator, alist):
    # Mock response events
    mock_text_event = unittest.mock.Mock(type="response.output_text.delta", delta="Hello")
    mock_complete_event = unittest.mock.Mock(
        type="response.completed",
        response=unittest.mock.Mock(
            usage=unittest.mock.Mock(input_tokens=10, output_tokens=5, total_tokens=15, input_tokens_details=None)
        ),
    )

    openai_client.responses.create = unittest.mock.AsyncMock(
        return_value=agenerator([mock_text_event, mock_complete_event])
    )

    messages = [{"role": "user", "content": [{"text": "test"}]}]
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
                "usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15},
                "metrics": {"latencyMs": 0},
            }
        },
    ]

    assert len(tru_events) == len(exp_events)
    expected_request = {
        "model": model_id,
        "input": [{"role": "user", "content": [{"type": "input_text", "text": "test"}]}],
        "stream": True,
        "store": False,
        "max_output_tokens": 100,
    }
    openai_client.responses.create.assert_called_once_with(**expected_request)


@pytest.mark.asyncio
async def test_stream_cache_tokens_propagated(openai_client, model, agenerator, alist):
    """Cache read tokens from input_tokens_details are surfaced in the metadata event."""
    mock_text_event = unittest.mock.Mock(type="response.output_text.delta", delta="Hi")
    mock_complete_event = unittest.mock.Mock(
        type="response.completed",
        response=unittest.mock.Mock(
            usage=unittest.mock.Mock(
                input_tokens=100,
                output_tokens=10,
                total_tokens=110,
                input_tokens_details=unittest.mock.Mock(cached_tokens=80),
            )
        ),
    )

    openai_client.responses.create = unittest.mock.AsyncMock(
        return_value=agenerator([mock_text_event, mock_complete_event])
    )

    messages = [{"role": "user", "content": [{"text": "test"}]}]
    tru_events = await alist(model.stream(messages))

    metadata_events = [e for e in tru_events if "metadata" in e]
    assert len(metadata_events) == 1
    usage = metadata_events[0]["metadata"]["usage"]
    assert usage["inputTokens"] == 100
    assert usage["outputTokens"] == 10
    assert usage["totalTokens"] == 110
    assert usage["cacheReadInputTokens"] == 80


@pytest.mark.asyncio
async def test_stream_no_cache_tokens_when_absent(openai_client, model, agenerator, alist):
    """cacheReadInputTokens is omitted from metadata when input_tokens_details is absent."""
    mock_text_event = unittest.mock.Mock(type="response.output_text.delta", delta="Hi")
    mock_complete_event = unittest.mock.Mock(
        type="response.completed",
        response=unittest.mock.Mock(
            usage=unittest.mock.Mock(
                input_tokens=100,
                output_tokens=10,
                total_tokens=110,
                input_tokens_details=None,
            )
        ),
    )

    openai_client.responses.create = unittest.mock.AsyncMock(
        return_value=agenerator([mock_text_event, mock_complete_event])
    )

    messages = [{"role": "user", "content": [{"text": "test"}]}]
    tru_events = await alist(model.stream(messages))

    metadata_events = [e for e in tru_events if "metadata" in e]
    assert len(metadata_events) == 1
    usage = metadata_events[0]["metadata"]["usage"]
    assert "cacheReadInputTokens" not in usage


@pytest.mark.asyncio
async def test_stream_with_tool_calls(openai_client, model, agenerator, alist):
    # Mock tool call events
    mock_tool_event = unittest.mock.Mock(
        type="response.output_item.added",
        item=unittest.mock.Mock(type="function_call", call_id="call_123", name="calculator", id="item_456"),
    )
    mock_args_event = unittest.mock.Mock(
        type="response.function_call_arguments.delta", delta='{"expression": "2+2"}', item_id="item_456"
    )
    mock_complete_event = unittest.mock.Mock(
        type="response.completed",
        response=unittest.mock.Mock(
            usage=unittest.mock.Mock(input_tokens=10, output_tokens=5, total_tokens=15, input_tokens_details=None)
        ),
    )

    openai_client.responses.create = unittest.mock.AsyncMock(
        return_value=agenerator([mock_tool_event, mock_args_event, mock_complete_event])
    )

    messages = [{"role": "user", "content": [{"text": "calculate 2+2"}]}]
    response = model.stream(messages)
    tru_events = await alist(response)

    # Should include tool call events
    assert any("toolUse" in str(event) for event in tru_events)
    assert {"messageStop": {"stopReason": "tool_use"}} in tru_events


@pytest.mark.asyncio
async def test_stream_with_tool_calls_done_event(openai_client, model, agenerator, alist):
    """Test that response.function_call_arguments.done overwrites accumulated deltas."""
    mock_tool_event = unittest.mock.Mock(
        type="response.output_item.added",
        item=unittest.mock.Mock(type="function_call", call_id="call_1", name="calculator", id="item_1"),
    )
    # Simulate partial delta that would produce incomplete JSON
    mock_args_delta = unittest.mock.Mock(
        type="response.function_call_arguments.delta", delta='{"expr', item_id="item_1"
    )
    # The done event provides the complete, correct arguments
    mock_args_done = unittest.mock.Mock(
        type="response.function_call_arguments.done", arguments='{"expression": "2+2"}', item_id="item_1"
    )
    mock_complete_event = unittest.mock.Mock(
        type="response.completed",
        response=unittest.mock.Mock(
            usage=unittest.mock.Mock(input_tokens=10, output_tokens=5, total_tokens=15, input_tokens_details=None)
        ),
    )

    openai_client.responses.create = unittest.mock.AsyncMock(
        return_value=agenerator([mock_tool_event, mock_args_delta, mock_args_done, mock_complete_event])
    )

    messages = [{"role": "user", "content": [{"text": "calculate 2+2"}]}]
    tru_events = await alist(model.stream(messages))

    # Find the tool use delta event and verify it has the final (done) arguments, not the partial delta
    tool_deltas = [e for e in tru_events if "contentBlockDelta" in e and "toolUse" in e["contentBlockDelta"]["delta"]]
    assert len(tool_deltas) == 1
    assert tool_deltas[0]["contentBlockDelta"]["delta"]["toolUse"]["input"] == '{"expression": "2+2"}'


@pytest.mark.asyncio
async def test_stream_response_incomplete(openai_client, model, agenerator, alist):
    """Test that response.incomplete sets stop_reason to length when max_output_tokens is reached."""
    mock_text_event = unittest.mock.Mock(type="response.output_text.delta", delta="Truncated resp")
    mock_incomplete_event = unittest.mock.Mock(
        type="response.incomplete",
        response=unittest.mock.Mock(
            usage=unittest.mock.Mock(input_tokens=10, output_tokens=100, total_tokens=110, input_tokens_details=None),
            incomplete_details=unittest.mock.Mock(reason="max_output_tokens"),
        ),
    )

    openai_client.responses.create = unittest.mock.AsyncMock(
        return_value=agenerator([mock_text_event, mock_incomplete_event])
    )

    messages = [{"role": "user", "content": [{"text": "write a long essay"}]}]
    tru_events = await alist(model.stream(messages))

    assert {"messageStop": {"stopReason": "max_tokens"}} in tru_events
    # Verify usage was still captured
    metadata_events = [e for e in tru_events if "metadata" in e]
    assert len(metadata_events) == 1
    assert metadata_events[0]["metadata"]["usage"]["inputTokens"] == 10
    assert metadata_events[0]["metadata"]["usage"]["outputTokens"] == 100


@pytest.mark.asyncio
async def test_stream_response_incomplete_with_truncated_tool_call(openai_client, model, agenerator, alist):
    """Test that max_tokens takes precedence over tool_use when a function call is cut off."""
    mock_item_added_event = unittest.mock.Mock(
        type="response.output_item.added",
        item=unittest.mock.Mock(type="function_call", call_id="call_1", name="write_file", id="fc_1"),
    )
    mock_args_event = unittest.mock.Mock(
        type="response.function_call_arguments.delta", item_id="fc_1", delta='{"path": "notes.md", "content": "Lorem'
    )
    mock_incomplete_event = unittest.mock.Mock(
        type="response.incomplete",
        response=unittest.mock.Mock(
            usage=unittest.mock.Mock(input_tokens=10, output_tokens=50, total_tokens=60, input_tokens_details=None),
            incomplete_details=unittest.mock.Mock(reason="max_output_tokens"),
        ),
    )

    openai_client.responses.create = unittest.mock.AsyncMock(
        return_value=agenerator([mock_item_added_event, mock_args_event, mock_incomplete_event])
    )

    messages = [{"role": "user", "content": [{"text": "save my notes"}]}]
    tru_events = await alist(model.stream(messages))

    assert {"messageStop": {"stopReason": "max_tokens"}} in tru_events
    assert {"messageStop": {"stopReason": "tool_use"}} not in tru_events


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "event_type",
    [
        "response.reasoning_text.delta",
        "response.reasoning_summary_text.delta",
    ],
)
async def test_stream_reasoning_content(openai_client, model, agenerator, alist, event_type):
    """Test that reasoning content is streamed correctly for both full and summary reasoning events."""
    mock_reasoning_event = unittest.mock.Mock(type=event_type, delta="Let me think...")
    mock_text_event = unittest.mock.Mock(type="response.output_text.delta", delta="The answer is 42")
    mock_complete_event = unittest.mock.Mock(
        type="response.completed",
        response=unittest.mock.Mock(
            usage=unittest.mock.Mock(input_tokens=10, output_tokens=20, total_tokens=30, input_tokens_details=None)
        ),
    )

    openai_client.responses.create = unittest.mock.AsyncMock(
        return_value=agenerator([mock_reasoning_event, mock_text_event, mock_complete_event])
    )

    messages = [{"role": "user", "content": [{"text": "think step by step"}]}]
    tru_events = await alist(model.stream(messages))

    # Verify reasoning content block was emitted
    reasoning_deltas = [
        e for e in tru_events if "contentBlockDelta" in e and "reasoningContent" in e["contentBlockDelta"]["delta"]
    ]
    assert len(reasoning_deltas) == 1
    assert reasoning_deltas[0]["contentBlockDelta"]["delta"]["reasoningContent"]["text"] == "Let me think..."

    # Verify text content block was also emitted
    text_deltas = [e for e in tru_events if "contentBlockDelta" in e and "text" in e["contentBlockDelta"]["delta"]]
    assert len(text_deltas) == 1
    assert text_deltas[0]["contentBlockDelta"]["delta"]["text"] == "The answer is 42"

    # Verify content blocks were properly opened and closed (reasoning start/stop, then text start/stop)
    content_starts = [e for e in tru_events if "contentBlockStart" in e]
    content_stops = [e for e in tru_events if "contentBlockStop" in e]
    assert len(content_starts) == 2  # one for reasoning, one for text
    assert len(content_stops) == 2


@pytest.mark.asyncio
async def test_stream_citation_annotations(openai_client, model, agenerator, alist):
    """Test that web search citation annotations are streamed as CitationsDelta events."""
    mock_text_event1 = unittest.mock.Mock(type="response.output_text.delta", delta="The answer is here. ")
    mock_text_event2 = unittest.mock.Mock(type="response.output_text.delta", delta="(example.com)")
    mock_annotation_event = unittest.mock.Mock(
        type="response.output_text.annotation.added",
        annotation={
            "type": "url_citation",
            "title": "Example Source",
            "url": "https://example.com/article",
        },
    )
    mock_complete_event = unittest.mock.Mock(
        type="response.completed",
        response=unittest.mock.Mock(
            usage=unittest.mock.Mock(input_tokens=10, output_tokens=5, total_tokens=15, input_tokens_details=None)
        ),
    )

    openai_client.responses.create = unittest.mock.AsyncMock(
        return_value=agenerator([mock_text_event1, mock_text_event2, mock_annotation_event, mock_complete_event])
    )

    messages = [{"role": "user", "content": [{"text": "search something"}]}]
    tru_events = await alist(model.stream(messages))

    citation_deltas = [
        e for e in tru_events if "contentBlockDelta" in e and "citation" in e["contentBlockDelta"]["delta"]
    ]
    assert len(citation_deltas) == 1
    assert citation_deltas[0] == {
        "contentBlockDelta": {
            "delta": {
                "citation": {
                    "title": "Example Source",
                    "location": {"web": {"url": "https://example.com/article"}},
                }
            }
        }
    }


@pytest.mark.asyncio
async def test_stream_unsupported_annotation_type(openai_client, model, agenerator, alist, caplog):
    """Test that unsupported annotation types log a warning and are not emitted."""
    mock_text_event = unittest.mock.Mock(type="response.output_text.delta", delta="Some text")
    mock_annotation_event = unittest.mock.Mock(
        type="response.output_text.annotation.added",
        annotation={"type": "file_citation", "file_id": "file-123", "filename": "doc.pdf"},
    )
    mock_complete_event = unittest.mock.Mock(
        type="response.completed",
        response=unittest.mock.Mock(
            usage=unittest.mock.Mock(input_tokens=10, output_tokens=5, total_tokens=15, input_tokens_details=None)
        ),
    )

    openai_client.responses.create = unittest.mock.AsyncMock(
        return_value=agenerator([mock_text_event, mock_annotation_event, mock_complete_event])
    )

    messages = [{"role": "user", "content": [{"text": "search files"}]}]
    tru_events = await alist(model.stream(messages))

    citation_deltas = [
        e for e in tru_events if "contentBlockDelta" in e and "citation" in e["contentBlockDelta"]["delta"]
    ]
    assert len(citation_deltas) == 0
    assert "annotation_type=<file_citation> | unsupported annotation type" in caplog.text


@pytest.mark.asyncio
async def test_structured_output(openai_client, model, test_output_model_cls, alist):
    messages = [{"role": "user", "content": [{"text": "Generate a person"}]}]

    mock_parsed_instance = test_output_model_cls(name="John", age=30)
    mock_response = unittest.mock.Mock(output_parsed=mock_parsed_instance)

    openai_client.responses.parse = unittest.mock.AsyncMock(return_value=mock_response)

    stream = model.structured_output(test_output_model_cls, messages)
    events = await alist(stream)

    tru_result = events[-1]
    exp_result = {"output": test_output_model_cls(name="John", age=30)}
    assert tru_result == exp_result


@pytest.mark.asyncio
async def test_structured_output_forwards_request_params(openai_client, model_id, test_output_model_cls, alist):
    messages = [{"role": "user", "content": [{"text": "Generate a person"}]}]
    model = OpenAIResponsesModel(
        model_id=model_id,
        params={"max_output_tokens": 100, "reasoning": {"effort": "low"}},
    )

    mock_parsed_instance = test_output_model_cls(name="John", age=30)
    mock_response = unittest.mock.Mock(output_parsed=mock_parsed_instance)
    openai_client.responses.parse = unittest.mock.AsyncMock(return_value=mock_response)

    events = await alist(model.structured_output(test_output_model_cls, messages, system_prompt="Be precise."))

    assert events[-1] == {"output": mock_parsed_instance}
    parse_kwargs = openai_client.responses.parse.call_args.kwargs
    assert parse_kwargs["model"] == model_id
    assert parse_kwargs["max_output_tokens"] == 100
    assert parse_kwargs["reasoning"] == {"effort": "low"}
    assert parse_kwargs["instructions"] == "Be precise."
    assert parse_kwargs["store"] is False
    assert parse_kwargs["text_format"] is test_output_model_cls
    assert "stream" not in parse_kwargs


@pytest.mark.asyncio
async def test_stream_response_failed_raises_provider_error(openai_client, model, messages, agenerator):
    error = ResponseError(message="The model failed while processing the request.", code="server_error")
    failed_event = ResponseFailedEvent.model_construct(
        type="response.failed", sequence_number=1, response=Response.model_construct(error=error)
    )
    openai_client.responses.create = unittest.mock.AsyncMock(return_value=agenerator([failed_event]))

    with pytest.raises(RuntimeError, match="The model failed while processing the request") as exc_info:
        async for _ in model.stream(messages):
            pass

    assert exc_info.value.code == "server_error"


@pytest.mark.asyncio
async def test_stream_response_failed_context_overflow(openai_client, model, messages, agenerator):
    message = "prompt tokens (320666) exceed customer model maximum (278528) for model-id"
    error = ResponseError(message=message, code="invalid_prompt")
    failed_event = ResponseFailedEvent.model_construct(
        type="response.failed", sequence_number=1, response=Response.model_construct(error=error)
    )
    openai_client.responses.create = unittest.mock.AsyncMock(return_value=agenerator([failed_event]))

    with pytest.raises(ContextWindowOverflowException, match="exceed customer model maximum") as exc_info:
        async for _ in model.stream(messages):
            pass

    assert exc_info.value.__cause__.code == "invalid_prompt"


@pytest.mark.asyncio
async def test_stream_response_failed_existing_context_pattern(openai_client, model, messages, agenerator):
    error = ResponseError(message="This model's maximum context length is 4096 tokens.", code="invalid_prompt")
    failed_event = ResponseFailedEvent.model_construct(
        type="response.failed", sequence_number=1, response=Response.model_construct(error=error)
    )
    openai_client.responses.create = unittest.mock.AsyncMock(return_value=agenerator([failed_event]))

    with pytest.raises(ContextWindowOverflowException, match="maximum context length"):
        async for _ in model.stream(messages):
            pass


@pytest.mark.asyncio
async def test_stream_response_failed_without_error_details(openai_client, model, messages, agenerator):
    failed_event = ResponseFailedEvent.model_construct(
        type="response.failed", sequence_number=1, response=Response.model_construct(error=None)
    )
    openai_client.responses.create = unittest.mock.AsyncMock(return_value=agenerator([failed_event]))

    with pytest.raises(RuntimeError, match="OpenAI Responses API response failed"):
        async for _ in model.stream(messages):
            pass


@pytest.mark.asyncio
@pytest.mark.parametrize("code", ["rate_limit_exceeded", None])
async def test_stream_error_event_as_throttle(openai_client, model, messages, agenerator, code):
    error_event = ResponseErrorEvent(
        type="error", sequence_number=1, code=code, message="Rate limit exceeded while streaming."
    )
    openai_client.responses.create = unittest.mock.AsyncMock(return_value=agenerator([error_event]))

    with pytest.raises(ModelThrottledException, match="Rate limit exceeded while streaming") as exc_info:
        async for _ in model.stream(messages):
            pass

    assert exc_info.value.__cause__.code == code


@pytest.mark.asyncio
async def test_stream_throttle_precedes_context_overflow(openai_client, model, messages, agenerator):
    error_event = ResponseErrorEvent(
        type="error",
        sequence_number=1,
        code="rate_limit_exceeded",
        message="prompt tokens exceed customer model maximum",
    )
    openai_client.responses.create = unittest.mock.AsyncMock(return_value=agenerator([error_event]))

    with pytest.raises(ModelThrottledException, match="exceed customer model maximum"):
        async for _ in model.stream(messages):
            pass


@pytest.mark.asyncio
async def test_stream_context_overflow_exception(openai_client, model, messages):
    """Test that OpenAI context overflow errors are properly converted to ContextWindowOverflowException."""
    mock_error = openai.BadRequestError(
        message="This model's maximum context length is 4096 tokens.",
        response=unittest.mock.MagicMock(),
        body={"error": {"code": "context_length_exceeded"}},
    )
    mock_error.code = "context_length_exceeded"

    openai_client.responses.create.side_effect = mock_error

    with pytest.raises(ContextWindowOverflowException) as exc_info:
        async for _ in model.stream(messages):
            pass

    assert "maximum context length" in str(exc_info.value)
    assert exc_info.value.__cause__ == mock_error


@pytest.mark.asyncio
async def test_stream_context_overflow_exception_api_error_type(openai_client, model, messages):
    """Test that OpenAI context overflow errors are properly converted to ContextWindowOverflowException."""
    mock_error = openai.APIError(
        message="This model's maximum context length is 4096 tokens.",
        request=unittest.mock.MagicMock(),
        body={"error": {"code": "context_length_exceeded"}},
    )
    mock_error.code = "context_length_exceeded"

    openai_client.responses.create.side_effect = mock_error

    with pytest.raises(ContextWindowOverflowException) as exc_info:
        async for _ in model.stream(messages):
            pass

    assert "maximum context length" in str(exc_info.value)
    assert exc_info.value.__cause__ == mock_error


@pytest.mark.asyncio
async def test_stream_http_429_as_throttle(openai_client, model, messages):
    request = httpx.Request("POST", "https://api.openai.com/v1/responses")
    response = httpx.Response(429, request=request)
    error = openai.APIStatusError("opaque provider failure", response=response, body=None)
    openai_client.responses.create.side_effect = error

    with pytest.raises(ModelThrottledException, match="opaque provider failure") as exc_info:
        async for _ in model.stream(messages):
            pass

    assert exc_info.value.__cause__ is error


@pytest.mark.asyncio
async def test_stream_rate_limit_as_throttle(openai_client, model, messages):
    """Test that rate limit errors are converted to ModelThrottledException."""
    mock_error = openai.RateLimitError(
        message="Rate limit exceeded",
        response=unittest.mock.MagicMock(),
        body={"error": {"code": "rate_limit_exceeded"}},
    )
    mock_error.code = "rate_limit_exceeded"

    openai_client.responses.create.side_effect = mock_error

    with pytest.raises(ModelThrottledException) as exc_info:
        async for _ in model.stream(messages):
            pass

    assert "Rate limit exceeded" in str(exc_info.value)


@pytest.mark.asyncio
async def test_stream_bad_request_non_context_overflow(openai_client, model, messages):
    """Test that non-context-overflow BadRequestErrors are re-raised."""
    mock_error = openai.BadRequestError(
        message="Invalid request format",
        response=unittest.mock.MagicMock(),
        body={"error": {"code": "invalid_request"}},
    )
    mock_error.code = "invalid_request"

    openai_client.responses.create.side_effect = mock_error

    with pytest.raises(openai.BadRequestError) as exc_info:
        async for _ in model.stream(messages):
            pass

    assert exc_info.value == mock_error


@pytest.mark.asyncio
async def test_stream_error_during_iteration(openai_client, model, messages, agenerator):
    """Test that errors during streaming iteration are properly handled."""
    mock_text_event = unittest.mock.Mock(type="response.output_text.delta", delta="Hello")

    async def error_generator():
        yield mock_text_event
        raise openai.RateLimitError(
            message="Rate limit during stream",
            response=unittest.mock.MagicMock(),
            body={"error": {"code": "rate_limit_exceeded"}},
        )

    openai_client.responses.create = unittest.mock.AsyncMock(return_value=error_generator())

    with pytest.raises(ModelThrottledException) as exc_info:
        async for _ in model.stream(messages):
            pass

    assert "Rate limit during stream" in str(exc_info.value)


@pytest.mark.asyncio
async def test_stream_context_overflow_during_iteration(openai_client, model, messages):
    """Test that context overflow during streaming iteration is properly handled."""
    mock_text_event = unittest.mock.Mock(type="response.output_text.delta", delta="Hello")

    async def error_generator():
        yield mock_text_event
        error = openai.BadRequestError(
            message="Context length exceeded during stream",
            response=unittest.mock.MagicMock(),
            body={"error": {"code": "context_length_exceeded"}},
        )
        error.code = "context_length_exceeded"
        raise error

    openai_client.responses.create = unittest.mock.AsyncMock(return_value=error_generator())

    with pytest.raises(ContextWindowOverflowException) as exc_info:
        async for _ in model.stream(messages):
            pass

    assert "Context length exceeded" in str(exc_info.value)


@pytest.mark.asyncio
async def test_structured_output_context_overflow_exception(openai_client, model, messages, test_output_model_cls):
    """Test that structured output handles context overflow properly."""
    mock_error = openai.BadRequestError(
        message="This model's maximum context length is 4096 tokens.",
        response=unittest.mock.MagicMock(),
        body={"error": {"code": "context_length_exceeded"}},
    )
    mock_error.code = "context_length_exceeded"

    openai_client.responses.parse.side_effect = mock_error

    with pytest.raises(ContextWindowOverflowException) as exc_info:
        async for _ in model.structured_output(test_output_model_cls, messages):
            pass

    assert "maximum context length" in str(exc_info.value)
    assert exc_info.value.__cause__ == mock_error


@pytest.mark.asyncio
async def test_structured_output_context_overflow_message(openai_client, model, messages, test_output_model_cls):
    message = "prompt tokens exceed customer model maximum"
    mock_error = openai.APIError(
        message=message,
        request=unittest.mock.MagicMock(),
        body={"error": {"message": message}},
    )
    openai_client.responses.parse.side_effect = mock_error

    with pytest.raises(ContextWindowOverflowException, match="exceed customer model maximum") as exc_info:
        async for _ in model.structured_output(test_output_model_cls, messages):
            pass

    assert exc_info.value.__cause__ is mock_error


@pytest.mark.asyncio
async def test_structured_output_rate_limit_message(openai_client, model, messages, test_output_model_cls):
    mock_error = openai.APIError(
        message="Too many requests from provider",
        request=unittest.mock.MagicMock(),
        body={"error": {"message": "Too many requests from provider"}},
    )
    openai_client.responses.parse.side_effect = mock_error

    with pytest.raises(ModelThrottledException, match="Too many requests") as exc_info:
        async for _ in model.structured_output(test_output_model_cls, messages):
            pass

    assert exc_info.value.__cause__ is mock_error


@pytest.mark.asyncio
async def test_structured_output_rate_limit_as_throttle(openai_client, model, messages, test_output_model_cls):
    """Test that structured output handles rate limit errors properly."""
    mock_error = openai.RateLimitError(
        message="Rate limit exceeded",
        response=unittest.mock.MagicMock(),
        body={"error": {"code": "rate_limit_exceeded"}},
    )
    mock_error.code = "rate_limit_exceeded"

    openai_client.responses.parse.side_effect = mock_error

    with pytest.raises(ModelThrottledException) as exc_info:
        async for _ in model.structured_output(test_output_model_cls, messages):
            pass

    assert "Rate limit exceeded" in str(exc_info.value)
    assert exc_info.value.__cause__ == mock_error


@pytest.mark.asyncio
async def test_structured_output_bad_request_non_context_overflow(
    openai_client, model, messages, test_output_model_cls
):
    """Test that structured output re-raises non-context-overflow BadRequestErrors."""
    mock_error = openai.BadRequestError(
        message="Invalid request format",
        response=unittest.mock.MagicMock(),
        body={"error": {"code": "invalid_request"}},
    )
    mock_error.code = "invalid_request"

    openai_client.responses.parse.side_effect = mock_error

    with pytest.raises(openai.BadRequestError) as exc_info:
        async for _ in model.structured_output(test_output_model_cls, messages):
            pass

    assert exc_info.value == mock_error


@pytest.mark.asyncio
async def test_structured_output_no_parsed_output(openai_client, model, messages, test_output_model_cls, alist):
    """Test that structured output raises ValueError when output_parsed is None."""
    mock_response = unittest.mock.Mock(output_parsed=None)
    openai_client.responses.parse = unittest.mock.AsyncMock(return_value=mock_response)

    with pytest.raises(ValueError, match="No valid parsed output"):
        await alist(model.structured_output(test_output_model_cls, messages))


@pytest.mark.asyncio
async def test_stream_with_empty_tool_result_content(model):
    """Test formatting tool result with empty content list."""
    tool_result = {
        "content": [],
        "status": "success",
        "toolUseId": "c1",
    }

    result = OpenAIResponsesModel._format_request_tool_message(tool_result)
    assert result["output"] == ""


def test_config_validation_warns_on_unknown_keys(openai_client, captured_warnings):
    """Test that unknown config keys emit a warning."""
    OpenAIResponsesModel({"api_key": "test"}, model_id="test-model", invalid_param="test")

    assert len(captured_warnings) == 1
    assert "Invalid configuration parameters" in str(captured_warnings[0].message)
    assert "invalid_param" in str(captured_warnings[0].message)


def test_update_config_validation_warns_on_unknown_keys(model, captured_warnings):
    """Test that update_config warns on unknown keys."""
    model.update_config(wrong_param="test")

    assert len(captured_warnings) == 1
    assert "Invalid configuration parameters" in str(captured_warnings[0].message)
    assert "wrong_param" in str(captured_warnings[0].message)


@pytest.mark.parametrize(
    ("tool_choice", "expected"),
    [
        (None, {}),
        ({"auto": {}}, {"tool_choice": "auto"}),
        ({"any": {}}, {"tool_choice": "required"}),
        ({"tool": {"name": "calculator"}}, {"tool_choice": {"type": "function", "name": "calculator"}}),
        ({"unknown": {}}, {"tool_choice": "auto"}),  # Test default fallback
    ],
)
def test_format_request_tool_choice(tool_choice, expected):
    """Test that tool_choice is properly formatted for the Responses API."""
    result = OpenAIResponsesModel._format_request_tool_choice(tool_choice)
    assert result == expected


def test_format_request_with_tool_choice(model, messages, tool_specs):
    """Test that tool_choice is properly included in the request."""
    tool_choice = {"tool": {"name": "test_tool"}}
    request = model._format_request(messages, tool_specs, tool_choice=tool_choice)

    assert "tool_choice" in request
    assert request["tool_choice"] == {"type": "function", "name": "test_tool"}


def test_format_request_merges_builtin_tools_with_function_tools(messages, tool_specs):
    """Test that built-in tools from params are merged with function tools."""
    model = OpenAIResponsesModel(
        model_id="gpt-4o",
        params={"tools": [{"type": "web_search"}]},
    )
    request = model._format_request(messages, tool_specs)

    assert request["tools"] == [
        {"type": "web_search"},
        {
            "type": "function",
            "name": "test_tool",
            "description": "A test tool",
            "parameters": {
                "type": "object",
                "properties": {"input": {"type": "string"}},
                "required": ["input"],
            },
        },
    ]


def test_format_request_does_not_mutate_params_tools_across_calls(messages, tool_specs):
    """Repeated _format_request calls must not mutate self.config["params"]["tools"]."""
    model = OpenAIResponsesModel(
        model_id="gpt-4o",
        params={"tools": [{"type": "web_search"}]},
    )

    first = model._format_request(messages, tool_specs)
    second = model._format_request(messages, tool_specs)

    assert second["tools"] == first["tools"]
    assert model.config["params"]["tools"] == [{"type": "web_search"}]


def test_format_request_builtin_tools_without_function_tools(messages):
    """Test that built-in tools from params are preserved when no function tools are provided."""
    model = OpenAIResponsesModel(
        model_id="gpt-4o",
        params={"tools": [{"type": "web_search"}]},
    )
    request = model._format_request(messages)

    assert request["tools"] == [{"type": "web_search"}]


def test_format_request_messages_with_citations_content():
    """Test that citationsContent blocks are converted to text in the request."""
    messages = [
        {"role": "user", "content": [{"text": "search something"}]},
        {
            "role": "assistant",
            "content": [
                {
                    "citationsContent": {
                        "citations": [
                            {
                                "title": "Example",
                                "location": {"web": {"url": "https://example.com", "domain": "example.com"}},
                                "sourceContent": [{"text": "cited text"}],
                            }
                        ],
                        "content": [{"text": "The answer with citations."}],
                    }
                }
            ],
        },
    ]
    formatted = OpenAIResponsesModel._format_request_messages(messages)

    assistant_msg = [m for m in formatted if m.get("role") == "assistant"][0]
    assert assistant_msg == {
        "role": "assistant",
        "content": "The answer with citations.",
    }


def test_format_request_message_content_image_size_limit():
    """Test that oversized images raise ValueError."""
    oversized_data = b"x" * (_MAX_MEDIA_SIZE_BYTES + 1)
    content = {"image": {"format": "png", "source": {"bytes": oversized_data}}}

    with pytest.raises(ValueError, match="Image size .* exceeds maximum"):
        OpenAIResponsesModel._format_request_message_content(content)


def test_format_request_message_content_document_size_limit():
    """Test that oversized documents raise ValueError."""
    oversized_data = b"x" * (_MAX_MEDIA_SIZE_BYTES + 1)
    content = {"document": {"format": "pdf", "name": "large.pdf", "source": {"bytes": oversized_data}}}

    with pytest.raises(ValueError, match="Document size .* exceeds maximum"):
        OpenAIResponsesModel._format_request_message_content(content)


def test_format_request_tool_message_image_size_limit():
    """Test that oversized images in tool results raise ValueError."""
    oversized_data = b"x" * (_MAX_MEDIA_SIZE_BYTES + 1)
    tool_result = {
        "content": [{"image": {"format": "png", "source": {"bytes": oversized_data}}}],
        "status": "success",
        "toolUseId": "c1",
    }

    with pytest.raises(ValueError, match="Image size .* exceeds maximum"):
        OpenAIResponsesModel._format_request_tool_message(tool_result)


def test_format_request_tool_message_document_size_limit():
    """Test that oversized documents in tool results raise ValueError."""
    oversized_data = b"x" * (_MAX_MEDIA_SIZE_BYTES + 1)
    tool_result = {
        "content": [{"document": {"format": "pdf", "name": "large.pdf", "source": {"bytes": oversized_data}}}],
        "status": "success",
        "toolUseId": "c1",
    }

    with pytest.raises(ValueError, match="Document size .* exceeds maximum"):
        OpenAIResponsesModel._format_request_tool_message(tool_result)


def test_openai_version_check():
    """Test that module import fails with old OpenAI SDK version."""
    import importlib

    import strands.models.openai_responses as openai_responses_module

    def mock_old_version(package_name: str) -> str:
        if package_name == "openai":
            return "1.99.0"
        from importlib.metadata import version

        return version(package_name)

    def mock_valid_version(package_name: str) -> str:
        if package_name == "openai":
            return "2.0.0"
        from importlib.metadata import version

        return version(package_name)

    with unittest.mock.patch("importlib.metadata.version", mock_old_version):
        with pytest.raises(ImportError, match="OpenAIResponsesModel requires openai>=2.0.0"):
            importlib.reload(openai_responses_module)

    # Reload with valid version to restore module state
    with unittest.mock.patch("importlib.metadata.version", mock_valid_version):
        importlib.reload(openai_responses_module)


@pytest.mark.parametrize("stateful", [True, False])
def test_stateful(model_id, stateful):
    """Model.stateful reflects the stateful config option."""
    model = OpenAIResponsesModel(model_id=model_id, stateful=stateful)
    assert model.stateful is stateful


@pytest.mark.asyncio
async def test_stream_stateful(openai_client, model_id, agenerator, alist):
    """When stateful is enabled, model writes response_id to model_state from response.created."""
    model = OpenAIResponsesModel(model_id=model_id, stateful=True)
    mock_events = [
        unittest.mock.Mock(
            type="response.created",
            response=unittest.mock.Mock(id="resp_abc123"),
        ),
        unittest.mock.Mock(type="response.output_text.delta", delta="Hi"),
        unittest.mock.Mock(
            type="response.completed",
            response=unittest.mock.Mock(
                id="resp_abc123",
                usage=unittest.mock.Mock(input_tokens=10, output_tokens=5, total_tokens=15, input_tokens_details=None),
            ),
        ),
    ]

    openai_client.responses.create = unittest.mock.AsyncMock(return_value=agenerator(mock_events))

    model_state = {"response_id": "resp_previous"}
    events = await alist(
        model.stream(
            [{"role": "user", "content": [{"text": "Hello"}]}],
            model_state=model_state,
        )
    )

    call_kwargs = openai_client.responses.create.call_args[1]
    assert call_kwargs["previous_response_id"] == "resp_previous"

    assert model_state["response_id"] == "resp_abc123"

    metadata_events = [e for e in events if "metadata" in e]
    assert len(metadata_events) == 1
    assert metadata_events[0]["metadata"] == {
        "usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15},
        "metrics": {"latencyMs": 0},
    }


def test_format_request_messages_excludes_reasoning_content(caplog):
    """Test that reasoningContent blocks are filtered from messages with a warning."""
    messages = [
        {
            "content": [{"text": "Hello"}],
            "role": "user",
        },
        {
            "content": [
                {"reasoningContent": {"reasoningText": {"text": "Let me think..."}}},
                {"text": "The answer is 42"},
            ],
            "role": "assistant",
        },
        {
            "content": [{"text": "Thanks"}],
            "role": "user",
        },
    ]

    with caplog.at_level("WARNING"):
        result = OpenAIResponsesModel._format_request_messages(messages)

    assert result == [
        {"role": "user", "content": [{"type": "input_text", "text": "Hello"}]},
        {"role": "assistant", "content": "The answer is 42"},
        {"role": "user", "content": [{"type": "input_text", "text": "Thanks"}]},
    ]
    assert "reasoningContent is not yet supported" in caplog.text


class TestCountTokens:
    """Tests for OpenAIResponsesModel.count_tokens native token counting."""

    @pytest.fixture
    def openai_client(self):
        with unittest.mock.patch.object(strands.models.openai_responses.openai, "AsyncOpenAI") as mock_client_cls:
            mock_client = unittest.mock.AsyncMock()
            mock_client_cls.return_value.__aenter__.return_value = mock_client
            yield mock_client

    @pytest.fixture
    def model(self, openai_client):
        _ = openai_client
        return OpenAIResponsesModel(model_id="gpt-4o", use_native_token_count=True)

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
    async def test_native_count_tokens_success(self, model, openai_client, messages):
        mock_response = unittest.mock.AsyncMock()
        mock_response.input_tokens = 42
        openai_client.responses.input_tokens.count.return_value = mock_response

        result = await model.count_tokens(messages=messages)

        assert result == 42
        openai_client.responses.input_tokens.count.assert_called_once()

    @pytest.mark.asyncio
    async def test_native_count_tokens_with_system_prompt(self, model, openai_client, messages):
        mock_response = unittest.mock.AsyncMock()
        mock_response.input_tokens = 55
        openai_client.responses.input_tokens.count.return_value = mock_response

        result = await model.count_tokens(messages=messages, system_prompt="Be helpful.")

        assert result == 55
        call_kwargs = openai_client.responses.input_tokens.count.call_args[1]
        assert call_kwargs["instructions"] == "Be helpful."

    @pytest.mark.asyncio
    async def test_native_count_tokens_with_tool_specs(self, model, openai_client, messages, tool_specs):
        mock_response = unittest.mock.AsyncMock()
        mock_response.input_tokens = 100
        openai_client.responses.input_tokens.count.return_value = mock_response

        result = await model.count_tokens(messages=messages, tool_specs=tool_specs)

        assert result == 100
        call_kwargs = openai_client.responses.input_tokens.count.call_args[1]
        assert "tools" in call_kwargs

    @pytest.mark.asyncio
    async def test_stream_and_store_stripped(self, model, openai_client, messages):
        mock_response = unittest.mock.AsyncMock()
        mock_response.input_tokens = 10
        openai_client.responses.input_tokens.count.return_value = mock_response

        await model.count_tokens(messages=messages)

        call_kwargs = openai_client.responses.input_tokens.count.call_args[1]
        assert "stream" not in call_kwargs
        assert "store" not in call_kwargs

    @pytest.mark.asyncio
    async def test_fallback_on_api_error(self, model, openai_client, messages):
        openai_client.responses.input_tokens.count.side_effect = openai.APIError(
            message="Unsupported", request=unittest.mock.MagicMock(), body=None
        )

        result = await model.count_tokens(messages=messages)

        assert isinstance(result, int)
        assert result >= 0

    @pytest.mark.asyncio
    async def test_fallback_on_generic_exception(self, model, openai_client, messages):
        openai_client.responses.input_tokens.count.side_effect = RuntimeError("Connection failed")

        result = await model.count_tokens(messages=messages)

        assert isinstance(result, int)
        assert result >= 0

    @pytest.mark.asyncio
    async def test_fallback_logs_debug(self, model, openai_client, messages, caplog):
        import logging

        openai_client.responses.input_tokens.count.side_effect = RuntimeError("API down")

        with caplog.at_level(logging.DEBUG, logger="strands.models.openai_responses"):
            await model.count_tokens(messages=messages)

        assert any("native token counting failed" in record.message for record in caplog.records)

    @pytest.mark.asyncio
    async def test_skip_native_api_when_use_native_token_count_false(self, openai_client, messages):
        _ = openai_client
        model = OpenAIResponsesModel(model_id="gpt-4o", use_native_token_count=False)

        result = await model.count_tokens(messages=messages)

        openai_client.responses.input_tokens.count.assert_not_called()
        assert isinstance(result, int)
        assert result >= 0

    @pytest.mark.asyncio
    async def test_skip_native_api_by_default(self, openai_client, messages):
        _ = openai_client
        model = OpenAIResponsesModel(model_id="gpt-4o")

        result = await model.count_tokens(messages=messages)

        openai_client.responses.input_tokens.count.assert_not_called()
        assert isinstance(result, int)
        assert result >= 0


# =============================================================================
# Bedrock Mantle (bedrock_mantle_config) integration with OpenAIResponsesModel
# =============================================================================


class TestOpenAIResponsesModelBedrockMantleConfig:
    @pytest.fixture
    def mock_provide_token(self):
        with unittest.mock.patch("aws_bedrock_token_generator.provide_token") as mock:
            mock.return_value = "bedrock-api-key-deadbeef&Version=1"
            yield mock

    def test_bedrock_mantle_config_sets_base_url_and_api_key(self, openai_client, mock_provide_token):
        _ = openai_client
        model = OpenAIResponsesModel(model_id="openai.gpt-oss-120b", bedrock_mantle_config={"region": "us-east-1"})
        resolved = model._resolve_client_args()
        assert resolved["base_url"] == "https://bedrock-mantle.us-east-1.api.aws/v1"
        assert resolved["api_key"] == "bedrock-api-key-deadbeef&Version=1"
        mock_provide_token.assert_called_once_with(region="us-east-1")

    def test_bedrock_mantle_config_uses_openai_path_for_gpt5(self, openai_client, mock_provide_token):
        """gpt-5.* models are routed through the /openai/v1 Mantle path."""
        _ = openai_client
        _ = mock_provide_token
        model = OpenAIResponsesModel(model_id="openai.gpt-5.4", bedrock_mantle_config={"region": "us-east-1"})
        resolved = model._resolve_client_args()
        assert resolved["base_url"] == "https://bedrock-mantle.us-east-1.api.aws/openai/v1"

    @pytest.mark.parametrize(
        ("model_id", "expected_path"),
        [
            # Regression for #3654: Mantle rejects the wrong base path with HTTP 400
            # validation_error. The affected ids use /openai/v1; controls below pin /v1.
            ("xai.grok-4.3", "/openai/v1"),
            ("google.gemma-4-31b", "/openai/v1"),
            ("openai.gpt-5.6-terra", "/openai/v1"),
            # Gemma 3 is served from /v1 while Gemma 4 is not, so `google.` cannot be a prefix.
            ("google.gemma-3-27b-it", "/v1"),
            ("openai.gpt-oss-120b", "/v1"),
        ],
    )
    def test_bedrock_mantle_config_base_path_per_model(
        self, model_id, expected_path, openai_client, mock_provide_token
    ):
        """Each Mantle model resolves to the base path it is actually served from."""
        _ = openai_client
        _ = mock_provide_token
        model = OpenAIResponsesModel(model_id=model_id, bedrock_mantle_config={"region": "us-east-1"})

        resolved = model._resolve_client_args()
        assert resolved["base_url"] == f"https://bedrock-mantle.us-east-1.api.aws{expected_path}"

    @pytest.mark.parametrize(
        ("model_id", "expected_path"),
        [
            # Point releases within a verified line, beyond the verified catalog.
            ("xai.grok-4.9", "/openai/v1"),
            ("openai.gpt-5.9-unreleased", "/openai/v1"),
            # New lines the prefixes deliberately do not cover.
            ("xai.grok-5", "/v1"),
            ("xai.grok-5-preview", "/v1"),
        ],
    )
    def test_bedrock_mantle_config_unverified_ids(self, model_id, expected_path, openai_client, mock_provide_token):
        """Ids beyond the verified catalog, through the Responses model (shares _resolve_mantle_base_path)."""
        _ = openai_client
        _ = mock_provide_token
        model = OpenAIResponsesModel(model_id=model_id, bedrock_mantle_config={"region": "us-east-1"})

        resolved = model._resolve_client_args()
        assert resolved["base_url"] == f"https://bedrock-mantle.us-east-1.api.aws{expected_path}"

    def test_bedrock_mantle_config_forwards_credentials_provider_and_expiry(self, openai_client, mock_provide_token):
        _ = openai_client
        from datetime import timedelta

        provider = unittest.mock.Mock()
        model = OpenAIResponsesModel(
            model_id="openai.gpt-oss-120b",
            bedrock_mantle_config={
                "region": "us-west-2",
                "credentials_provider": provider,
                "expiry": timedelta(minutes=15),
            },
        )
        model._resolve_client_args()
        mock_provide_token.assert_called_once_with(
            region="us-west-2",
            aws_credentials_provider=provider,
            expiry=timedelta(minutes=15),
        )

    def test_bedrock_mantle_config_mints_token_per_request(self, openai_client, mock_provide_token):
        _ = openai_client
        model = OpenAIResponsesModel(model_id="openai.gpt-oss-120b", bedrock_mantle_config={"region": "us-east-1"})
        model._resolve_client_args()
        model._resolve_client_args()
        assert mock_provide_token.call_count == 2

    def test_bedrock_mantle_config_merges_with_client_args(self, openai_client, mock_provide_token):
        """bedrock_mantle_config composes with client_args; transport options are preserved."""
        _ = openai_client
        sentinel_http_client = unittest.mock.Mock()
        model = OpenAIResponsesModel(
            model_id="openai.gpt-oss-120b",
            client_args={
                "timeout": 42,
                "http_client": sentinel_http_client,
            },
            bedrock_mantle_config={"region": "us-east-1"},
        )
        resolved = model._resolve_client_args()
        assert resolved["base_url"] == "https://bedrock-mantle.us-east-1.api.aws/v1"
        assert resolved["api_key"] == "bedrock-api-key-deadbeef&Version=1"
        assert resolved["timeout"] == 42
        assert resolved["http_client"] is sentinel_http_client

    def test_bedrock_mantle_config_rejects_base_url_in_client_args(self, openai_client):
        """client_args must not contain base_url or api_key when bedrock_mantle_config is set."""
        _ = openai_client
        with pytest.raises(ValueError, match="client_args must not contain"):
            OpenAIResponsesModel(
                model_id="openai.gpt-oss-120b",
                client_args={"api_key": "should-not-be-here"},
                bedrock_mantle_config={"region": "us-east-1"},
            )

    def test_bedrock_mantle_config_requires_region(self, openai_client):
        """bedrock_mantle_config raises when no region can be resolved from config, session, or env."""
        _ = openai_client
        with (
            unittest.mock.patch("boto3.Session") as mock_session_cls,
            unittest.mock.patch.dict(os.environ, {}, clear=True),
        ):
            mock_session_cls.return_value.region_name = None
            model = OpenAIResponsesModel(model_id="openai.gpt-oss-120b", bedrock_mantle_config={})
            with pytest.raises(ValueError, match="Could not resolve an AWS region"):
                model._resolve_client_args()

    def test_bedrock_mantle_config_region_resolved_from_boto3_default(self, openai_client, mock_provide_token):
        """When region is omitted, the default boto3 session chain resolves it."""
        _ = openai_client
        with unittest.mock.patch("boto3.Session") as mock_session_cls:
            mock_session_cls.return_value.region_name = "eu-west-1"
            model = OpenAIResponsesModel(model_id="openai.gpt-oss-120b", bedrock_mantle_config={})
            resolved = model._resolve_client_args()

        assert resolved["base_url"] == "https://bedrock-mantle.eu-west-1.api.aws/v1"
        mock_provide_token.assert_called_once_with(region="eu-west-1")

    def test_bedrock_mantle_config_region_resolved_from_boto_session(self, openai_client, mock_provide_token):
        """An explicit ``boto_session`` supplies the region when ``region`` is omitted."""
        _ = openai_client
        session = unittest.mock.Mock()
        session.region_name = "ap-southeast-2"
        model = OpenAIResponsesModel(
            model_id="openai.gpt-oss-120b",
            bedrock_mantle_config={"boto_session": session},
        )

        resolved = model._resolve_client_args()

        assert resolved["base_url"] == "https://bedrock-mantle.ap-southeast-2.api.aws/v1"
        mock_provide_token.assert_called_once_with(region="ap-southeast-2")

    @pytest.mark.parametrize("region", ["x@attacker.com:443/#", "us-east-1\n", "us-east-1/"])
    def test_bedrock_mantle_config_rejects_malformed_region(self, openai_client, mock_provide_token, region):
        """A malformed region is rejected before a token is minted or a URL is built."""
        _ = openai_client
        model = OpenAIResponsesModel(model_id="openai.gpt-oss-120b", bedrock_mantle_config={"region": region})
        with pytest.raises(ValueError, match="invalid AWS region"):
            model._resolve_client_args()
        # Validation must precede token minting so no bearer token is ever sent toward the host.
        mock_provide_token.assert_not_called()

    def test_bedrock_mantle_config_wraps_token_failures_with_context(self, openai_client, mock_provide_token):
        """provide_token failures are wrapped in a RuntimeError with actionable context."""
        _ = openai_client
        mock_provide_token.side_effect = RuntimeError("no credentials in chain")
        model = OpenAIResponsesModel(model_id="openai.gpt-oss-120b", bedrock_mantle_config={"region": "us-east-1"})
        with pytest.raises(RuntimeError, match="Bedrock Mantle bearer token.*us-east-1"):
            model._resolve_client_args()
