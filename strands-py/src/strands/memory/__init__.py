"""Memory module for Strands Agents.

This package gives agents cross-session recall and persistence through a
``MemoryManager`` plugin that manages pluggable memory stores, exposes search/add
tools, and runs automatic background extraction.
"""

from ..injection import InjectionConfig, InjectionContext, InjectionTrigger
from ..types.exceptions import AggregateMemoryError
from .extraction.model_extractor import ModelExtractor
from .extraction.triggers import IntervalTrigger, InvocationTrigger
from .extraction.types import (
    ExtractionConfig,
    ExtractionResult,
    ExtractionTrigger,
    ExtractionTriggerContext,
    Extractor,
    ExtractorContext,
    MemoryContentBlockType,
    MemoryMessageFilter,
)
from .memory_manager import MemoryManager
from .types import (
    AddMessagesContext,
    InjectionFormatContext,
    InjectionQueryContext,
    MemoryAddOptions,
    MemoryAddToolConfig,
    MemoryEntry,
    MemoryInjectionConfig,
    MemoryManagerConfig,
    MemorySearchOptions,
    MemoryStore,
    MemoryStoreConfig,
    MemoryToolConfig,
    SearchOptions,
)

__all__ = [
    "AddMessagesContext",
    "AggregateMemoryError",
    "ExtractionConfig",
    "ExtractionResult",
    "ExtractionTrigger",
    "ExtractionTriggerContext",
    "Extractor",
    "ExtractorContext",
    "InjectionConfig",
    "InjectionContext",
    "InjectionFormatContext",
    "InjectionQueryContext",
    "InjectionTrigger",
    "IntervalTrigger",
    "InvocationTrigger",
    "MemoryAddOptions",
    "MemoryAddToolConfig",
    "MemoryContentBlockType",
    "MemoryEntry",
    "MemoryInjectionConfig",
    "MemoryManager",
    "MemoryManagerConfig",
    "MemoryMessageFilter",
    "MemorySearchOptions",
    "MemoryStore",
    "MemoryStoreConfig",
    "MemoryToolConfig",
    "ModelExtractor",
    "SearchOptions",
]
