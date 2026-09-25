"""Pluggable search strategies for storage backends.

Each strategy encapsulates a single approach to searching stored content.
Storage backends use :class:`KeywordSearchStrategy` by default; consumers
(memory stores, context offloaders) can override with a different strategy.
"""

from ..storage import StorageSearchResult
from .bm25 import Bm25SearchStrategy, Bm25SearchStrategyConfig
from .keyword import KeywordSearchStrategy
from .types import SearchStrategy

__all__ = [
    "Bm25SearchStrategy",
    "Bm25SearchStrategyConfig",
    "KeywordSearchStrategy",
    "SearchStrategy",
    "StorageSearchResult",
]
