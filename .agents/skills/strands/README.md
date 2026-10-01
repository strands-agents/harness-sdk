# Strands Agents

Build, extend, and migrate agents with Strands Agents in Python or TypeScript. Strands works with your choice of supported model provider, including Claude through the Anthropic API or Amazon Bedrock.

The `strands` skill helps choose between the assembled Strands harness and the lower-level SDK, then guides an implementation that fits your project. Four focused skills cover scaffolding an agent, adding a tool, connecting an MCP server, and porting from LangGraph. The skills read the files and conventions in your project before suggesting or making changes.

The plugin also starts the local `strands-docs` MCP server with `uvx`, installing the pinned `strands-agents-mcp-server` package from PyPI. Its search index runs locally and it fetches public documentation pages from `https://strandsagents.com` when needed. The server does not require credentials. You need `uv` installed to use this optional documentation server.

Learn more at [Strands Agents](https://strandsagents.com). The plugin is licensed under [Apache-2.0](https://github.com/strands-agents/harness-sdk/blob/main/LICENSE.APACHE).
