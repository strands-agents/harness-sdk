"""L1 archive — durable storage for offloaded context content.

When the ContextManager offloads content, the original is persisted here
so the agent can retrieve it on demand via the retrieval tool.
"""

from __future__ import annotations

import base64
import builtins
import json
import logging
import uuid
from typing import TYPE_CHECKING, Any

from ..storage.storage import _NAMESPACED, _NamespacedStorage
from ..types.content import ContentBlock
from .placeholder import is_offloaded

if TYPE_CHECKING:
    from ..storage.storage import Storage
    from ..types.content import Message, Messages

logger = logging.getLogger(__name__)

ARCHIVE_PREFIX = "context"


class _BytesEncoder(json.JSONEncoder):
    """JSON encoder that base64-encodes bytes values."""

    def default(self, obj: object) -> object:
        if isinstance(obj, (bytes, bytearray)):
            return base64.b64encode(obj).decode("ascii")
        return super().default(obj)


def _encode(value: object) -> bytes:
    return json.dumps(value, cls=_BytesEncoder).encode("utf-8")


def _decode(data: bytes) -> object:
    return json.loads(data.decode("utf-8"))


def _parse_archive_key(key: str) -> tuple[str, int] | None:
    """Split a ``<id>_<index>`` archive key.

    The id may itself contain ``_``, so the index is whatever follows the last one.
    """
    owner, separator, index = key.rpartition("_")
    if not separator or not owner or not index.isdecimal():
        return None
    return owner, int(index)


class Archive:
    """Namespaced storage wrapper for persisting offloaded content blocks."""

    def __init__(
        self, storage: Storage, session_id: str, agent_id: str, *, custom_archive_namespace: bool = False
    ) -> None:
        self._base_storage = storage
        self._session_id = session_id
        # A caller-scoped view is the exact archive root when allowed; otherwise namespace per session and agent.
        self._storage = (
            storage
            if custom_archive_namespace and getattr(storage, "_namespaced", None) is _NAMESPACED
            else _NamespacedStorage(storage, f"{ARCHIVE_PREFIX}/{session_id}/scopes/agent/{agent_id}")
        )

    @property
    def storage_type_name(self) -> str:
        """Name of the base storage class, for diagnostic logging."""
        return type(self._base_storage).__name__

    async def store(self, block_id: str, block_index: int, data: bytes, *, keep_existing: bool = False) -> str:
        """Store a content block and return its deterministic reference key.

        With ``keep_existing``, an entry already stored under the key is left untouched.
        """
        key = f"{block_id}_{block_index}"
        if keep_existing and await self._storage.read(key) is not None:
            return key
        await self._storage.write(key, data)
        return key

    async def ensure_archived(self, block: ContentBlock, message: Message, block_index: int) -> str:
        """The reference an offload placeholder carries for the block it replaces, storing the block if it is not yet.

        A tool result is referenced by its ``toolUseId``; the retrieval tool resolves it to every stored item
        (``<toolUseId>_<i>``). Any other block is referenced by its position (``<tracking_id>_<block_index>``).
        History edits move blocks between messages and positions, so the key a block was stored under on arrival
        can differ from its key now; storing here keeps every emitted reference resolvable.
        """
        if "toolResult" in block:
            tool_result = block["toolResult"]
            # A result holding a placeholder is not the original; its items were stored before it was offloaded.
            if not any(is_offloaded(item) for item in tool_result["content"]):
                if len(await self.keys_of(tool_result["toolUseId"])) < len(tool_result["content"]):
                    await self._store_tool_result(block)
            return tool_result["toolUseId"]

        return await self.store(message.get("tracking_id", "unknown"), block_index, _encode(block), keep_existing=True)

    async def store_removed(self, removed: Messages) -> str:
        """Store messages removed from the context window as one entry.

        The reference is fresh for every removal rather than derived from the messages, because two removals can
        begin at the same message: a later pass removes the message an earlier marker was folded into, and a
        server-side summary always stands for the messages after message 0. Deriving it would have the second
        removal overwrite the first, leaving the earlier content unretrievable.
        """
        reference = f"removed-{uuid.uuid4()}"
        await self.store(reference, 0, _encode(removed))
        return reference

    async def store_message(
        self,
        message: Message,
        skip_tool_use_ids: frozenset[str] | None = None,
        *,
        keep_existing: bool = False,
    ) -> None:
        """Eagerly persist all archivable blocks from a message.

        Offload placeholders are never stored: their keys belong to the originals they replaced.
        With ``keep_existing``, entries already stored under a block's key are left untouched.
        """
        for block_index, block in enumerate(message["content"]):
            if "toolResult" in block:
                tool_result = block["toolResult"]
                if skip_tool_use_ids and tool_result["toolUseId"] in skip_tool_use_ids:
                    continue
                if any(is_offloaded(item) for item in tool_result["content"]):
                    continue
                await self._store_tool_result(block, keep_existing=keep_existing)
            elif "toolUse" in block or "reasoningContent" in block or "cachePoint" in block:
                continue
            elif is_offloaded(block):
                continue
            else:
                try:
                    await self.store(
                        message.get("tracking_id", "unknown"), block_index, _encode(block), keep_existing=keep_existing
                    )
                except Exception:
                    logger.warning(
                        "tracking_id=<%s>, block_index=<%s> | failed to archive block",
                        message.get("tracking_id"),
                        block_index,
                        exc_info=True,
                    )

    async def retrieve(self, reference: str) -> object | None:
        """Retrieve an archived block by reference. Returns None if not found."""
        data = await self._storage.read(reference)
        if data is None:
            return None
        return _decode(data)

    async def list(self, prefix: str = "") -> builtins.list[str]:
        """List archived reference keys, optionally only those starting with ``prefix``."""
        return await self._storage.list(prefix)

    async def keys_of(self, reference_id: str) -> builtins.list[str]:
        """The keys stored under ``reference_id``, in index order.

        A prefix list alone also returns ids that extend this one, so each key's parsed id has to match.
        """
        parsed = ((key, _parse_archive_key(key)) for key in await self.list(f"{reference_id}_"))
        matching = [(key, entry[1]) for key, entry in parsed if entry and entry[0] == reference_id]
        return [key for key, _ in sorted(matching, key=lambda entry: entry[1])]

    async def delete(self, reference: str) -> None:
        """Delete an archived entry."""
        await self._storage.delete(reference)
        logger.debug("reference=<%s> | deleted archive entry", reference)

    async def take_snapshot(self) -> dict[str, Any]:
        """Serialize all archive entries for snapshot persistence.

        Returns:
            Map of reference keys to their deserialized JSON values.
        """
        keys = await self.list()
        entries: dict[str, Any] = {}
        for key in keys:
            data = await self._storage.read(key)
            if data is not None:
                entries[key] = _decode(data)
        return entries

    async def load_snapshot(self, entries: dict[str, Any]) -> None:
        """Restore archive entries from a previously captured snapshot.

        Args:
            entries: Map of reference keys to their JSON values (from :meth:`take_snapshot`).
        """
        for key, data in entries.items():
            await self._storage.write(key, _encode(data))

    async def clear(self) -> None:
        """Delete all entries in this agent's archive namespace."""
        keys = await self.list()
        for key in keys:
            await self._storage.delete(key)

    async def clear_session(self) -> None:
        """Delete all archive data for this session across all agents.

        Unlike :meth:`clear`, which is scoped to this agent's namespace, this
        scans ``context/<session_id>/`` on the base storage to remove data from
        every agent that wrote to the session. An archive rooted at a caller-scoped
        view is shared beyond this session, so its data is left to the caller.
        """
        if self._storage is self._base_storage:
            logger.debug("session_id=<%s> | skipping archive deletion, archive is caller-scoped", self._session_id)
            return
        prefix = f"{ARCHIVE_PREFIX}/{self._session_id}/"
        keys = await self._base_storage.list(prefix)
        for key in keys:
            await self._base_storage.delete(key)

    async def _store_tool_result(self, block: ContentBlock, *, keep_existing: bool = False) -> None:
        """Store each sub-block of a tool result individually."""
        tool_result = block["toolResult"]
        for block_index, item in enumerate(tool_result["content"]):
            try:
                await self.store(tool_result["toolUseId"], block_index, _encode(item), keep_existing=keep_existing)
            except Exception:
                logger.warning(
                    "tool_use_id=<%s>, block_index=<%s> | failed to archive sub-block",
                    tool_result["toolUseId"],
                    block_index,
                    exc_info=True,
                )
