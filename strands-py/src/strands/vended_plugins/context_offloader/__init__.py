"""Context offloader plugin for Strands Agents.

This module provides the ContextOffloader plugin which intercepts oversized
tool results, persists each content block to a storage backend, and replaces
the in-context result with a truncated preview and per-block references.

Example Usage:
    ```python
    from strands import Agent
    from strands.vended_plugins.context_offloader import (
        BedrockReranker,
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

    # Relevance preview: keep the chunks the current question asks about,
    # instead of the leading characters of the result
    agent = Agent(plugins=[
        ContextOffloader(
            storage=InMemoryStorage(),
            preview_strategy="relevance",
            relevance_threshold=0.5,
        )
    ])

    # Relevance preview with an explicit scorer
    agent = Agent(plugins=[
        ContextOffloader(
            storage=InMemoryStorage(),
            preview_strategy="relevance",
            reranker=BedrockReranker(region_name="us-west-2"),
        )
    ])
    ```
"""

from .plugin import ContextOffloader, PreviewStrategy, ShouldOffload
from .reranker import BedrockReranker, Reranker, RerankerError
from .storage import (
    FileStorage,
    InMemoryStorage,
    S3Storage,
    Storage,
)

__all__ = [
    "BedrockReranker",
    "ContextOffloader",
    "FileStorage",
    "InMemoryStorage",
    "PreviewStrategy",
    "Reranker",
    "RerankerError",
    "S3Storage",
    "ShouldOffload",
    "Storage",
]
