"""Unified storage module.

Provides the Storage interface and shipped implementations for persisting
raw bytes under string keys. All SDK subsystems that need persistence
consume this interface.

Example:
    ```python
    from strands.storage import LocalFileStorage, InMemoryStorage

    storage = LocalFileStorage("./.strands/")
    await storage.write("sessions/abc/snapshot.json", data)
    ```
"""

from .in_memory_storage import InMemoryStorage
from .local_file_storage import LocalFileStorage
from .s3_storage import S3Storage
from .storage import Storage

__all__ = [
    "InMemoryStorage",
    "LocalFileStorage",
    "S3Storage",
    "Storage",
]
