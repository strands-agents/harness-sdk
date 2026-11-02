<div align="center">
  <div>
    <a href="https://strandsagents.com">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://strandsagents.com/latest/assets/wordmark-github-dark.svg">
        <img src="https://strandsagents.com/latest/assets/wordmark-github-light.svg" alt="Strands" width="320">
      </picture>
    </a>
  </div>

  <h1>
    Strands Agents
  </h1>

  <h2>
    A model-driven approach to building AI agents in just a few lines of code.
  </h2>

  <div align="center">
    <a href="https://github.com/strands-agents/harness-sdk/graphs/commit-activity"><img alt="GitHub commit activity" src="https://img.shields.io/github/commit-activity/m/strands-agents/harness-sdk"/></a>
    <a href="https://github.com/strands-agents/harness-sdk/issues"><img alt="GitHub open issues" src="https://img.shields.io/github/issues/strands-agents/harness-sdk"/></a>
    <a href="https://github.com/strands-agents/harness-sdk/pulls"><img alt="GitHub open pull requests" src="https://img.shields.io/github/issues-pr/strands-agents/harness-sdk"/></a>
    <a href="https://github.com/strands-agents/harness-sdk/blob/main/LICENSE.APACHE"><img alt="License" src="https://img.shields.io/github/license/strands-agents/harness-sdk"/></a>
  </div>
  
  <p>
    <a href="https://strandsagents.com/">Documentation</a>
    ◆ <a href="https://github.com/strands-agents/samples">Samples</a>
    ◆ <a href="https://github.com/strands-agents/harness-sdk/tree/main/strands-cli">CLI</a>
    ◆ <a href="https://github.com/strands-agents/harness-sdk/tree/main/strands-mcp">MCP Server</a>
    ◆ <a href="https://discord.gg/strands">Discord</a>
    <br>
    Harness (<a href="https://github.com/strands-agents/harness-sdk/tree/main/harness-py">Python</a>, <a href="https://github.com/strands-agents/harness-sdk/tree/main/harness-ts">TypeScript</a>)
    ◆ SDK (<a href="https://github.com/strands-agents/harness-sdk/tree/main/strands-py">Python</a>, <a href="https://github.com/strands-agents/harness-sdk/tree/main/strands-ts">TypeScript</a>)
    ◆ <a href="https://github.com/strands-agents/box">Box</a>
    ◆ <a href="https://github.com/strands-agents/shell">Shell</a>
    ◆ <a href="https://github.com/strands-agents/evals">Evals</a>
    ◆ <a href="https://github.com/strands-labs">Labs</a>
  </p>
</div>

Strands Agents is an open-source SDK for building and running AI agents in Python and TypeScript. Choose Strands when you would otherwise write your own agent loop: it runs in your process with no hosted control plane, and it covers the jobs a hand-rolled loop grows into. In one SDK you get [lifecycle controls](https://strandsagents.com/docs/user-guide/concepts/agents/agent-loop/) (turn limits, token budgets, cancellation, stop reasons), [tools](https://strandsagents.com/docs/user-guide/concepts/tools/) and [structured output](https://strandsagents.com/docs/user-guide/concepts/agents/structured-output/), [MCP](https://strandsagents.com/docs/user-guide/concepts/tools/mcp-tools/), [multi-agent patterns](https://strandsagents.com/docs/user-guide/concepts/multi-agent/multi-agent-patterns/), [memory](https://strandsagents.com/docs/user-guide/concepts/memory/overview/) and [sessions](https://strandsagents.com/docs/user-guide/concepts/agents/session-management/), [model portability](https://strandsagents.com/docs/user-guide/concepts/model-providers/), [streaming](https://strandsagents.com/docs/user-guide/concepts/streaming/), [guardrails](https://strandsagents.com/docs/user-guide/safety-security/guardrails/), [tracing](https://strandsagents.com/docs/user-guide/observability-evaluation/observability/), and [evals](https://strandsagents.com/docs/user-guide/evals-sdk/quickstart/).

Using a coding agent? Install the Strands plugin for Claude Code, Codex, or Cursor.
It adds framework selection, scaffolding, tool authoring, MCP server connections, web
framework guides, and LangGraph migration guidance. See
[Use Strands with AI coding agents](https://strandsagents.com/docs/user-guide/build-with-ai/)
for install and verification steps.

This monorepo contains Strands harness, the Python and TypeScript SDKs, the documentation site, and supporting packages:

| Directory | Description |
|-----------|-------------|
| [`harness-py/`](harness-py/) | Python Strands harness: fully assembled agent via `create_harness()` ([PyPI](https://pypi.org/project/strands-harness/) · [docs](https://strandsagents.com/docs/user-guide/harness/)) |
| [`harness-ts/`](harness-ts/) | TypeScript Strands harness: fully assembled agent via `createHarness()` ([npm](https://www.npmjs.com/package/@strands-agents/harness) · [docs](https://strandsagents.com/docs/user-guide/harness/)) |
| [`strands-cli/`](strands-cli/) | `strands` CLI: prototype and chat with a harness agent from the terminal ([npm](https://www.npmjs.com/package/@strands-agents/cli)) |
| [`strands-py/`](strands-py/) | Python SDK: agent loop, model providers, tools ([PyPI](https://pypi.org/project/strands-agents/) · [releases](https://github.com/strands-agents/harness-sdk/releases?q=python%2F&expanded=false)) |
| [`strands-ts/`](strands-ts/) | TypeScript SDK: agent loop, model providers, tools ([npm](https://www.npmjs.com/package/@strands-agents/sdk) · [releases](https://github.com/strands-agents/harness-sdk/releases?q=typescript%2F&expanded=false)) |
| [`strands-mcp/`](strands-mcp/) | MCP server that gives coding agents knowledge about building with Strands Agents ([PyPI](https://pypi.org/project/strands-agents-mcp-server/)) |
| [`site/`](site/) | Source for the [strandsagents.com](https://strandsagents.com) documentation site (Astro/Starlight) |
| [`team/`](team/) | Governance and cross-SDK process docs (tenets, decisions, PR & compatibility guidelines, and `designs/` proposals) |
| [`test-infra/`](test-infra/) | CDK stack provisioning the AWS resources a subset of integration tests run against (knowledge bases, SSH sandboxes) |

## Why Strands

Build an agent harness. Control it end-to-end.

- **Build your way.** Any model, any cloud. Context management, execution limits, and observability built in before you write a line of config. Swap backends when you scale; your code stays the same.
- **Model agnostic.** First-class support for Amazon Bedrock, Anthropic, OpenAI, and Gemini, plus [many more providers](https://strandsagents.com/docs/user-guide/concepts/model-providers/) and custom ones.
- **Stay in control.** The agent loop traces every decision by default. Hooks let you intercept any step to log it, validate it, or redirect it.
- **Deliver outcomes that work.** Guardrails catch mistakes before they run. Steering handlers let agents correct themselves instead of failing silently.

MCP, streaming, multi-agent patterns, and structured output are all built in.

## Quick Start

The easiest way to get started is with **[Strands harness](https://strandsagents.com/docs/user-guide/harness/)**, a fully assembled, state-of-the-art agent. A single `create_harness()` (Python) or `createHarness()` (TypeScript) call gives you an optimized agent with benchmarked defaults for the model, tools, memory, sessions, and context management — ready to take from idea to production. Follow the [harness quickstart](https://strandsagents.com/docs/user-guide/harness/quickstart/), or see the [Python Strands harness](harness-py/) and [TypeScript Strands harness](harness-ts/) packages to get started.

### Python

```bash
pip install strands-harness
```

```python
from strands_harness import create_harness

agent = create_harness()
agent("Find the slowest test in this repo and explain why it's slow")
```

### TypeScript

```bash
npm install @strands-agents/harness
```

```typescript
import { createHarness } from '@strands-agents/harness'

const agent = await createHarness()
await agent.invoke("Find the slowest test in this repo and explain why it's slow")
```

Start here to get a batteries-included agent, then drop down to the SDKs below when you want to own the agent loop and wire up tools, model providers, and memory yourself. The [harness configuration reference](https://strandsagents.com/docs/user-guide/harness/reference/configuration/) documents every default you can override.

The [Quickstart Guide](https://strandsagents.com/docs/user-guide/quickstart/overview/) covers configuring providers (Amazon Bedrock, Anthropic, OpenAI, Gemini, Ollama, and more).

## Working with the SDK

The Strands Harness SDK lets you go deeper and control every part of the agent: the loop, tools, model providers, memory, sessions, and hooks. You can dive into the SDK after working with Strands harness or if you prefer building your own harness from the ground up when the assembled defaults aren't enough.

### Python

Requires Python 3.10+:

```bash
pip install strands-agents
```

```python
from strands import Agent
from strands.vended_tools import http_request

agent = Agent(tools=[http_request])
agent("Tell me about the Strands harness features: https://strandsagents.com/docs/user-guide/harness/index.md")
```

The [Python SDK README](strands-py/) covers tools, model providers, MCP, and bidirectional streaming.

### TypeScript

To build a Strands agent in TypeScript, install the SDK in a Node.js 22+ ESM project (`"type": "module"`):

```bash
npm install @strands-agents/sdk
```

```typescript
import { Agent } from '@strands-agents/sdk'
import { httpRequest } from '@strands-agents/sdk/vended-tools/http-request'

const agent = new Agent({ tools: [httpRequest] })
await agent.invoke('Tell me about the Strands harness features: https://strandsagents.com/docs/user-guide/harness/index.md')
```

The agent uses Amazon Bedrock by default, so configure AWS credentials or pass another model.
Start with the [TypeScript quickstart](https://strandsagents.com/docs/user-guide/sdk/quickstart/typescript/)
to configure a model provider, run your first agent, and add tools. Use the
[TypeScript API reference](https://strandsagents.com/docs/api/typescript/) for the full
SDK surface, or explore more examples in the [TypeScript SDK README](strands-ts/).

## Documentation

For detailed guidance & examples, explore our documentation:

- [User Guide](https://strandsagents.com/)
- [Strands Harness Guide](https://strandsagents.com/docs/user-guide/harness/) ([quickstart](https://strandsagents.com/docs/user-guide/harness/quickstart/) · [configuration reference](https://strandsagents.com/docs/user-guide/harness/reference/configuration/))
- [Quick Start Guide](https://strandsagents.com/docs/user-guide/quickstart/overview/)
- [Agent Loop](https://strandsagents.com/docs/user-guide/concepts/agents/agent-loop/)
- [Bidirectional Streaming](https://strandsagents.com/docs/user-guide/sdk/bidi/) (Python)
- [Examples](https://strandsagents.com/docs/examples/)
- API Reference: [Python](https://strandsagents.com/docs/api/python/strands.agent.agent/) · [TypeScript](https://strandsagents.com/docs/api/typescript/)
- [Production & Deployment Guide](https://strandsagents.com/docs/user-guide/deploy/operating-agents-in-production/)

The docs themselves live in this monorepo under [`site/`](site/), and doc PRs are welcome alongside code changes.

## Development

Git operations (commits, branches, PRs) are done from the repo root. Each package has its own toolchain:

**Python SDK** (`strands-py/`):
```bash
cd strands-py
pip install hatch
hatch test        # run unit tests
hatch fmt         # format & lint
```

**TypeScript SDK** (`strands-ts/`):
```bash
npm ci            # install from repo root
npm run build     # build
npm test          # run unit tests
```

**Documentation site** (`site/`):
```bash
cd site
npm install
npm run dev       # local dev server at http://localhost:4321/
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

This project is licensed under the Apache License 2.0 - see the [LICENSE.APACHE](LICENSE.APACHE) file for details.

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.
