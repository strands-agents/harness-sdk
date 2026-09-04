import logging
import os
import unittest.mock

import httpx
import openai
import pydantic
import pytest

import strands
from strands.models import CacheConfig
from strands.models.openai import OpenAIModel
from strands.types.content import Messages
from strands.types.exceptions import ContextWindowOverflowException, ModelThrottledException


@pytest.fixture
def openai_client():
    with unittest.mock.patch.object(strands.models.openai.openai, "AsyncOpenAI") as mock_client_cls:
        mock_client = unittest.mock.AsyncMock()
        # Make the mock client work as an async context manager
        mock_client.__aenter__ = unittest.mock.AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = unittest.mock.AsyncMock(return_value=None)
        mock_client_cls.return_value = mock_client
        yield mock_client


@pytest.fixture
def model_id():
    return "m1"


@pytest.fixture
def model(openai_client, model_id):
    _ = openai_client

    return OpenAIModel(model_id=model_id, params={"max_tokens": 1})


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
    model = OpenAIModel(model_id=model_id, params={"max_tokens": 1})

    tru_config = model.get_config()
    exp_config = {"model_id": "m1", "params": {"max_tokens": 1}}

    assert tru_config == exp_config


def test_update_config(model, model_id):
    model.update_config(model_id=model_id)

    tru_model_id = model.get_config().get("model_id")
    exp_model_id = model_id

    assert tru_model_id == exp_model_id


def test__init__context_window_limit(openai_client):
    _ = openai_client

    model = OpenAIModel(model_id="gpt-4o", context_window_limit=128_000)

    assert model.get_config().get("context_window_limit") == 128_000
    assert model.context_window_limit == 128_000


def test__init__auto_populates_context_window_limit(openai_client):
    _ = openai_client

    model = OpenAIModel(model_id="gpt-4o")

    assert model.get_config().get("context_window_limit") == 128_000


def test__init__explicit_context_window_limit_not_overridden(openai_client):
    _ = openai_client

    model = OpenAIModel(model_id="gpt-4o", context_window_limit=50_000)

    assert model.get_config().get("context_window_limit") == 50_000


def test__init__unknown_model_no_context_window_limit(openai_client):
    _ = openai_client

    model = OpenAIModel(model_id="unknown-model")

    assert model.get_config().get("context_window_limit") is None


@pytest.mark.parametrize(
    "content, exp_result",
    [
        # Document
        (
            {
                "document": {
                    "format": "pdf",
                    "name": "test doc",
                    "source": {"bytes": b"document"},
                },
            },
            {
                "file": {
                    "file_data": "data:application/pdf;base64,ZG9jdW1lbnQ=",
                    "filename": "test doc",
                },
                "type": "file",
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
                "image_url": {
                    "detail": "auto",
                    "format": "image/jpeg",
                    "url": "data:image/jpeg;base64,aW1hZ2U=",
                },
                "type": "image_url",
            },
        ),
        # Text
        (
            {"text": "hello"},
            {"type": "text", "text": "hello"},
        ),
    ],
)
def test_format_request_message_content(content, exp_result):
    tru_result = OpenAIModel.format_request_message_content(content)
    assert tru_result == exp_result


def test_format_request_message_content_unsupported_type():
    content = {"unsupported": {}}

    with pytest.raises(TypeError, match="content_type=<unsupported> | unsupported type"):
        OpenAIModel.format_request_message_content(content)


def test_format_request_message_tool_call_preserves_non_ascii():
    tool_use = {
        "input": {"query": "東京"},
        "name": "search",
        "toolUseId": "c1",
    }

    tru_result = OpenAIModel.format_request_message_tool_call(tool_use)
    exp_result = {
        "function": {
            "arguments": '{"query": "東京"}',
            "name": "search",
        },
        "id": "c1",
        "type": "function",
    }
    assert tru_result == exp_result


def test_format_request_tool_message_preserves_non_ascii():
    tool_result = {
        "content": [{"json": {"city": "東京"}}],
        "status": "success",
        "toolUseId": "c1",
    }

    tru_result = OpenAIModel.format_request_tool_message(tool_result)
    exp_result = {
        "content": '{"city": "東京"}',
        "role": "tool",
        "tool_call_id": "c1",
    }
    assert tru_result == exp_result


def test_format_request_message_tool_call():
    tool_use = {
        "input": {"expression": "2+2"},
        "name": "calculator",
        "toolUseId": "c1",
    }

    tru_result = OpenAIModel.format_request_message_tool_call(tool_use)
    exp_result = {
        "function": {
            "arguments": '{"expression": "2+2"}',
            "name": "calculator",
        },
        "id": "c1",
        "type": "function",
    }
    assert tru_result == exp_result


def test_format_request_tool_message():
    tool_result = {
        "content": [{"text": "4"}, {"json": ["4"]}],
        "status": "success",
        "toolUseId": "c1",
    }

    tru_result = OpenAIModel.format_request_tool_message(tool_result)
    exp_result = {
        "content": '4\n["4"]',
        "role": "tool",
        "tool_call_id": "c1",
    }
    assert tru_result == exp_result


def test_format_request_tool_message_single_text_returns_string():
    """Test that single text content is returned as string for model compatibility."""
    tool_result = {
        "content": [{"text": '{"result": "success"}'}],
        "status": "success",
        "toolUseId": "c1",
    }

    tru_result = OpenAIModel.format_request_tool_message(tool_result)
    exp_result = {
        "content": '{"result": "success"}',
        "role": "tool",
        "tool_call_id": "c1",
    }
    assert tru_result == exp_result


def test_format_request_tool_message_multi_text_returns_joined_string():
    """Test that multi-content text results are joined into a single string.

    Regression test for https://github.com/strands-agents/harness-sdk/issues/1696.
    OpenAI-compatible endpoints (e.g., Kimi K2.5, vLLM, Ollama) only correctly
    parse string content for tool messages; array format causes hallucinated results.
    """
    tool_result = {
        "content": [
            {"text": "Temperature: 72°F"},
            {"json": {"humidity": 45, "unit": "%"}},
            {"text": "Wind: 5 mph"},
        ],
        "status": "success",
        "toolUseId": "c1",
    }

    tru_result = OpenAIModel.format_request_tool_message(tool_result)
    exp_result = {
        "content": 'Temperature: 72°F\n{"humidity": 45, "unit": "%"}\nWind: 5 mph',
        "role": "tool",
        "tool_call_id": "c1",
    }
    assert tru_result == exp_result


def test_format_request_tool_message_mixed_text_image_preserves_order():
    """Test that text and image content blocks preserve their original order."""
    tool_result = {
        "content": [
            {"text": "Before image"},
            {"image": {"format": "png", "source": {"bytes": b"PNG"}}},
            {"text": "After image"},
        ],
        "status": "success",
        "toolUseId": "c1",
    }

    tru_result = OpenAIModel.format_request_tool_message(tool_result)
    content = tru_result["content"]
    # Array format since images are present
    assert isinstance(content, list)
    assert len(content) == 3
    # Order preserved: text, image, text
    assert content[0] == {"type": "text", "text": "Before image"}
    assert content[1]["type"] == "image_url"
    assert content[2] == {"type": "text", "text": "After image"}


def test_format_request_tool_message_merges_adjacent_text():
    """Test that adjacent text blocks are merged while non-text order is preserved."""
    tool_result = {
        "content": [
            {"text": "Line 1"},
            {"text": "Line 2"},
            {"image": {"format": "png", "source": {"bytes": b"PNG"}}},
            {"text": "Line 3"},
        ],
        "status": "success",
        "toolUseId": "c1",
    }

    tru_result = OpenAIModel.format_request_tool_message(tool_result)
    content = tru_result["content"]
    assert isinstance(content, list)
    assert len(content) == 3
    # Adjacent text merged, image order preserved
    assert content[0] == {"type": "text", "text": "Line 1\nLine 2"}
    assert content[1]["type"] == "image_url"
    assert content[2] == {"type": "text", "text": "Line 3"}


def test_format_request_tool_message_image_only():
    """Test tool message with only non-text content."""
    tool_result = {
        "content": [
            {"image": {"format": "png", "source": {"bytes": b"PNG"}}},
        ],
        "status": "success",
        "toolUseId": "c1",
    }

    tru_result = OpenAIModel.format_request_tool_message(tool_result)
    content = tru_result["content"]
    assert isinstance(content, list)
    assert len(content) == 1
    assert content[0]["type"] == "image_url"


def test_format_request_tool_message_document_mixed():
    """Test tool message with document content mixed with text."""
    tool_result = {
        "content": [
            {"text": "Summary"},
            {"document": {"format": "pdf", "name": "report.pdf", "source": {"bytes": b"PDF"}}},
            {"text": "Footer"},
        ],
        "status": "success",
        "toolUseId": "c1",
    }

    tru_result = OpenAIModel.format_request_tool_message(tool_result)
    content = tru_result["content"]
    assert isinstance(content, list)
    assert len(content) == 3
    assert content[0] == {"type": "text", "text": "Summary"}
    assert content[1]["type"] == "file"
    assert content[2] == {"type": "text", "text": "Footer"}


def test_format_request_tool_message_empty_content():
    """Test tool message with empty content list returns empty string."""
    tool_result = {
        "content": [],
        "status": "success",
        "toolUseId": "c1",
    }

    tru_result = OpenAIModel.format_request_tool_message(tool_result)
    assert tru_result["content"] == ""
    assert tru_result["role"] == "tool"
    assert tru_result["tool_call_id"] == "c1"


def test_format_request_tool_message_skips_location_source_document(caplog):
    """Regression for https://github.com/strands-agents/harness-sdk/issues/4018.

    A location-source document nested inside a toolResult must not crash with
    KeyError: 'bytes'; it is warn-and-skipped instead (mirrors the message-
    path gate at openai.py for user messages containing location-source docs).
    """
    caplog.set_level(logging.WARNING, logger="strands.models.openai")

    tool_result = {
        "content": [
            {"text": "analyze this report"},
            {
                "document": {
                    "format": "pdf",
                    "name": "report.pdf",
                    "source": {"location": {"type": "s3", "uri": "s3://bucket/report.pdf"}},
                },
            },
        ],
        "status": "success",
        "toolUseId": "c1",
    }

    tru_result = OpenAIModel.format_request_tool_message(tool_result)
    content = tru_result["content"]

    # Location-source document skipped; surviving text returns as a joined string
    # (no non-text content remains, so has_non_text is False — same path as the
    # all-text case in format_request_tool_message).
    assert content == "analyze this report"
    assert "Location sources are not supported by OpenAI | skipping toolResult content block" in caplog.text


def test_format_request_tool_message_skips_location_source_image(caplog):
    """Regression for https://github.com/strands-agents/harness-sdk/issues/4018.

    Same gate for image blocks whose source is a location rather than bytes.
    """
    caplog.set_level(logging.WARNING, logger="strands.models.openai")

    tool_result = {
        "content": [
            {
                "image": {
                    "format": "png",
                    "source": {"location": {"type": "s3", "uri": "s3://bucket/img.png"}},
                },
            },
        ],
        "status": "success",
        "toolUseId": "c1",
    }

    tru_result = OpenAIModel.format_request_tool_message(tool_result)
    # Image-only result becomes empty string (no surviving text or non-text).
    assert tru_result["content"] == ""
    assert "Location sources are not supported by OpenAI | skipping toolResult content block" in caplog.text


def test_format_request_messages_tool_result_with_location_source_document(model, caplog):
    """Regression for https://github.com/strands-agents/harness-sdk/issues/4018.

    End-to-end: build an assistant→toolResult pair where the tool result carries
    a location-source document and confirm model.format_request does not raise.
    """
    caplog.set_level(logging.WARNING, logger="strands.models.openai")

    messages: Messages = [
        {"role": "user", "content": [{"text": "fetch the report"}]},
        {
            "role": "assistant",
            "content": [
                {
                    "toolUse": {
                        "input": {"path": "report.pdf"},
                        "name": "fetch_doc",
                        "toolUseId": "t1",
                    },
                },
            ],
        },
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "t1",
                        "status": "success",
                        "content": [
                            {
                                "document": {
                                    "format": "pdf",
                                    "name": "report.pdf",
                                    "source": {
                                        "location": {"type": "s3", "uri": "s3://bucket/report.pdf"},
                                    },
                                },
                            },
                        ],
                    },
                },
            ],
        },
    ]

    request = model.format_request(messages)
    # No exception is the headline assertion; the document is dropped, the
    # tool-message comes back with empty content.
    assert request["messages"][-1]["role"] == "tool"
    assert request["messages"][-1]["tool_call_id"] == "t1"
    assert "skipping toolResult content block" in caplog.text


def test_split_tool_message_images_with_image():
    """Test that images are extracted from tool messages."""
    tool_message = {
        "role": "tool",
        "tool_call_id": "c1",
        "content": [
            {"type": "text", "text": "Result"},
            {
                "type": "image_url",
                "image_url": {"url": "data:image/png;base64,iVBORw0KGgo=", "detail": "auto", "format": "image/png"},
            },
        ],
    }

    tool_clean, user_with_image = OpenAIModel._split_tool_message_images(tool_message)

    # Tool message should now have the original text plus the appended informational text
    assert tool_clean["role"] == "tool"
    assert tool_clean["tool_call_id"] == "c1"
    assert len(tool_clean["content"]) == 2
    assert tool_clean["content"][0]["type"] == "text"
    assert tool_clean["content"][0]["text"] == "Result"
    assert "Tool successfully returned an image" in tool_clean["content"][1]["text"]

    # User message should have the image
    assert user_with_image is not None
    assert user_with_image["role"] == "user"
    assert len(user_with_image["content"]) == 1
    assert user_with_image["content"][0]["type"] == "image_url"


def test_split_tool_message_images_without_image():
    """Test that tool messages without images are unchanged."""
    tool_message = {"role": "tool", "tool_call_id": "c1", "content": [{"type": "text", "text": "Result"}]}

    tool_clean, user_with_image = OpenAIModel._split_tool_message_images(tool_message)

    assert tool_clean == tool_message
    assert user_with_image is None


def test_split_tool_message_images_only_image():
    """Test tool message with only image content."""
    tool_message = {
        "role": "tool",
        "tool_call_id": "c1",
        "content": [{"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0KGgo="}}],
    }

    tool_clean, user_with_image = OpenAIModel._split_tool_message_images(tool_message)

    # Tool message should have default text
    assert tool_clean["role"] == "tool"
    assert len(tool_clean["content"]) == 1
    assert "successfully" in tool_clean["content"][0]["text"].lower()

    # User message should have the image
    assert user_with_image is not None
    assert user_with_image["role"] == "user"
    assert len(user_with_image["content"]) == 1


def test_split_tool_message_images_non_tool_role():
    """Test that messages with roles other than 'tool' are ignored."""
    user_msg = {"role": "user", "content": [{"type": "text", "text": "hello"}]}
    clean, extra = OpenAIModel._split_tool_message_images(user_msg)
    assert clean == user_msg
    assert extra is None


def test_split_tool_message_images_invalid_content_type():
    """Test that messages with non-list content are ignored."""
    invalid_msg = {"role": "tool", "content": "not a list"}
    clean, extra = OpenAIModel._split_tool_message_images(invalid_msg)
    assert clean == invalid_msg
    assert extra is None


def test_format_request_messages_with_tool_result_containing_image():
    """Test that tool results with images are properly split into tool and user messages."""
    messages = [
        {
            "content": [{"text": "Run the tool"}],
            "role": "user",
        },
        {
            "content": [
                {
                    "toolUse": {
                        "input": {},
                        "name": "image_tool",
                        "toolUseId": "t1",
                    },
                },
            ],
            "role": "assistant",
        },
        {
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "t1",
                        "status": "success",
                        "content": [
                            {"text": "Image generated"},
                            {
                                "image": {
                                    "format": "png",
                                    "source": {"bytes": b"fake_image_data"},
                                }
                            },
                        ],
                    }
                }
            ],
            "role": "user",
        },
    ]

    formatted = OpenAIModel.format_request_messages(messages)

    # Find the tool message
    tool_messages = [msg for msg in formatted if msg.get("role") == "tool"]
    assert len(tool_messages) == 1

    # Tool message should only have text content
    tool_msg = tool_messages[0]
    assert all(c.get("type") != "image_url" for c in tool_msg["content"])

    # There should be a user message right after the tool message with the image
    tool_msg_idx = formatted.index(tool_msg)
    assert tool_msg_idx + 1 < len(formatted)
    user_msg = formatted[tool_msg_idx + 1]
    assert user_msg["role"] == "user"
    assert any(c.get("type") == "image_url" for c in user_msg["content"])


def test_format_request_messages_with_multiple_images_in_tool_result():
    """Test tool result with multiple images."""
    messages = [
        {
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "t1",
                        "status": "success",
                        "content": [
                            {"text": "Two images generated"},
                            {
                                "image": {
                                    "format": "png",
                                    "source": {"bytes": b"image1"},
                                }
                            },
                            {
                                "image": {
                                    "format": "jpg",
                                    "source": {"bytes": b"image2"},
                                }
                            },
                        ],
                    }
                }
            ],
            "role": "user",
        },
    ]

    formatted = OpenAIModel.format_request_messages(messages)

    # Find user message with images
    user_image_msgs = [
        msg
        for msg in formatted
        if msg.get("role") == "user" and any(c.get("type") == "image_url" for c in msg.get("content", []))
    ]
    assert len(user_image_msgs) == 1

    # Should have both images
    image_contents = [c for c in user_image_msgs[0]["content"] if c.get("type") == "image_url"]
    assert len(image_contents) == 2


def test_format_request_tool_choice_auto():
    tool_choice = {"auto": {}}

    tru_result = OpenAIModel._format_request_tool_choice(tool_choice)
    exp_result = {"tool_choice": "auto"}
    assert tru_result == exp_result


def test_format_request_tool_choice_any():
    tool_choice = {"any": {}}

    tru_result = OpenAIModel._format_request_tool_choice(tool_choice)
    exp_result = {"tool_choice": "required"}
    assert tru_result == exp_result


def test_format_request_tool_choice_tool():
    tool_choice = {"tool": {"name": "test_tool"}}

    tru_result = OpenAIModel._format_request_tool_choice(tool_choice)
    exp_result = {"tool_choice": {"type": "function", "function": {"name": "test_tool"}}}
    assert tru_result == exp_result


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

    tru_result = OpenAIModel.format_request_messages(messages, system_prompt)
    exp_result = [
        {
            "content": system_prompt,
            "role": "system",
        },
        {
            "content": [{"text": "hello", "type": "text"}],
            "role": "user",
        },
        {
            "content": [{"text": "call tool", "type": "text"}],
            "role": "assistant",
            "tool_calls": [
                {
                    "function": {
                        "name": "calculator",
                        "arguments": '{"expression": "2+2"}',
                    },
                    "id": "c1",
                    "type": "function",
                }
            ],
        },
        {
            "content": "4",
            "role": "tool",
            "tool_call_id": "c1",
        },
    ]
    assert tru_result == exp_result


def test_format_request(model, messages, tool_specs, system_prompt):
    tru_request = model.format_request(messages, tool_specs, system_prompt)
    exp_request = {
        "messages": [
            {
                "content": system_prompt,
                "role": "system",
            },
            {
                "content": [{"text": "test", "type": "text"}],
                "role": "user",
            },
        ],
        "model": "m1",
        "stream": True,
        "stream_options": {"include_usage": True},
        "tools": [
            {
                "function": {
                    "description": "A test tool",
                    "name": "test_tool",
                    "parameters": {
                        "properties": {
                            "input": {"type": "string"},
                        },
                        "required": ["input"],
                        "type": "object",
                    },
                },
                "type": "function",
            },
        ],
        "max_tokens": 1,
    }
    assert tru_request == exp_request


def test_format_request_can_disable_stream(openai_client, model_id, messages):
    _ = openai_client
    model = OpenAIModel(model_id=model_id, stream=False, params={"max_tokens": 1})

    tru_request = model.format_request(messages)
    exp_request = {
        "messages": [{"role": "user", "content": [{"text": "test", "type": "text"}]}],
        "model": model_id,
        "stream": False,
        "tools": [],
        "max_tokens": 1,
    }
    assert tru_request == exp_request


def test_format_request_respects_legacy_stream_param(openai_client, model_id, messages):
    _ = openai_client
    model = OpenAIModel(model_id=model_id, params={"max_tokens": 1, "stream": False})

    tru_request = model.format_request(messages)

    assert tru_request["stream"] is False
    assert "stream_options" not in tru_request


def test_cache_key_maps_to_prompt_cache_key(openai_client, model_id, messages):
    _ = openai_client
    model = OpenAIModel(model_id=model_id, cache_config=CacheConfig(cache_key="tenant-42"))

    assert model.format_request(messages)["prompt_cache_key"] == "tenant-42"


def test_cache_key_absent_when_unset(openai_client, model_id, messages):
    _ = openai_client
    model = OpenAIModel(model_id=model_id, cache_config=CacheConfig())

    assert "prompt_cache_key" not in model.format_request(messages)


def test_explicit_prompt_cache_key_in_params_wins(openai_client, model_id, messages):
    _ = openai_client
    model = OpenAIModel(
        model_id=model_id,
        params={"prompt_cache_key": "explicit"},
        cache_config=CacheConfig(cache_key="from-config"),
    )

    assert model.format_request(messages)["prompt_cache_key"] == "explicit"


@pytest.mark.parametrize("retention", ["24h", "in_memory"])
def test_translatable_ttl_maps_to_prompt_cache_retention(openai_client, model_id, messages, retention):
    _ = openai_client
    model = OpenAIModel(model_id=model_id, cache_config=CacheConfig(cache_key="k", ttl=retention))

    assert model.format_request(messages)["prompt_cache_retention"] == retention


def test_untranslatable_ttl_is_ignored_and_warned(openai_client, model_id, messages):
    _ = openai_client
    model = OpenAIModel(model_id=model_id, cache_config=CacheConfig(cache_key="k", ttl="5m"))

    with pytest.warns(UserWarning, match="not an openai retention value"):
        request = model.format_request(messages)

    assert "prompt_cache_retention" not in request


def test_placement_fields_are_no_ops_warned(openai_client, model_id, messages):
    _ = openai_client
    model = OpenAIModel(model_id=model_id, cache_config=CacheConfig(strategy="anthropic", cache_key="k"))

    with pytest.warns(UserWarning, match="have no effect"):
        model.format_request(messages)


def test_format_request_with_tool_choice_auto(model, messages, tool_specs, system_prompt):
    tool_choice = {"auto": {}}
    tru_request = model.format_request(messages, tool_specs, system_prompt, tool_choice)
    exp_request = {
        "messages": [
            {
                "content": system_prompt,
                "role": "system",
            },
            {
                "content": [{"text": "test", "type": "text"}],
                "role": "user",
            },
        ],
        "model": "m1",
        "stream": True,
        "stream_options": {"include_usage": True},
        "tools": [
            {
                "function": {
                    "description": "A test tool",
                    "name": "test_tool",
                    "parameters": {
                        "properties": {
                            "input": {"type": "string"},
                        },
                        "required": ["input"],
                        "type": "object",
                    },
                },
                "type": "function",
            },
        ],
        "tool_choice": "auto",
        "max_tokens": 1,
    }
    assert tru_request == exp_request


def test_format_request_with_tool_choice_any(model, messages, tool_specs, system_prompt):
    tool_choice = {"any": {}}
    tru_request = model.format_request(messages, tool_specs, system_prompt, tool_choice)
    exp_request = {
        "messages": [
            {
                "content": system_prompt,
                "role": "system",
            },
            {
                "content": [{"text": "test", "type": "text"}],
                "role": "user",
            },
        ],
        "model": "m1",
        "stream": True,
        "stream_options": {"include_usage": True},
        "tools": [
            {
                "function": {
                    "description": "A test tool",
                    "name": "test_tool",
                    "parameters": {
                        "properties": {
                            "input": {"type": "string"},
                        },
                        "required": ["input"],
                        "type": "object",
                    },
                },
                "type": "function",
            },
        ],
        "tool_choice": "required",
        "max_tokens": 1,
    }
    assert tru_request == exp_request


def test_format_request_with_tool_choice_tool(model, messages, tool_specs, system_prompt):
    tool_choice = {"tool": {"name": "test_tool"}}
    tru_request = model.format_request(messages, tool_specs, system_prompt, tool_choice)
    exp_request = {
        "messages": [
            {
                "content": system_prompt,
                "role": "system",
            },
            {
                "content": [{"text": "test", "type": "text"}],
                "role": "user",
            },
        ],
        "model": "m1",
        "stream": True,
        "stream_options": {"include_usage": True},
        "tools": [
            {
                "function": {
                    "description": "A test tool",
                    "name": "test_tool",
                    "parameters": {
                        "properties": {
                            "input": {"type": "string"},
                        },
                        "required": ["input"],
                        "type": "object",
                    },
                },
                "type": "function",
            },
        ],
        "tool_choice": {"type": "function", "function": {"name": "test_tool"}},
        "max_tokens": 1,
    }
    assert tru_request == exp_request


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
        # Metadata
        (
            {
                "chunk_type": "metadata",
                "data": unittest.mock.Mock(
                    prompt_tokens=100,
                    completion_tokens=50,
                    total_tokens=150,
                    prompt_tokens_details=None,
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
    ],
)
def test_format_chunk(event, exp_chunk, model):
    tru_chunk = model.format_chunk(event)
    assert tru_chunk == exp_chunk


def test_format_chunk_unknown_type(model):
    event = {"chunk_type": "unknown"}

    with pytest.raises(RuntimeError, match="chunk_type=<unknown> | unknown type"):
        model.format_chunk(event)


def test_format_chunk_metadata_with_cache_tokens(model):
    """Test format_chunk for metadata with cache tokens present."""
    mock_usage = unittest.mock.Mock()
    mock_usage.prompt_tokens = 100
    mock_usage.completion_tokens = 50
    mock_usage.total_tokens = 150

    mock_tokens_details = unittest.mock.Mock()
    mock_tokens_details.cached_tokens = 25
    mock_usage.prompt_tokens_details = mock_tokens_details

    event = {"chunk_type": "metadata", "data": mock_usage}

    result = model.format_chunk(event)

    assert result["metadata"]["usage"]["inputTokens"] == 100
    assert result["metadata"]["usage"]["outputTokens"] == 50
    assert result["metadata"]["usage"]["totalTokens"] == 150
    assert result["metadata"]["usage"]["cacheReadInputTokens"] == 25


def test_format_chunk_metadata_with_zero_cached_tokens(model):
    """Test format_chunk for metadata when cached_tokens is 0."""
    mock_usage = unittest.mock.Mock()
    mock_usage.prompt_tokens = 100
    mock_usage.completion_tokens = 50
    mock_usage.total_tokens = 150

    mock_tokens_details = unittest.mock.Mock()
    mock_tokens_details.cached_tokens = 0
    mock_usage.prompt_tokens_details = mock_tokens_details

    event = {"chunk_type": "metadata", "data": mock_usage}

    result = model.format_chunk(event)

    assert "cacheReadInputTokens" not in result["metadata"]["usage"]


@pytest.mark.asyncio
async def test_stream(openai_client, model_id, model, agenerator, alist):
    mock_tool_call_1_part_1 = unittest.mock.Mock(index=0)
    mock_tool_call_2_part_1 = unittest.mock.Mock(index=1)
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
        content="I'll calculate", tool_calls=[mock_tool_call_1_part_1, mock_tool_call_2_part_1], reasoning_content=None
    )

    mock_tool_call_1_part_2 = unittest.mock.Mock(index=0)
    mock_tool_call_2_part_2 = unittest.mock.Mock(index=1)
    mock_delta_4 = unittest.mock.Mock(
        content="that for you", tool_calls=[mock_tool_call_1_part_2, mock_tool_call_2_part_2], reasoning_content=None
    )

    mock_delta_5 = unittest.mock.Mock(content="", tool_calls=None, reasoning_content=None)

    mock_event_1 = unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason=None, delta=mock_delta_1)])
    mock_event_2 = unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason=None, delta=mock_delta_2)])
    mock_event_3 = unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason=None, delta=mock_delta_3)])
    mock_event_4 = unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason=None, delta=mock_delta_4)])
    mock_event_5 = unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason="tool_calls", delta=mock_delta_5)])
    mock_event_6 = unittest.mock.Mock()

    openai_client.chat.completions.create = unittest.mock.AsyncMock(
        return_value=agenerator([mock_event_1, mock_event_2, mock_event_3, mock_event_4, mock_event_5, mock_event_6])
    )

    messages = [{"role": "user", "content": [{"text": "calculate 2+2"}]}]
    response = model.stream(messages)
    tru_events = await alist(response)
    exp_events = [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockStart": {"start": {}}},  # reasoning_content starts
        {"contentBlockDelta": {"delta": {"reasoningContent": {"text": "\nI'm thinking"}}}},
        {"contentBlockStop": {}},  # reasoning_content ends
        {"contentBlockStart": {"start": {}}},  # text starts
        {"contentBlockDelta": {"delta": {"text": "I'll calculate"}}},
        {"contentBlockDelta": {"delta": {"text": "that for you"}}},
        {"contentBlockStop": {}},  # text ends
        {
            "contentBlockStart": {
                "start": {
                    "toolUse": {"toolUseId": mock_tool_call_1_part_1.id, "name": mock_tool_call_1_part_1.function.name}
                }
            }
        },
        {"contentBlockDelta": {"delta": {"toolUse": {"input": mock_tool_call_1_part_1.function.arguments}}}},
        {"contentBlockDelta": {"delta": {"toolUse": {"input": mock_tool_call_1_part_2.function.arguments}}}},
        {"contentBlockStop": {}},
        {
            "contentBlockStart": {
                "start": {
                    "toolUse": {"toolUseId": mock_tool_call_2_part_1.id, "name": mock_tool_call_2_part_1.function.name}
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
                    "inputTokens": mock_event_6.usage.prompt_tokens,
                    "outputTokens": mock_event_6.usage.completion_tokens,
                    "totalTokens": mock_event_6.usage.total_tokens,
                },
                "metrics": {"latencyMs": 0},
            }
        },
    ]

    assert len(tru_events) == len(exp_events)
    # Verify that format_request was called with the correct arguments
    expected_request = {
        "max_tokens": 1,
        "model": model_id,
        "messages": [{"role": "user", "content": [{"text": "calculate 2+2", "type": "text"}]}],
        "stream": True,
        "stream_options": {"include_usage": True},
        "tools": [],
    }
    openai_client.chat.completions.create.assert_called_once_with(**expected_request)


@pytest.mark.asyncio
async def test_stream_accepts_vllm_reasoning_delta(openai_client, model, messages, agenerator, alist):
    reasoning_delta = unittest.mock.Mock(spec=["reasoning", "content", "tool_calls"])
    reasoning_delta.reasoning = "\nI'm thinking"
    reasoning_delta.content = None
    reasoning_delta.tool_calls = None

    stop_delta = unittest.mock.Mock(spec=["reasoning", "content", "tool_calls"])
    stop_delta.reasoning = None
    stop_delta.content = None
    stop_delta.tool_calls = None

    usage_event = unittest.mock.Mock(usage=None)
    openai_client.chat.completions.create = unittest.mock.AsyncMock(
        return_value=agenerator(
            [
                unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason=None, delta=reasoning_delta)]),
                unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason="stop", delta=stop_delta)]),
                usage_event,
            ]
        )
    )

    response = model.stream(messages)

    assert await alist(response) == [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockStart": {"start": {}}},
        {"contentBlockDelta": {"delta": {"reasoningContent": {"text": "\nI'm thinking"}}}},
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "end_turn"}},
    ]


@pytest.mark.asyncio
async def test_stream_empty(openai_client, model_id, model, agenerator, alist):
    mock_delta = unittest.mock.Mock(content=None, tool_calls=None, reasoning_content=None)

    mock_event_1 = unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason=None, delta=mock_delta)])
    mock_event_2 = unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason="stop", delta=mock_delta)])
    mock_event_3 = unittest.mock.Mock()
    mock_event_4 = unittest.mock.Mock(usage=None)

    openai_client.chat.completions.create = unittest.mock.AsyncMock(
        return_value=agenerator([mock_event_1, mock_event_2, mock_event_3, mock_event_4]),
    )

    messages = [{"role": "user", "content": []}]
    response = model.stream(messages)

    tru_events = await alist(response)
    exp_events = [
        {"messageStart": {"role": "assistant"}},
        {"messageStop": {"stopReason": "end_turn"}},  # No content blocks when no content
    ]

    assert len(tru_events) == len(exp_events)
    expected_request = {
        "max_tokens": 1,
        "model": model_id,
        "messages": [],
        "stream": True,
        "stream_options": {"include_usage": True},
        "tools": [],
    }
    openai_client.chat.completions.create.assert_called_once_with(**expected_request)


@pytest.mark.asyncio
async def test_stream_with_empty_choices(openai_client, model, agenerator, alist):
    mock_delta = unittest.mock.Mock(content="content", tool_calls=None, reasoning_content=None)
    mock_usage = unittest.mock.Mock(prompt_tokens=10, completion_tokens=20, total_tokens=30)

    # Event with no choices attribute
    mock_event_1 = unittest.mock.Mock(spec=[])

    # Event with empty choices list
    mock_event_2 = unittest.mock.Mock(choices=[])

    # Valid event with content
    mock_event_3 = unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason=None, delta=mock_delta)])

    # Event with finish reason
    mock_event_4 = unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason="stop", delta=mock_delta)])

    # Final event with usage info
    mock_event_5 = unittest.mock.Mock(usage=mock_usage)

    openai_client.chat.completions.create = unittest.mock.AsyncMock(
        return_value=agenerator([mock_event_1, mock_event_2, mock_event_3, mock_event_4, mock_event_5])
    )

    messages = [{"role": "user", "content": [{"text": "test"}]}]
    response = model.stream(messages)

    tru_events = await alist(response)
    exp_events = [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockStart": {"start": {}}},  # text content starts
        {"contentBlockDelta": {"delta": {"text": "content"}}},
        {"contentBlockDelta": {"delta": {"text": "content"}}},
        {"contentBlockStop": {}},  # text content ends
        {"messageStop": {"stopReason": "end_turn"}},
        {
            "metadata": {
                "usage": {"inputTokens": 10, "outputTokens": 20, "totalTokens": 30},
                "metrics": {"latencyMs": 0},
            }
        },
    ]

    assert len(tru_events) == len(exp_events)
    expected_request = {
        "max_tokens": 1,
        "model": "m1",
        "messages": [{"role": "user", "content": [{"text": "test", "type": "text"}]}],
        "stream": True,
        "stream_options": {"include_usage": True},
        "tools": [],
    }
    openai_client.chat.completions.create.assert_called_once_with(**expected_request)


@pytest.mark.asyncio
async def test_stream_can_use_non_streaming_chat_completion(openai_client, model_id, messages, alist):
    mock_usage = unittest.mock.Mock(prompt_tokens=7, completion_tokens=3, total_tokens=10, prompt_tokens_details=None)
    mock_message = unittest.mock.Mock(content="done", tool_calls=None, reasoning_content=None, reasoning=None)
    mock_choice = unittest.mock.Mock(message=mock_message, finish_reason="stop")
    mock_response = unittest.mock.Mock(choices=[mock_choice], usage=mock_usage)

    openai_client.chat.completions.create = unittest.mock.AsyncMock(return_value=mock_response)
    model = OpenAIModel(model_id=model_id, stream=False, params={"max_tokens": 1})

    tru_events = await alist(model.stream(messages))
    exp_events = [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockStart": {"start": {}}},
        {"contentBlockDelta": {"delta": {"text": "done"}}},
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "end_turn"}},
        {
            "metadata": {
                "usage": {"inputTokens": 7, "outputTokens": 3, "totalTokens": 10},
                "metrics": {"latencyMs": 0},
            }
        },
    ]

    assert tru_events == exp_events
    openai_client.chat.completions.create.assert_called_once_with(
        max_tokens=1,
        model=model_id,
        messages=[{"role": "user", "content": [{"text": "test", "type": "text"}]}],
        stream=False,
        tools=[],
    )


@pytest.mark.asyncio
async def test_structured_output(openai_client, model, test_output_model_cls, alist):
    messages = [{"role": "user", "content": [{"text": "Generate a person"}]}]

    mock_parsed_instance = test_output_model_cls(name="John", age=30)
    mock_choice = unittest.mock.Mock()
    mock_choice.message.parsed = mock_parsed_instance
    mock_response = unittest.mock.Mock()
    mock_response.choices = [mock_choice]

    openai_client.beta.chat.completions.parse = unittest.mock.AsyncMock(return_value=mock_response)

    stream = model.structured_output(test_output_model_cls, messages)
    events = await alist(stream)

    tru_result = events[-1]
    exp_result = {"output": test_output_model_cls(name="John", age=30)}
    assert tru_result == exp_result


@pytest.mark.asyncio
async def test_structured_output_forwards_request_params(openai_client, model_id, test_output_model_cls, alist):
    messages = [{"role": "user", "content": [{"text": "Generate a person"}]}]
    model = OpenAIModel(model_id=model_id, params={"max_tokens": 100, "temperature": 0.5})

    mock_parsed_instance = test_output_model_cls(name="John", age=30)
    mock_choice = unittest.mock.Mock()
    mock_choice.message.parsed = mock_parsed_instance
    mock_response = unittest.mock.Mock(choices=[mock_choice])
    openai_client.beta.chat.completions.parse = unittest.mock.AsyncMock(return_value=mock_response)

    stream = model.structured_output(test_output_model_cls, messages, system_prompt="Be precise.")
    events = await alist(stream)

    tru_result = events[-1]
    exp_result = {"output": test_output_model_cls(name="John", age=30)}
    assert tru_result == exp_result

    # Config params are forwarded; the streaming-only fields (stream, stream_options) are dropped.
    openai_client.beta.chat.completions.parse.assert_called_once_with(
        messages=[
            {"role": "system", "content": "Be precise."},
            {"role": "user", "content": [{"text": "Generate a person", "type": "text"}]},
        ],
        model=model_id,
        tools=[],
        max_tokens=100,
        temperature=0.5,
        response_format=test_output_model_cls,
    )


def test_config_validation_warns_on_unknown_keys(openai_client, captured_warnings):
    """Test that unknown config keys emit a warning."""
    OpenAIModel({"api_key": "test"}, model_id="test-model", invalid_param="test")

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


@pytest.mark.parametrize(
    "new_data_type, prev_data_type, expected_chunks, expected_data_type",
    [
        ("text", None, [{"contentBlockStart": {"start": {}}}], "text"),
        (
            "reasoning_content",
            "text",
            [{"contentBlockStop": {}}, {"contentBlockStart": {"start": {}}}],
            "reasoning_content",
        ),
        ("text", "text", [], "text"),
    ],
)
def test__stream_switch_content(model, new_data_type, prev_data_type, expected_chunks, expected_data_type):
    """Test _stream_switch_content method for content type switching."""
    chunks, data_type = model._stream_switch_content(new_data_type, prev_data_type)
    assert chunks == expected_chunks
    assert data_type == expected_data_type


def test_format_request_messages_excludes_reasoning_content():
    """Test that reasoningContent is excluded from formatted messages."""
    messages = [
        {
            "content": [
                {"text": "Hello"},
                {"reasoningContent": {"reasoningText": {"text": "excluded"}}},
            ],
            "role": "user",
        },
    ]

    tru_result = OpenAIModel.format_request_messages(messages)

    # Only text content should be included
    exp_result = [
        {
            "content": [{"text": "Hello", "type": "text"}],
            "role": "user",
        },
    ]
    assert tru_result == exp_result


@pytest.mark.asyncio
async def test_structured_output_context_overflow_exception(openai_client, model, messages, test_output_model_cls):
    """Test that structured output also handles context overflow properly."""
    # Create a mock OpenAI BadRequestError with context_length_exceeded code
    mock_error = openai.BadRequestError(
        message="This model's maximum context length is 4096 tokens. However, your messages resulted in 5000 tokens.",
        response=unittest.mock.MagicMock(),
        body={"error": {"code": "context_length_exceeded"}},
    )
    mock_error.code = "context_length_exceeded"

    # Configure the mock client to raise the context overflow error
    openai_client.beta.chat.completions.parse.side_effect = mock_error

    # Test that the structured_output method converts the error properly
    with pytest.raises(ContextWindowOverflowException) as exc_info:
        async for _ in model.structured_output(test_output_model_cls, messages):
            pass

    # Verify the exception message contains the original error
    assert "maximum context length" in str(exc_info.value)
    assert exc_info.value.__cause__ == mock_error


@pytest.mark.asyncio
async def test_stream_context_overflow_exception(openai_client, model, messages):
    """Test that OpenAI context overflow errors are properly converted to ContextWindowOverflowException."""
    # Create a mock OpenAI BadRequestError with context_length_exceeded code
    mock_error = openai.BadRequestError(
        message="This model's maximum context length is 4096 tokens. However, your messages resulted in 5000 tokens.",
        response=unittest.mock.MagicMock(),
        body={"error": {"code": "context_length_exceeded"}},
    )
    mock_error.code = "context_length_exceeded"

    # Configure the mock client to raise the context overflow error
    openai_client.chat.completions.create.side_effect = mock_error

    # Test that the stream method converts the error properly
    with pytest.raises(ContextWindowOverflowException) as exc_info:
        async for _ in model.stream(messages):
            pass

    # Verify the exception message contains the original error
    assert "maximum context length" in str(exc_info.value)
    assert exc_info.value.__cause__ == mock_error


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "error_message",
    [
        "Input is too long for requested model",
        "input length and `max_tokens` exceed context limit",
        "too many total text bytes",
        "prompt tokens exceed customer model maximum",
        "MAXIMUM CONTEXT LENGTH EXCEEDED",
    ],
)
async def test_stream_alternative_context_overflow_messages(openai_client, model, messages, error_message):
    """Test that alternative context overflow messages in APIError are properly converted."""
    # Create a mock OpenAI APIError with alternative context overflow message
    mock_error = openai.APIError(
        message=error_message,
        request=unittest.mock.MagicMock(),
        body={"error": {"message": error_message}},
    )

    # Configure the mock client to raise the APIError
    openai_client.chat.completions.create.side_effect = mock_error

    # Test that the stream method converts the error properly
    with pytest.raises(ContextWindowOverflowException) as exc_info:
        async for _ in model.stream(messages):
            pass

    # Verify the exception message contains the original error
    assert error_message in str(exc_info.value)
    assert exc_info.value.__cause__ == mock_error


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "error_message",
    [
        "Input is too long for requested model",
        "input length and `max_tokens` exceed context limit",
        "too many total text bytes",
        "prompt tokens exceed customer model maximum",
        "MAXIMUM CONTEXT LENGTH EXCEEDED",
    ],
)
async def test_structured_output_alternative_context_overflow_messages(
    openai_client, model, messages, test_output_model_cls, error_message
):
    """Test that alternative context overflow messages in APIError are properly converted in structured output."""
    # Create a mock OpenAI APIError with alternative context overflow message
    mock_error = openai.APIError(
        message=error_message,
        request=unittest.mock.MagicMock(),
        body={"error": {"message": error_message}},
    )

    # Configure the mock client to raise the APIError
    openai_client.beta.chat.completions.parse.side_effect = mock_error

    # Test that the structured_output method converts the error properly
    with pytest.raises(ContextWindowOverflowException) as exc_info:
        async for _ in model.structured_output(test_output_model_cls, messages):
            pass

    # Verify the exception message contains the original error
    assert error_message in str(exc_info.value)
    assert exc_info.value.__cause__ == mock_error


@pytest.mark.asyncio
async def test_stream_api_error_passthrough(openai_client, model, messages):
    """Test that APIError without overflow messages passes through unchanged."""
    # Create a mock OpenAI APIError without overflow message
    mock_error = openai.APIError(
        message="Some other API error",
        request=unittest.mock.MagicMock(),
        body={"error": {"message": "Some other API error"}},
    )

    # Configure the mock client to raise the APIError
    openai_client.chat.completions.create.side_effect = mock_error

    # Test that APIError without overflow messages passes through
    with pytest.raises(openai.APIError) as exc_info:
        async for _ in model.stream(messages):
            pass

    # Verify the original exception is raised, not ContextWindowOverflowException
    assert exc_info.value == mock_error


@pytest.mark.asyncio
async def test_stream_other_bad_request_errors_passthrough(openai_client, model, messages):
    """Test that other BadRequestError exceptions are not converted to ContextWindowOverflowException."""
    # Create a mock OpenAI BadRequestError with a different error code
    mock_error = openai.BadRequestError(
        message="Invalid parameter value",
        response=unittest.mock.MagicMock(),
        body={"error": {"code": "invalid_parameter"}},
    )
    mock_error.code = "invalid_parameter"

    # Configure the mock client to raise the non-context error
    openai_client.chat.completions.create.side_effect = mock_error

    # Test that other BadRequestError exceptions pass through unchanged
    with pytest.raises(openai.BadRequestError) as exc_info:
        async for _ in model.stream(messages):
            pass

    # Verify the original exception is raised, not ContextWindowOverflowException
    assert exc_info.value == mock_error


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("mock_error", "expected_exception"),
    [
        (
            openai.APIStatusError(
                "opaque provider failure",
                response=httpx.Response(
                    429,
                    request=httpx.Request("POST", "https://api.openai.com/v1/chat/completions"),
                ),
                body=None,
            ),
            ModelThrottledException,
        ),
        (
            openai.APIError(
                message="prompt tokens exceed customer model maximum",
                request=unittest.mock.MagicMock(),
                body=None,
            ),
            ContextWindowOverflowException,
        ),
    ],
)
async def test_stream_classifies_error_during_iteration(openai_client, model, messages, mock_error, expected_exception):
    async def error_generator():
        yield unittest.mock.Mock(choices=[])
        raise mock_error

    openai_client.chat.completions.create = unittest.mock.AsyncMock(return_value=error_generator())

    with pytest.raises(expected_exception) as exc_info:
        async for _ in model.stream(messages):
            pass

    assert exc_info.value.__cause__ is mock_error


@pytest.mark.asyncio
async def test_stream_http_429_as_throttle(openai_client, model, messages):
    request = httpx.Request("POST", "https://api.openai.com/v1/chat/completions")
    response = httpx.Response(429, request=request)
    mock_error = openai.APIStatusError("opaque provider failure", response=response, body=None)
    openai_client.chat.completions.create.side_effect = mock_error

    with pytest.raises(ModelThrottledException, match="opaque provider failure") as exc_info:
        async for _ in model.stream(messages):
            pass

    assert exc_info.value.__cause__ is mock_error


@pytest.mark.asyncio
async def test_structured_output_rate_limit_message(openai_client, model, messages, test_output_model_cls):
    mock_error = openai.APIError(
        message="Too many requests from provider",
        request=unittest.mock.MagicMock(),
        body={"error": {"message": "Too many requests from provider"}},
    )
    openai_client.beta.chat.completions.parse.side_effect = mock_error

    with pytest.raises(ModelThrottledException, match="Too many requests") as exc_info:
        async for _ in model.structured_output(test_output_model_cls, messages):
            pass

    assert exc_info.value.__cause__ is mock_error


@pytest.mark.asyncio
async def test_stream_rate_limit_as_throttle(openai_client, model, messages):
    """Test that all rate limit errors are converted to ModelThrottledException."""

    # Create a mock OpenAI RateLimitError (any type of rate limit)
    mock_error = openai.RateLimitError(
        message="Request too large for gpt-4o on tokens per min (TPM): Limit 30000, Requested 117505.",
        response=unittest.mock.MagicMock(),
        body={"error": {"code": "rate_limit_exceeded"}},
    )
    mock_error.code = "rate_limit_exceeded"

    # Configure the mock client to raise the rate limit error
    openai_client.chat.completions.create.side_effect = mock_error

    # Test that the stream method converts the error properly
    with pytest.raises(ModelThrottledException) as exc_info:
        async for _ in model.stream(messages):
            pass

    # Verify the exception message contains the original error
    assert "tokens per min" in str(exc_info.value)
    assert exc_info.value.__cause__ == mock_error


@pytest.mark.asyncio
async def test_stream_request_rate_limit_as_throttle(openai_client, model, messages):
    """Test that request-based rate limit errors are converted to ModelThrottledException."""

    # Create a mock OpenAI RateLimitError for request-based rate limiting
    mock_error = openai.RateLimitError(
        message="Rate limit reached for requests per minute.",
        response=unittest.mock.MagicMock(),
        body={"error": {"code": "rate_limit_exceeded"}},
    )
    mock_error.code = "rate_limit_exceeded"

    # Configure the mock client to raise the request rate limit error
    openai_client.chat.completions.create.side_effect = mock_error

    # Test that the stream method converts the error properly
    with pytest.raises(ModelThrottledException) as exc_info:
        async for _ in model.stream(messages):
            pass

    # Verify the exception message contains the original error
    assert "Rate limit reached" in str(exc_info.value)
    assert exc_info.value.__cause__ == mock_error


@pytest.mark.asyncio
async def test_structured_output_rate_limit_as_throttle(openai_client, model, messages, test_output_model_cls):
    """Test that structured output handles rate limit errors properly."""

    # Create a mock OpenAI RateLimitError
    mock_error = openai.RateLimitError(
        message="Request too large for gpt-4o on tokens per min (TPM): Limit 30000, Requested 117505.",
        response=unittest.mock.MagicMock(),
        body={"error": {"code": "rate_limit_exceeded"}},
    )
    mock_error.code = "rate_limit_exceeded"

    # Configure the mock client to raise the rate limit error
    openai_client.beta.chat.completions.parse.side_effect = mock_error

    # Test that the structured_output method converts the error properly
    with pytest.raises(ModelThrottledException) as exc_info:
        async for _ in model.structured_output(test_output_model_cls, messages):
            pass

    # Verify the exception message contains the original error
    assert "tokens per min" in str(exc_info.value)
    assert exc_info.value.__cause__ == mock_error


def test_format_request_messages_with_system_prompt_content():
    """Test format_request_messages with system_prompt_content parameter."""
    messages = [{"role": "user", "content": [{"text": "Hello"}]}]
    system_prompt_content = [{"text": "You are a helpful assistant."}]

    result = OpenAIModel.format_request_messages(messages, system_prompt_content=system_prompt_content)

    expected = [
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": [{"text": "Hello", "type": "text"}]},
    ]

    assert result == expected


def test_format_request_messages_with_none_system_prompt_content():
    """Test format_request_messages with system_prompt_content parameter."""
    messages = [{"role": "user", "content": [{"text": "Hello"}]}]

    result = OpenAIModel.format_request_messages(messages)

    expected = [{"role": "user", "content": [{"text": "Hello", "type": "text"}]}]

    assert result == expected


def test_format_request_messages_drops_cache_points():
    """Test that cache points are dropped in OpenAI format_request_messages."""
    messages = [{"role": "user", "content": [{"text": "Hello"}]}]
    system_prompt_content = [{"text": "You are a helpful assistant."}, {"cachePoint": {"type": "default"}}]

    result = OpenAIModel.format_request_messages(messages, system_prompt_content=system_prompt_content)

    # Cache points should be dropped, only text content included
    expected = [
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": [{"text": "Hello", "type": "text"}]},
    ]

    assert result == expected


@pytest.mark.asyncio
async def test_stream_with_injected_client(model_id, agenerator, alist):
    """Test that stream works with an injected client and doesn't close it."""
    # Create a mock injected client
    mock_injected_client = unittest.mock.AsyncMock()
    mock_injected_client.close = unittest.mock.AsyncMock()

    mock_delta = unittest.mock.Mock(content="Hello", tool_calls=None, reasoning_content=None)
    mock_event_1 = unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason=None, delta=mock_delta)])
    mock_event_2 = unittest.mock.Mock(choices=[unittest.mock.Mock(finish_reason="stop", delta=mock_delta)])
    mock_event_3 = unittest.mock.Mock()

    mock_injected_client.chat.completions.create = unittest.mock.AsyncMock(
        return_value=agenerator([mock_event_1, mock_event_2, mock_event_3])
    )

    # Create model with injected client
    model = OpenAIModel(client=mock_injected_client, model_id=model_id, params={"max_tokens": 1})

    messages = [{"role": "user", "content": [{"text": "test"}]}]
    response = model.stream(messages)
    tru_events = await alist(response)

    # Verify events were generated
    assert len(tru_events) > 0

    # Verify the injected client was used
    mock_injected_client.chat.completions.create.assert_called_once()

    # Verify the injected client was NOT closed
    mock_injected_client.close.assert_not_called()


@pytest.mark.asyncio
async def test_structured_output_with_injected_client(model_id, test_output_model_cls, alist):
    """Test that structured_output works with an injected client and doesn't close it."""
    # Create a mock injected client
    mock_injected_client = unittest.mock.AsyncMock()
    mock_injected_client.close = unittest.mock.AsyncMock()

    mock_parsed_instance = test_output_model_cls(name="John", age=30)
    mock_choice = unittest.mock.Mock()
    mock_choice.message.parsed = mock_parsed_instance
    mock_response = unittest.mock.Mock()
    mock_response.choices = [mock_choice]

    mock_injected_client.beta.chat.completions.parse = unittest.mock.AsyncMock(return_value=mock_response)

    # Create model with injected client
    model = OpenAIModel(client=mock_injected_client, model_id=model_id, params={"max_tokens": 1})

    messages = [{"role": "user", "content": [{"text": "Generate a person"}]}]
    stream = model.structured_output(test_output_model_cls, messages)
    events = await alist(stream)

    # Verify output was generated
    assert len(events) == 1
    assert events[0] == {"output": test_output_model_cls(name="John", age=30)}

    # Verify the injected client was used
    mock_injected_client.beta.chat.completions.parse.assert_called_once()

    # Verify the injected client was NOT closed
    mock_injected_client.close.assert_not_called()


def test_init_with_both_client_and_client_args_raises_error():
    """Test that providing both client and client_args raises ValueError."""
    mock_client = unittest.mock.AsyncMock()

    with pytest.raises(ValueError, match="Only one of 'client' or 'client_args' should be provided"):
        OpenAIModel(client=mock_client, client_args={"api_key": "test"}, model_id="test-model")


def test_format_request_filters_s3_source_image(model, caplog):
    """Test that images with Location sources are filtered out with warning."""
    caplog.set_level(logging.WARNING, logger="strands.models.openai")

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
    formatted_content = request["messages"][0]["content"]
    assert len(formatted_content) == 1
    assert formatted_content[0]["type"] == "text"
    assert "Location sources are not supported by OpenAI" in caplog.text


def test_format_request_skips_message_cache_point(model, caplog):
    caplog.set_level(logging.WARNING, logger="strands.models.openai")

    messages = [{"role": "user", "content": [{"text": "durable prefix"}, {"cachePoint": {"type": "default"}}]}]

    request = model.format_request(messages)

    assert request["messages"][0]["content"] == [{"text": "durable prefix", "type": "text"}]
    assert "cachePoint content block is not supported by OpenAI" in caplog.text


def test_format_request_filters_location_source_document(model, caplog):
    """Test that documents with Location sources are filtered out with warning."""
    caplog.set_level(logging.WARNING, logger="strands.models.openai")

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
    formatted_content = request["messages"][0]["content"]
    assert len(formatted_content) == 1
    assert formatted_content[0]["type"] == "text"
    assert "Location sources are not supported by OpenAI" in caplog.text


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

    tru_result = OpenAIModel.format_request_messages(messages)

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


def test_format_request_messages_multiple_tool_calls_with_images():
    """Test that multiple tool calls with image results are formatted correctly.

    OpenAI requires all tool response messages to immediately follow the assistant
    message with tool_calls, before any other messages. When tools return images,
    the images are moved to user messages, but these must come after ALL tool messages.
    """
    messages = [
        {"role": "user", "content": [{"text": "Run the tools"}]},
        {
            "role": "assistant",
            "content": [
                {"toolUse": {"input": {}, "name": "tool1", "toolUseId": "call_1"}},
                {"toolUse": {"input": {}, "name": "tool2", "toolUseId": "call_2"}},
            ],
        },
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "call_1",
                        "content": [{"image": {"format": "png", "source": {"bytes": b"img1"}}}],
                        "status": "success",
                    }
                },
                {
                    "toolResult": {
                        "toolUseId": "call_2",
                        "content": [{"image": {"format": "png", "source": {"bytes": b"img2"}}}],
                        "status": "success",
                    }
                },
            ],
        },
    ]

    tru_result = OpenAIModel.format_request_messages(messages)

    image_placeholder = (
        "Tool successfully returned an image. The image is being provided in the following user message."
    )
    exp_result = [
        {"role": "user", "content": [{"text": "Run the tools", "type": "text"}]},
        {
            "role": "assistant",
            "tool_calls": [
                {"function": {"arguments": "{}", "name": "tool1"}, "id": "call_1", "type": "function"},
                {"function": {"arguments": "{}", "name": "tool2"}, "id": "call_2", "type": "function"},
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "call_1",
            "content": [{"type": "text", "text": image_placeholder}],
        },
        {
            "role": "tool",
            "tool_call_id": "call_2",
            "content": [{"type": "text", "text": image_placeholder}],
        },
        {
            "role": "user",
            "content": [
                {
                    "image_url": {"detail": "auto", "format": "image/png", "url": "data:image/png;base64,aW1nMQ=="},
                    "type": "image_url",
                }
            ],
        },
        {
            "role": "user",
            "content": [
                {
                    "image_url": {"detail": "auto", "format": "image/png", "url": "data:image/png;base64,aW1nMg=="},
                    "type": "image_url",
                }
            ],
        },
    ]
    assert tru_result == exp_result


# =============================================================================
# Bedrock Mantle (bedrock_mantle_config) integration with OpenAIModel
# =============================================================================


class TestOpenAIModelBedrockMantleConfig:
    @pytest.fixture
    def mock_provide_token(self):
        with unittest.mock.patch("aws_bedrock_token_generator.provide_token") as mock:
            mock.return_value = "bedrock-api-key-deadbeef&Version=1"
            yield mock

    def test_bedrock_mantle_config_sets_base_url_and_api_key(self, openai_client, mock_provide_token):
        """bedrock_mantle_config produces the Mantle base_url and a minted bearer token as api_key."""
        _ = openai_client
        model = OpenAIModel(model_id="openai.gpt-oss-120b", bedrock_mantle_config={"region": "us-east-1"})

        # Token is minted lazily per request, so inspect the resolved kwargs.
        resolved = model._resolve_client_args()
        assert resolved["base_url"] == "https://bedrock-mantle.us-east-1.api.aws/v1"
        assert resolved["api_key"] == "bedrock-api-key-deadbeef&Version=1"
        # Optional kwargs aren't forwarded so provide_token's own defaults apply.
        mock_provide_token.assert_called_once_with(region="us-east-1")

    def test_bedrock_mantle_config_uses_openai_path_for_gpt5(self, openai_client, mock_provide_token):
        """gpt-5.* models are routed through the /openai/v1 Mantle path."""
        _ = openai_client
        _ = mock_provide_token
        model = OpenAIModel(model_id="openai.gpt-5.4", bedrock_mantle_config={"region": "us-east-1"})

        resolved = model._resolve_client_args()
        assert resolved["base_url"] == "https://bedrock-mantle.us-east-1.api.aws/openai/v1"

    @pytest.mark.parametrize(
        ("model_id", "expected_path"),
        [
            # Regression for #3654: Mantle rejects the wrong base path with HTTP 400
            # validation_error. The affected ids use /openai/v1; controls below pin /v1.
            ("xai.grok-4.3", "/openai/v1"),
            ("google.gemma-4-31b", "/openai/v1"),
            ("google.gemma-4-26b-a4b", "/openai/v1"),
            ("google.gemma-4-e2b", "/openai/v1"),
            ("openai.gpt-5.6-terra", "/openai/v1"),
            # Gemma 3 is served from /v1 while Gemma 4 is not, so `google.` cannot be a prefix.
            ("google.gemma-3-27b-it", "/v1"),
            ("google.gemma-3-4b-it", "/v1"),
            ("openai.gpt-oss-120b", "/v1"),
            ("openai.gpt-oss-safeguard-20b", "/v1"),
            ("qwen.qwen3-32b", "/v1"),
            ("deepseek.v3.2", "/v1"),
            ("mistral.ministral-3-8b-instruct", "/v1"),
            ("zai.glm-5", "/v1"),
            ("moonshotai.kimi-k2.5", "/v1"),
            ("minimax.minimax-m2", "/v1"),
            ("nvidia.nemotron-nano-9b-v2", "/v1"),
            ("writer.palmyra-vision-7b", "/v1"),
        ],
    )
    def test_bedrock_mantle_config_base_path_per_model(
        self, model_id, expected_path, openai_client, mock_provide_token
    ):
        """Each Mantle model resolves to the base path it is actually served from."""
        _ = openai_client
        _ = mock_provide_token
        model = OpenAIModel(model_id=model_id, bedrock_mantle_config={"region": "us-east-1"})

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
        """Ids beyond the verified catalog: a known line routes by prefix, a new line falls to /v1."""
        _ = openai_client
        _ = mock_provide_token
        model = OpenAIModel(model_id=model_id, bedrock_mantle_config={"region": "us-east-1"})

        resolved = model._resolve_client_args()
        assert resolved["base_url"] == f"https://bedrock-mantle.us-east-1.api.aws{expected_path}"

    def test_bedrock_mantle_config_forwards_credentials_provider_and_expiry(self, openai_client, mock_provide_token):
        """Optional credentials_provider and expiry are forwarded to provide_token."""
        _ = openai_client
        from datetime import timedelta

        provider = unittest.mock.Mock()
        model = OpenAIModel(
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
        """Each call to _resolve_client_args mints a fresh token (long-lived processes)."""
        _ = openai_client
        model = OpenAIModel(model_id="openai.gpt-oss-120b", bedrock_mantle_config={"region": "us-east-1"})
        model._resolve_client_args()
        model._resolve_client_args()
        model._resolve_client_args()
        assert mock_provide_token.call_count == 3

    def test_bedrock_mantle_config_conflicts_with_custom_client(self, openai_client):
        """Cannot pass both bedrock_mantle_config and a pre-built client."""
        _ = openai_client
        custom_client = unittest.mock.Mock()
        with pytest.raises(ValueError, match="bedrock_mantle_config"):
            OpenAIModel(
                model_id="openai.gpt-oss-120b",
                client=custom_client,
                bedrock_mantle_config={"region": "us-east-1"},
            )

    def test_bedrock_mantle_config_merges_with_client_args(self, openai_client, mock_provide_token):
        """bedrock_mantle_config composes with client_args; transport options are preserved."""
        _ = openai_client
        sentinel_http_client = unittest.mock.Mock()
        model = OpenAIModel(
            model_id="openai.gpt-oss-120b",
            client_args={
                "timeout": 42,
                "http_client": sentinel_http_client,
                "default_headers": {"X-Trace-Id": "abc"},
            },
            bedrock_mantle_config={"region": "us-east-1"},
        )
        resolved = model._resolve_client_args()
        assert resolved["base_url"] == "https://bedrock-mantle.us-east-1.api.aws/v1"
        assert resolved["api_key"] == "bedrock-api-key-deadbeef&Version=1"
        assert resolved["timeout"] == 42
        assert resolved["http_client"] is sentinel_http_client
        assert resolved["default_headers"] == {"X-Trace-Id": "abc"}

    def test_bedrock_mantle_config_rejects_base_url_in_client_args(self, openai_client):
        """client_args must not contain base_url or api_key when bedrock_mantle_config is set."""
        _ = openai_client
        with pytest.raises(ValueError, match="client_args must not contain"):
            OpenAIModel(
                model_id="openai.gpt-oss-120b",
                client_args={"base_url": "https://custom.example.com"},
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
            model = OpenAIModel(model_id="openai.gpt-oss-120b", bedrock_mantle_config={})
            with pytest.raises(ValueError, match="Could not resolve an AWS region"):
                model._resolve_client_args()

    def test_bedrock_mantle_config_region_resolved_from_boto3_default(self, openai_client, mock_provide_token):
        """When region is omitted, the default boto3 session chain resolves it."""
        _ = openai_client
        with unittest.mock.patch("boto3.Session") as mock_session_cls:
            mock_session_cls.return_value.region_name = "eu-west-1"
            model = OpenAIModel(model_id="openai.gpt-oss-120b", bedrock_mantle_config={})
            resolved = model._resolve_client_args()

        assert resolved["base_url"] == "https://bedrock-mantle.eu-west-1.api.aws/v1"
        mock_provide_token.assert_called_once_with(region="eu-west-1")

    @pytest.mark.parametrize("region", ["x@attacker.com:443/#", "us-east-1\n", "us-east-1/"])
    def test_bedrock_mantle_config_rejects_malformed_region(self, openai_client, mock_provide_token, region):
        """A malformed region is rejected before a token is minted or a URL is built."""
        _ = openai_client
        model = OpenAIModel(model_id="openai.gpt-oss-120b", bedrock_mantle_config={"region": region})
        with pytest.raises(ValueError, match="invalid AWS region"):
            model._resolve_client_args()
        # Validation must precede token minting so no bearer token is ever sent toward the host.
        mock_provide_token.assert_not_called()

    def test_bedrock_mantle_config_rejects_malformed_region_from_boto3_default(self, openai_client, mock_provide_token):
        """A malformed region resolved from the boto3 default chain is also rejected."""
        _ = openai_client
        with unittest.mock.patch("boto3.Session") as mock_session_cls:
            mock_session_cls.return_value.region_name = "x@attacker.com:443/#"
            model = OpenAIModel(model_id="openai.gpt-oss-120b", bedrock_mantle_config={})
            with pytest.raises(ValueError, match="invalid AWS region"):
                model._resolve_client_args()
        mock_provide_token.assert_not_called()

    def test_bedrock_mantle_config_region_resolved_from_boto_session(self, openai_client, mock_provide_token):
        """An explicit ``boto_session`` supplies the region when ``region`` is omitted."""
        _ = openai_client
        session = unittest.mock.Mock()
        session.region_name = "ap-southeast-2"
        model = OpenAIModel(
            model_id="openai.gpt-oss-120b",
            bedrock_mantle_config={"boto_session": session},
        )

        resolved = model._resolve_client_args()

        assert resolved["base_url"] == "https://bedrock-mantle.ap-southeast-2.api.aws/v1"
        mock_provide_token.assert_called_once_with(region="ap-southeast-2")

    def test_bedrock_mantle_config_explicit_region_wins_over_boto_session(self, openai_client, mock_provide_token):
        """``region`` takes precedence over a session's region."""
        _ = openai_client
        session = unittest.mock.Mock()
        session.region_name = "ap-southeast-2"
        model = OpenAIModel(
            model_id="openai.gpt-oss-120b",
            bedrock_mantle_config={"region": "us-east-1", "boto_session": session},
        )

        model._resolve_client_args()

        mock_provide_token.assert_called_once_with(region="us-east-1")

    def test_bedrock_mantle_config_wraps_token_failures_with_context(self, openai_client, mock_provide_token):
        """provide_token failures are wrapped in a RuntimeError with actionable context."""
        _ = openai_client
        mock_provide_token.side_effect = RuntimeError("no credentials in chain")
        model = OpenAIModel(model_id="openai.gpt-oss-120b", bedrock_mantle_config={"region": "us-east-1"})
        with pytest.raises(RuntimeError, match="Bedrock Mantle bearer token.*us-east-1"):
            model._resolve_client_args()
