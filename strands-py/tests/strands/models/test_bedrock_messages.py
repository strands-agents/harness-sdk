import base64
import importlib
import inspect
import json
import re
import struct
import subprocess
import sys
import zlib

import anthropic
import pytest

from strands import Agent
from strands.models import BedrockModel
from strands.models._bedrock_messages import BedrockMessagesModel
from strands.models.anthropic import AnthropicModel
from strands.types.exceptions import ContextWindowOverflowException, ModelThrottledException

SSE_TEXT_RESPONSE = "".join(
    f"event: {event}\ndata: {data}\n\n"
    for event, data in [
        (
            "message_start",
            '{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"m",'
            '"content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":1}}}',
        ),
        ("content_block_start", '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}'),
        ("content_block_delta", '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}'),
        ("content_block_stop", '{"type":"content_block_stop","index":0}'),
        (
            "message_delta",
            '{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},'
            '"usage":{"output_tokens":1}}',
        ),
        ("message_stop", '{"type":"message_stop"}'),
    ]
)


def _event_stream_message(headers: dict[str, str], payload: bytes) -> bytes:
    """Encode one AWS event stream message, the framing InvokeModelWithResponseStream uses."""
    encoded_headers = b"".join(
        bytes([len(name)]) + name.encode() + b"\x07" + struct.pack(">H", len(value)) + value.encode()
        for name, value in headers.items()
    )
    total_length = 16 + len(encoded_headers) + len(payload)
    prelude = struct.pack(">II", total_length, len(encoded_headers))
    prelude += struct.pack(">I", zlib.crc32(prelude))
    message = prelude + encoded_headers + payload
    return message + struct.pack(">I", zlib.crc32(message))


def _invoke_stream(events: list[str]) -> bytes:
    """An InvokeModelWithResponseStream body that carries each Anthropic stream event as a chunk."""
    chunk_headers = {":event-type": "chunk", ":content-type": "application/json", ":message-type": "event"}
    return b"".join(
        _event_stream_message(chunk_headers, json.dumps({"bytes": base64.b64encode(event.encode()).decode()}).encode())
        for event in events
    )


INVOKE_EVENTS = [line.removeprefix("data: ") for line in SSE_TEXT_RESPONSE.splitlines() if line.startswith("data: ")]


def _exception_event(exception_type: str, message: str) -> bytes:
    headers = {":exception-type": exception_type, ":content-type": "application/json", ":message-type": "exception"}
    return _event_stream_message(headers, json.dumps({"message": message}).encode())


THROTTLING_EVENT = _exception_event("throttlingException", "Too many requests, please wait before trying again.")
OVERFLOW_EVENT = _exception_event("validationException", "Input is too long for requested model.")
OTHER_ERROR_EVENT = _exception_event("internalServerException", "The system encountered an unexpected error.")

# The installed anthropic release decides the HTTP package: httpx before 1.0, httpx2 since.
HTTP = next(
    importlib.import_module(base.__module__.partition(".")[0])
    for base in anthropic.DefaultAsyncHttpxClient.__mro__
    if base.__name__ == "AsyncClient"
)

# anthropic added its bedrock-mantle client in 0.91.0; older releases still cover the bedrock-runtime tests.
requires_mantle_client = pytest.mark.skipif(
    not hasattr(anthropic, "AsyncAnthropicBedrockMantle"), reason="anthropic<0.91.0 has no bedrock-mantle client"
)

# anthropic added api_key to its bedrock-runtime client in 0.88.0.
requires_bedrock_api_key = pytest.mark.skipif(
    "api_key" not in inspect.signature(anthropic.AsyncAnthropicBedrock).parameters,
    reason="anthropic<0.88.0 has no api_key on its bedrock-runtime client",
)


@pytest.fixture(autouse=True)
def aws_environment(monkeypatch):
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIDEXAMPLE")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "secret")
    monkeypatch.setenv("AWS_REGION", "us-west-2")
    for name in ("AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_BEARER_TOKEN_BEDROCK", "ANTHROPIC_API_KEY"):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def captured_requests():
    return []


@pytest.fixture
def invoke_body():
    """The InvokeModel response stream to answer with."""
    return _invoke_stream(INVOKE_EVENTS)


@pytest.fixture(autouse=True)
def network(monkeypatch, captured_requests, invoke_body):
    """Answer at the innermost transport, so the Anthropic SDK's own Bedrock clients, their auth, and their
    stream decoding all run."""

    async def handle_async_request(self, request):
        await request.aread()
        captured_requests.append(request)
        if request.url.path.endswith("/v1/messages"):
            return HTTP.Response(200, headers={"content-type": "text/event-stream"}, text=SSE_TEXT_RESPONSE)
        return HTTP.Response(200, headers={"content-type": "application/vnd.amazon.eventstream"}, content=invoke_body)

    monkeypatch.setattr(HTTP.AsyncHTTPTransport, "handle_async_request", handle_async_request)


def test_nested_names():
    assert BedrockModel.Messages is BedrockMessagesModel
    assert issubclass(BedrockModel.Messages, AnthropicModel)
    assert BedrockModel.ConverseStream is BedrockModel


def test_importing_bedrock_does_not_import_provider_sdks():
    code = "import sys, strands.models.bedrock; assert not {'anthropic', 'openai'} & set(sys.modules)"

    subprocess.run([sys.executable, "-c", code], check=True)


def test_missing_extra_is_reported_as_an_absent_attribute():
    code = (
        "import sys; sys.modules['anthropic'] = None\n"
        "from strands.models import BedrockModel\n"
        "assert not hasattr(BedrockModel, 'Messages')\n"
        'try:\n    BedrockModel.Messages\nexcept AttributeError as e:\n    assert "strands-agents[anthropic]" in str(e)'
    )

    subprocess.run([sys.executable, "-c", code], check=True)


def test_runtime_streams_through_invoke_model_signed_by_the_sdk(captured_requests):
    model = BedrockModel.Messages(model_id="global.anthropic.claude-sonnet-4-6", max_tokens=16)

    result = Agent(model=model, callback_handler=None)("hello")

    assert str(result).strip() == "hi"
    request = captured_requests[0]
    assert str(request.url) == (
        "https://bedrock-runtime.us-west-2.amazonaws.com/model/global.anthropic.claude-sonnet-4-6"
        "/invoke-with-response-stream"
    )
    assert request.headers["authorization"].startswith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/")
    assert "/us-west-2/bedrock/aws4_request" in request.headers["authorization"]
    assert json.loads(request.content)["anthropic_version"] == "bedrock-2023-05-31"


def test_runtime_url_encodes_arn_model_ids(captured_requests):
    arn = "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/abc"
    Agent(model=BedrockModel.Messages(model_id=arn, max_tokens=16), callback_handler=None)("hello")

    assert (
        captured_requests[0]
        .url.raw_path.decode()
        .startswith("/model/arn:aws:bedrock:us-west-2:123456789012:application-inference-profile%2Fabc/")
    )


@pytest.mark.parametrize(
    ("invoke_body", "expected"),
    [
        (THROTTLING_EVENT, ModelThrottledException),
        (OVERFLOW_EVENT, ContextWindowOverflowException),
        # The SDK raises other events as ValueError before 1.0 and as APIStatusError since; they pass through.
        (OTHER_ERROR_EVENT, (ValueError, anthropic.APIStatusError)),
    ],
    ids=["throttling", "overflow", "other"],
)
@pytest.mark.asyncio
async def test_runtime_error_events_mid_stream_are_mapped(expected):
    model = BedrockModel.Messages(model_id="m", max_tokens=16, client_args={"max_retries": 0})

    with pytest.raises(expected) as raised:
        async for _ in model.stream([{"role": "user", "content": [{"text": "hello"}]}]):
            pass

    expected_event = {
        ModelThrottledException: "throttlingException",
        ContextWindowOverflowException: "Input is too long",
    }
    assert expected_event.get(expected, "internalServerException") in str(raised.value)
    if expected is ValueError:
        assert type(raised.value) is ValueError


@requires_mantle_client
def test_mantle_uses_the_messages_api_signed_by_the_sdk(captured_requests):
    model = BedrockModel.Messages(model_id="anthropic.claude-haiku-4-5", max_tokens=16, endpoint="bedrock-mantle")

    result = Agent(model=model, callback_handler=None)("hello")

    assert str(result).strip() == "hi"
    request = captured_requests[0]
    assert str(request.url) == "https://bedrock-mantle.us-west-2.api.aws/anthropic/v1/messages"
    assert "/us-west-2/bedrock-mantle/aws4_request" in request.headers["authorization"]


@pytest.mark.parametrize(
    "endpoint",
    [
        pytest.param("bedrock-runtime", marks=requires_bedrock_api_key),
        pytest.param("bedrock-mantle", marks=requires_mantle_client),
    ],
)
@pytest.mark.parametrize("source", ["argument", "environment"])
def test_api_key_is_sent_instead_of_signing(endpoint, source, monkeypatch, captured_requests):
    kwargs = {"api_key": "bedrock-key"} if source == "argument" else {}
    if source == "environment":
        monkeypatch.setenv("AWS_BEARER_TOKEN_BEDROCK", "bedrock-key")
    model = BedrockModel.Messages(model_id="m", max_tokens=16, endpoint=endpoint, **kwargs)

    Agent(model=model, callback_handler=None)("hello")

    # The SDK picks the header: X-Api-Key before anthropic 0.98, a bearer token since; mantle accepts both.
    headers = captured_requests[0].headers
    assert headers.get("authorization") == "Bearer bedrock-key" or headers.get("x-api-key") == "bedrock-key"


def test_client_args_are_forwarded_to_the_bedrock_client():
    model = BedrockModel.Messages(model_id="m", max_tokens=16, client_args={"timeout": 12.5, "max_retries": 1})

    assert model.client.timeout == 12.5
    assert model.client.max_retries == 1


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"client_args": {"base_url": "https://example.com"}}, "set by BedrockModel.Messages"),
        ({"client_args": {"aws_region": "eu-west-1"}}, "set by BedrockModel.Messages"),
        ({"client": object()}, "not supported by BedrockModel.Messages"),
        ({"model_id": "arn:aws:bedrock:us-west-2:123456789012:imported-model/abc"}, "imported models"),
        ({"endpoint": "bedrock-agent"}, "unknown Bedrock endpoint"),
        ({"region_name": "us-east-1.evil.com#"}, "region"),
    ],
)
def test_invalid_configuration_raises(kwargs, message):
    with pytest.raises(ValueError, match=message):
        BedrockModel.Messages(**{"model_id": "m", "max_tokens": 16, **kwargs})


@pytest.mark.parametrize(
    ("region_name", "env_region", "expected"),
    [("eu-west-1", "us-east-2", "eu-west-1"), (None, "us-east-2", "us-east-2")],
)
def test_region_resolution(region_name, env_region, expected, monkeypatch):
    monkeypatch.setenv("AWS_REGION", env_region)
    monkeypatch.delenv("AWS_DEFAULT_REGION", raising=False)

    model = BedrockModel.Messages(model_id="m", max_tokens=16, region_name=region_name)

    assert model.client.aws_region == expected


def test_mantle_on_an_anthropic_release_without_its_client_raises(monkeypatch):
    monkeypatch.delattr(anthropic, "AsyncAnthropicBedrockMantle", raising=False)

    with pytest.raises(ImportError, match=re.escape("pip install -U 'anthropic>=0.91.0'")):
        BedrockModel.Messages(model_id="m", max_tokens=16, endpoint="bedrock-mantle")


def test_runtime_api_key_on_an_anthropic_release_without_it_raises(monkeypatch):
    class OldBedrockClient:
        def __init__(self, *, aws_region=None, base_url=None):
            pass

    monkeypatch.setattr(anthropic, "AsyncAnthropicBedrock", OldBedrockClient)

    with pytest.raises(ImportError, match=re.escape("pip install -U 'anthropic>=0.88.0'")):
        BedrockModel.Messages(model_id="m", max_tokens=16, api_key="bedrock-key")
