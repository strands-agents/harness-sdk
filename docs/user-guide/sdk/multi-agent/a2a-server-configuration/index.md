Once you have an A2A server running (see [Agent-to-Agent (A2A) Protocol](/docs/user-guide/sdk/multi-agent/agent-to-agent/index.md#creating-an-a2a-server)), this page is the reference for tuning it: every constructor option, the custom task stores and request-handler components you can plug in, and path-based mounting for deployments behind a load balancer.

## Server Configuration Options

(( tab "Python" ))
The `A2AServer` constructor accepts several configuration options:

-   `agent_factory`: Callable that takes a `context_id` and returns a fresh agent per context (recommended)
-   `agent`: A single Strands agent reused across contexts (deprecated; prefer `agent_factory`)
-   `max_contexts`: Maximum number of per context agents to retain concurrently (default: 1000, must be at least 1)
-   `host`: Hostname or IP address to bind to (default: “127.0.0.1”)
-   `port`: Port to bind to (default: 9000)
-   `version`: Version of the agent (default: “0.0.1”)
-   `skills`: Custom list of agent skills (default: auto-generated from tools)
-   `http_url`: Public HTTP URL where this agent will be accessible (optional, enables path-based mounting)
-   `serve_at_root`: Forces server to serve at root path regardless of http\_url path (default: False)
-   `task_store`: Custom task storage implementation (defaults to InMemoryTaskStore)
-   `queue_manager`: Custom message queue management (optional)
-   `push_config_store`: Custom push notification configuration storage (optional)
-   `push_sender`: Custom push notification sender implementation (optional)
-   `enable_a2a_compliant_streaming`: Streams responses as A2A artifact updates when `True` (default: `False`). The default uses legacy status-update streaming and emits a warning; set this to `True` to conform to the A2A spec. It becomes the default in the next major version.

Provide exactly one of `agent_factory` or `agent`, recommend `agent_factory`.
(( /tab "Python" ))

(( tab "TypeScript" ))
The TypeScript SDK provides two server classes:

-   **`A2AServer`**: Base class that manages the agent card and request handler. Use this when integrating with your own HTTP framework.
-   **`A2AExpressServer`**: Express based server with `serve()` and `createMiddleware()` methods.

The `A2AExpressServer` constructor accepts a config object:

-   `agentFactory`: Callable that takes a `contextId` and returns a fresh agent per context (recommended)
-   `agent`: A single Strands Agent reused across contexts (deprecated; prefer `agentFactory`)
-   `maxContexts`: Maximum number of per context agents to retain concurrently (default: 1000, must be at least 1)
-   `name` (required): Human-readable name for the agent
-   `description`: Description of the agent’s purpose
-   `host`: Host to bind the server to (default: `'127.0.0.1'`)
-   `port`: Port to listen on (default: `9000`)
-   `version`: Version string for the agent card (default: `'0.0.1'`)
-   `httpUrl`: Public URL override for the agent card
-   `skills`: Skills to advertise in the agent card
-   `taskStore`: Task store for persisting task state (defaults to InMemoryTaskStore)
-   `userBuilder`: User builder for authentication (default: no authentication)

Provide exactly one of `agentFactory` or `agent`, recommend `agentFactory`.

```typescript
const server = new A2AExpressServer({
  agentFactory: (contextId) =>
    new Agent({
      systemPrompt: 'You are a helpful agent.',
    }),
  name: 'My Agent',
  description: 'A helpful agent',
  // Retain at most 1000 per context agents; evict least recently used
  maxContexts: 1000,
  host: '0.0.0.0',
  port: 8080,
  version: '1.0.0',
  httpUrl: 'https://my-agent.example.com', // Public URL override
  skills: [
    { id: 'math', name: 'Math', description: 'Performs calculations', tags: [] },
  ],
})

await server.serve()
```
(( /tab "TypeScript" ))

## Advanced Server Customization

(( tab "Python" ))
The `A2AServer` provides access to the underlying FastAPI or Starlette application objects allowing you to further customize server behavior.

```python
from contextlib import asynccontextmanager
from strands import Agent
from strands.multiagent.a2a import A2AServer
import uvicorn

# Create your agent factory and A2A server
def create_agent(context_id: str) -> Agent:
    return Agent(name="My Agent", description="A customizable agent", callback_handler=None)

a2a_server = A2AServer(agent_factory=create_agent)

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifespan with proper error handling."""
    # Startup tasks
    yield  # Application runs here
    # Shutdown tasks

# Access the underlying FastAPI app
# Allows passing keyword arguments to FastAPI constructor for further customization
fastapi_app = a2a_server.to_fastapi_app(app_kwargs={"lifespan": lifespan})
# Add custom middleware, routes, or configuration
fastapi_app.add_middleware(...)

# Or access the Starlette app
# Allows passing keyword arguments to FastAPI constructor for further customization
starlette_app = a2a_server.to_starlette_app(app_kwargs={"lifespan": lifespan})
# Customize as needed

# You can then serve the customized app directly
uvicorn.run(fastapi_app, host="127.0.0.1", port=9000)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
The `A2AExpressServer` exposes a `createMiddleware()` method that returns an Express Router, which you can mount in your own Express app:

```typescript
const express = (await import('express')).default

const server = new A2AExpressServer({
  agentFactory: (contextId) =>
    new Agent({ systemPrompt: 'You are a customizable agent.' }),
  name: 'My Agent',
  description: 'A customizable agent',
})

// Get the A2A middleware as an Express Router
const a2aRouter = server.createMiddleware()

// Create your own Express app with custom routes/middleware
const app = express()
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})
app.use(a2aRouter)

app.listen(9000, '127.0.0.1', () => {
  console.log('Server listening on http://127.0.0.1:9000')
})
```

You can also use an `AbortSignal` for graceful shutdown:

```typescript
const server = new A2AExpressServer({
  agentFactory: (contextId) => new Agent({ systemPrompt: 'You are a helpful agent.' }),
  name: 'My Agent',
})

const controller = new AbortController()
await server.serve({ signal: controller.signal })

// Later, to stop the server:
controller.abort()
```
(( /tab "TypeScript" ))

### Configurable Request Handler Components

(( tab "Python" ))
The `A2AServer` supports configurable request handler components for advanced customization:

```python
from strands import Agent
from strands.multiagent.a2a import A2AServer
from a2a.server.tasks import TaskStore, PushNotificationConfigStore, PushNotificationSender
from a2a.server.events import QueueManager

# Custom task storage implementation
class CustomTaskStore(TaskStore):
    # Implementation details...
    pass

# Custom queue manager
class CustomQueueManager(QueueManager):
    # Implementation details...
    pass

# Create an agent factory with custom components
def create_agent(context_id: str) -> Agent:
    return Agent(name="My Agent", description="A customizable agent", callback_handler=None)

a2a_server = A2AServer(
    agent_factory=create_agent,
    task_store=CustomTaskStore(),
    queue_manager=CustomQueueManager(),
    push_config_store=MyPushConfigStore(),
    push_sender=MyPushSender()
)
```

**Interface Requirements:**

Custom implementations must follow these interfaces:

-   `task_store`: Must implement `TaskStore` interface from `a2a.server.tasks`
-   `queue_manager`: Must implement `QueueManager` interface from `a2a.server.events`
-   `push_config_store`: Must implement `PushNotificationConfigStore` interface from `a2a.server.tasks`
-   `push_sender`: Must implement `PushNotificationSender` interface from `a2a.server.tasks`
(( /tab "Python" ))

(( tab "TypeScript" ))
The TypeScript `A2AExpressServer` supports a custom `taskStore` for persisting task state:

```typescript
import { Agent } from '@strands-agents/sdk'
import { A2AExpressServer } from '@strands-agents/sdk/a2a/express'

const server = new A2AExpressServer({
  agentFactory: (contextId) => new Agent({ systemPrompt: 'You are a helpful agent.' }),
  name: 'My Agent',
  taskStore: myCustomTaskStore, // Must implement TaskStore from @a2a-js/sdk/server
})
```
(( /tab "TypeScript" ))

### Path-Based Mounting for Containerized Deployments

(( tab "Python" ))
The `A2AServer` supports automatic path-based mounting for deployment scenarios involving load balancers or reverse proxies. This allows you to deploy agents behind load balancers with different path prefixes.

```python
from strands import Agent
from strands.multiagent.a2a import A2AServer

# Create an agent factory
def create_agent(context_id: str) -> Agent:
    return Agent(
        name="Calculator Agent",
        description="A calculator agent",
        callback_handler=None
    )

# Deploy with path-based mounting
# The agent will be accessible at http://my-alb.amazonaws.com/calculator/
a2a_server = A2AServer(
    agent_factory=create_agent,
    http_url="http://my-alb.amazonaws.com/calculator"
)

# For load balancers that strip path prefixes, use serve_at_root=True
a2a_server_with_root = A2AServer(
    agent_factory=create_agent,
    http_url="http://my-alb.amazonaws.com/calculator",
    serve_at_root=True  # Serves at root even though URL has /calculator path
)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
Use the `httpUrl` option to set the public URL for the agent card. For custom path mounting, use `createMiddleware()` and mount the router at any path in your Express app:

```typescript
import { Agent } from '@strands-agents/sdk'
import { A2AExpressServer } from '@strands-agents/sdk/a2a/express'

const server = new A2AExpressServer({
  agentFactory: (contextId) => new Agent({ systemPrompt: 'A calculator agent.' }),
  name: 'Calculator Agent',
  httpUrl: 'http://my-alb.amazonaws.com/calculator',
})

const express = (await import('express')).default
const app = express()
app.use('/calculator', server.createMiddleware())
app.listen(9000)
```
(( /tab "TypeScript" ))

## Related pages

- [Agent-to-Agent (A2A) Protocol](/docs/user-guide/sdk/multi-agent/agent-to-agent/index.md) (1 shared tag)
- [Build a sequential workflow](/docs/user-guide/sdk/multi-agent/workflow/index.md) (1 shared tag)
- [Choose a multi-agent pattern](/docs/user-guide/sdk/multi-agent/multi-agent-patterns/index.md) (1 shared tag)
- [Graph Components](/docs/user-guide/sdk/multi-agent/graph-components/index.md) (1 shared tag)
- [Graph Multi-Agent Pattern](/docs/user-guide/sdk/multi-agent/graph/index.md) (1 shared tag)
- [Swarm Multi-Agent Pattern](/docs/user-guide/sdk/multi-agent/swarm/index.md) (1 shared tag)
- [Agents as tools](/docs/user-guide/sdk/multi-agent/agents-as-tools/index.md) (1 shared tag)
- [Interrupts in Multi-Agent Systems](/docs/user-guide/sdk/interrupts-multi-agent/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/multiagent/a2a/server.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/a2a/server.py)
- [harness-sdk/strands-py/src/strands/multiagent/a2a/executor.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/a2a/executor.py)

### TypeScript

- [harness-sdk/strands-ts/src/a2a/server.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/a2a/server.ts)
- [harness-sdk/strands-ts/src/a2a/express-server.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/a2a/express-server.ts)
