<div align="center">
  <div>
    <a href="https://strandsagents.com">
      <img src="https://strandsagents.com/latest/assets/logo-github.svg" alt="Strands Agents" width="55px" height="105px">
    </a>
  </div>

  <h1>
    Strands Agents MCP Server
  </h1>

  <h2>
    A model-driven approach to building AI agents in just a few lines of code.
  </h2>

  <div align="center">
    <a href="https://github.com/strands-agents/harness-sdk/graphs/commit-activity"><img alt="GitHub commit activity" src="https://img.shields.io/github/commit-activity/m/strands-agents/harness-sdk"/></a>
    <a href="https://github.com/strands-agents/harness-sdk/issues"><img alt="GitHub open issues" src="https://img.shields.io/github/issues/strands-agents/harness-sdk"/></a>
    <a href="https://github.com/strands-agents/harness-sdk/pulls"><img alt="GitHub open pull requests" src="https://img.shields.io/github/issues-pr/strands-agents/harness-sdk"/></a>
    <a href="https://github.com/strands-agents/harness-sdk/blob/main/LICENSE.APACHE"><img alt="License" src="https://img.shields.io/github/license/strands-agents/harness-sdk"/></a>
    <a href="https://pypi.org/project/strands-agents-mcp-server/"><img alt="PyPI version" src="https://img.shields.io/pypi/v/strands-agents-mcp-server"/></a>
    <a href="https://python.org"><img alt="Python versions" src="https://img.shields.io/pypi/pyversions/strands-agents-mcp-server"/></a>
    <a href="https://discord.gg/strands"><img alt="Strands Discord" src="https://img.shields.io/badge/Discord-Strands-5865F2?logo=discord&logoColor=white"/></a>
  </div>

  <p>
    <a href="https://strandsagents.com/">Documentation</a>
    ◆ <a href="https://github.com/strands-agents/samples">Samples</a>
    ◆ <a href="https://github.com/strands-agents/harness-sdk/tree/main/strands-py">Python SDK</a>
    ◆ <a href="https://github.com/strands-agents/tools">Tools</a>
    ◆ <a href="https://github.com/strands-agents/harness-sdk/tree/main/strands-mcp">MCP Server</a>
  </p>
</div>

This MCP server provides curated documentation access to your GenAI tools via llms.txt files, enabling AI coding assistants to find pages by title and retrieve their contents.

## Features

- **Document Search**: Weighted TF-IDF ranking over document titles, extended to page content once a page is hydrated (fetched), so body terms become searchable
- **Section-Based Browsing**: Browse document structure via table of contents, then fetch only the section you need - more token-efficient than retrieving full pages
- **Curated Content**: Indexes documentation from llms.txt files with clean, human-readable titles
- **On-Demand Fetching**: Lazy-loads full document content only when needed for optimal performance
- **Snippet Generation**: Hydrates the top-ranked pages to provide contextual previews
- **Real URL Support**: Works with actual HTTPS URLs while maintaining backward compatibility

### Tool behavior

- `search_docs(query, k)` ranks by document title and by page content once a page has been hydrated. Both title-like keywords and body terms work; call `fetch_doc` to inspect a result's contents.
- Search scores are unbounded weighted TF-IDF values. They are useful only for ordering results from the same query; they are not probabilities and should not be compared across queries.
- `search_docs` returns an empty list when no document matches. If a matched page cannot be fetched for its snippet, the result still includes the URL and title.
- `fetch_doc` returns `{"error": "...", "url": "..."}` for unsupported URLs and failed page fetches. For
  sectioned documents, unknown section IDs also return an error; `section` is ignored when the full document is
  returned automatically.

## Configuration

- `STRANDS_MCP_PREFETCH_ALL`: when set to a truthy value (`1`, `true`, `yes`), the server prefetches and indexes all pages in the background at startup, so body-term search works immediately instead of only after a page has been hydrated by a prior query. Defaults to off. Prefetch is best-effort and eventually consistent: results may be title-only until background hydration completes.

- `STRANDS_MCP_LLMS_TXT`: comma-separated list of `llms.txt` URLs to index. Defaults to `https://strandsagents.com/llms.txt`. A value with no usable URLs falls back to the default.
- `STRANDS_MCP_TIMEOUT`: HTTP request timeout in seconds. Defaults to `30`. A value that is not a positive number is ignored, with a warning, so a typo cannot stop the server from starting.
- `STRANDS_MCP_USER_AGENT`: `User-Agent` header for outbound requests. Defaults to `strands-mcp-docs/1.0`.

Configuration is read from the environment at import time.

> **Note:** `fetch_doc` currently accepts only `https://strandsagents.com` URLs. Documents from other configured sources are indexed and searchable through `search_docs` (including their body text, which is hydrated during search), but cannot be read directly with `fetch_doc` yet.

## Prerequisites

The usage methods below require [uv](https://github.com/astral-sh/uv) to be installed on your system. You can install it by following the [official installation instructions](https://github.com/astral-sh/uv#installation).

## Installation

You can use the Strands Agents MCP server with
[40+ applications that support MCP servers](https://modelcontextprotocol.io/clients),
including Amazon Q Developer CLI, Anthropic Claude Code, Cline, and Cursor.

Get started quickly with one-click installation buttons for popular MCP clients. Click the buttons below to install servers directly in your IDE:

[![Install in Kiro](https://img.shields.io/badge/Install-Kiro-9046FF?style=for-the-badge&logo=kiro)](https://kiro.dev/launch/mcp/add?name=strands-agents&config=%7B%22command%22%3A%22uvx%22%2C%22args%22%3A%5B%22strands-agents-mcp-server%22%5D%2C%22disabled%22%3Afalse%2C%22autoApprove%22%3A%5B%22search_docs%22%2C%22fetch_doc%22%5D%7D)
[![Install in Cursor](https://img.shields.io/badge/Install-Cursor-blue?style=for-the-badge&logo=cursor)](https://cursor.com/en-US/install-mcp?name=strands-agents&config=eyJjb21tYW5kIjoidXZ4IHN0cmFuZHMtYWdlbnRzLW1jcC1zZXJ2ZXIifQ%3D%3D)
[![Install in VS Code](https://img.shields.io/badge/Install-VS_Code-FF9900?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22strands-agents%22%2C%22type%22%3A%22stdio%22%2C%22command%22%3A%22uvx%22%2C%22args%22%3A%5B%22strands-agents-mcp-server%22%5D%7D)

### Kiro example

See the [Kiro documentation](https://kiro.dev/docs/mcp/configuration/)
for instructions on managing MCP configuration.

In `~/.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "strands-agents": {
      "command": "uvx",
      "args": ["strands-agents-mcp-server"],
      "env": {
        "FASTMCP_LOG_LEVEL": "INFO"
      },
      "disabled": false,
      "autoApprove": ["search_docs", "fetch_doc"]
    }
  }
}
```

### Q Developer CLI example

See the [Q Developer CLI documentation](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/command-line-mcp-configuration.html)
for instructions on managing MCP configuration.

In `~/.aws/amazonq/mcp.json`:

```json
{
  "mcpServers": {
    "strands-agents": {
      "command": "uvx",
      "args": ["strands-agents-mcp-server"],
      "env": {
        "FASTMCP_LOG_LEVEL": "INFO"
      },
      "disabled": false,
      "autoApprove": ["search_docs", "fetch_doc"]
    }
  }
}
```

### Claude Code example

See the [Claude Code documentation](https://docs.anthropic.com/en/docs/claude-code/tutorials#configure-mcp-servers)
for instructions on managing MCP servers.

```bash
claude mcp add strands uvx strands-agents-mcp-server
```

### Cline example

See the [Cline documentation](https://docs.cline.bot/mcp-servers/configuring-mcp-servers#editing-mcp-settings-files)
for instructions on managing MCP configuration.

Provide Cline with the following information:

```
I want to add the MCP server for Strands Agents.
Here's the GitHub link: @https://github.com/strands-agents/harness-sdk/tree/main/strands-mcp
Can you add it?"
```

### Cursor example

See the [Cursor documentation](https://docs.cursor.com/context/model-context-protocol#configuring-mcp-servers)
for instructions on managing MCP configuration.

In `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "strands-agents": {
      "command": "uvx",
      "args": ["strands-agents-mcp-server"],
      "env": {
        "FASTMCP_LOG_LEVEL": "INFO"
      },
      "disabled": false,
      "autoApprove": ["search_docs", "fetch_doc"]
    }
  }
}
```

### VS Code example

See the [VS Code documentation](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)
for instructions on managing MCP configuration.

In your `mcp.json` file:

```json
{
  "servers": {
    "strands-agents": {
      "command": "uvx",
      "args": ["strands-agents-mcp-server"]
    }
  }
}
```

## Quick Testing

You can quickly test the MCP server using the MCP Inspector:

```bash
# For published package
npx @modelcontextprotocol/inspector uvx strands-agents-mcp-server

# For local development
npx @modelcontextprotocol/inspector python -m strands_mcp_server
```

Note: This requires [npx](https://docs.npmjs.com/cli/v11/commands/npx) to be installed on your system. It comes bundled with [Node.js](https://nodejs.org/).

The Inspector is also useful for troubleshooting MCP server issues as it provides detailed connection and protocol information. For an in-depth guide, have a look at the [MCP Inspector documentation](https://modelcontextprotocol.io/docs/tools/inspector).

## Getting Started

1. **Install prerequisites**:

   - Install [uv](https://github.com/astral-sh/uv) following the [official installation instructions](https://github.com/astral-sh/uv#installation)
   - Make sure you have [Node.js](https://nodejs.org/) installed for npx commands

2. **Configure your MCP client**:

   - Choose your preferred MCP client from the installation examples above
   - Add the Strands Agents MCP server configuration to your client

3. **Test the connection**:

   ```bash
   # For published package
   npx @modelcontextprotocol/inspector uvx strands-agents-mcp-server

   # For local development
   npx @modelcontextprotocol/inspector python -m strands_mcp_server
   ```

4. **Start using the documentation tools**:
   - `search_docs` - Find relevant documentation with intelligent ranking
   - `fetch_doc` - Browse a page's structure and preamble, then read individual sections
   - The server automatically indexes curated content from llms.txt files

## Server Development

```bash
git clone https://github.com/strands-agents/harness-sdk.git
cd harness-sdk/strands-mcp
python3 -m venv venv
source venv/bin/activate
pip3 install -e ".[dev]"

npx @modelcontextprotocol/inspector python -m strands_mcp_server
```

### Running Tests

```bash
# Unit tests (fast, no network access required)
pytest tests/

# Integration tests (requires network access to strandsagents.com)
pytest tests_integ/ -v

# All tests
pytest tests/ tests_integ/ -v
```

To skip integration tests (e.g., in CI environments without network access):

```bash
SKIP_INTEG_TESTS=1 pytest tests_integ/
```

## Contributing ❤️

We welcome contributions! See our [Contributing Guide](CONTRIBUTING.md) for details on:

- Reporting bugs & features
- Development setup
- Contributing via Pull Requests
- Code of Conduct
- Reporting of security issues

## Stay in touch with the team
Come meet the Strands team and other users on [**Discord**](https://discord.com/invite/strands)

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.
