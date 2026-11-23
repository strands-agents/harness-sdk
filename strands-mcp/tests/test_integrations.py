"""Tests for the integrations catalog feed and find_integrations."""

import json
import time
import urllib.error
from unittest.mock import patch

import pytest

from strands_mcp_server.config import doc_config
from strands_mcp_server.server import ToolError, find_integrations
from strands_mcp_server.utils import integrations

FEED = {
    "$schema": "https://strandsagents.com/integrations.schema.json",
    "schemaVersion": 1,
    "integrations": [
        {
            "id": "agentcore-memory",
            "name": "AgentCore Memory",
            "description": "Long-term memory for Strands agents, backed by Amazon Bedrock AgentCore.",
            "integrationType": "memory-store",
            "sdk": "agents",
            "languages": {
                "python": {
                    "package": "bedrock-agentcore",
                    "registryUrl": "https://pypi.org/project/bedrock-agentcore/",
                },
                "typescript": {
                    "package": "@aws/agentcore-memory",
                    "registryUrl": "https://www.npmjs.com/package/@aws/agentcore-memory",
                },
            },
            "github": "https://github.com/aws/bedrock-agentcore-sdk-python",
            "docsUrl": "https://strandsagents.com/docs/integrations/memory/agentcore/",
            "maintainedBy": "aws",
            "addedDate": "2026-01-01",
        },
        {
            "id": "mem-community",
            "name": "strands-mem",
            "description": "Community memory store with AgentCore-compatible schema.",
            "integrationType": "memory-store",
            "sdk": "agents",
            "languages": {
                "python": {"package": "strands-mem[redis]", "registryUrl": "https://pypi.org/project/strands-mem/"}
            },
            "github": "https://github.com/example/strands-mem",
            "maintainedBy": "community",
            "addedDate": "2026-02-01",
        },
        {
            "id": "langfuse",
            "name": "Langfuse",
            "description": "Tracing and evaluation for Strands agents.",
            "integrationType": "observability",
            "sdk": "agents",
            "languages": {"python": {}},
            "github": "https://github.com/langfuse/langfuse",
            "docsUrl": "https://langfuse.com/integrations/frameworks/strands-agents",
            "maintainedBy": "partner",
            "addedDate": "2026-03-01",
        },
    ],
}


@pytest.fixture(autouse=True)
def fresh_cache(monkeypatch):
    monkeypatch.setattr(integrations, "_cached", None)


@pytest.fixture
def feed_get():
    with patch.object(integrations.doc_fetcher, "fetch_text", return_value=json.dumps(FEED)) as mock_get:
        yield mock_get


AGENTCORE_MEMORY = {
    "name": "AgentCore Memory",
    "description": "Long-term memory for Strands agents, backed by Amazon Bedrock AgentCore.",
    "type": "memory-store",
    "sdk": "agents",
    "maintained_by": "aws",
    "languages": ["python", "typescript"],
    "packages": [
        {"language": "python", "package": "bedrock-agentcore", "install": "pip install bedrock-agentcore"},
        {"language": "typescript", "package": "@aws/agentcore-memory", "install": "npm install @aws/agentcore-memory"},
    ],
    "docs_url": "https://strandsagents.com/docs/integrations/memory/agentcore/index.md",
    "github": "https://github.com/aws/bedrock-agentcore-sdk-python",
}
STRANDS_MEM = {
    "name": "strands-mem",
    "description": "Community memory store with AgentCore-compatible schema.",
    "type": "memory-store",
    "sdk": "agents",
    "maintained_by": "community",
    "languages": ["python"],
    "packages": [
        {"language": "python", "package": "strands-mem[redis]", "install": "pip install 'strands-mem[redis]'"}
    ],
    "docs_url": None,
    "github": "https://github.com/example/strands-mem",
}
LANGFUSE = {
    "name": "Langfuse",
    "description": "Tracing and evaluation for Strands agents.",
    "type": "observability",
    "sdk": "agents",
    "maintained_by": "partner",
    "languages": ["python"],
    "packages": [],
    "docs_url": "https://langfuse.com/integrations/frameworks/strands-agents",
    "github": "https://github.com/langfuse/langfuse",
}
FORMAT_ERROR = (
    f"the integrations catalog at {doc_config.integrations_feed_url} is not in the expected format; retry later, "
    "or use search_docs to find integration guides"
)
LOAD_ERROR = (
    f"could not load the integrations catalog from {doc_config.integrations_feed_url} ({{}}); retry later, "
    "or use search_docs to find integration guides"
)


def found(*results):
    return {"total": len(results), "results": list(results)}


class TestFind:
    def test_filters_by_type_and_language(self, feed_get):
        assert integrations.find(integration_type="memory-store", language="typescript") == found(AGENTCORE_MEMORY)

    def test_filters_by_maintainer(self, feed_get):
        assert integrations.find(maintained_by="community") == found(STRANDS_MEM)

    def test_filters_by_sdk(self, feed_get):
        feed = json.loads(json.dumps(FEED))
        feed["integrations"][2]["sdk"] = "evals"
        feed_get.return_value = json.dumps(feed)

        assert integrations.find(sdk="evals") == found({**LANGFUSE, "sdk": "evals"})
        assert integrations.find(sdk="agents") == found(AGENTCORE_MEMORY, STRANDS_MEM)

    def test_query_requires_every_term_and_ranks_name_matches_first(self, feed_get):
        assert integrations.find("strands") == found(STRANDS_MEM, AGENTCORE_MEMORY, LANGFUSE)
        assert integrations.find("memory agentcore") == found(AGENTCORE_MEMORY, STRANDS_MEM)
        assert integrations.find("agentcore postgres") == found()

    def test_limit_caps_results_and_total_counts_every_match(self, feed_get):
        assert integrations.find(limit=2) == {"total": 3, "results": [AGENTCORE_MEMORY, STRANDS_MEM]}

    def test_guide_only_language_matches_language_filter(self, feed_get):
        assert integrations.find("langfuse", language="python") == found(LANGFUSE)

    def test_unknown_feed_values_and_fields_are_passed_through(self, feed_get):
        feed = json.loads(json.dumps(FEED))
        entry = feed["integrations"][2]
        entry.update(integrationType="evaluator", maintainedBy="foundation", newField={"nested": True})
        entry["languages"]["go"] = {"package": "github.com/langfuse/strands-go"}
        feed_get.return_value = json.dumps({**feed, "newTopLevel": []})

        evaluator = {**LANGFUSE, "type": "evaluator", "maintained_by": "foundation", "languages": ["python", "go"]}
        assert integrations.find() == found(AGENTCORE_MEMORY, STRANDS_MEM, evaluator)
        assert integrations.find(integration_type="observability") == found()


class TestFeedCache:
    def test_reuses_feed_within_ttl(self, feed_get):
        integrations.find()
        integrations.find("langfuse")

        feed_get.assert_called_once_with(doc_config.integrations_feed_url)

    def test_refetches_after_ttl(self, feed_get, monkeypatch):
        monkeypatch.setattr(doc_config, "integrations_feed_ttl", 0)
        integrations.find()
        integrations.find()

        assert feed_get.call_count == 2

    def test_failed_refetch_serves_cached_copy_for_another_ttl(self, feed_get, monkeypatch):
        integrations.find()
        expired = integrations._cached[0] + doc_config.integrations_feed_ttl
        monkeypatch.setattr(time, "monotonic", lambda: expired)
        feed_get.side_effect = urllib.error.URLError("down")

        assert find_integrations() == found(AGENTCORE_MEMORY, STRANDS_MEM, LANGFUSE)
        assert find_integrations() == found(AGENTCORE_MEMORY, STRANDS_MEM, LANGFUSE)
        assert feed_get.call_count == 2


class TestFeedErrors:
    @pytest.mark.parametrize(
        ("error", "reason"),
        [
            (
                urllib.error.HTTPError(doc_config.integrations_feed_url, 404, "Not Found", None, None),
                "HTTP Error 404: Not Found",
            ),
            (urllib.error.URLError("connection refused"), "<urlopen error connection refused>"),
            (TimeoutError("timed out"), "timed out"),
        ],
    )
    def test_unreachable_feed_is_a_tool_error(self, feed_get, error, reason):
        feed_get.side_effect = error

        with pytest.raises(ToolError) as exc_info:
            find_integrations()
        assert str(exc_info.value) == LOAD_ERROR.format(reason)

    def test_non_json_feed_is_a_tool_error(self, feed_get):
        feed_get.return_value = "<html>not found</html>"

        with pytest.raises(ToolError) as exc_info:
            find_integrations()
        assert str(exc_info.value) == LOAD_ERROR.format("Expecting value: line 1 column 1 (char 0)")

    @pytest.mark.parametrize(
        "body", [[], None, {"schemaVersion": 1}, {"schemaVersion": 1, "integrations": {}}, {"integrations": []}]
    )
    def test_wrong_shape_feed_is_a_tool_error(self, feed_get, body):
        feed_get.return_value = json.dumps(body)

        with pytest.raises(ToolError) as exc_info:
            find_integrations()
        assert str(exc_info.value) == FORMAT_ERROR

    def test_unsupported_schema_version_asks_for_upgrade(self, feed_get):
        feed_get.return_value = json.dumps({**FEED, "schemaVersion": 2})

        with pytest.raises(ToolError) as exc_info:
            find_integrations()
        assert str(exc_info.value) == (
            f"the integrations catalog at {doc_config.integrations_feed_url} uses schemaVersion 2, "
            "this server supports 1; upgrade strands-agents-mcp-server"
        )

    def test_failed_fetch_is_not_cached(self, feed_get):
        feed_get.side_effect = [urllib.error.URLError("down"), json.dumps(FEED)]

        with pytest.raises(ToolError):
            find_integrations()
        assert find_integrations() == found(AGENTCORE_MEMORY, STRANDS_MEM, LANGFUSE)


def test_tool_passes_filters_through(feed_get):
    assert find_integrations(query="", type="observability", language="python", sdk="agents", limit=1) == found(
        LANGFUSE
    )
