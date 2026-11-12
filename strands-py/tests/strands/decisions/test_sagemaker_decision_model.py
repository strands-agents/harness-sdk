"""SageMakerDecisionModel tests — the behavioral spec for the SageMaker System One provider."""

import json
import unittest.mock
from typing import Any

import boto3
import pytest
from botocore.config import Config as BotocoreConfig
from botocore.exceptions import ClientError

from strands.decisions import SageMakerDecisionModel
from strands.types.exceptions import (
    ContextWindowOverflowException,
    ModelThrottledException,
    StructuredOutputException,
)

_ENDPOINT_NAME = "strands-decider-2b-qwen3-5-v1-2610"


class _FakeBody:
    def __init__(self, payload: bytes) -> None:
        self._payload = payload

    def read(self) -> bytes:
        return self._payload


def _response(payload: Any) -> dict[str, Any]:
    return {"Body": _FakeBody(json.dumps(payload).encode("utf-8"))}


def _sagemaker_error(code: str, **fields: Any) -> ClientError:
    error_response: dict[str, Any] = {"Error": {"Code": code, "Message": f"{code} message"}, **fields}
    return ClientError(error_response, "InvokeEndpoint")


@pytest.fixture
def mock_client():
    """Mock sagemaker-runtime client returned by boto3.client."""
    with unittest.mock.patch.object(boto3, "client") as mock_boto_client:
        client = unittest.mock.Mock()
        mock_boto_client.return_value = client
        yield mock_boto_client, client


def _sent_input(client: unittest.mock.Mock) -> dict[str, Any]:
    kwargs = client.invoke_endpoint.call_args.kwargs
    return {**kwargs, "Body": json.loads(kwargs["Body"].decode("utf-8"))}


async def _ask_error(decision: SageMakerDecisionModel) -> BaseException | None:
    try:
        await decision.ask("state", {"q": {"question": "ok?", "choices": "boolean"}})
    except BaseException as caught:  # noqa: BLE001
        return caught
    return None


class TestAsk:
    @pytest.mark.asyncio
    async def test_invokes_the_endpoint_with_the_system_one_body_and_maps_the_response(self, mock_client):
        _, client = mock_client
        client.invoke_endpoint.return_value = _response(
            {
                "model": "strands-decider-2B-qwen3.5-v1-2610",
                "answers": {"urgent": {"type": "noul", "noul": 0.9}},
                "usage": {"input_tokens": 86, "output_tokens": 1},
                "latency_ms": 1013.13,
            }
        )
        decision = SageMakerDecisionModel(_ENDPOINT_NAME)

        result = await decision.ask(
            "Payouts failing", {"urgent": {"question": "Is this urgent?", "choices": "boolean"}}
        )

        assert _sent_input(client) == {
            "EndpointName": _ENDPOINT_NAME,
            "ContentType": "application/json",
            "Accept": "application/json",
            "Body": {
                "state": "Payouts failing",
                "questions": {"urgent": {"type": "noul", "instructions": "Is this urgent?"}},
            },
        }
        assert result.answers == {"urgent": True}
        assert result.usage == {"inputTokens": 86, "outputTokens": 1, "totalTokens": 87}
        assert result.metadata.provider_name == "sagemaker"
        assert result.metadata.model_id == "strands-decider-2B-qwen3.5-v1-2610"
        assert result.metadata.confidence == {"urgent": pytest.approx(0.8)}
        assert result.metadata.latency_ms >= 0

    @pytest.mark.asyncio
    async def test_omits_the_model_from_the_request_body(self, mock_client):
        _, client = mock_client
        client.invoke_endpoint.return_value = _response({"model": "m", "answers": {"q": {"type": "noul", "noul": 1}}})
        decision = SageMakerDecisionModel(_ENDPOINT_NAME)

        await decision.ask("state", {"q": {"question": "ok?", "choices": "boolean"}})

        assert "model" not in _sent_input(client)["Body"]

    @pytest.mark.asyncio
    async def test_creates_one_client_with_region_name_taking_precedence_over_boto_client_config(self, mock_client):
        mock_boto_client, client = mock_client
        client.invoke_endpoint.return_value = _response({"model": "m", "answers": {"q": {"type": "noul", "noul": 1}}})
        decision = SageMakerDecisionModel(
            _ENDPOINT_NAME,
            region_name="us-east-1",
            boto_client_config=BotocoreConfig(region_name="us-west-2", read_timeout=5),
        )

        await decision.ask("state", {"q": {"question": "ok?", "choices": "boolean"}})
        await decision.ask("state", {"q": {"question": "ok?", "choices": "boolean"}})

        mock_boto_client.assert_called_once()
        call = mock_boto_client.call_args
        assert call.args == ("sagemaker-runtime",)
        assert call.kwargs["region_name"] == "us-east-1"
        config = call.kwargs["config"]
        assert config.read_timeout == 5
        assert "strands-agents" in config.user_agent_extra

    @pytest.mark.asyncio
    async def test_appends_the_sdk_user_agent_to_an_existing_one(self, mock_client):
        mock_boto_client, client = mock_client
        client.invoke_endpoint.return_value = _response({"model": "m", "answers": {"q": {"type": "noul", "noul": 1}}})
        decision = SageMakerDecisionModel(_ENDPOINT_NAME, boto_client_config=BotocoreConfig(user_agent_extra="my-app"))

        await decision.ask("state", {"q": {"question": "ok?", "choices": "boolean"}})

        assert mock_boto_client.call_args.kwargs["config"].user_agent_extra == "my-app strands-agents"

    @pytest.mark.asyncio
    async def test_uses_a_provided_client_as_is_instead_of_creating_one(self, mock_client):
        mock_boto_client, _ = mock_client
        provided = unittest.mock.Mock()
        provided.invoke_endpoint.return_value = _response({"model": "m", "answers": {"q": {"type": "noul", "noul": 1}}})
        decision = SageMakerDecisionModel(_ENDPOINT_NAME, client=provided)

        result = await decision.ask("state", {"q": {"question": "ok?", "choices": "boolean"}})

        assert result.answers == {"q": True}
        provided.invoke_endpoint.assert_called_once()
        assert provided.invoke_endpoint.call_args.kwargs["EndpointName"] == _ENDPOINT_NAME
        mock_boto_client.assert_not_called()

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "fields",
        [
            {"Error": {"Code": "ThrottlingException"}},
            {"Error": {"Code": "ModelNotReadyException"}},
            {"Error": {"Code": "ServiceUnavailable"}},
            {"Error": {"Code": "ModelError"}, "OriginalStatusCode": 429},
            {"Error": {"Code": "ModelError"}, "OriginalStatusCode": 503},
            {"Error": {"Code": "ModelError"}, "OriginalStatusCode": "429"},
            # A proxy or load balancer throttle has no SageMaker error code, only the HTTP status.
            {"Error": {"Code": "Unknown"}, "ResponseMetadata": {"HTTPStatusCode": 429}},
            {"Error": {"Code": "InternalFailure"}, "ResponseMetadata": {"HTTPStatusCode": 503}},
        ],
    )
    async def test_maps_to_model_throttled(self, mock_client, fields: dict[str, Any]):
        _, client = mock_client
        cause = ClientError(fields, "InvokeEndpoint")
        client.invoke_endpoint.side_effect = cause

        error = await _ask_error(SageMakerDecisionModel(_ENDPOINT_NAME))

        assert isinstance(error, ModelThrottledException)
        assert error.__cause__ is cause

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "fields",
        [
            {"OriginalStatusCode": 413},
            {
                "OriginalStatusCode": 422,
                "OriginalMessage": '{"detail":"prompt of 9000 tokens exceeds the context window of 8192 tokens"}',
            },
            {"OriginalStatusCode": "413"},
            {"ResponseMetadata": {"HTTPStatusCode": 413}},
        ],
    )
    async def test_maps_a_container_error_to_context_window_overflow(self, mock_client, fields: dict[str, Any]):
        _, client = mock_client
        client.invoke_endpoint.side_effect = _sagemaker_error("ModelError", **fields)

        error = await _ask_error(SageMakerDecisionModel(_ENDPOINT_NAME))

        assert isinstance(error, ContextWindowOverflowException)

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "code, fields",
        [
            (
                "ModelError",
                {
                    "OriginalStatusCode": 422,
                    "OriginalMessage": '{"detail":[{"msg":"choice requires at least 2 options"}]}',
                },
            ),
            # A validation error echoes the request, which may itself mention the context window.
            (
                "ModelError",
                {
                    "OriginalStatusCode": 422,
                    "OriginalMessage": '{"detail":[{"msg":"bad","input":{"context window":null}}]}',
                },
            ),
            ("ModelError", {"ResponseMetadata": {"HTTPStatusCode": 424}}),
            ("ValidationError", {}),
            ("InternalFailure", {}),
        ],
    )
    async def test_re_raises_other_errors_unchanged(self, mock_client, code: str, fields: dict[str, Any]):
        _, client = mock_client
        cause = _sagemaker_error(code, **fields)
        client.invoke_endpoint.side_effect = cause

        error = await _ask_error(SageMakerDecisionModel(_ENDPOINT_NAME))

        assert error is cause
        assert not isinstance(error, (ModelThrottledException, ContextWindowOverflowException))

    @pytest.mark.asyncio
    async def test_rejects_a_non_json_response_body(self, mock_client):
        _, client = mock_client
        client.invoke_endpoint.return_value = {"Body": _FakeBody(b"not json")}
        decision = SageMakerDecisionModel(_ENDPOINT_NAME)

        with pytest.raises(StructuredOutputException, match="non-JSON response"):
            await decision.ask("state", {"q": {"question": "ok?", "choices": "boolean"}})

    @pytest.mark.asyncio
    async def test_rejects_a_non_utf8_response_body(self, mock_client):
        _, client = mock_client
        client.invoke_endpoint.return_value = {"Body": _FakeBody(b"\xff\xfe")}
        decision = SageMakerDecisionModel(_ENDPOINT_NAME)

        with pytest.raises(StructuredOutputException, match="non-JSON response"):
            await decision.ask("state", {"q": {"question": "ok?", "choices": "boolean"}})

    @pytest.mark.asyncio
    async def test_rejects_an_empty_response_body_as_a_non_object_response(self, mock_client):
        _, client = mock_client
        client.invoke_endpoint.return_value = {"Body": _FakeBody(b"")}
        decision = SageMakerDecisionModel(_ENDPOINT_NAME)

        with pytest.raises(StructuredOutputException, match="decision provider response must be an object"):
            await decision.ask("state", {"q": {"question": "ok?", "choices": "boolean"}})


class TestConstruction:
    @pytest.mark.parametrize("endpoint_name", ["", "   "], ids=["empty", "whitespace"])
    def test_requires_an_endpoint_name(self, endpoint_name: str):
        with pytest.raises(ValueError, match="requires an endpoint_name"):
            SageMakerDecisionModel(endpoint_name)

    @pytest.mark.parametrize("threshold", [-0.1, 1.1, float("nan"), float("inf")])
    def test_rejects_an_invalid_default_threshold(self, mock_client, threshold: float):
        with pytest.raises(ValueError, match=r"default_min_confidence must be in \[0.0, 1.0\]"):
            SageMakerDecisionModel(_ENDPOINT_NAME, default_min_confidence=threshold)

    @pytest.mark.parametrize("options", [{"region_name": "us-east-1"}, {"boto_client_config": BotocoreConfig()}])
    def test_rejects_a_provided_client_combined_with_region_name_or_boto_client_config(self, options: dict[str, Any]):
        with pytest.raises(ValueError, match="Cannot specify both client and region_name/boto_client_config"):
            SageMakerDecisionModel(_ENDPOINT_NAME, client=unittest.mock.Mock(), **options)
