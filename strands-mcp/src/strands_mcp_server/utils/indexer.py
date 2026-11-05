from __future__ import annotations

import math
import re
import threading
from dataclasses import dataclass
from typing import Dict, List, Set, Tuple

# Enhanced tokenization patterns
_TOKEN = re.compile(r"[A-Za-z0-9_]+")
_MD_HEADER = re.compile(r"^#{1,6}\s+(.+)$", re.MULTILINE)
_MD_CODE_BLOCK = re.compile(r"```[\w]*\n([\s\S]*?)```")
_MD_INLINE_CODE = re.compile(r"`([^`]+)`")
_MD_LINK_TEXT = re.compile(r"\[([^\]]+)\]\([^)]+\)")


@dataclass(slots=True)
class Doc:
    """A single indexed document with display and search metadata.

    Attributes:
        uri: Unique identifier/URL for the document
        display_title: Human-readable title shown to users
        content: Full text content (may be empty before fetching)
        index_title: Searchable title text including variants and synonyms
    """

    uri: str  # Unique identifier/URL for the document
    display_title: str  # Human-readable title shown to users
    content: str  # Full text content (may be empty before fetching)
    index_title: str  # Searchable title text including variants


# Title boost constants
_TITLE_BOOST_EMPTY = 8  # boost for unfetched content
_TITLE_BOOST_SHORT = 5  # boost for short pages (<800 chars)
_TITLE_BOOST_LONG = 3  # boost for longer pages
_SHORT_PAGE_THRESHOLD = 800  # character threshold for short pages


class IndexSearch:
    """Lightweight inverted index with TF-IDF scoring and Markdown awareness.

    This class provides document indexing and search functionality optimized for
    technical documentation. It uses TF-IDF scoring with special handling for
    Markdown structure elements like headers, code blocks, and links.

    Note:
        This class is an internal implementation detail of strands-mcp-server.
        It is NOT part of the public API and may change without notice.
        Do not import or depend on it from external code.

    Thread Safety:
        All public methods (add, update_content, search) are thread-safe.
        A single lock guards all shared state mutations to ensure atomic
        read-modify-write operations when used by concurrent threads
        (e.g., background prefetch daemon + foreground ensure_page).

    Features:
        - Indexes searchable titles (not display titles) for synonym support
        - Adaptive title boosting based on content length
        - Enhanced scoring for Markdown elements (headers, code, links)
        - Lightweight implementation without external dependencies

    Attributes:
        docs: List of indexed documents
        doc_frequency: Token document frequency for IDF calculation
        doc_indices: Inverted index mapping tokens to document indices
    """

    def __init__(self) -> None:
        """Initialize an empty search index."""
        self._lock = threading.Lock()
        self.docs: List[Doc] = []
        self.doc_frequency: Dict[str, int] = {}  # document frequency
        self.doc_indices: Dict[str, List[int]] = {}  # token -> doc indices
        self.uri_to_idx: Dict[str, int] = {}  # uri -> doc index for updates
        self.doc_tokens: Dict[int, Set[str]] = {}  # idx -> set of tokens (for rehydration)

    def _index_tokens_for_doc(self, idx: int, doc: Doc) -> Set[str]:
        """Extract tokens from a document and add them to the inverted index.

        Returns the set of unique tokens indexed, tracked for later rehydration.
        Must be called with ``self._lock`` held.
        """
        tokens = self._extract_tokens(doc)
        for tok in tokens:
            self.doc_indices.setdefault(tok, []).append(idx)
            self._bump_df(tok)
        return tokens

    def _bump_df(self, tok: str) -> None:
        """Increment the document frequency for a token (read-modify-write).

        Isolated into its own method so concurrency tests can monkeypatch it to
        force the deterministic interleaving that exposes the lost-update race the
        index lock guards against. Must be called with ``self._lock`` held.
        """
        self.doc_frequency[tok] = self.doc_frequency.get(tok, 0) + 1

    def add(self, doc: Doc) -> None:
        """Add a document to the search index.

        Thread-safe: acquires lock for the entire add operation.

        Args:
            doc: Document to add to the index

        Note:
            Extracts and weights different content types:
            - Titles: Highest weight for search relevance
            - Headers: High weight for structural importance
            - Code blocks: Medium weight for technical content
            - Link text: Medium weight for navigation context
            - Body text: Base weight for general content
        """
        with self._lock:
            idx = len(self.docs)
            self.docs.append(doc)
            self.uri_to_idx[doc.uri] = idx

            # Index tokens and track which tokens belong to this doc
            self.doc_tokens[idx] = self._index_tokens_for_doc(idx, doc)

    def update_content(self, uri: str, new_content: str) -> bool:
        """Update content for an existing document and reindex.

        Called when document content is hydrated after initial title-only indexing.
        Idempotent - calling with the same content multiple times is safe.

        Thread-safe: acquires lock for the entire update operation.
        """
        with self._lock:
            idx = self.uri_to_idx.get(uri)
            if idx is None:
                return False

            doc = self.docs[idx]

            # Skip if content unchanged (idempotent)
            if doc.content == new_content:
                return True

            # Get old tokens and new tokens (extract from new_content WITHOUT
            # assigning doc.content yet — atomic: content committed last)
            old_tokens = self.doc_tokens.get(idx, set())
            new_tokens = self._extract_tokens(doc, content_override=new_content)

            # Tokens to remove from index (in old but not in new)
            tokens_to_remove = old_tokens - new_tokens

            # Tokens to add to index (in new but not in old)
            tokens_to_add = new_tokens - old_tokens

            # Update document frequency for removed tokens
            for tok in tokens_to_remove:
                if tok in self.doc_frequency:
                    self.doc_frequency[tok] -= 1
                    if self.doc_frequency[tok] <= 0:
                        del self.doc_frequency[tok]
                if tok in self.doc_indices:
                    try:
                        self.doc_indices[tok].remove(idx)
                    except ValueError:
                        pass
                    if not self.doc_indices[tok]:
                        del self.doc_indices[tok]

            # Add new tokens to index
            for tok in tokens_to_add:
                self.doc_indices.setdefault(tok, []).append(idx)
                self._bump_df(tok)

            # Update tracked tokens and commit content last — if anything above
            # raised, doc.content is unchanged and the idempotence guard allows retry
            self.doc_tokens[idx] = new_tokens
            doc.content = new_content

            return True

    @staticmethod
    def _build_haystack(doc: Doc, content_override: str | None = None) -> str:
        """Assemble the combined searchable text for a document.

        Concatenates the index title with Markdown-structural extracts (headers,
        link text, code blocks, inline code) and the raw body. This is the single
        source of truth for what counts as a token source, shared by both indexing
        (:meth:`_index_tokens_for_doc`) and reindexing (:meth:`_extract_tokens`),
        so the two can never drift and silently corrupt ``doc_frequency`` via the
        ``old_tokens - new_tokens`` diff in :meth:`update_content`.
        """
        raw_content = content_override if content_override is not None else doc.content
        haystack_parts = [
            doc.index_title.lower(),
            " ".join(_MD_HEADER.findall(raw_content)).lower(),
            " ".join(_MD_LINK_TEXT.findall(raw_content)).lower(),
            " ".join(_MD_CODE_BLOCK.findall(raw_content)).lower(),
            " ".join(_MD_INLINE_CODE.findall(raw_content)).lower(),
            raw_content.lower(),
        ]
        return " ".join(part for part in haystack_parts if part)

    def _extract_tokens(self, doc: Doc, content_override: str | None = None) -> Set[str]:
        """Return the set of unique lowercased tokens for a document (no indexing)."""
        haystack = self._build_haystack(doc, content_override)
        return {tok.lower() for tok in _TOKEN.findall(haystack)}

    def search(self, query: str, k: int = 8) -> List[Tuple[float, Doc]]:
        """Search the index and return ranked results.

        Uses TF-IDF scoring with Markdown-aware enhancements:
        - Title matches receive adaptive boosting
        - Header matches get 4x weight
        - Code and link matches get 2x weight
        - Empty content gets higher title boost for better ranking

        Thread-safe: acquires lock to ensure consistent reads of index state.

        Args:
            query: Search query string
            k: Maximum number of results to return

        Returns:
            List of (score, document) tuples sorted by relevance (highest first)
        """

        def _title_boost_for(doc: Doc) -> int:
            """Calculate title boost factor based on document content length.

            Args:
                doc: Document to calculate boost for

            Returns:
                Boost multiplier for title matches
            """
            n = len(doc.content)
            if n == 0:  # not fetched yet
                return _TITLE_BOOST_EMPTY
            if n < _SHORT_PAGE_THRESHOLD:  # short page
                return _TITLE_BOOST_SHORT
            return _TITLE_BOOST_LONG

        def _calculate_md_score(doc: Doc, token: str) -> float:
            """Calculate enhanced relevance score for Markdown content.

            Args:
                doc: Document to score
                token: Search token to score against

            Returns:
                Weighted relevance score considering Markdown structure

            Note:
                Applies different weights to content types:
                - Title matches: Variable boost (8x/5x/3x based on content length)
                - Header matches: 4x weight
                - Code matches: 2x weight
                - Link text matches: 2x weight
                - Body text: 1x weight (base)
            """
            content_lower = doc.content.lower()
            title_lower = doc.index_title.lower()

            # Base content frequency
            content_tf = content_lower.count(token)

            # Title matches (highest weight)
            title_tf = title_lower.count(token) * _title_boost_for(doc)

            # Header matches (high weight)
            header_tf = 0
            for header in _MD_HEADER.findall(doc.content):
                header_tf += header.lower().count(token) * 4

            # Code block matches (medium weight for tech docs)
            code_tf = 0
            for code in _MD_CODE_BLOCK.findall(doc.content):
                code_tf += code.lower().count(token) * 2

            # Link text matches (medium weight)
            link_tf = 0
            for link in _MD_LINK_TEXT.findall(doc.content):
                link_tf += link.lower().count(token) * 2

            return float(content_tf + title_tf + header_tf + code_tf + link_tf)

        q_tokens = [t.lower() for t in _TOKEN.findall(query)]

        # Snapshot the posting/df structures under the lock so ranking sees a
        # point-in-time-consistent view of them. doc.content is read live during
        # scoring below, so a concurrent hydration may pair these postings with
        # newer content — eventually consistent, never corrupt (attribute writes
        # are atomic under the GIL).
        with self._lock:
            docs_snapshot = list(self.docs)
            doc_frequency_snapshot = dict(self.doc_frequency)
            doc_indices_snapshot = {k: list(v) for k, v in self.doc_indices.items()}

        scores: Dict[int, float] = {}
        N = max(len(docs_snapshot), 1)

        for qt in q_tokens:
            for idx in doc_indices_snapshot.get(qt, []):
                if idx < len(docs_snapshot):
                    d = docs_snapshot[idx]
                    tf = _calculate_md_score(d, qt)
                    idf = math.log((N + 1) / (1 + doc_frequency_snapshot.get(qt, 0))) + 1.0
                    scores[idx] = scores.get(idx, 0.0) + tf * idf

        ranked = sorted(((score, docs_snapshot[i]) for i, score in scores.items()), key=lambda x: x[0], reverse=True)
        return ranked[:k]
