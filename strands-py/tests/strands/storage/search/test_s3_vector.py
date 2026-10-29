"""Tests for S3VectorSearchStrategy."""

import asyncio
from unittest.mock import MagicMock, patch

import pytest

from strands.storage import S3Storage
from strands.storage.search import Embedder, S3VectorSearchStrategy


class FakeEmbedder(Embedder):
    """Returns a fixed vector and records every text it embedded."""

    def __init__(self, vector=None, error=None):
        self.vector = vector or [0.1, 0.2, 0.3]
        self.error = error
        self.calls = []

    async def embed(self, text):
        self.calls.append(text)
        if self.error is not None:
            raise self.error
        return self.vector


@pytest.fixture
def client():
    mock_client = MagicMock()
    mock_client.query_vectors.return_value = {"vectors": []}
    return mock_client


@pytest.fixture
def session(client):
    mock_session = MagicMock()
    mock_session.client.return_value = client
    return mock_session


@pytest.fixture
def embedder():
    return FakeEmbedder()


def make_strategy(session, embedder, **overrides):
    return S3VectorSearchStrategy(
        vector_bucket_name="vectors", index_name="notes", embedder=embedder, boto_session=session, **overrides
    )


@pytest.fixture
def strategy(session, embedder):
    return make_strategy(session, embedder)


@pytest.fixture
def storage():
    return S3Storage("bucket", region_name="us-west-2")


class TestIndex:
    @pytest.mark.asyncio
    async def test_embeds_content_and_puts_a_vector(self, strategy, storage, embedder, client):
        await strategy.index(storage, "notes/a.md", b"hello world")

        assert embedder.calls == ["hello world"]
        client.put_vectors.assert_called_once_with(
            vectorBucketName="vectors",
            indexName="notes",
            vectors=[{"key": "notes/a.md", "data": {"float32": [0.1, 0.2, 0.3]}}],
        )

    @pytest.mark.asyncio
    @pytest.mark.parametrize("data", [b"", b"\xff\xfe\x00binary"], ids=["empty", "non-utf8"])
    async def test_removes_the_vector_instead_of_embedding_non_text(self, strategy, storage, embedder, client, data):
        await strategy.index(storage, "blob.bin", data)

        assert embedder.calls == []
        client.put_vectors.assert_not_called()
        client.delete_vectors.assert_called_once_with(vectorBucketName="vectors", indexName="notes", keys=["blob.bin"])

    @pytest.mark.asyncio
    async def test_propagates_embedder_errors_without_putting_a_vector(self, session, storage, client):
        strategy = make_strategy(session, FakeEmbedder(error=RuntimeError("throttled")))

        with pytest.raises(RuntimeError, match="throttled"):
            await strategy.index(storage, "a.md", b"text")
        client.put_vectors.assert_not_called()

    @pytest.mark.asyncio
    async def test_propagates_put_vectors_errors(self, strategy, storage, client):
        client.put_vectors.side_effect = RuntimeError("access denied")

        with pytest.raises(RuntimeError, match="access denied"):
            await strategy.index(storage, "a.md", b"text")


class TestRemove:
    @pytest.mark.asyncio
    async def test_deletes_the_vector_without_embedding(self, strategy, storage, embedder, client):
        await strategy.remove(storage, "a.md")

        assert embedder.calls == []
        client.delete_vectors.assert_called_once_with(vectorBucketName="vectors", indexName="notes", keys=["a.md"])


class TestSearch:
    @pytest.mark.asyncio
    async def test_embeds_the_query_and_returns_ranked_results(self, strategy, storage, embedder, client):
        client.query_vectors.return_value = {
            "vectors": [{"key": "a.md", "distance": 0.0}, {"key": "b.md", "distance": 1.0}],
        }

        results = await strategy.search(storage, "find notes")

        assert embedder.calls == ["find notes"]
        client.query_vectors.assert_called_once_with(
            vectorBucketName="vectors",
            indexName="notes",
            queryVector={"float32": [0.1, 0.2, 0.3]},
            topK=10,
            returnDistance=True,
        )
        assert [(result.key, result.score) for result in results] == [("a.md", 1.0), ("b.md", 0.5)]

    @pytest.mark.asyncio
    async def test_uses_custom_max_results(self, session, embedder, storage, client):
        strategy = make_strategy(session, embedder, max_results=3)

        await strategy.search(storage, "query")

        assert client.query_vectors.call_args.kwargs["topK"] == 3

    @pytest.mark.asyncio
    async def test_returns_empty_list_when_no_vectors_match(self, strategy, storage):
        assert await strategy.search(storage, "query") == []

    @pytest.mark.asyncio
    async def test_scores_zero_when_no_distance_is_returned(self, strategy, storage, client):
        client.query_vectors.return_value = {"vectors": [{"key": "a.md"}]}

        results = await strategy.search(storage, "query")

        assert [(result.key, result.score) for result in results] == [("a.md", 0.0)]

    @pytest.mark.asyncio
    async def test_drops_results_with_no_key(self, strategy, storage, client):
        client.query_vectors.return_value = {"vectors": [{"distance": 0.1}, {"key": "a.md", "distance": 0.0}]}

        results = await strategy.search(storage, "query")

        assert [result.key for result in results] == ["a.md"]

    @pytest.mark.asyncio
    async def test_propagates_query_vectors_errors(self, strategy, storage, client):
        client.query_vectors.side_effect = RuntimeError("index not found")

        with pytest.raises(RuntimeError, match="index not found"):
            await strategy.search(storage, "query")


class TestPrefixes:
    @pytest.mark.asyncio
    async def test_keys_vectors_by_the_prefixed_object_key(self, strategy, client):
        storage = S3Storage("bucket", prefix="agents/a")

        await strategy.index(storage, "x.md", b"text")
        await strategy.remove(storage, "y.md")

        assert client.put_vectors.call_args.kwargs["vectors"][0]["key"] == "agents/a/x.md"
        assert client.delete_vectors.call_args.kwargs["keys"] == ["agents/a/y.md"]

    @pytest.mark.asyncio
    async def test_returns_only_keys_under_the_prefix_with_the_prefix_stripped(self, strategy, client):
        storage = S3Storage("bucket", prefix="agents/a")
        client.query_vectors.return_value = {
            "vectors": [
                {"key": "agents/a/x.md", "distance": 0.0},
                {"key": "agents/b/x.md", "distance": 0.0},
            ],
        }

        results = await strategy.search(storage, "query")

        assert [result.key for result in results] == ["x.md"]

    @pytest.mark.asyncio
    async def test_keys_vectors_by_the_namespace_prefix_and_strips_it_on_search(self, strategy, client):
        scoped = S3Storage("bucket", prefix="agents").namespace("memory/a")
        client.query_vectors.return_value = {
            "vectors": [
                {"key": "agents/memory/a/x.md", "distance": 0.0},
                {"key": "agents/memory/b/x.md", "distance": 0.0},
            ],
        }

        await strategy.index(scoped, "x.md", b"text")
        results = await strategy.search(scoped, "query")

        assert client.put_vectors.call_args.kwargs["vectors"][0]["key"] == "agents/memory/a/x.md"
        assert [result.key for result in results] == ["x.md"]


class TestDefaults:
    @pytest.mark.asyncio
    async def test_uses_the_bedrock_embedder_in_the_storage_region_when_none_is_given(self, session, storage):
        strategy = make_strategy(session, None)

        with patch("strands.storage.embeddings.bedrock.BedrockEmbedder") as embedder_class:
            embedder_class.return_value = FakeEmbedder()
            await strategy.search(storage, "a")
            await strategy.search(storage, "b")

        embedder_class.assert_called_once_with(region_name="us-west-2")

    @pytest.mark.asyncio
    async def test_creates_one_default_embedder_for_concurrent_first_calls(self, session, storage):
        strategy = make_strategy(session, None)

        with patch("strands.storage.embeddings.bedrock.BedrockEmbedder") as embedder_class:
            embedder_class.return_value = FakeEmbedder()
            await asyncio.gather(strategy.search(storage, "a"), strategy.search(storage, "b"))

        embedder_class.assert_called_once()

    @pytest.mark.asyncio
    async def test_uses_the_default_region_chain_when_the_storage_has_no_region(self, session):
        strategy = make_strategy(session, None)

        with patch("strands.storage.embeddings.bedrock.BedrockEmbedder") as embedder_class:
            embedder_class.return_value = FakeEmbedder()
            await strategy.search(S3Storage("bucket"), "a")

        embedder_class.assert_called_once_with(region_name=None)

    @pytest.mark.asyncio
    async def test_default_embedder_uses_the_storage_session(self, session):
        storage_session = MagicMock()
        strategy = make_strategy(session, None)

        with patch("strands.storage.embeddings.bedrock.BedrockEmbedder") as embedder_class:
            embedder_class.return_value = FakeEmbedder()
            await strategy.search(S3Storage("bucket", boto_session=storage_session), "a")

        embedder_class.assert_called_once_with(boto_session=storage_session)

    @pytest.mark.asyncio
    async def test_creates_the_client_on_the_storage_session(self, embedder, client):
        storage_session = MagicMock()
        storage_session.client.return_value = client
        strategy = S3VectorSearchStrategy(vector_bucket_name="vectors", index_name="notes", embedder=embedder)

        with patch("boto3.Session") as session_class:
            await strategy.search(S3Storage("bucket", boto_session=storage_session), "a")

        session_class.assert_not_called()
        storage_session.client.assert_called_once()
        assert storage_session.client.call_args.args == ("s3vectors",)

    @pytest.mark.asyncio
    async def test_configured_session_takes_priority_over_the_storage_session(self, strategy, session):
        storage_session = MagicMock()
        await strategy.search(S3Storage("bucket", boto_session=storage_session), "a")

        session.client.assert_called_once()
        storage_session.client.assert_not_called()

    @pytest.mark.asyncio
    async def test_creates_the_client_once_in_the_storage_region(self, embedder, storage):
        strategy = S3VectorSearchStrategy(vector_bucket_name="vectors", index_name="notes", embedder=embedder)

        with patch("boto3.Session") as session_class:
            await strategy.search(storage, "a")
            await strategy.search(storage, "b")

        session_class.assert_called_once_with(region_name="us-west-2")
        session_class.return_value.client.assert_called_once()
        assert session_class.return_value.client.call_args.args == ("s3vectors",)

    @pytest.mark.asyncio
    async def test_uses_a_pre_configured_session(self, strategy, storage, session):
        await strategy.search(storage, "a")

        session.client.assert_called_once()
        assert session.client.call_args.args == ("s3vectors",)
        assert session.client.call_args.kwargs["config"].user_agent_extra == "strands-agents"
