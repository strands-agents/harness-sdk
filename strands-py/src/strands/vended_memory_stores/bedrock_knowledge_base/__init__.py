"""A :class:`~strands.memory.types.MemoryStore` backed by Amazon Bedrock Knowledge Bases.

Example:
    ```python
    from strands.vended_memory_stores.bedrock_knowledge_base import BedrockKnowledgeBaseStore

    store = BedrockKnowledgeBaseStore(
        config={
            "knowledge_base_id": "KB123",
            "data_source_type": "CUSTOM",
            "data_source_id": "DS456",
        },
        name="preferences",
        scope="user-abc",
        writable=True,
    )
    ```
"""

from .store import BedrockKnowledgeBaseStore
from .types import (
    BedrockKnowledgeBaseAccessControlEntry,
    BedrockKnowledgeBaseAddResult,
    BedrockKnowledgeBaseConfig,
    BedrockKnowledgeBaseS3Config,
    BedrockKnowledgeBaseStoreConfig,
)

__all__ = [
    "BedrockKnowledgeBaseAccessControlEntry",
    "BedrockKnowledgeBaseAddResult",
    "BedrockKnowledgeBaseConfig",
    "BedrockKnowledgeBaseS3Config",
    "BedrockKnowledgeBaseStore",
    "BedrockKnowledgeBaseStoreConfig",
]
