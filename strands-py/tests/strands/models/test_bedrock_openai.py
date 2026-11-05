import unittest.mock

import boto3
import openai
import pytest
from botocore.credentials import Credentials

from strands import Agent
from strands.models import BedrockModel
from strands.models._bedrock_auth import _http_package
from strands.models._bedrock_openai import BedrockChatCompletionsModel, BedrockResponsesModel
from strands.models.openai import OpenAIModel
from strands.models.openai_responses import OpenAIResponsesModel

CHAT_SSE_RESPONSE = "".join(
    f"data: {chunk}\n\n"
    for chunk in [
        '{"id":"c1","object":"chat.completion.chunk","created":0,"model":"m",'
        '"choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}',
        '{"id":"c1","object":"chat.completion.chunk","created":0,"model":"m",'
        '"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        "[DONE]",
    ]
)


@pytest.fixture
def boto_session():
    return boto3.Session(aws_access_key_id="AKIDEXAMPLE", aws_secret_access_key="secret", region_name="us-west-2")


@pytest.fixture
def captured_requests():
    return []


# The installed openai release decides the HTTP package: httpx before 3.0, httpx2 since.
HTTP = _http_package(openai.DefaultAsyncHttpxClient)


@pytest.fixture(autouse=True)
def network(monkeypatch, captured_requests):
    """Answer at the innermost transport, so the SDK's real client and the provider's auth both run."""

    async def handle_async_request(self, request):
        await request.aread()
        captured_requests.append(request)
        if request.url.path.endswith("/models"):
            return HTTP.Response(200, json={"object": "list", "data": []})
        return HTTP.Response(200, headers={"content-type": "text/event-stream"}, text=CHAT_SSE_RESPONSE)

    monkeypatch.setattr(HTTP.AsyncHTTPTransport, "handle_async_request", handle_async_request)


def test_nested_names():
    assert BedrockModel.ChatCompletions is BedrockChatCompletionsModel
    assert BedrockModel.Responses is BedrockResponsesModel
    assert issubclass(BedrockModel.ChatCompletions, OpenAIModel)
    assert issubclass(BedrockModel.Responses, OpenAIResponsesModel)


@pytest.mark.parametrize(
    ("endpoint", "model_id", "expected_url"),
    [
        (
            "bedrock-runtime",
            "openai.gpt-oss-120b-1:0",
            "https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1/chat/completions",
        ),
        ("bedrock-mantle", "openai.gpt-oss-120b", "https://bedrock-mantle.us-west-2.api.aws/v1/chat/completions"),
    ],
)
def test_chat_completions_agent_call_is_sigv4_signed(endpoint, model_id, expected_url, boto_session, captured_requests):
    model = BedrockModel.ChatCompletions(model_id=model_id, endpoint=endpoint, boto_session=boto_session)

    result = Agent(model=model, callback_handler=None)("hello")

    assert str(result).strip() == "hi"
    request = captured_requests[0]
    assert str(request.url) == expected_url
    assert request.headers["authorization"].startswith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/")
    service = "bedrock-mantle" if endpoint == "bedrock-mantle" else "bedrock"
    assert f"/us-west-2/{service}/aws4_request" in request.headers["authorization"]


def test_each_request_is_signed_with_the_sessions_current_credentials(captured_requests):
    session = unittest.mock.Mock(spec=boto3.Session, region_name="us-west-2")
    session.get_credentials.side_effect = [Credentials("AKIDFIRST", "s1"), Credentials("AKIDSECOND", "s2")]
    agent = Agent(model=BedrockModel.ChatCompletions(model_id="m", boto_session=session), callback_handler=None)

    agent("one")
    agent("two")

    assert "Credential=AKIDFIRST/" in captured_requests[0].headers["authorization"]
    assert "Credential=AKIDSECOND/" in captured_requests[1].headers["authorization"]


def test_missing_credentials_raise_without_retrying(captured_requests):
    session = unittest.mock.Mock(spec=boto3.Session, region_name="us-west-2")
    session.get_credentials.return_value = None
    model = BedrockModel.ChatCompletions(model_id="m", boto_session=session)

    with pytest.raises(openai.OpenAIError, match="Could not resolve AWS credentials"):
        Agent(model=model, callback_handler=None)("hello")
    assert session.get_credentials.call_count == 1


def test_openai_credentials_in_the_environment_are_not_sent(monkeypatch, boto_session, captured_requests):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openai-secret")
    model = BedrockModel.ChatCompletions(model_id="m", boto_session=boto_session)

    Agent(model=model, callback_handler=None)("hello")

    assert "sk-openai-secret" not in str(captured_requests[0].headers)
    assert captured_requests[0].headers["authorization"].startswith("AWS4-HMAC-SHA256 ")


def test_api_key_is_sent_on_every_request(captured_requests):
    agent = Agent(
        model=BedrockModel.ChatCompletions(model_id="m", region_name="us-east-1", api_key="bedrock-key"),
        callback_handler=None,
    )

    agent("one")
    agent("two")

    assert [str(request.url) for request in captured_requests] == [
        "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/chat/completions"
    ] * 2
    assert {request.headers["authorization"] for request in captured_requests} == {"Bearer bedrock-key"}


def test_bedrock_bearer_token_from_the_environment_is_used(monkeypatch, captured_requests):
    monkeypatch.setenv("AWS_BEARER_TOKEN_BEDROCK", "env-bedrock-key")

    Agent(model=BedrockModel.ChatCompletions(model_id="m"), callback_handler=None)("hello")

    assert captured_requests[0].headers["authorization"] == "Bearer env-bedrock-key"


def test_openai_organization_and_project_from_the_environment_are_not_sent(
    monkeypatch, boto_session, captured_requests
):
    monkeypatch.setenv("OPENAI_ORG_ID", "org-secret")
    monkeypatch.setenv("OPENAI_PROJECT_ID", "proj-secret")
    model = BedrockModel.ChatCompletions(
        model_id="m", boto_session=boto_session, client_args={"default_headers": {"X-Trace": "t1"}}
    )

    Agent(model=model, callback_handler=None)("hello")

    headers = captured_requests[0].headers
    assert "openai-organization" not in headers
    assert "openai-project" not in headers
    assert headers["x-trace"] == "t1"


@pytest.mark.asyncio
async def test_responses_requests_are_signed(boto_session, captured_requests):
    model = BedrockModel.Responses(model_id="openai.gpt-oss-120b", endpoint="bedrock-mantle", boto_session=boto_session)

    async with openai.AsyncOpenAI(**model._resolve_client_args()) as client:
        await client.models.list()

    request = captured_requests[0]
    assert str(request.url) == "https://bedrock-mantle.us-west-2.api.aws/v1/models"
    assert request.headers["authorization"].startswith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/")


@pytest.mark.parametrize("model_class", [BedrockChatCompletionsModel, BedrockResponsesModel])
def test_mantle_base_path_follows_the_current_model(model_class, boto_session):
    model = model_class(model_id="openai.gpt-oss-120b", endpoint="bedrock-mantle", boto_session=boto_session)
    assert model._resolve_client_args()["base_url"] == "https://bedrock-mantle.us-west-2.api.aws/v1"

    model.update_config(model_id="openai.gpt-5.1")

    assert model._resolve_client_args()["base_url"] == "https://bedrock-mantle.us-west-2.api.aws/openai/v1"


@pytest.mark.parametrize("model_class", [BedrockChatCompletionsModel, BedrockResponsesModel])
@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"model_id": "arn:aws:bedrock:us-west-2:123456789012:imported-model/abc"}, "imported models"),
        ({"model_id": "m", "client_args": {"base_url": "https://example.com"}}, "remove them"),
        ({"model_id": "m", "client_args": {"http_client": object()}}, "remove them"),
        ({"model_id": "m", "client": object()}, "not supported by BedrockModel"),
        ({"model_id": "m", "bedrock_mantle_config": {}}, "not supported by BedrockModel"),
        ({"model_id": "m", "endpoint": "bedrock-agent"}, "unknown Bedrock endpoint"),
        ({"model_id": "m", "region_name": "us-east-1", "boto_session": boto3.Session()}, "Cannot specify both"),
    ],
)
def test_invalid_configuration_raises(model_class, kwargs, message):
    with pytest.raises(ValueError, match=message):
        model_class(**kwargs)
