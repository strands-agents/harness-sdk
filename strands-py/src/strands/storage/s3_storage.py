"""Amazon S3 storage implementation."""

from __future__ import annotations

import asyncio
import builtins
from typing import TYPE_CHECKING, Any

from ..types.exceptions import StorageError
from .storage import _NamespacedStorage, _normalize_key, _normalize_prefix

if TYPE_CHECKING:
    from .storage import StorageSearchResult

_S3_PAGE_SIZE = 1000


class S3Storage:
    """Persists bytes as objects in an Amazon S3 bucket.

    The AWS SDK (boto3) is imported lazily on first use so applications that
    never use S3 don't pay the import cost.

    Example:
        ```python
        from strands.storage import S3Storage

        storage = S3Storage("my-bucket", prefix="agents/")
        await storage.write("session/abc/state.json", data)
        ```
    """

    def __init__(
        self,
        bucket: str,
        *,
        prefix: str = "",
        region_name: str | None = None,
        boto_session: Any = None,
        boto_client_config: Any = None,
    ) -> None:
        """Initialize S3 storage.

        Args:
            bucket: S3 bucket name.
            prefix: Key prefix prepended to every key (namespace within the bucket).
            region_name: AWS region override.
            boto_session: Pre-configured boto3 session. Cannot combine with region_name.
            boto_client_config: Botocore Config object for the S3 client.

        Raises:
            StorageError: If both region_name and boto_session are provided.
        """
        if region_name is not None and boto_session is not None:
            raise StorageError("Cannot specify both region_name and boto_session")

        self._bucket = bucket
        normalized = _normalize_prefix(prefix)
        self._prefix = f"{normalized}/" if normalized else ""
        self._region_name = region_name
        self._boto_session = boto_session
        self._boto_client_config = boto_client_config
        self._client: Any = None

    async def write(self, key: str, data: bytes) -> None:
        """Store data as an S3 object.

        Args:
            key: Opaque string key identifying the value.
            data: Raw bytes to persist.

        Raises:
            StorageError: If the write fails.
        """
        normalized = _normalize_key(key)
        client = self._get_client()
        object_key = f"{self._prefix}{normalized}"

        try:
            await asyncio.to_thread(client.put_object, Bucket=self._bucket, Key=object_key, Body=data)
        except Exception as error:
            raise StorageError(f"Failed to write '{key}' to S3") from error

    async def read(self, key: str) -> bytes | None:
        """Read an S3 object.

        Args:
            key: The key to read.

        Returns:
            The object contents as bytes, or None if the key does not exist.

        Raises:
            StorageError: If the read fails for a reason other than a missing key.
        """
        normalized = _normalize_key(key)
        client = self._get_client()
        object_key = f"{self._prefix}{normalized}"

        try:
            response = await asyncio.to_thread(client.get_object, Bucket=self._bucket, Key=object_key)
            return await asyncio.to_thread(response["Body"].read)
        except client.exceptions.NoSuchKey:
            return None
        except Exception as error:
            resp = getattr(error, "response", None)
            if resp and resp.get("Error", {}).get("Code") == "NoSuchKey":
                return None
            raise StorageError(f"Failed to read '{key}' from S3") from error

    async def delete(self, key: str) -> None:
        """Delete an S3 object. No-op if the key does not exist.

        Args:
            key: The key to delete.

        Raises:
            StorageError: If the delete fails.
        """
        normalized = _normalize_key(key)
        client = self._get_client()
        object_key = f"{self._prefix}{normalized}"

        try:
            await asyncio.to_thread(client.delete_object, Bucket=self._bucket, Key=object_key)
        except Exception as error:
            raise StorageError(f"Failed to delete '{key}' from S3") from error

    async def list(self, query: str = "") -> builtins.list[str]:
        """List S3 objects matching the given prefix.

        Paginates automatically for large result sets.

        Args:
            query: A prefix string to filter keys. Empty string matches all.

        Returns:
            Matching keys sorted ascending, with the storage-level prefix stripped.

        Raises:
            StorageError: If the listing fails.
        """
        prefix = _normalize_prefix(query)
        client = self._get_client()
        s3_prefix = f"{self._prefix}{prefix}"

        try:
            return await asyncio.to_thread(self._list_sync, client, s3_prefix)
        except Exception as error:
            raise StorageError(f"Failed to list keys with prefix '{query}' from S3") from error

    def _list_sync(self, client: Any, s3_prefix: str) -> builtins.list[str]:
        """Paginate list_objects_v2 synchronously (called via to_thread)."""
        keys: builtins.list[str] = []
        continuation_token: str | None = None

        while True:
            kwargs: dict[str, Any] = {
                "Bucket": self._bucket,
                "Prefix": s3_prefix,
                "MaxKeys": _S3_PAGE_SIZE,
            }
            if continuation_token:
                kwargs["ContinuationToken"] = continuation_token

            response = client.list_objects_v2(**kwargs)

            for obj in response.get("Contents", []):
                key = obj["Key"]
                if self._prefix and key.startswith(self._prefix):
                    key = key[len(self._prefix) :]
                keys.append(key)

            if not response.get("IsTruncated"):
                break
            continuation_token = response.get("NextContinuationToken")

        return sorted(keys)

    async def search(self, query: str) -> builtins.list[StorageSearchResult]:
        """Search stored content by keyword token-overlap scoring.

        Args:
            query: Natural-language search query.

        Returns:
            All matches with relevance scores, ranked best-first.
        """
        from .search.keyword import KeywordSearchStrategy

        return await KeywordSearchStrategy().search(self, query)

    def namespace(self, prefix: str) -> _NamespacedStorage:
        """Return a view of this storage with all keys prefixed.

        Args:
            prefix: Prefix to prepend to all keys.

        Returns:
            A namespaced storage view.
        """
        return _NamespacedStorage(self, prefix)

    def _get_client(self) -> Any:
        """Lazily create and cache the S3 client."""
        if self._client is not None:
            return self._client

        import boto3
        from botocore.config import Config

        config = self._boto_client_config
        if config is None:
            config = Config(user_agent_extra="strands-agents")
        elif not getattr(config, "user_agent_extra", None):
            config = config.merge(Config(user_agent_extra="strands-agents"))

        if self._boto_session is not None:
            session = self._boto_session
        else:
            session = boto3.Session(region_name=self._region_name)

        self._client = session.client("s3", config=config)
        return self._client
