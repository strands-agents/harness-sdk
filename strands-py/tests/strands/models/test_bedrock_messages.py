import subprocess
import sys
import unittest.mock

import boto3
import httpx
import pytest
from botocore.credentials import Credentials

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


@pytest.fixture
def boto_session():
    return boto3.Session(aws_access_key_id="AKIDEXAMPLE", aws_secret_access_key="secret", region_name="us-west-2")


@pytest.fixture
def captured_requests():
    return []


def _serve(model, captured_requests):
    """Route the model's HTTP calls to a canned streaming response, recording each request."""

    def handler(request):
        captured_requests.append(request)
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, text=SSE_TEXT_RESPONSE)

    model.client._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_nested_names():
    assert BedrockModel.Messages is BedrockMessagesModel
    assert issubclass(BedrockModel.Messages, AnthropicModel)
    assert BedrockModel.ConverseStream is BedrockModel


def test_importing_bedrock_does_not_import_anthropic():
    code = "import sys, strands.models.bedrock; assert 'anthropic' not in sys.modules"

    subprocess.run([sys.executable, "-c", code], check=True)


@pytest.mark.parametrize(
    ("endpoint", "expected_url"),
    [
        ("bedrock-runtime", "https://bedrock-runtime.us-west-2.amazonaws.com/anthropic/v1/messages"),
        ("bedrock-mantle", "https://bedrock-mantle.us-west-2.api.aws/anthropic/v1/messages"),
    ],
)
def test_agent_call_is_sigv4_signed_for_endpoint(endpoint, expected_url, boto_session, captured_requests):
    model = BedrockModel.Messages(
        model_id="anthropic.claude-haiku-4-5", max_tokens=16, endpoint=endpoint, boto_session=boto_session
    )
    _serve(model, captured_requests)

    result = Agent(model=model, callback_handler=None)("hello")

    assert str(result).strip() == "hi"
    request = captured_requests[0]
    assert str(request.url) == expected_url
    assert request.headers["authorization"].startswith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/")
    assert "/us-west-2/bedrock/aws4_request" in request.headers["authorization"]
    assert "x-api-key" not in request.headers


def test_each_request_is_signed_with_the_sessions_current_credentials(captured_requests):
    session = unittest.mock.Mock(spec=boto3.Session, region_name="us-west-2")
    session.get_credentials.side_effect = [Credentials("AKIDFIRST", "s1"), Credentials("AKIDSECOND", "s2")]
    model = BedrockModel.Messages(model_id="m", max_tokens=16, boto_session=session)
    _serve(model, captured_requests)
    agent = Agent(model=model, callback_handler=None)

    agent("one")
    agent("two")

    assert "Credential=AKIDFIRST/" in captured_requests[0].headers["authorization"]
    assert "Credential=AKIDSECOND/" in captured_requests[1].headers["authorization"]


def test_missing_credentials_raise(captured_requests):
    session = unittest.mock.Mock(spec=boto3.Session, region_name="us-west-2")
    session.get_credentials.return_value = None
    model = BedrockModel.Messages(model_id="m", max_tokens=16, boto_session=session)
    _serve(model, captured_requests)

    with pytest.raises(RuntimeError, match="Could not resolve AWS credentials"):
        Agent(model=model, callback_handler=None)("hello")


def test_api_key_is_sent_instead_of_signing(captured_requests):
    model = BedrockModel.Messages(model_id="m", max_tokens=16, region_name="us-east-1", api_key="bedrock-key")
    _serve(model, captured_requests)

    Agent(model=model, callback_handler=None)("hello")

    request = captured_requests[0]
    assert str(request.url) == "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic/v1/messages"
    assert request.headers["x-api-key"] == "bedrock-key"
    assert "authorization" not in request.headers


def test_anthropic_credentials_in_the_environment_are_not_sent(monkeypatch, boto_session, captured_requests):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-secret")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "anthropic-token")
    model = BedrockModel.Messages(model_id="m", max_tokens=16, boto_session=boto_session)
    _serve(model, captured_requests)

    Agent(model=model, callback_handler=None)("hello")

    headers = captured_requests[0].headers
    assert "x-api-key" not in headers
    assert "anthropic-token" not in headers["authorization"]


@pytest.mark.parametrize(
    ("region_args", "env_region", "expected_region"),
    [
        ({"region_name": "eu-west-1"}, "us-east-2", "eu-west-1"),
        ({"boto_session": boto3.Session(region_name="ap-south-1")}, "us-east-2", "ap-south-1"),
        ({}, "us-east-2", "us-east-2"),
    ],
)
def test_region_resolution(region_args, env_region, expected_region, monkeypatch):
    monkeypatch.setenv("AWS_REGION", env_region)
    monkeypatch.delenv("AWS_DEFAULT_REGION", raising=False)

    model = BedrockModel.Messages(model_id="m", max_tokens=16, **region_args)

    assert str(model.client.base_url) == f"https://bedrock-runtime.{expected_region}.amazonaws.com/anthropic/"


def test_region_name_and_boto_session_are_exclusive(boto_session):
    with pytest.raises(ValueError, match="Cannot specify both"):
        BedrockModel.Messages(model_id="m", max_tokens=16, region_name="us-east-1", boto_session=boto_session)


def test_unknown_endpoint_raises():
    with pytest.raises(ValueError, match="unknown Bedrock endpoint"):
        BedrockModel.Messages(model_id="m", max_tokens=16, endpoint="bedrock-agent")  # type: ignore[arg-type]


def test_malformed_region_raises():
    with pytest.raises(ValueError):
        BedrockModel.Messages(model_id="m", max_tokens=16, region_name="us-east-1.evil.com#")
