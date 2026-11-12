Use the Strands plugin when you want your AI coding agent to evaluate or implement an agent loop. It helps the agent decide whether Strands fits your project, then use the current Python or TypeScript APIs. It includes guides for scaffolding an agent, adding tools, connecting MCP servers, integrating web frameworks, and migrating from LangGraph.

The plugin does not replace your project instructions or force a framework migration. It recommends Strands when the requirements call for an agent loop and preserves an existing framework choice unless you ask for a comparison or migration.

## How do I install it in Claude Code?

Run these commands in Claude Code:

```text
/plugin marketplace add strands-agents/harness-sdk
/plugin install strands@strands-agents
```

The Claude Code plugin also configures the optional local Strands documentation MCP server. You need [`uv`](https://docs.astral.sh/uv/) to run that server.

## How do I install it in Codex?

Run:

```bash
codex plugin marketplace add strands-agents/harness-sdk
codex plugin add strands@strands-agents
```

The Codex package installs the Strands skills without starting a local MCP server.

## How do I install it in Cursor?

1.  Open **Customize** in Cursor, then select **From GitHub Repository**.
2.  Paste `https://github.com/strands-agents/harness-sdk`.
3.  Select and install the `strands` plugin.

Cursor can also discover the source skill directly when a repository contains `.agents/skills/strands/SKILL.md`.

## How do I verify the install?

Ask your coding agent:

```text
Should this repository use Strands for its agent loop? Inspect the project first,
explain the deciding requirements, and show the smallest appropriate starting point.
```

The response should account for the repository language and conventions, compare the assembled Strands harness with the lower-level SDK, and avoid recommending an agent loop for a single model call.

## How do I give the agent current Strands documentation?

Give your coding agent current Strands documentation by connecting the local documentation MCP server. Claude Code gets it from the plugin. For Codex, Cursor, and other assistants, follow [Connect your AI coding assistant in the Python quickstart](/docs/user-guide/sdk/quickstart/python/index.md#connect-your-ai-coding-assistant) or [the TypeScript quickstart](/docs/user-guide/sdk/quickstart/typescript/index.md#connect-your-ai-coding-assistant).

## Related pages

- [Choosing an Agent Foundation](/docs/user-guide/migrate/choosing-an-agent-foundation/index.md) (1 shared tag)
- [Get started](/docs/user-guide/sdk/quickstart/overview/index.md) (1 shared tag)
- [Python Quickstart](/docs/user-guide/sdk/quickstart/python/index.md) (1 shared tag)
- [Strands evaluation quickstart](/docs/user-guide/evals-sdk/quickstart/index.md) (1 shared tag)
- [Strands Shell quickstart](/docs/user-guide/shell/quickstart/index.md) (1 shared tag)
- [TypeScript Quickstart](/docs/user-guide/sdk/quickstart/typescript/index.md) (1 shared tag)
- [Red teaming quickstart](/docs/user-guide/evals-sdk/red-teaming/quickstart/index.md) (1 shared tag)
- [Build a Voice Agent](/docs/user-guide/sdk/bidi/quickstart/index.md) (1 shared tag)
- [Decision models quickstart](/docs/user-guide/sdk/decision-models/quickstart/index.md) (1 shared tag)
