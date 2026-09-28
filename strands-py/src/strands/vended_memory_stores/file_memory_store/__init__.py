"""A file-based MemoryStore that stores knowledge as plain markdown files.

Example:
    ```python
    from strands.vended_memory_stores.file_memory_store import FileMemoryStore

    store = FileMemoryStore(name="agent-memory")
    ```
"""

from .store import FileMemoryStore
from .types import FileMemoryStoreConfig

__all__ = [
    "FileMemoryStore",
    "FileMemoryStoreConfig",
]
