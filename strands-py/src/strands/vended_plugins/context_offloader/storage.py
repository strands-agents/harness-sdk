"""Storage backends for offloaded tool result content.

.. deprecated::
    The storage classes in this module (``InMemoryStorage``, ``FileStorage``,
    ``S3Storage``) are deprecated. Use the unified storage backends from
    :mod:`strands.storage` instead::

        from strands.storage import InMemoryStorage, LocalFileStorage, S3Storage

Example:
    ```python
    from strands.storage import InMemoryStorage, LocalFileStorage, S3Storage

    # Unified storage backends
    storage = LocalFileStorage("./artifacts")
    storage = InMemoryStorage()
    storage = S3Storage("my-bucket", prefix="artifacts/")
    ```
"""

import json
import logging
import re
import threading
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol, runtime_checkable

import boto3
from botocore.config import Config as BotocoreConfig
from botocore.exceptions import ClientError

from .media_types import _extension_for_content_type

if TYPE_CHECKING:
    from ...sandbox.base import Sandbox

logger = logging.getLogger(__name__)


def _sanitize_id(raw_id: str) -> str:
    """Sanitize an ID for safe use in filenames and object keys.

    Replaces path separators, parent directory references, and other
    unsafe characters with underscores.

    Args:
        raw_id: The raw ID string.

    Returns:
        A sanitized string safe for use in filenames.
    """
    sanitized = raw_id.replace("..", "_").replace("/", "_").replace("\\", "_")
    sanitized = re.sub(r"[^\w\-.]", "_", sanitized)
    return sanitized


@runtime_checkable
class Storage(Protocol):
    """Backend for storing and retrieving offloaded content blocks.

    .. deprecated::
        Use :class:`strands.storage.Storage` instead.

    Each content block from a tool result is stored individually with its
    content type preserved. The SDK ships three built-in implementations:
    ``InMemoryStorage``, ``FileStorage``, and ``S3Storage``. Implement this
    protocol to create custom storage backends (e.g., Redis, DynamoDB).

    Lifecycle:
        This protocol intentionally does not include eviction or deletion methods.
        Stored content accumulates for the lifetime of the storage instance. For
        long-running agents, create a new storage instance per session or use a
        backend with built-in lifecycle management (e.g., S3 lifecycle policies).
    """

    async def store(self, key: str, content: bytes, content_type: str = "text/plain") -> str:
        """Store content and return a reference identifier.

        Args:
            key: A unique key for this content block.
            content: The raw content bytes to store.
            content_type: MIME type of the content (e.g., "text/plain",
                "application/json", "image/png", "application/pdf").

        Returns:
            A reference string that can be used to retrieve the content later.
        """
        ...

    async def retrieve(self, reference: str) -> tuple[bytes, str]:
        """Retrieve stored content by reference.

        Args:
            reference: The reference returned by a previous store() call.

        Returns:
            A tuple of (content bytes, content type).

        Raises:
            KeyError: If the reference is not found.
        """
        ...


class FileStorage:
    """Store offloaded content as files, on the host filesystem or through a sandbox.

    .. deprecated::
        Use :class:`strands.storage.LocalFileStorage` instead.

    Files are written to the configured artifact directory with unique names.
    File extensions are derived from the content type. A ``.metadata.json``
    sidecar file tracks content types so they survive process restarts.

    When constructed without a ``sandbox``, writes go to the host filesystem.
    When used by :class:`ContextOffloader`, the plugin binds a per-agent copy to
    that agent's sandbox (which may be the host default) via :meth:`for_sandbox`.

    Args:
        artifact_dir: Directory path where artifact files will be stored.
        sandbox: Optional sandbox to route file I/O through. When ``None``,
            the host filesystem is used directly.
    """

    _METADATA_FILE = ".metadata.json"

    def __init__(self, artifact_dir: str = "./artifacts", *, sandbox: "Sandbox | None" = None) -> None:
        """Initialize file-based storage.

        Args:
            artifact_dir: Directory path where artifact files will be stored.
            sandbox: Optional sandbox to route file I/O through.
        """
        self._artifact_dir = Path(artifact_dir)
        self._sandbox = sandbox
        self._counter: int = 0
        self._lock = threading.Lock()
        self._metadata_loaded = False
        # Host metadata can load eagerly; sandbox metadata loads lazily on first use
        # (the sandbox may be remote, so we avoid I/O during construction).
        if sandbox is None:
            self._content_types: dict[str, str] = self._load_metadata()
            self._metadata_loaded = True
        else:
            self._content_types = {}

    def for_sandbox(self, sandbox: "Sandbox") -> "FileStorage":
        """Return a storage instance bound to the given sandbox.

        Instances constructed with an explicit sandbox keep using it (returns
        ``self``). Otherwise a new instance is returned so a shared
        :class:`ContextOffloader` can isolate artifacts per agent sandbox.

        Args:
            sandbox: Sandbox to bind the returned instance to.

        Returns:
            A FileStorage routed through ``sandbox``.
        """
        if self._sandbox is not None:
            return self
        return FileStorage(str(self._artifact_dir), sandbox=sandbox)

    @staticmethod
    def _extension_for(content_type: str) -> str:
        """Return a file extension for the given content type."""
        return _extension_for_content_type(content_type)

    def _artifact_path(self, filename: str) -> str:
        """Join a filename onto the artifact dir, preserving its string form."""
        return f"{str(self._artifact_dir).rstrip('/')}/{filename}"

    def _resolve_reference(self, reference: str) -> str:
        """Normalize a reference to a known filename in ``_content_types``.

        Accepts full paths, bare filenames (with extension), and filename
        stems (without extension). Validates against path traversal.

        Args:
            reference: Full path, bare filename, or filename stem.

        Returns:
            The resolved filename (basename with extension).

        Raises:
            KeyError: If the reference cannot be resolved or fails validation.
        """
        if ".." in reference:
            raise KeyError(f"Reference not found: {reference}")

        ref_path = Path(reference)
        if len(ref_path.parts) > 1:
            if ref_path.parent.resolve() != self._artifact_dir.resolve():
                raise KeyError(f"Reference not found: {reference}")
            candidate = ref_path.name
        else:
            candidate = reference

        if candidate in self._content_types:
            return candidate

        matches = [key for key in self._content_types if Path(key).stem == candidate]
        if len(matches) == 1:
            return matches[0]

        raise KeyError(f"Reference not found: {reference}")

    async def store(self, key: str, content: bytes, content_type: str = "text/plain") -> str:
        """Store content as a file and return the path as reference.

        The returned path preserves the form of ``artifact_dir`` passed to
        the constructor: a relative ``artifact_dir`` yields a relative
        reference, an absolute one yields an absolute reference.

        Args:
            key: A unique key for this content block.
            content: The raw content bytes to store.
            content_type: MIME type of the content.

        Returns:
            The file path (e.g., ``./artifacts/1234_1_key.txt``).
        """
        sanitized_key = _sanitize_id(key)
        timestamp_ms = int(time.time() * 1000)
        ext = self._extension_for(content_type)

        if self._sandbox is not None:
            await self._ensure_sandbox_metadata()
            with self._lock:
                self._counter += 1
                filename = f"{timestamp_ms}_{self._counter}_{sanitized_key}{ext}"
                self._content_types[filename] = content_type
            # Persist the content-type sidecar, then the artifact itself.
            await self._sandbox.write_text(self._artifact_path(self._METADATA_FILE), json.dumps(self._content_types))
            file_path = self._artifact_path(filename)
            await self._sandbox.write_file(file_path, content)
            return file_path

        self._artifact_dir.mkdir(parents=True, exist_ok=True)
        with self._lock:
            self._counter += 1
            filename = f"{timestamp_ms}_{self._counter}_{sanitized_key}{ext}"
            self._content_types[filename] = content_type
            self._save_metadata()

        host_path = self._artifact_dir / filename
        host_path.write_bytes(content)
        return str(host_path)

    def _resolve_from_path(self, reference: str) -> str:
        """Validate a reference as a path within the artifact directory.

        Used as a fallback when ``_resolve_reference`` fails (metadata
        missing or corrupt). Only accepts full paths or bare filenames —
        stem matching requires metadata.

        Args:
            reference: A full path or bare filename.

        Returns:
            The validated filename (basename).

        Raises:
            KeyError: If the path is outside the artifact directory.
        """
        if ".." in reference:
            raise KeyError(f"Reference not found: {reference}")
        ref_path = Path(reference)
        if len(ref_path.parts) > 1:
            if ref_path.parent.resolve() != self._artifact_dir.resolve():
                raise KeyError(f"Reference not found: {reference}")
            return ref_path.name
        return reference

    async def retrieve(self, reference: str) -> tuple[bytes, str]:
        """Retrieve content from a stored file.

        Accepts full paths (as returned by ``store()``), bare filenames,
        and filename stems (without extension) for backward compatibility.

        Args:
            reference: The file path, filename, or stem returned by store().

        Returns:
            A tuple of (content bytes, content type).

        Raises:
            KeyError: If the file does not exist.
        """
        if self._sandbox is not None:
            await self._ensure_sandbox_metadata()
            try:
                filename = self._resolve_reference(reference)
            except KeyError:
                filename = self._resolve_from_path(reference)
            full_path = self._artifact_path(filename)
            try:
                content = await self._sandbox.read_file(full_path)
            except Exception as exc:
                raise KeyError(f"Reference not found: {reference}") from exc
            return content, self._content_types.get(filename, "application/octet-stream")

        try:
            filename = self._resolve_reference(reference)
        except KeyError:
            filename = self._resolve_from_path(reference)

        file_path = (self._artifact_dir / filename).resolve()
        if not file_path.is_relative_to(self._artifact_dir.resolve()) or not file_path.is_file():
            raise KeyError(f"Reference not found: {reference}")
        content_type = self._content_types.get(filename, "application/octet-stream")
        return file_path.read_bytes(), content_type

    async def _ensure_sandbox_metadata(self) -> None:
        """Lazily load the content-type sidecar from the sandbox on first use."""
        if self._metadata_loaded:
            return
        assert self._sandbox is not None
        try:
            raw = await self._sandbox.read_text(self._artifact_path(self._METADATA_FILE))
            loaded = json.loads(raw)
            self._content_types = loaded if isinstance(loaded, dict) else {}
        except Exception:
            self._content_types = {}
        self._metadata_loaded = True

    def _load_metadata(self) -> dict[str, str]:
        """Load content type metadata from the sidecar file (host filesystem)."""
        metadata_path = self._artifact_dir / self._METADATA_FILE
        if metadata_path.is_file():
            try:
                result: dict[str, str] = json.loads(metadata_path.read_text(encoding="utf-8"))
                return result
            except (json.JSONDecodeError, OSError):
                return {}
        return {}

    def _save_metadata(self) -> None:
        """Save content type metadata to the sidecar file (host filesystem)."""
        metadata_path = self._artifact_dir / self._METADATA_FILE
        metadata_path.write_text(json.dumps(self._content_types), encoding="utf-8")


class InMemoryStorage:
    """Store offloaded content in memory.

    .. deprecated::
        Use :class:`strands.storage.InMemoryStorage` instead.

    Useful for testing and serverless environments where disk access
    is not available or not desired. Thread-safe.

    Supports turn-based eviction: entries not accessed (stored or retrieved)
    within ``evict_after_turns`` agent loop cycles are automatically removed.
    The ``ContextOffloader`` plugin triggers eviction on each model invocation
    cycle. Eviction is enabled by default (20 cycles). Pass ``None`` to disable.

    Note:
        Content does not survive process restarts. For multi-session
        persistence, use ``FileStorage`` or ``S3Storage``. Each agent should
        use its own ``InMemoryStorage`` instance — sharing one across multiple
        agents is not supported when eviction is enabled.

        Evicted entries are permanently deleted from memory. The agent will
        receive an error if it attempts to retrieve evicted content. The
        original tool result is not preserved in the conversation history
        after offloading — only the preview and references remain in context.

    Args:
        evict_after_turns: Number of cycles of inactivity before an entry is
            evicted. Defaults to 20. ``None`` disables eviction.
    """

    _DEFAULT_EVICT_AFTER_TURNS = 20

    def __init__(self, evict_after_turns: int | None = _DEFAULT_EVICT_AFTER_TURNS) -> None:
        """Initialize in-memory storage.

        Args:
            evict_after_turns: Number of cycles of inactivity before an entry is
                evicted. Defaults to 20. ``None`` disables eviction.

        Raises:
            ValueError: If evict_after_turns is not a positive integer.
        """
        if evict_after_turns is not None and evict_after_turns < 1:
            raise ValueError("evict_after_turns must be a positive integer")

        self._store: dict[str, tuple[bytes, str, int]] = {}
        self._counter: int = 0
        self._current_cycle: int = 0
        self._evict_after_turns: int | None = evict_after_turns
        self._bound_agent_id: int | None = None
        self._lock = threading.Lock()

    async def store(self, key: str, content: bytes, content_type: str = "text/plain") -> str:
        """Store content in memory and return a reference.

        Args:
            key: A unique key for this content block.
            content: The raw content bytes to store.
            content_type: MIME type of the content.

        Returns:
            A unique reference string.
        """
        with self._lock:
            self._counter += 1
            reference = f"mem_{self._counter}_{key}"
            self._store[reference] = (content, content_type, self._current_cycle)
        return reference

    async def retrieve(self, reference: str) -> tuple[bytes, str]:
        """Retrieve content from memory.

        Refreshes the last-accessed turn so the entry stays alive longer
        when eviction is enabled.

        Args:
            reference: The reference returned by store().

        Returns:
            A tuple of (content bytes, content type).

        Raises:
            KeyError: If the reference is not found (or was evicted).
        """
        with self._lock:
            if reference not in self._store:
                raise KeyError(f"Reference not found: {reference}")
            content, content_type, _ = self._store[reference]
            self._store[reference] = (content, content_type, self._current_cycle)
            return content, content_type

    def _bind(self, agent_id: int) -> None:
        """Claim this storage for a single agent.

        Raises:
            ValueError: If already bound to a different agent.
        """
        with self._lock:
            if self._bound_agent_id is None:
                self._bound_agent_id = agent_id
            elif self._bound_agent_id != agent_id:
                raise ValueError(
                    "InMemoryStorage cannot be shared across multiple agents. "
                    "Use a separate InMemoryStorage instance per agent."
                )

    def _evict(self, cycle: int) -> None:
        """Update current cycle and evict stale entries.

        Called by the ContextOffloader plugin on each ``BeforeModelCallEvent``.
        Entries whose last-accessed cycle is more than ``evict_after_turns``
        behind the current cycle are removed.

        Args:
            cycle: The agent's current event loop cycle count.
        """
        with self._lock:
            self._current_cycle = cycle
            if self._evict_after_turns is None:
                return
            threshold = cycle - self._evict_after_turns
            stale_refs = [ref for ref, (_, _, last_cycle) in self._store.items() if last_cycle < threshold]
            for ref in stale_refs:
                del self._store[ref]
            if stale_refs:
                logger.debug("evicted=<%d>, cycle=<%d> | stale entries removed", len(stale_refs), cycle)

    def clear(self) -> None:
        """Remove all stored content.

        Call this to free memory when offloaded results are no longer needed,
        e.g., between sessions or after an invocation completes.
        """
        with self._lock:
            self._store.clear()


class S3Storage:
    """Store offloaded content in Amazon S3.

    .. deprecated::
        Use :class:`strands.storage.S3Storage` instead.

    Objects are stored with unique keys under the configured prefix.
    Content type is preserved as S3 object metadata.

    Args:
        bucket: S3 bucket name.
        prefix: S3 key prefix for organizing stored artifacts.
        boto_session: Optional boto3 session. If not provided, a new session
            is created using the given region_name.
        boto_client_config: Optional botocore client configuration.
        region_name: AWS region. Used only when boto_session is not provided.

    Example:
        ```python
        from strands.vended_plugins.context_offloader import S3Storage

        storage = S3Storage(
            bucket="my-agent-artifacts",
            prefix="tool-results/",
        )
        ```
    """

    def __init__(
        self,
        bucket: str,
        prefix: str = "",
        boto_session: boto3.Session | None = None,
        boto_client_config: BotocoreConfig | None = None,
        region_name: str | None = None,
    ) -> None:
        """Initialize S3-based storage.

        Args:
            bucket: S3 bucket name.
            prefix: S3 key prefix for organizing stored artifacts.
            boto_session: Optional boto3 session. If not provided, a new session
                is created using the given region_name.
            boto_client_config: Optional botocore client configuration.
            region_name: AWS region. Used only when boto_session is not provided.
        """
        self._bucket = bucket
        self._prefix = prefix.strip("/")
        if self._prefix:
            self._prefix += "/"

        session = boto_session or boto3.Session(region_name=region_name)

        if boto_client_config:
            existing_user_agent = getattr(boto_client_config, "user_agent_extra", None)
            new_user_agent = f"{existing_user_agent} strands-agents" if existing_user_agent else "strands-agents"
            client_config = boto_client_config.merge(BotocoreConfig(user_agent_extra=new_user_agent))
        else:
            client_config = BotocoreConfig(user_agent_extra="strands-agents")

        self._client: Any = session.client(service_name="s3", config=client_config)
        self._counter: int = 0
        self._lock = threading.Lock()

    async def store(self, key: str, content: bytes, content_type: str = "text/plain") -> str:
        """Store content as an S3 object and return an ``s3://`` URI as reference.

        Args:
            key: A unique key for this content block.
            content: The raw content bytes to store.
            content_type: MIME type of the content.

        Returns:
            An S3 URI (e.g., ``s3://bucket/prefix/1234_1_key``).

        Raises:
            botocore.exceptions.ClientError: If the S3 operation fails (e.g., bucket
                does not exist, permission denied).
        """
        sanitized_key = _sanitize_id(key)
        timestamp_ms = int(time.time() * 1000)
        with self._lock:
            self._counter += 1
            counter = self._counter
        s3_key = f"{self._prefix}{timestamp_ms}_{counter}_{sanitized_key}"

        self._client.put_object(
            Bucket=self._bucket,
            Key=s3_key,
            Body=content,
            ContentType=content_type,
        )

        return f"s3://{self._bucket}/{s3_key}"

    async def retrieve(self, reference: str) -> tuple[bytes, str]:
        """Retrieve content from an S3 object.

        Accepts both ``s3://`` URIs (as returned by ``store()``) and raw
        S3 keys for backward compatibility. References are constrained to the
        configured ``bucket`` and ``prefix``: a reference that resolves to a key
        outside the prefix (or to a different bucket) is rejected, mirroring the
        scope that ``store()`` enforces.

        Args:
            reference: The S3 URI or object key returned by store().

        Returns:
            A tuple of (content bytes, content type).

        Raises:
            KeyError: If the object does not exist or the reference resolves
                outside the configured bucket and prefix.
        """
        s3_key = reference
        if reference.startswith("s3://"):
            expected_prefix = f"s3://{self._bucket}/"
            if not reference.startswith(expected_prefix):
                raise KeyError(f"Reference not found: {reference}")
            s3_key = reference[len(expected_prefix) :]
        if self._prefix and not s3_key.startswith(self._prefix):
            raise KeyError(f"Reference not found: {reference}")
        try:
            response = self._client.get_object(Bucket=self._bucket, Key=s3_key)
            content: bytes = response["Body"].read()
            content_type: str = response.get("ContentType", "application/octet-stream")
            return content, content_type
        except ClientError as e:
            if e.response["Error"]["Code"] == "NoSuchKey":
                raise KeyError(f"Reference not found: {reference}") from e
            raise
