The [Responses API](https://platform.openai.com/docs/api-reference/responses) is OpenAI’s interface for generating model responses and building agents. It is a superset of the [Chat Completions](/docs/user-guide/sdk/model-providers/openai/index.md) API, with additional support for [built-in tools](#built-in-tools), server-side conversation state management, and multi-modal inputs.

## Installation

(( tab "Python" ))
```bash
pip install 'strands-agents[openai]'
```

Requires `openai>=2.0.0`. Install or upgrade with `pip install -U openai`.
(( /tab "Python" ))

(( tab "TypeScript" ))
```bash
npm install @strands-agents/sdk openai
```
(( /tab "TypeScript" ))

## Usage

After installing dependencies, you can import and initialize the Responses provider as follows:

(( tab "Python" ))
```python
from strands import Agent
from strands.models.openai_responses import OpenAIResponsesModel

model = OpenAIResponsesModel(
    model_id="gpt-4o",
    client_args={"api_key": "<KEY>"},
)

agent = Agent(model=model)
response = agent("Hello!")
print(response)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'

const model = new OpenAIModel({
  modelId: 'gpt-4o',
  apiKey: '<KEY>',
})

const agent = new Agent({ model })
const response = await agent.invoke('Hello!')
console.log(response)
```

In TypeScript, both the Responses API and Chat Completions API are available through a single `OpenAIModel` class. The Responses API is selected by default. Pass `api: 'chat'` to use [Chat Completions](/docs/user-guide/sdk/model-providers/openai/index.md) instead.
(( /tab "TypeScript" ))

To connect to Amazon Bedrock’s OpenAI-compatible Mantle endpoints, see [OpenAI-compatible endpoints (Mantle)](/docs/user-guide/sdk/model-providers/amazon-bedrock/index.md#openai-compatible-endpoints-mantle) on the Amazon Bedrock page.

## Configuration

### Client Configuration

(( tab "Python" ))
The `client_args` configure the underlying OpenAI client. For a complete list of available arguments, refer to the [OpenAI Python SDK](https://github.com/openai/openai-python).
(( /tab "Python" ))

(( tab "TypeScript" ))
The `clientConfig` configures the underlying OpenAI client. For a complete list of available options, refer to the [OpenAI TypeScript SDK](https://github.com/openai/openai-node).
(( /tab "TypeScript" ))

### Model Configuration

The model configuration sets parameters for inference:

(( tab "Python" ))
| Parameter | Description | Example | Options |
| --- | --- | --- | --- |
| `model_id` | ID of a model to use | `gpt-4o` | [reference](https://platform.openai.com/docs/models) |
| `params` | Model and tool parameters | `{"tools": [{"type": "web_search"}]}` | [reference](https://platform.openai.com/docs/api-reference/responses/create) |
| `stateful` | Enable server-side conversation state | `True` | `True` / `False` |
(( /tab "Python" ))

(( tab "TypeScript" ))
| Parameter | Description | Example | Options |
| --- | --- | --- | --- |
| `modelId` | ID of a model to use | `'gpt-4o'` | [reference](https://platform.openai.com/docs/models) |
| `maxTokens` | Maximum tokens to generate | `1000` | [reference](https://platform.openai.com/docs/api-reference/responses/create) |
| `temperature` | Controls randomness (0-2) | `0.7` | [reference](https://platform.openai.com/docs/api-reference/responses/create) |
| `topP` | Nucleus sampling (0-1) | `0.9` | [reference](https://platform.openai.com/docs/api-reference/responses/create) |
| `stateful` | Enable server-side conversation state | `true` | `true` / `false` |
| `params` | Additional parameters (e.g., built-in tools) | `{ tools: [{ type: 'web_search' }] }` | [reference](https://platform.openai.com/docs/api-reference/responses/create) |
(( /tab "TypeScript" ))

## Built-in Tools

Built-in tools run server-side and are passed via the `params` configuration. They work alongside any function tools registered on the agent.

### Web Search

(( tab "Python" ))
```python
model = OpenAIResponsesModel(
    model_id="gpt-4o",
    params={"tools": [{"type": "web_search"}]},
    client_args={"api_key": "<KEY>"},
)

agent = Agent(model=model)
response = agent("What are the latest developments in AI?")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const model = new OpenAIModel({
  modelId: 'gpt-4o',
  apiKey: '<KEY>',
  params: {
    tools: [{ type: 'web_search' }],
  },
})

const agent = new Agent({ model })
const response = await agent.invoke('What are the latest developments in AI?')
```
(( /tab "TypeScript" ))

Web search responses include URL citations that are streamed through the SDK’s citation system.

### File Search

(( tab "Python" ))
```python
model = OpenAIResponsesModel(
    model_id="gpt-4o",
    params={
        "tools": [{"type": "file_search", "vector_store_ids": ["vs_abc123"]}],
    },
    client_args={"api_key": "<KEY>"},
)

agent = Agent(model=model)
response = agent("What does the document say about pricing?")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const model = new OpenAIModel({
  modelId: 'gpt-4o',
  apiKey: '<KEY>',
  params: {
    tools: [
      {
        type: 'file_search',
        vector_store_ids: ['vs_abc123'],
      },
    ],
  },
})

const agent = new Agent({ model })
const response = await agent.invoke('What does the document say about pricing?')
```
(( /tab "TypeScript" ))

File search requires a [vector store](https://platform.openai.com/docs/guides/tools-file-search) with uploaded files. Text responses stream correctly; file citation annotations are not yet mapped to the SDK citation schema.

### Code Interpreter

(( tab "Python" ))
```python
model = OpenAIResponsesModel(
    model_id="gpt-4o",
    params={
        "tools": [{"type": "code_interpreter", "container": {"type": "auto"}}],
    },
    client_args={"api_key": "<KEY>"},
)

agent = Agent(model=model)
response = agent("Calculate the SHA-256 hash of 'hello world'")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const model = new OpenAIModel({
  modelId: 'gpt-4o',
  apiKey: '<KEY>',
  params: {
    tools: [
      {
        type: 'code_interpreter',
        container: { type: 'auto' },
      },
    ],
  },
})

const agent = new Agent({ model })
const response = await agent.invoke("Calculate the SHA-256 hash of 'hello world'")
```
(( /tab "TypeScript" ))

The model executes code server-side and includes the results in its text response. The executed code and stdout/stderr are not currently surfaced to the caller.

### Remote MCP

The `mcp` built-in tool connects the model to a remote [MCP](https://modelcontextprotocol.io/) server, letting it call tools hosted externally without any local MCP client setup.

(( tab "Python" ))
```python
model = OpenAIResponsesModel(
    model_id="gpt-4o",
    params={
        "tools": [
            {
                "type": "mcp",
                "server_label": "deepwiki",
                "server_url": "https://mcp.deepwiki.com/mcp",
                "require_approval": "never",
            }
        ]
    },
    client_args={"api_key": "<KEY>"},
)

agent = Agent(model=model)
response = agent("Using deepwiki, what language is the strands-agents/harness-sdk repo written in?")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const model = new OpenAIModel({
  modelId: 'gpt-4o',
  apiKey: '<KEY>',
  params: {
    tools: [
      {
        type: 'mcp',
        server_label: 'deepwiki',
        server_url: 'https://mcp.deepwiki.com/mcp',
        require_approval: 'never',
      },
    ],
  },
})

const agent = new Agent({ model })
const response = await agent.invoke(
  'Using deepwiki, what language is the strands-agents/harness-sdk repo written in?'
)
```
(( /tab "TypeScript" ))

The model discovers and calls tools exposed by the remote MCP server. The approval flow is not currently surfaced, so `require_approval` must be set to `"never"`.

### Shell

The `shell` built-in tool runs shell commands inside a hosted container managed by OpenAI.

(( tab "Python" ))
```python
model = OpenAIResponsesModel(
    model_id="gpt-4o",
    params={
        "tools": [{"type": "shell", "environment": {"type": "container_auto"}}],
    },
    client_args={"api_key": "<KEY>"},
)

agent = Agent(model=model)
response = agent("Use the shell to compute the md5sum of the string 'hello world'.")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const model = new OpenAIModel({
  modelId: 'gpt-4o',
  apiKey: '<KEY>',
  params: {
    tools: [
      {
        type: 'shell',
        environment: { type: 'container_auto' },
      },
    ],
  },
})

const agent = new Agent({ model })
const response = await agent.invoke(
  'Use the shell to compute the md5sum of the string "hello world".'
)
```
(( /tab "TypeScript" ))

The model executes commands server-side and includes the output in its text response.

## Server-side Conversation State

When `stateful` is enabled, the model manages conversation history server-side using OpenAI’s `previous_response_id` mechanism. The agent’s local message history is cleared after each turn, reducing payload size for multi-turn conversations.

(( tab "Python" ))
```python
model = OpenAIResponsesModel(
    model_id="gpt-4o",
    stateful=True,
    client_args={"api_key": "<KEY>"},
)

agent = Agent(model=model)
agent("My name is Alice.")
# agent.messages is empty; conversation state is on the server

response = agent("What is my name?")
# The model remembers "Alice" via server-side state
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const model = new OpenAIModel({
  modelId: 'gpt-4o',
  apiKey: '<KEY>',
  stateful: true,
})

const agent = new Agent({ model })
await agent.invoke('My name is Alice.')
// agent.messages is empty: state is on the server

const response = await agent.invoke('What is my name?')
// The model remembers "Alice" via server-side state
```
(( /tab "TypeScript" ))

When using a stateful model, the agent automatically uses a null conversation manager and throws an error if a conversation manager is also supplied.

## Advanced Features

### Token Counting

Token counting is used by context management strategies to estimate input tokens before each model call.

(( tab "Python" ))
The OpenAI Responses provider can use the native `responses.input_tokens.count()` API, which provides exact token counts including messages, instructions, and tool specifications.

You can enable native token counting with:

```python
model = OpenAIResponsesModel(
    model_id="gpt-4.1",
    use_native_token_count=True,
)
```

When disabled (or if the API call fails), falls back to estimation with a character-based heuristic (characters ÷ 4 for text, characters ÷ 2 for JSON).
(( /tab "Python" ))

(( tab "TypeScript" ))
The OpenAI Responses provider does not currently implement native token counting in the TypeScript SDK. It uses estimation with a character-based heuristic (characters ÷ 4 for text, characters ÷ 2 for JSON).
(( /tab "TypeScript" ))

## References

-   [Migrate from OpenAI to Strands](/docs/user-guide/migrate/openai/index.md) — move a hand-written OpenAI loop or an OpenAI Agents SDK app to Strands
-   [Python API](/docs/api/python/strands.models.openai_responses)
-   [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses)
-   [Amazon Bedrock Mantle](https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-mantle.html)
-   [OpenAI Chat Completions](/docs/user-guide/sdk/model-providers/openai/index.md) (alternative provider using the Chat Completions API)

## Related pages

- [Add tools to your agent](/docs/user-guide/sdk/tools/index.md) (1 shared tag)
- [Connect your agent to MCP tools](/docs/user-guide/sdk/tools/mcp-tools/index.md) (1 shared tag)
- [MCP Transports](/docs/user-guide/sdk/tools/mcp-transports/index.md) (1 shared tag)
- [State Management](/docs/user-guide/sdk/agents/state/index.md) (1 shared tag)
- [Persist state across sessions](/docs/user-guide/sdk/agents/session-management/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/models/openai_responses.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/openai_responses.py)

### TypeScript

- [harness-sdk/strands-ts/src/models/openai/responses-adapter.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/openai/responses-adapter.ts)
