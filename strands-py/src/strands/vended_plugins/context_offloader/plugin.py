"""ContextOffloader plugin for managing large tool outputs.

This module provides the ContextOffloader plugin that intercepts oversized
tool results, persists each content block to a storage backend, and replaces
the in-context result with a truncated preview and per-block references.

Example:
    ```python
    from strands import Agent
    from strands.vended_plugins.context_offloader import (
        ContextOffloader,
        InMemoryStorage,
        FileStorage,
    )

    # In-memory storage
    agent = Agent(plugins=[
        ContextOffloader(storage=InMemoryStorage())
    ])

    # File storage with custom thresholds and retrieval tool enabled
    agent = Agent(plugins=[
        ContextOffloader(
            storage=FileStorage("./artifacts"),
            max_result_tokens=5_000,
            preview_tokens=2_000,
            include_retrieval_tool=True,
        )
    ])

    # Selective offloading: only offload results from specific tools
    agent = Agent(plugins=[
        ContextOffloader(
            storage=InMemoryStorage(),
            should_offload=lambda tool_name, token_count, **kwargs: (
                tool_name == "get_document_text"
            ),
        )
    ])
    ```
"""

from __future__ import annotations

import inspect
import json
import logging
import weakref
from collections.abc import Awaitable
from typing import TYPE_CHECKING, Any, Protocol

from typing_extensions import TypedDict

from ...agent._agent_as_tool import _AgentAsTool
from ...hooks.events import AfterToolCallEvent, BeforeModelCallEvent
from ...plugins import Plugin, hook
from ...storage import Storage
from ...storage.storage import _NAMESPACED, _NamespacedStorage
from ...tools.decorator import tool
from ...types.content import Message
from ...types.tools import ToolContext, ToolResult, ToolResultContent
from .search import _is_searchable_content, _search_content
from .storage import InMemoryStorage
from .storage import Storage as _LegacyStorage

if TYPE_CHECKING:
    from ...agent.agent import Agent

logger = logging.getLogger(__name__)


def _is_offloader_storage(storage: Storage | _LegacyStorage) -> bool:
    """Detect legacy offloader storage by presence of store/retrieve methods."""
    return hasattr(storage, "store") and hasattr(storage, "retrieve")


def _frame_content(data: bytes, content_type: str) -> bytes:
    """Frame content with its content-type for unified Storage.

    Format: [2-byte BE content-type length][content-type UTF-8][content bytes]
    """
    ct_bytes = content_type.encode("utf-8")
    ct_len = len(ct_bytes)
    frame = bytearray(2 + ct_len + len(data))
    frame[0] = (ct_len >> 8) & 0xFF
    frame[1] = ct_len & 0xFF
    frame[2 : 2 + ct_len] = ct_bytes
    frame[2 + ct_len :] = data
    return bytes(frame)


def _unframe_content(frame: bytes) -> tuple[bytes, str]:
    """Unframe content stored via unified Storage.

    Returns:
        Tuple of (content bytes, content type).

    Raises:
        ValueError: If the frame is truncated or corrupt.
    """
    if len(frame) < 2:
        raise ValueError(f"Corrupt storage frame: expected at least 2 bytes, got {len(frame)}")
    ct_len = (frame[0] << 8) | frame[1]
    if len(frame) < 2 + ct_len:
        raise ValueError(f"Corrupt storage frame: content-type length {ct_len} exceeds frame size {len(frame)}")
    content_type = frame[2 : 2 + ct_len].decode("utf-8")
    content = frame[2 + ct_len :]
    return content, content_type


async def _store_content(
    storage: Storage | _LegacyStorage,
    key: str,
    content: bytes,
    content_type: str,
) -> str:
    """Store content via either unified or legacy storage."""
    if _is_offloader_storage(storage):
        return await storage.store(key, content, content_type)  # type: ignore[union-attr]
    await storage.write(key, _frame_content(content, content_type))  # type: ignore[union-attr]
    return key


async def _retrieve_content(
    storage: Storage | _LegacyStorage,
    reference: str,
) -> tuple[bytes, str]:
    """Retrieve content from either unified or legacy storage."""
    if _is_offloader_storage(storage):
        return await storage.retrieve(reference)  # type: ignore[union-attr]
    data = await storage.read(reference)  # type: ignore[union-attr]
    if data is None:
        raise KeyError(f"Reference not found: {reference}")
    return _unframe_content(data)


class LineRange(TypedDict):
    """A span of lines to retrieve (1-indexed, inclusive)."""

    start: int
    end: int


_DEFAULT_MAX_RESULT_TOKENS = 2_500
"""Default token threshold above which tool results are offloaded."""

_DEFAULT_PREVIEW_TOKENS = 1_000
"""Default number of tokens to keep as a preview in context."""

_CHARS_PER_TOKEN = 4
"""Approximate characters per token, fallback for preview slicing without tiktoken."""


class ShouldOffload(Protocol):
    """Callback protocol for deciding whether a tool result should be offloaded."""

    def __call__(self, tool_name: str, token_count: int, **kwargs: Any) -> bool | Awaitable[bool]:
        """Return True to offload, False to keep the result in context. May be sync or async.

        Args:
            tool_name: Name of the tool that produced the result.
            token_count: Estimated token count of the result.
            **kwargs: Reserved for future parameters. Implementations should accept
                ``**kwargs`` for forward compatibility.
        """
        ...


class ContextOffloader(Plugin):
    """Plugin that offloads oversized tool results to reduce context consumption.

    When a tool result exceeds the configured token threshold, this plugin
    stores each content block individually to a storage backend and replaces
    the in-context result with a truncated text preview plus per-block references.

    Token estimation uses the agent's model ``count_tokens`` method, which
    leverages tiktoken when available and falls back to character-based heuristics.

    Content type handling:

    - **Text**: stored as ``text/plain``, replaced with a preview
    - **JSON**: stored as ``application/json``, replaced with a preview
    - **Image**: stored in its native format (e.g., ``image/png``), replaced with a
      placeholder showing format and size
    - **Document**: stored in its native format (e.g., ``application/pdf``), replaced
      with a placeholder showing format, name, and size
    - **Unknown types**: passed through unchanged

    This operates proactively at tool execution time via ``AfterToolCallEvent``,
    before the result enters the conversation — unlike ``SlidingWindowConversationManager``
    which truncates reactively after context overflow.

    Args:
        storage: Backend for storing offloaded content (required).
        max_result_tokens: Offload results whose estimated token count exceeds this threshold.
        preview_tokens: Number of tokens to keep as a text preview in context.
        include_retrieval_tool: Whether to register the ``retrieve_offloaded_content`` tool.
            Defaults to True.
        should_offload: Callback to control which tool results are offloaded.
            Defaults to None (all oversized results offloaded).

    Example:
        ```python
        from strands import Agent
        from strands.vended_plugins.context_offloader import ContextOffloader, InMemoryStorage

        agent = Agent(plugins=[
            ContextOffloader(storage=InMemoryStorage())
        ])

        # Only offload results from large-output tools
        agent = Agent(plugins=[
            ContextOffloader(
                storage=InMemoryStorage(),
                should_offload=lambda tool_name, token_count, **kwargs: (
                    tool_name == "get_document_text"
                ),
            )
        ])
        ```
    """

    name = "context_offloader"

    def __init__(
        self,
        storage: Storage | _LegacyStorage | None = None,
        max_result_tokens: int = _DEFAULT_MAX_RESULT_TOKENS,
        preview_tokens: int = _DEFAULT_PREVIEW_TOKENS,
        *,
        include_retrieval_tool: bool = True,
        should_offload: ShouldOffload | None = None,
        evict_after_cycles: int | None = 20,
    ) -> None:
        """Initialize the ContextOffloader plugin.

        Args:
            storage: Backend for storing offloaded content. Accepts either a unified
                ``Storage`` (from ``strands.storage``), a legacy offloader ``Storage``
                (from this module), or None. When None, resolves from the agent-level
                storage during initialization; if no agent-level storage is available,
                falls back to in-memory storage.
            max_result_tokens: Offload results whose estimated token count exceeds this
                threshold. Defaults to ``_DEFAULT_MAX_RESULT_TOKENS`` (2,500).
            preview_tokens: Number of tokens to keep as a text preview in context.
                Uses tiktoken for exact slicing when available, falls back to
                chars/4 heuristic. Defaults to ``_DEFAULT_PREVIEW_TOKENS`` (1,000).
            include_retrieval_tool: Whether to register the ``retrieve_offloaded_content``
                tool so the agent can fetch offloaded content. Defaults to True.
            should_offload: Callback ``(tool_name, token_count, **kwargs) -> bool`` to decide
                whether a specific tool result should be offloaded. Called only when the result
                exceeds ``max_result_tokens``. Return ``True`` to offload, ``False`` to keep
                in context. Defaults to None (all oversized results offloaded).
            evict_after_cycles: Number of agent loop cycles before an offloaded entry is
                evicted (unified Storage only). Entries stored more than this many cycles
                ago are deleted. Defaults to 20. Set to None to disable eviction.

        Raises:
            ValueError: If max_result_tokens is not positive, preview_tokens is negative,
                preview_tokens >= max_result_tokens, or evict_after_cycles is invalid.
        """
        if max_result_tokens <= 0:
            raise ValueError("max_result_tokens must be positive")
        if preview_tokens < 0:
            raise ValueError("preview_tokens must be non-negative")
        if preview_tokens >= max_result_tokens:
            raise ValueError("preview_tokens must be less than max_result_tokens")
        if evict_after_cycles is not None and (not isinstance(evict_after_cycles, int) or evict_after_cycles < 1):
            raise ValueError("evict_after_cycles must be a positive integer or None")

        self._raw_storage: Storage | _LegacyStorage | None = storage
        self._storage: Storage | _LegacyStorage | None = self._resolve_storage(storage) if storage is not None else None
        self._storage_by_agent: weakref.WeakKeyDictionary[Agent, Storage | _LegacyStorage] = weakref.WeakKeyDictionary()
        self._max_result_tokens = max_result_tokens
        self._preview_tokens = preview_tokens
        self._include_retrieval_tool = include_retrieval_tool
        self._should_offload = should_offload
        self._evict_after_cycles = evict_after_cycles
        self._stored_cycles: weakref.WeakKeyDictionary[Agent, dict[str, int]] = weakref.WeakKeyDictionary()
        super().__init__()

    @staticmethod
    def _resolve_storage(storage: Storage | _LegacyStorage) -> Storage | _LegacyStorage:
        """Auto-namespace unified storage with 'offloader' if not already scoped."""
        if _is_offloader_storage(storage):
            return storage
        if getattr(storage, "_namespaced", None) is _NAMESPACED:
            return storage
        return _NamespacedStorage(storage, "offloader")  # type: ignore[arg-type]

    def _storage_for_agent(self, agent: Agent) -> Storage | _LegacyStorage:
        """Return the storage for an agent, binding file-based storage to its sandbox.

        Any storage (or namespaced view) exposing ``for_sandbox()`` is bound once
        per agent to that agent's sandbox. All other backends are shared as-is.

        Args:
            agent: The agent whose storage to resolve.

        Returns:
            The storage instance for this agent.

        Raises:
            RuntimeError: If called before init_agent has resolved storage.
        """
        if self._storage is None:
            raise RuntimeError("ContextOffloader storage not initialized; call init_agent first")
        if not hasattr(self._storage, "for_sandbox"):
            return self._storage
        storage = self._storage_by_agent.get(agent)
        if storage is None:
            storage = self._storage.for_sandbox(agent.sandbox)  # type: ignore[union-attr]
            self._storage_by_agent[agent] = storage
        return storage

    def init_agent(self, agent: Agent) -> None:
        """Conditionally register the retrieval tool and bind storage.

        Storage is resolved on the first call and cached for the instance lifetime; a single
        ContextOffloader should not be shared across agents with differing storage backends.
        """
        if self._storage is None:
            if agent.storage is not None:
                self._storage = self._resolve_storage(agent.storage)
            else:
                self._storage = InMemoryStorage()
        if isinstance(self._storage, InMemoryStorage):
            self._storage._bind(id(agent))
        # Bind file-based storage to this agent's sandbox up front (no-op for other backends).
        self._storage_for_agent(agent)
        if not self._include_retrieval_tool:
            # Remove the auto-discovered retrieval tool
            self._tools = [t for t in self._tools if t.tool_name != "retrieve_offloaded_content"]

    @hook
    async def _on_before_model_call(self, event: BeforeModelCallEvent) -> None:
        """Trigger eviction of stale entries based on the agent's cycle count."""
        if self._storage is None:
            return
        cycle = event.agent.event_loop_metrics.cycle_count
        if isinstance(self._storage, InMemoryStorage):
            self._storage._evict(cycle)
            return

        if _is_offloader_storage(self._storage) or self._evict_after_cycles is None:
            return

        # Cycle-based eviction for unified Storage
        storage = self._storage_for_agent(event.agent)
        agent_cycles = self._stored_cycles.get(event.agent)
        if not agent_cycles:
            return
        threshold = cycle - self._evict_after_cycles
        stale_keys = [key for key, stored_cycle in agent_cycles.items() if stored_cycle < threshold]
        if stale_keys:
            evicted = 0
            for key in stale_keys:
                try:
                    await storage.delete(key)  # type: ignore[union-attr]
                except Exception:
                    logger.debug("key=<%s> | failed to evict stale entry", key)
                    continue
                del agent_cycles[key]
                evicted += 1
            if evicted:
                logger.debug("evicted=<%d>, cycle=<%d> | stale entries removed", evicted, cycle)

    @tool(context=True)
    async def retrieve_offloaded_content(
        self,
        reference: str,
        tool_context: ToolContext,
        pattern: str | None = None,
        line_range: LineRange | None = None,
        context_lines: int | None = None,
    ) -> dict | str:
        """Retrieve offloaded content by reference.

        When a tool result was too large to keep in context, it was stored externally and replaced with a preview
        and a reference. Use this tool with that reference to access the stored content.

        Returns:
          - With pattern: matching lines with line numbers and surrounding context
          - With line_range: the specified span of lines with line numbers
          - Without pattern/line_range: the full original content (use sparingly — re-injects all tokens)

        Constraints:
          - pattern/line_range/context_lines only work on text content. For binary content, omit them.
          - Line numbers in results are 1-indexed and can be used in follow-up line_range calls.
          - Retrieving a reference refreshes its eviction timer for unified Storage
            backends, so actively-retrieved content survives ``evict_after_cycles``
            beyond its store time — matching ``InMemoryStorage.retrieve``'s
            last-access refresh behavior.

        Examples:
          {"reference": "ref_1", "pattern": "error"} -> lines containing "error" with 5 lines context
          {"reference": "ref_1", "pattern": "error|warning", "context_lines": 3} -> regex, 3 lines context
          {"reference": "ref_1", "line_range": {"start": 10, "end": 25}} -> lines 10-25
          {"reference": "ref_1", "pattern": "TODO", "line_range": {"start": 1, "end": 50}} -> search within range

        Args:
            reference: The reference string from the offload placeholder (e.g. "mem_1_tool-123_0").
            pattern: Regex or keyword to grep for. Returns only matching lines with context — not the full content.
            line_range: Return only this span of lines. A dict with 'start' and 'end' keys (1-indexed).
                Combine with pattern to search within the range.
            context_lines: Lines before AND after each match (like grep -C). Default: 5.
                Without pattern/line_range, returns first N lines.
            tool_context: Injected by the framework. Not user-facing.

        Raises:
            ValueError: If the reference is unknown, the content is binary and pattern/line_range/context_lines
                were supplied, or line_range falls outside the content.
        """
        storage = self._storage_for_agent(tool_context.agent)
        try:
            content_bytes, content_type = await _retrieve_content(storage, reference)
        except KeyError as error:
            raise ValueError(f"reference not found: {reference}") from error

        # Refresh the eviction cycle so actively-retrieved content survives
        # eviction for unified Storage backends, matching InMemoryStorage.retrieve.
        self._refresh_eviction_cycle(tool_context.agent, reference)

        if pattern is None and line_range is None and context_lines is None:
            return self._decode_full_content(content_bytes, content_type, reference)

        if not _is_searchable_content(content_type):
            raise ValueError(
                f"cannot search binary content ({content_type}). "
                "Omit pattern/line_range/context_lines to retrieve the full content."
            )

        text = content_bytes.decode("utf-8")
        ctx_lines = context_lines if context_lines is not None else 5
        max_chars = self._max_result_tokens * _CHARS_PER_TOKEN

        lr: tuple[int, int] | None = None
        if line_range is not None:
            lr = (int(line_range["start"]), int(line_range["end"]))
        elif pattern is None:
            lr = (1, max(1, ctx_lines))

        return _search_content(text, pattern=pattern, line_range=lr, context_lines=ctx_lines, max_chars=max_chars)

    @staticmethod
    def _decode_full_content(content_bytes: bytes, content_type: str, reference: str) -> dict | str:
        """Decode stored content into its native format for full retrieval."""
        if content_type.startswith("text/"):
            return content_bytes.decode("utf-8")

        if content_type == "application/json":
            return {"status": "success", "content": [{"json": json.loads(content_bytes)}]}

        if content_type.startswith("image/"):
            img_format = content_type.split("/")[-1]
            return {
                "status": "success",
                "content": [{"image": {"format": img_format, "source": {"bytes": content_bytes}}}],
            }

        if content_type.startswith("application/"):
            doc_format = content_type.split("/")[-1]
            doc_block = {"format": doc_format, "name": reference, "source": {"bytes": content_bytes}}
            return {"status": "success", "content": [{"document": doc_block}]}

        return content_bytes.decode("utf-8", errors="replace")

    @hook
    async def _handle_tool_result(self, event: AfterToolCallEvent) -> None:
        """Intercept oversized tool results, offload per-block, and replace with preview."""
        if event.cancel_message is not None:
            return

        if self._include_retrieval_tool and event.tool_use.get("name") == self.retrieve_offloaded_content.tool_name:
            return

        # Never offload delegation tool results — they become the final user-facing answer
        # and no subsequent model call can retrieve the offloaded content.
        if isinstance(event.selected_tool, _AgentAsTool) and event.selected_tool.delegate:
            return

        result = event.result
        content = result["content"]
        tool_use_id = event.tool_use["toolUseId"]

        # Estimate token count by wrapping the tool result as a message for count_tokens
        tool_result_message: Message = {"role": "user", "content": [{"toolResult": result}]}
        token_count = await event.agent.model.count_tokens([tool_result_message])

        if token_count <= self._max_result_tokens:
            return

        if self._should_offload is not None:
            try:
                verdict = self._should_offload(event.tool_use.get("name", ""), token_count)
                if inspect.isawaitable(verdict):
                    verdict = await verdict
                if not verdict:
                    return
            except Exception:
                logger.warning(
                    "tool_use_id=<%s> | should_offload callback failed, falling back to default offload",
                    tool_use_id,
                    exc_info=True,
                )

        # Build text preview from text+JSON blocks.
        # Empty text blocks are intentionally excluded — they add no content value.
        text_preview_parts: list[str] = []
        for block in content:
            if block.get("text"):
                text_preview_parts.append(block["text"])
            elif "json" in block:
                text_preview_parts.append(json.dumps(block["json"], indent=2))

        full_text = "\n".join(text_preview_parts) if text_preview_parts else ""

        # Store each content block individually
        storage = self._storage_for_agent(event.agent)
        cycle = event.agent.event_loop_metrics.cycle_count
        references: list[tuple[str, str, str] | None] = []  # (ref, content_type, description) or None
        try:
            for i, block in enumerate(content):
                key = f"{tool_use_id}_{i}"
                if block.get("text"):
                    ref = await _store_content(storage, key, block["text"].encode("utf-8"), "text/plain")
                    references.append((ref, "text/plain", f"text, {len(block['text']):,} chars"))
                    self._track_stored_cycle(event.agent, ref, cycle)
                elif "json" in block:
                    json_bytes = json.dumps(block["json"], indent=2).encode("utf-8")
                    ref = await _store_content(storage, key, json_bytes, "application/json")
                    references.append((ref, "application/json", f"json, {len(json_bytes):,} bytes"))
                    self._track_stored_cycle(event.agent, ref, cycle)
                elif "image" in block:
                    image = block["image"]
                    img_format = image.get("format", "unknown")
                    img_bytes = image.get("source", {}).get("bytes", b"")
                    if img_bytes:
                        ref = await _store_content(storage, key, img_bytes, f"image/{img_format}")
                        references.append((ref, f"image/{img_format}", f"image/{img_format}, {len(img_bytes):,} bytes"))
                        self._track_stored_cycle(event.agent, ref, cycle)
                    else:
                        references.append(None)
                elif "document" in block:
                    doc = block["document"]
                    doc_format = doc.get("format", "unknown")
                    doc_name = doc.get("name", "unknown")
                    doc_bytes = doc.get("source", {}).get("bytes", b"")
                    if doc_bytes:
                        ref = await _store_content(storage, key, doc_bytes, f"application/{doc_format}")
                        references.append((ref, f"application/{doc_format}", f"{doc_name}, {len(doc_bytes):,} bytes"))
                        self._track_stored_cycle(event.agent, ref, cycle)
                    else:
                        references.append(None)
        except Exception:
            logger.warning(
                "tool_use_id=<%s> | failed to offload tool result, keeping original",
                tool_use_id,
                exc_info=True,
            )
            return

        logger.debug(
            "tool_use_id=<%s>, blocks=<%d>, tokens=<%d> | tool result offloaded",
            tool_use_id,
            len(references),
            token_count,
        )

        # Build preview text — use tiktoken for exact slicing when available
        preview = self._slice_preview(full_text) if full_text else ""
        # Skip None: non-bytes image/document sources were left unstored (#4017).
        ref_lines = "\n".join(
            f"  {ref} ({desc})" for entry in references if entry is not None for ref, _, desc in [entry] if ref
        )

        guidance = (
            "Tool result was offloaded to external storage due to size.\n"
            "Use the preview below if it answers your question.\n"
        )
        if self._include_retrieval_tool:
            guidance += (
                "If you need more detail, use retrieve_offloaded_content with a reference and:\n"
                "  - pattern: regex or keyword to find matching lines with context\n"
                "  - line_range: { start, end } to read a specific span of lines\n"
                "Retrieve full content (omit pattern/line_range) as a last resort."
            )
        else:
            guidance += "If you need more detail, use your available tools to access specific data."

        preview_text = (
            f"[Offloaded: {len(content)} blocks, ~{token_count:,} tokens]\n"
            f"{guidance}\n\n"
            f"{preview}\n\n"
            f"[Stored references:]\n{ref_lines}"
        )

        # Build new content with preview + placeholders for non-text blocks
        new_content: list[ToolResultContent] = [ToolResultContent(text=preview_text)]
        for i, block in enumerate(content):
            # None = unstored non-bytes source; keep the original block (#4017).
            ref_entry = references[i] if i < len(references) else None
            if ref_entry is None:
                new_content.append(block)
                continue
            ref = ref_entry[0]
            if "text" in block or "json" in block:
                continue
            elif "image" in block:
                image = block["image"]
                img_format = image.get("format", "unknown")
                img_bytes = image.get("source", {}).get("bytes", b"")
                placeholder = f"[image: {img_format}, {len(img_bytes) if img_bytes else 0} bytes"
                if ref:
                    placeholder += f" | ref: {ref}"
                placeholder += "]"
                new_content.append(ToolResultContent(text=placeholder))
            elif "document" in block:
                doc = block["document"]
                doc_format = doc.get("format", "unknown")
                doc_name = doc.get("name", "unknown")
                doc_bytes = doc.get("source", {}).get("bytes", b"")
                placeholder = f"[document: {doc_format}, {doc_name}, {len(doc_bytes) if doc_bytes else 0} bytes"
                if ref:
                    placeholder += f" | ref: {ref}"
                placeholder += "]"
                new_content.append(ToolResultContent(text=placeholder))
            else:
                new_content.append(block)

        event.result = ToolResult(
            toolUseId=result["toolUseId"],
            status=result["status"],
            content=new_content,
        )

    def _track_stored_cycle(self, agent: Agent, ref: str, cycle: int) -> None:
        """Record the cycle at which a key was stored (unified Storage eviction)."""
        if self._storage is not None and not _is_offloader_storage(self._storage):
            agent_cycles = self._stored_cycles.get(agent)
            if agent_cycles is None:
                agent_cycles = {}
                self._stored_cycles[agent] = agent_cycles
            agent_cycles[ref] = cycle

    def _refresh_eviction_cycle(self, agent: Agent, reference: str) -> None:
        """Refresh the eviction cycle for a retrieved reference.

        Unified ``Storage`` backends are evicted by the plugin based on the cycle
        recorded at *store* time (see ``_on_before_model_call``). Without a refresh
        on retrieve, an entry is evicted ``evict_after_cycles`` after it was stored
        regardless of active retrieval — so an agent that retrieves a reference at
        cycle 15 can still hit "reference not found" at cycle 21 because the store
        happened at cycle 0. ``InMemoryStorage.retrieve`` already refreshes its own
        last-accessed cycle (storage.py:372); this mirrors that behavior for the
        unified-Storage path so cross-backend behavior matches the documented
        contract. A no-op for ``InMemoryStorage`` (``_track_stored_cycle`` is guarded
        by ``not _is_offloader_storage``), which self-refreshes on retrieve.
        """
        cycle = agent.event_loop_metrics.cycle_count
        self._track_stored_cycle(agent, reference, cycle)
        logger.debug("reference=<%s>, cycle=<%d> | retrieve refreshed eviction cycle", reference, cycle)

    def _slice_preview(self, text: str) -> str:
        """Slice text to approximately preview_tokens using character-based estimation.

        Args:
            text: The full text to slice.

        Returns:
            The preview text.
        """
        return text[: self._preview_tokens * _CHARS_PER_TOKEN]
