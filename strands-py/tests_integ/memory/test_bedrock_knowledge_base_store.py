"""Live integration tests for ``BedrockKnowledgeBaseStore``.

The live tests need only a Bedrock Knowledge Base (resolved via the ``bedrock_kb_context`` fixture in
``conftest.py``) and skip when it is unavailable; the pure-constructor validation tests need no AWS
access. Clients come from a fixture and per-test cleanup is appended to the ``cleanup_registrar`` list
(drained in its fixture teardown).
"""

from __future__ import annotations

import boto3
import pytest

from strands.memory.types import SearchOptions
from strands.vended_memory_stores.bedrock_knowledge_base import (
    BedrockKnowledgeBaseConfig,
    BedrockKnowledgeBaseS3Config,
    BedrockKnowledgeBaseStore,
)

from ._bedrock_kb_test_helpers import (
    cleanup_custom_document,
    cleanup_s3_document,
    key_from_uri,
    search_until,
    unique_marker,
    wait_for_indexed,
)

# Bedrock KB ingestion is eventually consistent and routinely exceeds the global 90s per-test cap
# once indexing (up to 120s) and the follow-on search poll are serialized; raise it for this suite.
pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(300)]


@pytest.fixture(scope="session")
def kb_clients():
    """Build the boto3 clients the live store tests share.

    Built once per session from the default credential chain.
    """
    session = boto3.Session()
    return {
        "agent": session.client("bedrock-agent"),
        "runtime": session.client("bedrock-agent-runtime"),
        "s3": session.client("s3"),
    }


@pytest.fixture
def skip_if_no_kb(bedrock_kb_context):
    """Skip a test when the live Bedrock KB is unavailable."""
    if bedrock_kb_context.should_skip:
        pytest.skip("Bedrock KB test-infra parameters not available")


# --------------------------------------------------------------------------- #
# CUSTOM data source
# --------------------------------------------------------------------------- #


class TestCustomDataSource:
    """Ingestion and retrieval against a ``CUSTOM`` data source (content ingested inline)."""

    async def test_adds_and_searches_a_document(self, skip_if_no_kb, bedrock_kb_context, kb_clients, cleanup_registrar):
        """Ingest a CUSTOM document, wait for it to index, then find it by semantic search."""
        kb_id = bedrock_kb_context.knowledge_base_id
        ds_id = bedrock_kb_context.custom_data_source_id

        store = BedrockKnowledgeBaseStore(
            config=BedrockKnowledgeBaseConfig(
                knowledge_base_id=kb_id,
                data_source_type="CUSTOM",
                data_source_id=ds_id,
                runtime_client=kb_clients["runtime"],
                agent_client=kb_clients["agent"],
            ),
            name="integ-custom",
            writable=True,
        )

        marker = unique_marker("custom-add")
        content = f"The project codename is {marker}. It launched in 2025."

        result = await store.add(content)
        assert result.document_id
        cleanup_custom_document(cleanup_registrar, kb_clients["agent"], kb_id, ds_id, result.document_id)

        wait_for_indexed(
            kb_clients["agent"], kb_id, ds_id, {"dataSourceType": "CUSTOM", "custom": {"id": result.document_id}}
        )

        match = await search_until(store, marker, lambda entry: marker in entry.content)
        assert match is not None
        assert "launched in 2025" in match.content

    async def test_adds_with_scope_and_retrieves_filtered(
        self, skip_if_no_kb, bedrock_kb_context, kb_clients, cleanup_registrar
    ):
        """A scoped store stamps writes with its scope and finds them back through the scope filter."""
        kb_id = bedrock_kb_context.knowledge_base_id
        ds_id = bedrock_kb_context.custom_data_source_id

        scope = unique_marker("scope")
        store = BedrockKnowledgeBaseStore(
            config=BedrockKnowledgeBaseConfig(
                knowledge_base_id=kb_id,
                data_source_type="CUSTOM",
                data_source_id=ds_id,
                runtime_client=kb_clients["runtime"],
                agent_client=kb_clients["agent"],
            ),
            name="integ-custom-scoped",
            writable=True,
            scope=scope,
        )

        marker = unique_marker("custom-scope")
        result = await store.add(f"Scoped fact: {marker}")
        cleanup_custom_document(cleanup_registrar, kb_clients["agent"], kb_id, ds_id, result.document_id)

        wait_for_indexed(
            kb_clients["agent"], kb_id, ds_id, {"dataSourceType": "CUSTOM", "custom": {"id": result.document_id}}
        )

        assert await search_until(store, marker, lambda entry: marker in entry.content) is not None

    async def test_scope_isolates_documents_from_other_scopes(
        self, skip_if_no_kb, bedrock_kb_context, kb_clients, cleanup_registrar
    ):
        """A document written under one scope is invisible to a store searching under a different scope."""
        kb_id = bedrock_kb_context.knowledge_base_id
        ds_id = bedrock_kb_context.custom_data_source_id

        scope_a = unique_marker("isolate-a")
        scope_b = unique_marker("isolate-b")
        marker = unique_marker("isolation")

        store_a = BedrockKnowledgeBaseStore(
            config=BedrockKnowledgeBaseConfig(
                knowledge_base_id=kb_id,
                data_source_type="CUSTOM",
                data_source_id=ds_id,
                runtime_client=kb_clients["runtime"],
                agent_client=kb_clients["agent"],
            ),
            name="integ-scope-a",
            writable=True,
            scope=scope_a,
        )

        store_b = BedrockKnowledgeBaseStore(
            config=BedrockKnowledgeBaseConfig(
                knowledge_base_id=kb_id,
                data_source_type="CUSTOM",
                data_source_id=ds_id,
                runtime_client=kb_clients["runtime"],
                agent_client=kb_clients["agent"],
            ),
            name="integ-scope-b",
            scope=scope_b,
        )

        result = await store_a.add(f"Isolated fact: {marker}")
        cleanup_custom_document(cleanup_registrar, kb_clients["agent"], kb_id, ds_id, result.document_id)

        wait_for_indexed(
            kb_clients["agent"], kb_id, ds_id, {"dataSourceType": "CUSTOM", "custom": {"id": result.document_id}}
        )

        assert await search_until(store_a, marker, lambda entry: marker in entry.content) is not None

        # Absence is only meaningful once the doc is confirmed retrievable in scope A above.
        entries_b = await store_b.search(marker, SearchOptions(max_search_results=10))
        assert not any(marker in entry.content for entry in entries_b)

    async def test_adds_with_metadata_attributes_and_returns_them_in_search(
        self, skip_if_no_kb, bedrock_kb_context, kb_clients, cleanup_registrar
    ):
        """Caller metadata round-trips through search, plus the synthetic ``_relevance_score``/``_source_location``."""
        kb_id = bedrock_kb_context.knowledge_base_id
        ds_id = bedrock_kb_context.custom_data_source_id

        store = BedrockKnowledgeBaseStore(
            config=BedrockKnowledgeBaseConfig(
                knowledge_base_id=kb_id,
                data_source_type="CUSTOM",
                data_source_id=ds_id,
                runtime_client=kb_clients["runtime"],
                agent_client=kb_clients["agent"],
            ),
            name="integ-custom-meta",
            writable=True,
        )

        marker = unique_marker("custom-meta")
        result = await store.add(f"Metadata fact: {marker}", {"priority": "high", "version": 3})
        cleanup_custom_document(cleanup_registrar, kb_clients["agent"], kb_id, ds_id, result.document_id)

        wait_for_indexed(
            kb_clients["agent"], kb_id, ds_id, {"dataSourceType": "CUSTOM", "custom": {"id": result.document_id}}
        )

        match = await search_until(store, marker, lambda entry: marker in entry.content)
        assert match is not None
        assert match.metadata is not None
        assert match.metadata.get("priority") == "high"
        assert match.metadata.get("version") == 3
        # Synthetic result keys are snake_case: ``_relevance_score`` / ``_source_location``.
        assert isinstance(match.metadata.get("_relevance_score"), (int, float))
        assert match.metadata.get("_source_location") is not None


# --------------------------------------------------------------------------- #
# S3 data source
# --------------------------------------------------------------------------- #


class TestS3DataSource:
    """Ingestion and retrieval against an ``S3`` data source (object upload plus optional sidecar)."""

    async def test_adds_and_searches_a_document_via_s3(
        self, skip_if_no_kb, bedrock_kb_context, kb_clients, cleanup_registrar
    ):
        """Ingest via an S3 data source: ``add`` returns an ``s3://`` URI and the content is searchable."""
        kb_id = bedrock_kb_context.knowledge_base_id
        ds_id = bedrock_kb_context.s3_data_source_id
        bucket = bedrock_kb_context.s3_bucket

        store = BedrockKnowledgeBaseStore(
            config=BedrockKnowledgeBaseConfig(
                knowledge_base_id=kb_id,
                data_source_type="S3",
                data_source_id=ds_id,
                runtime_client=kb_clients["runtime"],
                agent_client=kb_clients["agent"],
                s3=BedrockKnowledgeBaseS3Config(
                    bucket=bucket, client=kb_clients["s3"], prefix=f"integ-test/{unique_marker('pfx')}/"
                ),
            ),
            name="integ-s3",
            writable=True,
        )

        marker = unique_marker("s3-add")
        content = f"S3 stored fact: {marker}. The answer is 42."

        result = await store.add(content)
        assert result.document_id.startswith("s3://")

        content_key = key_from_uri(result.document_id)
        cleanup_s3_document(cleanup_registrar, kb_clients["agent"], kb_clients["s3"], kb_id, ds_id, bucket, content_key)

        wait_for_indexed(kb_clients["agent"], kb_id, ds_id, {"dataSourceType": "S3", "s3": {"uri": result.document_id}})

        match = await search_until(store, marker, lambda entry: marker in entry.content)
        assert match is not None
        assert "answer is 42" in match.content

    async def test_adds_with_scope_and_writes_a_sidecar(
        self, skip_if_no_kb, bedrock_kb_context, kb_clients, cleanup_registrar
    ):
        """A scoped S3 write emits a ``.metadata.json`` sidecar carrying the scope, and the content is searchable."""
        kb_id = bedrock_kb_context.knowledge_base_id
        ds_id = bedrock_kb_context.s3_data_source_id
        bucket = bedrock_kb_context.s3_bucket

        scope = unique_marker("s3scope")
        store = BedrockKnowledgeBaseStore(
            config=BedrockKnowledgeBaseConfig(
                knowledge_base_id=kb_id,
                data_source_type="S3",
                data_source_id=ds_id,
                runtime_client=kb_clients["runtime"],
                agent_client=kb_clients["agent"],
                s3=BedrockKnowledgeBaseS3Config(
                    bucket=bucket, client=kb_clients["s3"], prefix=f"integ-test/{unique_marker('pfx')}/"
                ),
            ),
            name="integ-s3-scoped",
            writable=True,
            scope=scope,
        )

        marker = unique_marker("s3-scoped")
        result = await store.add(f"S3 scoped: {marker}")
        content_key = key_from_uri(result.document_id)
        cleanup_s3_document(cleanup_registrar, kb_clients["agent"], kb_clients["s3"], kb_id, ds_id, bucket, content_key)

        wait_for_indexed(kb_clients["agent"], kb_id, ds_id, {"dataSourceType": "S3", "s3": {"uri": result.document_id}})

        match = await search_until(store, marker, lambda entry: marker in entry.content)
        assert match is not None
        assert match.metadata is not None
        assert match.metadata.get("namespace") == scope

    async def test_scope_isolates_s3_documents_from_other_scopes(
        self, skip_if_no_kb, bedrock_kb_context, kb_clients, cleanup_registrar
    ):
        """Scope isolation holds for S3 documents too: a sidecar scope is invisible to another scope's store."""
        kb_id = bedrock_kb_context.knowledge_base_id
        ds_id = bedrock_kb_context.s3_data_source_id
        bucket = bedrock_kb_context.s3_bucket

        scope_a = unique_marker("s3-iso-a")
        scope_b = unique_marker("s3-iso-b")
        marker = unique_marker("s3-isolation")

        store_a = BedrockKnowledgeBaseStore(
            config=BedrockKnowledgeBaseConfig(
                knowledge_base_id=kb_id,
                data_source_type="S3",
                data_source_id=ds_id,
                runtime_client=kb_clients["runtime"],
                agent_client=kb_clients["agent"],
                s3=BedrockKnowledgeBaseS3Config(
                    bucket=bucket, client=kb_clients["s3"], prefix=f"integ-test/{unique_marker('pfx')}/"
                ),
            ),
            name="integ-s3-iso-a",
            writable=True,
            scope=scope_a,
        )

        store_b = BedrockKnowledgeBaseStore(
            config=BedrockKnowledgeBaseConfig(
                knowledge_base_id=kb_id,
                data_source_type="S3",
                data_source_id=ds_id,
                runtime_client=kb_clients["runtime"],
                agent_client=kb_clients["agent"],
                s3=BedrockKnowledgeBaseS3Config(
                    bucket=bucket, client=kb_clients["s3"], prefix=f"integ-test/{unique_marker('pfx')}/"
                ),
            ),
            name="integ-s3-iso-b",
            scope=scope_b,
        )

        result = await store_a.add(f"S3 isolated: {marker}")
        content_key = key_from_uri(result.document_id)
        cleanup_s3_document(cleanup_registrar, kb_clients["agent"], kb_clients["s3"], kb_id, ds_id, bucket, content_key)

        wait_for_indexed(kb_clients["agent"], kb_id, ds_id, {"dataSourceType": "S3", "s3": {"uri": result.document_id}})

        assert await search_until(store_a, marker, lambda entry: marker in entry.content) is not None

        # Absence is only meaningful once the doc is confirmed retrievable in scope A above.
        entries_b = await store_b.search(marker, SearchOptions(max_search_results=10))
        assert not any(marker in entry.content for entry in entries_b)

    async def test_adds_with_metadata_in_the_sidecar(
        self, skip_if_no_kb, bedrock_kb_context, kb_clients, cleanup_registrar
    ):
        """Caller metadata supplied to an S3 ``add`` round-trips through search via the sidecar."""
        kb_id = bedrock_kb_context.knowledge_base_id
        ds_id = bedrock_kb_context.s3_data_source_id
        bucket = bedrock_kb_context.s3_bucket

        store = BedrockKnowledgeBaseStore(
            config=BedrockKnowledgeBaseConfig(
                knowledge_base_id=kb_id,
                data_source_type="S3",
                data_source_id=ds_id,
                runtime_client=kb_clients["runtime"],
                agent_client=kb_clients["agent"],
                s3=BedrockKnowledgeBaseS3Config(
                    bucket=bucket, client=kb_clients["s3"], prefix=f"integ-test/{unique_marker('pfx')}/"
                ),
            ),
            name="integ-s3-meta",
            writable=True,
        )

        marker = unique_marker("s3-meta")
        result = await store.add(f"S3 metadata fact: {marker}", {"category": "testing", "count": 7})
        content_key = key_from_uri(result.document_id)
        cleanup_s3_document(cleanup_registrar, kb_clients["agent"], kb_clients["s3"], kb_id, ds_id, bucket, content_key)

        wait_for_indexed(kb_clients["agent"], kb_id, ds_id, {"dataSourceType": "S3", "s3": {"uri": result.document_id}})

        match = await search_until(store, marker, lambda entry: marker in entry.content)
        assert match is not None
        assert match.metadata is not None
        assert match.metadata.get("category") == "testing"
        assert match.metadata.get("count") == 7


# --------------------------------------------------------------------------- #
# Read-only / error handling
# --------------------------------------------------------------------------- #


class TestReadOnlyAndErrorHandling:
    """Read-only behavior and write-config validation (the last three need no live AWS access)."""

    async def test_throws_when_add_called_on_a_read_only_store(self, skip_if_no_kb, bedrock_kb_context, kb_clients):
        """A store left non-writable rejects ``add`` with a ``ValueError``."""
        kb_id = bedrock_kb_context.knowledge_base_id

        store = BedrockKnowledgeBaseStore(
            config=BedrockKnowledgeBaseConfig(knowledge_base_id=kb_id, runtime_client=kb_clients["runtime"]),
            name="integ-readonly",
        )

        with pytest.raises(ValueError):
            await store.add("should fail")

    async def test_search_works_on_a_read_only_store(self, skip_if_no_kb, bedrock_kb_context, kb_clients):
        """Search is the read path and works regardless of writability: a read-only store still returns a list."""
        kb_id = bedrock_kb_context.knowledge_base_id

        store = BedrockKnowledgeBaseStore(
            config=BedrockKnowledgeBaseConfig(knowledge_base_id=kb_id, runtime_client=kb_clients["runtime"]),
            name="integ-readonly-search",
        )

        entries = await store.search("hello")
        assert isinstance(entries, list)

    async def test_throws_when_writable_with_other_data_source_type(self):
        """Pure constructor validation; needs no AWS access."""
        with pytest.raises(ValueError, match="add requires data_source_type 'CUSTOM' or 'S3'"):
            BedrockKnowledgeBaseStore(
                config=BedrockKnowledgeBaseConfig(knowledge_base_id="fake-id", data_source_type="OTHER"),
                name="integ-other",
                writable=True,
            )

    async def test_throws_when_writable_without_data_source_id(self):
        """Pure constructor validation; needs no AWS access."""
        with pytest.raises(ValueError, match="data_source_id is required"):
            BedrockKnowledgeBaseStore(
                config=BedrockKnowledgeBaseConfig(knowledge_base_id="fake-id", data_source_type="CUSTOM"),
                name="integ-no-ds",
                writable=True,
            )

    async def test_throws_when_writable_s3_store_missing_s3_config(self):
        """Pure constructor validation; needs no AWS access."""
        with pytest.raises(ValueError, match="s3 config is required"):
            BedrockKnowledgeBaseStore(
                config=BedrockKnowledgeBaseConfig(
                    knowledge_base_id="fake-id", data_source_type="S3", data_source_id="fake-ds"
                ),
                name="integ-no-s3",
                writable=True,
            )
