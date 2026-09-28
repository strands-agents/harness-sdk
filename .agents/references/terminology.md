# Terminology Lock

One concept, one term. Never vary for stylistic reasons. This file is the canonical source. Reference it during writing and review.

## Core SDK Concepts

| Concept | Canonical Term | NOT These |
|---------|---------------|-----------|
| The SDK's reasoning loop | agent loop | reasoning cycle, inference loop, think-act cycle |
| Calling a tool from the agent | tool calling | function calling, tool invocation, tool execution, function invocation |
| The model generating text | model response | LLM output, AI response, generation, completion |
| Developer-defined functions the agent can call | tools | functions, actions, capabilities, skills (in SDK context) |
| Pre-built tools from strands-agents-tools | community tools | built-in tools, standard tools, default tools |
| The MCP protocol for tool integration | MCP tools | MCP functions, MCP integrations, protocol tools |
| Configuring which model to use | model provider | model backend, LLM provider, inference provider |
| Maintaining conversation across turns (user-facing concept) | session management | context persistence, memory, conversation history |
| The SDK class that implements session management | conversation manager | session handler, context manager (note: `ConversationManager` is the API class name; "session management" is the user-facing concept in docs) |
| Durable knowledge an agent recalls across sessions | memory (or long-term memory) | knowledge store, recall, persistent memory |
| The SDK class that implements memory management | memory manager | knowledge store, recall, memory store, knowledge base |
| The SDK class that implements the backend containing memories | memory store | knowledge store, recall |
| Controlling agent behavior at runtime | hooks | middleware, interceptors, callbacks (hooks is Strands-specific) |
| Multiple agents working together | multi-agent | multi-agent system, agent orchestration, agent coordination |
| Agent-to-agent communication pattern | agents as tools | agent chaining, agent delegation, nested agents |
| Graph-based agent coordination | graph | workflow graph, DAG, directed graph |
| Dynamic agent handoff pattern | swarm | swarm intelligence, dynamic routing |
| Pausing agent execution for human input | interrupts | human-in-the-loop, breakpoints, pause points |
| Agent output with enforced schema | structured output | typed output, schema-validated output, Pydantic output |
| Watching agent execution | observability | monitoring, telemetry, instrumentation |
| Durable storage for offloaded context content | stash | L1 stash, L1, stash layer, context cache |
| Checking agent quality | evaluation | testing, benchmarking, assessment |
| Running agents in production | deployment | hosting, serving, shipping |
| The decorator for making Python functions into tools | @tool decorator | tool annotation, tool wrapper |

> **Note on "skills":** The banned synonym above applies to the SDK domain — never call SDK tools "skills" in user-facing docs. The term "skills" *is* correct when referring to [agentskills.io](https://agentskills.io)-style agent skill files (e.g., the contents of `.agents/skills/`). Those are authoring procedures for agents working on this repo, not SDK constructs.

## Infrastructure and Cloud

| Concept | Canonical Term | NOT These |
|---------|---------------|-----------|
| AWS model service | Amazon Bedrock | AWS Bedrock, Bedrock |
| Anthropic's model family | Claude (with version, e.g., Claude Sonnet 4) | Anthropic model, the model |
| OpenAI's model API | OpenAI | GPT (when referring to the provider) |
| Ollama local inference | Ollama | local LLM, self-hosted model |
| LiteLLM proxy | LiteLLM | lite-llm, LiteLLM proxy |
| Container deployment | Docker | containerization |
| AWS serverless deployment | AWS Lambda | Lambda functions, serverless functions |
| AWS managed agent platform | Amazon Bedrock AgentCore | AgentCore, Bedrock Agents (legacy) |

## Model Provider Naming

When documenting model providers, use the provider name as the heading and the SDK class name in code. The framework is model-agnostic — never imply a default in conceptual docs.

| Provider | SDK Class (Python) | SDK Class (TypeScript) |
|----------|-------------------|----------------------|
| Amazon Bedrock | `BedrockModel` | `BedrockModel` |
| Anthropic (direct) | `AnthropicModel` | `AnthropicModel` |
| OpenAI | `OpenAIModel` | `OpenAIModel` |
| Ollama | `OllamaModel` | `OllamaModel` |
| LiteLLM | `LiteLLMModel` | `LiteLLMModel` |
| Custom | `Model` (protocol/interface) | `Model` (interface) |

## Content Type Labels (for frontmatter)

| Type | Frontmatter Value | Description |
|------|------------------|-------------|
| Learning-oriented, narrative | tutorial | Walk-through that builds something |
| Problem-oriented, practical | howto | Steps to accomplish a specific task |
| Information-oriented, precise | reference | API docs, parameter tables, specs |
| Understanding-oriented, conceptual | explanation | Why things work the way they do |

## Python / TypeScript Naming Divergences

These SDK-specific names differ between languages. Use the correct name per language tab:

| Concept | Python | TypeScript |
|---------|--------|------------|
| Agent initialized event | `AgentInitializedEvent` | `InitializedEvent` |
| Multi-agent plugin base | `HookProvider` (protocol) | `MultiAgentPlugin` (abstract class, use `extends`) |
| Plugin base | `Plugin` (class) | `Plugin` (interface, use `implements`) |
| Tool use property | `event.tool_use["name"]` (dict) | `event.toolUse.name` (object) |
| Cancel tool | `event.cancel_tool` | `event.cancel` |

## Adding New Terms

When you encounter a concept that needs a canonical term:
1. Check this file first
2. If not present, propose the term with rationale
3. Add to this file after team review
4. Update any existing docs that use non-canonical variants
