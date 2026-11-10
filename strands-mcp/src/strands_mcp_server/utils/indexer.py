from __future__ import annotations

import math
import re
import threading
from collections import Counter
from dataclasses import dataclass
from typing import Dict, List, Set, Tuple

_TOKEN = re.compile(r"[A-Za-z0-9_]+")
_MD_HEADER = re.compile(r"^#{1,6}\s+(.+)$", re.MULTILINE)


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


_K1 = 1.2
# Each field saturates on its own, so a long body adds a bounded amount per query term.
_FIELD_WEIGHTS = {"title": 4.0, "headings": 1.0, "body": 1.0}
# Light title normalization keeps an llms.txt description from costing a page its title match.
_FIELD_B = {"title": 0.3, "headings": 0.75, "body": 0.75}

FieldCounts = Dict[str, Counter[str]]


def _tokenize(text: str) -> List[str]:
    return _TOKEN.findall(text.lower())


def _field_counts(index_title: str, content: str) -> FieldCounts:
    """Count the tokens of each scored field: the index title, Markdown headings, and the full body."""
    return {
        "title": Counter(_tokenize(index_title)),
        "headings": Counter(_tokenize(" ".join(_MD_HEADER.findall(content)))),
        "body": Counter(_tokenize(content)),
    }


def _tokens(fields: FieldCounts) -> Set[str]:
    return set().union(*fields.values())


class IndexSearch:
    """Lightweight inverted index with field-weighted BM25 scoring.

    Each document has three fields: its index title (title variants, URL path words, and description), its
    Markdown headings, and its body. Token counts per field are computed once when a document is added or its
    content is updated; search reads only those counts.

    Note:
        This class is an internal implementation detail of strands-mcp-server.
        It is NOT part of the public API and may change without notice.
        Do not import or depend on it from external code.

    Thread Safety:
        All public methods (add, update_content, search) are thread-safe.
        A single lock guards all shared state, so mutations are atomic
        read-modify-write operations and searches see a consistent index
        (e.g., background prefetch daemon + foreground ensure_page).

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
        self.doc_fields: Dict[int, FieldCounts] = {}  # idx -> field -> token counts
        self.doc_lengths: Dict[int, Dict[str, int]] = {}  # idx -> field -> token count
        self._field_length_sum = dict.fromkeys(_FIELD_WEIGHTS, 0)
        self._field_doc_count = dict.fromkeys(_FIELD_WEIGHTS, 0)  # docs with a non-empty field

    def _bump_df(self, tok: str) -> None:
        """Increment the document frequency for a token (read-modify-write).

        Isolated into its own method so concurrency tests can monkeypatch it to
        force the deterministic interleaving that exposes the lost-update race the
        index lock guards against. Must be called with ``self._lock`` held.
        """
        self.doc_frequency[tok] = self.doc_frequency.get(tok, 0) + 1

    def _store_fields(self, idx: int, fields: FieldCounts) -> None:
        """Commit a document's field counts and keep the per-field length totals in step.

        Must be called with ``self._lock`` held.
        """
        lengths = {name: counts.total() for name, counts in fields.items()}
        for name, length in self.doc_lengths.get(idx, {}).items():
            self._field_length_sum[name] -= length
            self._field_doc_count[name] -= length > 0
        for name, length in lengths.items():
            self._field_length_sum[name] += length
            self._field_doc_count[name] += length > 0
        self.doc_fields[idx] = fields
        self.doc_lengths[idx] = lengths

    def add(self, doc: Doc) -> None:
        """Add a document to the search index.

        Thread-safe: acquires lock for the entire add operation.

        Args:
            doc: Document to add to the index
        """
        fields = _field_counts(doc.index_title, doc.content)
        with self._lock:
            idx = len(self.docs)
            self.docs.append(doc)
            self.uri_to_idx[doc.uri] = idx
            for tok in _tokens(fields):
                self.doc_indices.setdefault(tok, []).append(idx)
                self._bump_df(tok)
            self._store_fields(idx, fields)

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

            old_tokens = _tokens(self.doc_fields[idx])
            new_fields = _field_counts(doc.index_title, new_content)
            new_tokens = _tokens(new_fields)

            for tok in old_tokens - new_tokens:
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

            for tok in new_tokens - old_tokens:
                self.doc_indices.setdefault(tok, []).append(idx)
                self._bump_df(tok)

            # Commit fields and content last: if anything above raised, doc.content is
            # unchanged and the idempotence guard allows a retry
            self._store_fields(idx, new_fields)
            doc.content = new_content

            return True

    def _term_score(self, idx: int, tok: str, avg_lengths: Dict[str, float]) -> float:
        """Sum the weighted BM25 term-frequency component of ``tok`` over a document's fields."""
        score = 0.0
        for name, counts in self.doc_fields[idx].items():
            tf = counts[tok]
            if tf:
                b = _FIELD_B[name]
                norm = 1 - b + b * self.doc_lengths[idx][name] / avg_lengths[name]
                score += _FIELD_WEIGHTS[name] * tf * (_K1 + 1) / (tf + _K1 * norm)
        return score

    def search(self, query: str, k: int = 8) -> List[Tuple[float, Doc]]:
        """Search the index and return ranked results.

        Scores are field-weighted BM25: unbounded, non-negative, and comparable only
        within one result set.

        Thread-safe: holds the lock while scoring so ranking sees a consistent index.

        Args:
            query: Search query string
            k: Maximum number of results to return

        Returns:
            List of (score, document) tuples sorted by relevance (highest first)
        """
        q_tokens = _tokenize(query)
        scores: Dict[int, float] = {}
        with self._lock:
            n_docs = len(self.docs)
            avg_lengths = {
                name: self._field_length_sum[name] / max(self._field_doc_count[name], 1) for name in _FIELD_WEIGHTS
            }
            for qt in q_tokens:
                df = self.doc_frequency.get(qt, 0)
                idf = math.log(1 + (n_docs - df + 0.5) / (df + 0.5))
                for idx in set(self.doc_indices.get(qt, [])):
                    scores[idx] = scores.get(idx, 0.0) + idf * self._term_score(idx, qt, avg_lengths)
            ranked = sorted(((score, self.docs[i]) for i, score in scores.items()), key=lambda x: x[0], reverse=True)
        return ranked[:k]
