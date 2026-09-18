"""Tests for the shared Bedrock embedding helper."""

import json

import pytest
from botocore.exceptions import ClientError

from strands.vended_plugins._embedding import (
    BedrockEmbedder,
    EmbeddingError,
    cosine_similarity,
)


def _body(payload):
    from unittest.mock import MagicMock

    body = MagicMock()
    body.read.return_value = json.dumps(payload).encode()
    return {"body": body}


@pytest.fixture
def cohere_client():
    from unittest.mock import MagicMock

    client = MagicMock()
    client.calls = []

    def invoke_model(*, modelId, body):
        request = json.loads(body)
        client.calls.append(request)
        texts = request["texts"]
        # A distinct vector per text, and a distinct one per input_type, so a test can tell
        # which purpose produced a cached entry.
        offset = {"clustering": 0.0, "search_query": 10.0, "search_document": 20.0}[request["input_type"]]
        return _body({"embeddings": [[offset + len(text), 1.0] for text in texts]})

    client.invoke_model.side_effect = invoke_model
    return client


@pytest.fixture
def embedder(cohere_client):
    from unittest.mock import patch

    with patch("boto3.Session") as session_cls:
        session_cls.return_value.client.return_value = cohere_client
        yield BedrockEmbedder(purpose="clustering")


class TestCosineSimilarity:
    def test_identical_vectors_score_one(self):
        assert cosine_similarity([1.0, 2.0], [1.0, 2.0]) == pytest.approx(1.0)

    def test_opposite_vectors_clamp_to_zero(self):
        assert cosine_similarity([1.0, 0.0], [-1.0, 0.0]) == 0.0

    def test_length_mismatch_is_unrelated_not_an_error(self):
        assert cosine_similarity([1.0], [1.0, 2.0]) == 0.0

    def test_zero_magnitude_is_unrelated(self):
        assert cosine_similarity([0.0, 0.0], [1.0, 1.0]) == 0.0


class TestConstruction:
    def test_rejects_unknown_purpose(self):
        with pytest.raises(ValueError, match="purpose must be one of"):
            BedrockEmbedder(purpose="search_query")

    @pytest.mark.parametrize("size", [0, -1, True, 1.5])
    def test_rejects_invalid_cache_size(self, size):
        with pytest.raises(ValueError, match="cache_size must be None"):
            BedrockEmbedder(cache_size=size)

    def test_construction_opens_no_client(self):
        from unittest.mock import patch

        with patch("boto3.Session") as session_cls:
            BedrockEmbedder()
            session_cls.assert_not_called()


class TestPurpose:
    def test_default_purpose_is_used_when_not_overridden(self, embedder, cohere_client):
        embedder.embed(["alpha"])
        assert cohere_client.calls[0]["input_type"] == "clustering"

    @pytest.mark.parametrize(
        ("purpose", "expected"),
        [("clustering", "clustering"), ("query", "search_query"), ("document", "search_document")],
    )
    def test_purpose_maps_onto_cohere_input_type(self, embedder, cohere_client, purpose, expected):
        embedder.embed(["alpha"], purpose=purpose)
        assert cohere_client.calls[0]["input_type"] == expected

    def test_per_call_purpose_does_not_change_the_default(self, embedder, cohere_client):
        embedder.embed(["alpha"], purpose="query")
        embedder.embed(["beta"])
        assert [call["input_type"] for call in cohere_client.calls] == ["search_query", "clustering"]

    def test_rejects_unknown_purpose_per_call(self, embedder):
        with pytest.raises(ValueError, match="purpose must be one of"):
            embedder.embed(["alpha"], purpose="nonsense")


class TestCache:
    def test_same_text_under_two_purposes_is_not_shared(self, embedder, cohere_client):
        """The whole reason the cache key carries the purpose.

        Keying on text alone would return the query vector where the document vector was
        asked for, silently.
        """
        (as_query,) = embedder.embed(["alpha"], purpose="query")
        (as_document,) = embedder.embed(["alpha"], purpose="document")

        assert as_query != as_document
        assert len(cohere_client.calls) == 2

    def test_repeated_text_is_served_from_cache(self, embedder, cohere_client):
        first = embedder.embed(["alpha", "beta"])
        second = embedder.embed(["alpha", "beta"])

        assert first == second
        assert len(cohere_client.calls) == 1

    def test_only_misses_reach_bedrock(self, embedder, cohere_client):
        embedder.embed(["alpha"])
        embedder.embed(["alpha", "beta"])

        assert cohere_client.calls[1]["texts"] == ["beta"]

    def test_duplicate_text_in_one_batch_is_embedded_once(self, embedder, cohere_client):
        vectors = embedder.embed(["alpha", "alpha"])

        assert cohere_client.calls[0]["texts"] == ["alpha"]
        assert vectors[0] == vectors[1]

    def test_result_order_follows_the_input(self, embedder):
        vectors = embedder.embed(["a", "bbb", "cc"])
        assert [vector[0] for vector in vectors] == [1.0, 3.0, 2.0]

    def test_cache_evicts_least_recently_used(self, cohere_client):
        from unittest.mock import patch

        with patch("boto3.Session") as session_cls:
            session_cls.return_value.client.return_value = cohere_client
            small = BedrockEmbedder(cache_size=2)

            small.embed(["alpha"])
            small.embed(["beta"])
            small.embed(["alpha"])  # refreshes alpha, so gamma should evict beta
            small.embed(["gamma"])
            calls_before = len(cohere_client.calls)
            small.embed(["alpha"])  # still cached
            small.embed(["beta"])  # evicted, so it must be re-embedded

        assert len(cohere_client.calls) == calls_before + 1
        assert cohere_client.calls[-1]["texts"] == ["beta"]

    def test_unbounded_cache_keeps_everything(self, cohere_client):
        from unittest.mock import patch

        with patch("boto3.Session") as session_cls:
            session_cls.return_value.client.return_value = cohere_client
            unbounded = BedrockEmbedder(cache_size=None)
            unbounded.embed([str(index) for index in range(50)])
            calls_before = len(cohere_client.calls)
            unbounded.embed([str(index) for index in range(50)])

        assert len(cohere_client.calls) == calls_before


class TestBatching:
    def test_empty_input_makes_no_call(self, embedder, cohere_client):
        assert embedder.embed([]) == []
        assert cohere_client.calls == []

    def test_batches_are_paged_at_the_cohere_limit(self, embedder, cohere_client):
        vectors = embedder.embed([f"text-{index}" for index in range(200)])

        assert len(vectors) == 200
        assert [len(call["texts"]) for call in cohere_client.calls] == [96, 96, 8]

    def test_input_sequence_is_not_mutated(self, embedder):
        texts = ["alpha", "beta"]
        embedder.embed(texts)
        assert texts == ["alpha", "beta"]


class TestTitan:
    @pytest.fixture
    def titan(self):
        from unittest.mock import MagicMock, patch

        client = MagicMock()
        client.calls = []

        def invoke_model(*, modelId, body):
            request = json.loads(body)
            client.calls.append(request)
            return _body({"embedding": [float(len(request["inputText"])), 1.0]})

        client.invoke_model.side_effect = invoke_model

        with patch("boto3.Session") as session_cls:
            session_cls.return_value.client.return_value = client
            yield BedrockEmbedder("amazon.titan-embed-text-v2:0"), client

    def test_titan_is_one_call_per_text(self, titan):
        embedder, client = titan
        vectors = embedder.embed(["a", "bb"])

        assert len(vectors) == 2
        assert [call["inputText"] for call in client.calls] == ["a", "bb"]

    def test_titan_ignores_purpose(self, titan):
        embedder, client = titan
        embedder.embed(["a"], purpose="query")

        assert "input_type" not in client.calls[0]


class TestFailures:
    def _embedder_raising(self, error):
        from unittest.mock import MagicMock, patch

        client = MagicMock()
        client.invoke_model.side_effect = error
        patcher = patch("boto3.Session")
        session_cls = patcher.start()
        session_cls.return_value.client.return_value = client
        return BedrockEmbedder(), patcher

    def test_client_error_becomes_embedding_error(self):
        error = ClientError({"Error": {"Code": "ThrottlingException"}}, "InvokeModel")
        embedder, patcher = self._embedder_raising(error)
        try:
            with pytest.raises(EmbeddingError, match="embedding call failed"):
                embedder.embed(["alpha"])
        finally:
            patcher.stop()

    def test_short_response_is_rejected_rather_than_misaligned(self, cohere_client):
        from unittest.mock import patch

        cohere_client.invoke_model.side_effect = lambda *, modelId, body: _body({"embeddings": [[1.0, 2.0]]})

        with patch("boto3.Session") as session_cls:
            session_cls.return_value.client.return_value = cohere_client
            embedder = BedrockEmbedder()
            with pytest.raises(EmbeddingError, match="covered 1 of 2 texts"):
                embedder.embed(["alpha", "beta"])

    def test_missing_embeddings_key_is_rejected(self, cohere_client):
        from unittest.mock import patch

        cohere_client.invoke_model.side_effect = lambda *, modelId, body: _body({"unexpected": []})

        with patch("boto3.Session") as session_cls:
            session_cls.return_value.client.return_value = cohere_client
            with pytest.raises(EmbeddingError, match="missing 'embeddings'"):
                BedrockEmbedder().embed(["alpha"])

    def test_non_numeric_vector_is_rejected(self, cohere_client):
        from unittest.mock import patch

        cohere_client.invoke_model.side_effect = lambda *, modelId, body: _body({"embeddings": [["not-a-number"]]})

        with patch("boto3.Session") as session_cls:
            session_cls.return_value.client.return_value = cohere_client
            with pytest.raises(EmbeddingError, match="non-number"):
                BedrockEmbedder().embed(["alpha"])

    def test_failure_leaves_nothing_cached(self, cohere_client):
        from unittest.mock import patch

        cohere_client.invoke_model.side_effect = lambda *, modelId, body: _body({"unexpected": []})

        with patch("boto3.Session") as session_cls:
            session_cls.return_value.client.return_value = cohere_client
            embedder = BedrockEmbedder()
            with pytest.raises(EmbeddingError):
                embedder.embed(["alpha"])
            with pytest.raises(EmbeddingError):
                embedder.embed(["alpha"])

        assert cohere_client.invoke_model.call_count == 2


class TestAsync:
    @pytest.mark.asyncio
    async def test_async_returns_the_same_vectors(self, embedder):
        assert await embedder.embed_async(["alpha"]) == embedder.embed(["alpha"])

    @pytest.mark.asyncio
    async def test_async_empty_input_makes_no_call(self, embedder, cohere_client):
        assert await embedder.embed_async([]) == []
        assert cohere_client.calls == []

    @pytest.mark.asyncio
    async def test_all_cached_takes_no_thread(self, embedder, cohere_client):
        embedder.embed(["alpha"])
        await embedder.embed_async(["alpha"])
        assert len(cohere_client.calls) == 1

    @pytest.mark.asyncio
    async def test_async_validates_purpose(self, embedder):
        with pytest.raises(ValueError, match="purpose must be one of"):
            await embedder.embed_async(["alpha"], purpose="nonsense")

    @pytest.mark.asyncio
    async def test_async_propagates_embedding_error(self, cohere_client):
        from unittest.mock import patch

        cohere_client.invoke_model.side_effect = lambda *, modelId, body: _body({"unexpected": []})

        with patch("boto3.Session") as session_cls:
            session_cls.return_value.client.return_value = cohere_client
            with pytest.raises(EmbeddingError):
                await BedrockEmbedder().embed_async(["alpha"])


class TestClientConfiguration:
    def test_user_agent_is_appended_not_replaced(self, cohere_client):
        from unittest.mock import patch

        from botocore.config import Config as BotocoreConfig

        with patch("boto3.Session") as session_cls:
            session_cls.return_value.client.return_value = cohere_client
            embedder = BedrockEmbedder(boto_client_config=BotocoreConfig(user_agent_extra="caller-agent"))
            embedder.embed(["alpha"])

            config = session_cls.return_value.client.call_args.kwargs["config"]

        assert config.user_agent_extra == "caller-agent strands-agents"

    def test_caller_timeouts_win_over_defaults(self, cohere_client):
        from unittest.mock import patch

        from botocore.config import Config as BotocoreConfig

        with patch("boto3.Session") as session_cls:
            session_cls.return_value.client.return_value = cohere_client
            embedder = BedrockEmbedder(boto_client_config=BotocoreConfig(read_timeout=42))
            embedder.embed(["alpha"])

            config = session_cls.return_value.client.call_args.kwargs["config"]

        assert config.read_timeout == 42
        assert config.connect_timeout == 10

    def test_client_is_built_once_across_calls(self, cohere_client):
        from unittest.mock import MagicMock

        session = MagicMock()
        session.client.return_value = cohere_client
        embedder = BedrockEmbedder(boto_session=session)

        embedder.embed(["alpha"])
        embedder.embed(["beta"])
        embedder.embed(["gamma"], purpose="query")

        assert session.client.call_count == 1

    def test_supplied_session_is_used(self, cohere_client):
        from unittest.mock import MagicMock

        session = MagicMock()
        session.client.return_value = cohere_client
        embedder = BedrockEmbedder(boto_session=session)
        embedder.embed(["alpha"])

        assert session.client.call_args.kwargs["service_name"] == "bedrock-runtime"
