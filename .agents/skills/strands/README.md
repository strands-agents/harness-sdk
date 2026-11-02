# Strands Agents plugin

Build, extend, and migrate agents with Strands Agents in Python or TypeScript. Strands works with your choice of supported model provider, including Claude through the Anthropic API or Amazon Bedrock.

The plugin helps choose between the assembled Strands harness and the lower-level SDK,
then guides an implementation that fits your project. It includes focused skills for
scaffolding an agent, adding a tool, connecting an MCP server, porting from LangGraph,
and integrating FastAPI, Express, or Next.js.

## Install in Claude Code

Run these commands in Claude Code:

```text
/plugin marketplace add strands-agents/harness-sdk
/plugin install strands@strands-agents
```

The Claude Code package also starts the local `strands-docs` MCP server with `uvx`.
It installs the pinned `strands-agents-mcp-server` package from PyPI. You need `uv`
for this optional documentation server.

## Install in Codex

```bash
codex plugin marketplace add strands-agents/harness-sdk
codex plugin add strands@strands-agents
```

## Install in Cursor

Open **Customize** in Cursor, select **From GitHub Repository**, and paste:

```text
https://github.com/strands-agents/harness-sdk
```

Select and install the `strands` plugin.

See the
[AI coding agent guide](https://strandsagents.com/docs/user-guide/build-with-ai/)
for verification and optional documentation MCP setup. The plugin is licensed under
[Apache-2.0](https://github.com/strands-agents/harness-sdk/blob/main/LICENSE.APACHE).
