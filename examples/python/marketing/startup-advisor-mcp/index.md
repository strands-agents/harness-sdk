Have a new startup in mind, but haven’t quite hired your marketing staff? Use this Startup Advisor agent to do your market research, come up with campaign ideas, and write effective campaign copy.

![architecture](https://raw.githubusercontent.com/strands-agents/samples/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/04-industry-use-cases/marketing/startup-advisor-mcp/architecture.png)

| Feature | Description |
| --- | --- |
| Agent Structure | Multi-agent architecture |
| Native Tools | swarm, file\_write, editor |
| Custom Agents | market\_research\_team, writer\_team |
| MCP Servers | [Perplexity search](https://github.com/jsonallen/perplexity-mcp) |
| Model Provider | Amazon Bedrock |

## Key Features

-   Shows sequential multi-agent architecture using Strands Agent
-   Agentic search using the Perplexity MCP server.
-   Utilizes the `swarm` tool, allowing a swarm of agents to collaborate on market research. Checkout multi-agent systems and [Swarm](https://strandsagents.com/latest/user-guide/concepts/multi-agent/swarm/) intelligence with Strands for more information.

## Prerequisites

1.  Install [uv](https://docs.astral.sh/uv/getting-started/installation/).
2.  Follow guidance [here](https://docs.perplexity.ai/guides/getting-started) to get started with perplexity AI.
3.  Create .env file with [.env.example](https://github.com/strands-agents/samples/blob/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/04-industry-use-cases/marketing/startup-advisor-mcp/.env.example).
4.  Run `uv run main.py`

## Upstream source

- [View this sample at the imported commit](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/04-industry-use-cases/marketing/startup-advisor-mcp)
