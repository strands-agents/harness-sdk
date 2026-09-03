"""Tests for offload storage backends.

The ``Storage`` protocol is async (``store``/``retrieve`` are coroutines), so
these tests await those calls. The thread-safety tests drive the async API from
real OS threads via ``asyncio.run`` to keep exercising the backends' locks.
"""

import asyncio
import threading
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from strands.vended_plugins.context_offloader import (
    FileStorage,
    InMemoryStorage,
    S3Storage,
)
from tests.fixtures.sandbox import TestSandbox


class TestInMemoryStorage:
    @pytest.mark.asyncio
    async def test_round_trip(self):
        storage = InMemoryStorage()
        ref = await storage.store("key_1", b"hello world")
        content, content_type = await storage.retrieve(ref)
        assert content == b"hello world"
        assert content_type == "text/plain"

    @pytest.mark.asyncio
    async def test_preserves_content_type(self):
        storage = InMemoryStorage()
        ref = await storage.store("key_1", b'{"a": 1}', "application/json")
        content, content_type = await storage.retrieve(ref)
        assert content == b'{"a": 1}'
        assert content_type == "application/json"

    @pytest.mark.asyncio
    async def test_stores_binary_content(self):
        storage = InMemoryStorage()
        img_bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100
        ref = await storage.store("key_1", img_bytes, "image/png")
        content, content_type = await storage.retrieve(ref)
        assert content == img_bytes
        assert content_type == "image/png"

    @pytest.mark.asyncio
    async def test_retrieve_missing_raises_key_error(self):
        storage = InMemoryStorage()
        with pytest.raises(KeyError, match="Reference not found"):
            await storage.retrieve("nonexistent_ref")

    @pytest.mark.asyncio
    async def test_unique_references(self):
        storage = InMemoryStorage()
        ref1 = await storage.store("key_1", b"content a")
        ref2 = await storage.store("key_1", b"content b")
        assert ref1 != ref2
        assert (await storage.retrieve(ref1))[0] == b"content a"
        assert (await storage.retrieve(ref2))[0] == b"content b"

    @pytest.mark.asyncio
    async def test_reference_format(self):
        storage = InMemoryStorage()
        ref = await storage.store("tool_abc", b"content")
        assert ref.startswith("mem_")
        assert "tool_abc" in ref

    def test_thread_safety(self):
        storage = InMemoryStorage()
        refs: list[str] = []
        errors: list[Exception] = []

        def store_item(i: int):
            try:
                ref = asyncio.run(storage.store(f"key_{i}", f"content_{i}".encode()))
                refs.append(ref)
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=store_item, args=(i,)) for i in range(50)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors
        assert len(set(refs)) == 50

    @pytest.mark.asyncio
    async def test_stores_empty_content(self):
        storage = InMemoryStorage()
        ref = await storage.store("key_1", b"")
        assert await storage.retrieve(ref) == (b"", "text/plain")

    @pytest.mark.asyncio
    async def test_clear(self):
        storage = InMemoryStorage()
        ref = await storage.store("key_1", b"content")
        storage.clear()
        with pytest.raises(KeyError):
            await storage.retrieve(ref)

    def test_clear_empty_storage(self):
        storage = InMemoryStorage()
        storage.clear()


class TestInMemoryStorageEviction:
    def test_evict_after_turns_validation(self):
        with pytest.raises(ValueError, match="evict_after_turns must be a positive integer"):
            InMemoryStorage(evict_after_turns=0)
        with pytest.raises(ValueError, match="evict_after_turns must be a positive integer"):
            InMemoryStorage(evict_after_turns=-1)

    @pytest.mark.asyncio
    async def test_eviction_enabled_by_default(self):
        storage = InMemoryStorage()
        assert storage._evict_after_turns == 20
        ref = await storage.store("key_1", b"content")
        for _ in range(21):
            storage._evict(storage._current_cycle + 1)
        with pytest.raises(KeyError):
            await storage.retrieve(ref)

    @pytest.mark.asyncio
    async def test_eviction_disabled_with_none(self):
        storage = InMemoryStorage(evict_after_turns=None)
        ref = await storage.store("key_1", b"content")
        for _ in range(100):
            storage._evict(storage._current_cycle + 1)
        assert await storage.retrieve(ref) == (b"content", "text/plain")

    @pytest.mark.asyncio
    async def test_entry_evicted_after_n_turns(self):
        storage = InMemoryStorage(evict_after_turns=3)
        ref = await storage.store("key_1", b"content")

        storage._evict(storage._current_cycle + 1)  # turn 1
        storage._evict(storage._current_cycle + 1)  # turn 2
        storage._evict(storage._current_cycle + 1)  # turn 3 — threshold = 3 - 3 = 0, stored at 0, 0 < 0 is false
        assert await storage.retrieve(ref) == (b"content", "text/plain")

        storage._evict(storage._current_cycle + 1)  # turn 4 — refreshed by retrieve to 3, 3 < 1 is false
        assert await storage.retrieve(ref) == (b"content", "text/plain")

    @pytest.mark.asyncio
    async def test_entry_evicted_without_access(self):
        storage = InMemoryStorage(evict_after_turns=2)
        ref = await storage.store("key_1", b"content")

        storage._evict(storage._current_cycle + 1)  # turn 1
        storage._evict(storage._current_cycle + 1)  # turn 2 — threshold = 2 - 2 = 0, stored at 0, 0 < 0 is false
        # Entry still alive at exact boundary
        content, _ = await storage.retrieve(ref)
        assert content == b"content"

    @pytest.mark.asyncio
    async def test_entry_evicted_past_boundary(self):
        storage = InMemoryStorage(evict_after_turns=2)
        ref = await storage.store("key_1", b"content")

        storage._evict(storage._current_cycle + 1)  # turn 1
        storage._evict(storage._current_cycle + 1)  # turn 2
        storage._evict(storage._current_cycle + 1)  # turn 3 — threshold = 1, 0 < 1 → evicted
        with pytest.raises(KeyError):
            await storage.retrieve(ref)

    @pytest.mark.asyncio
    async def test_retrieve_refreshes_last_accessed(self):
        storage = InMemoryStorage(evict_after_turns=2)
        ref = await storage.store("key_1", b"content")

        storage._evict(storage._current_cycle + 1)  # turn 1
        await storage.retrieve(ref)  # refreshes last_accessed to turn 1

        storage._evict(storage._current_cycle + 1)  # turn 2
        storage._evict(storage._current_cycle + 1)  # turn 3 — threshold = 1, last_accessed = 1, 1 < 1 is false
        assert await storage.retrieve(ref) == (b"content", "text/plain")

    @pytest.mark.asyncio
    async def test_multiple_entries_evicted_independently(self):
        storage = InMemoryStorage(evict_after_turns=2)
        ref1 = await storage.store("key_1", b"first")

        storage._evict(storage._current_cycle + 1)  # turn 1
        ref2 = await storage.store("key_2", b"second")

        storage._evict(storage._current_cycle + 1)  # turn 2
        storage._evict(storage._current_cycle + 1)  # turn 3 — threshold = 1. ref1 evicted, ref2 survives
        with pytest.raises(KeyError):
            await storage.retrieve(ref1)
        assert await storage.retrieve(ref2) == (b"second", "text/plain")

    def test_evict_updates_current_cycle(self):
        storage = InMemoryStorage()
        assert storage._current_cycle == 0
        storage._evict(5)
        assert storage._current_cycle == 5

    def test_rejects_shared_storage_across_agents(self):
        storage = InMemoryStorage()
        storage._bind(1)
        with pytest.raises(ValueError, match="cannot be shared"):
            storage._bind(2)

    def test_allows_same_agent_repeated_bind(self):
        storage = InMemoryStorage()
        storage._bind(42)
        storage._bind(42)

    def test_thread_safety_with_eviction(self):
        storage = InMemoryStorage(evict_after_turns=5)
        refs: list[str] = []
        errors: list[Exception] = []

        def store_and_tick(i: int):
            try:
                ref = asyncio.run(storage.store(f"key_{i}", f"content_{i}".encode()))
                refs.append(ref)
                storage._evict(storage._current_cycle + 1)
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=store_and_tick, args=(i,)) for i in range(50)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors


class TestFileStorage:
    @pytest.mark.asyncio
    async def test_round_trip(self, tmp_path):
        storage = FileStorage(artifact_dir=str(tmp_path / "artifacts"))
        ref = await storage.store("key_1", b"hello world")
        content, content_type = await storage.retrieve(ref)
        assert content == b"hello world"
        assert content_type == "text/plain"

    @pytest.mark.asyncio
    async def test_preserves_content_type(self, tmp_path):
        storage = FileStorage(artifact_dir=str(tmp_path))
        ref = await storage.store("key_1", b'{"a": 1}', "application/json")
        content, content_type = await storage.retrieve(ref)
        assert content == b'{"a": 1}'
        assert content_type == "application/json"

    @pytest.mark.asyncio
    async def test_stores_binary_content(self, tmp_path):
        storage = FileStorage(artifact_dir=str(tmp_path))
        img_bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100
        ref = await storage.store("key_1", img_bytes, "image/png")
        content, content_type = await storage.retrieve(ref)
        assert content == img_bytes
        assert content_type == "image/png"

    @pytest.mark.asyncio
    async def test_extension_from_content_type(self, tmp_path):
        storage = FileStorage(artifact_dir=str(tmp_path))
        assert (await storage.store("k", b"text", "text/plain")).endswith(".txt")
        assert (await storage.store("k", b"{}", "application/json")).endswith(".json")
        assert (await storage.store("k", b"img", "image/png")).endswith(".png")
        assert (await storage.store("k", b"pdf", "application/pdf")).endswith(".pdf")

    @pytest.mark.asyncio
    async def test_extension_for_document_content_types(self, tmp_path):
        """Canonical document MIME types map to shell-friendly extensions."""
        storage = FileStorage(artifact_dir=str(tmp_path))
        assert (await storage.store("k", b"a,b", "text/csv")).endswith(".csv")
        assert (await storage.store("k", b"# hi", "text/markdown")).endswith(".md")
        assert (await storage.store("k", b"<p/>", "text/html")).endswith(".html")
        assert (await storage.store("k", b"doc", "application/msword")).endswith(".doc")
        docx_type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        assert (await storage.store("k", b"docx", docx_type)).endswith(".docx")
        assert (await storage.store("k", b"xls", "application/vnd.ms-excel")).endswith(".xls")
        xlsx_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        assert (await storage.store("k", b"xlsx", xlsx_type)).endswith(".xlsx")
        assert (await storage.store("k", b"\x00\x01", "application/octet-stream")).endswith(".bin")

    @pytest.mark.asyncio
    async def test_auto_creates_directory(self, tmp_path):
        artifact_dir = tmp_path / "nested" / "dir" / "artifacts"
        assert not artifact_dir.exists()
        storage = FileStorage(artifact_dir=str(artifact_dir))
        await storage.store("key_1", b"content")
        assert artifact_dir.exists()

    @pytest.mark.asyncio
    async def test_retrieve_missing_raises_key_error(self, tmp_path):
        storage = FileStorage(artifact_dir=str(tmp_path))
        with pytest.raises(KeyError, match="Reference not found"):
            await storage.retrieve("nonexistent.txt")

    @pytest.mark.asyncio
    async def test_unique_references(self, tmp_path):
        storage = FileStorage(artifact_dir=str(tmp_path))
        ref1 = await storage.store("key_1", b"content a")
        ref2 = await storage.store("key_1", b"content b")
        assert ref1 != ref2
        assert (await storage.retrieve(ref1))[0] == b"content a"
        assert (await storage.retrieve(ref2))[0] == b"content b"

    @pytest.mark.asyncio
    async def test_sanitizes_path_traversal(self, tmp_path):
        storage = FileStorage(artifact_dir=str(tmp_path))
        ref = await storage.store("../../etc/passwd", b"content")
        assert ".." not in ref
        assert "/" not in Path(ref).name

    @pytest.mark.asyncio
    async def test_reference_includes_artifact_dir(self, tmp_path):
        artifact_dir = str(tmp_path / "artifacts")
        storage = FileStorage(artifact_dir=artifact_dir)
        ref = await storage.store("key_1", b"content")
        assert Path(ref).parent == Path(artifact_dir)

    @pytest.mark.asyncio
    async def test_relative_artifact_dir_gives_relative_reference(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        storage = FileStorage(artifact_dir="./artifacts")
        ref = await storage.store("key_1", b"content")
        assert Path(ref).parent == Path("artifacts")
        content, content_type = await storage.retrieve(ref)
        assert content == b"content"
        assert content_type == "text/plain"

    @pytest.mark.asyncio
    async def test_retrieve_accepts_bare_filename(self, tmp_path):
        storage = FileStorage(artifact_dir=str(tmp_path))
        ref = await storage.store("key_1", b"hello world")
        filename = Path(ref).name
        content, content_type = await storage.retrieve(filename)
        assert content == b"hello world"
        assert content_type == "text/plain"

    @pytest.mark.asyncio
    async def test_retrieve_accepts_stem_without_extension(self, tmp_path):
        storage = FileStorage(artifact_dir=str(tmp_path))
        ref = await storage.store("key_1", b"hello world", "text/plain")
        stem = Path(ref).stem
        content, content_type = await storage.retrieve(stem)
        assert content == b"hello world"
        assert content_type == "text/plain"

    @pytest.mark.asyncio
    async def test_metadata_survives_across_instances(self, tmp_path):
        artifact_dir = str(tmp_path / "artifacts")
        storage1 = FileStorage(artifact_dir=artifact_dir)
        ref = await storage1.store("key_1", b"hello", "image/png")

        storage2 = FileStorage(artifact_dir=artifact_dir)
        content, content_type = await storage2.retrieve(ref)
        assert content == b"hello"
        assert content_type == "image/png"

    def test_corrupt_metadata_fallback(self, tmp_path):
        (tmp_path / ".metadata.json").write_text("not valid json", encoding="utf-8")
        storage = FileStorage(artifact_dir=str(tmp_path))
        assert storage._content_types == {}

    @pytest.mark.asyncio
    async def test_missing_metadata_fallback(self, tmp_path):
        storage = FileStorage(artifact_dir=str(tmp_path))
        ref = await storage.store("key_1", b"content", "image/png")

        storage._content_types.clear()
        _, content_type = await storage.retrieve(ref)
        assert content_type == "application/octet-stream"

    @pytest.mark.asyncio
    async def test_retrieve_rejects_path_traversal(self, tmp_path):
        storage = FileStorage(artifact_dir=str(tmp_path))
        with pytest.raises(KeyError, match="Reference not found"):
            await storage.retrieve("../../etc/passwd")


class TestS3Storage:
    @pytest.fixture
    def mock_s3_client(self):
        """Create a mock S3 client that stores objects in memory."""
        client = MagicMock()
        objects: dict[str, tuple[bytes, str]] = {}

        def put_object(Bucket, Key, Body, ContentType="application/octet-stream", **kwargs):
            objects[f"{Bucket}/{Key}"] = (Body, ContentType)

        def get_object(Bucket, Key, **kwargs):
            full_key = f"{Bucket}/{Key}"
            if full_key not in objects:
                error_response = {"Error": {"Code": "NoSuchKey", "Message": "Not found"}}
                raise ClientError(error_response, "GetObject")
            body_bytes, ct = objects[full_key]
            body = MagicMock()
            body.read.return_value = body_bytes
            return {"Body": body, "ContentType": ct}

        client.put_object.side_effect = put_object
        client.get_object.side_effect = get_object
        return client

    @pytest.fixture
    def storage(self, mock_s3_client):
        with patch("boto3.Session") as mock_session_cls:
            mock_session = MagicMock()
            mock_session.client.return_value = mock_s3_client
            mock_session_cls.return_value = mock_session
            return S3Storage(bucket="test-bucket", prefix="artifacts")

    @pytest.mark.asyncio
    async def test_round_trip(self, storage):
        ref = await storage.store("key_1", b"hello world")
        content, content_type = await storage.retrieve(ref)
        assert content == b"hello world"
        assert content_type == "text/plain"

    @pytest.mark.asyncio
    async def test_preserves_content_type(self, storage):
        ref = await storage.store("key_1", b"img", "image/png")
        content, content_type = await storage.retrieve(ref)
        assert content == b"img"
        assert content_type == "image/png"

    @pytest.mark.asyncio
    async def test_retrieve_missing_raises_key_error(self, storage):
        with pytest.raises(KeyError, match="Reference not found"):
            await storage.retrieve("nonexistent_key")

    @pytest.mark.asyncio
    async def test_unique_references(self, storage):
        ref1 = await storage.store("key_1", b"content a")
        ref2 = await storage.store("key_1", b"content b")
        assert ref1 != ref2
        assert (await storage.retrieve(ref1))[0] == b"content a"
        assert (await storage.retrieve(ref2))[0] == b"content b"

    @pytest.mark.asyncio
    async def test_reference_is_s3_uri(self, storage):
        ref = await storage.store("tool_abc", b"content")
        assert ref.startswith("s3://test-bucket/artifacts/")

    @pytest.mark.asyncio
    async def test_empty_prefix(self, mock_s3_client):
        with patch("boto3.Session") as mock_session_cls:
            mock_session = MagicMock()
            mock_session.client.return_value = mock_s3_client
            mock_session_cls.return_value = mock_session
            storage = S3Storage(bucket="test-bucket", prefix="")

        ref = await storage.store("tool_abc", b"content")
        assert ref.startswith("s3://test-bucket/")
        assert (await storage.retrieve(ref))[0] == b"content"

    @pytest.mark.asyncio
    async def test_retrieve_accepts_raw_key(self, storage, mock_s3_client):
        ref = await storage.store("key_1", b"hello world")
        raw_key = ref.removeprefix("s3://test-bucket/")
        content, content_type = await storage.retrieve(raw_key)
        assert content == b"hello world"
        assert content_type == "text/plain"

    @pytest.mark.asyncio
    async def test_retrieve_rejects_wrong_bucket_uri(self, storage):
        with pytest.raises(KeyError, match="Reference not found"):
            await storage.retrieve("s3://wrong-bucket/artifacts/some_key")

    @pytest.mark.asyncio
    async def test_retrieve_rejects_raw_key_outside_prefix(self, storage, mock_s3_client):
        # Regression for report 3858663: a raw key pointing outside the configured
        # prefix must not be readable, even when the object exists in the same bucket.
        mock_s3_client.put_object(Bucket="test-bucket", Key="private/secret.txt", Body=b"SECRET")
        with pytest.raises(KeyError, match="Reference not found"):
            await storage.retrieve("private/secret.txt")

    @pytest.mark.asyncio
    async def test_retrieve_rejects_s3_uri_outside_prefix(self, storage, mock_s3_client):
        # Regression for report 3858663: a same-bucket s3:// URI outside the configured
        # prefix must be rejected, not silently read.
        mock_s3_client.put_object(Bucket="test-bucket", Key="private/secret.txt", Body=b"SECRET")
        with pytest.raises(KeyError, match="Reference not found"):
            await storage.retrieve("s3://test-bucket/private/secret.txt")

    @pytest.mark.asyncio
    async def test_retrieve_rejects_sibling_prefix_key(self, storage, mock_s3_client):
        # Regression for report 3858663: the trailing-slash normalization must make
        # prefix "artifacts/" reject "artifactsX/...", not just fully-disjoint keys.
        mock_s3_client.put_object(Bucket="test-bucket", Key="artifactsX/secret.txt", Body=b"SECRET")
        with pytest.raises(KeyError, match="Reference not found"):
            await storage.retrieve("artifactsX/secret.txt")

    @pytest.mark.asyncio
    async def test_put_object_called_with_correct_params(self, storage, mock_s3_client):
        await storage.store("key_1", b"test content", "application/json")

        mock_s3_client.put_object.assert_called_once()
        call_kwargs = mock_s3_client.put_object.call_args[1]
        assert call_kwargs["Bucket"] == "test-bucket"
        assert call_kwargs["Key"].startswith("artifacts/")
        assert call_kwargs["Body"] == b"test content"
        assert call_kwargs["ContentType"] == "application/json"

    @pytest.mark.asyncio
    async def test_non_nosuchkey_error_propagates(self, storage, mock_s3_client):
        error_response = {"Error": {"Code": "AccessDenied", "Message": "Forbidden"}}
        mock_s3_client.get_object.side_effect = ClientError(error_response, "GetObject")

        with pytest.raises(ClientError, match="Forbidden"):
            await storage.retrieve("artifacts/some_key")


class TestFileStorageWithSandbox:
    """FileStorage routed through a sandbox (the path the plugin uses per agent)."""

    @pytest.fixture
    def storage(self, tmp_path):
        return FileStorage(artifact_dir=str(tmp_path / "artifacts"), sandbox=TestSandbox(str(tmp_path)))

    @pytest.mark.asyncio
    async def test_round_trip_through_sandbox(self, storage):
        ref = await storage.store("key_1", b"hello sandbox", "text/plain")
        content, content_type = await storage.retrieve(ref)
        assert content == b"hello sandbox"
        assert content_type == "text/plain"

    @pytest.mark.asyncio
    async def test_preserves_content_type_through_sandbox(self, storage):
        ref = await storage.store("key_1", b"\x89PNG", "image/png")
        content, content_type = await storage.retrieve(ref)
        assert content == b"\x89PNG"
        assert content_type == "image/png"

    @pytest.mark.asyncio
    async def test_reference_under_artifact_dir(self, storage, tmp_path):
        ref = await storage.store("key_1", b"data")
        assert ref.startswith(f"{tmp_path / 'artifacts'}/")

    @pytest.mark.asyncio
    async def test_retrieve_accepts_bare_filename(self, storage):
        ref = await storage.store("key_1", b"hello sandbox", "text/plain")
        filename = ref.split("/")[-1]
        content, content_type = await storage.retrieve(filename)
        assert content == b"hello sandbox"
        assert content_type == "text/plain"

    @pytest.mark.asyncio
    async def test_retrieve_accepts_stem_without_extension(self, storage):
        ref = await storage.store("key_1", b"hello sandbox", "text/plain")
        filename = ref.split("/")[-1]
        stem = filename.rsplit(".", 1)[0]
        content, content_type = await storage.retrieve(stem)
        assert content == b"hello sandbox"
        assert content_type == "text/plain"

    @pytest.mark.asyncio
    async def test_retrieve_rejects_path_outside_artifact_dir(self, storage):
        with pytest.raises(KeyError, match="Reference not found"):
            await storage.retrieve("/etc/passwd")

    @pytest.mark.asyncio
    async def test_retrieve_rejects_path_traversal(self, storage, tmp_path):
        with pytest.raises(KeyError, match="Reference not found"):
            await storage.retrieve(f"{tmp_path / 'artifacts'}/../secret.txt")

    @pytest.mark.asyncio
    async def test_retrieve_missing_reference(self, storage, tmp_path):
        with pytest.raises(KeyError, match="Reference not found"):
            await storage.retrieve(f"{tmp_path / 'artifacts'}/nope.txt")

    @pytest.mark.asyncio
    async def test_metadata_survives_across_instances(self, tmp_path):
        artifact_dir = str(tmp_path / "artifacts")
        sandbox = TestSandbox(str(tmp_path))
        ref = await FileStorage(artifact_dir=artifact_dir, sandbox=sandbox).store("key_1", b"hello", "image/png")

        # A fresh instance lazily loads the content-type sidecar from the sandbox.
        _, content_type = await FileStorage(artifact_dir=artifact_dir, sandbox=sandbox).retrieve(ref)
        assert content_type == "image/png"

    @pytest.mark.asyncio
    async def test_missing_metadata_fallback(self, tmp_path):
        sandbox = TestSandbox(str(tmp_path))
        artifact_dir = str(tmp_path / "artifacts")
        storage = FileStorage(artifact_dir=artifact_dir, sandbox=sandbox)
        ref = await storage.store("key_1", b"content", "image/png")

        storage._content_types.clear()
        _, content_type = await storage.retrieve(ref)
        assert content_type == "application/octet-stream"

    def test_for_sandbox_keeps_explicit_sandbox(self, tmp_path):
        # An instance constructed with a sandbox is returned unchanged by for_sandbox.
        sandbox = TestSandbox(str(tmp_path))
        storage = FileStorage(artifact_dir=str(tmp_path), sandbox=sandbox)
        assert storage.for_sandbox(TestSandbox(str(tmp_path))) is storage

    def test_for_sandbox_binds_detached_instance(self, tmp_path):
        # A host instance (no sandbox) produces a new, sandbox-bound instance.
        host = FileStorage(artifact_dir=str(tmp_path))
        bound = host.for_sandbox(TestSandbox(str(tmp_path)))
        assert bound is not host
