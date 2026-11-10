"""Tests for llms.txt parsing."""

from unittest.mock import patch

from strands_mcp_server.utils import doc_fetcher

LLMS_TXT = """# Strands Agents

> Build agents. See [the docs](https://strandsagents.com/docs/index.md).

## Integrations

- Tools
  - [Exa](https://strandsagents.com/exa.md): Web search, used with [MCP](https://strandsagents.com/mcp.md) servers.
  - [Tavily](https://strandsagents.com/tavily.md)
- [Overview](https://strandsagents.com/docs/integrations/index.md): Every integration: tools, models, and stores.
"""


def test_parse_llms_txt_returns_title_url_and_description():
    with patch("strands_mcp_server.utils.doc_fetcher._get", return_value=LLMS_TXT):
        links = doc_fetcher.parse_llms_txt("https://strandsagents.com/llms.txt")

    assert links == [
        ("the docs", "https://strandsagents.com/docs/index.md", ""),
        ("Exa", "https://strandsagents.com/exa.md", "Web search, used with"),
        ("MCP", "https://strandsagents.com/mcp.md", ""),
        ("Tavily", "https://strandsagents.com/tavily.md", ""),
        (
            "Overview",
            "https://strandsagents.com/docs/integrations/index.md",
            "Every integration: tools, models, and stores.",
        ),
    ]
