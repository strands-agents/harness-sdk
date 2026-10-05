"""Tests for ``BedrockKnowledgeBaseStore``.

Each behavior the store guarantees maps to a ``test_...`` case here, grouped into classes.

Test scaffolding:
- boto3 clients are ``MagicMock``s; ``retrieve`` / ``ingest_knowledge_base_documents`` / ``put_object``
  return values (and ``side_effect`` for failures) are programmed per test. Calls are inspected via
  ``.call_args.kwargs``.
- ``make_store`` / ``make_custom_store`` / ``make_s3_store`` are factory fixtures that build a store
  from a base connection config plus per-store fields.
- The generated document id is pinned by monkeypatching ``store_module._new_id``.
- Default-client construction is observed by patching ``boto3.client``.
"""

from __future__ import annotations

import inspect
import json
import logging
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

import strands.vended_memory_stores.bedrock_knowledge_base.store as store_module
from strands.hooks.events import AfterInvocationEvent, MessageAddedEvent
from strands.hooks.registry import HookOrder
from strands.memory.extraction.triggers import InvocationTrigger
from strands.memory.extraction.types import ExtractionConfig, ExtractionResult
from strands.memory.memory_manager import MemoryManager
from strands.memory.types import SearchOptions
from strands.vended_memory_stores.bedrock_knowledge_base import (
    BedrockKnowledgeBaseConfig,
    BedrockKnowledgeBaseS3Config,
    BedrockKnowledgeBaseStore,
)

# --------------------------------------------------------------------------- #
# Test fixtures / helpers
# --------------------------------------------------------------------------- #


@pytest.fixture(autouse=True)
def _pin_id(monkeypatch):
    """Pin the generated document/object id for deterministic assertions."""
    monkeypatch.setattr(store_module, "_new_id", lambda: "test-uuid-v7")


def _mock_client() -> MagicMock:
    """A stub AWS client whose methods are spies the test can program and inspect."""
    return MagicMock()


@pytest.fixture
def make_store():
    """Factory building a store from a base connection config plus per-store fields.

    Returns a callable ``(overrides, config_overrides) -> (store, runtime, agent)``: the injected
    ``runtime`` / ``agent`` spies are ready to program and inspect. ``retrieve`` defaults to an empty
    result set; ``ingest_knowledge_base_documents`` defaults to ``{}``; ``get_knowledge_base`` defaults
    to a ``VECTOR`` knowledge base (re-program it to ``MANAGED`` to exercise managed search).
    """

    def _make(
        overrides: dict[str, Any] | None = None,
        config_overrides: dict[str, Any] | None = None,
    ) -> tuple[BedrockKnowledgeBaseStore, MagicMock, MagicMock]:
        overrides = overrides or {}
        config_overrides = config_overrides or {}

        runtime = _mock_client()
        runtime.retrieve.return_value = {"retrievalResults": []}
        agent = _mock_client()
        agent.ingest_knowledge_base_documents.return_value = {}
        agent.get_knowledge_base.return_value = {"knowledgeBase": {"knowledgeBaseConfiguration": {"type": "VECTOR"}}}

        config = BedrockKnowledgeBaseConfig(
            knowledge_base_id="kb-1",
            runtime_client=runtime,
            agent_client=agent,
            **config_overrides,
        )
        name = overrides.pop("name", "kb")
        store = BedrockKnowledgeBaseStore(config=config, name=name, **overrides)
        return store, runtime, agent

    return _make


@pytest.fixture
def make_custom_store(make_store):
    """Factory for a writable CUSTOM store, with the data source wired into config.

    Returns a callable ``(overrides, config_overrides) -> (store, agent)``.
    """

    def _make(
        overrides: dict[str, Any] | None = None,
        config_overrides: dict[str, Any] | None = None,
    ) -> tuple[BedrockKnowledgeBaseStore, MagicMock]:
        overrides = {"writable": True, **(overrides or {})}
        config_overrides = {"data_source_type": "CUSTOM", "data_source_id": "ds-1", **(config_overrides or {})}
        store, _runtime, agent = make_store(overrides, config_overrides)
        return store, agent

    return _make


@pytest.fixture
def make_s3_store(make_store):
    """Factory for a writable S3 store, with the data source + bucket wired into config.

    Returns a callable ``(overrides, config_overrides) -> (store, agent, s3)``.
    """

    def _make(
        overrides: dict[str, Any] | None = None,
        config_overrides: dict[str, Any] | None = None,
    ) -> tuple[BedrockKnowledgeBaseStore, MagicMock, MagicMock]:
        s3 = _mock_client()
        s3.put_object.return_value = {}
        overrides = {"writable": True, **(overrides or {})}
        config_overrides = {
            "data_source_type": "S3",
            "data_source_id": "ds-1",
            "s3": BedrockKnowledgeBaseS3Config(bucket="my-bucket", client=s3, prefix="memories"),
            **(config_overrides or {}),
        }
        store, _runtime, agent = make_store(overrides, config_overrides)
        return store, agent, s3

    return _make


def _last_search_filter(runtime: MagicMock) -> Any:
    """Read the filter the most recent ``retrieve`` was sent with."""
    config = runtime.retrieve.call_args.kwargs["retrievalConfiguration"]["vectorSearchConfiguration"]
    return config.get("filter")


def _last_inline_attributes(agent: MagicMock) -> list[Any]:
    """Read the inline attributes the most recent CUSTOM ingestion document carried."""
    document = agent.ingest_knowledge_base_documents.call_args.kwargs["documents"][0]
    metadata = document.get("metadata")
    if metadata is None:
        return []
    return metadata.get("inlineAttributes", [])


def _managed_kb(agent: MagicMock) -> None:
    """Program ``get_knowledge_base`` to report a managed knowledge base."""
    agent.get_knowledge_base.return_value = {"knowledgeBase": {"knowledgeBaseConfiguration": {"type": "MANAGED"}}}


def _validation_error(message: str) -> ClientError:
    """Build a botocore ``ValidationException`` carrying ``message``, as Bedrock would raise."""
    return ClientError(
        {"Error": {"Code": "ValidationException", "Message": message}},
        "IngestKnowledgeBaseDocuments",
    )


# --------------------------------------------------------------------------- #
# Constructor
# --------------------------------------------------------------------------- #


class TestConstructor:
    def test_exposes_name_and_defaults_writable_to_false(self, make_store):
        store, _runtime, _agent = make_store()
        assert store.name == "kb"
        assert store.writable is False
        assert store.description is None
        assert store.max_search_results is None
        assert store.min_score is None
        assert store.max_score is None

    def test_keeps_name_and_scope_as_independent_fields(self, make_store):
        store, _runtime, _agent = make_store({"name": "explicit", "scope": "user-abc"})
        assert store.name == "explicit"
        assert store.scope == "user-abc"

    def test_carries_through_description_and_max_search_results(self, make_store):
        store, _runtime, _agent = make_store({"description": "product docs", "max_search_results": 7})
        assert store.description == "product docs"
        assert store.max_search_results == 7

    def test_throws_when_writable_true_but_data_source_type_omitted(self, make_store):
        with pytest.raises(ValueError, match="add requires data_source_type 'CUSTOM' or 'S3'"):
            make_store({"writable": True})

    def test_throws_when_writable_true_but_data_source_type_other(self, make_store):
        with pytest.raises(ValueError, match="add requires data_source_type 'CUSTOM' or 'S3'"):
            make_store({"writable": True}, {"data_source_type": "OTHER"})

    def test_throws_when_max_search_results_less_than_one(self, make_store):
        with pytest.raises(ValueError, match="max_search_results must be at least 1"):
            make_store({"max_search_results": 0})
        with pytest.raises(ValueError, match="max_search_results must be at least 1"):
            make_store({"max_search_results": -5})

    def test_carries_through_min_score(self, make_store):
        store, _runtime, _agent = make_store({"min_score": 0.4})
        assert store.min_score == 0.4
        assert store.max_score is None

    def test_carries_through_max_score(self, make_store):
        store, _runtime, _agent = make_store({"max_score": 0.4})
        assert store.max_score == 0.4
        assert store.min_score is None

    def test_throws_when_min_score_and_max_score_are_both_set(self, make_store):
        with pytest.raises(ValueError, match="min_score and max_score are mutually exclusive"):
            make_store({"min_score": 0.5, "max_score": 0.4})

    def test_throws_when_a_zero_min_score_is_paired_with_max_score(self, make_store):
        with pytest.raises(ValueError, match="min_score and max_score are mutually exclusive"):
            make_store({"min_score": 0.0, "max_score": 0.4})

    def test_allows_writable_with_custom_data_source(self, make_custom_store):
        store, _agent = make_custom_store()
        assert store.writable is True

    def test_allows_writable_with_s3_data_source(self, make_s3_store):
        store, _agent, _s3 = make_s3_store()
        assert store.writable is True

    def test_constructs_a_default_runtime_client_when_none_injected(self):
        with patch("boto3.client") as client_fn:
            BedrockKnowledgeBaseStore(config=BedrockKnowledgeBaseConfig(knowledge_base_id="kb-1"), name="kb")
            client_fn.assert_called_once_with("bedrock-agent-runtime", region_name=None)

    def test_uses_the_injected_runtime_client_without_constructing_one(self, make_store):
        with patch("boto3.client") as client_fn:
            make_store()
            client_fn.assert_not_called()


# --------------------------------------------------------------------------- #
# Region resolution for default clients
# --------------------------------------------------------------------------- #


class TestRegionResolution:
    """Default boto3 clients receive the configured region as a hint; otherwise boto3 resolves it.

    Only an explicit ``region_name`` config is threaded into the store's default ``boto3.client``
    calls. When it is absent, ``None`` is passed so boto3 resolves the region from its own chain.
    """

    def test_no_config_passes_none_so_boto_resolves(self, monkeypatch, tmp_path):
        # A host with no region hint: no env vars and no AWS config file under HOME.
        monkeypatch.delenv("AWS_REGION", raising=False)
        monkeypatch.delenv("AWS_DEFAULT_REGION", raising=False)
        monkeypatch.setenv("HOME", str(tmp_path))
        monkeypatch.setenv("AWS_CONFIG_FILE", str(tmp_path / "no-such-config"))
        with patch("boto3.client") as client_fn:
            store = BedrockKnowledgeBaseStore(config=BedrockKnowledgeBaseConfig(knowledge_base_id="kb-1"), name="kb")
            assert store._region is None
            client_fn.assert_called_once_with("bedrock-agent-runtime", region_name=None)

    def test_explicit_region_name_is_threaded_into_runtime_client(self):
        with patch("boto3.client") as client_fn:
            store = BedrockKnowledgeBaseStore(
                config=BedrockKnowledgeBaseConfig(knowledge_base_id="kb-1", region_name="eu-west-1"),
                name="kb",
            )
            assert store._region == "eu-west-1"
            client_fn.assert_called_once_with("bedrock-agent-runtime", region_name="eu-west-1")

    def test_explicit_region_threads_into_default_lazy_clients(self):
        with patch("boto3.client") as client_fn:
            store = BedrockKnowledgeBaseStore(
                config=BedrockKnowledgeBaseConfig(
                    knowledge_base_id="kb-1",
                    data_source_type="CUSTOM",
                    data_source_id="ds-1",
                    region_name="ap-southeast-2",
                ),
                name="kb",
                writable=True,
            )
            # Eager runtime client is built at __init__.
            assert client_fn.call_count == 1
            store._get_agent_client()
            store._get_s3_client()
            calls = {call.args[0]: call.kwargs["region_name"] for call in client_fn.call_args_list}
            assert calls == {
                "bedrock-agent-runtime": "ap-southeast-2",
                "bedrock-agent": "ap-southeast-2",
                "s3": "ap-southeast-2",
            }

    def test_no_config_threads_none_into_default_lazy_clients(self, monkeypatch, tmp_path):
        monkeypatch.delenv("AWS_REGION", raising=False)
        monkeypatch.delenv("AWS_DEFAULT_REGION", raising=False)
        monkeypatch.setenv("HOME", str(tmp_path))
        monkeypatch.setenv("AWS_CONFIG_FILE", str(tmp_path / "no-such-config"))
        with patch("boto3.client") as client_fn:
            store = BedrockKnowledgeBaseStore(
                config=BedrockKnowledgeBaseConfig(
                    knowledge_base_id="kb-1",
                    data_source_type="CUSTOM",
                    data_source_id="ds-1",
                ),
                name="kb",
                writable=True,
            )
            store._get_agent_client()
            store._get_s3_client()
            calls = {call.args[0]: call.kwargs["region_name"] for call in client_fn.call_args_list}
            assert calls == {
                "bedrock-agent-runtime": None,
                "bedrock-agent": None,
                "s3": None,
            }


# --------------------------------------------------------------------------- #
# Extraction config
# --------------------------------------------------------------------------- #


class TestExtractionConfig:
    def test_defaults_extraction_to_none(self, make_store):
        store, _runtime, _agent = make_store()
        assert store.extraction is None

    def test_exposes_a_configured_extraction_config_verbatim(self, make_custom_store):
        extraction = ExtractionConfig(trigger=InvocationTrigger(), extractor=MagicMock())
        store, _agent = make_custom_store({"extraction": extraction})
        assert store.extraction is extraction

    def test_exposes_the_boolean_shorthand_verbatim(self, make_custom_store):
        store, _agent = make_custom_store({"extraction": True})
        assert store.extraction is True


# --------------------------------------------------------------------------- #
# search
# --------------------------------------------------------------------------- #


class TestSearch:
    @pytest.mark.asyncio
    async def test_issues_retrieve_with_query_and_default_limit_of_10(self, make_store):
        store, runtime, _agent = make_store()
        await store.search("how do refunds work")
        kwargs = runtime.retrieve.call_args.kwargs
        assert kwargs["knowledgeBaseId"] == "kb-1"
        assert kwargs["retrievalQuery"] == {"text": "how do refunds work"}
        assert kwargs["retrievalConfiguration"] == {"vectorSearchConfiguration": {"numberOfResults": 10}}

    @pytest.mark.asyncio
    async def test_uses_store_max_search_results_when_caller_omits(self, make_store):
        store, runtime, _agent = make_store({"max_search_results": 5})
        await store.search("q")
        config = runtime.retrieve.call_args.kwargs["retrievalConfiguration"]["vectorSearchConfiguration"]
        assert config["numberOfResults"] == 5

    @pytest.mark.asyncio
    async def test_per_call_max_search_results_overrides_store_default(self, make_store):
        store, runtime, _agent = make_store({"max_search_results": 5})
        await store.search("q", SearchOptions(max_search_results=2))
        config = runtime.retrieve.call_args.kwargs["retrievalConfiguration"]["vectorSearchConfiguration"]
        assert config["numberOfResults"] == 2

    @pytest.mark.asyncio
    async def test_per_call_max_search_results_less_than_one_raises(self, make_store):
        store, _runtime, _agent = make_store()
        with pytest.raises(ValueError, match="max_search_results must be at least 1"):
            await store.search("q", SearchOptions(max_search_results=0))

    @pytest.mark.asyncio
    async def test_derives_a_scope_filter_with_default_key_namespace(self, make_store):
        store, runtime, _agent = make_store({"scope": "user-123"})
        await store.search("q")
        config = runtime.retrieve.call_args.kwargs["retrievalConfiguration"]["vectorSearchConfiguration"]
        assert config == {
            "numberOfResults": 10,
            "filter": {"equals": {"key": "namespace", "value": "user-123"}},
        }

    @pytest.mark.asyncio
    async def test_honors_a_custom_scope_metadata_key(self, make_store):
        store, runtime, _agent = make_store({"scope": "acme"}, {"scope_metadata_key": "tenant"})
        await store.search("q")
        assert _last_search_filter(runtime) == {"equals": {"key": "tenant", "value": "acme"}}

    @pytest.mark.asyncio
    async def test_prefers_an_explicit_filter_over_a_scope_derived_one(self, make_store):
        explicit = {"equals": {"key": "custom", "value": "v"}}
        store, runtime, _agent = make_store({"scope": "ignored", "filter": explicit})
        await store.search("q")
        assert _last_search_filter(runtime) == explicit

    @pytest.mark.asyncio
    async def test_maps_content_metadata_location_and_score_onto_each_entry(self, make_store):
        store, runtime, _agent = make_store()
        runtime.retrieve.return_value = {
            "retrievalResults": [
                {
                    "content": {"text": "refunds take 5 days"},
                    "metadata": {"source": "faq"},
                    "location": {"type": "S3", "s3Location": {"uri": "s3://b/k"}},
                    "score": 0.92,
                }
            ]
        }

        results = await store.search("q")
        assert len(results) == 1
        assert results[0].content == "refunds take 5 days"
        assert results[0].metadata == {
            "source": "faq",
            "_source_location": {"type": "S3", "s3Location": {"uri": "s3://b/k"}},
            "_relevance_score": 0.92,
        }

    @pytest.mark.asyncio
    async def test_defaults_missing_content_to_empty_string_and_omits_absent_metadata(self, make_store):
        store, runtime, _agent = make_store()
        runtime.retrieve.return_value = {"retrievalResults": [{}]}

        results = await store.search("q")
        assert len(results) == 1
        assert results[0].content == ""
        assert results[0].metadata == {}

    @pytest.mark.asyncio
    async def test_returns_empty_list_when_no_results(self, make_store):
        store, _runtime, _agent = make_store()
        assert await store.search("q") == []

    @pytest.mark.asyncio
    async def test_returns_empty_list_when_response_omits_retrieval_results(self, make_store):
        store, runtime, _agent = make_store()
        runtime.retrieve.return_value = {}
        assert await store.search("q") == []

    @pytest.mark.asyncio
    async def test_logs_and_rethrows_when_retrieve_fails(self, make_store, caplog):
        store, runtime, _agent = make_store()
        runtime.retrieve.side_effect = RuntimeError("retrieve boom")

        with caplog.at_level(logging.ERROR):
            with pytest.raises(RuntimeError, match="retrieve boom"):
                await store.search("q")
        assert "knowledge base retrieve failed" in caplog.text

    @pytest.mark.asyncio
    async def test_detects_the_kind_from_get_knowledge_base_using_the_kb_id(self, make_store):
        store, _runtime, agent = make_store()
        await store.search("q")
        assert agent.get_knowledge_base.call_args.kwargs == {"knowledgeBaseId": "kb-1"}

    @pytest.mark.asyncio
    async def test_queries_a_managed_kb_with_managed_search_configuration(self, make_store):
        store, runtime, agent = make_store()
        _managed_kb(agent)
        await store.search("q")
        assert runtime.retrieve.call_args.kwargs["retrievalConfiguration"] == {
            "managedSearchConfiguration": {"numberOfResults": 10}
        }

    @pytest.mark.asyncio
    async def test_carries_the_scope_filter_into_managed_search_configuration(self, make_store):
        store, runtime, agent = make_store({"scope": "user-123"})
        _managed_kb(agent)
        await store.search("q")
        assert runtime.retrieve.call_args.kwargs["retrievalConfiguration"] == {
            "managedSearchConfiguration": {
                "numberOfResults": 10,
                "filter": {"equals": {"key": "namespace", "value": "user-123"}},
            }
        }

    @pytest.mark.asyncio
    async def test_treats_non_managed_types_as_vector(self, make_store):
        store, runtime, agent = make_store()
        agent.get_knowledge_base.return_value = {"knowledgeBase": {"knowledgeBaseConfiguration": {"type": "KENDRA"}}}
        await store.search("q")
        assert "vectorSearchConfiguration" in runtime.retrieve.call_args.kwargs["retrievalConfiguration"]

    @pytest.mark.asyncio
    async def test_detects_the_kind_once_and_reuses_it_across_searches(self, make_store):
        store, _runtime, agent = make_store()
        _managed_kb(agent)
        await store.search("q")
        await store.search("q")
        assert agent.get_knowledge_base.call_count == 1

    @pytest.mark.asyncio
    async def test_raises_when_detection_fails(self, make_store):
        store, _runtime, agent = make_store()
        agent.get_knowledge_base.side_effect = RuntimeError("AccessDenied")
        with pytest.raises(RuntimeError, match="AccessDenied"):
            await store.search("q")

    @pytest.mark.asyncio
    async def test_initialize_is_idempotent(self, make_store):
        store, _runtime, agent = make_store()
        await store.initialize()
        await store.initialize()
        assert agent.get_knowledge_base.call_count == 1


# --------------------------------------------------------------------------- #
# search -- score bounds
# --------------------------------------------------------------------------- #


def _scored(*scores: float | None) -> dict[str, Any]:
    """A retrieve response of one result per score, each carrying its score as its content."""
    results: list[dict[str, Any]] = []
    for score in scores:
        result: dict[str, Any] = {"content": {"text": str(score)}}
        if score is not None:
            result["score"] = score
        results.append(result)
    return {"retrievalResults": results}


def _contents(entries: list[Any]) -> list[str]:
    """The content of each entry, in order."""
    return [entry.content for entry in entries]


class TestScoreBounds:
    @pytest.mark.asyncio
    async def test_keeps_every_result_when_no_bound_is_set(self, make_store):
        store, runtime, _agent = make_store()
        runtime.retrieve.return_value = _scored(0.9, 0.5, 0.1)
        assert _contents(await store.search("q")) == ["0.9", "0.5", "0.1"]

    @pytest.mark.asyncio
    async def test_min_score_keeps_results_at_or_above_the_floor(self, make_store):
        store, runtime, _agent = make_store({"min_score": 0.5})
        runtime.retrieve.return_value = _scored(0.9, 0.5, 0.49, 0.1, 0.0)
        assert _contents(await store.search("q")) == ["0.9", "0.5"]

    @pytest.mark.asyncio
    async def test_max_score_keeps_results_at_or_below_the_ceiling(self, make_store):
        # pgvector's `<=>` returns cosine distance, where 0 is the exact match.
        store, runtime, _agent = make_store({"max_score": 0.4})
        runtime.retrieve.return_value = _scored(0.02, 0.4, 0.41, 0.95)
        assert _contents(await store.search("q")) == ["0.02", "0.4"]

    @pytest.mark.asyncio
    async def test_a_zero_max_score_is_not_treated_as_unset(self, make_store):
        store, runtime, _agent = make_store({"max_score": 0.0})
        runtime.retrieve.return_value = _scored(0.0, 0.1)
        assert _contents(await store.search("q")) == ["0.0"]

    @pytest.mark.asyncio
    async def test_a_zero_min_score_is_not_treated_as_unset(self, make_store):
        # Raw backend scores pass through unchanged, and cosine similarity spans [-1, 1], so a zero
        # floor is a real config: it drops anti-correlated results.
        store, runtime, _agent = make_store({"min_score": 0.0})
        runtime.retrieve.return_value = _scored(0.7, 0.0, -0.3)
        assert _contents(await store.search("q")) == ["0.7", "0.0"]

    @pytest.mark.asyncio
    async def test_keeps_a_later_result_after_dropping_an_earlier_one(self, make_store):
        store, runtime, _agent = make_store({"min_score": 0.5})
        runtime.retrieve.return_value = _scored(0.9, 0.1, 0.8)
        assert _contents(await store.search("q")) == ["0.9", "0.8"]

    @pytest.mark.asyncio
    async def test_keeps_a_result_the_knowledge_base_did_not_score(self, make_store):
        store, runtime, _agent = make_store({"min_score": 0.5})
        runtime.retrieve.return_value = _scored(0.9, None, 0.1)
        results = await store.search("q")
        assert _contents(results) == ["0.9", "None"]
        assert "_relevance_score" not in results[1].metadata

    @pytest.mark.asyncio
    async def test_returns_fewer_entries_than_max_search_results(self, make_store):
        store, runtime, _agent = make_store({"min_score": 0.5, "max_search_results": 3})
        runtime.retrieve.return_value = _scored(0.9, 0.2, 0.1)
        results = await store.search("q")
        assert runtime.retrieve.call_args.kwargs["retrievalConfiguration"]["vectorSearchConfiguration"] == {
            "numberOfResults": 3
        }
        assert _contents(results) == ["0.9"]

    @pytest.mark.asyncio
    async def test_returns_nothing_when_no_result_clears_the_bound(self, make_store):
        store, runtime, _agent = make_store({"min_score": 0.8})
        runtime.retrieve.return_value = _scored(0.3, 0.1)
        assert await store.search("q") == []

    @pytest.mark.asyncio
    async def test_a_kept_result_still_carries_its_score_as_metadata(self, make_store):
        store, runtime, _agent = make_store({"min_score": 0.5})
        runtime.retrieve.return_value = _scored(0.9)
        results = await store.search("q")
        assert results[0].metadata == {"_relevance_score": 0.9}

    @pytest.mark.asyncio
    async def test_logs_how_many_results_the_bound_kept(self, make_store, caplog):
        store, runtime, _agent = make_store({"min_score": 0.5})
        runtime.retrieve.return_value = _scored(0.9, 0.1)
        with caplog.at_level(logging.DEBUG, logger="strands.vended_memory_stores.bedrock_knowledge_base.store"):
            await store.search("q")
        assert "retrieved=<2>, kept=<1> | score bound applied" in caplog.text

    @pytest.mark.asyncio
    async def test_logs_a_full_keep_when_the_knowledge_base_scores_nothing(self, make_store, caplog):
        # A bound over unscored results drops nothing, which reads the same as a bound that was never
        # configured. The count tells the two apart.
        store, runtime, _agent = make_store({"min_score": 0.5})
        runtime.retrieve.return_value = _scored(None, None)
        with caplog.at_level(logging.DEBUG, logger="strands.vended_memory_stores.bedrock_knowledge_base.store"):
            await store.search("q")
        assert "retrieved=<2>, kept=<2> | score bound applied" in caplog.text

    @pytest.mark.asyncio
    async def test_a_zero_min_score_still_logs_the_bound(self, make_store, caplog):
        store, runtime, _agent = make_store({"min_score": 0.0})
        runtime.retrieve.return_value = _scored(0.7)
        with caplog.at_level(logging.DEBUG, logger="strands.vended_memory_stores.bedrock_knowledge_base.store"):
            await store.search("q")
        assert "score bound applied" in caplog.text


# --------------------------------------------------------------------------- #
# add -- CUSTOM data source
# --------------------------------------------------------------------------- #


class TestAddCustom:
    def test_throws_when_data_source_id_missing(self, make_store):
        with pytest.raises(ValueError, match="data_source_id is required"):
            make_store({"writable": True}, {"data_source_type": "CUSTOM"})

    @pytest.mark.asyncio
    async def test_throws_when_content_empty_or_whitespace(self, make_custom_store):
        store, _agent = make_custom_store()
        with pytest.raises(ValueError, match="content must not be empty"):
            await store.add("")
        with pytest.raises(ValueError, match="content must not be empty"):
            await store.add("   ")

    @pytest.mark.asyncio
    async def test_returns_the_generated_custom_document_id(self, make_custom_store):
        store, _agent = make_custom_store()
        result = await store.add("fact")
        assert result.document_id == "test-uuid-v7"

    @pytest.mark.asyncio
    async def test_uses_same_id_for_document_identifier_and_returned_id(self, make_custom_store):
        store, agent = make_custom_store()
        result = await store.add("fact")
        document = agent.ingest_knowledge_base_documents.call_args.kwargs["documents"][0]
        assert document["content"]["custom"]["customDocumentIdentifier"]["id"] == result.document_id

    @pytest.mark.asyncio
    async def test_ingests_inline_document_with_no_metadata_field_when_no_scope_or_metadata(self, make_custom_store):
        store, agent = make_custom_store()
        await store.add("remember this")
        kwargs = agent.ingest_knowledge_base_documents.call_args.kwargs
        assert kwargs["knowledgeBaseId"] == "kb-1"
        assert kwargs["dataSourceId"] == "ds-1"
        assert kwargs["documents"] == [
            {
                "content": {
                    "dataSourceType": "CUSTOM",
                    "custom": {
                        "customDocumentIdentifier": {"id": "test-uuid-v7"},
                        "sourceType": "IN_LINE",
                        "inlineContent": {"type": "TEXT", "textContent": {"data": "remember this"}},
                    },
                },
            }
        ]

    @pytest.mark.asyncio
    async def test_attaches_scope_as_leading_inline_attribute(self, make_custom_store):
        store, agent = make_custom_store({"scope": "user-123"})
        await store.add("fact")
        assert _last_inline_attributes(agent) == [
            {"key": "namespace", "value": {"type": "STRING", "stringValue": "user-123"}},
        ]

    @pytest.mark.asyncio
    async def test_drops_metadata_keys_colliding_with_scope_key_and_preserves_scope(self, make_custom_store, caplog):
        store, agent = make_custom_store({"scope": "tenant-A"})
        with caplog.at_level(logging.WARNING):
            await store.add("fact", {"namespace": "tenant-EVIL", "other": "ok"})
        attrs = _last_inline_attributes(agent)
        namespace_attrs = [a for a in attrs if a["key"] == "namespace"]
        assert len(namespace_attrs) == 1
        assert namespace_attrs[0]["value"]["stringValue"] == "tenant-A"
        assert any(a["key"] == "other" for a in attrs)
        assert "collides with scope_metadata_key" in caplog.text

    @pytest.mark.asyncio
    async def test_maps_supported_metadata_types_and_skips_unsupported(self, make_custom_store):
        store, agent = make_custom_store()
        await store.add(
            "fact",
            {
                "str": "a",
                "num": 1,
                "bool": False,
                "arr": ["x", "y"],
                "obj": {"nested": True},
                "nul": None,
                "mixed_arr": [1, "a"],
            },
        )
        assert _last_inline_attributes(agent) == [
            {"key": "str", "value": {"type": "STRING", "stringValue": "a"}},
            {"key": "num", "value": {"type": "NUMBER", "numberValue": 1}},
            {"key": "bool", "value": {"type": "BOOLEAN", "booleanValue": False}},
            {"key": "arr", "value": {"type": "STRING_LIST", "stringListValue": ["x", "y"]}},
        ]

    @pytest.mark.asyncio
    async def test_logs_and_rethrows_when_ingestion_fails(self, make_custom_store, caplog):
        store, agent = make_custom_store()
        agent.ingest_knowledge_base_documents.side_effect = RuntimeError("ingest boom")

        with caplog.at_level(logging.ERROR):
            with pytest.raises(RuntimeError, match="ingest boom"):
                await store.add("fact")
        assert "knowledge base document ingestion failed" in caplog.text

    @pytest.mark.asyncio
    async def test_lazily_constructs_a_default_agent_client_when_none_injected(self):
        agent = _mock_client()
        agent.ingest_knowledge_base_documents.return_value = {}
        runtime = _mock_client()
        runtime.retrieve.return_value = {"retrievalResults": []}
        with patch("boto3.client") as client_fn:
            client_fn.return_value = agent
            store = BedrockKnowledgeBaseStore(
                config=BedrockKnowledgeBaseConfig(
                    knowledge_base_id="kb-1",
                    data_source_type="CUSTOM",
                    data_source_id="ds-1",
                    runtime_client=runtime,
                ),
                name="kb",
                writable=True,
            )
            await store.add("fact")
            service_names = [call.args[0] for call in client_fn.call_args_list]
            assert "bedrock-agent" in service_names

    @pytest.mark.asyncio
    async def test_attaches_access_control_list_verbatim_in_inline_metadata(self, make_custom_store):
        acl = [{"access": "ALLOW", "name": "alice@example.com", "type": "USER"}]
        store, agent = make_custom_store({"access_control_list": acl})
        # An inline ACL needs at least one attribute, so supply caller metadata.
        await store.add("fact", {"team": "hr"})
        metadata = agent.ingest_knowledge_base_documents.call_args.kwargs["documents"][0]["metadata"]
        assert metadata == {
            "type": "IN_LINE_ATTRIBUTE",
            "inlineAttributes": [{"key": "team", "value": {"type": "STRING", "stringValue": "hr"}}],
            "accessControlList": acl,
        }

    @pytest.mark.asyncio
    async def test_raises_when_acl_set_but_no_inline_attributes(self, make_custom_store):
        # An inline ACL rides on IN_LINE_ATTRIBUTE metadata, which Bedrock requires to carry at least
        # one attribute; an ACL with no scope/metadata has no valid inline shape, so reject it early.
        acl = [{"access": "DENY", "name": "bob@example.com", "type": "USER"}]
        store, agent = make_custom_store({"access_control_list": acl})
        with pytest.raises(ValueError, match="at least one metadata attribute"):
            await store.add("fact")
        agent.ingest_knowledge_base_documents.assert_not_called()

    @pytest.mark.asyncio
    async def test_carries_both_inline_attributes_and_acl(self, make_custom_store):
        acl = [{"access": "ALLOW", "name": "alice@example.com", "type": "USER"}]
        store, agent = make_custom_store({"scope": "user-123", "access_control_list": acl})
        await store.add("fact")
        metadata = agent.ingest_knowledge_base_documents.call_args.kwargs["documents"][0]["metadata"]
        assert metadata == {
            "type": "IN_LINE_ATTRIBUTE",
            "inlineAttributes": [{"key": "namespace", "value": {"type": "STRING", "stringValue": "user-123"}}],
            "accessControlList": acl,
        }

    @pytest.mark.asyncio
    async def test_rewrites_missing_acl_error_to_point_at_the_param(self, make_custom_store):
        store, agent = make_custom_store()
        agent.ingest_knowledge_base_documents.side_effect = _validation_error(
            "accessControlList is required when ACL is enabled on the data source"
        )
        with pytest.raises(ValueError, match="access_control_list"):
            await store.add("fact")

    @pytest.mark.asyncio
    async def test_does_not_rewrite_acl_error_when_acl_is_already_configured(self, make_custom_store):
        acl = [{"access": "ALLOW", "name": "alice@example.com", "type": "USER"}]
        store, agent = make_custom_store({"access_control_list": acl})
        original = _validation_error("accessControlList is invalid")
        agent.ingest_knowledge_base_documents.side_effect = original
        # The store already has an ACL, so the missing-ACL hint would mislead: re-raise as-is. Pass
        # metadata so the inline ACL has the attribute it requires and the write reaches ingestion.
        with pytest.raises(ClientError) as excinfo:
            await store.add("fact", {"team": "hr"})
        assert excinfo.value is original

    @pytest.mark.asyncio
    async def test_does_not_rewrite_unrelated_validation_errors(self, make_custom_store):
        store, agent = make_custom_store()
        original = _validation_error("document content exceeds the maximum size")
        agent.ingest_knowledge_base_documents.side_effect = original
        with pytest.raises(ClientError) as excinfo:
            await store.add("fact")
        assert excinfo.value is original


# --------------------------------------------------------------------------- #
# add -- S3 data source
# --------------------------------------------------------------------------- #


class TestAddS3:
    def test_throws_when_s3_config_missing(self, make_store):
        with pytest.raises(ValueError, match="s3 config is required"):
            make_store({"writable": True}, {"data_source_type": "S3", "data_source_id": "ds-1"})

    @pytest.mark.asyncio
    async def test_returns_the_uploaded_content_objects_uri_as_document_id(self, make_s3_store):
        store, _agent, _s3 = make_s3_store()
        result = await store.add("content")
        assert result.document_id == "s3://my-bucket/memories/test-uuid-v7.txt"

    @pytest.mark.asyncio
    async def test_uploads_content_and_ingests_s3_document_no_sidecar(self, make_s3_store):
        store, agent, s3 = make_s3_store()
        await store.add("s3 content")

        assert s3.put_object.call_count == 1
        assert s3.put_object.call_args.kwargs == {
            "Bucket": "my-bucket",
            "Key": "memories/test-uuid-v7.txt",
            "Body": "s3 content",
            "ContentType": "text/plain; charset=utf-8",
        }
        kwargs = agent.ingest_knowledge_base_documents.call_args.kwargs
        assert kwargs["knowledgeBaseId"] == "kb-1"
        assert kwargs["dataSourceId"] == "ds-1"
        assert kwargs["documents"] == [
            {
                "content": {
                    "dataSourceType": "S3",
                    "s3": {"s3Location": {"uri": "s3://my-bucket/memories/test-uuid-v7.txt"}},
                },
            }
        ]

    @pytest.mark.asyncio
    async def test_does_not_double_slash_when_prefix_ends_with_one(self, make_s3_store):
        client = _mock_client()
        client.put_object.return_value = {}
        store, _agent, _s3 = make_s3_store(
            {}, {"s3": BedrockKnowledgeBaseS3Config(bucket="my-bucket", client=client, prefix="memories/")}
        )
        await store.add("content")
        assert client.put_object.call_args.kwargs["Key"] == "memories/test-uuid-v7.txt"

    @pytest.mark.asyncio
    async def test_writes_a_sidecar_carrying_scope_and_points_metadata_at_it(self, make_s3_store):
        store, agent, s3 = make_s3_store({"scope": "team-a"})
        await store.add("content")

        assert s3.put_object.call_count == 2
        second_call = s3.put_object.call_args_list[1].kwargs
        assert second_call["Bucket"] == "my-bucket"
        assert second_call["Key"] == "memories/test-uuid-v7.txt.metadata.json"
        assert second_call["ContentType"] == "application/json"
        assert second_call["Body"] == json.dumps(
            {
                "metadataAttributes": {
                    "namespace": {"value": {"type": "STRING", "stringValue": "team-a"}, "includeForEmbedding": False},
                }
            },
            separators=(",", ":"),
        )
        document = agent.ingest_knowledge_base_documents.call_args.kwargs["documents"][0]
        assert document["metadata"] == {
            "type": "S3_LOCATION",
            "s3Location": {"uri": "s3://my-bucket/memories/test-uuid-v7.txt.metadata.json"},
        }

    @pytest.mark.asyncio
    async def test_writes_a_sidecar_built_from_caller_metadata(self, make_s3_store):
        store, _agent, s3 = make_s3_store()
        await store.add("content", {"priority": "high"})

        assert s3.put_object.call_count == 2
        assert s3.put_object.call_args_list[1].kwargs["Body"] == json.dumps(
            {
                "metadataAttributes": {
                    "priority": {"value": {"type": "STRING", "stringValue": "high"}, "includeForEmbedding": False},
                }
            },
            separators=(",", ":"),
        )

    @pytest.mark.asyncio
    async def test_omits_unsupported_metadata_values_from_the_sidecar(self, make_s3_store):
        store, _agent, s3 = make_s3_store()
        await store.add("content", {"keep": "yes", "drop": {"nested": True}})

        assert s3.put_object.call_args_list[1].kwargs["Body"] == json.dumps(
            {
                "metadataAttributes": {
                    "keep": {"value": {"type": "STRING", "stringValue": "yes"}, "includeForEmbedding": False},
                }
            },
            separators=(",", ":"),
        )

    @pytest.mark.asyncio
    async def test_lazily_constructs_agent_client_when_neither_client_nor_config_given(self):
        s3 = _mock_client()
        s3.put_object.return_value = {}
        agent = _mock_client()
        agent.ingest_knowledge_base_documents.return_value = {}
        runtime = _mock_client()
        runtime.retrieve.return_value = {"retrievalResults": []}
        with patch("boto3.client") as client_fn:
            client_fn.return_value = agent
            store = BedrockKnowledgeBaseStore(
                config=BedrockKnowledgeBaseConfig(
                    knowledge_base_id="kb-1",
                    data_source_type="S3",
                    data_source_id="ds-1",
                    s3=BedrockKnowledgeBaseS3Config(bucket="my-bucket", client=s3, prefix="memories"),
                    runtime_client=runtime,
                ),
                name="kb",
                writable=True,
            )
            await store.add("content")
            service_names = [call.args[0] for call in client_fn.call_args_list]
            assert "bedrock-agent" in service_names

    @pytest.mark.asyncio
    async def test_logs_and_rethrows_when_s3_upload_fails_before_any_ingestion(self, make_s3_store, caplog):
        store, agent, s3 = make_s3_store()
        s3.put_object.side_effect = RuntimeError("upload boom")

        with caplog.at_level(logging.ERROR):
            with pytest.raises(RuntimeError, match="upload boom"):
                await store.add("content")
        assert "S3 upload failed before ingestion" in caplog.text
        agent.ingest_knowledge_base_documents.assert_not_called()

    @pytest.mark.asyncio
    async def test_writes_acl_into_the_sidecar_with_capitalized_keys(self, make_s3_store):
        acl = [{"access": "ALLOW", "name": "alice@example.com", "type": "USER"}]
        store, _agent, s3 = make_s3_store({"access_control_list": acl})
        await store.add("content")

        # The sidecar is the second put_object; the ACL uses the sidecar's capitalized field names.
        sidecar_body = json.loads(s3.put_object.call_args_list[1].kwargs["Body"])
        assert sidecar_body["accessControlList"] == [{"Name": "alice@example.com", "Type": "USER", "Access": "ALLOW"}]

    @pytest.mark.asyncio
    async def test_writes_a_sidecar_for_acl_only_when_no_scope_or_metadata(self, make_s3_store):
        acl = [{"access": "DENY", "name": "bob@example.com", "type": "USER"}]
        store, agent, s3 = make_s3_store({"access_control_list": acl})
        await store.add("content")

        # An ACL alone forces the sidecar even with no attributes, so two objects are written and the
        # document points its metadata at the sidecar.
        assert s3.put_object.call_count == 2
        sidecar_body = json.loads(s3.put_object.call_args_list[1].kwargs["Body"])
        assert sidecar_body["metadataAttributes"] == {}
        assert sidecar_body["accessControlList"] == [{"Name": "bob@example.com", "Type": "USER", "Access": "DENY"}]
        document = agent.ingest_knowledge_base_documents.call_args.kwargs["documents"][0]
        assert document["metadata"]["type"] == "S3_LOCATION"

    @pytest.mark.asyncio
    async def test_sidecar_carries_both_scope_attributes_and_acl(self, make_s3_store):
        acl = [{"access": "ALLOW", "name": "alice@example.com", "type": "USER"}]
        store, _agent, s3 = make_s3_store({"scope": "team-a", "access_control_list": acl})
        await store.add("content")

        sidecar_body = json.loads(s3.put_object.call_args_list[1].kwargs["Body"])
        assert sidecar_body["metadataAttributes"]["namespace"]["value"]["stringValue"] == "team-a"
        assert sidecar_body["accessControlList"] == [{"Name": "alice@example.com", "Type": "USER", "Access": "ALLOW"}]


# --------------------------------------------------------------------------- #
# add -- non-writable store
# --------------------------------------------------------------------------- #


class TestAddNonWritable:
    @pytest.mark.asyncio
    async def test_throws_when_add_called_on_non_writable_store(self):
        agent = _mock_client()
        runtime = _mock_client()
        runtime.retrieve.return_value = {"retrievalResults": []}
        store = BedrockKnowledgeBaseStore(
            config=BedrockKnowledgeBaseConfig(
                knowledge_base_id="kb-1",
                data_source_type="OTHER",
                data_source_id="ds-1",
                agent_client=agent,
                runtime_client=runtime,
            ),
            name="kb",
        )
        with pytest.raises(ValueError, match="store is not writable"):
            await store.add("fact")
        agent.ingest_knowledge_base_documents.assert_not_called()


# --------------------------------------------------------------------------- #
# config reuse across namespaces
# --------------------------------------------------------------------------- #


class TestConfigReuseAcrossNamespaces:
    @pytest.mark.asyncio
    async def test_reuses_an_injected_runtime_client_across_stores(self):
        runtime = _mock_client()
        runtime.retrieve.return_value = {"retrievalResults": []}
        agent = _mock_client()
        agent.get_knowledge_base.return_value = {"knowledgeBase": {"knowledgeBaseConfiguration": {"type": "VECTOR"}}}
        config = BedrockKnowledgeBaseConfig(knowledge_base_id="kb-1", runtime_client=runtime, agent_client=agent)

        with patch("boto3.client") as client_fn:
            personal = BedrockKnowledgeBaseStore(config=config, name="personal", scope="user-abc")
            team = BedrockKnowledgeBaseStore(config=config, name="team", scope="other")
            client_fn.assert_not_called()

        await personal.search("q")
        assert _last_search_filter(runtime) == {"equals": {"key": "namespace", "value": "user-abc"}}
        await team.search("q")
        assert _last_search_filter(runtime) == {"equals": {"key": "namespace", "value": "other"}}

    def test_constructs_a_separate_default_runtime_client_per_store_when_config_injects_none(self):
        config = BedrockKnowledgeBaseConfig(knowledge_base_id="kb-1")
        with patch("boto3.client") as client_fn:
            BedrockKnowledgeBaseStore(config=config, name="a")
            BedrockKnowledgeBaseStore(config=config, name="b")
            assert client_fn.call_count == 2

    @pytest.mark.asyncio
    async def test_inherits_the_data_source_from_the_shared_config_when_writing(self):
        agent = _mock_client()
        agent.ingest_knowledge_base_documents.return_value = {}
        runtime = _mock_client()
        runtime.retrieve.return_value = {"retrievalResults": []}
        config = BedrockKnowledgeBaseConfig(
            knowledge_base_id="kb-shared",
            data_source_type="CUSTOM",
            data_source_id="ds-shared",
            agent_client=agent,
            runtime_client=runtime,
        )
        store = BedrockKnowledgeBaseStore(config=config, name="personal", scope="user-abc", writable=True)
        await store.add("fact")
        kwargs = agent.ingest_knowledge_base_documents.call_args.kwargs
        assert kwargs["knowledgeBaseId"] == "kb-shared"
        assert kwargs["dataSourceId"] == "ds-shared"

    def test_registers_distinct_name_stores_together_in_a_memory_manager(self):
        config = BedrockKnowledgeBaseConfig(knowledge_base_id="kb-1", runtime_client=_mock_client())
        personal = BedrockKnowledgeBaseStore(config=config, name="personal", scope="user-abc")
        team = BedrockKnowledgeBaseStore(config=config, name="team", scope="other")
        # Should not raise.
        MemoryManager(stores=[personal, team])

    def test_rejects_two_stores_with_the_same_name_in_a_memory_manager(self):
        config = BedrockKnowledgeBaseConfig(knowledge_base_id="kb-1", runtime_client=_mock_client())
        a = BedrockKnowledgeBaseStore(config=config, name="dupe", scope="user-abc")
        b = BedrockKnowledgeBaseStore(config=config, name="dupe", scope="other")
        with pytest.raises(ValueError, match="duplicate store name"):
            MemoryManager(stores=[a, b])


# --------------------------------------------------------------------------- #
# scope and filter resolution
# --------------------------------------------------------------------------- #


class TestScopeAndFilterResolution:
    @pytest.mark.asyncio
    async def test_applies_no_filter_when_the_store_has_no_scope(self, make_store):
        store, runtime, _agent = make_store()
        await store.search("q")
        assert _last_search_filter(runtime) is None

    @pytest.mark.asyncio
    async def test_scopes_writes_by_scope_even_when_explicit_search_filter_set(self, make_custom_store):
        store, agent = make_custom_store({"scope": "tenant-a", "filter": {"equals": {"key": "custom", "value": "v"}}})
        await store.add("fact")
        assert _last_inline_attributes(agent) == [
            {"key": "namespace", "value": {"type": "STRING", "stringValue": "tenant-a"}},
        ]


# --------------------------------------------------------------------------- #
# metadata logging
# --------------------------------------------------------------------------- #


class TestMetadataLogging:
    @pytest.mark.asyncio
    async def test_logs_a_debug_line_when_custom_document_drops_unsupported_value(self, make_custom_store, caplog):
        store, _agent = make_custom_store()
        # The ``strands`` logger is pinned to INFO in conftest; raise it to DEBUG for this logger so
        # the debug line is captured.
        with caplog.at_level(logging.DEBUG, logger="strands"):
            await store.add("fact", {"good": "v", "bad": {"nested": True}})
        debug_messages = [record.getMessage() for record in caplog.records if record.levelno == logging.DEBUG]
        assert any("key=<bad>" in message for message in debug_messages)
        assert not any("key=<good>" in message for message in debug_messages)


# --------------------------------------------------------------------------- #
# extraction via MemoryManager (end-to-end, clients mocked)
# --------------------------------------------------------------------------- #


class _FakeAgent:
    """Minimal agent stand-in for ``init_agent`` wiring (mirrors ``test_memory_manager._FakeAgent``)."""

    def __init__(self, model: Any = None) -> None:
        self.model = model
        self.aux_model = model
        self.hooks: list[tuple[Any, Any, float]] = []
        self._middleware_registry = MagicMock()

    def add_hook(self, callback: Any, event_type: Any = None, *, order: float = HookOrder.DEFAULT) -> None:
        self.hooks.append((callback, event_type, order))


async def _invoke_all(agent: _FakeAgent, event: Any) -> None:
    """Fire every recorded hook registered for ``event``'s type."""
    for callback, event_type, _order in list(agent.hooks):
        if event_type is type(event):
            result = callback(event)
            if inspect.isawaitable(result):
                await result


class TestExtractionViaMemoryManager:
    @pytest.mark.asyncio
    async def test_ingests_extracted_facts_through_add_when_the_trigger_fires(self, make_custom_store):
        extractor = MagicMock()

        async def _extract(messages, context=None):
            return [ExtractionResult(content="user prefers dark mode")]

        extractor.extract.side_effect = _extract

        store, agent_client = make_custom_store(
            {"extraction": ExtractionConfig(trigger=InvocationTrigger(), extractor=extractor)}
        )

        mm = MemoryManager(stores=[store])
        agent = _FakeAgent()
        await mm.init_agent(agent)

        message = {"role": "user", "content": [{"text": "I like dark mode"}]}
        await _invoke_all(agent, MessageAddedEvent(agent=agent, message=message))
        await _invoke_all(agent, AfterInvocationEvent(agent=agent))
        await mm.flush()

        extractor.extract.assert_called_once()
        assert agent_client.ingest_knowledge_base_documents.call_count == 1
        document = agent_client.ingest_knowledge_base_documents.call_args.kwargs["documents"][0]
        assert document["content"]["custom"]["inlineContent"]["textContent"]["data"] == "user prefers dark mode"
