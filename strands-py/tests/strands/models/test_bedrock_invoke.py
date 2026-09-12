"""Tests for ``BedrockInvokeModel``."""

import asyncio
import base64
import json
import logging
import sys
import threading
import time
import traceback
import unittest.mock

import pydantic
import pytest
from botocore.exceptions import ClientError

import strands
from strands import _exception_notes, tool
from strands.event_loop import streaming
from strands.models.bedrock import DEFAULT_BEDROCK_MODEL_ID
from strands.models.bedrock_invoke import BedrockInvokeModel
from strands.models.model import Model
from strands.types.exceptions import ContextWindowOverflowException, ModelThrottledException

CLAUDE_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0"
# An id with no native-schema prefix, so family detection settles on the openai dialect.
IMPORTED_ID = "arn:aws:bedrock:us-east-1:123:imported-model/abc"
# A foundation-model id whose native InvokeModel body shape this provider does not send.
NATIVE_SCHEMA_ID = "meta.llama3-1-8b-instruct-v1:0"


@tool
def string_length(string_to_measure: str) -> str:
    """Return the length of the string passed in."""
    return str(len(string_to_measure))


@pytest.fixture
def session_cls():
    with unittest.mock.patch.object(strands.models.bedrock.boto3, "Session") as mock_cls:
        sess = unittest.mock.Mock()
        sess.region_name = None
        mock_cls.return_value = sess
        yield mock_cls


@pytest.fixture
def bedrock_client(session_cls):
    client = session_cls.return_value.client.return_value
    client.meta = unittest.mock.MagicMock()
    client.meta.region_name = "us-west-2"
    return client


@pytest.fixture
def model(bedrock_client):
    _ = bedrock_client
    return BedrockInvokeModel(model_id=CLAUDE_ID)


def _chunks(payloads):
    return [{"chunk": {"bytes": json.dumps(p).encode("utf-8")}} for p in payloads]


async def _collect(m, *args, **kwargs):
    return [e async for e in m.stream(*args, **kwargs)]


def _texts(events):
    return "".join(
        e["contentBlockDelta"]["delta"]["text"]
        for e in events
        if "contentBlockDelta" in e and "text" in e["contentBlockDelta"]["delta"]
    )


def _tool_inputs(events):
    return "".join(
        e["contentBlockDelta"]["delta"]["toolUse"]["input"]
        for e in events
        if "contentBlockDelta" in e and "toolUse" in e["contentBlockDelta"]["delta"]
    )


def _reasoning_deltas(events):
    return [
        e["contentBlockDelta"]["delta"]["reasoningContent"]
        for e in events
        if "contentBlockDelta" in e and "reasoningContent" in e["contentBlockDelta"]["delta"]
    ]


def _stop_reason(events):
    return next(e for e in events if "messageStop" in e)["messageStop"]["stopReason"]


def _metadata(events):
    return next(e for e in events if "metadata" in e)["metadata"]


def _tool_use_blocks(events):
    """Group tool-use content blocks by their delimiting start/stop events, as the consumer sees them.

    Returns a list of ``(start, joined_input)`` pairs, one per tool call, so a test can assert that
    parallel tool calls stay separate blocks instead of being merged or overwritten.
    """
    blocks = []
    current = None
    for event in events:
        if "contentBlockStart" in event:
            start = event["contentBlockStart"]["start"].get("toolUse")
            current = (start, []) if start else None
        elif "contentBlockStop" in event and current is not None:
            blocks.append((current[0], "".join(current[1])))
            current = None
        elif "contentBlockDelta" in event and current is not None:
            delta = event["contentBlockDelta"]["delta"]
            if "toolUse" in delta:
                current[1].append(delta["toolUse"]["input"])
    return blocks


pytestmark = pytest.mark.usefixtures("bedrock_client")


def test_lazy_export_from_models_package():
    """The provider resolves through the package's lazy ``__getattr__`` so importing it stays optional."""
    assert "BedrockInvokeModel" in strands.models.__all__
    assert strands.models.BedrockInvokeModel is BedrockInvokeModel


def test_init_default_model_id():
    m = BedrockInvokeModel()
    assert m.get_config()["model_id"] == DEFAULT_BEDROCK_MODEL_ID
    assert m.get_config()["streaming"] is True


def test_init_explicit_model_id():
    m = BedrockInvokeModel(model_id="my-model", streaming=False)
    assert m.get_config()["model_id"] == "my-model"
    assert m.get_config()["streaming"] is False


def test_init_rejects_session_and_region():
    with pytest.raises(ValueError):
        BedrockInvokeModel(boto_session=unittest.mock.Mock(), region_name="us-east-1")


def test_update_config():
    m = BedrockInvokeModel(model_id="m")
    m.update_config(temperature=0.7, max_tokens=128)
    cfg = m.get_config()
    assert cfg["temperature"] == 0.7
    assert cfg["max_tokens"] == 128


def test_get_config_resolves_context_window_limit_for_known_model():
    """A known model id resolves its context window limit so ConversationManager can compress proactively."""
    m = BedrockInvokeModel(model_id=CLAUDE_ID)
    assert m.get_config()["context_window_limit"] == 200_000
    assert m.context_window_limit == 200_000


def test_get_config_keeps_explicit_context_window_limit():
    m = BedrockInvokeModel(model_id=CLAUDE_ID, context_window_limit=42)
    assert m.get_config()["context_window_limit"] == 42
    assert m.context_window_limit == 42


def test_get_config_context_window_limit_none_for_unknown_model():
    m = BedrockInvokeModel(model_id=IMPORTED_ID)
    assert m.get_config().get("context_window_limit") is None
    assert m.context_window_limit is None


# ---- token counting


@pytest.mark.asyncio
async def test_count_tokens_uses_heuristic(bedrock_client):
    """Native CountTokens is Converse-shaped, so this provider always estimates locally."""
    messages = [{"role": "user", "content": [{"text": "count these tokens please"}]}]

    m = BedrockInvokeModel(model_id=CLAUDE_ID)
    tru_count = await m.count_tokens(messages)
    exp_count = await Model.count_tokens(m, messages)

    assert tru_count == exp_count
    bedrock_client.count_tokens.assert_not_called()


@pytest.mark.asyncio
async def test_count_tokens_ignores_use_native_token_count(bedrock_client):
    messages = [{"role": "user", "content": [{"text": "count these tokens please"}]}]

    m = BedrockInvokeModel(model_id=CLAUDE_ID)
    m.config["use_native_token_count"] = True  # type: ignore[typeddict-unknown-key]

    tru_count = await m.count_tokens(messages)
    exp_count = await Model.count_tokens(m, messages)

    assert tru_count == exp_count
    bedrock_client.count_tokens.assert_not_called()


@pytest.mark.parametrize(
    "model_id, expected",
    [
        (CLAUDE_ID, "anthropic"),
        ("global.anthropic.claude-sonnet-4-6", "anthropic"),
        ("us.anthropic.claude-3-haiku", "anthropic"),
        (IMPORTED_ID, "openai"),
        ("my-imported-model", "openai"),
    ],
)
def test_model_family_detection(model_id, expected):
    assert BedrockInvokeModel(model_id=model_id)._get_model_family() == expected


def test_model_family_override():
    m = BedrockInvokeModel(model_id=IMPORTED_ID, model_family="anthropic")
    assert m._get_model_family() == "anthropic"


@pytest.mark.parametrize(
    "model_id",
    [
        "amazon.titan-text-express-v1",
        NATIVE_SCHEMA_ID,
        "mistral.mistral-large-2402-v1:0",
        "cohere.command-r-v1:0",
        "ai21.jamba-1-5-mini-v1:0",
    ],
)
def test_model_family_detection_rejects_native_schema_model(model_id):
    """A native foundation model takes a body shape this provider does not send, so detection refuses to guess."""
    m = BedrockInvokeModel(model_id=model_id)
    with pytest.raises(ValueError, match="model_family"):
        m._get_model_family()


@pytest.mark.parametrize("family", ["anthropic", "openai"])
def test_model_family_override_allows_native_schema_model(family):
    """An explicit override is an intentional choice, so it wins even over a native-schema model id."""
    m = BedrockInvokeModel(model_id=NATIVE_SCHEMA_ID, model_family=family)
    assert m._get_model_family() == family


@pytest.mark.asyncio
async def test_stream_native_schema_model_raises_before_invoking(bedrock_client):
    """The guard surfaces to the caller rather than sending a body the model cannot parse."""
    m = BedrockInvokeModel(model_id=NATIVE_SCHEMA_ID)
    with pytest.raises(ValueError, match="model_family"):
        await _collect(m, [{"role": "user", "content": [{"text": "hi"}]}])

    bedrock_client.invoke_model_with_response_stream.assert_not_called()


# ---- request formatting


def test_format_anthropic_request_minimal(model):
    req = model._format_anthropic_request(
        [{"role": "user", "content": [{"text": "hello"}]}], None, [{"text": "be nice"}], None
    )
    assert req["anthropic_version"] == "bedrock-2023-05-31"
    assert req["system"] == "be nice"
    assert req["messages"] == [{"role": "user", "content": [{"type": "text", "text": "hello"}]}]


def test_format_anthropic_request_image_media_type(model):
    msg = {"role": "user", "content": [{"image": {"format": "png", "source": {"bytes": b"\x89PNG\r\n"}}}]}
    req = model._format_anthropic_request([msg], None, None, None)
    image = req["messages"][0]["content"][0]
    assert image["type"] == "image"
    assert image["source"]["media_type"] == "image/png"


def test_format_anthropic_request_tool_use_and_result(model):
    tu = {"toolUseId": "tu1", "name": "weather", "input": {"city": "Paris"}}
    tr = {"toolUseId": "tu1", "status": "error", "content": [{"text": "boom"}]}
    msgs = [
        {"role": "assistant", "content": [{"toolUse": tu}]},
        {"role": "user", "content": [{"toolResult": tr}]},
    ]
    req = model._format_anthropic_request(msgs, None, None, None)
    expected = {"type": "tool_use", "id": "tu1", "name": "weather", "input": tu["input"]}
    assert req["messages"][0]["content"][0] == expected
    user = req["messages"][1]["content"][0]
    assert user["type"] == "tool_result"
    assert user["tool_use_id"] == "tu1"
    assert user["is_error"] is True
    assert user["content"] == [{"type": "text", "text": "boom"}]


def test_format_anthropic_request_tool_choice(model):
    req = model._format_anthropic_request(
        [{"role": "user", "content": [{"text": "x"}]}],
        [string_length.tool_spec],
        None,
        {"any": {}},
    )
    assert req["tool_choice"] == {"type": "any"}
    assert req["tools"][0]["name"] == string_length.tool_name
    assert req["tools"][0]["input_schema"] == string_length.tool_spec["inputSchema"]["json"]


def test_format_anthropic_request_reasoning(model):
    reasoning = {"reasoningContent": {"reasoningText": {"text": "working", "signature": "sig"}}}

    req = model._format_anthropic_request([{"role": "assistant", "content": [reasoning]}], None, None, None)

    tru_content = req["messages"][0]["content"]
    exp_content = [{"type": "thinking", "thinking": "working", "signature": "sig"}]
    assert tru_content == exp_content


def test_format_anthropic_request_redacted_reasoning(model):
    reasoning = {"reasoningContent": {"redactedContent": b"redacted-bytes"}}

    req = model._format_anthropic_request([{"role": "assistant", "content": [reasoning]}], None, None, None)

    tru_content = req["messages"][0]["content"]
    exp_content = [{"type": "redacted_thinking", "data": base64.b64encode(b"redacted-bytes").decode("utf-8")}]
    assert tru_content == exp_content


@pytest.mark.parametrize("family, schema_key", [("anthropic", "input_schema"), ("openai", "parameters")])
def test_format_request_unwraps_tool_input_schema(model, family, schema_key):
    """``ToolSpec.inputSchema`` is a ``{"json": ...}`` envelope; only the schema inside it goes on the wire."""
    model.update_config(model_family=family)
    req = model._format_invoke_request(
        [{"role": "user", "content": [{"text": "x"}]}], [string_length.tool_spec], None, None
    )
    declared = req["tools"][0] if family == "anthropic" else req["tools"][0]["function"]

    tru_schema = declared[schema_key]
    exp_schema = string_length.tool_spec["inputSchema"]["json"]
    assert tru_schema == exp_schema
    assert "json" not in tru_schema


@pytest.mark.parametrize("family", ["anthropic", "openai"])
@pytest.mark.parametrize("config", [{}, {"max_tokens": None}], ids=["unset", "explicit_none"])
def test_format_request_max_tokens_falls_back_to_default(family, config):
    """The Anthropic Messages API requires ``max_tokens``, so neither an unset nor a ``None`` value reaches the wire."""
    m = BedrockInvokeModel(model_id=CLAUDE_ID, model_family=family, **config)
    req = m._format_invoke_request([{"role": "user", "content": [{"text": "x"}]}], None, None, None)
    assert req["max_tokens"] == 4096


def test_format_openai_request_basic():
    m = BedrockInvokeModel(model_id=IMPORTED_ID)
    req = m._format_openai_request([{"role": "user", "content": [{"text": "Hello"}]}], None, [{"text": "sys"}], None)
    assert req["model"] == IMPORTED_ID
    assert req["messages"][0] == {"role": "system", "content": "sys"}
    assert req["messages"][1] == {"role": "user", "content": "Hello"}


def test_format_openai_request_tool_calls_and_results():
    m = BedrockInvokeModel(model_id="my-imported-model", model_family="openai")
    tu = {"toolUseId": "tu1", "name": "fn", "input": {"x": 1}}
    tr = {"toolUseId": "tu1", "status": "success", "content": [{"text": "ok"}]}
    spec = [{"name": "fn", "description": "d", "inputSchema": {"json": {"type": "object"}}}]
    msgs = [
        {"role": "assistant", "content": [{"toolUse": tu}]},
        {"role": "user", "content": [{"toolResult": tr}]},
    ]
    req = m._format_openai_request(msgs, spec, None, {"tool": {"name": "fn"}})
    fn = req["messages"][0]["tool_calls"][0]["function"]
    assert fn == {"name": "fn", "arguments": json.dumps({"x": 1})}
    assert req["messages"][1] == {"role": "tool", "tool_call_id": "tu1", "content": "ok"}
    assert req["tool_choice"] == {"type": "function", "function": {"name": "fn"}}
    assert req["tools"][0]["function"]["parameters"] == {"type": "object"}


def test_format_anthropic_request_tool_result_success_omits_is_error(model):
    """``is_error`` marks failed tool results only."""
    tr = {"toolUseId": "tu1", "status": "success", "content": [{"text": "ok"}]}
    req = model._format_anthropic_request([{"role": "user", "content": [{"toolResult": tr}]}], None, None, None)
    block = req["messages"][0]["content"][0]
    assert "is_error" not in block
    assert block["content"] == [{"type": "text", "text": "ok"}]


def test_format_openai_request_omits_tool_choice_when_unset():
    """Tools are declared without forcing a selection when the caller passes no tool_choice."""
    spec = [{"name": "fn", "description": "d", "inputSchema": {"json": {"type": "object"}}}]
    m = BedrockInvokeModel(model_id=IMPORTED_ID)
    req = m._format_openai_request([{"role": "user", "content": [{"text": "hi"}]}], spec, None, None)
    assert "tool_choice" not in req
    assert req["tools"][0]["function"]["parameters"] == {"type": "object"}


@pytest.mark.parametrize(
    "family, tool_choice, expected",
    [
        ("anthropic", None, None),
        ("anthropic", {"auto": {}}, {"type": "auto"}),
        ("anthropic", {"any": {}}, {"type": "any"}),
        ("anthropic", {"tool": {"name": "fn"}}, {"type": "tool", "name": "fn"}),
        ("openai", None, None),
        ("openai", {"auto": {}}, "auto"),
        ("openai", {"any": {}}, "required"),
        ("openai", {"tool": {"name": "fn"}}, {"type": "function", "function": {"name": "fn"}}),
    ],
)
def test_to_tool_choice(family, tool_choice, expected):
    assert BedrockInvokeModel._to_tool_choice(tool_choice, family) == expected


# ---- sampling params


def test_format_anthropic_request_sampling_params(model):
    """The Anthropic body carries top_k and names the stop list ``stop_sequences``."""
    model.update_config(temperature=0.2, top_p=0.9, top_k=40, stop_sequences=["STOP"])
    req = model._format_anthropic_request([{"role": "user", "content": [{"text": "hi"}]}], None, None, None)
    assert req["temperature"] == 0.2
    assert req["top_p"] == 0.9
    assert req["top_k"] == 40
    assert req["stop_sequences"] == ["STOP"]


def test_format_openai_request_sampling_params():
    """The OpenAI body names the stop list ``stop`` and drops top_k, which the API does not accept."""
    m = BedrockInvokeModel(model_id=IMPORTED_ID, temperature=0.2, top_p=0.9, top_k=40, stop_sequences=["STOP"])
    req = m._format_openai_request([{"role": "user", "content": [{"text": "hi"}]}], None, None, None)
    assert req["temperature"] == 0.2
    assert req["top_p"] == 0.9
    assert req["stop"] == ["STOP"]
    assert "top_k" not in req
    assert "stop_sequences" not in req


# ---- params passthrough


def test_format_anthropic_request_merges_params(model):
    """``params`` carries Anthropic-only wire fields the typed config does not model."""
    model.update_config(params={"thinking": {"type": "enabled", "budget_tokens": 1024}, "anthropic_beta": ["beta-1"]})
    req = model._format_anthropic_request([{"role": "user", "content": [{"text": "hi"}]}], None, None, None)
    assert req["thinking"] == {"type": "enabled", "budget_tokens": 1024}
    assert req["anthropic_beta"] == ["beta-1"]


def test_format_openai_request_merges_params():
    m = BedrockInvokeModel(model_id=IMPORTED_ID, params={"logprobs": True})
    req = m._format_openai_request([{"role": "user", "content": [{"text": "hi"}]}], None, None, None)
    assert req["logprobs"] is True


@pytest.mark.parametrize("streaming", [True, False], ids=["streaming", "non_streaming"])
def test_format_openai_request_params_cannot_desync_stream_transport(streaming):
    """The wire flag must match the Bedrock API selected by ``streaming``, even when params conflicts."""
    m = BedrockInvokeModel(model_id=IMPORTED_ID, streaming=streaming, params={"stream": not streaming})

    req = m._format_openai_request([{"role": "user", "content": [{"text": "hi"}]}], None, None, None)

    assert req["stream"] is streaming
    assert ("stream_options" in req) is streaming


def test_format_request_params_override_computed_fields(model):
    """``params`` is splatted last, matching anthropic.py, so it wins over computed fields."""
    model.update_config(max_tokens=100, params={"max_tokens": 999})
    req = model._format_anthropic_request([{"role": "user", "content": [{"text": "hi"}]}], None, None, None)
    assert req["max_tokens"] == 999


# ---- unsupported content blocks


@pytest.mark.parametrize(
    "block",
    [
        {"document": {"format": "pdf", "name": "doc", "source": {"bytes": b"%PDF-"}}},
        {"video": {"format": "mp4", "source": {"bytes": b"\x00"}}},
        {"cachePoint": {"type": "default"}},
    ],
)
def test_format_anthropic_request_rejects_unsupported_block(model, block):
    """An unformattable block raises rather than silently vanishing from the request."""
    with pytest.raises(TypeError, match="unsupported type"):
        model._format_anthropic_request([{"role": "user", "content": [{"text": "hi"}, block]}], None, None, None)


@pytest.mark.parametrize(
    "block",
    [
        {"image": {"format": "png", "source": {"bytes": b"\x89PNG\r\n"}}},
        {"document": {"format": "pdf", "name": "doc", "source": {"bytes": b"%PDF-"}}},
        {"cachePoint": {"type": "default"}},
    ],
)
def test_format_openai_request_rejects_unsupported_block(block):
    m = BedrockInvokeModel(model_id=IMPORTED_ID)
    with pytest.raises(TypeError, match="unsupported type"):
        m._format_openai_request([{"role": "user", "content": [{"text": "hi"}, block]}], None, None, None)


def test_format_anthropic_request_all_unsupported_blocks_does_not_drop_message(model):
    """A message of only unsupported blocks raises instead of silently dropping the whole message."""
    msgs = [
        {"role": "user", "content": [{"text": "hi"}]},
        {"role": "assistant", "content": [{"cachePoint": {"type": "default"}}]},
    ]
    with pytest.raises(TypeError, match="unsupported type"):
        model._format_anthropic_request(msgs, None, None, None)


def test_format_openai_request_all_unsupported_blocks_does_not_drop_message():
    m = BedrockInvokeModel(model_id=IMPORTED_ID)
    msgs = [
        {"role": "user", "content": [{"text": "hi"}]},
        {"role": "user", "content": [{"image": {"format": "png", "source": {"bytes": b"\x89PNG\r\n"}}}]},
    ]
    with pytest.raises(TypeError, match="unsupported type"):
        m._format_openai_request(msgs, None, None, None)


@pytest.mark.parametrize("family", ["anthropic", "openai"])
@pytest.mark.parametrize(
    "result_content",
    [
        {"json": {"ok": True}},
        {"image": {"format": "png", "source": {"bytes": b"\x89PNG\r\n"}}},
        {"document": {"format": "pdf", "name": "doc", "source": {"bytes": b"%PDF-"}}},
    ],
)
def test_format_request_rejects_non_text_tool_result(model, family, result_content):
    """Both request families accept text-only tool-result content."""
    model.update_config(model_family=family)
    tool_result = {"toolUseId": "tu1", "status": "success", "content": [result_content]}
    messages = [{"role": "user", "content": [{"toolResult": tool_result}]}]

    exp_content_type = next(iter(result_content))
    with pytest.raises(TypeError, match=rf"content_type=<{exp_content_type}> \| unsupported type"):
        model._format_invoke_request(messages, None, None, None)


@pytest.mark.parametrize(
    "family, reason",
    [("anthropic", "refusal"), ("openai", "content_filter")],
)
def test_map_stop_reason_content_filtered(family, reason):
    mapper = BedrockInvokeModel._map_anthropic_stop if family == "anthropic" else BedrockInvokeModel._map_openai_stop

    tru_stop_reason = mapper(reason)
    exp_stop_reason = "content_filtered"
    assert tru_stop_reason == exp_stop_reason


# ---- unsupported inherited methods


def test_format_request_not_supported(model):
    """Converse-shaped request formatting is not what this provider sends."""
    with pytest.raises(NotImplementedError, match="format_request"):
        model.format_request([{"role": "user", "content": [{"text": "hi"}]}])


def test_convert_non_streaming_to_streaming_not_supported(model):
    """Converse-shaped response translation is not what this provider receives."""
    with pytest.raises(NotImplementedError, match="convert_non_streaming_to_streaming"):
        list(model.convert_non_streaming_to_streaming({"content": [{"type": "text", "text": "hi"}]}))


# ---- streaming


@pytest.mark.asyncio
async def test_stream_anthropic_text_only(bedrock_client):
    bedrock_client.invoke_model_with_response_stream.return_value = {
        "body": _chunks([
            {"type": "message_start", "message": {"usage": {"input_tokens": 5, "output_tokens": 0}}},
            {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
            {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hi"}},
            {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": " there"}},
            {"type": "content_block_stop", "index": 0},
            {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 3}},
            {"type": "message_stop"},
        ])
    }
    events = await _collect(BedrockInvokeModel(model_id=CLAUDE_ID), [{"role": "user", "content": [{"text": "hi"}]}])
    assert _texts(events) == "Hi there"
    assert _stop_reason(events) == "end_turn"
    assert _metadata(events)["usage"] == {"inputTokens": 5, "outputTokens": 3, "totalTokens": 8}


@pytest.mark.asyncio
async def test_stream_anthropic_reasoning(bedrock_client):
    bedrock_client.invoke_model_with_response_stream.return_value = {
        "body": _chunks([
            {"type": "message_start", "message": {"usage": {"input_tokens": 5, "output_tokens": 0}}},
            {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}},
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "thinking_delta", "thinking": "working"},
            },
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "signature_delta", "signature": "sig"},
            },
            {"type": "content_block_stop", "index": 0},
            {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 3}},
            {"type": "message_stop"},
        ])
    }

    events = await _collect(BedrockInvokeModel(model_id=CLAUDE_ID), [{"role": "user", "content": [{"text": "hi"}]}])

    assert _reasoning_deltas(events) == [{"text": "working"}, {"signature": "sig"}]


@pytest.mark.asyncio
async def test_stream_anthropic_reasoning_without_signature_round_trips(bedrock_client):
    bedrock_client.invoke_model_with_response_stream.return_value = {
        "body": _chunks([
            {"type": "message_start", "message": {"usage": {"input_tokens": 5, "output_tokens": 0}}},
            {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}},
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "thinking_delta", "thinking": "working"},
            },
            {"type": "content_block_stop", "index": 0},
            {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 3}},
            {"type": "message_stop"},
        ])
    }
    m = BedrockInvokeModel(model_id=CLAUDE_ID)

    processed = [
        event
        async for event in streaming.process_stream(m.stream([{"role": "user", "content": [{"text": "hi"}]}]))
    ]
    _, message, _, _ = processed[-1]["stop"]
    req = m._format_anthropic_request([message], None, None, None)

    assert req["messages"][0]["content"] == [{"type": "thinking", "thinking": "working"}]


@pytest.mark.asyncio
async def test_stream_anthropic_redacted_reasoning_round_trips(bedrock_client):
    data = base64.b64encode(b"redacted-bytes").decode("utf-8")
    bedrock_client.invoke_model_with_response_stream.return_value = {
        "body": _chunks([
            {"type": "message_start", "message": {"usage": {"input_tokens": 5, "output_tokens": 0}}},
            {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "redacted_thinking", "data": data},
            },
            {"type": "content_block_stop", "index": 0},
            {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 3}},
            {"type": "message_stop"},
        ])
    }
    m = BedrockInvokeModel(model_id=CLAUDE_ID)

    processed = [
        event
        async for event in streaming.process_stream(m.stream([{"role": "user", "content": [{"text": "hi"}]}]))
    ]
    _, message, _, _ = processed[-1]["stop"]
    req = m._format_anthropic_request([message], None, None, None)

    assert req["messages"][0]["content"] == [{"type": "redacted_thinking", "data": data}]


@pytest.mark.asyncio
async def test_stream_anthropic_reports_cache_usage(bedrock_client):
    bedrock_client.invoke_model_with_response_stream.return_value = {
        "body": _chunks([
            {
                "type": "message_start",
                "message": {
                    "usage": {
                        "input_tokens": 5,
                        "output_tokens": 0,
                        "cache_read_input_tokens": 100,
                        "cache_creation_input_tokens": 50,
                    }
                },
            },
            {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 3}},
            {"type": "message_stop"},
        ])
    }

    events = await _collect(BedrockInvokeModel(model_id=CLAUDE_ID), [{"role": "user", "content": [{"text": "hi"}]}])

    tru_usage = _metadata(events)["usage"]
    exp_usage = {
        "inputTokens": 5,
        "outputTokens": 3,
        "totalTokens": 8,
        "cacheReadInputTokens": 100,
        "cacheWriteInputTokens": 50,
    }
    assert tru_usage == exp_usage


@pytest.mark.asyncio
async def test_stream_anthropic_tool_use(bedrock_client):
    cb_start = {"type": "tool_use", "id": "tu1", "name": "weather", "input": {}}
    delta1 = {"type": "input_json_delta", "partial_json": '{"city":'}
    delta2 = {"type": "input_json_delta", "partial_json": '"Paris"}'}
    bedrock_client.invoke_model_with_response_stream.return_value = {
        "body": _chunks([
            {"type": "message_start", "message": {"usage": {"input_tokens": 7, "output_tokens": 0}}},
            {"type": "content_block_start", "index": 0, "content_block": cb_start},
            {"type": "content_block_delta", "index": 0, "delta": delta1},
            {"type": "content_block_delta", "index": 0, "delta": delta2},
            {"type": "content_block_stop", "index": 0},
            {"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 11}},
            {"type": "message_stop"},
        ])
    }
    events = await _collect(BedrockInvokeModel(model_id=CLAUDE_ID), [{"role": "user", "content": [{"text": "?"}]}])
    starts = [e["contentBlockStart"]["start"] for e in events if "contentBlockStart" in e]
    assert {"toolUse": {"toolUseId": "tu1", "name": "weather"}} in starts
    assert _tool_inputs(events) == '{"city":"Paris"}'
    assert _stop_reason(events) == "tool_use"


@pytest.mark.asyncio
async def test_stream_openai_text_and_tool(bedrock_client):
    tc1 = {"index": 0, "id": "call_abc", "function": {"name": "fn", "arguments": '{"x":'}}
    tc2 = {"index": 0, "function": {"arguments": "1}"}}
    bedrock_client.invoke_model_with_response_stream.return_value = {
        "body": _chunks([
            {"choices": [{"delta": {"content": "Hello"}, "finish_reason": None}]},
            {"choices": [{"delta": {"content": " world"}, "finish_reason": None}]},
            {"choices": [{"delta": {"tool_calls": [tc1]}, "finish_reason": None}]},
            {"choices": [{"delta": {"tool_calls": [tc2]}, "finish_reason": "tool_calls"}]},
            {"choices": [], "usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14}},
        ])
    }
    m = BedrockInvokeModel(model_id=IMPORTED_ID)
    events = await _collect(m, [{"role": "user", "content": [{"text": "go"}]}])
    assert _texts(events) == "Hello world"
    assert _tool_inputs(events) == '{"x":1}'
    assert _stop_reason(events) == "tool_use"
    assert _metadata(events)["usage"]["totalTokens"] == 14


@pytest.mark.asyncio
async def test_stream_openai_asks_for_usage_in_stream(bedrock_client):
    """OpenAI streaming withholds the usage chunk unless asked, which would leave the turn reporting no tokens."""
    bedrock_client.invoke_model_with_response_stream.return_value = {"body": _chunks([])}
    await _collect(BedrockInvokeModel(model_id=IMPORTED_ID), [{"role": "user", "content": [{"text": "hi"}]}])

    body = json.loads(bedrock_client.invoke_model_with_response_stream.call_args.kwargs["body"])
    assert body["stream_options"] == {"include_usage": True}


@pytest.mark.parametrize(
    "model_id, config", [(CLAUDE_ID, {}), (IMPORTED_ID, {"streaming": False})], ids=["anthropic", "non_streaming"]
)
def test_format_request_omits_stream_options(model_id, config):
    """``stream_options`` belongs to a streaming OpenAI Chat Completions request and nowhere else."""
    m = BedrockInvokeModel(model_id=model_id, **config)
    req = m._format_invoke_request([{"role": "user", "content": [{"text": "hi"}]}], None, None, None)
    assert "stream_options" not in req


@pytest.mark.asyncio
async def test_stream_openai_reports_metadata_without_usage_chunk(bedrock_client):
    """An endpoint that ignores ``stream_options`` still gets a metadata event, so latency is never lost."""
    bedrock_client.invoke_model_with_response_stream.return_value = {
        "body": _chunks([{"choices": [{"delta": {"content": "hi"}, "finish_reason": "stop"}]}])
    }
    events = await _collect(BedrockInvokeModel(model_id=IMPORTED_ID), [{"role": "user", "content": [{"text": "x"}]}])

    tru_usage = _metadata(events)["usage"]
    exp_usage = {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0}
    assert tru_usage == exp_usage


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "first_delta",
    [
        {"index": 0, "id": "call_0"},
        {"index": 0, "id": "call_0", "function": {}},
        {"index": 0, "id": "call_0", "function": {"arguments": '{"city":'}},
    ],
    ids=["id_only", "empty_function", "arguments_before_name"],
)
async def test_stream_openai_tool_call_name_after_id(bedrock_client, first_delta):
    """A tool call whose name trails its id still opens a named block, since the consumer cannot fill it in later."""
    tail = '"Paris"}' if "arguments" in first_delta.get("function", {}) else '{"city":"Paris"}'
    bedrock_client.invoke_model_with_response_stream.return_value = {
        "body": _chunks([
            {"choices": [{"delta": {"tool_calls": [first_delta]}, "finish_reason": None}]},
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"name": "weather"}}]}}]},
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": tail}}]}}]},
            {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]},
        ])
    }
    events = await _collect(BedrockInvokeModel(model_id=IMPORTED_ID), [{"role": "user", "content": [{"text": "?"}]}])

    tru_blocks = _tool_use_blocks(events)
    exp_blocks = [({"toolUseId": "call_0", "name": "weather"}, '{"city":"Paris"}')]
    assert tru_blocks == exp_blocks


@pytest.mark.asyncio
async def test_stream_openai_drops_tool_call_that_never_names_itself(bedrock_client, caplog):
    """A nameless tool call cannot be executed, so it is reported rather than emitted as an empty block."""
    caplog.set_level(logging.WARNING, logger="strands.models.bedrock_invoke")
    bedrock_client.invoke_model_with_response_stream.return_value = {
        "body": _chunks([
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_0"}]}, "finish_reason": "tool_calls"}]}
        ])
    }
    events = await _collect(BedrockInvokeModel(model_id=IMPORTED_ID), [{"role": "user", "content": [{"text": "?"}]}])

    assert _tool_use_blocks(events) == []
    assert "dropping a tool call that never carried a name" in caplog.text


@pytest.mark.asyncio
async def test_stream_openai_parallel_tool_calls_stay_separate_blocks(bedrock_client):
    """Each parallel tool call gets its own start/stop pair, since the consumer keeps only the newest open block."""
    tc0_start = {"index": 0, "id": "call_0", "function": {"name": "weather", "arguments": '{"city":'}}
    tc0_args = {"index": 0, "function": {"arguments": '"Paris"}'}}
    tc1_start = {"index": 1, "id": "call_1", "function": {"name": "time", "arguments": '{"tz":'}}
    tc1_args = {"index": 1, "function": {"arguments": '"UTC"}'}}
    bedrock_client.invoke_model_with_response_stream.return_value = {
        "body": _chunks([
            {"choices": [{"delta": {"tool_calls": [tc0_start]}, "finish_reason": None}]},
            {"choices": [{"delta": {"tool_calls": [tc0_args]}, "finish_reason": None}]},
            {"choices": [{"delta": {"tool_calls": [tc1_start]}, "finish_reason": None}]},
            {"choices": [{"delta": {"tool_calls": [tc1_args]}, "finish_reason": "tool_calls"}]},
            {"choices": [], "usage": {"prompt_tokens": 9, "completion_tokens": 8, "total_tokens": 17}},
        ])
    }
    m = BedrockInvokeModel(model_id=IMPORTED_ID)
    events = await _collect(m, [{"role": "user", "content": [{"text": "go"}]}])

    tru_blocks = _tool_use_blocks(events)
    exp_blocks = [
        ({"toolUseId": "call_0", "name": "weather"}, '{"city":"Paris"}'),
        ({"toolUseId": "call_1", "name": "time"}, '{"tz":"UTC"}'),
    ]
    assert tru_blocks == exp_blocks
    assert _stop_reason(events) == "tool_use"


@pytest.mark.asyncio
async def test_stream_openai_content_blocks_are_delimited(bedrock_client):
    """Every block is closed before the next opens, in both the text->tool and tool->text directions."""
    tc0 = {"index": 0, "id": "call_0", "function": {"name": "a", "arguments": "{}"}}
    tc1 = {"index": 1, "id": "call_1", "function": {"name": "b", "arguments": "{}"}}
    bedrock_client.invoke_model_with_response_stream.return_value = {
        "body": _chunks([
            {"choices": [{"delta": {"content": "thinking"}, "finish_reason": None}]},
            {"choices": [{"delta": {"tool_calls": [tc0]}, "finish_reason": None}]},
            {"choices": [{"delta": {"tool_calls": [tc1]}, "finish_reason": None}]},
            {"choices": [{"delta": {"content": " done"}, "finish_reason": "tool_calls"}]},
        ])
    }
    m = BedrockInvokeModel(model_id=IMPORTED_ID)
    events = await _collect(m, [{"role": "user", "content": [{"text": "go"}]}])

    open_blocks = 0
    for event in events:
        if "contentBlockStart" in event:
            open_blocks += 1
        elif "contentBlockStop" in event:
            open_blocks -= 1
        assert 0 <= open_blocks <= 1
    assert open_blocks == 0
    assert _texts(events) == "thinking done"
    assert [start["name"] for start, _ in _tool_use_blocks(events)] == ["a", "b"]


@pytest.mark.asyncio
async def test_stream_anthropic_closes_unterminated_block(bedrock_client):
    """A stream that ends without content_block_stop still closes the block, leaving nothing dangling."""
    bedrock_client.invoke_model_with_response_stream.return_value = {
        "body": _chunks([
            {"type": "message_start", "message": {"usage": {"input_tokens": 3, "output_tokens": 0}}},
            {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
            {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "partial"}},
            {"type": "message_stop"},
        ])
    }
    events = await _collect(BedrockInvokeModel(model_id=CLAUDE_ID), [{"role": "user", "content": [{"text": "hi"}]}])

    tru_delimiters = (sum("contentBlockStart" in e for e in events), sum("contentBlockStop" in e for e in events))
    assert tru_delimiters == (1, 1)
    assert _texts(events) == "partial"
    assert _stop_reason(events) == "end_turn"


@pytest.mark.asyncio
async def test_stream_openai_interleaved_parallel_tool_calls_preserve_arguments(bedrock_client):
    """Arguments arriving after another parallel call starts still belong to their original tool call."""
    open_0 = {"index": 0, "id": "call_0", "function": {"name": "a"}}
    open_1 = {"index": 1, "id": "call_1", "function": {"name": "b", "arguments": '{"y":2}'}}
    late_0 = {"index": 0, "function": {"arguments": '{"x":1}'}}
    bedrock_client.invoke_model_with_response_stream.return_value = {
        "body": _chunks([
            {"choices": [{"delta": {"tool_calls": [open_0]}, "finish_reason": None}]},
            {"choices": [{"delta": {"tool_calls": [open_1]}, "finish_reason": None}]},
            {"choices": [{"delta": {"tool_calls": [late_0]}, "finish_reason": "tool_calls"}]},
        ])
    }
    m = BedrockInvokeModel(model_id=IMPORTED_ID)
    events = await _collect(m, [{"role": "user", "content": [{"text": "go"}]}])

    tru_blocks = _tool_use_blocks(events)
    exp_blocks = [
        ({"toolUseId": "call_0", "name": "a"}, '{"x":1}'),
        ({"toolUseId": "call_1", "name": "b"}, '{"y":2}'),
    ]
    assert tru_blocks == exp_blocks


@pytest.mark.asyncio
async def test_stream_openai_tool_call_arguments_survive_interleaved_text(bedrock_client):
    """A text delta cannot finalize a tool call because later chunks may still carry its arguments."""
    start = {"index": 0, "id": "call_0", "function": {"name": "a", "arguments": '{"x":'}}
    tail = {"index": 0, "function": {"arguments": "1}"}}
    bedrock_client.invoke_model_with_response_stream.return_value = {
        "body": _chunks([
            {"choices": [{"delta": {"tool_calls": [start]}, "finish_reason": None}]},
            {"choices": [{"delta": {"content": "interlude"}, "finish_reason": None}]},
            {"choices": [{"delta": {"tool_calls": [tail]}, "finish_reason": "tool_calls"}]},
        ])
    }

    events = await _collect(BedrockInvokeModel(model_id=IMPORTED_ID), [{"role": "user", "content": [{"text": "go"}]}])

    assert _texts(events) == "interlude"
    assert _tool_use_blocks(events) == [({"toolUseId": "call_0", "name": "a"}, '{"x":1}')]


@pytest.mark.asyncio
async def test_stream_system_prompt_reaches_request_body(bedrock_client):
    """A plain ``system_prompt`` string is promoted to a system content block and lands on the wire."""
    bedrock_client.invoke_model_with_response_stream.return_value = {"body": _chunks([{"type": "message_stop"}])}
    m = BedrockInvokeModel(model_id=CLAUDE_ID)
    await _collect(m, [{"role": "user", "content": [{"text": "hi"}]}], system_prompt="be nice")

    body = json.loads(bedrock_client.invoke_model_with_response_stream.call_args.kwargs["body"])
    assert body["system"] == "be nice"


@pytest.mark.asyncio
async def test_stream_non_streaming_anthropic(bedrock_client):
    body = unittest.mock.Mock()
    body.read.return_value = json.dumps({
        "content": [{"type": "text", "text": "ack"}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 1, "output_tokens": 1},
    }).encode("utf-8")
    bedrock_client.invoke_model.return_value = {"body": body}

    m = BedrockInvokeModel(model_id=CLAUDE_ID, streaming=False)
    events = await _collect(m, [{"role": "user", "content": [{"text": "hi"}]}])
    assert _texts(events) == "ack"


@pytest.mark.asyncio
async def test_stream_non_streaming_anthropic_tool_use(bedrock_client):
    body = unittest.mock.Mock()
    body.read.return_value = json.dumps({
        "content": [
            {"type": "text", "text": "checking"},
            {"type": "tool_use", "id": "tu1", "name": "weather", "input": {"city": "Paris"}},
        ],
        "stop_reason": "tool_use",
        "usage": {"input_tokens": 4, "output_tokens": 6},
    }).encode("utf-8")
    bedrock_client.invoke_model.return_value = {"body": body}

    m = BedrockInvokeModel(model_id=CLAUDE_ID, streaming=False)
    events = await _collect(m, [{"role": "user", "content": [{"text": "?"}]}])
    assert _texts(events) == "checking"
    assert _tool_use_blocks(events) == [({"toolUseId": "tu1", "name": "weather"}, json.dumps({"city": "Paris"}))]
    assert _stop_reason(events) == "tool_use"
    assert _metadata(events)["usage"] == {"inputTokens": 4, "outputTokens": 6, "totalTokens": 10}


@pytest.mark.asyncio
async def test_stream_non_streaming_anthropic_reasoning(bedrock_client):
    body = unittest.mock.Mock()
    body.read.return_value = json.dumps({
        "content": [{"type": "thinking", "thinking": "working", "signature": "sig"}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 4, "output_tokens": 6},
    }).encode("utf-8")
    bedrock_client.invoke_model.return_value = {"body": body}

    events = await _collect(
        BedrockInvokeModel(model_id=CLAUDE_ID, streaming=False),
        [{"role": "user", "content": [{"text": "?"}]}],
    )

    assert _reasoning_deltas(events) == [{"text": "working"}, {"signature": "sig"}]


@pytest.mark.asyncio
async def test_stream_non_streaming_anthropic_redacted_reasoning(bedrock_client):
    data = base64.b64encode(b"redacted-bytes").decode("utf-8")
    body = unittest.mock.Mock()
    body.read.return_value = json.dumps({
        "content": [{"type": "redacted_thinking", "data": data}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 4, "output_tokens": 6},
    }).encode("utf-8")
    bedrock_client.invoke_model.return_value = {"body": body}

    events = await _collect(
        BedrockInvokeModel(model_id=CLAUDE_ID, streaming=False),
        [{"role": "user", "content": [{"text": "?"}]}],
    )

    assert _reasoning_deltas(events) == [{"redactedContent": b"redacted-bytes"}]


@pytest.mark.asyncio
async def test_stream_non_streaming_anthropic_reports_cache_usage(bedrock_client):
    body = unittest.mock.Mock()
    body.read.return_value = json.dumps({
        "content": [{"type": "text", "text": "ack"}],
        "stop_reason": "end_turn",
        "usage": {
            "input_tokens": 4,
            "output_tokens": 6,
            "cache_read_input_tokens": 100,
            "cache_creation_input_tokens": 50,
        },
    }).encode("utf-8")
    bedrock_client.invoke_model.return_value = {"body": body}

    events = await _collect(
        BedrockInvokeModel(model_id=CLAUDE_ID, streaming=False),
        [{"role": "user", "content": [{"text": "?"}]}],
    )

    tru_usage = _metadata(events)["usage"]
    exp_usage = {
        "inputTokens": 4,
        "outputTokens": 6,
        "totalTokens": 10,
        "cacheReadInputTokens": 100,
        "cacheWriteInputTokens": 50,
    }
    assert tru_usage == exp_usage


@pytest.mark.asyncio
async def test_stream_non_streaming_openai_text_and_tool(bedrock_client):
    body = unittest.mock.Mock()
    body.read.return_value = json.dumps({
        "choices": [{
            "message": {
                "content": "hi there",
                "tool_calls": [{"id": "call_1", "function": {"name": "fn", "arguments": '{"x":1}'}}],
            },
            "finish_reason": "tool_calls",
        }],
        "usage": {"prompt_tokens": 6, "completion_tokens": 2, "total_tokens": 8},
    }).encode("utf-8")
    bedrock_client.invoke_model.return_value = {"body": body}

    m = BedrockInvokeModel(model_id=IMPORTED_ID, streaming=False)
    events = await _collect(m, [{"role": "user", "content": [{"text": "hi"}]}])
    assert _texts(events) == "hi there"
    assert _tool_inputs(events) == '{"x":1}'
    assert _stop_reason(events) == "tool_use"


# ---- latency metrics


@pytest.mark.asyncio
async def test_stream_reports_measured_latency(bedrock_client):
    """Latency is measured around the boto3 call so telemetry sees a real number."""

    def slow_invoke(**kwargs):
        time.sleep(0.02)
        return {
            "body": _chunks([
                {"type": "message_start", "message": {"usage": {"input_tokens": 5, "output_tokens": 0}}},
                {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 3}},
                {"type": "message_stop"},
            ])
        }

    bedrock_client.invoke_model_with_response_stream.side_effect = slow_invoke

    events = await _collect(BedrockInvokeModel(model_id=CLAUDE_ID), [{"role": "user", "content": [{"text": "hi"}]}])
    assert _metadata(events)["metrics"]["latencyMs"] > 0


@pytest.mark.asyncio
async def test_stream_openai_reports_measured_latency(bedrock_client):
    def slow_invoke(**kwargs):
        time.sleep(0.02)
        return {
            "body": _chunks([
                {"choices": [{"delta": {"content": "hi"}, "finish_reason": "stop"}]},
                {"choices": [], "usage": {"prompt_tokens": 2, "completion_tokens": 1, "total_tokens": 3}},
            ])
        }

    bedrock_client.invoke_model_with_response_stream.side_effect = slow_invoke

    m = BedrockInvokeModel(model_id=IMPORTED_ID)
    events = await _collect(m, [{"role": "user", "content": [{"text": "hi"}]}])
    assert _metadata(events)["metrics"]["latencyMs"] > 0


@pytest.mark.asyncio
async def test_stream_non_streaming_anthropic_reports_measured_latency(bedrock_client):
    body = unittest.mock.Mock()
    body.read.return_value = json.dumps({
        "content": [{"type": "text", "text": "ack"}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 1, "output_tokens": 1},
    }).encode("utf-8")

    def slow_invoke(**kwargs):
        time.sleep(0.02)
        return {"body": body}

    bedrock_client.invoke_model.side_effect = slow_invoke

    m = BedrockInvokeModel(model_id=CLAUDE_ID, streaming=False)
    events = await _collect(m, [{"role": "user", "content": [{"text": "hi"}]}])
    assert _metadata(events)["metrics"]["latencyMs"] > 0


@pytest.mark.asyncio
async def test_stream_non_streaming_openai_reports_measured_latency(bedrock_client):
    body = unittest.mock.Mock()
    body.read.return_value = json.dumps({
        "choices": [{"message": {"content": "hi"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 6, "completion_tokens": 2, "total_tokens": 8},
    }).encode("utf-8")

    def slow_invoke(**kwargs):
        time.sleep(0.02)
        return {"body": body}

    bedrock_client.invoke_model.side_effect = slow_invoke

    m = BedrockInvokeModel(model_id=IMPORTED_ID, streaming=False)
    events = await _collect(m, [{"role": "user", "content": [{"text": "hi"}]}])
    assert _metadata(events)["metrics"]["latencyMs"] > 0


# ---- errors


@pytest.mark.asyncio
async def test_stream_throttling_raises(bedrock_client):
    bedrock_client.invoke_model_with_response_stream.side_effect = ClientError(
        {"Error": {"Code": "ThrottlingException", "Message": "slow down"}},
        "InvokeModelWithResponseStream",
    )
    with pytest.raises(ModelThrottledException):
        await _collect(BedrockInvokeModel(model_id=CLAUDE_ID), [{"role": "user", "content": [{"text": "x"}]}])


@pytest.mark.asyncio
async def test_stream_context_window_overflow(bedrock_client):
    bedrock_client.invoke_model_with_response_stream.side_effect = ClientError(
        {"Error": {"Code": "ValidationException", "Message": "Input is too long for requested model"}},
        "InvokeModelWithResponseStream",
    )
    with pytest.raises(ContextWindowOverflowException):
        await _collect(BedrockInvokeModel(model_id=CLAUDE_ID), [{"role": "user", "content": [{"text": "x"}]}])


@pytest.mark.skipif(sys.version_info < (3, 11), reason="This test requires Python 3.11 or higher (need add_note)")
@pytest.mark.asyncio
async def test_stream_access_denied_adds_note(bedrock_client):
    bedrock_client.invoke_model_with_response_stream.side_effect = ClientError(
        {"Error": {"Code": "AccessDeniedException", "Message": "You don't have access to the model"}},
        "InvokeModelWithResponseStream",
    )
    with pytest.raises(ClientError) as err:
        await _collect(BedrockInvokeModel(model_id=CLAUDE_ID), [{"role": "user", "content": [{"text": "x"}]}])
    notes = getattr(err.value, "__notes__", [])
    assert any("required-iam-permissions" in note for note in notes)
    assert any(f"Model id: {CLAUDE_ID}" in note for note in notes)


@pytest.mark.asyncio
async def test_stream_access_denied_adds_note_without_add_notes(bedrock_client):
    """When add_note is not available, the note text is still included in the error output."""
    with unittest.mock.patch.object(_exception_notes, "supports_add_note", False):
        bedrock_client.invoke_model_with_response_stream.side_effect = ClientError(
            {"Error": {"Code": "AccessDeniedException", "Message": "You don't have access to the model"}},
            "InvokeModelWithResponseStream",
        )
        with pytest.raises(ClientError) as err:
            await _collect(BedrockInvokeModel(model_id=CLAUDE_ID), [{"role": "user", "content": [{"text": "x"}]}])

    error_str = "".join(traceback.format_exception(err.value))
    assert "required-iam-permissions" in error_str
    assert f"└ Model id: {CLAUDE_ID}" in error_str


@pytest.mark.skipif(sys.version_info < (3, 11), reason="This test requires Python 3.11 or higher (need add_note)")
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "config, expected_family",
    [({}, "openai (auto-detected from the model id)"), ({"model_family": "anthropic"}, "anthropic (explicitly")],
    ids=["auto_detected", "explicit"],
)
async def test_stream_client_error_names_request_body_family(bedrock_client, config, expected_family):
    """A rejected body usually means the dialect was guessed wrong, which the raw Bedrock error never says."""
    bedrock_client.invoke_model_with_response_stream.side_effect = ClientError(
        {"Error": {"Code": "ValidationException", "Message": "anthropic_version: Field required"}},
        "InvokeModelWithResponseStream",
    )
    m = BedrockInvokeModel(model_id=IMPORTED_ID, **config)
    with pytest.raises(ClientError) as err:
        await _collect(m, [{"role": "user", "content": [{"text": "x"}]}])

    notes = getattr(err.value, "__notes__", [])
    assert any(f"Request body family: {expected_family}" in note for note in notes)
    assert any('Override it with model_family="anthropic"' in note for note in notes)


# ---- cancellation


def _slow_then_raise(bedrock_client):
    """Make the streaming InvokeModel call block, then fail, mimicking a hung boto3 call."""

    def slow_invoke(**kwargs):
        time.sleep(0.1)
        raise RuntimeError("simulated boto3 timeout")

    bedrock_client.invoke_model_with_response_stream.side_effect = slow_invoke


class _FakeEventStream:
    """Stand-in for botocore's ``EventStream``: iterable, closable, one chunk per gate release."""

    def __init__(self, chunks, gate):
        self.chunks = list(chunks)
        self.gate = gate
        self.emitted = []
        self.closed = False

    def __iter__(self):
        for chunk in self.chunks:
            self.gate.wait()
            self.gate.clear()
            self.emitted.append(chunk)
            yield chunk

    def close(self):
        self.closed = True


async def _wait_until(predicate, timeout=5.0):
    deadline = time.time() + timeout
    while not predicate():
        assert time.time() < deadline, "condition was not met before the timeout"
        await asyncio.sleep(0.01)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "model_id, payload",
    [
        (CLAUDE_ID, {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "late"}}),
        (IMPORTED_ID, {"choices": [{"delta": {"content": "late"}, "finish_reason": None}]}),
    ],
    ids=["anthropic", "openai"],
)
async def test_stream_cancel_signal_stops_reading_at_next_chunk(bedrock_client, model_id, payload):
    """A cancelled run stops reading and closes the response rather than streaming — and billing — to the end."""
    gate = threading.Event()
    event_stream = _FakeEventStream(_chunks([payload] * 5), gate)
    bedrock_client.invoke_model_with_response_stream.return_value = {"body": event_stream}
    cancel_signal = threading.Event()

    m = BedrockInvokeModel(model_id=model_id)
    events = []
    async for event in m.stream([{"role": "user", "content": [{"text": "x"}]}], cancel_signal=cancel_signal):
        events.append(event)
        cancel_signal.set()
        gate.set()

    await _wait_until(lambda: event_stream.closed)

    assert events == [{"messageStart": {"role": "assistant"}}]
    # The chunk read at the cancellation boundary is dropped; the rest is never read.
    assert len(event_stream.emitted) == 1


@pytest.mark.asyncio
async def test_stream_cancellation_consumes_orphaned_task_exception(bedrock_client):
    """Orphaned background task exception is consumed when stream generator is cancelled."""
    _slow_then_raise(bedrock_client)

    loop = asyncio.get_running_loop()
    captured: list[dict] = []
    loop.set_exception_handler(lambda _loop, ctx: captured.append(ctx))

    gen = BedrockInvokeModel(model_id=CLAUDE_ID).stream([{"role": "user", "content": [{"text": "x"}]}])
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(gen.__anext__(), timeout=0.01)

    await gen.aclose()

    # Allow the background thread to finish and the done-callback to fire
    await asyncio.sleep(0.2)

    assert not captured, f"orphaned task exception was not consumed: {captured}"


@pytest.mark.asyncio
async def test_stream_cancellation_does_not_block_on_background_call(bedrock_client):
    """Cancelling the generator returns promptly instead of waiting for the blocking boto3 call."""
    _slow_then_raise(bedrock_client)

    gen = BedrockInvokeModel(model_id=CLAUDE_ID).stream([{"role": "user", "content": [{"text": "x"}]}])
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(gen.__anext__(), timeout=0.01)

    # The background thread still sleeps for ~0.1s; closing must not wait for it.
    await asyncio.wait_for(gen.aclose(), timeout=0.05)

    # Consume the orphaned task's exception so it doesn't leak into other tests.
    await asyncio.sleep(0.2)


@pytest.mark.asyncio
async def test_stream_generator_close_stops_event_stream_without_cancel_signal(bedrock_client):
    """Closing the consumer-owned generator also stops and closes the worker-owned Bedrock stream."""
    gate = threading.Event()
    payload = {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "late"}}
    event_stream = _FakeEventStream(_chunks([payload]), gate)
    bedrock_client.invoke_model_with_response_stream.return_value = {"body": event_stream}

    gen = BedrockInvokeModel(model_id=CLAUDE_ID).stream([{"role": "user", "content": [{"text": "x"}]}])
    assert await gen.__anext__() == {"messageStart": {"role": "assistant"}}

    await gen.aclose()
    gate.set()
    await _wait_until(lambda: bool(event_stream.emitted))

    assert event_stream.closed


@pytest.mark.asyncio
async def test_stream_generator_close_does_not_set_caller_cancel_signal(bedrock_client):
    """Generator ownership cancellation stays private when the caller reuses its signal elsewhere."""
    gate = threading.Event()
    payload = {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "late"}}
    event_stream = _FakeEventStream(_chunks([payload]), gate)
    bedrock_client.invoke_model_with_response_stream.return_value = {"body": event_stream}
    cancel_signal = threading.Event()

    gen = BedrockInvokeModel(model_id=CLAUDE_ID).stream(
        [{"role": "user", "content": [{"text": "x"}]}],
        cancel_signal=cancel_signal,
    )
    assert await gen.__anext__() == {"messageStart": {"role": "assistant"}}

    await gen.aclose()
    gate.set()
    await _wait_until(lambda: bool(event_stream.emitted))

    assert event_stream.closed
    assert not cancel_signal.is_set()


# ---- structured output


@pytest.mark.asyncio
async def test_structured_output_yields_pydantic_model(bedrock_client):
    cb_start = {"type": "tool_use", "id": "tu1", "name": "Person", "input": {}}
    delta = {"type": "input_json_delta", "partial_json": '{"name":"Ada","age":36}'}
    bedrock_client.invoke_model_with_response_stream.return_value = {
        "body": _chunks([
            {"type": "message_start", "message": {"usage": {"input_tokens": 4, "output_tokens": 0}}},
            {"type": "content_block_start", "index": 0, "content_block": cb_start},
            {"type": "content_block_delta", "index": 0, "delta": delta},
            {"type": "content_block_stop", "index": 0},
            {"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 9}},
            {"type": "message_stop"},
        ])
    }

    class Person(pydantic.BaseModel):
        name: str
        age: int

    m = BedrockInvokeModel(model_id=CLAUDE_ID)
    structured: list[dict] = []
    async for event in m.structured_output(Person, [{"role": "user", "content": [{"text": "?"}]}]):
        structured.append(event)
    assert structured[-1]["output"] == Person(name="Ada", age=36)


@pytest.mark.asyncio
async def test_structured_output_raises_when_model_answers_with_text(bedrock_client):
    """A turn that ends without the forced tool call cannot produce the output model."""
    bedrock_client.invoke_model_with_response_stream.return_value = {
        "body": _chunks([
            {"type": "message_start", "message": {"usage": {"input_tokens": 4, "output_tokens": 0}}},
            {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
            {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "no thanks"}},
            {"type": "content_block_stop", "index": 0},
            {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 2}},
            {"type": "message_stop"},
        ])
    }

    class Person(pydantic.BaseModel):
        name: str

    m = BedrockInvokeModel(model_id=CLAUDE_ID)
    with pytest.raises(ValueError, match='instead of "tool_use"'):
        async for event in m.structured_output(Person, [{"role": "user", "content": [{"text": "?"}]}]):
            assert "output" not in event
