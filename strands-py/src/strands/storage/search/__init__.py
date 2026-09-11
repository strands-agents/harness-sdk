"""Pluggable search strategies for storage backends.

Each strategy encapsulates a single approach to searching stored content.
Storage backends use :class:`KeywordSearchStrategy` by default; consumers
(memory stores, context offloaders) can override with a different strategy.
"""

from ..storage import StorageSearchResult
from .keyword import KeywordSearchStrategy
from .types import SearchStrategy

__all__ = [
    "KeywordSearchStrategy",
    "SearchStrategy",
    "StorageSearchResult",
]
