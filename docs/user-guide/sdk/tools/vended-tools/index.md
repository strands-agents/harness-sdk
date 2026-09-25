Vended tools are pre-built tools included directly in the Strands Harness SDK for common agent tasks like file operations, shell commands, HTTP requests, and persistent notes.

They ship as part of the SDK package and are updated alongside it. See [Versioning & Maintenance](#versioning--maintenance) for how changes are communicated and what level of backwards compatibility they maintain.

## Quick start

Each tool is imported from its own subpath under `@strands-agents/sdk/vended-tools`, with no additional packages required:

```typescript
import { Agent } from '@strands-agents/sdk'
import { bash } from '@strands-agents/sdk/vended-tools/bash'
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor'
import { httpRequest } from '@strands-agents/sdk/vended-tools/http-request'
import { notebook, makeNotebook } from '@strands-agents/sdk/vended-tools/notebook'

const agent = new Agent({
  tools: [bash, fileEditor, httpRequest, notebook],
})
```

## Available tools

| Tool | Description | Supported in |
| --- | --- | --- |
| [File Editor](#file-editor) | View, create, and edit files | Python, TypeScript (Node.js) |
| [HTTP Request](#http-request) | Make HTTP requests to external APIs | Python, TypeScript (Node.js 22+, browsers) |
| [Notebook](#notebook) | Manage persistent text notebooks | Python, TypeScript (Node.js, browsers) |
| [Bash](#bash) | Execute shell commands with persistent sessions | Python, TypeScript (Node.js, Unix/Linux/macOS) |
| [MCP Router](#mcp-router) | Connect to Model Context Protocol servers on a developer-set allowlist | Python |
| [Sleep](#sleep) | Pause execution for a bounded, cancellable duration | Python, TypeScript (Node.js, browsers) |
| [Handoff to User](#handoff-to-user) | Pause the agent loop and surface a message to the user | Python, TypeScript (Node.js, browsers) |
| [Stop](#stop-experimental) | Gracefully end the agent loop when the task is complete | Python, TypeScript (Node.js, browsers) |
| [Web Fetch](#web-fetch) | Fetch a URL and return cleaned markdown for a model to read | Python, TypeScript (Node.js) |
| [A2A Client](#a2a-client) | Discover and send messages to remote A2A-protocol agents | Python |

### File editor

Lets your agent read and modify files on disk: useful for coding agents, config management, or any workflow where the agent inspects output and makes targeted edits.

Security Warning

This tool reads and writes files at arbitrary absolute paths with the full permissions of the process. Only use with trusted input and consider running in a [sandboxed environment](/docs/user-guide/sdk/sandbox/index.md) for production.

**Example:**

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor'

const agent = new Agent({
  tools: [fileEditor],
})

// Create, view, and edit files
await agent.invoke('Create a file /tmp/config.json with {"debug": false}')
await agent.invoke('Replace "debug": false with "debug": true in /tmp/config.json')
await agent.invoke('View lines 1-10 of /tmp/config.json')
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
from strands import Agent
from strands.vended_tools import file_editor

agent = Agent(tools=[file_editor])
agent("Create a file at /tmp/hello.txt with the contents 'Hello, world!'")
```
(( /tab "Python" ))

[Full API reference](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/file-editor/README.md)

---

### HTTP request

Lets your agent call external APIs and fetch web content. Supports all HTTP methods, custom headers, and request bodies. Default timeout is 30 seconds.

*Supported in: Python; Node.js 22+, modern browsers (TypeScript).*

(( tab "Python" ))
The Python tool delegates all networking to an `httpx.AsyncClient`. Use the `make_http_request` factory to supply a pre-configured client with authentication, timeouts, redirects, proxies, or other transport-level configuration.
(( /tab "Python" ))

**Example:**

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { httpRequest } from '@strands-agents/sdk/vended-tools/http-request'

const agent = new Agent({
  tools: [httpRequest],
})

// Make API requests
await agent.invoke('Get data from https://api.example.com/users')
await agent.invoke('Post {"name": "John"} to https://api.example.com/users')
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
from strands import Agent
from strands.vended_tools import http_request

agent = Agent(tools=[http_request])
agent("Get data from https://api.example.com/data")
```

Custom configuration with a pre-configured client:

```python
import httpx
from strands import Agent
from strands.vended_tools import make_http_request

client = httpx.AsyncClient(
    headers={"Authorization": "Bearer token"},
)
tool = make_http_request(client=client)
agent = Agent(tools=[tool])
```
(( /tab "Python" ))

Full API reference: [TypeScript](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/http-request/README.md), [Python](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/http_request/README.md)

---

### Notebook

A scratchpad the agent can read and write across invocations. The most effective use is giving the agent a notebook at the start of a task and instructing it to plan its work there. It can break the task into steps, check things off as it goes, and always have a clear picture of what’s left. Notebook state is part of the agent’s state, so it persists automatically with [Session Management](/docs/user-guide/sdk/agents/session-management/index.md).

*Supported in: Node.js, modern browsers (TypeScript); all platforms (Python).*

**Example - Task Management:**

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { notebook } from '@strands-agents/sdk/vended-tools/notebook'

const agent = new Agent({
  tools: [notebook],
  systemPrompt:
    'Before starting any multi-step task, create a notebook with a checklist of steps. ' +
    'Check off each step as you complete it.',
})

// The agent uses the notebook to plan and track its work
await agent.invoke('Write a project plan for building a personal budget tracker app')
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
from strands import Agent
from strands.vended_tools import notebook

agent = Agent(tools=[notebook])
agent('Create a notebook called "tasks" with "# Daily Tasks" and add "- [ ] Review code" to it')
```
(( /tab "Python" ))

**Example - State Persistence:**

(( tab "TypeScript" ))
```typescript
import { Agent, SessionManager, FileStorage } from '@strands-agents/sdk'
import { notebook } from '@strands-agents/sdk/vended-tools/notebook'

const session = new SessionManager({
  sessionId: 'my-session',
  storage: { snapshot: new FileStorage('./sessions') },
})

const agent = new Agent({ tools: [notebook], sessionManager: session })

// Notebooks are automatically persisted as part of the session
await agent.invoke('Create a notebook called "ideas" with "# Project Ideas"')
await agent.invoke('Add "- Build a web scraper" to the ideas notebook')

// ...

// Later, a new agent with the same session restores notebooks automatically
const restoredAgent = new Agent({ tools: [notebook], sessionManager: session })
await restoredAgent.invoke('Read the ideas notebook')
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
from strands import Agent
from strands.vended_tools import notebook

agent = Agent(tools=[notebook])
agent('Create a notebook called "tasks" with "# Daily Tasks" and add "- [ ] Review code" to it')

# Read the notebook contents directly off agent state.
notebooks = agent.state.get("notebooks") or {}
print(notebooks.get("tasks"))
```
(( /tab "Python" ))

**Example - Custom configuration:**

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { makeNotebook } from '@strands-agents/sdk/vended-tools/notebook'

const notes = makeNotebook({
  name: 'notes',
  maxNotebookSizeBytes: 64 * 1024, // 64 KiB
})
const agent = new Agent({ tools: [notes] })
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
from strands import Agent
from strands.vended_tools import make_notebook

notes = make_notebook(
    name="notes",
    max_notebook_size_bytes=64 * 1024,  # 64 KiB
)
agent = Agent(tools=[notes])
```
(( /tab "Python" ))

📖 [Full API Reference](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/notebook/README.md)

---

### Bash / shell

Lets your agent run shell commands and act on the output. The two SDKs expose different tools here:

-   **TypeScript `bash`** spawns a persistent `bash` process on the host. Shell state (variables, working directory, exported functions) persists across invocations within the same session, so the agent can build up context incrementally. Sessions can be restarted to clear state.
-   **Python `shell`** (and TypeScript’s `makeShell`) routes each command through the agent’s [Sandbox](/docs/user-guide/sdk/sandbox/index.md) and is stateless: every call runs in a fresh shell, so variables and the working directory do not carry over. The sandbox decides the interpreter (`sh` locally and in Docker, the remote login shell over SSH), so use portable POSIX syntax.

*Supported in: Node.js on Unix/Linux/macOS (TypeScript), all platforms (Python).*

Security Warning

These tools execute arbitrary shell commands. Without a [Sandbox](/docs/user-guide/sdk/sandbox/index.md), commands run with the full permissions of the process. Only use with trusted input and consider running in a [sandboxed environment](/docs/user-guide/sdk/sandbox/index.md) for production.

**Example - File Operations:**

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { bash } from '@strands-agents/sdk/vended-tools/bash'

const agent = new Agent({
  tools: [bash],
})

// List files and create a new file
await agent.invoke('List all files in the current directory')
await agent.invoke('Create a new file called notes.txt with "Hello World"')
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
from strands import Agent
from strands.vended_tools import shell

agent = Agent(tools=[shell])
agent("List all Python files in the current directory and count them")
```
(( /tab "Python" ))

**Example - Session Persistence (TypeScript):**

```typescript
import { Agent } from '@strands-agents/sdk'
import { bash } from '@strands-agents/sdk/vended-tools/bash'

const agent = new Agent({
  tools: [bash],
})

// Variables persist across invocations within the same session
await agent.invoke('Run: export MY_VAR="hello"')
await agent.invoke('Run: echo $MY_VAR') // Will show "hello"

// Restart session to clear state
await agent.invoke('Restart the bash session')
await agent.invoke('Run: echo $MY_VAR') // Variable will be empty
```

Full API reference: [shell](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/shell/README.md), [bash (TypeScript only)](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/bash/README.md)

---

### Sleep

Pauses the agent for a bounded number of seconds. Cancelling the enclosing invocation aborts the sleep immediately rather than waiting for the full duration, so a long timer never ties up a session the caller has moved on from.

*Supported in: Node.js, modern browsers (TypeScript); all platforms (Python).*

The maximum duration is configurable at construction (default: 60 seconds) and cannot be raised by the model. Negative, `NaN`, infinite, non-numeric, and boolean durations are rejected at the tool boundary.

**Example:**

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { sleep } from '@strands-agents/sdk/vended-tools/sleep'

const agent = new Agent({
  tools: [sleep],
})
await agent.invoke('Pause for two seconds, then continue.')
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
from strands import Agent
from strands.vended_tools import sleep

agent = Agent(tools=[sleep])
agent("Pause for two seconds, then continue.")
```
(( /tab "Python" ))

**Custom maximum:**

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { makeSleep } from '@strands-agents/sdk/vended-tools/sleep'

const shortSleep = makeSleep({ maxDuration: 5 })
const agent = new Agent({ tools: [shortSleep] })
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
from strands import Agent
from strands.vended_tools import make_sleep

short_sleep = make_sleep(max_duration=5)
agent = Agent(tools=[short_sleep])
```
(( /tab "Python" ))

[Full API reference](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/sleep/README.md)

---

### Handoff to User

Lets the model pause the agent loop and surface a message to the user for human-in-the-loop input. Use this when the agent needs explicit confirmation, additional information, or user approval before proceeding.

*Supported in: Node.js, modern browsers (TypeScript); all platforms (Python).*

Bidirectional streaming not supported

`handoff_to_user` relies on the interrupt/resume mechanism, which requires the agent loop to fully halt and restart. It cannot be used inside bidirectional streaming sessions, where the loop runs continuously without a clean pause point.

The loop halts with a `stop_reason` / `stopReason` of `"interrupt"` and the message is available on the interrupt’s `reason` field in `AgentResult.interrupts`. Resume the agent by passing back an `interruptResponse` content block with the interrupt ID and the user’s reply; the tool then returns that reply as its result and the model continues. To recognize a handoff interrupt, match its `name` against the exported `HANDOFF_INTERRUPT_NAME` constant.

Combining with HumanInTheLoop

`HumanInTheLoop()` requires approval for every tool by default, so pairing it with `handoff_to_user` prompts the user twice — once to approve the call, then again to answer it. Allow-list the tool with `HumanInTheLoop(allowed_tools=["handoff_to_user"])` / `new HumanInTheLoop({ allowedTools: ["handoff_to_user"] })` so only the handoff itself prompts.

**Example:**

(( tab "TypeScript" ))
```typescript
import { Agent, InterruptResponseContent } from '@strands-agents/sdk'
import { handoffToUser, HANDOFF_INTERRUPT_NAME } from '@strands-agents/sdk/vended-tools/handoff-to-user'

const agent = new Agent({
  tools: [handoffToUser],
  systemPrompt:
    'Before deleting any files, call handoff_to_user to confirm with the user.',
})

let result = await agent.invoke('Delete all .tmp files in /workspace.')
const interrupt = result.interrupts?.find((i) => i.name === HANDOFF_INTERRUPT_NAME)
if (interrupt) {
  console.log(interrupt.reason)
  result = await agent.invoke([
    new InterruptResponseContent({ interruptId: interrupt.id, response: 'confirmed' }),
  ])
}
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
from strands import Agent
from strands.vended_tools.handoff_to_user import HANDOFF_INTERRUPT_NAME, handoff_to_user

agent = Agent(
    tools=[handoff_to_user],
    system_prompt=(
        "Before deleting any files, call handoff_to_user to confirm with the user."
    ),
)

result = agent("Delete all .tmp files in /workspace.")
interrupt = next(i for i in (result.interrupts or []) if i.name == HANDOFF_INTERRUPT_NAME)
print(interrupt.reason)

resumed = agent([
    {
        "interruptResponse": {
            "interruptId": interrupt.id,
            "response": "confirmed",
        }
    }
])
```
(( /tab "Python" ))

📖 [Full API Reference](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/handoff-to-user/README.md)

---

### Stop (experimental)

> This tool is experimental and subject to change in future revisions without notice.

Lets the model gracefully end the agent loop with an optional final message. The default loop already terminates when the model returns without any tool call; the stop tool is useful when you want an explicit “I am done” affordance, when a workflow enforces that termination is a deliberate model decision, or when a sub-agent needs to signal completion back to a coordinator via the loop’s last assistant message.

*Supported in: Node.js, modern browsers (TypeScript); all platforms (Python).*

This is a cooperative stop, not an abort. Any other tools the model requested in the same turn still run to completion; the loop halts after that batch without calling the model again. The final message defaults to a 4096-character cap; pass `max_message_length` / `maxMessageLength` to `make_stop` / `makeStop` when a longer summary is legitimate.

The two SDKs shim onto different loop-termination primitives, which produces a small difference in the final `AgentResult`. TypeScript halts via `AfterToolsEvent.endTurn` and returns `stopReason: "endTurn"` with the stop text as the last assistant message. Python halts via `invocation_state["request_state"]["stop_event_loop"]` and returns `stop_reason: "tool_use"` with the model’s tool-use message as the final message; the stop text lives in history as the tool result, not as a new assistant turn.

**Example:**

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { stop } from '@strands-agents/sdk/experimental/vended-tools/stop'

const agent = new Agent({
  tools: [stop],
  systemPrompt: 'Complete the task. Call stop with a short summary when you are done.',
})
await agent.invoke('Summarize the changes in ./CHANGELOG.md')
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
from strands import Agent
from strands.experimental.tools import stop

agent = Agent(
    tools=[stop],
    system_prompt="Complete the task. Call stop with a short summary when you are done.",
)
result = agent("Summarize the changes in ./CHANGELOG.md")
```
(( /tab "Python" ))

[Full API reference](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/experimental/vended-tools/stop/README.md)

---

### Web fetch

Fetches an HTTP(S) URL and returns its content. Two modes are available, configured at construction time via `make_web_fetch` / `makeWebFetch`:

-   **`agentic`** (default): HTML is converted to markdown and passed to an analyst agent that answers a `prompt`, so the full page never enters the main agent’s context. Use when targeted answers are needed about potentially large pages.
-   **`markdown`**: HTML is converted to clean markdown with scripts, styles, and noise stripped. Use when the agent needs full pages for reasoning.

The `max_bytes` / `maxBytes` parameter caps the HTTP response size (default 5 MiB); `max_content_chars` / `maxContentChars` caps the extracted content delivered to the model or analyst (default 50,000 characters). For `mode='agentic'` / `mode: 'agentic'`, the factory also accepts a `model` for the analyst; the agent’s own model is used when none is supplied.

The Python tool delegates all networking to an `httpx.AsyncClient`. Use the `make_web_fetch` factory to supply a pre-configured client with custom timeouts, redirects, proxies, or caching.

*Supported in: Node.js (TypeScript); Python (all platforms).*

Install required

(( tab "Python" ))
`web_fetch` requires the optional `web-fetch` extra:

```bash
pip install 'strands-agents[web-fetch]'
```
(( /tab "Python" ))

(( tab "TypeScript" ))
HTML conversion requires the optional `turndown` peer dependency:

```bash
npm install turndown
```
(( /tab "TypeScript" ))

Security posture

Web fetch accepts only `http://` and `https://` URLs and caps response bodies at 5 MiB by default. Egress control belongs at the layer that encapsulates the agent (a sandbox, microVM, or network policy) where it can be enforced consistently across all tools, including `shell`.

**Example:**

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { webFetch } from '@strands-agents/sdk/vended-tools/web-fetch'

const agent = new Agent({ tools: [webFetch] })
await agent.invoke('Summarize https://example.com/blog/post')
```

Reading the full page as markdown:

```typescript
import { Agent } from '@strands-agents/sdk'
import { makeWebFetch } from '@strands-agents/sdk/vended-tools/web-fetch'

const webFetch = makeWebFetch({ mode: 'markdown' })
const agent = new Agent({ tools: [webFetch] })
await agent.invoke('Read https://example.com/docs and explain the architecture')
```

Tighter response cap with a dedicated analyst model:

```typescript
import { Agent } from '@strands-agents/sdk'
import { makeWebFetch } from '@strands-agents/sdk/vended-tools/web-fetch'
import { BedrockModel } from '@strands-agents/sdk/models/bedrock'

const webFetch = makeWebFetch({
  mode: 'agentic',
  maxBytes: 1 * 1024 * 1024,
  maxContentChars: 25_000,
  model: new BedrockModel({ modelId: 'us.amazon.nova-micro-v1:0' }),
})
const agent = new Agent({ tools: [webFetch] })
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
from strands import Agent
from strands.vended_tools import web_fetch

agent = Agent(tools=[web_fetch])
agent("What is the pricing for the enterprise plan at https://example.com/pricing")
```

Reading the full page as markdown:

```python
from strands import Agent
from strands.vended_tools import make_web_fetch

web_fetch = make_web_fetch(mode="markdown")
agent = Agent(tools=[web_fetch])
agent("Read https://example.com/docs and then explain the architecture")
```

Tighter response cap with a dedicated analyst model and custom transport:

```python
import httpx
from strands import Agent
from strands.models import BedrockModel
from strands.vended_tools import make_web_fetch

web_fetch = make_web_fetch(
    mode="agentic",
    client=httpx.AsyncClient(timeout=10.0),
    max_bytes=1 * 1024 * 1024,
    max_content_chars=25_000,
    model=BedrockModel(model_id="us.amazon.nova-micro-v1:0"),
)
agent = Agent(tools=[web_fetch])
```
(( /tab "Python" ))

📖 [Full API Reference](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/web-fetch/README.md)

---

### MCP Router

Lets your agent connect to Model Context Protocol servers at runtime, list the tools they expose, invoke one, and disconnect. The factory takes a developer-set allowlist of server configurations; the model can only initiate connections to servers on that list.

The tool exposes five commands: `connect` (opens a named connection to an allowlisted server using a `connection_id`), `list_connections` (returns all open connection IDs for the current agent), `list_tools` (returns the tools the server exposes), `call_tool` (invokes a tool by name), and `disconnect` (closes a connection).

Connections are scoped per agent and persist across invocations on the same agent instance. A connection is closed when the model calls `disconnect` explicitly, or when the agent is garbage collected. The connection remains open otherwise.

*Supported in: all platforms (Python).*

Security Warning

The allowlist controls which servers the model may connect to. For HTTP servers, treat this like any network request — egress control belongs at the encapsulation layer. For stdio servers, the allowlisted command is spawned as a local process with access to the host filesystem, environment variables, and network. Only allowlist commands you would run directly on the host.

**Example:**

(( tab "Python" ))
```python
from strands import Agent
from strands.vended_tools import make_mcp_router

mcp_router = make_mcp_router(
    servers={
        "files": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]},
        "my-api": {"url": "https://mcp.example.com/mcp"},
    },
    max_connections=5,
)
agent = Agent(tools=[mcp_router])
agent(
    "Connect to 'files', list its tools, "
    "call the read_file tool on /tmp/hello.txt, then disconnect."
)
```
(( /tab "Python" ))

### A2A Client

Lets your agent discover and communicate with remote [A2A (Agent-to-Agent) protocol](https://google.github.io/A2A/) agents. Two operations are available:

-   **`discover`** — fetches the agent card from a remote A2A endpoint and returns its capabilities, name, description, and skills.
-   **`send_message`** — sends a text message to a remote A2A agent and returns the response.

The tool is stateless: a fresh `A2AAgent` is created on every call using the `ClientConfig` configured for that endpoint. Use `make_a2a_client` to control which endpoints the model may contact, with per-endpoint authentication, and to tune size limits. Requires `pip install 'strands-agents[a2a]'`.

*Supported in: Python.*

Endpoint security

`allowed_endpoints` is required and checked before any network connection is made, but it only gates the agent-card fetch. `send_message` is delivered to the `url` in that card, which may point to a different host, and HTTP redirects are not checked either. For full egress control, enforce it at the network layer.

```python
import httpx
from a2a.client import ClientConfig
from strands import Agent
from strands.vended_tools import make_a2a_client

a2a_client = make_a2a_client(
    allowed_endpoints={
        "https://agent.example.com": None,
        "https://researcher.example.com": ClientConfig(
            httpx_client=httpx.AsyncClient(
                headers={"Authorization": "Bearer your-token"},
                timeout=60.0,
            ),
        ),
    },
    max_bytes=1 * 1024 * 1024,
)
agent = Agent(tools=[a2a_client])
agent("What has the research agent found recently?")
```

---

## Using multiple tools together

Combine vended tools in one agent to cover a multi-step workflow:

```typescript
import { Agent } from '@strands-agents/sdk'
import { bash } from '@strands-agents/sdk/vended-tools/bash'
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor'
import { notebook } from '@strands-agents/sdk/vended-tools/notebook'

const agent = new Agent({
  tools: [bash, fileEditor, notebook],
  systemPrompt: [
    'You are a software development assistant.',
    'When given a feature to implement:',
    '1. Use the notebook tool to create a plan with a checklist of steps',
    '2. Work through each step, checking them off as you go',
    '3. Use the bash tool to run tests and verify your changes',
  ].join('\n'),
})

// Agent plans the work, implements it, and tracks progress
await agent.invoke(
  'Add input validation to the createUser function in src/users.ts. ' +
    'It should reject empty names and invalid email formats.'
)
```

## Versioning & maintenance

Vended tools ship as part of the SDK and are updated alongside it. Report bugs and feature requests in the [GitHub repository](https://github.com/strands-agents/harness-sdk/issues).

Tool names are stable and will not change. In minor versions, a tool’s description, spec, or parameters may be updated to improve effectiveness. These changes are noted in SDK release notes. Pin your SDK version and test after upgrades if your workflows depend on specific tool behavior.

## See also

-   [Custom Tools](/docs/user-guide/sdk/tools/custom-tools/index.md): build your own tools
-   [Community Tools Package](/docs/user-guide/sdk/tools/community-tools-package/index.md): Python tools package with 30+ tools
-   [Session Management](/docs/user-guide/sdk/agents/session-management/index.md): persist agent state including notebooks
-   [Interrupts](/docs/user-guide/sdk/interrupts/index.md): implement approval workflows for sensitive operations
-   [Hooks](/docs/user-guide/sdk/agents/hooks/index.md): intercept and customize tool execution

## Related pages

- [Attach and invoke tools](/docs/user-guide/sdk/tools/using-tools/index.md) (1 shared tag)
- [Community tools package](/docs/user-guide/sdk/tools/community-tools-package/index.md) (1 shared tag)
- [Create custom tools](/docs/user-guide/sdk/tools/custom-tools/index.md) (1 shared tag)
- [Tool result format](/docs/user-guide/sdk/tools/tool-results/index.md) (1 shared tag)
- [Add tools to your agent](/docs/user-guide/sdk/tools/index.md) (1 shared tag)
- [Connect your agent to MCP tools](/docs/user-guide/sdk/tools/mcp-tools/index.md) (1 shared tag)
- [MCP Transports](/docs/user-guide/sdk/tools/mcp-transports/index.md) (1 shared tag)
- [Agents as tools](/docs/user-guide/sdk/multi-agent/agents-as-tools/index.md) (1 shared tag)
- [Agent Configuration](/docs/user-guide/sdk/experimental/agent-config/index.md) (1 shared tag)


## Implementation

### TypeScript

- [harness-sdk/strands-ts/src/vended-tools/file-editor/file-editor.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/file-editor/file-editor.ts)
- [harness-sdk/strands-ts/src/vended-tools/handoff-to-user/handoff-to-user.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/handoff-to-user/handoff-to-user.ts)
- [harness-sdk/strands-ts/src/vended-tools/bash/bash.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/bash/bash.ts)
- [harness-sdk/strands-ts/src/vended-tools/http-request/http-request.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/http-request/http-request.ts)
- [harness-sdk/strands-ts/src/vended-tools/notebook/notebook.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/notebook/notebook.ts)
- [harness-sdk/strands-ts/src/vended-tools/sleep/sleep.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/sleep/sleep.ts)
- [harness-sdk/strands-ts/src/vended-tools/web-fetch/web-fetch.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/web-fetch/web-fetch.ts)
- [harness-sdk/strands-ts/src/experimental/vended-tools/stop/stop.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/experimental/vended-tools/stop/stop.ts)

### Python

- [harness-sdk/strands-py/src/strands/vended_tools/handoff_to_user/handoff_to_user.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/handoff_to_user/handoff_to_user.py)
- [harness-sdk/strands-py/src/strands/vended_tools/http_request/http_request.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/http_request/http_request.py)
- [harness-sdk/strands-py/src/strands/vended_tools/notebook/notebook.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/notebook/notebook.py)
- [harness-sdk/strands-py/src/strands/vended_tools/mcp_router/mcp_router.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/mcp_router/mcp_router.py)
- [harness-sdk/strands-py/src/strands/vended_tools/shell/shell.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/shell/shell.py)
- [harness-sdk/strands-py/src/strands/vended_tools/sleep/sleep.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/sleep/sleep.py)
- [harness-sdk/strands-py/src/strands/vended_tools/web_fetch/web_fetch.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/web_fetch/web_fetch.py)
- [harness-sdk/strands-py/src/strands/vended_tools/a2a_client/a2a_client.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/a2a_client/a2a_client.py)
- [harness-sdk/strands-py/src/strands/experimental/tools/stop/stop.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/tools/stop/stop.py)
