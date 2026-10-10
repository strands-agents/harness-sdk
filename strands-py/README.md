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
    Strands Agents - Python SDK
  </h1>

  <h2>
    A model-driven approach to building AI agents in just a few lines of code.
  </h2>

  <div align="center">
    <a href="https://github.com/strands-agents/harness-sdk/graphs/commit-activity"><img alt="GitHub commit activity" src="https://img.shields.io/github/commit-activity/m/strands-agents/harness-sdk"/></a>
    <a href="https://github.com/strands-agents/harness-sdk/issues"><img alt="GitHub open issues" src="https://img.shields.io/github/issues/strands-agents/harness-sdk"/></a>
    <a href="https://github.com/strands-agents/harness-sdk/pulls"><img alt="GitHub open pull requests" src="https://img.shields.io/github/issues-pr/strands-agents/harness-sdk"/></a>
    <a href="https://github.com/strands-agents/harness-sdk/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/strands-agents/harness-sdk"/></a>
    <a href="https://pypi.org/project/strands-agents/"><img alt="PyPI version" src="https://img.shields.io/pypi/v/strands-agents"/></a>
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

Strands Agents is a simple yet powerful SDK that takes a model-driven approach to building and running AI agents. From simple conversational assistants to complex autonomous workflows, from local development to production deployment, Strands Agents scales with your needs.

## Feature Overview

- **Lightweight & Flexible**: Simple agent loop that just works and is fully customizable
- **Model Agnostic**: Support for Amazon Bedrock, Anthropic, Gemini, LiteLLM, Llama, Ollama, OpenAI, Writer, and custom providers
- **Advanced Capabilities**: Multi-agent systems, autonomous agents, and streaming support
- **Built-in MCP**: Native support for Model Context Protocol (MCP) servers, enabling access to thousands of pre-built tools

## Quick Start

```bash
# Install Strands Agents
pip install strands-agents strands-agents-tools
```

```python
from strands import Agent
from strands_tools import calculator
agent = Agent(tools=[calculator])
agent("What is the square root of 1764")
```

> **Note**: For the default Amazon Bedrock model provider, you'll need AWS credentials configured and model access enabled for Claude 4 Sonnet in the us-west-2 region. See the [Quickstart Guide](https://strandsagents.com/) for details on configuring other model providers.

## Installation

Ensure you have Python 3.10+ installed, then:

```bash
# Create and activate virtual environment
python -m venv .venv
source .venv/bin/activate  # On Windows use: .venv\Scripts\activate

# Install Strands and tools
pip install strands-agents strands-agents-tools
```

## Features at a Glance

### Python-Based Tools

Easily build tools using Python decorators:

```python
from strands import Agent, tool

@tool
def word_count(text: str) -> int:
    """Count words in text.

    This docstring is used by the LLM to understand the tool's purpose.
    """
    return len(text.split())

agent = Agent(tools=[word_count])
response = agent("How many words are in this sentence?")
```

**Hot Reloading from Directory:**
Enable automatic tool loading and reloading from the `./tools/` directory:

```python
from strands import Agent

# Agent will watch ./tools/ directory for changes
agent = Agent(load_tools_from_directory=True)
response = agent("Use any tools you find in the tools directory")
```

### MCP Support

Connect to Model Context Protocol (MCP) servers:

```python
from strands import Agent
from strands.tools.mcp import MCPClient
from mcp import stdio_client, StdioServerParameters

aws_docs_client = MCPClient(
    lambda: stdio_client(StdioServerParameters(command="uvx", args=["awslabs.aws-documentation-mcp-server@latest"]))
)

with aws_docs_client:
   agent = Agent(tools=aws_docs_client.list_tools_sync())
   response = agent("Tell me about Amazon Bedrock and how to use it with Python")
```

The SDK works with both major versions of the `mcp` package through a built-in compatibility layer, so most code that uses `MCPClient` runs unchanged on either version. A fresh install resolves to mcp 2.x, and pinning `mcp<2` keeps you on 1.x. See [docs/MCP_VERSIONS.md](./docs/MCP_VERSIONS.md) for support status, the behavior differences on 2.x, and migration notes.

### Multiple Model Providers

Support for various model providers:

```python
from strands import Agent
from strands.models import BedrockModel
from strands.models.ollama import OllamaModel
from strands.models.llamaapi import LlamaAPIModel
from strands.models.gemini import GeminiModel
from strands.models.llamacpp import LlamaCppModel

# Bedrock
bedrock_model = BedrockModel(
  model_id="us.amazon.nova-pro-v1:0",
  temperature=0.3,
  streaming=True, # Enable/disable streaming
)
agent = Agent(model=bedrock_model)
agent("Tell me about Agentic AI")

# Google Gemini
gemini_model = GeminiModel(
  client_args={
    "api_key": "your_gemini_api_key",
  },
  model_id="gemini-2.5-flash",
  params={"temperature": 0.7}
)
agent = Agent(model=gemini_model)
agent("Tell me about Agentic AI")

# Ollama
ollama_model = OllamaModel(
  host="http://localhost:11434",
  model_id="llama3"
)
agent = Agent(model=ollama_model)
agent("Tell me about Agentic AI")

# Llama API
llama_model = LlamaAPIModel(
    model_id="Llama-4-Maverick-17B-128E-Instruct-FP8",
)
agent = Agent(model=llama_model)
response = agent("Tell me about Agentic AI")
```

Built-in providers:
 - [Amazon Bedrock](https://strandsagents.com/docs/user-guide/concepts/model-providers/amazon-bedrock/)
 - [Anthropic](https://strandsagents.com/docs/user-guide/concepts/model-providers/anthropic/)
 - [Gemini](https://strandsagents.com/docs/user-guide/concepts/model-providers/gemini/)
 - [Cohere](https://strandsagents.com/docs/user-guide/concepts/model-providers/cohere/)
 - [LiteLLM](https://strandsagents.com/docs/user-guide/concepts/model-providers/litellm/)
 - [llama.cpp](https://strandsagents.com/docs/user-guide/concepts/model-providers/llamacpp/)
 - [LlamaAPI](https://strandsagents.com/docs/user-guide/concepts/model-providers/llamaapi/)
 - [MistralAI](https://strandsagents.com/docs/user-guide/concepts/model-providers/mistral/)
 - [Ollama](https://strandsagents.com/docs/user-guide/concepts/model-providers/ollama/)
 - [OpenAI](https://strandsagents.com/docs/user-guide/concepts/model-providers/openai/)
 - [OpenAI Responses API](https://strandsagents.com/docs/user-guide/concepts/model-providers/openai/)
 - [SageMaker](https://strandsagents.com/docs/user-guide/concepts/model-providers/sagemaker/)
 - [Writer](https://strandsagents.com/docs/user-guide/concepts/model-providers/writer/)

Custom providers can be implemented using [Custom Providers](https://strandsagents.com/docs/user-guide/concepts/model-providers/custom_model_provider/)

### Example tools

Strands offers an optional strands-agents-tools package with pre-built tools for quick experimentation:

```python
from strands import Agent
from strands_tools import calculator
agent = Agent(tools=[calculator])
agent("What is the square root of 1764")
```

It's also available on GitHub via [strands-agents/tools](https://github.com/strands-agents/tools).

### Bidirectional Streaming

Build voice agents that talk with users in real time. A `BidiAgent` holds a persistent connection to a speech model, streams audio both ways, runs tools mid-conversation, and stops speaking when the user interrupts.

Install the extra for your provider. Local audio also needs the PortAudio system library:

```bash
# Amazon Bedrock Nova Sonic (Python 3.12+)
pip install "strands-agents[bidi,bidi-io,bidi-pyaudio]"

# Google Gemini Live
pip install "strands-agents[bidi-google,bidi-io,bidi-pyaudio]"

# OpenAI Realtime API
pip install "strands-agents[bidi-openai,bidi-io,bidi-pyaudio]"
```

This agent listens on your microphone, answers through your speakers, and prints transcripts to the terminal:

```python
import asyncio

from strands.bidi.agent import BidiAgent
from strands.bidi.io import AudioIO
from strands.bidi.models import BedrockNovaSonicModel


async def main():
    model = BedrockNovaSonicModel(model_id="amazon.nova-2-5-sonic")
    agent = BidiAgent(model=model)
    audio_io = AudioIO()

    await agent.run(inputs=[audio_io.input()], outputs=[audio_io.output()])


if __name__ == "__main__":
    asyncio.run(main())
```

`run()` keeps the conversation open until you press Ctrl+C or a tool calls `agent.cancel()`. See the [bidirectional streaming quickstart](https://strandsagents.com/docs/user-guide/sdk/bidi/quickstart/) for model configuration, custom I/O, and more.

## Documentation

For detailed guidance & examples, explore our documentation:

- [User Guide](https://strandsagents.com/)
- [Quick Start Guide](https://strandsagents.com/docs/user-guide/quickstart/)
- [Agent Loop](https://strandsagents.com/docs/user-guide/concepts/agents/agent-loop/)
- [Examples](https://strandsagents.com/docs/examples/)
- [API Reference](https://strandsagents.com/docs/api/python/strands.agent.agent/)
- [Production & Deployment Guide](https://strandsagents.com/docs/user-guide/deploy/operating-agents-in-production/)

## Development

```bash
pip install hatch
hatch test        # run unit tests
hatch fmt         # format & lint
```

## Contributing ❤️

We welcome contributions! See our [Contributing Guide](https://github.com/strands-agents/harness-sdk/blob/main/CONTRIBUTING.md) for details on:
- Reporting bugs & features
- Development setup
- Contributing via Pull Requests
- Code of Conduct
- Reporting of security issues

## Stay in touch with the team
Come meet the Strands team and other users on [**Discord**](https://discord.com/invite/strands)

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](https://github.com/strands-agents/harness-sdk/blob/main/LICENSE.APACHE) file for details.

## Security

See [CONTRIBUTING](https://github.com/strands-agents/harness-sdk/blob/main/CONTRIBUTING.md#security-issue-notifications) for more information.
