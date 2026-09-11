"""Keyword search strategy using token-overlap scoring."""

from __future__ import annotations

import asyncio
import builtins
import re
from typing import Any

from ..storage import Storage, StorageSearchResult


def tokenize(text: str) -> set[str]:
    r"""Lowercase and split text into a set of word tokens, dropping empties.

    Splits on any run of non-word characters (Unicode-aware). Ensures cross-SDK
    compatibility with the TypeScript ``/[^\p{L}\p{N}_]+/u`` regex.

    Args:
        text: The text to tokenize.

    Returns:
        A set of lowercased word tokens.
    """
    return {token for token in re.split(r"\W+", text.lower()) if token}


def token_overlap_score(query_tokens: set[str], content: str) -> int:
    """Lexical relevance score: distinct query tokens present in the content.

    A higher count means more of the query's words are present.
    Returns 0 when there is no overlap.

    Args:
        query_tokens: Pre-tokenized query terms.
        content: The content string to score against.

    Returns:
        Number of distinct query tokens found in the content.
    """
    return len(query_tokens & tokenize(content))


class KeywordSearchStrategy:
    """Keyword search strategy using token-overlap scoring.

    Tokenizes the query and each stored entry (key + content), then scores by the
    number of distinct query tokens that appear. Works on any storage backend with
    ``list()`` and ``read()`` -- no index or embedding model required.

    This is the default search strategy for all shipped storage backends.

    Example:
        ```python
        from strands.storage.search import KeywordSearchStrategy

        strategy = KeywordSearchStrategy()
        results = await strategy.search(storage, "dark mode toggle")
        ```
    """

    async def search(self, storage: Storage, query: str, **kwargs: Any) -> builtins.list[StorageSearchResult]:
        """Search content in storage by keyword token-overlap scoring.

        Args:
            storage: The storage to search over.
            query: A natural-language string query.
            **kwargs: Unused; accepted for protocol compatibility.

        Returns:
            Matched keys with relevance scores, ranked best-first.
        """
        query_tokens = tokenize(query)
        if not query_tokens:
            return []

        all_keys = await storage.list("")
        all_data = await asyncio.gather(*(storage.read(key) for key in all_keys))

        scored: builtins.list[StorageSearchResult] = []
        for key, data in zip(all_keys, all_data, strict=True):
            if data is None:
                continue
            content = data.decode("utf-8", errors="replace")
            score = token_overlap_score(query_tokens, f"{key} {content}")
            if score > 0:
                scored.append(StorageSearchResult(key=key, score=score, data=data))

        scored.sort(key=lambda result: result.score, reverse=True)
        return scored
