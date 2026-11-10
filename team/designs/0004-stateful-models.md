# Strands: Stateful Model Providers

**Status**: Proposed

**Date**: 2026-03-26

## Overview

We've been asked to add stateful model provider support to the Strands Python SDK, targeting the OpenAI Responses API on Amazon Bedrock (Project Mantle). The SDK already supports the Responses API in stateless mode via `OpenAIResponsesModel`. The ask is to enable stateful server-side conversation management: the server tracks context across turns, so the SDK sends only the latest message instead of the full history each time. The Responses API on Bedrock also brings compute environment selection, server-side context compaction, and reasoning effort control.

## Background

The OpenAI Responses API is hosted on AWS Bedrock's Mantle endpoint (`bedrock-mantle.{region}.api.aws`). It uses an OpenAI-compatible format and supports stateful server-side conversation management, where the server tracks context across turns so the client only sends the latest message.

### Features

- **Stateful conversations**: Server tracks context across turns (`previous_response_id`, `conversation`)
- **Context management**: Automatic truncation (`truncation`) and server-side compaction (`context_management`) for long conversations
- **Inference controls**: `temperature`, `top_p`, `max_output_tokens`
- **Reasoning**: Effort control from none to xhigh (`reasoning.effort`) with optional summaries (`reasoning.summary`)
- **Tools**: Function tools (client-side, same as today) plus server-side built-in tools like web search, file search, and code interpreter
- **Output format**: Plain text, JSON schema enforcement, JSON mode (`text.format`), verbosity control (`text.verbosity`)
- **Execution**: Streaming (`stream`) and background/async modes (`background`), parallel tool calls (`parallel_tool_calls`, `max_tool_calls`)
- **Storage**: Response persistence (`store`) and metadata tagging (`metadata`)
- **Caching**: Prompt caching (`prompt_cache_key`, `prompt_cache_retention`)
- **Service tiers**: Default, flex, priority (`service_tier`)
- **Compute environments**: e.g., AgentCore Runtime (`compute_environment`)

### Usage

```python
# Turn 1: No conversation ID yet, send full input
request = {
    "model": "us.anthropic.claude-sonnet-4-20250514",
    "input": [{"role": "user", "content": [{"type": "input_text", "text": "Hello"}]}],
    "instructions": "You are a helpful assistant.",
    "stream": True
}
# Server responds with id: "resp_abc123"

# Turn 2: Include previous_response_id, send only latest message
request = {
    "model": "us.anthropic.claude-sonnet-4-20250514",
    "previous_response_id": "resp_abc123",
    "input": [{"role": "user", "content": [{"type": "input_text", "text": "What did I just say?"}]}],
    "instructions": "You are a helpful assistant.",
    "stream": True
}
# Server rebuilds context from the chain, responds with id: "resp_def456"
```

The `previous_response_id` forms a linked list of turns. The server walks the chain to rebuild context. There is also a newer `conversation` parameter that provides a persistent container (similar to the old Assistants API threads), but `previous_response_id` is the established mechanism.

## Solution

What follows is the full vision for stateful model support in Strands. Some of this we may reach iteratively, for example starting with stateful mode on `OpenAIResponsesModel` and adding the `BedrockModel` subpackage later. The goal is to align the team on direction so that incremental work stays on track.

### Model Provider

`BedrockModel` is refactored from a single file (`bedrock.py`) into a subpackage:

```
strands/models/bedrock/
├── __init__.py      # exports BedrockModel, backward-compatible imports
├── base.py          # shared config, region resolution, boto session, facade logic
├── converse.py      # current Converse/ConverseStream (extracted from bedrock.py)
└── responses.py     # new Responses API implementation
```

`BedrockModel` becomes a facade. The `api` parameter controls dispatch:

```python
# Converse API (default, current behavior, nothing changes)
model = BedrockModel(model_id="us.anthropic.claude-sonnet-4-20250514")

# Responses API (new, targets Mantle endpoint)
model = BedrockModel(model_id="us.anthropic.claude-sonnet-4-20250514", api="responses")

# Responses API with compute environment
model = BedrockModel(
    model_id="us.anthropic.claude-sonnet-4-20250514",
    api="responses",
    compute_environment="agentcore",
)

# Pass-through for any Responses API parameter
model = BedrockModel(
    model_id="us.anthropic.claude-sonnet-4-20250514",
    api="responses",
    params={"reasoning": {"effort": "high"}, "truncation": "auto"},
)
```

- The Converse path uses boto3; the Responses path uses the OpenAI Python SDK with SigV4 signing via a custom httpx transport that resolves credentials from the same boto session
- Bedrock API key auth is also supported as a simpler alternative
- Request formatting and streaming event parsing are extracted into shared utilities used by both `bedrock/responses.py` and the existing `OpenAIResponsesModel`
- Provider-specific logic (auth, endpoint, client creation) stays in each provider

### Model State

We introduce a new framework-managed dict called `model_state` that flows between the Agent and model provider. This keeps model providers stateless while enabling stateful conversation tracking.

- Owned by the Agent, not the model provider (providers remain stateless)
- Passed to `model.stream()` as a keyword argument (existing providers ignore it via `**kwargs`)
- Model reads `conversation_id` from `model_state` and writes the updated ID back after each response
- Persisted in sessions via `_internal_state` in `SessionAgent` (works with all session manager implementations)
- Accessible in hooks via `event.model_state`

### Messages

When `model_state` contains a conversation ID, the Agent clears `agent.messages` at the start of each top-level invocation. Within an invocation, messages are appended normally (the event loop needs them for tool execution). After the invocation, `agent.messages` contains only that invocation's messages.

```python
agent = Agent(model=BedrockModel(api="responses"))

result1 = agent("Hello")
# agent.messages has: [user: "Hello", assistant: "Hi there!"]

result2 = agent("What's the weather?")
# agent.messages has: [user: "What's the weather?", assistant: "Let me check..."]
# (previous invocation's messages are cleared)
# Server still has full context via previous_response_id
```

- The server owns conversation history in stateful mode, so clearing locally avoids confusion about what the model sees and prevents unbounded memory growth
- `MessageAddedEvent` hooks still fire for each message during the invocation
- Session managers persist messages as they happen via hooks
- Nothing changes within an invocation; only cross-invocation behavior differs

### Conversations

The Responses implementation maps user-defined conversation IDs to server-generated response IDs in `model_state`. Users work with their own meaningful IDs and never need to manage server-generated ones. By default, all invocations use a `"default"` conversation. Users who need multiple conversations pass their own `conversation_id` on invoke:

```python
agent = Agent(model=BedrockModel(api="responses"))

# Single conversation (uses "default" implicitly)
agent("Hello")
agent("What's the capital of France?")
agent("What river runs through it?")  # server knows "it" = Paris

# Multi-conversation with user-defined IDs
agent("Help with billing", conversation_id="billing")
agent("What was my last charge?", conversation_id="billing")

agent("Track my order", conversation_id="orders")
agent("Any updates?", conversation_id="orders")

# Switch back
agent("One more billing question", conversation_id="billing")
```

- `model_state` maintains the mapping (e.g., `{"default": "resp_abc", "billing": "resp_def", "orders": "resp_xyz"}`)
- Session manager persists the mapping automatically, so all conversations survive restarts
- Users never need to capture or manage server-generated IDs
- Defaults to `NullConversationManager` when the model is operating in stateful mode
- If the user provides a different conversation manager, we emit a warning (not an exception)
- `ContextWindowOverflowException` is not retried client-side in stateful mode since the server handles context management

### Session Management

`model_state` (including the full conversation ID mapping) is persisted in `_internal_state` within `SessionAgent`. On session restore, the Agent restores `model_state` and subsequent requests resume their server-side conversations.

```python
# Session 1: Start conversations
session_mgr = RepositorySessionManager(session_id="user-123", ...)
agent = Agent(model=BedrockModel(api="responses"), session_manager=session_mgr)
agent("Help with my order", conversation_id="support")
agent("Check my balance", conversation_id="billing")

# Session 2: Resume (maybe after process restart)
session_mgr = RepositorySessionManager(session_id="user-123", ...)
agent = Agent(model=BedrockModel(api="responses"), session_manager=session_mgr)
agent("Any update on my order?", conversation_id="support")  # resumes support conversation
agent("What was my last charge?", conversation_id="billing")  # resumes billing conversation
```

- All conversation mappings survive agent restarts
- All session manager implementations (file, S3, DynamoDB, custom) get this automatically since `_internal_state` is already serialized

### Multi-Agent

Each agent in a swarm or graph has its own independent `model_state` and conversation ID mapping. `model_state` is reset alongside `messages` and `state` in `reset_executor_state()`, following the existing reset pattern.

- When `model_state` is reset (no conversation ID), the first request sends the full message history (including prefilled messages and context summaries), starting a new server-side conversation
- Text-based context passing (`_build_node_input`) works unchanged in both swarm and graph
- In graph, `reset_executor_state()` only runs when `reset_on_revisit` is enabled and a node is revisited; on revisit without reset, the agent resumes its existing server-side conversation
- Parallel node execution in graph is safe since `model_state` is per-agent, not per-model

### Plugin Pattern

Rather than the Agent having special-case `if stateful:` logic, the model provider could extend `Plugin` and register hooks for its lifecycle behaviors:

```python
class BedrockModel(Model, Plugin):
    name = "strands:bedrock-model"

    @hook
    def _on_before_invocation(self, event: BeforeInvocationEvent):
        if event.agent.model_state.get("conversation_id"):
            event.agent.messages.clear()
```

- Keeps the Agent generic with no stateful-mode special cases
- Any stateful provider can self-describe its behaviors through the existing hook/plugin system

## Questions

- **Background/async inference**: Should we support `background: true` (fire-and-forget with polling) in the initial release?
- **Mantle feature parity**: Which Converse features (guardrails, prompt caching) are NOT available through the Responses API?
- **Model availability**: Which models are available on the Mantle endpoint beyond OpenAI GPT OSS?
- **Conversation object**: Does Mantle support the `conversation` parameter, or only `previous_response_id`?
- **Conversation retention**: How long does the server maintain conversation state?

## Resources

- [AWS Bedrock Mantle docs](https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-mantle.html)
- [AWS Bedrock supported APIs](https://docs.aws.amazon.com/bedrock/latest/userguide/apis.html)
- [AWS Bedrock API key usage](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-use.html)
- [OpenAI Responses API reference](https://platform.openai.com/docs/api-reference/responses/create)
- [OpenAI conversation state guide](https://platform.openai.com/docs/guides/conversation-state)
- [OpenAI Responses API background mode](https://platform.openai.com/docs/guides/background)
- [Exploring Mantle CLI (blog post)](https://dev.to/aws/exploring-the-openai-compatible-apis-in-amazon-bedrock-a-cli-journey-through-project-mantle-2114)
