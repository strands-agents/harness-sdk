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
from collections.abc import AsyncIterable, Awaitable, Callable
from copy import deepcopy

import pydantic
import pytest
from botocore.exceptions import ClientError, EventStreamError

import strands
from strands import _exception_notes, tool
from strands.event_loop import streaming
from strands.models.bedrock import DEFAULT_BEDROCK_MODEL_ID, BedrockModel
from strands.models.bedrock_invoke import BedrockInvokeModel
from strands.models.model import CacheConfig, CacheToolsConfig, Model
from strands.types.exceptions import ContextWindowOverflowException, ModelThrottledException
from strands.types.streaming import StreamEvent

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
    body = unittest.mock.MagicMock()
    body.__iter__.return_value = iter([{"chunk": {"bytes": json.dumps(p).encode("utf-8")}} for p in payloads])
    return body


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


@pytest.mark.parametrize("update", [False, True], ids=["init", "update"])
def test_config_validation_warns_on_converse_only_key(update: bool) -> None:
    model = BedrockInvokeModel(model_id=CLAUDE_ID)
    with pytest.warns(UserWarning, match=r"Invalid configuration parameters: \['guardrail_id'\]"):
        if update:
            model.update_config(guardrail_id="guardrail")
        else:
            BedrockInvokeModel(model_id=CLAUDE_ID, guardrail_id="guardrail")


def test_init_creates_client_before_validation_and_default_model(session_cls: unittest.mock.Mock) -> None:
    calls = unittest.mock.Mock()
    calls.attach_mock(session_cls.return_value.client, "client")
    with (
        unittest.mock.patch(
            "strands.models.bedrock_invoke.validate_config_keys",
            wraps=strands.models.bedrock_invoke.validate_config_keys,
        ) as validate_config,
        unittest.mock.patch.object(
            BedrockInvokeModel,
            "_get_default_model_with_warning",
            wraps=BedrockInvokeModel._get_default_model_with_warning,
        ) as default_model,
    ):
        calls.attach_mock(validate_config, "validate_config")
        calls.attach_mock(default_model, "default_model")
        BedrockInvokeModel()

    tru_calls = calls.mock_calls
    exp_calls = [
        unittest.mock.call.client(
            service_name="bedrock-runtime",
            config=unittest.mock.ANY,
            endpoint_url=None,
            region_name=unittest.mock.ANY,
        ),
        unittest.mock.call.validate_config({}, BedrockInvokeModel.BedrockInvokeConfig),
        unittest.mock.call.default_model(unittest.mock.ANY, {}),
    ]
    assert tru_calls == exp_calls


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
        ("claude-sonnet-4-6", "anthropic"),
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


@pytest.mark.parametrize(
    "tool_choice, params_choice, forces_tool",
    [
        ({"any": {}}, None, True),
        ({"tool": {"name": "string_length"}}, None, True),
        ({"auto": {}}, None, False),
        (None, None, False),
        ({"auto": {}}, {"type": "any"}, True),
        ({"any": {}}, {"type": "auto"}, False),
    ],
)
def test_format_anthropic_request_thinking_respects_effective_tool_choice(
    model: BedrockInvokeModel, tool_choice: dict | None, params_choice: dict | None, forces_tool: bool
) -> None:
    params = {"thinking": {"type": "enabled", "budget_tokens": 1024}, "anthropic_beta": ["test-beta"]}
    if params_choice is not None:
        params["tool_choice"] = params_choice
    model.update_config(params=params)

    request = model._format_anthropic_request(
        [{"role": "user", "content": [{"text": "measure abc"}]}], [string_length.tool_spec], None, tool_choice
    )

    assert ("thinking" in request) is not forces_tool
    assert request["anthropic_beta"] == ["test-beta"]
    assert model.get_config()["params"] == params
    assert "thinking" in params


@pytest.mark.parametrize(
    "family, block, cache_config",
    [
        ("openai", {"cachePoint": {"type": "default"}}, None),
        ("openai", {"guardContent": {"text": {"text": "guard"}}}, None),
        ("anthropic", {"guardContent": {"text": {"text": "guard"}}}, None),
        ("anthropic", {"guardContent": {"text": {"text": "guard"}}}, CacheConfig(strategy="anthropic")),
    ],
)
@pytest.mark.asyncio
async def test_stream_rejects_unsupported_system_blocks(
    model: BedrockInvokeModel,
    bedrock_client: unittest.mock.Mock,
    family: str,
    block: dict,
    cache_config: CacheConfig | None,
    alist: Callable[[AsyncIterable[StreamEvent]], Awaitable[list[StreamEvent]]],
) -> None:
    model.update_config(model_family=family, cache_config=cache_config)
    with pytest.raises(TypeError, match=f"content_type=<{next(iter(block))}>"):
        await alist(
            model.stream(
                [{"role": "user", "content": [{"text": "hello"}]}],
                system_prompt_content=[{"text": "system instructions"}, block],
            )
        )
    bedrock_client.invoke_model.assert_not_called()
    bedrock_client.invoke_model_with_response_stream.assert_not_called()


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


@pytest.mark.parametrize("family", ["anthropic", "openai"])
@pytest.mark.parametrize("text_position", [0, 1, 2])
def test_format_request_tool_results_precede_user_text(family: str, text_position: int) -> None:
    model = BedrockInvokeModel(model_id=IMPORTED_ID, model_family=family)
    results = [
        {"toolResult": {"toolUseId": tool_id, "status": "success", "content": [{"text": tool_id}]}}
        for tool_id in ("tu1", "tu2")
    ]
    text = [{"text": "Now explain the results."}]
    messages = [
        {
            "role": "assistant",
            "content": [{"toolUse": {"toolUseId": tool_id, "name": "fn", "input": {}}} for tool_id in ("tu1", "tu2")],
        },
        {"role": "user", "content": results[:text_position] + text + results[text_position:]},
    ]

    tru_messages = model._format_invoke_request(messages, None, None, None)["messages"]
    exp_messages = [
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {"id": tool_id, "type": "function", "function": {"name": "fn", "arguments": "{}"}}
                for tool_id in ("tu1", "tu2")
            ],
        },
        {"role": "tool", "tool_call_id": "tu1", "content": "tu1"},
        {"role": "tool", "tool_call_id": "tu2", "content": "tu2"},
        {"role": "user", "content": "Now explain the results."},
    ]
    if family == "anthropic":
        exp_messages = [
            {
                "role": "assistant",
                "content": [
                    {"type": "tool_use", "id": tool_id, "name": "fn", "input": {}} for tool_id in ("tu1", "tu2")
                ],
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": tool_id,
                        "content": [{"type": "text", "text": tool_id}],
                    }
                    for tool_id in ("tu1", "tu2")
                ]
                + [{"type": "text", "text": "Now explain the results."}],
            },
        ]
    assert tru_messages == exp_messages


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
        {"reasoningContent": {}},
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
        {"role": "assistant", "content": [{"video": {"format": "mp4", "source": {"bytes": b"video"}}}]},
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
        "body": _chunks(
            [
                {"type": "message_start", "message": {"usage": {"input_tokens": 5, "output_tokens": 0}}},
                {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
                {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hi"}},
                {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": " there"}},
                {"type": "content_block_stop", "index": 0},
                {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 3}},
                {"type": "message_stop"},
            ]
        )
    }
    events = await _collect(BedrockInvokeModel(model_id=CLAUDE_ID), [{"role": "user", "content": [{"text": "hi"}]}])
    assert _texts(events) == "Hi there"
    assert _stop_reason(events) == "end_turn"
    assert _metadata(events)["usage"] == {"inputTokens": 5, "outputTokens": 3, "totalTokens": 8}


@pytest.mark.asyncio
async def test_stream_anthropic_reasoning(bedrock_client):
    bedrock_client.invoke_model_with_response_stream.return_value = {
        "body": _chunks(
            [
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
            ]
        )
    }

    events = await _collect(BedrockInvokeModel(model_id=CLAUDE_ID), [{"role": "user", "content": [{"text": "hi"}]}])

    assert _reasoning_deltas(events) == [{"text": "working"}, {"signature": "sig"}]


@pytest.mark.asyncio
async def test_stream_anthropic_reasoning_without_signature_round_trips(bedrock_client):
    bedrock_client.invoke_model_with_response_stream.return_value = {
        "body": _chunks(
            [
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
            ]
        )
    }
    m = BedrockInvokeModel(model_id=CLAUDE_ID)

    processed = [
        event async for event in streaming.process_stream(m.stream([{"role": "user", "content": [{"text": "hi"}]}]))
    ]
    _, message, _, _ = processed[-1]["stop"]
    req = m._format_anthropic_request([message], None, None, None)

    assert req["messages"][0]["content"] == [{"type": "thinking", "thinking": "working"}]


@pytest.mark.asyncio
async def test_stream_anthropic_redacted_reasoning_round_trips(bedrock_client):
    data = base64.b64encode(b"redacted-bytes").decode("utf-8")
    bedrock_client.invoke_model_with_response_stream.return_value = {
        "body": _chunks(
            [
                {"type": "message_start", "message": {"usage": {"input_tokens": 5, "output_tokens": 0}}},
                {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {"type": "redacted_thinking", "data": data},
                },
                {"type": "content_block_stop", "index": 0},
                {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 3}},
                {"type": "message_stop"},
            ]
        )
    }
    m = BedrockInvokeModel(model_id=CLAUDE_ID)

    processed = [
        event async for event in streaming.process_stream(m.stream([{"role": "user", "content": [{"text": "hi"}]}]))
    ]
    _, message, _, _ = processed[-1]["stop"]
    req = m._format_anthropic_request([message], None, None, None)

    assert req["messages"][0]["content"] == [{"type": "redacted_thinking", "data": data}]


@pytest.mark.asyncio
async def test_stream_anthropic_reports_cache_usage(bedrock_client):
    bedrock_client.invoke_model_with_response_stream.return_value = {
        "body": _chunks(
            [
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
            ]
        )
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
        "body": _chunks(
            [
                {"type": "message_start", "message": {"usage": {"input_tokens": 7, "output_tokens": 0}}},
                {"type": "content_block_start", "index": 0, "content_block": cb_start},
                {"type": "content_block_delta", "index": 0, "delta": delta1},
                {"type": "content_block_delta", "index": 0, "delta": delta2},
                {"type": "content_block_stop", "index": 0},
                {"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 11}},
                {"type": "message_stop"},
            ]
        )
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
        "body": _chunks(
            [
                {"choices": [{"delta": {"content": "Hello"}, "finish_reason": None}]},
                {"choices": [{"delta": {"content": " world"}, "finish_reason": None}]},
                {"choices": [{"delta": {"tool_calls": [tc1]}, "finish_reason": None}]},
                {"choices": [{"delta": {"tool_calls": [tc2]}, "finish_reason": "tool_calls"}]},
                {"choices": [], "usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 19}},
            ]
        )
    }
    m = BedrockInvokeModel(model_id=IMPORTED_ID)
    events = await _collect(m, [{"role": "user", "content": [{"text": "go"}]}])
    assert _texts(events) == "Hello world"
    assert _tool_inputs(events) == '{"x":1}'
    assert _stop_reason(events) == "tool_use"
    tru_usage = _metadata(events)["usage"]
    exp_usage = {"inputTokens": 10, "outputTokens": 4, "totalTokens": 19}
    assert tru_usage == exp_usage


@pytest.mark.asyncio
async def test_stream_openai_asks_for_usage_in_stream(bedrock_client):
    """OpenAI streaming withholds the usage chunk unless asked, which would leave the turn reporting no tokens."""
    bedrock_client.invoke_model_with_response_stream.return_value = {
        "body": _chunks([{"choices": [{"delta": {}, "finish_reason": "stop"}]}])
    }
    await _collect(BedrockInvokeModel(model_id=IMPORTED_ID), [{"role": "user", "content": [{"text": "hi"}]}])

    body = json.loads(bedrock_client.invoke_model_with_response_stream.call_args.kwargs["body"])
    assert body["stream_options"] == {"include_usage": True}


@pytest.mark.parametrize(
    "model_id, config",
    [(CLAUDE_ID, {}), (IMPORTED_ID, {"streaming": False}), (IMPORTED_ID, {"params": {"stream_options": None}})],
    ids=["anthropic", "non_streaming", "strict_openai_endpoint"],
)
def test_format_request_omits_stream_options(model_id, config):
    """Only request streaming OpenAI usage when the endpoint accepts stream_options."""
    m = BedrockInvokeModel(model_id=model_id, **config)
    req = m._format_invoke_request([{"role": "user", "content": [{"text": "hi"}]}], None, None, None)
    assert "stream_options" not in req


@pytest.mark.asyncio
async def test_stream_openai_reports_metadata_without_usage_chunk(bedrock_client, measured_clock):
    """An endpoint that ignores ``stream_options`` still gets a metadata event, so latency is never lost."""
    bedrock_client.invoke_model_with_response_stream.return_value = {
        "body": _chunks([{"choices": [{"delta": {"content": "hi"}, "finish_reason": "stop"}]}])
    }
    events = await _collect(BedrockInvokeModel(model_id=IMPORTED_ID), [{"role": "user", "content": [{"text": "x"}]}])

    tru_usage = _metadata(events)["usage"]
    exp_usage = {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0}
    assert tru_usage == exp_usage
    assert _metadata(events)["metrics"] == {"latencyMs": 125}


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
        "body": _chunks(
            [
                {"choices": [{"delta": {"tool_calls": [first_delta]}, "finish_reason": None}]},
                {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"name": "weather"}}]}}]},
                {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": tail}}]}}]},
                {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]},
            ]
        )
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
        "body": _chunks(
            [{"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_0"}]}, "finish_reason": "tool_calls"}]}]
        )
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
        "body": _chunks(
            [
                {"choices": [{"delta": {"tool_calls": [tc0_start]}, "finish_reason": None}]},
                {"choices": [{"delta": {"tool_calls": [tc0_args]}, "finish_reason": None}]},
                {"choices": [{"delta": {"tool_calls": [tc1_start]}, "finish_reason": None}]},
                {"choices": [{"delta": {"tool_calls": [tc1_args]}, "finish_reason": "tool_calls"}]},
                {"choices": [], "usage": {"prompt_tokens": 9, "completion_tokens": 8, "total_tokens": 17}},
            ]
        )
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
        "body": _chunks(
            [
                {"choices": [{"delta": {"content": "thinking"}, "finish_reason": None}]},
                {"choices": [{"delta": {"tool_calls": [tc0]}, "finish_reason": None}]},
                {"choices": [{"delta": {"tool_calls": [tc1]}, "finish_reason": None}]},
                {"choices": [{"delta": {"content": " done"}, "finish_reason": "tool_calls"}]},
            ]
        )
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
        "body": _chunks(
            [
                {"type": "message_start", "message": {"usage": {"input_tokens": 3, "output_tokens": 0}}},
                {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
                {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "partial"}},
                {"type": "message_delta", "delta": {"stop_reason": "end_turn"}},
                {"type": "message_stop"},
            ]
        )
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
        "body": _chunks(
            [
                {"choices": [{"delta": {"tool_calls": [open_0]}, "finish_reason": None}]},
                {"choices": [{"delta": {"tool_calls": [open_1]}, "finish_reason": None}]},
                {"choices": [{"delta": {"tool_calls": [late_0]}, "finish_reason": "tool_calls"}]},
            ]
        )
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
        "body": _chunks(
            [
                {"choices": [{"delta": {"tool_calls": [start]}, "finish_reason": None}]},
                {"choices": [{"delta": {"content": "interlude"}, "finish_reason": None}]},
                {"choices": [{"delta": {"tool_calls": [tail]}, "finish_reason": "tool_calls"}]},
            ]
        )
    }

    events = await _collect(BedrockInvokeModel(model_id=IMPORTED_ID), [{"role": "user", "content": [{"text": "go"}]}])

    assert _texts(events) == "interlude"
    assert _tool_use_blocks(events) == [({"toolUseId": "call_0", "name": "a"}, '{"x":1}')]


@pytest.mark.parametrize("model_id", [CLAUDE_ID, IMPORTED_ID])
@pytest.mark.parametrize("stream_response", [True, False])
@pytest.mark.parametrize("structured_system", [True, False])
@pytest.mark.asyncio
async def test_stream_sends_complete_request(
    bedrock_client: unittest.mock.Mock, model_id: str, stream_response: bool, structured_system: bool
) -> None:
    payloads = (
        [{"type": "message_delta", "delta": {"stop_reason": "end_turn"}}]
        if model_id == CLAUDE_ID
        else [{"choices": [{"delta": {}, "finish_reason": "stop"}]}]
    )
    bedrock_client.invoke_model_with_response_stream.return_value = {"body": _chunks(payloads)}
    body = unittest.mock.Mock()
    body.read.return_value = b"{}"
    bedrock_client.invoke_model.return_value = {"body": body}
    model = BedrockInvokeModel(model_id=model_id, streaming=stream_response, max_tokens=128, temperature=0.25)
    await _collect(
        model,
        [{"role": "user", "content": [{"text": "hi"}]}],
        tool_specs=[string_length.tool_spec],
        tool_choice={"any": {}},
        system_prompt="be nice",
        system_prompt_content=[{"text": "be"}, {"text": "nice"}] if structured_system else None,
    )

    invoked = bedrock_client.invoke_model_with_response_stream if stream_response else bedrock_client.invoke_model
    unused = bedrock_client.invoke_model if stream_response else bedrock_client.invoke_model_with_response_stream
    invoked.assert_called_once()
    unused.assert_not_called()
    invoked.return_value["body"].close.assert_called_once()
    tru_request = invoked.call_args.kwargs.copy()
    tru_request["body"] = json.loads(tru_request["body"])
    spec = string_length.tool_spec
    exp_body = {
        "max_tokens": 128,
        "temperature": 0.25,
    }
    if model_id == CLAUDE_ID:
        exp_body.update(
            {
                "anthropic_version": "bedrock-2023-05-31",
                "system": "be nice",
                "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
                "tools": [
                    {
                        "name": spec["name"],
                        "description": spec["description"],
                        "input_schema": spec["inputSchema"]["json"],
                    }
                ],
                "tool_choice": {"type": "any"},
            }
        )
    else:
        exp_body.update(
            {
                "model": IMPORTED_ID,
                "stream": stream_response,
                "messages": [{"role": "system", "content": "be nice"}, {"role": "user", "content": "hi"}],
                "tools": [
                    {
                        "type": "function",
                        "function": {
                            "name": spec["name"],
                            "description": spec["description"],
                            "parameters": spec["inputSchema"]["json"],
                        },
                    }
                ],
                "tool_choice": "required",
            }
        )
        if stream_response:
            exp_body["stream_options"] = {"include_usage": True}
    exp_request = {
        "modelId": model_id,
        "body": exp_body,
        "contentType": "application/json",
        "accept": "application/json",
    }
    assert tru_request == exp_request


@pytest.mark.asyncio
async def test_stream_non_streaming_anthropic(bedrock_client):
    body = unittest.mock.Mock()
    body.read.return_value = json.dumps(
        {
            "content": [{"type": "text", "text": "ack"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 1, "output_tokens": 1},
        }
    ).encode("utf-8")
    bedrock_client.invoke_model.return_value = {"body": body}

    m = BedrockInvokeModel(model_id=CLAUDE_ID, streaming=False)
    events = await _collect(m, [{"role": "user", "content": [{"text": "hi"}]}])
    assert _texts(events) == "ack"


@pytest.mark.asyncio
async def test_stream_non_streaming_anthropic_tool_use(bedrock_client):
    body = unittest.mock.Mock()
    body.read.return_value = json.dumps(
        {
            "content": [
                {"type": "text", "text": "checking"},
                {"type": "tool_use", "id": "tu1", "name": "weather", "input": {"city": "Paris"}},
            ],
            "stop_reason": "tool_use",
            "usage": {"input_tokens": 4, "output_tokens": 6},
        }
    ).encode("utf-8")
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
    body.read.return_value = json.dumps(
        {
            "content": [{"type": "thinking", "thinking": "working", "signature": "sig"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 4, "output_tokens": 6},
        }
    ).encode("utf-8")
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
    body.read.return_value = json.dumps(
        {
            "content": [{"type": "redacted_thinking", "data": data}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 4, "output_tokens": 6},
        }
    ).encode("utf-8")
    bedrock_client.invoke_model.return_value = {"body": body}

    events = await _collect(
        BedrockInvokeModel(model_id=CLAUDE_ID, streaming=False),
        [{"role": "user", "content": [{"text": "?"}]}],
    )

    assert _reasoning_deltas(events) == [{"redactedContent": b"redacted-bytes"}]


@pytest.mark.asyncio
async def test_stream_non_streaming_anthropic_reports_cache_usage(bedrock_client):
    body = unittest.mock.Mock()
    body.read.return_value = json.dumps(
        {
            "content": [{"type": "text", "text": "ack"}],
            "stop_reason": "end_turn",
            "usage": {
                "input_tokens": 4,
                "output_tokens": 6,
                "cache_read_input_tokens": 100,
                "cache_creation_input_tokens": 50,
            },
        }
    ).encode("utf-8")
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


@pytest.mark.parametrize("content", ["hi there", None], ids=["text_and_tool", "tool_only"])
@pytest.mark.asyncio
async def test_stream_non_streaming_openai_text_and_tool(bedrock_client, content):
    body = unittest.mock.Mock()
    body.read.return_value = json.dumps(
        {
            "choices": [
                {
                    "message": {
                        "content": content,
                        "tool_calls": [{"id": "call_1", "function": {"name": "fn", "arguments": '{"x":1}'}}],
                    },
                    "finish_reason": "tool_calls",
                }
            ],
            "usage": {"prompt_tokens": 6, "completion_tokens": 2, "total_tokens": 13},
        }
    ).encode("utf-8")
    bedrock_client.invoke_model.return_value = {"body": body}

    m = BedrockInvokeModel(model_id=IMPORTED_ID, streaming=False)
    events = await _collect(m, [{"role": "user", "content": [{"text": "hi"}]}])
    assert _texts(events) == (content or "")
    assert _tool_use_blocks(events) == [({"toolUseId": "call_1", "name": "fn"}, '{"x":1}')]
    assert _stop_reason(events) == "tool_use"
    tru_usage = _metadata(events)["usage"]
    exp_usage = {"inputTokens": 6, "outputTokens": 2, "totalTokens": 13}
    assert tru_usage == exp_usage


@pytest.mark.asyncio
async def test_stream_non_streaming_openai_empty_choices(bedrock_client: unittest.mock.Mock, alist) -> None:
    body = unittest.mock.Mock()
    body.read.return_value = json.dumps(
        {"choices": [], "usage": {"prompt_tokens": 6, "completion_tokens": 0, "total_tokens": 6}}
    ).encode("utf-8")
    bedrock_client.invoke_model.return_value = {"body": body}
    model = BedrockInvokeModel(model_id=IMPORTED_ID, streaming=False)

    tru_events = await alist(model.stream([{"role": "user", "content": [{"text": "hi"}]}]))
    exp_events = [
        {"messageStart": {"role": "assistant"}},
        {"messageStop": {"stopReason": "end_turn"}},
        {
            "metadata": {
                "usage": {"inputTokens": 6, "outputTokens": 0, "totalTokens": 6},
                "metrics": {"latencyMs": unittest.mock.ANY},
            }
        },
    ]
    assert tru_events == exp_events
    body.close.assert_called_once()


# ---- latency metrics


@pytest.fixture
def measured_clock():
    with unittest.mock.patch("strands.models.bedrock_invoke.time.perf_counter", side_effect=[100.0, 100.125]) as clock:
        yield clock
    assert clock.call_count == 2


@pytest.mark.asyncio
async def test_stream_reports_measured_latency(bedrock_client, measured_clock):
    """Latency includes the provider call and response consumption, in milliseconds."""
    bedrock_client.invoke_model_with_response_stream.return_value = {
        "body": _chunks(
            [
                {"type": "message_start", "message": {"usage": {"input_tokens": 5, "output_tokens": 0}}},
                {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 3}},
                {"type": "message_stop"},
            ]
        )
    }

    events = await _collect(BedrockInvokeModel(model_id=CLAUDE_ID), [{"role": "user", "content": [{"text": "hi"}]}])
    assert _metadata(events)["metrics"] == {"latencyMs": 125}


@pytest.mark.asyncio
async def test_stream_openai_reports_measured_latency(bedrock_client, measured_clock):
    bedrock_client.invoke_model_with_response_stream.return_value = {
        "body": _chunks(
            [
                {"choices": [{"delta": {"content": "hi"}, "finish_reason": "stop"}]},
                {"choices": [], "usage": {"prompt_tokens": 2, "completion_tokens": 1, "total_tokens": 3}},
            ]
        )
    }

    m = BedrockInvokeModel(model_id=IMPORTED_ID)
    events = await _collect(m, [{"role": "user", "content": [{"text": "hi"}]}])
    assert _metadata(events)["metrics"] == {"latencyMs": 125}


@pytest.mark.asyncio
async def test_stream_non_streaming_anthropic_reports_measured_latency(bedrock_client, measured_clock):
    body = unittest.mock.Mock()
    body.read.return_value = json.dumps(
        {
            "content": [{"type": "text", "text": "ack"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 1, "output_tokens": 1},
        }
    ).encode("utf-8")
    bedrock_client.invoke_model.return_value = {"body": body}

    m = BedrockInvokeModel(model_id=CLAUDE_ID, streaming=False)
    events = await _collect(m, [{"role": "user", "content": [{"text": "hi"}]}])
    assert _metadata(events)["metrics"] == {"latencyMs": 125}


@pytest.mark.asyncio
async def test_stream_non_streaming_openai_reports_measured_latency(bedrock_client, measured_clock):
    body = unittest.mock.Mock()
    body.read.return_value = json.dumps(
        {
            "choices": [{"message": {"content": "hi"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 6, "completion_tokens": 2, "total_tokens": 8},
        }
    ).encode("utf-8")
    bedrock_client.invoke_model.return_value = {"body": body}

    m = BedrockInvokeModel(model_id=IMPORTED_ID, streaming=False)
    events = await _collect(m, [{"role": "user", "content": [{"text": "hi"}]}])
    assert _metadata(events)["metrics"] == {"latencyMs": 125}


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


@pytest.mark.parametrize("thinking", [None, {"type": "enabled", "budget_tokens": 1024}])
@pytest.mark.parametrize("cancel_after_stop", [True, False])
@pytest.mark.asyncio
async def test_structured_output_yields_pydantic_model(bedrock_client, thinking, cancel_after_stop):
    cb_start = {"type": "tool_use", "id": "tu1", "name": "Person", "input": {}}
    delta = {"type": "input_json_delta", "partial_json": '{"name":"Ada","age":36}'}
    bedrock_client.invoke_model_with_response_stream.return_value = {
        "body": _chunks(
            [
                {"type": "message_start", "message": {"usage": {"input_tokens": 4, "output_tokens": 0}}},
                {"type": "content_block_start", "index": 0, "content_block": cb_start},
                {"type": "content_block_delta", "index": 0, "delta": delta},
                {"type": "content_block_stop", "index": 0},
                {"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 9}},
                {"type": "message_stop"},
            ]
        )
    }

    class Person(pydantic.BaseModel):
        name: str
        age: int

    params = {"thinking": thinking} if thinking else {}
    m = BedrockInvokeModel(model_id=CLAUDE_ID, params=params)
    cancel_signal = threading.Event()
    structured: list[dict] = []
    async for event in m.structured_output(
        Person, [{"role": "user", "content": [{"text": "?"}]}], cancel_signal=cancel_signal
    ):
        structured.append(event)
        if cancel_after_stop and "stop" in event:
            cancel_signal.set()
    if cancel_after_stop:
        assert not any("output" in event for event in structured)
    else:
        assert structured[-1]["output"] == Person(name="Ada", age=36)
    request = json.loads(bedrock_client.invoke_model_with_response_stream.call_args.kwargs["body"])
    assert request["tool_choice"] == {"type": "any"}
    assert "thinking" not in request
    assert m.get_config()["params"] == params


@pytest.mark.asyncio
async def test_structured_output_raises_when_model_answers_with_text(bedrock_client):
    """A turn that ends without the forced tool call cannot produce the output model."""
    bedrock_client.invoke_model_with_response_stream.return_value = {
        "body": _chunks(
            [
                {"type": "message_start", "message": {"usage": {"input_tokens": 4, "output_tokens": 0}}},
                {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
                {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "no thanks"}},
                {"type": "content_block_stop", "index": 0},
                {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 2}},
                {"type": "message_stop"},
            ]
        )
    }

    class Person(pydantic.BaseModel):
        name: str

    m = BedrockInvokeModel(model_id=CLAUDE_ID)
    with pytest.raises(ValueError, match='instead of "tool_use"'):
        async for event in m.structured_output(Person, [{"role": "user", "content": [{"text": "?"}]}]):
            assert "output" not in event


@pytest.mark.parametrize("family", ["anthropic", "openai"])
@pytest.mark.parametrize("empty", [True, False])
@pytest.mark.asyncio
async def test_stream_rejects_premature_eof(bedrock_client: unittest.mock.Mock, family: str, empty: bool) -> None:
    payloads = (
        [
            {"type": "content_block_start", "content_block": {"type": "text", "text": ""}},
            {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "partial"}},
        ]
        if family == "anthropic"
        else [{"choices": [{"delta": {"content": "partial"}, "finish_reason": None}]}]
    )
    body = _chunks([] if empty else payloads)
    bedrock_client.invoke_model_with_response_stream.return_value = {"body": body}
    model = BedrockInvokeModel(model_id=IMPORTED_ID, model_family=family)

    with pytest.raises(ValueError, match="without a stop reason"):
        await _collect(model, [{"role": "user", "content": [{"text": "hi"}]}])
    body.close.assert_called_once()


@pytest.mark.parametrize("family", ["anthropic", "openai"])
@pytest.mark.parametrize("invalid_json", [True, False])
@pytest.mark.asyncio
async def test_stream_closes_body_on_error(bedrock_client: unittest.mock.Mock, family: str, invalid_json: bool) -> None:
    body = _chunks([])
    if invalid_json:
        body.__iter__.return_value = iter([{"chunk": {"bytes": b"{invalid"}}])
        expected_error = json.JSONDecodeError
    else:
        body.__iter__.side_effect = EventStreamError(
            {"Error": {"Code": "ThrottlingException", "Message": "slow down"}}, "InvokeModelWithResponseStream"
        )
        expected_error = ModelThrottledException
    bedrock_client.invoke_model_with_response_stream.return_value = {"body": body}
    model = BedrockInvokeModel(model_id=IMPORTED_ID, model_family=family)

    with pytest.raises(expected_error):
        await _collect(model, [{"role": "user", "content": [{"text": "hi"}]}])
    body.close.assert_called_once()


@pytest.mark.parametrize("family", ["anthropic", "openai"])
@pytest.mark.parametrize("structured", [True, False])
@pytest.mark.asyncio
async def test_stream_cancellation_discards_buffered_response(
    bedrock_client: unittest.mock.Mock, family: str, structured: bool
) -> None:
    class Person(pydantic.BaseModel):
        name: str

    payloads = (
        [
            {"type": "content_block_start", "content_block": {"type": "tool_use", "id": "tu1", "name": "Person"}},
            {"type": "content_block_delta", "delta": {"type": "input_json_delta", "partial_json": '{"name":"Ada"}'}},
            {"type": "content_block_stop"},
            {"type": "message_delta", "delta": {"stop_reason": "tool_use"}},
        ]
        if family == "anthropic"
        else [
            {
                "choices": [
                    {
                        "delta": {
                            "tool_calls": [
                                {"index": 0, "id": "tu1", "function": {"name": "Person", "arguments": '{"name":"Ada"}'}}
                            ]
                        },
                        "finish_reason": "tool_calls",
                    }
                ]
            }
        ]
    )
    bedrock_client.invoke_model_with_response_stream.return_value = {"body": _chunks(payloads)}
    model = BedrockInvokeModel(model_id=IMPORTED_ID, model_family=family)
    worker_finished = threading.Event()
    original_stream = model._stream

    def run_worker(*args, **kwargs) -> None:
        try:
            original_stream(*args, **kwargs)
        finally:
            worker_finished.set()

    cancel_signal = threading.Event()
    messages = [{"role": "user", "content": [{"text": "hi"}]}]
    response = (
        model.structured_output(Person, messages, cancel_signal=cancel_signal)
        if structured
        else model.stream(messages, cancel_signal=cancel_signal)
    )
    with unittest.mock.patch.object(model, "_stream", side_effect=run_worker):
        await response.__anext__()
        await _wait_until(worker_finished.is_set)
        cancel_signal.set()
        remaining = [event async for event in response]

    if structured:
        assert len(remaining) == 1
        assert remaining[0]["stop"][0] == "cancelled"
    else:
        assert remaining == []


@pytest.mark.parametrize("manual_boundary", [False, True])
def test_format_request_cache_boundaries_match_converse(manual_boundary: bool) -> None:
    cache_config = CacheConfig(ttl="1h", tools_ttl=True)
    messages = [
        {"role": "user", "content": [{"text": "old"}, {"cachePoint": {"type": "default"}}]},
        {"role": "assistant", "content": [{"text": "reply"}]},
        {"role": "user", "content": [{"text": "durable"}, {"text": "dynamic"}]},
    ]
    if manual_boundary:
        messages[-1]["content"].insert(1, {"cachePoint": {"type": "default", "ttl": "5m"}})
    system = [{"text": "rules"}]
    tools = [string_length.tool_spec]
    original = deepcopy((messages, system, tools))
    model = BedrockInvokeModel(model_id=CLAUDE_ID, cache_config=cache_config)
    converse = BedrockModel(model_id=CLAUDE_ID, cache_config=cache_config)

    request = model._format_invoke_request(messages, tools, system, None, dynamic_trailing_blocks=1)
    converse_request = converse.format_request(messages, tools, system, dynamic_trailing_blocks=1)

    control = {"type": "ephemeral", "ttl": "1h"}
    assert request["system"] == [{"type": "text", "text": "rules", "cache_control": control}]
    assert request["tools"][-1]["cache_control"] == control
    assert request["messages"] == [
        {"role": "user", "content": [{"type": "text", "text": "old"}]},
        {"role": "assistant", "content": [{"type": "text", "text": "reply"}]},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "durable", "cache_control": control},
                {"type": "text", "text": "dynamic"},
            ],
        },
    ]
    assert converse_request["messages"][-1]["content"] == [
        {"text": "durable"},
        {"cachePoint": {"type": "default", "ttl": "1h"}},
        {"text": "dynamic"},
    ]
    assert converse_request["system"][-1] == {"cachePoint": {"type": "default", "ttl": "1h"}}
    assert converse_request["toolConfig"]["tools"][-1] == {"cachePoint": {"type": "default", "ttl": "1h"}}
    assert (messages, system, tools) == original


@pytest.mark.parametrize(
    "cache_config, expected_system, expected_tools",
    [
        (CacheConfig(ttl="5m", system_prompt_ttl="1h", tools_ttl="1h"), "1h", "1h"),
        (CacheConfig(ttl="1h", system_prompt_ttl=False, tools_ttl=False), None, None),
    ],
)
def test_format_request_cache_section_settings(
    cache_config: CacheConfig, expected_system: str | None, expected_tools: str | None
) -> None:
    model = BedrockInvokeModel(model_id=IMPORTED_ID, model_family="anthropic", cache_config=cache_config)
    request = model._format_invoke_request(
        [{"role": "user", "content": [{"text": "hello"}]}], [string_length.tool_spec], [{"text": "rules"}], None
    )
    if expected_system:
        assert request["system"] == [
            {"type": "text", "text": "rules", "cache_control": {"type": "ephemeral", "ttl": expected_system}}
        ]
    else:
        assert request["system"] == "rules"
    if expected_tools:
        assert request["tools"][0]["cache_control"] == {"type": "ephemeral", "ttl": expected_tools}
    else:
        assert "cache_control" not in request["tools"][0]
    assert request["messages"][0]["content"][0]["cache_control"] == {"type": "ephemeral", "ttl": cache_config.ttl}


def test_format_request_honors_explicit_cache_points_without_config(model: BedrockInvokeModel) -> None:
    messages = [
        {"role": "user", "content": [{"text": "prefix"}, {"cachePoint": {"type": "default"}}, {"text": "tail"}]}
    ]
    system = [{"text": "rules"}, {"cachePoint": {"type": "default", "ttl": "1h"}}, {"text": "more"}]
    request = model._format_invoke_request(messages, None, system, None)
    assert request["system"] == [
        {"type": "text", "text": "rules", "cache_control": {"type": "ephemeral", "ttl": "1h"}},
        {"type": "text", "text": "more"},
    ]
    assert request["messages"][0]["content"] == [
        {"type": "text", "text": "prefix", "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": "tail"},
    ]


@pytest.mark.parametrize("boundary", ["automatic", "dynamic_tail", "explicit"])
def test_format_request_cache_boundaries_survive_tool_result_ordering(boundary: str) -> None:
    """Ordering tool results must preserve the cached prefix or reject an impossible boundary."""
    tool_result = {"toolResult": {"toolUseId": "tu1", "content": [{"text": "result"}]}}
    content = [{"text": "durable"}, tool_result]
    if boundary == "explicit":
        content = [
            {"text": "durable"},
            {"cachePoint": {"type": "default", "ttl": "1h"}},
            tool_result,
            {"cachePoint": {"type": "default", "ttl": "5m"}},
        ]
    messages = [
        {
            "role": "assistant",
            "content": [
                {"toolUse": {"toolUseId": "tu1", "name": "string_length", "input": {"string_to_measure": "abc"}}}
            ],
        },
        {"role": "user", "content": content},
    ]
    original = deepcopy(messages)
    model = BedrockInvokeModel(
        model_id=CLAUDE_ID,
        cache_config=None if boundary == "explicit" else CacheConfig(system_prompt_ttl=False),
    )
    if boundary == "automatic":
        request = model._format_invoke_request(messages, [string_length.tool_spec], None, None)
        assert request["messages"][-1]["content"] == [
            {"type": "tool_result", "tool_use_id": "tu1", "content": [{"type": "text", "text": "result"}]},
            {"type": "text", "text": "durable", "cache_control": {"type": "ephemeral"}},
        ]
    else:
        with pytest.raises(ValueError, match="tool results.*cache boundary"):
            model._format_invoke_request(
                messages,
                [string_length.tool_spec],
                None,
                None,
                dynamic_trailing_blocks=1 if boundary == "dynamic_tail" else 0,
            )
    assert messages == original


def test_format_request_preserves_cache_boundaries_after_tool_results(model: BedrockInvokeModel) -> None:
    messages = [
        {
            "role": "user",
            "content": [
                {"toolResult": {"toolUseId": "tu1", "content": [{"text": "result"}]}},
                {"cachePoint": {"type": "default", "ttl": "1h"}},
                {"text": "durable"},
                {"cachePoint": {"type": "default", "ttl": "5m"}},
                {"text": "dynamic"},
            ],
        }
    ]
    request = model._format_invoke_request(messages, None, None, None)
    content = request["messages"][0]["content"]
    assert content[0]["cache_control"] == {"type": "ephemeral", "ttl": "1h"}
    assert content[1]["cache_control"] == {"type": "ephemeral", "ttl": "5m"}
    assert "cache_control" not in content[2]


@pytest.mark.parametrize("cache_tools", ["default", CacheToolsConfig(ttl="1h")])
def test_format_request_legacy_cache_options(cache_tools: str | CacheToolsConfig) -> None:
    with pytest.warns(DeprecationWarning, match="cache_tools"):
        model = BedrockInvokeModel(model_id=CLAUDE_ID, cache_tools=cache_tools, cache_prompt="default")
    with pytest.warns(UserWarning, match="cache_prompt"):
        request = model._format_invoke_request([], [string_length.tool_spec], [{"text": "rules"}], None)
    expected_tools = {"type": "ephemeral"}
    if isinstance(cache_tools, CacheToolsConfig):
        expected_tools["ttl"] = "1h"
    assert request["tools"][0]["cache_control"] == expected_tools
    assert request["system"] == [{"type": "text", "text": "rules", "cache_control": {"type": "ephemeral"}}]


@pytest.mark.parametrize("location", ["system", "message"])
@pytest.mark.parametrize("point", [{"type": "default"}, {"type": "unsupported"}])
def test_format_request_rejects_invalid_cache_boundary(model: BedrockInvokeModel, location: str, point: dict) -> None:
    messages = [{"role": "user", "content": [{"cachePoint": point}]}] if location == "message" else []
    system = [{"cachePoint": point}] if location == "system" else None
    with pytest.raises(ValueError, match="cache"):
        model._format_invoke_request(messages, None, system, None)


@pytest.mark.parametrize("config", [{"cache_config": CacheConfig()}, {"cache_prompt": "default"}])
def test_format_openai_request_rejects_cache_configuration(config: dict) -> None:
    model = BedrockInvokeModel(model_id=IMPORTED_ID, **config)
    with pytest.raises(ValueError, match="Anthropic"):
        model._format_invoke_request([], None, None, None)


@pytest.mark.asyncio
async def test_stream_cache_excludes_dynamic_tail(bedrock_client: unittest.mock.Mock) -> None:
    bedrock_client.invoke_model_with_response_stream.return_value = {
        "body": _chunks([{"type": "message_delta", "delta": {"stop_reason": "end_turn"}}])
    }
    model = BedrockInvokeModel(model_id=CLAUDE_ID, cache_config=CacheConfig())
    await _collect(
        model,
        [{"role": "user", "content": [{"text": "durable"}, {"text": "dynamic"}]}],
        dynamic_trailing_blocks=1,
    )
    request = json.loads(bedrock_client.invoke_model_with_response_stream.call_args.kwargs["body"])
    assert request["messages"][0]["content"] == [
        {"type": "text", "text": "durable", "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": "dynamic"},
    ]
