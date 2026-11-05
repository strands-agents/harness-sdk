import re
import subprocess
import sys

import anthropic
import httpx
import pytest

from strands import Agent
from strands.models import BedrockModel
from strands.models._bedrock_messages import BedrockMessagesModel
from strands.models.anthropic import AnthropicModel

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


@pytest.fixture(autouse=True)
def network(monkeypatch, captured_requests):
    """Answer at the innermost transport, so the Anthropic SDK's own Bedrock client and its auth run."""

    async def handle_async_request(self, request):
        await request.aread()
        captured_requests.append(request)
        if request.url.path.endswith("/v1/messages"):
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, text=SSE_TEXT_RESPONSE)
        return httpx.Response(400, json={"message": "stop here"})

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", handle_async_request)


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


def test_runtime_uses_invoke_model_signed_by_the_sdk(captured_requests):
    model = BedrockModel.Messages(model_id="global.anthropic.claude-sonnet-4-6", max_tokens=16)

    with pytest.raises(Exception, match="stop here"):
        Agent(model=model, callback_handler=None)("hello")

    request = captured_requests[0]
    assert str(request.url) == (
        "https://bedrock-runtime.us-west-2.amazonaws.com/model/global.anthropic.claude-sonnet-4-6"
        "/invoke-with-response-stream"
    )
    assert request.headers["authorization"].startswith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/")
    assert "/us-west-2/bedrock/aws4_request" in request.headers["authorization"]
    assert b'"anthropic_version"' in request.content


def test_mantle_uses_the_messages_api_signed_by_the_sdk(captured_requests):
    model = BedrockModel.Messages(model_id="anthropic.claude-haiku-4-5", max_tokens=16, endpoint="bedrock-mantle")

    result = Agent(model=model, callback_handler=None)("hello")

    assert str(result).strip() == "hi"
    request = captured_requests[0]
    assert str(request.url) == "https://bedrock-mantle.us-west-2.api.aws/anthropic/v1/messages"
    assert "/us-west-2/bedrock-mantle/aws4_request" in request.headers["authorization"]


@pytest.mark.parametrize("source", ["argument", "environment"])
def test_api_key_is_sent_as_a_bearer_token(source, monkeypatch, captured_requests):
    kwargs = {"api_key": "bedrock-key"} if source == "argument" else {}
    if source == "environment":
        monkeypatch.setenv("AWS_BEARER_TOKEN_BEDROCK", "bedrock-key")
    model = BedrockModel.Messages(model_id="m", max_tokens=16, endpoint="bedrock-mantle", **kwargs)

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
    monkeypatch.delattr(anthropic, "AsyncAnthropicBedrockMantle")

    with pytest.raises(ImportError, match=re.escape("pip install -U 'anthropic>=0.91.0'")):
        BedrockModel.Messages(model_id="m", max_tokens=16, endpoint="bedrock-mantle")
