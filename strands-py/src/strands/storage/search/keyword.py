"""Keyword search strategy using token-overlap scoring."""

from __future__ import annotations

import asyncio
import builtins
import logging
import re
from typing import Any, Literal

from ...types.exceptions import StorageError
from ..storage import Storage, StorageSearchResult

logger = logging.getLogger(__name__)


#: Common English words dropped from queries before matching.
STOP_WORDS: frozenset[str] = frozenset(
    {
        "a",
        "about",
        "above",
        "after",
        "again",
        "all",
        "although",
        "an",
        "and",
        "any",
        "are",
        "as",
        "at",
        "be",
        "because",
        "been",
        "before",
        "being",
        "below",
        "between",
        "both",
        "but",
        "by",
        "can",
        "could",
        "dare",
        "did",
        "do",
        "does",
        "during",
        "each",
        "either",
        "every",
        "few",
        "for",
        "from",
        "further",
        "had",
        "has",
        "have",
        "he",
        "her",
        "him",
        "his",
        "how",
        "i",
        "if",
        "in",
        "into",
        "is",
        "it",
        "its",
        "just",
        "may",
        "me",
        "might",
        "more",
        "most",
        "my",
        "need",
        "neither",
        "no",
        "nor",
        "not",
        "of",
        "off",
        "on",
        "once",
        "only",
        "or",
        "other",
        "ought",
        "our",
        "out",
        "over",
        "own",
        "same",
        "shall",
        "she",
        "should",
        "since",
        "so",
        "some",
        "such",
        "than",
        "that",
        "the",
        "their",
        "them",
        "then",
        "these",
        "they",
        "this",
        "those",
        "though",
        "through",
        "to",
        "too",
        "under",
        "unless",
        "until",
        "up",
        "us",
        "used",
        "very",
        "was",
        "we",
        "were",
        "what",
        "when",
        "where",
        "which",
        "while",
        "who",
        "whom",
        "why",
        "will",
        "with",
        "would",
        "yet",
        "you",
        "your",
    }
)

#: Entries read concurrently per batch during a keyword scan, to avoid throttling remote backends such as S3.
_READ_BATCH_SIZE = 8

_EXTENSION = re.compile(r"(?<=[^/])\.[^./]*$")


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

    Tokenizes the query and each stored entry (key without its file extension + content),
    then scores by the number of distinct query tokens that appear. Stop words in the
    query (``the``, ``is``, ``what``, ...) are ignored. Works on any storage backend with
    ``list()`` and ``read()`` -- no index or embedding model required. Entries are read
    in small concurrent batches, and each result carries the bytes read during the scan.
    Entries whose ``read()`` raises ``StorageError`` are skipped.

    This is the default search strategy for all shipped storage backends.

    Example:
        ```python
        from strands.storage.search import KeywordSearchStrategy

        strategy = KeywordSearchStrategy()
        results = await strategy.search(storage, "dark mode toggle")
        ```
    """

    requires_host_fs: Literal[False] = False

    async def index(self, storage: Storage, key: str, data: bytes, **kwargs: Any) -> None:
        """No-op — keyword search scans storage on the fly."""

    async def search(self, storage: Storage, query: str, **kwargs: Any) -> builtins.list[StorageSearchResult]:
        """Search content in storage by keyword token-overlap scoring.

        Args:
            storage: The storage to search over.
            query: A natural-language string query.
            **kwargs: Unused; accepted for protocol compatibility.

        Returns:
            Matched keys with relevance scores, ranked best-first.
        """
        query_tokens = tokenize(query) - STOP_WORDS
        if not query_tokens:
            return []

        all_keys = await storage.list("")
        scored: builtins.list[StorageSearchResult] = []
        for offset in range(0, len(all_keys), _READ_BATCH_SIZE):
            keys = all_keys[offset : offset + _READ_BATCH_SIZE]
            batch = await asyncio.gather(*(_read_or_skip(storage, key) for key in keys))
            for key, data in zip(keys, batch, strict=True):
                if data is None:
                    continue
                content = data.decode("utf-8", errors="replace")
                # Score the key without its extension so e.g. ``md`` does not match every ``.md`` entry.
                score = token_overlap_score(query_tokens, f"{_EXTENSION.sub('', key)} {content}")
                if score > 0:
                    scored.append(StorageSearchResult(key=key, score=score, data=data))

        scored.sort(key=lambda result: result.score, reverse=True)
        return scored


async def _read_or_skip(storage: Storage, key: str) -> bytes | None:
    """Read ``key``, returning ``None`` when the read fails so one bad entry cannot fail a search."""
    try:
        return await storage.read(key)
    except StorageError as error:
        logger.debug("key=<%s>, error=<%s> | skipped unreadable entry", key, error)
        return None
