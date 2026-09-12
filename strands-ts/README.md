<div align="center">
  <div>
    <a href="https://strandsagents.com">
      <img src="https://strandsagents.com/latest/assets/logo-github.svg" alt="Strands Agents" width="55px" height="105px">
    </a>
  </div>

  <h1>
    Strands Agents - TypeScript SDK
  </h1>

  <h2>
    A model-driven approach to building AI agents in TypeScript/JavaScript.
  </h2>

  <div align="center">
    <a href="https://github.com/strands-agents/harness-sdk/graphs/commit-activity"><img alt="GitHub commit activity" src="https://img.shields.io/github/commit-activity/m/strands-agents/harness-sdk"/></a>
    <a href="https://github.com/strands-agents/harness-sdk/issues"><img alt="GitHub open issues" src="https://img.shields.io/github/issues/strands-agents/harness-sdk"/></a>
    <a href="https://github.com/strands-agents/harness-sdk/pulls"><img alt="GitHub open pull requests" src="https://img.shields.io/github/issues-pr/strands-agents/harness-sdk"/></a>
    <a href="https://github.com/strands-agents/harness-sdk/blob/main/LICENSE.APACHE"><img alt="License" src="https://img.shields.io/github/license/strands-agents/harness-sdk"/></a>
    <a href="https://www.npmjs.com/package/@strands-agents/sdk"><img alt="NPM Version" src="https://img.shields.io/npm/v/@strands-agents/sdk"/></a>
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

---

## Overview

Strands Agents is a simple yet powerful SDK that takes a model-driven approach to building and running AI agents. The TypeScript SDK brings key features from the Python Strands framework to Node.js environments, enabling type-safe agent development for everything from simple assistants to complex workflows.

### Key Features

- **🪶 Lightweight & Flexible**: Simple agent loop that works seamlessly in Node.js and browser environments
- **🔒 Type-Safe Tools**: Define tools easily using Zod schemas for robust input validation and type inference
- **📋 Structured Output**: Get type-safe, validated responses from LLMs using Zod schemas with automatic retry on validation errors
- **🔌 Model Agnostic**: First-class support for Amazon Bedrock and OpenAI, with extensible architecture for custom providers
- **🔗 Built-in MCP**: Native support for Model Context Protocol (MCP) clients, enabling access to external tools and servers
- **⚡ Streaming Support**: Real-time response streaming for better user experience
- **🎣 Extensible Hooks**: Lifecycle hooks for monitoring and customizing agent behavior
- **💬 Conversation Management**: Flexible strategies for managing conversation history and context windows
- **🤝 Multi-Agent Orchestration**: Graph and Swarm patterns for coordinating multiple agents

---

## Quick Start

### Installation

Ensure you have **[Node.js 22+](https://nodejs.org/)** installed, then:

```bash
npm install @strands-agents/sdk
```

### Basic Usage

```typescript
import { Agent } from '@strands-agents/sdk'

// Create agent (uses default Amazon Bedrock provider)
const agent = new Agent()

// Invoke
const result = await agent.invoke('What is the square root of 1764?')
console.log(result)
```

> **Note**: For the default Amazon Bedrock model provider, you'll need AWS credentials configured and model access enabled for Claude Sonnet 4.6 in your region.

---

## Core Concepts

### Agents

The `Agent` class is the central orchestrator that manages the interaction loop between users, models, and tools.

```typescript
import { Agent } from '@strands-agents/sdk'

const agent = new Agent({
  systemPrompt: 'You are a helpful assistant.',
})
```
### Model Providers

Switch between model providers easily:

**Amazon Bedrock (Default)**

```typescript
import { Agent, BedrockModel } from '@strands-agents/sdk'

const model = new BedrockModel({
  region: 'us-east-1',
  modelId: 'global.anthropic.claude-sonnet-4-6',
  maxTokens: 4096,
  temperature: 0.7
})

const agent = new Agent({ model })
```

**OpenAI**

```typescript
import { Agent } from '@strands-agents/sdk'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'

// Automatically uses process.env.OPENAI_API_KEY and defaults to gpt-5.4
const model = new OpenAIModel({ api: 'chat' })

const agent = new Agent({ model })
```

### Streaming Responses

Access responses as they are generated:

```typescript
const agent = new Agent()

console.log('Agent response stream:')
for await (const event of agent.stream('Tell me a story about a brave toaster.')) {
  console.log('[Event]', event.type)
}
```

### Tools

Tools enable agents to interact with external systems and perform actions. Create type-safe tools using Zod schemas:

```typescript
import { Agent, tool } from '@strands-agents/sdk'
import { z } from 'zod'

const weatherTool = tool({
  name: 'get_weather',
  description: 'Get the current weather for a specific location.',
  inputSchema: z.object({
    location: z.string().describe('The city and state, e.g., San Francisco, CA'),
  }),
  callback: (input) => {
    // input is fully typed based on the Zod schema
    return `The weather in ${input.location} is 72°F and sunny.`
  },
})

const agent = new Agent({
  tools: [weatherTool],
})

await agent.invoke('What is the weather in San Francisco?')
```

**Vended Tools**: The SDK includes optional pre-built tools:
- **Notebook Tool**: Manage text-based notebooks for persistent note-taking
- **File Editor Tool**: Perform file system operations (read, write, edit files)
- **HTTP Request Tool**: Make HTTP requests to external APIs


### Structured Output

Get type-safe, validated responses from LLMs by defining the expected output structure with Zod schemas. The agent automatically validates the LLM's response and retries on validation errors:

```typescript
import { Agent } from '@strands-agents/sdk'
import { z } from 'zod'

const PersonSchema = z.object({
  name: z.string().describe('Name of the person'),
  age: z.number().describe('Age of the person'),
  occupation: z.string().describe('Occupation of the person')
})

// Configure structured output at the agent level
const agent = new Agent({ 
  structuredOutputSchema: PersonSchema 
})

const result = await agent.invoke('John Smith is a 30 year-old software engineer')

// result.structuredOutput is fully typed based on the schema
console.log(result.structuredOutput.name) // "John Smith"
console.log(result.structuredOutput.age)  // 30
```

**Error handling**: The agent automatically retries with validation feedback when the LLM provides invalid output. If validation ultimately fails, a `StructuredOutputError` is thrown:

```typescript
import { StructuredOutputError } from '@strands-agents/sdk'

try {
  const result = await agent.invoke('Extract person info...')
  console.log(result.structuredOutput)
} catch (error) {
  if (error instanceof StructuredOutputError) {
    console.error('Validation failed:', error.message)
  }
}
```


### MCP Integration

Seamlessly integrate Model Context Protocol (MCP) servers:

```typescript
import { Agent, McpClient } from "@strands-agents/sdk";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Create a client for a local MCP server
const documentationTools = new McpClient({
  transport: new StdioClientTransport({
    command: "uvx",
    args: ["awslabs.aws-documentation-mcp-server@latest"],
  }),
});

const agent = new Agent({
  systemPrompt: "You are a helpful assistant using MCP tools.",
  tools: [documentationTools], // Pass the MCP client directly as a tool source
});

await agent.invoke("Use a random tool from the MCP server.");

await documentationTools.disconnect();
```

### Multi-Agent Orchestration

Coordinate multiple agents using built-in orchestration patterns.

**Graph** — You define a deterministic execution plan. Agents run as nodes in a directed graph, with edges controlling execution order. Parallel execution is supported, and downstream nodes run once all dependencies complete.

```typescript
import { Agent, BedrockModel, Graph } from '@strands-agents/sdk'

const model = new BedrockModel({ maxTokens: 1024 })

const researcher = new Agent({
  model,
  id: 'researcher',
  systemPrompt: 'Research the topic and provide key facts.',
})

const writer = new Agent({
  model,
  id: 'writer',
  systemPrompt: 'Rewrite the research into a polished paragraph.',
})

const graph = new Graph({
  nodes: [researcher, writer],
  edges: [['researcher', 'writer']],
})

const result = await graph.invoke('What is the largest ocean?')
```

**Swarm** — The agents decide the routing. Each agent chooses whether to hand off to another agent or produce a final response, making the execution path dynamic and model-driven.

```typescript
import { Agent, BedrockModel, Swarm } from '@strands-agents/sdk'

const model = new BedrockModel({ maxTokens: 1024 })

const researcher = new Agent({
  model,
  id: 'researcher',
  description: 'Researches a topic and gathers key facts.',
  systemPrompt: 'Research the answer, then hand off to the writer.',
})

const writer = new Agent({
  model,
  id: 'writer',
  description: 'Writes a polished final answer.',
  systemPrompt: 'Write the final answer. Do not hand off.',
})

const swarm = new Swarm({
  nodes: [researcher, writer],
  start: 'researcher',
  maxSteps: 4,
})

const result = await swarm.invoke('What is the largest ocean?')
```

Both patterns support streaming via `.stream()` for real-time access to handoff and node execution events. See the [examples](./examples/) directory for complete working samples.

---

## Documentation

For detailed guidance, tutorials, and concept overviews, please visit:

- **[Official Documentation](https://strandsagents.com/)**: Comprehensive guides and tutorials
- **[API Reference](https://strandsagents.com/docs/api/typescript/)**: Complete API documentation
- **[Examples](./examples/)**: Sample applications
  - **[First Agent](./examples/first-agent/)**: Basic Node.js agent
  - **[MCP](./examples/mcp/)**: MCP integration example
  - **[Browser Agent](./examples/browser-agent/)**: Browser-based agent with DOM manipulation

- **[Contributing Guide](https://github.com/strands-agents/harness-sdk/blob/main/CONTRIBUTING.md)**: Development setup and guidelines

---

## Contributing ❤️

We welcome contributions! See our [Contributing Guide](https://github.com/strands-agents/harness-sdk/blob/main/CONTRIBUTING.md) for details on:

- Development setup and environment
- Testing and code quality standards
- Pull request process
- Code of Conduct
- Security issue reporting

---

## Stay in touch with the team
Come meet the Strands team and other users on [**Discord**](https://discord.com/invite/strands)

---

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](https://github.com/strands-agents/harness-sdk/blob/main/LICENSE.APACHE) file for details.

---

## Security

See [CONTRIBUTING](https://github.com/strands-agents/harness-sdk/blob/main/CONTRIBUTING.md#security-issue-notifications) for more information on reporting security issues.

