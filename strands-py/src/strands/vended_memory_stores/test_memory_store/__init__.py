"""A :class:`~strands.memory.types.MemoryStore` that persists to a local JSON file.

A zero-infrastructure store for prototyping and offline use: no cloud account or provisioned
resources required. Persists to disk by default so an agent remembers across restarts.

Example:
    ```python
    from strands.vended_memory_stores.test_memory_store import TestMemoryStore

    store = TestMemoryStore(name="notes")
    ```
"""

from .store import TestMemoryStore
from .types import TestMemoryAddResult, TestMemoryStoreConfig

__all__ = [
    "TestMemoryAddResult",
    "TestMemoryStore",
    "TestMemoryStoreConfig",
]
