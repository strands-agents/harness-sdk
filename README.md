<div align="center">
  <div>
    <a href="https://strandsagents.com">
      <img src="https://strandsagents.com/latest/assets/logo-github.svg" alt="Strands Agents" width="55px" height="105px">
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
    <a href="https://pypi.org/project/strands-agents/"><img alt="PyPI version" src="https://img.shields.io/pypi/v/strands-agents"/></a>
    <a href="https://www.npmjs.com/package/@strands-agents/sdk"><img alt="npm version" src="https://img.shields.io/npm/v/%40strands-agents%2Fsdk"/></a>
    <a href="https://python.org"><img alt="Python versions" src="https://img.shields.io/pypi/pyversions/strands-agents"/></a>
    <a href="https://discord.gg/strands"><img alt="Strands Discord" src="https://img.shields.io/badge/Discord-Strands-5865F2?logo=discord&logoColor=white"/></a>
  </div>
  
  <p>
    <a href="https://strandsagents.com/">Documentation</a>
    ◆ <a href="https://github.com/strands-agents/samples">Samples</a>
    ◆ <a href="https://github.com/strands-agents/tools">Tools</a>
    ◆ <a href="https://github.com/strands-agents/harness-sdk/tree/main/strands-mcp">MCP Server</a>
  </p>
</div>

Strands Agents is an open-source SDK for building and running AI agents in Python and TypeScript. Choose Strands when you would otherwise write your own agent loop: it runs in your process with no hosted control plane, and it covers the jobs a hand-rolled loop grows into. In one SDK you get [lifecycle controls](https://strandsagents.com/docs/user-guide/concepts/agents/agent-loop/) (turn limits, token budgets, cancellation, stop reasons), [tools](https://strandsagents.com/docs/user-guide/concepts/tools/) and [structured output](https://strandsagents.com/docs/user-guide/concepts/agents/structured-output/), [MCP](https://strandsagents.com/docs/user-guide/concepts/tools/mcp-tools/), [multi-agent patterns](https://strandsagents.com/docs/user-guide/concepts/multi-agent/multi-agent-patterns/), [memory](https://strandsagents.com/docs/user-guide/concepts/memory/overview/) and [sessions](https://strandsagents.com/docs/user-guide/concepts/agents/session-management/), [model portability](https://strandsagents.com/docs/user-guide/concepts/model-providers/), [streaming](https://strandsagents.com/docs/user-guide/concepts/streaming/), [guardrails](https://strandsagents.com/docs/user-guide/safety-security/guardrails/), [tracing](https://strandsagents.com/docs/user-guide/observability-evaluation/observability/), and [evals](https://strandsagents.com/docs/user-guide/evals-sdk/quickstart/).

This monorepo contains the Python SDK, TypeScript SDK, documentation site, and supporting packages:

| Directory | Description |
|-----------|-------------|
| `strands-py/` | Python SDK: agent loop, model providers, tools ([PyPI](https://pypi.org/project/strands-agents/) · [releases](https://github.com/strands-agents/harness-sdk/releases?q=python%2F&expanded=false)) |
| `strands-ts/` | TypeScript SDK: agent loop, model providers, tools ([npm](https://www.npmjs.com/package/@strands-agents/sdk) · [releases](https://github.com/strands-agents/harness-sdk/releases?q=typescript%2F&expanded=false)) |
| `site/` | Source for the [strandsagents.com](https://strandsagents.com) documentation site (Astro/Starlight) |
| `team/` | Governance and cross-SDK process docs (tenets, decisions, PR & compatibility guidelines, and `designs/` proposals) |

## Why Strands

Build an agent harness. Control it end-to-end.

- **Build your way.** Any model, any cloud. Context management, execution limits, and observability built in before you write a line of config. Swap backends when you scale; your code stays the same.
- **Model agnostic.** First-class support for Amazon Bedrock, Anthropic, OpenAI, and Gemini, plus [many more providers](https://strandsagents.com/docs/user-guide/concepts/model-providers/) and custom ones.
- **Stay in control.** The agent loop traces every decision by default. Hooks let you intercept any step to log it, validate it, or redirect it.
- **Deliver outcomes that work.** Guardrails catch mistakes before they run. Steering handlers let agents correct themselves instead of failing silently.

MCP, streaming, multi-agent patterns, and structured output are all built in.

## Quick Start

Both SDKs default to the Amazon Bedrock model provider, so you'll need AWS credentials configured and model access enabled for Claude Sonnet. The [Quickstart Guide](https://strandsagents.com/docs/user-guide/quickstart/overview/) covers configuring other providers (Anthropic, OpenAI, Gemini, Ollama, and more).

### Python

Requires Python 3.10+:

```bash
pip install strands-agents strands-agents-tools
```

```python
from strands import Agent
from strands_tools import calculator

agent = Agent(tools=[calculator])
agent("What is the square root of 1764")
```

The [Python SDK README](strands-py/) covers tools, model providers, MCP, and bidirectional streaming.

### TypeScript

Requires Node.js 22+:

```bash
npm install @strands-agents/sdk
```

```typescript
import { Agent } from '@strands-agents/sdk'

const agent = new Agent()
const result = await agent.invoke('What is the square root of 1764?')
console.log(result)
```

More in the [TypeScript SDK README](strands-ts/), including Zod-typed tools, structured output, and multi-agent patterns.

## Documentation

For detailed guidance & examples, explore our documentation:

- [User Guide](https://strandsagents.com/)
- [Quick Start Guide](https://strandsagents.com/docs/user-guide/quickstart/overview/)
- [Agent Loop](https://strandsagents.com/docs/user-guide/concepts/agents/agent-loop/)
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

