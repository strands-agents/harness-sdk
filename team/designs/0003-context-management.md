# Strands Context Management

## Overview

This document outlines the strategic direction for context management improvements in Strands Agents. It is a high-level roadmap, not a detailed implementation spec. Individual features will require their own design documents before implementation. This document is intended for SDK contributors and advanced users familiar with Strands Agents internals.

---

## Problem Statement

Context is everything the model sees in a single request: the system prompt, conversation history, tool definitions, and any documents or images. Every model has a finite context window, measured in tokens. When the accumulated context exceeds this limit, the request fails. Context management is the practice of controlling what stays in the active context window versus what is removed, manipulated, or stored elsewhere. As conversations grow and agents accumulate tool results and artifacts, something has to give. The question is what to keep, what to remove, and whether removed content should be retrieved later.

This document focuses on performance: helping agents maintain trajectory alignment throughout long conversations. Cost is not a primary consideration, though some proposals may incidentally reduce costs while others may increase them in service of better performance. The proposals here aim to help users maintain optimal context to achieve their application goals effectively.

---

## Current State

#### Conversation Context Challenges

Context is not populated or removed intelligently. Each prompt sends whatever is in the active window without considering what's relevant to the current task. Content removed from active context is stored in session storage for audit-ability, but there's no standard way to retrieve it. If something relevant was said early in a conversation, it's effectively lost once removed from the window. Session reloading is a partial exception where semantic retrieval can repopulate context, but this only applies when resuming a session, not during ongoing conversations. Current strategies are lossy. Sliding window drops oldest messages regardless of importance. Summarization delegates to an LLM, but each iteration loses detail, gradually eroding the foundation of understanding that agents need to maintain trajectory alignment across long-running conversations.

#### Tool Context Challenges

Tool definitions and results both consume context. On the definition side, all registered tools are sent with every request regardless of relevance to the current task. Irrelevant tools dilute attention and degrade tool selection accuracy. On the result side, a single oversized result can push context into overflow. Recovery is difficult when the result itself exceeds what can be summarized, leading to unrecoverable loops where the agent repeatedly fails to reduce context. Today, Strands offers no first-class support for dynamically filtering tools or managing result sizes; users must handle these problems themselves.

---

## Proposed Solutions

#### Design Principles

1. Paved paths over escape hatches: Guide users through well-designed interfaces that make the right thing easy. Plugins already provide escape hatches for advanced customization, but the primary path should be a first-class interface. If users consistently reach for plugins to achieve common outcomes, that's a signal to pave that path with a proper abstraction.
2. Autonomy over configuration: Agents should be dynamic throughout execution, not just at startup. Static configuration that becomes fixed once the run starts limits agent capability. Prefer designs where the agent can adapt its own behavior mid-run based on task needs.
3. Research-backed: Features grounded in data, not speculation
4. Provider Agnostic: Core strategies work across all model providers

#### Tracks

The work is organized into three tracks. 

1. Track 1: Conversation Context addresses how message history is managed as conversations grow. 
2. Track 2: Tool Context addresses how tool definitions consume context.
3. Track 3: Delegation addresses how agents can dynamically delegate tasks to sub-agents to manage context overhead.

---

### Track 1: Conversation Context

Current conversation managers treat context reduction as a one-way operation. Sliding window drops messages permanently. Summarization compresses them into a lossy summary. In both cases, once content leaves the active window, it cannot come back even if it becomes relevant later. These approaches work for short conversations but struggle to maintain trajectory alignment over long-running sessions.

Two research papers offer approaches Strands should explore for making context recoverable rather than permanently lost.

#### MemGPT

[MemGPT](https://arxiv.org/abs/2310.08560) challenges the assumption that context reduction must be permanent. It applies OS concepts to LLM context: tiered memory with intelligent paging between main context (active window), recall memory (recent history), and archival memory (long-term storage). Content moves between tiers based on relevance. The key insight for Strands is that we already have the storage layer (SessionManager) but lack the retrieval path. AgentCore already offers semantic retrieval as a managed service. The value of building this into Strands itself is provider independence. Users who can't or don't want to use AgentCore still need a path to intelligent context retrieval. A first-class Strands implementation would work across any model provider and storage backend.

#### Lessons from Recursive Language Models

[Recursive Language Models](https://arxiv.org/abs/2512.24601) train models to recursively process long prompts by chunking and summarizing. We're not building a model, but the approach offers a useful pattern for agentic frameworks: instead of dumping large content directly into context, give the agent tools to navigate it on demand.

For Strands, this means providing aliasing tools for large context items like documents and images. Rather than consuming the full context window upfront, agents could intelligently explore these resources as needed. This complements the MemGPT approach: when an agent realizes "we discussed this earlier," it can navigate back to that content rather than having it permanently lost or bloating the window. We have routinely seen this in interest channels with questions like "the returned item is large what do I do". The answer is to alias so the result is not automatically, and entirely, entered into the context window. This alias can be first class in Strands.

#### Proposed Features: Aliasing and Context Navigation

Both approaches require bridging the active context window with persistent storage. Today ConversationManager and SessionManager operate in isolation. Intelligent context management needs them to work together: persistent storage becomes a retrievable context source, and the context manager must know what's available for retrieval and when to retrieve it.

The core idea is giving the agent tools to navigate its own context rather than passively receiving whatever fits in the window. Content removed from active context is stored in SessionManager but never retrieved, close this loop by letting the agent search and retrieve relevant messages from session storage. The same pattern applies to large content blocks like documents, images, and long tool results: alias them rather than inline them, and let the agent navigate into them on demand rather than consuming the full window upfront.

```
class OversizedToolResult(ToolResult):
    """ToolResult storing representation of large result and ability to access as needed"""
    ...
```

The key design decision is whether navigation is automatic (ConversationManager retrieves on behalf of the agent) or autonomous (agent explicitly requests context via tools). Following the autonomy principle, we lean toward giving the agent control. This means providing the agent with meta-tools to modify its own context:

```
@tool
def populate_context(...) -> None:
    """Find and load relevant context into the active window."""
    ...
```

The agent can request context, and the framework handles retrieval and insertion into the active window. This is a direct application of the MemGPT pattern: the agent manages its own memory rather than relying on static windowing strategies. The exact ergonomics, whether this is one tool or several, what parameters it takes, come later in LLD. The decision to progress with the concept is what matters: agents can modify their own context.

Notably, temporal order is not always the best ordering for retrieved context. LLMs attend best to the beginning and end of context, with reduced attention in the middle ([Lost in the Middle](https://arxiv.org/abs/2307.03172)). An autonomous agent can use this knowledge, through its system prompt, to order its own context strategically, placing high-relevance content at attention-favored positions rather than simply appending in chronological order.

---

### Track 2: Tool Context

Tool definitions consume context alongside messages. When agents have large tool sets, irrelevant tools dilute the model's attention and degrade selection accuracy. This track explores two approaches: filtering tools by relevance, and replacing large tool sets with code generation.

#### Dynamic Tool Loading

Every registered tool is sent with every request. An agent with 100 tools sends all 100 definitions regardless of whether the user's current task needs them. This wastes context and confuses tool selection. The same pattern applies beyond tools: agent SOPs, skills, and other capability definitions all consume context and could benefit from relevance-based filtering. AgentCore Gateway solves this for managed service users by embedding tool descriptions and filtering by semantic similarity to the current query. MCP has a draft proposal for tool search ([SEP-1821](https://github.com/modelcontextprotocol/specification/issues/1821)), but it only addresses filtering within a single server. When an agent connects to multiple tool sources, there's no cross-source search.
Proposed solution. We propose two approaches for dynamically switching tools based on relevance:

Automatic approach: Using `SemanticDynamicToolRegistry` which automatically loads and removes tools during certain lifecycle events. This registry can be backed by a vector store for semantic similarity search, or use a simpler file-based approach with LLM calls to determine relevance. The registry monitors conversation context and proactively adjusts the active tool set without agent intervention.
```
Agent(
    model=model,
    tools=[mcp1, mcp2, mcp3],
    tool_selection="semantic_dynamic",  # Enable automatic dynamic tool loading
    tool_registry=SemanticDynamicToolRegistry(..) # Handles lifecycle-based tool switching
)
```
This addresses gaps that managed services and protocol extensions cannot fill. AgentCore Gateway only works with remote MCPs; local MCP servers are invisible to it. MCP's SEP-1821 only addresses filtering within a single server. When an agent connects to multiple MCP sources, there's no cross-source search. A client-side dynamic registry solves both: it works with any tool source (local or remote) and searches across all of them.

#### Autonomous Approach

Providing a meta-tool `load_relevant_tools` that lets the LLM decide when to discover and load additional capabilities. This approach gives the agent full control over its toolkit expansion, allowing it to request specific tools as the task evolves. Rather than rigid upfront filtering, this leans into agent autonomy: start with a relevant subset, but let the agent expand its toolkit when needed.
```
def load_relevant_tools(query: str, limit: int = 10) -> list[ToolDescription]:
    """Search for additional tools by description."""
    ...
```
The autonomous approach goes further by exposing tool discovery as a tool itself, letting the agent autonomously discover capabilities as the task evolves.

#### Code Generation

The problem. Even with semantic filtering, some agents need access to many capabilities. A developer assistant might need file operations, git commands, HTTP requests, JSON parsing, and more. Each capability as a separate tool adds to context overhead.

[Cloudflare Code Mode](https://blog.cloudflare.com/code-mode/) and [Anthropic Code Execution](https://www.anthropic.com/engineering/code-execution-with-mcp) found that LLMs are better at writing code than selecting tools. Models have seen far more training examples of code than function-calling schemas. They convert tool definitions to typed SDK definitions and let the LLM generate code that calls the SDK. The generated code executes in a sandbox where the SDK is bound to actual tool implementations. Tools become a typed API surface, and the model's strength at code generation replaces its weakness at tool selection. A single `execute_code` tool replaces dozens of individual tools. The agent accomplishes work in one code execution call instead of chaining N tool calls, fewer round-trips means faster results and less opportunity to drift off track.

However, there are security concerns with this approach. The agent generates arbitrary code. Without isolation, that code runs with the agent's full permissions, file system access, network access, credentials. A sandbox must be introduced to constrain what generated code can do. The tools themselves define the capability boundary: the sandbox exposes only the tool SDK, not raw system access.

**Proposed solution**. Provide a `CodeSandbox` interface that accepts tool definitions, exposes them as a callable SDK within the sandbox, executes agent-generated code in isolation, and returns results to the agent. Interface details are pending LLD. AgentCore CodeInterpreter is a natural implementation of this interface, it already provides sandboxed Python execution. We will ship a local and AgentCore CodeInterpreter integration alongside this feature.

---

### Track 3: Delegation

We support delegation through sub-agent processes, where agents can be used as tools to absorb context pain and prevent orchestrator context window bloat. However, agents should also be able to autonomously choose when to delegate based on task complexity and context constraints. This autonomous delegation capability will be implemented as a meta-tool in the core SDK, building on existing concepts from strands-agents/tools.

Unlike context management (which tackles what to do once we have context and whether to prune or retrieve it) and tool context (which prevents tools from bloating context), this track tackles the idea similar to tools of preventing context from entering the system in the first place. By delegating subtasks to specialized sub-agents, the orchestrator never accumulates the detailed context that would otherwise consume its window.

This track will largely be a migration. Where we must envision what meta-agents look like when they are foundational tools compared to

---

### Meta-tooling

These are a new class of tools: meta-tools that operate on the agent's own state rather than external systems. Where normal tools let agents act on the world, meta-tools let agents introspect and modify themselves. Context navigation is one example; the search_tools feedback mechanism in Track 2 is another. This is related to the meta-agents concept: agents that spawn or orchestrate other agents. Meta-tools are the single-agent equivalent.

---

## Work Plan

This work plan outlines the prioritized issues we plan to tackle as part of this epic context epic. Importantly, we already have several issues filed in GitHub. So those will be prioritized along with the new suggestions in this document.

| # | Name | Size | Priority | Description | Dependencies |
|---|------|------|----------|-------------|--------------|
| 1 | Track agent.messages token size | S | High | Expose current context token count as a metric (#1197) | — |
| 2 | Token estimation API | M | Medium | Needs design around model switching (token definitions change per model/provider) (#1294) | — |
| 3 | Context limit property on Model | S | Medium | Add a property + lookup table per provider (#1295) | 2 |
| 4 | Code sandbox | XL | Medium | Replace large tool sets with a single execute_code tool backed by an isolated sandbox (#1676) | — |
| 5 | Large tool result externalization hook | S | High | Uses existing hooks system; immediate value for the "my result is too large" pain point (#1296) | — |
| 6 | Proactive context compression | M | Medium | Most requested context feature (#555) | 2, 3 |
| 7 | In-event-loop context management | M | Medium | Manage context within a cycle for tool-heavy agents (#298) | — |
| 8 | Autonomous delegation meta-tool | M | Medium | Migration from existing multi-agent patterns; high standalone value (#1681) | — |
| 9 | Semantic dynamic tool registry | XL | Medium | Needs design doc + vector store integration (#1677) | — |
| 10 | Large content aliasing | M | Low | Externalize oversized results so agents navigate on demand instead of inlining (#1678) | 5 |
| 11 | Bridge ConversationManager and SessionManager | L | Low | Foundational plumbing that unlocks 13 and 14 (#1679) | — |
| 12 | Autonomous tool discovery meta-tool | M | Low | load_relevant_tools as a standalone capability without full registry (#1680) | — |
| 13 | Context navigation meta-tools | S | Low | First "agent manages its own memory" capability (#1682) | 11 |
| 14 | Tiered memory (MemGPT-inspired) | XL | Low | Capstone of conversation context track (#1683) | 11, 13 |

