"""L1 stash — durable storage for offloaded context content.

When the ContextManager offloads content, the original is persisted here
so the agent can retrieve it on demand via the retrieval tool.
"""

from __future__ import annotations

import base64
import json
import logging
from typing import TYPE_CHECKING

from ..storage.storage import _resolve_namespace
from ..types.content import ContentBlock

if TYPE_CHECKING:
    from ..storage.storage import Storage
    from ..types.content import Message

logger = logging.getLogger(__name__)

STASH_PREFIX = "context"


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


def _format_stash_refs(refs: list[str]) -> str:
    """Format stash refs as a standalone bracket token for offload placeholders.

    Returns an empty string when refs is empty. With one ref returns
    ``' [ref: <ref>]'``; with multiple returns ``' [refs: <r1>, <r2>]'``.
    Note the leading space in non-empty returns.
    """
    if not refs:
        return ""
    if len(refs) == 1:
        return f" [ref: {refs[0]}]"
    return f" [refs: {', '.join(refs)}]"


class Stash:
    """Namespaced storage wrapper for persisting offloaded content blocks."""

    def __init__(self, storage: Storage, session_id: str, agent_id: str) -> None:
        self._storage = _resolve_namespace(storage, f"{STASH_PREFIX}/{session_id}/scopes/agent/{agent_id}")

    async def store(self, block_id: str, block_index: int, data: bytes) -> str:
        """Store a content block and return its deterministic reference key."""
        key = f"{block_id}_{block_index}"
        await self._storage.write(key, data)
        return key

    def refs_for(self, block: ContentBlock, message: Message, block_index: int) -> list[str]:
        """Compute deterministic reference keys for a content block."""
        if "toolResult" in block:
            tool_result = block["toolResult"]
            return [f"{tool_result['toolUseId']}_{index}" for index in range(len(tool_result["content"]))]
        return [f"{message.get('tracking_id', 'unknown')}_{block_index}"]

    async def store_message(self, message: Message, skip_tool_use_ids: frozenset[str] | None = None) -> None:
        """Eagerly persist all stashable blocks from a message."""
        for block_index, block in enumerate(message["content"]):
            if "toolResult" in block:
                tool_result = block["toolResult"]
                if skip_tool_use_ids and tool_result["toolUseId"] in skip_tool_use_ids:
                    continue
                await self._store_tool_result(block)
            elif "toolUse" in block or "reasoningContent" in block or "cachePoint" in block:
                continue
            else:
                try:
                    await self.store(message.get("tracking_id", "unknown"), block_index, _encode(block))
                except Exception:
                    logger.warning(
                        "tracking_id=<%s>, block_index=<%s> | failed to stash block",
                        message.get("tracking_id"),
                        block_index,
                        exc_info=True,
                    )

    async def retrieve(self, reference: str) -> object | None:
        """Retrieve a stashed block by reference. Returns None if not found."""
        data = await self._storage.read(reference)
        if data is None:
            return None
        return _decode(data)

    async def list(self) -> list[str]:
        """List all stashed reference keys."""
        return await self._storage.list("")

    async def delete(self, reference: str) -> None:
        """Delete a stashed entry."""
        await self._storage.delete(reference)
        logger.debug("reference=<%s> | deleted stash entry", reference)

    async def _store_tool_result(self, block: ContentBlock) -> None:
        """Store each sub-block of a tool result individually."""
        tool_result = block["toolResult"]
        for block_index, item in enumerate(tool_result["content"]):
            try:
                await self.store(tool_result["toolUseId"], block_index, _encode(item))
            except Exception:
                logger.warning(
                    "tool_use_id=<%s>, block_index=<%s> | failed to stash sub-block",
                    tool_result["toolUseId"],
                    block_index,
                    exc_info=True,
                )
