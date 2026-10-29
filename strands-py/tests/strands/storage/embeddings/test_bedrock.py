"""Tests for BedrockEmbedder."""

import json
from unittest.mock import MagicMock, patch

import pytest
from botocore.config import Config

from strands.storage.embeddings.bedrock import DEFAULT_EMBEDDER_MODEL_ID, BedrockEmbedder
from strands.storage.search import Embedder
from strands.types.exceptions import StorageError


def make_response(payload):
    body = MagicMock()
    body.read.return_value = json.dumps(payload).encode()
    return {"body": body}


@pytest.fixture
def client():
    mock_client = MagicMock()
    mock_client.invoke_model.return_value = make_response({"embedding": [0.1, 0.2]})
    return mock_client


@pytest.fixture
def session(client):
    mock_session = MagicMock()
    mock_session.client.return_value = client
    return mock_session


class TestBedrockEmbedder:
    def test_is_an_embedder(self, session):
        assert isinstance(BedrockEmbedder(boto_session=session), Embedder)

    @pytest.mark.asyncio
    async def test_calls_bedrock_with_the_default_titan_model(self, session, client):
        vector = await BedrockEmbedder(boto_session=session).embed("hello")

        assert vector == [0.1, 0.2]
        client.invoke_model.assert_called_once_with(
            modelId=DEFAULT_EMBEDDER_MODEL_ID,
            contentType="application/json",
            accept="application/json",
            body=json.dumps({"inputText": "hello"}),
        )
        assert DEFAULT_EMBEDDER_MODEL_ID == "amazon.titan-embed-text-v2:0"

    @pytest.mark.asyncio
    async def test_passes_any_model_id_through_to_bedrock_unchecked(self, session, client):
        await BedrockEmbedder(model_id="some.future-embed-model", boto_session=session).embed("hello")

        assert client.invoke_model.call_args.kwargs["modelId"] == "some.future-embed-model"

    @pytest.mark.asyncio
    @pytest.mark.parametrize("payload", [{}, {"embedding": "nope"}, {"embeddings": {"float": [[0.1]]}}])
    async def test_raises_when_the_response_is_not_titan_shaped(self, session, client, payload):
        client.invoke_model.return_value = make_response(payload)

        with pytest.raises(StorageError, match="did not return a Titan-shaped"):
            await BedrockEmbedder(model_id="cohere.embed-v4:0", boto_session=session).embed("hello")

    def test_passes_region_to_the_session(self):
        with patch("boto3.Session") as session_class:
            BedrockEmbedder(region_name="eu-west-1")

        session_class.assert_called_once_with(region_name="eu-west-1")
        assert session_class.return_value.client.call_args.args == ("bedrock-runtime",)

    def test_uses_a_pre_configured_session_and_adds_the_user_agent(self, session):
        BedrockEmbedder(boto_session=session, boto_client_config=Config(read_timeout=5))

        config = session.client.call_args.kwargs["config"]
        assert config.read_timeout == 5
        assert config.user_agent_extra == "strands-agents"

    def test_raises_when_both_region_and_session_are_provided(self, session):
        with pytest.raises(StorageError, match="Cannot specify both region_name and boto_session"):
            BedrockEmbedder(region_name="us-east-1", boto_session=session)

    @pytest.mark.asyncio
    async def test_reuses_the_client_across_calls(self, session, client):
        embedder = BedrockEmbedder(boto_session=session)

        await embedder.embed("a")
        await embedder.embed("b")

        session.client.assert_called_once()
        assert client.invoke_model.call_count == 2
