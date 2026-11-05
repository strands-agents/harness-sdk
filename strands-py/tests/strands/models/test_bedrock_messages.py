import asyncio
import http.server
import re
import subprocess
import sys
import threading
import unittest.mock

import anthropic
import boto3
import httpx
import pytest
from botocore.credentials import Credentials

from strands import Agent
from strands.models import BedrockModel
from strands.models._bedrock_auth import _auth_class, _per_loop_transport_class, require_sdk_version
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
def responses():
    """Status codes to answer with, in order; a canned streaming reply once they run out."""
    return []


@pytest.fixture
def captured_requests():
    return []


@pytest.fixture(autouse=True)
def network(monkeypatch, responses, captured_requests):
    """Answer at the innermost transport, so the SDK's real client, the auth, and the per-loop pools all run."""

    async def handle_async_request(self, request):
        await request.aread()
        captured_requests.append(request)
        status = responses.pop(0) if responses else 200
        if status != 200:
            return httpx.Response(status, json={"type": "error", "error": {"type": "overloaded_error", "message": "x"}})
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, text=SSE_TEXT_RESPONSE)

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", handle_async_request)


def test_nested_names():
    assert BedrockModel.Messages is BedrockMessagesModel
    assert issubclass(BedrockModel.Messages, AnthropicModel)
    assert BedrockModel.ConverseStream is BedrockModel


def test_importing_bedrock_does_not_import_provider_sdks():
    code = "import sys, strands.models.bedrock; assert not {'anthropic', 'openai'} & set(sys.modules)"

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

    result = Agent(model=model, callback_handler=None)("hello")

    assert str(result).strip() == "hi"
    request = captured_requests[0]
    assert str(request.url) == expected_url
    assert request.headers["authorization"].startswith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/")
    service = "bedrock-mantle" if endpoint == "bedrock-mantle" else "bedrock"
    assert f"/us-west-2/{service}/aws4_request" in request.headers["authorization"]
    assert "x-api-key" not in request.headers


def test_each_request_is_signed_with_the_sessions_current_credentials(captured_requests):
    session = unittest.mock.Mock(spec=boto3.Session, region_name="us-west-2")
    session.get_credentials.side_effect = [Credentials("AKIDFIRST", "s1"), Credentials("AKIDSECOND", "s2")]
    agent = Agent(model=BedrockModel.Messages(model_id="m", max_tokens=16, boto_session=session), callback_handler=None)

    agent("one")
    agent("two")

    assert "Credential=AKIDFIRST/" in captured_requests[0].headers["authorization"]
    assert "Credential=AKIDSECOND/" in captured_requests[1].headers["authorization"]


def test_retried_requests_are_signed_again(boto_session, responses, captured_requests):
    responses.append(529)
    model = BedrockModel.Messages(
        model_id="m", max_tokens=16, boto_session=boto_session, client_args={"max_retries": 1}
    )

    with unittest.mock.patch("anthropic._base_client.AsyncAPIClient._calculate_retry_timeout", return_value=0):
        Agent(model=model, callback_handler=None)("hello")

    first, retry = captured_requests
    assert first.headers["x-stainless-retry-count"] != retry.headers["x-stainless-retry-count"]
    assert first.headers["authorization"] != retry.headers["authorization"]
    assert "x-stainless-retry-count" in retry.headers["authorization"]


def test_missing_credentials_raise():
    session = unittest.mock.Mock(spec=boto3.Session, region_name="us-west-2")
    session.get_credentials.return_value = None
    model = BedrockModel.Messages(model_id="m", max_tokens=16, boto_session=session)

    with pytest.raises(anthropic.AnthropicError, match="Could not resolve AWS credentials"):
        Agent(model=model, callback_handler=None)("hello")


def test_api_key_is_sent_instead_of_signing(captured_requests):
    model = BedrockModel.Messages(model_id="m", max_tokens=16, region_name="us-east-1", api_key="bedrock-key")

    Agent(model=model, callback_handler=None)("hello")

    request = captured_requests[0]
    assert str(request.url) == "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic/v1/messages"
    assert request.headers["authorization"] == "Bearer bedrock-key"
    assert "x-api-key" not in request.headers


def test_anthropic_credentials_in_the_environment_are_not_sent(monkeypatch, boto_session, captured_requests):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-secret")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "anthropic-token")
    monkeypatch.setenv("ANTHROPIC_CUSTOM_HEADERS", "X-Gateway-Auth: gw-secret")
    model = BedrockModel.Messages(model_id="m", max_tokens=16, boto_session=boto_session)

    Agent(model=model, callback_handler=None)("hello")

    headers = captured_requests[0].headers
    assert "x-api-key" not in headers
    assert "x-gateway-auth" not in headers
    assert headers["authorization"].startswith("AWS4-HMAC-SHA256 ")


def test_bedrock_bearer_token_from_the_environment_is_used(monkeypatch, captured_requests):
    monkeypatch.setenv("AWS_BEARER_TOKEN_BEDROCK", "env-bedrock-key")

    Agent(model=BedrockModel.Messages(model_id="m", max_tokens=16), callback_handler=None)("hello")

    assert captured_requests[0].headers["authorization"] == "Bearer env-bedrock-key"


def test_imported_models_and_parent_client_option_are_rejected():
    with pytest.raises(ValueError, match="imported models"):
        BedrockModel.Messages(model_id="arn:aws:bedrock:us-west-2:123456789012:imported-model/abc", max_tokens=16)
    with pytest.raises(ValueError, match="not supported by BedrockModel.Messages"):
        BedrockModel.Messages(model_id="m", max_tokens=16, client=object())  # type: ignore[call-arg]


def test_connection_pools_are_per_event_loop_and_released_with_the_loop():
    transport = _per_loop_transport_class(httpx)(httpx.Limits())
    pools = []

    async def send():
        with unittest.mock.patch.object(httpx.AsyncClient, "send", return_value=httpx.Response(200)):
            await transport.handle_async_request(httpx.Request("GET", "https://example.com"))
        pools.append(transport._clients[asyncio.get_running_loop()])

    for _ in range(5):
        asyncio.run(send())

    assert len({id(pool) for pool in pools}) == 5
    assert len(transport._clients) == 1


def test_messages_client_uses_a_pool_per_event_loop(boto_session):
    model = BedrockModel.Messages(model_id="m", max_tokens=16, boto_session=boto_session)
    agent = Agent(model=model, callback_handler=None)

    transport = model.client._client._transport

    agent("one")
    (first,) = transport._clients.values()
    agent("two")
    (second,) = transport._clients.values()

    assert second is not first
    assert isinstance(second, httpx.AsyncClient)


@pytest.mark.parametrize("package", ["httpx", "httpx2"])
def test_streamed_request_bodies_are_read_before_signing(package, boto_session):
    http = pytest.importorskip(package)
    auth = _auth_class(http)(
        session=boto_session, region="us-west-2", service="bedrock", error_type=RuntimeError, api_key=None
    )

    async def body():
        yield b'{"a": '
        yield b"1}"

    async def sign():
        request = http.Request(
            "POST", "https://bedrock-runtime.us-west-2.amazonaws.com/anthropic/v1/messages", content=body()
        )
        flow = auth.async_auth_flow(request)
        return await flow.__anext__()

    request = asyncio.run(sign())

    assert request.content == b'{"a": 1}'
    assert request.headers["authorization"].startswith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/")


def test_sync_auth_flow_signs_and_sends_api_keys(boto_session):
    auth_class = _auth_class(httpx)
    signing = auth_class(
        session=boto_session, region="us-west-2", service="bedrock", error_type=RuntimeError, api_key=None
    )
    keyed = auth_class(
        session=boto_session, region="us-west-2", service="bedrock", error_type=RuntimeError, api_key="k"
    )

    signed = next(signing.sync_auth_flow(httpx.Request("POST", "https://example.com", content=b"{}")))
    with_key = next(keyed.sync_auth_flow(httpx.Request("POST", "https://example.com", content=b"{}")))

    assert signed.headers["authorization"].startswith("AWS4-HMAC-SHA256 ")
    assert with_key.headers["authorization"] == "Bearer k"


def test_old_sdk_versions_are_rejected_with_the_version_to_install():
    with pytest.raises(ImportError, match=re.escape("pip install -U 'anthropic>=0.98.0'")):
        require_sdk_version("anthropic", "0.97.3", (0, 98, 0), "BedrockModel.Messages")
    require_sdk_version("anthropic", "0.98.0", (0, 98, 0), "BedrockModel.Messages")


def test_proxy_environment_variables_apply(monkeypatch):
    monkeypatch.undo()
    seen = []

    class Proxy(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            seen.append(self.path)
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv("HTTP_PROXY", f"http://127.0.0.1:{server.server_port}")
    monkeypatch.delenv("NO_PROXY", raising=False)
    monkeypatch.delenv("no_proxy", raising=False)
    transport = _per_loop_transport_class(httpx)(httpx.Limits())

    async def get():
        async with httpx.AsyncClient(transport=transport) as client:
            return (await client.get("http://bedrock.invalid/path")).status_code

    try:
        assert asyncio.run(get()) == 200
    finally:
        server.shutdown()
        server.server_close()
    assert seen == ["http://bedrock.invalid/path"]


def test_missing_extra_is_reported_as_an_absent_attribute():
    code = (
        "import sys; sys.modules['anthropic'] = None\n"
        "from strands.models import BedrockModel\n"
        "assert not hasattr(BedrockModel, 'Messages')\n"
        'try:\n    BedrockModel.Messages\nexcept AttributeError as e:\n    assert "strands-agents[anthropic]" in str(e)'
    )

    subprocess.run([sys.executable, "-c", code], check=True)


def test_client_args_are_forwarded(boto_session, captured_requests):
    model = BedrockModel.Messages(
        model_id="m",
        max_tokens=16,
        boto_session=boto_session,
        client_args={"timeout": 12.5, "default_headers": {"X-Trace": "t1"}},
    )

    Agent(model=model, callback_handler=None)("hello")

    assert model.client.timeout == 12.5
    assert captured_requests[0].headers["x-trace"] == "t1"
    assert "x-trace" in captured_requests[0].headers["authorization"]


@pytest.mark.parametrize("owned", ["base_url", "api_key", "skip_auth", "aws_profile", "http_client"])
def test_client_args_cannot_override_bedrock_settings(owned):
    with pytest.raises(ValueError, match="set by BedrockModel.Messages"):
        BedrockModel.Messages(model_id="m", max_tokens=16, client_args={owned: "x"})


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
