"""Tests for S3Storage."""

from unittest.mock import AsyncMock

import pytest

from strands.storage import S3Storage
from strands.types.exceptions import StorageError


@pytest.fixture
def s3_bucket():
    """Create a moto-mocked S3 bucket."""
    import boto3
    from moto import mock_aws

    with mock_aws():
        session = boto3.Session(region_name="us-east-1")
        client = session.client("s3")
        client.create_bucket(Bucket="test-bucket")
        yield session


@pytest.fixture
def storage(s3_bucket):
    return S3Storage("test-bucket", boto_session=s3_bucket)


class TestS3Storage:
    @pytest.mark.asyncio
    async def test_write_and_read(self, storage):
        await storage.write("key", b"hello")
        assert await storage.read("key") == b"hello"

    @pytest.mark.asyncio
    async def test_read_missing_returns_none(self, storage):
        assert await storage.read("nonexistent") is None

    @pytest.mark.asyncio
    async def test_write_overwrites(self, storage):
        await storage.write("key", b"first")
        await storage.write("key", b"second")
        assert await storage.read("key") == b"second"

    @pytest.mark.asyncio
    async def test_delete(self, storage):
        await storage.write("key", b"data")
        await storage.delete("key")
        assert await storage.read("key") is None

    @pytest.mark.asyncio
    async def test_delete_missing_is_noop(self, storage):
        await storage.delete("nonexistent")

    @pytest.mark.asyncio
    async def test_list_all(self, storage):
        await storage.write("b", b"")
        await storage.write("a", b"")
        await storage.write("c", b"")
        keys = await storage.list("")
        assert keys == ["a", "b", "c"]

    @pytest.mark.asyncio
    async def test_list_with_prefix(self, storage):
        await storage.write("sessions/a", b"")
        await storage.write("sessions/b", b"")
        await storage.write("offloader/x", b"")
        keys = await storage.list("sessions/")
        assert keys == ["sessions/a", "sessions/b"]

    @pytest.mark.asyncio
    async def test_key_normalization(self, storage):
        await storage.write("//foo///bar//", b"data")
        assert await storage.read("foo/bar") == b"data"

    @pytest.mark.asyncio
    async def test_rejects_path_traversal(self, storage):
        with pytest.raises(StorageError):
            await storage.write("../bad", b"data")

    @pytest.mark.asyncio
    async def test_namespace(self, storage):
        ns = storage.namespace("scope")
        await ns.write("key", b"value")
        assert await ns.read("key") == b"value"
        assert await storage.read("scope/key") == b"value"

    def test_rejects_both_region_and_session(self):
        import boto3

        with pytest.raises(StorageError, match="Cannot specify both"):
            S3Storage("bucket", region_name="us-east-1", boto_session=boto3.Session())

    @pytest.mark.asyncio
    async def test_write_error_raises_storage_error(self, s3_bucket):
        storage = S3Storage("nonexistent-bucket-xyz", boto_session=s3_bucket)
        with pytest.raises(StorageError, match="Failed to write"):
            await storage.write("key", b"data")

    @pytest.mark.asyncio
    async def test_read_error_raises_storage_error(self):
        from unittest.mock import MagicMock

        storage = S3Storage("bucket", region_name="us-east-1")
        mock_client = MagicMock()
        mock_client.exceptions = MagicMock()
        mock_client.exceptions.NoSuchKey = type("NoSuchKey", (Exception,), {})
        mock_client.get_object.side_effect = RuntimeError("connection reset")
        storage._client = mock_client
        with pytest.raises(StorageError, match="Failed to read"):
            await storage.read("key")

    @pytest.mark.asyncio
    async def test_read_nosuchkey_via_response_code(self):
        from unittest.mock import MagicMock

        storage = S3Storage("bucket", region_name="us-east-1")
        mock_client = MagicMock()
        mock_client.exceptions = MagicMock()
        mock_client.exceptions.NoSuchKey = type("NoSuchKey", (Exception,), {})
        error = Exception("not found")
        error.response = {"Error": {"Code": "NoSuchKey"}}
        mock_client.get_object.side_effect = error
        storage._client = mock_client
        assert await storage.read("key") is None

    @pytest.mark.asyncio
    async def test_delete_error_raises_storage_error(self, s3_bucket):
        storage = S3Storage("nonexistent-bucket-xyz", boto_session=s3_bucket)
        with pytest.raises(StorageError, match="Failed to delete"):
            await storage.delete("key")

    @pytest.mark.asyncio
    async def test_list_error_raises_storage_error(self, s3_bucket):
        storage = S3Storage("nonexistent-bucket-xyz", boto_session=s3_bucket)
        with pytest.raises(StorageError, match="Failed to list"):
            await storage.list("")

    @pytest.mark.asyncio
    async def test_list_pagination(self, storage):
        # Write more than would fit in a single page to exercise pagination
        for i in range(5):
            await storage.write(f"item_{i:03d}", b"data")
        keys = await storage.list("")
        assert len(keys) == 5
        assert keys == sorted(keys)

    def test_client_created_with_boto_session(self):
        from unittest.mock import MagicMock

        mock_session = MagicMock()
        mock_client = MagicMock()
        mock_session.client.return_value = mock_client
        storage = S3Storage("bucket", boto_session=mock_session)
        client = storage._get_client()
        mock_session.client.assert_called_once()
        assert client is mock_client

    def test_client_created_with_region(self):
        from unittest.mock import MagicMock, patch

        with patch("boto3.Session") as mock_session_cls:
            mock_session = MagicMock()
            mock_client = MagicMock()
            mock_session.client.return_value = mock_client
            mock_session_cls.return_value = mock_session
            storage = S3Storage("bucket", region_name="eu-west-1")
            client = storage._get_client()
            mock_session_cls.assert_called_once_with(region_name="eu-west-1")
            assert client is mock_client

    def test_client_merges_user_agent_on_existing_config(self):
        from unittest.mock import MagicMock

        from botocore.config import Config

        mock_session = MagicMock()
        mock_client = MagicMock()
        mock_session.client.return_value = mock_client
        config = Config(read_timeout=30)
        storage = S3Storage("bucket", boto_session=mock_session, boto_client_config=config)
        storage._get_client()
        call_kwargs = mock_session.client.call_args[1]
        assert "strands-agents" in call_kwargs["config"].user_agent_extra

    @pytest.mark.asyncio
    async def test_list_paginates(self):
        from unittest.mock import MagicMock

        mock_client = MagicMock()
        mock_client.list_objects_v2.side_effect = [
            {
                "IsTruncated": True,
                "NextContinuationToken": "token_1",
                "Contents": [{"Key": "a"}, {"Key": "b"}],
            },
            {
                "IsTruncated": False,
                "Contents": [{"Key": "c"}],
            },
        ]
        storage = S3Storage("bucket", region_name="us-east-1")
        storage._client = mock_client
        keys = await storage.list("")
        assert keys == ["a", "b", "c"]
        # Verify continuation token was passed on second call
        second_call_kwargs = mock_client.list_objects_v2.call_args_list[1][1]
        assert second_call_kwargs["ContinuationToken"] == "token_1"


    @pytest.mark.asyncio
    async def test_write_indexes_with_search_strategy(self, s3_bucket):
        strategy = AsyncMock()
        storage = S3Storage("test-bucket", boto_session=s3_bucket, search_strategy=strategy)
        await storage.write("key", b"data")
        strategy.index.assert_awaited_once_with(storage, "key", b"data")

    @pytest.mark.asyncio
    async def test_search_delegates_to_strategy(self, s3_bucket):
        strategy = AsyncMock()
        strategy.search.return_value = []
        storage = S3Storage("test-bucket", boto_session=s3_bucket, search_strategy=strategy)
        await storage.search("query")
        strategy.search.assert_awaited_once_with(storage, "query")


class TestS3StorageWithPrefix:
    @pytest.fixture
    def prefixed_storage(self, s3_bucket):
        return S3Storage("test-bucket", prefix="agents/data", boto_session=s3_bucket)

    @pytest.mark.asyncio
    async def test_prefix_scopes_keys(self, prefixed_storage, s3_bucket):
        await prefixed_storage.write("key", b"hello")
        # Verify the actual S3 key includes the prefix
        client = s3_bucket.client("s3")
        response = client.get_object(Bucket="test-bucket", Key="agents/data/key")
        assert response["Body"].read() == b"hello"

    @pytest.mark.asyncio
    async def test_list_strips_prefix(self, prefixed_storage):
        await prefixed_storage.write("a", b"")
        await prefixed_storage.write("b", b"")
        keys = await prefixed_storage.list("")
        assert keys == ["a", "b"]
