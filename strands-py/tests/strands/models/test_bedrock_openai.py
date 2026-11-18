import importlib.util

import httpx
import openai
import pytest

from strands import Agent
from strands.models import BedrockModel
from strands.models._bedrock_openai import BedrockChatCompletionsModel
from strands.models._bedrock_openai_responses import BedrockResponsesModel
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

# The installed openai release decides the HTTP package: httpx before 3.0, httpx2 since.
HTTP = pytest.importorskip("httpx2") if openai.__version__.startswith("3.") else httpx


@pytest.fixture(autouse=True)
def aws_environment(monkeypatch):
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIDEXAMPLE")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "secret")
    monkeypatch.setenv("AWS_REGION", "us-west-2")
    for name in ("AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_BEARER_TOKEN_BEDROCK", "OPENAI_API_KEY"):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def captured_requests():
    return []


@pytest.fixture(autouse=True)
def network(monkeypatch, captured_requests):
    """Answer at the innermost transport, so the OpenAI SDK's real client and the token auth run."""

    async def handle_async_request(self, request):
        await request.aread()
        captured_requests.append(request)
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
def test_requests_carry_a_bearer_token_minted_from_aws_credentials(endpoint, model_id, expected_url, captured_requests):
    agent = Agent(model=BedrockModel.ChatCompletions(model_id=model_id, endpoint=endpoint), callback_handler=None)

    result = agent("hello")
    agent("again")

    assert str(result).strip() == "hi"
    assert [str(request.url) for request in captured_requests] == [expected_url] * 2
    assert captured_requests[0].headers["authorization"].startswith("Bearer bedrock-api-key-")


@pytest.mark.parametrize("model_class", [BedrockChatCompletionsModel, BedrockResponsesModel])
@pytest.mark.parametrize("source", ["argument", "environment"])
def test_api_key_is_sent_and_the_mantle_path_follows_the_model(model_class, source, monkeypatch):
    kwargs = {"api_key": "bedrock-key"} if source == "argument" else {}
    if source == "environment":
        monkeypatch.setenv("AWS_BEARER_TOKEN_BEDROCK", "bedrock-key")
    model = model_class(model_id="openai.gpt-oss-120b", endpoint="bedrock-mantle", **kwargs)

    first = model._resolve_client_args()
    model.update_config(model_id="openai.gpt-5.1")
    second = model._resolve_client_args()

    assert first["api_key"] == "bedrock-key"
    assert first["base_url"] == "https://bedrock-mantle.us-west-2.api.aws/v1"
    assert second["base_url"] == "https://bedrock-mantle.us-west-2.api.aws/openai/v1"


def test_api_key_requests_reach_the_endpoint(captured_requests):
    model = BedrockModel.ChatCompletions(model_id="m", region_name="us-east-1", api_key="bedrock-key")

    Agent(model=model, callback_handler=None)("hello")

    request = captured_requests[0]
    assert str(request.url) == "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/chat/completions"
    assert request.headers["authorization"] == "Bearer bedrock-key"


@pytest.mark.parametrize("model_class", [BedrockChatCompletionsModel, BedrockResponsesModel])
@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"model_id": "arn:aws:bedrock:us-west-2:123456789012:imported-model/abc"}, "imported models"),
        ({"model_id": "m", "client_args": {"base_url": "https://example.com"}}, "remove them"),
        ({"model_id": "m", "client_args": {"api_key": "k"}}, "remove them"),
        ({"model_id": "m", "client": object()}, "not supported by BedrockModel"),
        ({"model_id": "m", "bedrock_mantle_config": {}}, "not supported by BedrockModel"),
        ({"model_id": "m", "endpoint": "bedrock-agent"}, "unknown Bedrock endpoint"),
    ],
)
def test_invalid_configuration_raises(model_class, kwargs, message):
    with pytest.raises(ValueError, match=message):
        model_class(**kwargs)


@pytest.mark.parametrize("model_class", [BedrockChatCompletionsModel, BedrockResponsesModel])
def test_signing_without_the_token_generator_raises_at_init(model_class, monkeypatch):
    real_find_spec = importlib.util.find_spec
    monkeypatch.setattr(
        importlib.util,
        "find_spec",
        lambda name, *args: None if name == "aws_bedrock_token_generator" else real_find_spec(name, *args),
    )

    with pytest.raises(ImportError, match=r"pip install aws-bedrock-token-generator, or pass a Bedrock api_key"):
        model_class(model_id="m")
    assert model_class(model_id="m", api_key="k").client_args == {}
