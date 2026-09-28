"""Helpers for the live Bedrock Knowledge Base integration tests.

The cleanup helpers take a ``registrar`` (a list the owning fixture drains in teardown) rather than
self-registering. Unique test markers are ``uuid``-based, and indexing waits are ``asyncio.sleep``
poll loops.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from collections.abc import Callable
from typing import Any
from urllib.parse import urlparse

from strands.memory.types import MemoryEntry, SearchOptions
from strands.vended_memory_stores.bedrock_knowledge_base import BedrockKnowledgeBaseStore

# A best-effort cleanup callback queued during a test and drained by the owning fixture's teardown.
CleanupCallback = Callable[[], None]
CleanupRegistrar = list[CleanupCallback]


def unique_marker(label: str) -> str:
    """Generate a globally unique marker so concurrent tests against the same KB don't collide.

    Uniqueness is the only requirement, so this uses a UUID suffix.
    """
    return f"integ-{label}-{uuid.uuid4().hex[:12]}"


async def search_until(
    store: BedrockKnowledgeBaseStore,
    query: str,
    predicate: Callable[[MemoryEntry], bool] | None = None,
    *,
    timeout_s: float = 150.0,
    interval_s: float = 2.0,
) -> MemoryEntry | None:
    """Poll a store search until an entry matches ``predicate`` (default: any result), or time out.

    Returns the matched entry, or ``None`` on timeout.

    Two usage modes, both covered by the default budget:

    - After :func:`wait_for_indexed`, to absorb ``Retrieve`` propagation lag - even after a document
      reports INDEXED, a single search can miss it. Here the match lands on the first poll and the
      budget is never consumed.
    - Standalone, when the written content has no searchable test-known id: extraction rephrases what
      it writes across an unknown number of documents, so there is no single id to await via
      :func:`wait_for_indexed`. Here the poll must cover the whole write->index->retrieve pipeline,
      so the default spans indexing latency (see :func:`wait_for_indexed`) plus retrieve lag.
    """
    if predicate is None:
        predicate = lambda _entry: True  # noqa: E731 - tiny default predicate

    deadline = time.monotonic() + timeout_s
    while True:
        entries = await store.search(query, SearchOptions(max_search_results=10))
        for entry in entries:
            if predicate(entry):
                return entry
        if time.monotonic() >= deadline:
            return None
        await asyncio.sleep(interval_s)


def wait_for_indexed(
    agent_client: Any,
    knowledge_base_id: str,
    data_source_id: str,
    document_identifier: dict[str, Any],
    *,
    timeout_s: float = 120.0,
    interval_s: float = 2.0,
) -> None:
    """Poll until the document reaches INDEXED (or fails/times out).

    Ingestion is async even for ``IngestKnowledgeBaseDocuments`` and routinely takes upward of a
    minute under load; without this a subsequent ``Retrieve`` can miss the document. The boto3 key
    casing matches the store
    (``knowledgeBaseId``/``dataSourceId``/``documentIdentifiers``).

    Args:
        agent_client: A ``bedrock-agent`` boto3 client.
        knowledge_base_id: The knowledge base id.
        data_source_id: The data source id.
        document_identifier: A Bedrock document identifier, e.g.
            ``{"dataSourceType": "CUSTOM", "custom": {"id": "..."}}`` or
            ``{"dataSourceType": "S3", "s3": {"uri": "s3://..."}}``.

    Raises:
        RuntimeError: If the document reports ``FAILED`` or does not index before the timeout.
    """
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        response = agent_client.get_knowledge_base_documents(
            knowledgeBaseId=knowledge_base_id,
            dataSourceId=data_source_id,
            documentIdentifiers=[document_identifier],
        )
        details = response.get("documentDetails") or []
        detail = details[0] if details else None
        status = detail.get("status") if detail else None
        if status in ("INDEXED", "PARTIALLY_INDEXED"):
            return
        if status == "FAILED":
            raise RuntimeError(f"Document indexing failed: {detail.get('statusReason', 'unknown')}")
        time.sleep(interval_s)
    raise RuntimeError(f"Document did not reach INDEXED within {timeout_s}s")


def cleanup_custom_document(
    registrar: CleanupRegistrar,
    agent_client: Any,
    knowledge_base_id: str,
    data_source_id: str,
    document_id: str,
) -> None:
    """Queue best-effort cleanup for a CUSTOM document (drained by the owning fixture's teardown)."""

    def _cleanup() -> None:
        try:
            agent_client.delete_knowledge_base_documents(
                knowledgeBaseId=knowledge_base_id,
                dataSourceId=data_source_id,
                documentIdentifiers=[{"dataSourceType": "CUSTOM", "custom": {"id": document_id}}],
            )
        except Exception:  # noqa: BLE001 - best-effort; don't mask test failures.
            pass

    registrar.append(_cleanup)


def cleanup_s3_document(
    registrar: CleanupRegistrar,
    agent_client: Any,
    s3_client: Any,
    knowledge_base_id: str,
    data_source_id: str,
    bucket: str,
    content_key: str,
) -> None:
    """Queue best-effort cleanup for an S3 document.

    Deletes the content object, its optional ``.metadata.json`` sidecar, and the KB document entry.
    """

    def _cleanup() -> None:
        for key in (content_key, f"{content_key}.metadata.json"):
            try:
                s3_client.delete_object(Bucket=bucket, Key=key)
            except Exception:  # noqa: BLE001 - best-effort.
                pass

        uri = f"s3://{bucket}/{content_key}"
        try:
            agent_client.delete_knowledge_base_documents(
                knowledgeBaseId=knowledge_base_id,
                dataSourceId=data_source_id,
                documentIdentifiers=[{"dataSourceType": "S3", "s3": {"uri": uri}}],
            )
        except Exception:  # noqa: BLE001 - best-effort.
            pass

    registrar.append(_cleanup)


def key_from_uri(uri: str) -> str:
    """Extract the S3 object key from an ``s3://`` URI."""
    return urlparse(uri).path.lstrip("/")
