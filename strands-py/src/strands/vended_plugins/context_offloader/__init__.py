"""Context offloader plugin for Strands Agents.

This module provides the ContextOffloader plugin which intercepts oversized
tool results, persists each content block to a storage backend, and replaces
the in-context result with a truncated preview and per-block references.

Example Usage:
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

    # File storage with custom thresholds
    agent = Agent(plugins=[
        ContextOffloader(
            storage=FileStorage("./artifacts"),
            max_result_tokens=5_000,
            preview_tokens=2_000,
        )
    ])
    ```
"""

from .plugin import ContextOffloader, ShouldOffload
from .storage import (
    FileStorage,
    InMemoryStorage,
    S3Storage,
    Storage,
)

__all__ = [
    "ContextOffloader",
    "FileStorage",
    "InMemoryStorage",
    "S3Storage",
    "ShouldOffload",
    "Storage",
]
