import io
import json
import subprocess
import sys
import threading
import unittest.mock

import pytest
from botocore.exceptions import ClientError

import strands
from strands.models import BedrockModel, CacheConfig, ModelCapabilities, ModelInfo
from strands.models._anthropic_compaction import COMPACTION_BETA
from strands.models._bedrock_invoke_model import ANTHROPIC_VERSION, build_body, compaction_body, decode_chunk
from strands.types.exceptions import ContextWindowOverflowException, ModelThrottledException

THINKING = {"type": "adaptive"}
NATIVE_INFO = ModelInfo(capabilities=ModelCapabilities(server_side_summary=True))
COMPACTION = {"type": "compaction", "content": "earlier steps"}
STORED_COMPACTION = {
    "text": "earlier steps",
    "metadata": {"providerData": {"provider": "anthropic", "data": COMPACTION}},
}
TOOL_SPEC = {"name": "f", "description": "d", "inputSchema": {"json": {"type": "object", "properties": {}}}}


@pytest.fixture
def bedrock_client():
    with unittest.mock.patch.object(strands.models.bedrock.boto3, "Session") as session_cls:
        session_cls.return_value.region_name = None
        client = session_cls.return_value.client.return_value
        client.meta = unittest.mock.MagicMock()
        client.meta.region_name = "us-west-2"
        yield client


def _model(**config):
    config.setdefault("model_info", NATIVE_INFO)
    return BedrockModel(model_id="us.anthropic.claude-sonnet-5-5", max_tokens=1000, **config)


def _stream_body(*raw_events):
    return {"body": [{"chunk": {"bytes": json.dumps(event).encode()}} for event in raw_events]}


def _sent_body(method):
    return json.loads(method.call_args.kwargs["body"])


TURN = [
    {"type": "message_start", "message": {"usage": {"input_tokens": 5, "output_tokens": 1}}},
    {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}},
    {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "hmm"}},
    {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "sig"}},
    {"type": "content_block_stop", "index": 0},
    {"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}},
    {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "hi"}},
    {"type": "content_block_stop", "index": 1},
    {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 9}},
    {"type": "message_stop"},
]


def _binding_error():
    return ClientError(
        {"Error": {"Code": "ValidationException", "Message": "thinking block bound to a different conversation"}},
        "InvokeModelWithResponseStream",
    )


@pytest.mark.asyncio
async def test_stream_sends_anthropic_body_through_invoke_model(bedrock_client, alist):
    bedrock_client.invoke_model_with_response_stream.return_value = _stream_body(*TURN)
    model = _model(additional_request_fields={"thinking": THINKING}, temperature=0.5)

    events = await alist(model.stream([{"role": "user", "content": [{"text": "go"}]}], [TOOL_SPEC], "sys"))

    bedrock_client.converse_stream.assert_not_called()
    call = bedrock_client.invoke_model_with_response_stream.call_args.kwargs
    assert call["modelId"] == "us.anthropic.claude-sonnet-5-5"
    assert _sent_body(bedrock_client.invoke_model_with_response_stream) == {
        "anthropic_version": ANTHROPIC_VERSION,
        "max_tokens": 1000,
        "messages": [{"role": "user", "content": [{"type": "text", "text": "go"}]}],
        "system": [{"type": "text", "text": "sys"}],
        "tools": [{"name": "f", "description": "d", "input_schema": {"type": "object", "properties": {}}}],
        "temperature": 0.5,
        "thinking": THINKING,
    }
    assert {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"reasoningContent": {"signature": "sig"}}}} in (
        events
    )
    assert events[-2] == {"messageStop": {"stopReason": "end_turn"}}
    assert events[-1]["metadata"]["usage"] == {"inputTokens": 5, "outputTokens": 9, "totalTokens": 14}


@pytest.mark.asyncio
async def test_stream_sends_from_the_last_compaction_block_with_the_beta(bedrock_client, alist):
    bedrock_client.invoke_model_with_response_stream.return_value = _stream_body(*TURN)
    messages = [
        {"role": "user", "content": [{"text": "task"}]},
        {"role": "assistant", "content": [STORED_COMPACTION, {"text": "next"}]},
        {"role": "user", "content": [{"text": "more"}]},
    ]

    await alist(_model().stream(messages))

    body = _sent_body(bedrock_client.invoke_model_with_response_stream)
    assert body["messages"][0] == {"role": "assistant", "content": [COMPACTION, {"type": "text", "text": "next"}]}
    assert len(body["messages"]) == 2
    assert body["anthropic_beta"] == [COMPACTION_BETA]


@pytest.mark.asyncio
async def test_stream_uses_converse_without_the_capability(bedrock_client, alist):
    bedrock_client.converse_stream.return_value = {"stream": []}

    await alist(_model(model_info=None).stream([{"role": "user", "content": [{"text": "go"}]}]))

    bedrock_client.converse_stream.assert_called_once()
    bedrock_client.invoke_model_with_response_stream.assert_not_called()


@pytest.mark.asyncio
async def test_stream_without_streaming_uses_invoke_model(bedrock_client, alist):
    message = {"content": [{"type": "text", "text": "hi"}], "stop_reason": "end_turn", "usage": {}}
    bedrock_client.invoke_model.return_value = {"body": io.BytesIO(json.dumps(message).encode())}

    events = await alist(_model(streaming=False).stream([{"role": "user", "content": [{"text": "go"}]}]))

    bedrock_client.invoke_model_with_response_stream.assert_not_called()
    assert {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": "hi"}}} in events
    assert events[-1] == {"messageStop": {"stopReason": "end_turn"}}


@pytest.mark.asyncio
async def test_stream_retries_with_drop_block_on_a_binding_error(bedrock_client, alist):
    bedrock_client.invoke_model_with_response_stream.side_effect = [_binding_error(), _stream_body(*TURN)]
    model = _model(additional_request_fields={"thinking": THINKING})

    await alist(model.stream([{"role": "user", "content": [{"text": "go"}]}]))

    body = _sent_body(bedrock_client.invoke_model_with_response_stream)
    assert body["thinking"]["block_binding"] == {"prefix_mismatch_behavior": "drop_block"}
    assert "thinking-binding-controls-2026-08-01" in body["anthropic_beta"]


@pytest.mark.asyncio
async def test_stream_maps_throttling(bedrock_client, alist):
    bedrock_client.invoke_model_with_response_stream.side_effect = ClientError(
        {"Error": {"Code": "ThrottlingException", "Message": "slow down"}}, "InvokeModelWithResponseStream"
    )

    with pytest.raises(ModelThrottledException):
        await alist(_model().stream([{"role": "user", "content": [{"text": "go"}]}]))


@pytest.mark.asyncio
async def test_stream_stops_when_cancelled(bedrock_client, alist):
    stream = unittest.mock.MagicMock()
    stream.__iter__.return_value = iter(_stream_body(*TURN)["body"])
    bedrock_client.invoke_model_with_response_stream.return_value = {"body": stream}
    cancel = threading.Event()
    cancel.set()

    events = await alist(_model().stream([{"role": "user", "content": [{"text": "go"}]}], cancel_signal=cancel))

    assert events == []
    stream.close.assert_called_once()


@pytest.mark.asyncio
async def test_summarize_sends_a_compaction_request(bedrock_client):
    response = {
        "content": [COMPACTION],
        "stop_reason": "compaction",
        "usage": {"iterations": [{"type": "compaction", "input_tokens": 50, "output_tokens": 5}]},
    }
    bedrock_client.invoke_model.return_value = {"body": io.BytesIO(json.dumps(response).encode())}
    model = _model(additional_request_fields={"thinking": THINKING}, stop_sequences=["X"])

    result = await model.summarize(
        [{"role": "user", "content": [{"text": "task"}]}], tool_specs=[TOOL_SPEC], instructions="keep it short"
    )

    body = _sent_body(bedrock_client.invoke_model)
    assert body["compaction"] == {"type": "summarize", "instructions": "keep it short"}
    assert body["anthropic_beta"] == [COMPACTION_BETA]
    assert "stop_sequences" not in body
    assert "extra_body" not in body
    assert result.content == [STORED_COMPACTION]
    assert result.usage is not None and result.usage["inputTokens"] == 50


@pytest.mark.asyncio
async def test_summarize_returns_nothing_without_a_compaction(bedrock_client):
    response = {"content": [{"type": "text", "text": "no"}], "stop_reason": "end_turn", "usage": {}}
    bedrock_client.invoke_model.return_value = {"body": io.BytesIO(json.dumps(response).encode())}

    result = await _model().summarize([{"role": "user", "content": [{"text": "task"}]}])

    assert result.content == []


@pytest.mark.asyncio
async def test_summarize_maps_context_overflow(bedrock_client):
    bedrock_client.invoke_model.side_effect = ClientError(
        {"Error": {"Code": "ValidationException", "Message": "prompt is too long"}}, "InvokeModel"
    )

    with pytest.raises(ContextWindowOverflowException):
        await _model().summarize([{"role": "user", "content": [{"text": "task"}]}])


@pytest.mark.asyncio
async def test_summarize_without_the_capability_uses_the_base_summarize(bedrock_client):
    model = _model(model_info=None)
    with unittest.mock.patch.object(strands.models.model.Model, "summarize") as base:
        await model.summarize([{"role": "user", "content": [{"text": "task"}]}])

    base.assert_called_once()
    bedrock_client.invoke_model.assert_not_called()


@pytest.mark.asyncio
async def test_count_tokens_estimates_from_the_last_compaction_block(bedrock_client):
    model = _model()
    long = [{"role": "user", "content": [{"text": "word " * 500}]}]
    compacted = [*long, {"role": "assistant", "content": [STORED_COMPACTION]}]

    assert await model.count_tokens(compacted) < await model.count_tokens(long)


@pytest.mark.asyncio
async def test_count_tokens_natively_sends_the_invoke_model_body(bedrock_client):
    bedrock_client.count_tokens.return_value = {"inputTokens": 42}

    count = await _model(use_native_token_count=True).count_tokens([{"role": "user", "content": [{"text": "go"}]}])

    assert count == 42
    sent = bedrock_client.count_tokens.call_args.kwargs["input"]["invokeModel"]["body"]
    assert json.loads(sent)["anthropic_version"] == ANTHROPIC_VERSION


def _body(messages, **overrides):
    kwargs = {
        "tool_specs": None,
        "system_prompt_content": None,
        "tool_choice": None,
        "max_tokens": None,
        "inference": {},
        "additional_fields": {},
        "cache_config": None,
        "tools_cache_ttl": (False, None),
        "system_cache_ttl": (False, None),
        **overrides,
    }
    return build_body(messages, **kwargs)


def test_build_body_places_one_managed_cache_point_in_the_last_user_message():
    messages = [
        {"role": "user", "content": [{"text": "a"}, {"cachePoint": {"type": "default"}}]},
        {"role": "assistant", "content": [{"text": "b"}]},
        {"role": "user", "content": [{"text": "c"}]},
    ]

    body = _body(messages, cache_config=CacheConfig(strategy="anthropic", ttl="1h"))

    assert body["max_tokens"] == 4096
    assert body["messages"][0]["content"] == [{"type": "text", "text": "a"}]
    assert body["messages"][2]["content"] == [
        {"type": "text", "text": "c", "cache_control": {"type": "ephemeral", "ttl": "1h"}}
    ]


def test_build_body_caches_system_and_tools_and_sends_strict_tools():
    body = _body(
        [{"role": "user", "content": [{"text": "a"}]}],
        tool_specs=[TOOL_SPEC],
        tool_choice={"any": {}},
        system_prompt_content=[{"text": "sys"}],
        tools_cache_ttl=(True, None),
        system_cache_ttl=(True, "5m"),
        strict_tools=True,
    )

    assert body["system"] == [{"type": "text", "text": "sys", "cache_control": {"type": "ephemeral", "ttl": "5m"}}]
    assert body["tools"][0]["strict"] is True
    assert body["tools"][0]["input_schema"]["additionalProperties"] is False
    assert body["tools"][0]["cache_control"] == {"type": "ephemeral"}
    assert body["tool_choice"] == {"type": "any"}


def test_build_body_omits_tool_choice_without_tools():
    assert "tool_choice" not in _body([{"role": "user", "content": [{"text": "a"}]}], tool_choice={"any": {}})


def test_compaction_body_inlines_extra_body_drops_forced_tool_choice_and_keeps_betas():
    body = compaction_body({"messages": [], "anthropic_beta": ["other"], "tool_choice": {"type": "any"}}, None)

    assert body == {"messages": [], "anthropic_beta": ["other", COMPACTION_BETA], "compaction": {"type": "summarize"}}


def test_decode_chunk_ignores_events_without_bytes():
    assert decode_chunk({"chunk": {"bytes": b'{"type": "ping"}'}}) == {"type": "ping"}
    assert decode_chunk({"internalServerException": {}}) is None


def test_bedrock_invoke_model_path_imports_without_anthropic():
    code = (
        "import sys; sys.modules['anthropic'] = None\n"
        "import strands.models.bedrock, strands.models._bedrock_invoke_model, strands.models._anthropic_messages\n"
    )
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
