"""File-based memory store backed by the unified Storage interface.

Stores knowledge as markdown files under a ``memory/`` storage namespace. Provides
keyword-based search via ``search_memory`` (registered by MemoryManager).
"""

from __future__ import annotations

import asyncio
import re
import time
from typing import TYPE_CHECKING

from typing_extensions import Unpack

from ...memory.extraction.model_extractor import ModelExtractor
from ...memory.extraction.types import ExtractionConfig, ExtractionResult, Extractor, ExtractorContext
from ...memory.types import MemoryEntry, MemoryStore, Metadata, SearchOptions
from ...storage.local_file_storage import LocalFileStorage
from ...storage.storage import _normalize_key, _resolve_namespace
from .types import FileMemoryStoreConfig

if TYPE_CHECKING:
    from ...storage.storage import Storage
    from ...types.content import Message

_DEFAULT_EXTRACTION_FRAMING = (
    "You extract durable facts worth remembering across future conversations from a transcript."
)

_OUTPUT_CONTRACT = (
    'Return ONLY a JSON array of objects: {"content": string}.\n\n'
    "Group related facts into a single entry. The first line is a markdown heading"
    ' (e.g. "# User preferences", "# Project setup", "# Team conventions").'
    " Put each fact on its own line below the heading.\n\n"
    "If there is nothing worth remembering, return []."
)

_DEFAULT_MAX_SEARCH_RESULTS = 10
_STORAGE_NAMESPACE = "memory"
_MAX_SLUG_LENGTH = 50


def _basename(key: str) -> str:
    """Extract the filename stem (without .md extension) from a storage key."""
    filename = key.rsplit("/", maxsplit=1)[-1]
    return filename.removesuffix(".md")


def _slugify(text: str) -> str:
    """Convert text to a URL-safe kebab-case slug, truncated to 50 characters."""
    slug = text.lower()
    slug = re.sub(r"[^a-z0-9\s-]", "", slug)
    slug = slug.strip()
    slug = re.sub(r"\s+", "-", slug)
    slug = slug[:_MAX_SLUG_LENGTH]
    return slug.rstrip("-")


def _create_key_aware_extractor(storage: Storage) -> Extractor:
    """Create an extractor that injects existing topic headings so the model reuses them."""

    class _KeyAwareExtractor:
        async def extract(
            self, messages: list[Message], context: ExtractorContext | None = None
        ) -> list[ExtractionResult]:
            existing_keys = await storage.list("")
            headings = [_basename(key).replace("-", " ") for key in existing_keys]

            prompt = f"{_DEFAULT_EXTRACTION_FRAMING}\n\n{_OUTPUT_CONTRACT}"
            if headings:
                prompt += (
                    f"\n\nExisting topics: {', '.join(headings)}. "
                    "Reuse an existing topic heading when new facts belong to it."
                )

            return await ModelExtractor(system_prompt=prompt).extract(messages, context)

    return _KeyAwareExtractor()


class FileMemoryStore(MemoryStore):
    """A file-based memory store backed by the unified Storage interface.

    Knowledge is stored as plain markdown files under a ``memory/`` storage namespace.
    Retrieval uses keyword-based token-overlap scoring against filename and body content.

    The storage backend defaults to :class:`~strands.storage.LocalFileStorage`. Keys are
    auto-scoped under ``memory/<name>/`` (so a store named ``agent-memory`` with the
    default backend writes to ``./.strands/memory/agent-memory/``).

    Example:
        ```python
        from strands import Agent
        from strands.memory import MemoryManager
        from strands.vended_memory_stores.file_memory_store import FileMemoryStore

        memory_store = FileMemoryStore(name="agent-memory")

        agent = Agent(
            model=model,
            memory_manager=MemoryManager(stores=[memory_store], injection=False),
        )
        ```
    """

    def __init__(self, **config: Unpack[FileMemoryStoreConfig]) -> None:
        """Initialize the FileMemoryStore.

        Args:
            **config: Store configuration. See :class:`FileMemoryStoreConfig`.
        """
        self.name: str = config["name"]
        self.writable: bool = config.get("writable", True)
        self.description: str | None = config.get("description")
        self.max_search_results: int | None = config.get("max_search_results")

        raw_storage = config.get("storage") or LocalFileStorage()
        self._storage: Storage = _resolve_namespace(raw_storage, f"{_STORAGE_NAMESPACE}/{self.name}")
        self.extraction: ExtractionConfig | bool | None = self._resolve_extraction(config)
        self._write_lock = asyncio.Lock()

    def _resolve_extraction(self, config: FileMemoryStoreConfig) -> ExtractionConfig | bool | None:
        extraction: ExtractionConfig | bool | None = config.get("extraction")
        if extraction is None or extraction is False:
            return extraction
        if extraction is True:
            return ExtractionConfig(extractor=_create_key_aware_extractor(self._storage))
        if "extractor" not in extraction or extraction.get("extractor") is None:
            result = ExtractionConfig(extractor=_create_key_aware_extractor(self._storage))
            if "trigger" in extraction:
                result["trigger"] = extraction["trigger"]
            if "filter" in extraction:
                result["filter"] = extraction["filter"]
            return result
        return extraction

    async def search(self, query: str, options: SearchOptions | None = None) -> list[MemoryEntry]:
        """Search knowledge files by keyword token-overlap scoring.

        Args:
            query: Natural-language search query.
            options: Optional search configuration (e.g. max_search_results).

        Returns:
            Top matches ranked by relevance.
        """
        option_max = options.get("max_search_results") if options else None
        if option_max is not None and option_max < 1:
            raise ValueError("max_search_results must be >= 1")
        max_results = (
            option_max
            if option_max is not None
            else self.max_search_results
            if self.max_search_results is not None
            else _DEFAULT_MAX_SEARCH_RESULTS
        )

        results = await self._storage.search(query)
        entries: list[MemoryEntry] = []
        for result in results[:max_results]:
            data = result.data if result.data is not None else await self._storage.read(result.key)
            if data is not None:
                entries.append(
                    MemoryEntry(
                        content=data.decode("utf-8", errors="replace").strip(),
                        metadata={"path": result.key, "score": result.score},
                    )
                )
        return entries

    async def add(self, content: str, metadata: Metadata | None = None) -> str:
        """Add a knowledge entry to the store.

        The filename is derived from the first line of content (slugified, truncated to
        50 chars). If a file with the same slug already exists, new facts (lines after
        the heading) are appended rather than overwriting.

        Args:
            content: The knowledge content to store.
            metadata: Unused; accepted for interface compatibility.

        Returns:
            The canonical storage key the entry was written under.
        """
        lines = content.split("\n")
        first_line = re.sub(r"^#+\s*", "", lines[0])
        slug = _slugify(first_line) or f"entry-{int(time.time() * 1000)}"
        key = _normalize_key(f"{slug}.md").lower()

        async with self._write_lock:
            existing = await self._storage.read(key)
            if existing:
                existing_content = existing.decode("utf-8", errors="replace")
                new_facts = "\n".join(lines[1:]).strip()
                merged = f"{existing_content.rstrip()}\n{new_facts}" if new_facts else existing_content
            else:
                merged = content

            await self._storage.write(key, merged.encode("utf-8"))

        return key
