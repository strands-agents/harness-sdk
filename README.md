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
    Run a preconfigured agent or build your own.
  </h2>

  <div align="center">
    <a href="https://github.com/strands-agents/harness-sdk/graphs/commit-activity"><img alt="GitHub commit activity" src="https://img.shields.io/github/commit-activity/m/strands-agents/harness-sdk"/></a>
    <a href="https://github.com/strands-agents/harness-sdk/issues"><img alt="GitHub open issues" src="https://img.shields.io/github/issues/strands-agents/harness-sdk"/></a>
    <a href="https://github.com/strands-agents/harness-sdk/pulls"><img alt="GitHub open pull requests" src="https://img.shields.io/github/issues-pr/strands-agents/harness-sdk"/></a>
    <a href="https://github.com/strands-agents/harness-sdk/blob/main/LICENSE.APACHE"><img alt="License" src="https://img.shields.io/github/license/strands-agents/harness-sdk"/></a>
    <a href="https://pypi.org/project/strands-harness/"><img alt="Python harness version" src="https://img.shields.io/pypi/v/strands-harness?label=harness"/></a>
    <a href="https://pypi.org/project/strands-agents/"><img alt="Python SDK version" src="https://img.shields.io/pypi/v/strands-agents?label=Python%20SDK"/></a>
    <a href="https://www.npmjs.com/package/@strands-agents/sdk"><img alt="TypeScript SDK version" src="https://img.shields.io/npm/v/%40strands-agents%2Fsdk?label=TypeScript%20SDK"/></a>
    <a href="https://discord.gg/strands"><img alt="Strands Discord" src="https://img.shields.io/badge/Discord-Strands-5865F2?logo=discord&logoColor=white"/></a>
  </div>
  
  <p>
    <a href="https://strandsagents.com/">Documentation</a>
    ◆ <a href="https://github.com/strands-agents/samples">Samples</a>
    ◆ <a href="https://github.com/strands-agents/tools">Tools</a>
    ◆ <a href="https://github.com/strands-agents/harness-sdk/tree/main/strands-mcp">MCP Server</a>
  </p>
</div>

Build and run AI agents in Python and TypeScript with Strands. Start with **Strands harness** for preconfigured tools, context management, session management, and memory. Choose the **Harness SDK** to configure these building blocks yourself.

## Start here

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://strandsagents.com/latest/assets/harness-sdk-overview-dark.svg">
    <img src="https://strandsagents.com/latest/assets/harness-sdk-overview-light.svg" alt="Run a preconfigured agent with Strands harness, built with the Harness SDK. Build your own agent with SDK models, tools, context, memory, sessions, hooks, plugins, and interventions." width="640">
  </picture>
</p>

| I want a working agent now | I want to build my own agent |
| --- | --- |
| **Strands harness**: start with a preconfigured agent, then customize it. | **Harness SDK**: choose your tools, model provider, and agent configuration. |
| [Run the harness](#quick-start) | [Build with the SDK](#build-with-the-harness-sdk) |

Strands harness is the Harness SDK preconfigured. It returns an SDK `Agent`, so you can change, extend, or replace every default as your requirements change.

## Quick start

Ask the harness to create and read a file in your working directory. Before running an example, [configure AWS credentials and model access](https://strandsagents.com/docs/user-guide/sdk/model-providers/amazon-bedrock/). These examples use Amazon Bedrock by default; the [harness quickstart](https://strandsagents.com/docs/user-guide/harness/quickstart/) covers other model providers.

### Python

Install the harness in a Python 3.10+ environment:

```bash
pip install strands-harness
```

```python
from strands_harness import create_harness

agent = create_harness()
agent("Write Hello from Strands to hello-strands.txt, then read the file back.")
```

Example result: `hello-strands.txt` contains `Hello from Strands`. The harness includes file tools for this task. See the [Python harness README](harness-py/) to configure tools, session management, memory, and model providers.

### TypeScript

Install the harness in a Node.js 22+ project:

```bash
npm install @strands-agents/harness
```

```typescript
import { createHarness } from '@strands-agents/harness'

const agent = await createHarness()
const result = await agent.invoke('Write Hello from Strands to hello-strands.txt, then read the file back.')
console.log(result)
```

Example result: `hello-strands.txt` contains `Hello from Strands`. Run this code in an ES module with top-level `await`. See the [TypeScript setup guide](https://strandsagents.com/docs/user-guide/sdk/quickstart/overview/) for project setup and the [TypeScript harness README](harness-ts/) for configuration.

### Terminal

Chat with the harness from your terminal. Install the CLI with Node.js 22+:

```bash
npm install -g @strands-agents/cli
strands
```

The `strands` command opens interactive setup or chat. See the [CLI README](strands-cli/) for model selection, saved configurations, and non-interactive use.

## Build with the Harness SDK

Build an agent with your own tools and model provider configuration. Use the SDK's [agent loop](https://strandsagents.com/docs/user-guide/sdk/agents/agent-loop/), [tools and MCP](https://strandsagents.com/docs/user-guide/sdk/tools/), [context management](https://strandsagents.com/docs/user-guide/sdk/context-management/), [session management](https://strandsagents.com/docs/user-guide/sdk/agents/session-management/), and [hooks](https://strandsagents.com/docs/user-guide/sdk/agents/hooks/) as building blocks.

These examples use Amazon Bedrock by default and require AWS credentials and model access. The [SDK quickstart](https://strandsagents.com/docs/user-guide/sdk/quickstart/overview/) covers setup and other model providers.

### Python SDK

Install the SDK in a Python 3.10+ environment:

```bash
pip install strands-agents
```

```python
from strands import Agent

agent = Agent()
agent("Explain when to use semantic versioning.")
```

Add your own tools and configuration with the [Python SDK](strands-py/).

### TypeScript SDK

Install the SDK in a Node.js 22+ project:

```bash
npm install @strands-agents/sdk
```

```typescript
import { Agent } from '@strands-agents/sdk'

const agent = new Agent()
const result = await agent.invoke('Explain when to use semantic versioning.')
console.log(result)
```

Run this code in an ES module with top-level `await`. The [SDK quickstart](https://strandsagents.com/docs/user-guide/sdk/quickstart/overview/) covers project setup. See the [TypeScript SDK](strands-ts/) for tools, structured output, and multi-agent examples.

## Repository layout

Find the implementation or guide you want to work on:

| Directory | Contents |
| --- | --- |
| [`harness-py/`](harness-py/) | Python harness, published as [`strands-harness`](https://pypi.org/project/strands-harness/) |
| [`harness-ts/`](harness-ts/) | TypeScript harness, published as [`@strands-agents/harness`](https://www.npmjs.com/package/@strands-agents/harness) |
| [`strands-cli/`](strands-cli/) | Terminal interface, published as [`@strands-agents/cli`](https://www.npmjs.com/package/@strands-agents/cli), command `strands` |
| [`strands-py/`](strands-py/) | Python Harness SDK, published as [`strands-agents`](https://pypi.org/project/strands-agents/) |
| [`strands-ts/`](strands-ts/) | TypeScript Harness SDK, published as [`@strands-agents/sdk`](https://www.npmjs.com/package/@strands-agents/sdk) |
| [`strands-mcp/`](strands-mcp/) | MCP server for the Strands documentation |
| [`site/`](site/) | Source for [strandsagents.com](https://strandsagents.com), built with Astro and Starlight |
| [`test-infra/`](test-infra/) | Infrastructure for SDK integration tests |
| [`team/`](team/) | Project decisions, designs, and contribution process |

## Documentation

Follow the guide for the part of your agent you want to build or customize:

- [Harness guide](https://strandsagents.com/docs/user-guide/harness/)
- [Harness quickstart](https://strandsagents.com/docs/user-guide/harness/quickstart/)
- [SDK quickstart](https://strandsagents.com/docs/user-guide/sdk/quickstart/overview/)
- [Examples](https://strandsagents.com/docs/examples/)
- API Reference: [Python](https://strandsagents.com/docs/api/python/strands.agent.agent/) · [TypeScript](https://strandsagents.com/docs/api/typescript/)
- [Production and deployment](https://strandsagents.com/docs/user-guide/sdk/deploy/operating-agents-in-production/)

## Development

Set up the package you want to change using its contribution guide:

- [Monorepo development and contributions](CONTRIBUTING.md)
- [Python SDK development](strands-py/README.md#development)
- [TypeScript SDK contributions](strands-ts/README.md#contributing-)
- [Website development](site/CONTRIBUTING.md)

## Contributing

Report bugs, suggest features, or submit a pull request. See the [Contributing Guide](CONTRIBUTING.md) and [Code of Conduct](CODE_OF_CONDUCT.md).

## Community

Join other developers and the Strands team on [Discord](https://discord.gg/strands).

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE.APACHE](LICENSE.APACHE) file for details.

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability.
