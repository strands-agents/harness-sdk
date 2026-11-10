"""Configuration types for the FileMemoryStore."""

from __future__ import annotations

from typing import TYPE_CHECKING

from ...memory.types import MemoryStoreConfig

if TYPE_CHECKING:
    from ...storage.storage import Storage


class FileMemoryStoreConfig(MemoryStoreConfig, total=False):
    """Configuration for :class:`~strands.vended_memory_stores.file_memory_store.FileMemoryStore`.

    Attributes:
        storage: The unified Storage backend for file operations. Defaults to
            LocalFileStorage at ``./.strands/``. Keys are auto-scoped under
            ``memory/<name>/`` unless the provided storage is already namespaced, so
            stores with distinct names safely share one backend. Two stores with the same
            name on the same backend share storage -- give them different names (or
            separate storage) to isolate them.
    """

    storage: Storage
