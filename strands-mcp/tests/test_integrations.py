"""Tests for the integrations catalog feed and find_integrations."""

import json
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
            "description": "Long-term memory backed by Amazon Bedrock AgentCore.",
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
    with patch.object(integrations.doc_fetcher, "_get", return_value=json.dumps(FEED)) as mock_get:
        yield mock_get


def _names(results):
    return [r["name"] for r in results]


class TestFind:
    def test_filters_by_type_and_language(self, feed_get):
        results = integrations.find(integration_type="memory-store", language="typescript")

        assert _names(results) == ["AgentCore Memory"]

    def test_filters_by_maintainer(self, feed_get):
        assert _names(integrations.find(maintained_by="community")) == ["strands-mem"]

    def test_query_requires_every_term_and_ranks_name_matches_first(self, feed_get):
        assert _names(integrations.find("agentcore memory")) == ["AgentCore Memory", "strands-mem"]
        assert integrations.find("agentcore postgres") == []

    def test_limit_caps_results(self, feed_get):
        assert len(integrations.find(limit=2)) == 2

    def test_result_shape(self, feed_get):
        [result] = integrations.find("agentcore", maintained_by="aws")

        assert result == {
            "name": "AgentCore Memory",
            "description": "Long-term memory backed by Amazon Bedrock AgentCore.",
            "type": "memory-store",
            "maintained_by": "aws",
            "languages": ["python", "typescript"],
            "packages": [
                {"language": "python", "package": "bedrock-agentcore", "install": "pip install bedrock-agentcore"},
                {
                    "language": "typescript",
                    "package": "@aws/agentcore-memory",
                    "install": "npm install @aws/agentcore-memory",
                },
            ],
            "docs_url": "https://strandsagents.com/docs/integrations/memory/agentcore/index.md",
            "github": "https://github.com/aws/bedrock-agentcore-sdk-python",
        }

    def test_extras_are_shell_quoted(self, feed_get):
        [result] = integrations.find(maintained_by="community")

        assert result["packages"][0]["install"] == "pip install 'strands-mem[redis]'"

    def test_guide_only_language_has_no_package_and_keeps_external_docs(self, feed_get):
        [result] = integrations.find("langfuse")

        assert result["languages"] == ["python"]
        assert result["packages"] == []
        assert result["docs_url"] == "https://langfuse.com/integrations/frameworks/strands-agents"
        assert integrations.find("langfuse", language="python") == [result]

    def test_missing_docs_url_is_none(self, feed_get):
        [result] = integrations.find(maintained_by="community")

        assert result["docs_url"] is None


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


class TestFeedErrors:
    @pytest.mark.parametrize(
        "error",
        [
            urllib.error.HTTPError(doc_config.integrations_feed_url, 404, "Not Found", None, None),
            urllib.error.URLError("connection refused"),
            TimeoutError("timed out"),
        ],
    )
    def test_unreachable_feed_is_a_tool_error(self, error):
        with patch.object(integrations.doc_fetcher, "_get", side_effect=error):
            with pytest.raises(ToolError, match="could not load the integrations catalog.*search_docs"):
                find_integrations()

    def test_non_json_feed_is_a_tool_error(self):
        with patch.object(integrations.doc_fetcher, "_get", return_value="<html>not found</html>"):
            with pytest.raises(ToolError, match="could not load the integrations catalog"):
                find_integrations()

    def test_unsupported_schema_version_asks_for_upgrade(self):
        with patch.object(integrations.doc_fetcher, "_get", return_value=json.dumps({**FEED, "schemaVersion": 2})):
            with pytest.raises(ToolError, match="schemaVersion 2.*upgrade strands-agents-mcp-server"):
                find_integrations()

    def test_failed_fetch_is_not_cached(self, feed_get):
        feed_get.side_effect = [urllib.error.URLError("down"), json.dumps(FEED)]

        with pytest.raises(ToolError):
            find_integrations()
        assert len(find_integrations()) == 3


def test_tool_passes_filters_through(feed_get):
    assert _names(find_integrations(query="", type="observability", language="python")) == ["Langfuse"]
