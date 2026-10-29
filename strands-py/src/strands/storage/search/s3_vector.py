"""Vector search for ``S3Storage``, backed by Amazon S3 Vectors."""

from __future__ import annotations

import asyncio
import builtins
import logging
from typing import TYPE_CHECKING, Any

from ..storage import StorageSearchResult

if TYPE_CHECKING:
    from ..embeddings.embedder import Embedder
    from ..s3_storage import S3Storage

logger = logging.getLogger(__name__)


class S3VectorSearchStrategy:
    """Vector search for :class:`~strands.storage.S3Storage`, backed by Amazon S3 Vectors.

    A derived index over the bucket: ``S3Storage`` calls :meth:`index` on every write (one embedder
    call plus a ``PutVectors``), :meth:`remove` on every delete, and :meth:`search` on search. Only
    works with ``S3Storage``; each storage backend pairs with its own native vector index, and only
    the :class:`~strands.storage.search.Embedder` is shared.

    The vector bucket and index must already exist, with a dimension matching the embedder (1024 for
    the default, Titan Text Embeddings V2). Clients default to the storage's session, else its region.
    Vectors are keyed by the full object key, so storages sharing a bucket under different prefixes can
    share one index.
    Empty and non-UTF-8 values are stored but not indexed, and clear any earlier vector for that key.
    Attach each instance to a single storage.

    Example:
        ```python
        from strands.storage import S3Storage
        from strands.storage.search import S3VectorSearchStrategy

        storage = S3Storage(
            "my-bucket",
            search_strategy=S3VectorSearchStrategy(vector_bucket_name="my-vectors", index_name="notes"),
        )
        ```
    """

    def __init__(
        self,
        *,
        vector_bucket_name: str,
        index_name: str,
        embedder: Embedder | None = None,
        max_results: int = 10,
        boto_session: Any = None,
        boto_client_config: Any = None,
    ) -> None:
        """Initialize the S3 Vectors search strategy.

        Args:
            vector_bucket_name: Name of an existing S3 Vectors bucket. Not created automatically. Do not
                share one index across storages on different buckets: results are filtered by prefix only.
            index_name: Name of an existing vector index in that bucket. Not created automatically, and
                its dimension must match the embedder.
            embedder: Produces the embedding vectors. Defaults to a ``BedrockEmbedder`` (Titan Text
                Embeddings V2) on the storage's ``boto_session``, or in the storage's region when it has
                none, created on first use.
            max_results: Maximum number of results to return. The limit applies before results are
                filtered to this storage's prefix (and to a ``namespace()`` view's prefix), so a search
                over a narrow prefix of a shared index can return fewer results.
            boto_session: Pre-configured boto3 session for the S3 Vectors client. Defaults to the
                storage's ``boto_session``, or a session in the storage's region when it has none.
            boto_client_config: Botocore Config object for the S3 Vectors client.
        """
        self._vector_bucket_name = vector_bucket_name
        self._index_name = index_name
        self._embedder: Embedder | None = embedder
        self._max_results = max_results
        self._boto_session = boto_session
        self._boto_client_config = boto_client_config
        self._client: Any = None

    async def index(self, storage: S3Storage, key: str, data: bytes, **kwargs: Any) -> None:
        """Embed and store a vector for the given key.

        Empty or non-UTF-8 values are not embedded. Any vector from a previous write to the same key
        is removed instead, so the index never matches content that is no longer stored.

        Args:
            storage: The storage the content was written to.
            key: The storage key to associate the vector with.
            data: The raw bytes to embed.
            **kwargs: Unused; accepted for forward compatibility.
        """
        text = _decode_text(data)
        if not text:
            logger.debug("key=<%s> | value is empty or not valid utf-8 text | removing any existing vector", key)
            await self.remove(storage, key)
            return
        vector = await self._get_embedder(storage).embed(text)
        await asyncio.to_thread(
            self._get_client(storage).put_vectors,
            vectorBucketName=self._vector_bucket_name,
            indexName=self._index_name,
            vectors=[{"key": storage.prefix + key, "data": {"float32": vector}}],
        )

    async def remove(self, storage: S3Storage, key: str) -> None:
        """Delete the vector associated with the given key. A no-op if none exists.

        Called by ``S3Storage`` on ``delete()``.

        Args:
            storage: The storage the content was deleted from.
            key: The storage key whose vector should be removed.
        """
        await asyncio.to_thread(
            self._get_client(storage).delete_vectors,
            vectorBucketName=self._vector_bucket_name,
            indexName=self._index_name,
            keys=[storage.prefix + key],
        )

    async def search(self, storage: S3Storage, query: str, **kwargs: Any) -> builtins.list[StorageSearchResult]:
        """Query the S3 Vectors index for keys similar to the query.

        Args:
            storage: The storage to search over.
            query: Natural-language search query.
            **kwargs: Unused; accepted for forward compatibility.

        Returns:
            Matched keys under the storage's prefix with similarity scores, ranked best-first.
        """
        query_vector = await self._get_embedder(storage).embed(query)
        response = await asyncio.to_thread(
            self._get_client(storage).query_vectors,
            vectorBucketName=self._vector_bucket_name,
            indexName=self._index_name,
            queryVector={"float32": query_vector},
            topK=self._max_results,
            returnDistance=True,
        )
        prefix = storage.prefix
        results: builtins.list[StorageSearchResult] = []
        for vector in response.get("vectors", []):
            vector_key = vector.get("key")
            if vector_key is None or not vector_key.startswith(prefix):
                continue
            distance = vector.get("distance")
            results.append(
                StorageSearchResult(
                    key=vector_key[len(prefix) :],
                    score=1 / (1 + distance) if distance is not None else 0.0,
                )
            )
        return results

    def _get_embedder(self, storage: S3Storage) -> Embedder:
        """Return the configured embedder, or create the default Bedrock embedder once on first use."""
        if self._embedder is None:
            from ..embeddings.bedrock import BedrockEmbedder

            if storage.boto_session is not None:
                self._embedder = BedrockEmbedder(boto_session=storage.boto_session)
            else:
                self._embedder = BedrockEmbedder(region_name=storage.region_name)
        return self._embedder

    def _get_client(self, storage: S3Storage) -> Any:
        """Create the S3 Vectors client once on first use, on the configured or storage's session."""
        if self._client is not None:
            return self._client

        import boto3
        from botocore.config import Config

        config = self._boto_client_config
        if config is None:
            config = Config(user_agent_extra="strands-agents")
        elif not getattr(config, "user_agent_extra", None):
            config = config.merge(Config(user_agent_extra="strands-agents"))

        session = self._boto_session or storage.boto_session or boto3.Session(region_name=storage.region_name)
        self._client = session.client("s3vectors", config=config)
        return self._client


def _decode_text(data: bytes) -> str | None:
    """Decode ``data`` as UTF-8, returning ``None`` for empty or non-UTF-8 input."""
    if not data:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as error:
        logger.debug("bytes=<%d>, error=<%s> | failed to decode value as utf-8", len(data), error)
        return None
