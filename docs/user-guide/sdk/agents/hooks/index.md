To add logging, validation, guardrails, or custom logic at any point in the agent loop, use hooks. Hooks ship in the core Strands Agents SDK (`strands-agents` on PyPI, `@strands-agents/sdk` on npm): both built-in components and user code subscribe to events throughout the agent lifecycle and react to or modify agent behavior through strongly-typed event callbacks.

## Overview

Hooks are composable and type-safe, and every event type accepts multiple subscribers. A *hook event* marks a point in the agent lifecycle; a *hook callback* is the function you register to run when that event fires.

Hooks cover tasks such as:

-   Monitoring agent execution and tool usage
-   Modifying tool execution behavior
-   Adding validation and error handling
-   Monitoring multi-agent execution flow and node transitions
-   Debugging complex orchestration patterns
-   Implementing custom logging and metrics collection

## Basic Usage

You register a hook callback against an event type, and it receives a strongly-typed event object each time that event fires. Each event carries the data for its stage of the lifecycle: `BeforeInvocationEvent` includes the agent and request details, and `BeforeToolCallEvent` provides the tool and its parameters.

### Registering Individual Hook Callbacks

The simplest way to register a hook callback is using the `agent.add_hook()``agent.addHook()` method:

(( tab "Python" ))
```python
from strands import Agent
from strands.hooks import BeforeInvocationEvent, BeforeToolCallEvent

agent = Agent()

# Register individual callbacks
def my_callback(event: BeforeInvocationEvent) -> None:
    print("Custom callback triggered")

agent.add_hook(my_callback, BeforeInvocationEvent)

# Type inference: If your callback has a type hint, the event type is inferred
def typed_callback(event: BeforeToolCallEvent) -> None:
    print(f"Tool called: {event.tool_use['name']}")

agent.add_hook(typed_callback)  # Event type inferred from type hint
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const agent = new Agent()

// Register individual callback
const myCallback = (event: BeforeInvocationEvent) => {
  console.log('Custom callback triggered')
}

agent.addHook(BeforeInvocationEvent, myCallback)
```
(( /tab "TypeScript" ))

For multi-agent orchestrators, you can register callbacks for orchestration events:

(( tab "Python" ))
```python
# Create your orchestrator (Graph or Swarm)
orchestrator = Graph(...)

# Register individual callbacks
def my_callback(event: BeforeNodeCallEvent) -> None:
    print(f"Custom callback triggered")

orchestrator.hooks.add_callback(BeforeNodeCallEvent, my_callback)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const researcher = new Agent({
  id: 'researcher',
  systemPrompt: 'You are a research specialist.',
})
const writer = new Agent({
  id: 'writer',
  systemPrompt: 'You are a writing specialist.',
})

const graph = new Graph({
  nodes: [researcher, writer],
  edges: [['researcher', 'writer']],
})

// Register individual callbacks on the orchestrator
graph.addHook(BeforeNodeCallEvent, (event) => {
  console.log(`Node ${event.nodeId} starting`)
})

graph.addHook(AfterNodeCallEvent, (event) => {
  console.log(`Node ${event.nodeId} completed`)
})
```
(( /tab "TypeScript" ))

### Using Plugins for Multiple Hooks

For packaging multiple related hooks together, [Plugins](/docs/user-guide/sdk/plugins/index.md) provide a convenient way to bundle hooks with configuration and tools:

(( tab "Python" ))
```python
from strands import Agent
from strands.plugins import Plugin, hook
from strands.hooks import BeforeToolCallEvent, AfterToolCallEvent

class LoggingPlugin(Plugin):
    name = "logging-plugin"

    @hook
    def log_before(self, event: BeforeToolCallEvent) -> None:
        print(f"Calling: {event.tool_use['name']}")

    @hook
    def log_after(self, event: AfterToolCallEvent) -> None:
        print(f"Completed: {event.tool_use['name']}")

agent = Agent(plugins=[LoggingPlugin()])
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
class LoggingPlugin implements Plugin {
  name = 'logging-plugin'

  initAgent(agent: LocalAgent): void {
    agent.addHook(BeforeToolCallEvent, (event) => {
      console.log(`Calling: ${event.toolUse.name}`)
    })

    agent.addHook(AfterToolCallEvent, (event) => {
      console.log(`Completed: ${event.toolUse.name}`)
    })
  }
}

const agent = new Agent({ plugins: [new LoggingPlugin()] })
```
(( /tab "TypeScript" ))

See [Plugins](/docs/user-guide/sdk/plugins/index.md) for more information on creating and using plugins.

## Hook events

Hook events fire at defined points across the agent loop and, for orchestrators, across node execution. For the lifecycle diagrams, the full catalogue of event types, and the properties you can modify on each, see the [Hook events](/docs/user-guide/sdk/agents/hooks-events/index.md) reference.

## Callback Ordering

(( tab "Python" ))
By default, After event callbacks run in reverse registration order for cleanup symmetry. You can override this with explicit priority using the `order` option: lower values run first.

The SDK exports convenience presets that mark where the SDK’s own hooks run, so you can position yours relative to them:

-   `HookOrder.SDK_FIRST` (-100): where the SDK’s earliest hooks run
-   `HookOrder.DEFAULT` (0): implicit when no order is specified
-   `HookOrder.SDK_LAST` (100): where the SDK’s latest hooks run

These are not enforced bounds: any numeric value works. Use values beyond them (e.g. `SDK_FIRST - 1`) to run before or after the SDK’s hooks, or `float('-inf')`/`float('inf')` for guaranteed absolute ordering.

```python
from strands import Agent
from strands.hooks import BeforeModelCallEvent, HookOrder

agent = Agent()

def early_hook(event: BeforeModelCallEvent) -> None:
    print("I run first")

def late_hook(event: BeforeModelCallEvent) -> None:
    print("I run last")

agent.add_hook(early_hook, order=HookOrder.SDK_FIRST)
agent.add_hook(late_hook, order=HookOrder.SDK_LAST)
```

Within the same order group, Before events preserve registration order and After events reverse it.
(( /tab "Python" ))

(( tab "TypeScript" ))
By default, After event callbacks run in reverse registration order for cleanup symmetry. You can override this with explicit priority using the `order` option: lower values run first.

The SDK exports convenience presets that mark where the SDK’s own hooks run, so you can position yours relative to them:

-   `HookOrder.SDK_FIRST` (-100): where the SDK’s earliest hooks run
-   `HookOrder.DEFAULT` (0): implicit when no order is specified
-   `HookOrder.SDK_LAST` (100): where the SDK’s latest hooks run

These are not enforced bounds: any numeric value works. Use values beyond them (e.g. `SDK_FIRST - 1`) to run before or after the SDK’s hooks, or `-Infinity`/`Infinity` for guaranteed absolute ordering.

```typescript
import { Agent, HookOrder, BeforeToolCallEvent } from '@strands-agents/sdk'

const agent = new Agent()

agent.addHook(BeforeToolCallEvent, (event) => {
  console.log('[logging] Tool called:', event.toolUse.name)
}) // HookOrder.DEFAULT (0)

// Run before the SDK's earliest hooks
agent.addHook(
  BeforeToolCallEvent,
  (event) => {
    console.log('[guardrail] Runs before SDK hooks')
  },
  { order: HookOrder.SDK_FIRST - 1 }
)

// Arbitrary numbers for fine-grained control
agent.addHook(
  BeforeToolCallEvent,
  (event) => {
    console.log('[validation] Validating input')
  },
  { order: -50 }
)

// Use -Infinity/Infinity for guaranteed absolute first/last
agent.addHook(
  BeforeToolCallEvent,
  (event) => {
    console.log('[absolute] Always runs first, no matter what')
  },
  { order: -Infinity }
)
```

Within the same order group, Before events preserve registration order and After events reverse it.
(( /tab "TypeScript" ))

## Advanced Usage

### Accessing Invocation State in Hooks

Invocation state carries configuration and context data through the agent or orchestrator invocation. Reach for it when a hook needs to:

1.  **Access custom objects**: database client objects, connection pools, or other Python objects
2.  **Read request context**: session IDs, user information, settings, or request-specific data
3.  **Share state across a multi-agent run**: access state shared across all agents, see [Shared State Across Multi-Agent Patterns](/docs/user-guide/sdk/multi-agent/multi-agent-patterns/index.md#shared-state-across-multi-agent-patterns)
4.  **Pass custom parameters**: any additional data the hook needs

(( tab "Python" ))
```python
from strands.hooks import BeforeToolCallEvent
import logging

def log_with_context(event: BeforeToolCallEvent) -> None:
    """Log tool invocations with context from invocation state."""
    # Access invocation state from the event
    user_id = event.invocation_state.get("user_id", "unknown")
    session_id = event.invocation_state.get("session_id")

    # Access non-JSON serializable objects like database connections
    db_connection = event.invocation_state.get("database_connection")
    logger_instance = event.invocation_state.get("custom_logger")

    # Use custom logger if provided, otherwise use default
    logger = logger_instance if logger_instance else logging.getLogger(__name__)

    logger.info(
        f"User {user_id} in session {session_id} "
        f"invoking tool: {event.tool_use['name']} "
        f"with DB connection: {db_connection is not None}"
    )

# Register the hook
agent = Agent(tools=[my_tool])
agent.hooks.add_callback(BeforeToolCallEvent, log_with_context)

# Execute with context including non-serializable objects
import sqlite3
custom_logger = logging.getLogger("custom")
db_conn = sqlite3.connect(":memory:")

result = agent(
    "Process the data",
    user_id="user123",
    session_id="sess456",
    database_connection=db_conn,  # Non-JSON serializable object
    custom_logger=custom_logger   # Non-JSON serializable object
)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const agent = new Agent()

agent.addHook(BeforeToolCallEvent, (event) => {
  // Read caller-provided context
  const userId = event.invocationState.userId as string | undefined
  const sessionId = event.invocationState.sessionId as string | undefined

  console.log(
    `User ${userId} (session ${sessionId}) ` + `invoking tool: ${event.toolUse.name}`
  )
})

// Pass invocation state when invoking the agent
const result = await agent.invoke('Process the data', {
  invocationState: {
    userId: 'user123',
    sessionId: 'sess456',
  },
})

// The same object is returned on the result
console.log(result.invocationState.userId) // 'user123'
```
(( /tab "TypeScript" ))

Multi-agent hook events provide access to:

(( tab "Python" ))
-   **source**: The multi-agent orchestrator instance (for example: Graph/Swarm)
-   **node\_id**: Identifier of the node being executed (for node-level events)
-   **invocation\_state**: Configuration and context data passed through the orchestrator invocation
(( /tab "Python" ))

(( tab "TypeScript" ))
-   **orchestrator**: The multi-agent orchestrator instance (for example: Graph/Swarm)
-   **nodeId**: Identifier of the node being executed (for node-level events)
-   **state**: The `MultiAgentState` for the current invocation, including an `app` field for custom consumer state
(( /tab "TypeScript" ))

### Tool Interception

Modify or replace tools before execution:

(( tab "Python" ))
```python
class ToolInterceptor(HookProvider):
    def register_hooks(self, registry: HookRegistry) -> None:
        registry.add_callback(BeforeToolCallEvent, self.intercept_tool)

    def intercept_tool(self, event: BeforeToolCallEvent) -> None:
        if event.tool_use.name == "sensitive_tool":
            # Replace with a safer alternative
            event.selected_tool = self.safe_alternative_tool
            event.tool_use["name"] = "safe_tool"
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import {
  BeforeToolCallEvent,
  type LocalAgent,
  type Plugin,
  type FunctionTool,
} from '@strands-agents/sdk'

class ToolInterceptor implements Plugin {
  name = 'tool-interceptor'

  constructor(private readonly safeAlternative: FunctionTool) {}

  initAgent(agent: LocalAgent): void {
    agent.addHook(BeforeToolCallEvent, (event) => this.interceptTool(event))
  }

  private interceptTool(event: BeforeToolCallEvent): void {
    if (event.toolUse.name !== 'sensitive_tool') return
    // Run a safer tool in place of the registry's match for this call.
    event.selectedTool = this.safeAlternative
    // Mirror the rename on toolUse so the model sees the substitution.
    event.toolUse.name = this.safeAlternative.name
  }
}
```
(( /tab "TypeScript" ))

### Invocation Message Modification

To sanitize input before it enters conversation history, modify the `messages` property on `BeforeInvocationEvent`. The SDK normalizes the current invocation input before the event runs. Changes made by the hook become the input appended to history and sent to the model.

(( tab "Python" ))
```python
from strands import Agent
from strands.hooks import BeforeInvocationEvent

agent = Agent()

def redact_input(event: BeforeInvocationEvent) -> None:
    if not event.messages:
        return

    event.messages[-1]["content"] = [{"text": "[REDACTED]"}]

agent.add_hook(redact_input, BeforeInvocationEvent)
agent("Contact me at user@example.com")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent, BeforeInvocationEvent, TextBlock } from '@strands-agents/sdk'

const agent = new Agent()

agent.addHook(BeforeInvocationEvent, (event) => {
  const latestMessage = event.messages.at(-1)
  if (latestMessage?.role !== 'user') return

  latestMessage.content.splice(
    0,
    latestMessage.content.length,
    new TextBlock('[REDACTED]')
  )
})

await agent.invoke('Contact me at user@example.com')
```

The live event exposes `messages`, but `toJSON()` omits them.
(( /tab "TypeScript" ))

Assign a new collection to `event.messages` to replace the input. Assign an empty collection to remove the input from the invocation.

### Result Modification

Modify tool results after execution:

(( tab "Python" ))
```python
class ResultProcessor(HookProvider):
    def register_hooks(self, registry: HookRegistry) -> None:
        registry.add_callback(AfterToolCallEvent, self.process_result)

    def process_result(self, event: AfterToolCallEvent) -> None:
        if event.tool_use.name == "calculator":
            # Add formatting to calculator results
            original_content = event.result["content"][0]["text"]
            event.result["content"][0]["text"] = f"Result: {original_content}"
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import {
  AfterToolCallEvent,
  ToolResultBlock,
  TextBlock,
  type LocalAgent,
  type Plugin,
} from '@strands-agents/sdk'

class ResultProcessor implements Plugin {
  name = 'result-processor'

  initAgent(agent: LocalAgent): void {
    agent.addHook(AfterToolCallEvent, (event) => this.processResult(event))
  }

  private processResult(event: AfterToolCallEvent): void {
    if (event.toolUse.name !== 'calculator') return

    // Prefix calculator output before it propagates to the model.
    event.result = new ToolResultBlock({
      toolUseId: event.result.toolUseId,
      status: event.result.status,
      content: event.result.content.map((block) =>
        block.type === 'textBlock' ? new TextBlock(`Result: ${block.text}`) : block
      ),
      ...(event.result.error !== undefined ? { error: event.result.error } : {}),
    })
  }
}
```
(( /tab "TypeScript" ))

### Conditional Node Execution

Implement custom logic to modify orchestration behavior in multi-agent systems:

(( tab "Python" ))
```python
class ConditionalExecutionHook(HookProvider):
    def __init__(self, skip_conditions: dict[str, callable]):
        self.skip_conditions = skip_conditions

    def register_hooks(self, registry: HookRegistry) -> None:
        registry.add_callback(BeforeNodeCallEvent, self.check_execution_conditions)

    def check_execution_conditions(self, event: BeforeNodeCallEvent) -> None:
        node_id = event.node_id
        if node_id in self.skip_conditions:
            condition_func = self.skip_conditions[node_id]
            if condition_func(event.invocation_state):
                print(f"Skipping node {node_id} due to condition")
                # Note: Actual node skipping would require orchestrator-specific implementation
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const researcher = new Agent({
  id: 'researcher',
  systemPrompt: 'You are a research specialist.',
})
const writer = new Agent({
  id: 'writer',
  systemPrompt: 'You are a writing specialist.',
})
const reviewer = new Agent({
  id: 'reviewer',
  systemPrompt: 'You are a review specialist.',
})

const graph = new Graph({
  nodes: [researcher, writer, reviewer],
  edges: [
    ['researcher', 'writer'],
    ['writer', 'reviewer'],
  ],
})

// Cancel specific nodes based on custom conditions
graph.addHook(BeforeNodeCallEvent, (event) => {
  if (event.nodeId === 'reviewer') {
    // Cancel with a custom message
    event.cancel = 'Skipping review for this run'
  }
})
```
(( /tab "TypeScript" ))

## Best Practices

### Composability

Design hooks to be composable and reusable:

(( tab "Python" ))
```python
class RequestLoggingHook(HookProvider):
    def register_hooks(self, registry: HookRegistry) -> None:
        registry.add_callback(BeforeInvocationEvent, self.log_request)
        registry.add_callback(AfterInvocationEvent, self.log_response)
        registry.add_callback(BeforeToolCallEvent, self.log_tool_use)

    ...
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
class RequestLoggingHook implements Plugin {
  name = 'request-logging'

  initAgent(agent: LocalAgent): void {
    agent.addHook(BeforeInvocationEvent, (ev) => this.logRequest(ev))
    agent.addHook(AfterInvocationEvent, (ev) => this.logResponse(ev))
    agent.addHook(BeforeToolCallEvent, (ev) => this.logToolUse(ev))
  }

  // ...
```
(( /tab "TypeScript" ))

### Event Property Modifications

When modifying event properties, log the changes for debugging and audit purposes:

(( tab "Python" ))
```python
class ResultProcessor(HookProvider):
    def register_hooks(self, registry: HookRegistry) -> None:
        registry.add_callback(AfterToolCallEvent, self.process_result)

    def process_result(self, event: AfterToolCallEvent) -> None:
        if event.tool_use.name == "calculator":
            original_content = event.result["content"][0]["text"]
            logger.info(f"Modifying calculator result: {original_content}")
            event.result["content"][0]["text"] = f"Result: {original_content}"
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import {
  AfterToolCallEvent,
  ToolResultBlock,
  TextBlock,
  type LocalAgent,
  type Plugin,
} from '@strands-agents/sdk'

class ResultProcessor implements Plugin {
  name = 'result-processor'

  initAgent(agent: LocalAgent): void {
    agent.addHook(AfterToolCallEvent, (event) => this.processResult(event))
  }

  private processResult(event: AfterToolCallEvent): void {
    if (event.toolUse.name !== 'calculator') return

    const original = event.result.content.find((block) => block.type === 'textBlock')
    if (original?.type !== 'textBlock') return

    // Log the change before mutating so the audit trail captures both states.
    console.log(`Modifying calculator result: ${original.text}`)
    event.result = new ToolResultBlock({
      toolUseId: event.result.toolUseId,
      status: event.result.status,
      content: event.result.content.map((block) =>
        block.type === 'textBlock' ? new TextBlock(`Result: ${block.text}`) : block
      ),
      ...(event.result.error !== undefined ? { error: event.result.error } : {}),
    })
  }
}
```
(( /tab "TypeScript" ))

### Orchestrator-Agnostic Design

Design multi-agent hooks to work with different orchestrator types:

(( tab "Python" ))
```python
class UniversalMultiAgentHook(HookProvider):
    def register_hooks(self, registry: HookRegistry) -> None:
        registry.add_callback(BeforeNodeCallEvent, self.handle_node_execution)

    def handle_node_execution(self, event: BeforeNodeCallEvent) -> None:
        orchestrator_type = type(event.source).__name__
        print(f"Executing node {event.node_id} in {orchestrator_type} orchestrator")

        # Handle orchestrator-specific logic if needed
        if orchestrator_type == "Graph":
            self.handle_graph_node(event)
        elif orchestrator_type == "Swarm":
            self.handle_swarm_node(event)

    def handle_graph_node(self, event: BeforeNodeCallEvent) -> None:
        # Graph-specific handling
        pass

    def handle_swarm_node(self, event: BeforeNodeCallEvent) -> None:
        # Swarm-specific handling
        pass
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
class UniversalMultiAgentPlugin implements MultiAgentPlugin {
  readonly name = 'universal-multi-agent'

  initMultiAgent(orchestrator: MultiAgent): void {
    orchestrator.addHook(BeforeNodeCallEvent, (event) => {
      console.log(`Executing node ${event.nodeId} in ${orchestrator.id} orchestrator`)

      // Handle orchestrator-specific logic if needed
      if (orchestrator instanceof Graph) {
        this.handleGraphNode(event)
      } else if (orchestrator instanceof Swarm) {
        this.handleSwarmNode(event)
      }
    })
  }

  private handleGraphNode(event: BeforeNodeCallEvent): void {
    // Graph-specific handling
  }

  private handleSwarmNode(event: BeforeNodeCallEvent): void {
    // Swarm-specific handling
  }
}
```
(( /tab "TypeScript" ))

## Integration with Multi-Agent Systems

Multi-agent hooks complement single-agent hooks. Individual agents within the orchestrator can still have their own hooks, creating a layered monitoring and customization system:

(( tab "Python" ))
```python
# Single-agent hook for individual agents
class AgentLevelHook(HookProvider):
    def register_hooks(self, registry: HookRegistry) -> None:
        registry.add_callback(BeforeToolCallEvent, self.log_tool_use)

    def log_tool_use(self, event: BeforeToolCallEvent) -> None:
        print(f"Agent tool call: {event.tool_use['name']}")

# Multi-agent hook for orchestrator
class OrchestratorLevelHook(HookProvider):
    def register_hooks(self, registry: HookRegistry) -> None:
        registry.add_callback(BeforeNodeCallEvent, self.log_node_execution)

    def log_node_execution(self, event: BeforeNodeCallEvent) -> None:
        print(f"Orchestrator node execution: {event.node_id}")

# Create agents with individual hooks
agent1 = Agent(tools=[tool1], hooks=[AgentLevelHook()])
agent2 = Agent(tools=[tool2], hooks=[AgentLevelHook()])

# Create orchestrator with multi-agent hooks
orchestrator = Graph(
    agents={"agent1": agent1, "agent2": agent2},
    hooks=[OrchestratorLevelHook()]
)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
// Agent-level hooks via plugins
class AgentLoggingPlugin implements Plugin {
  name = 'agent-logging'

  initAgent(agent: LocalAgent): void {
    agent.addHook(BeforeToolCallEvent, (event) => {
      console.log(`Agent tool call: ${event.toolUse.name}`)
    })
  }
}

// Create agents with individual hooks
const agent1 = new Agent({ id: 'agent1', plugins: [new AgentLoggingPlugin()] })
const agent2 = new Agent({ id: 'agent2', plugins: [new AgentLoggingPlugin()] })

// Orchestrator-level hooks via MultiAgentPlugin
class OrchestratorLoggingPlugin implements MultiAgentPlugin {
  readonly name = 'orchestrator-logging'

  initMultiAgent(orchestrator: MultiAgent): void {
    orchestrator.addHook(BeforeNodeCallEvent, (event) => {
      console.log(`Orchestrator node execution: ${event.nodeId}`)
    })
  }
}

// Create orchestrator with multi-agent hooks
const graph = new Graph({
  nodes: [agent1, agent2],
  edges: [['agent1', 'agent2']],
  plugins: [new OrchestratorLoggingPlugin()],
})
```
(( /tab "TypeScript" ))

Layering the two gives you observability and control at both levels: individual agent execution and orchestrator coordination.

## Cookbook

Practical hook implementations for common tasks.

### Fixed Tool Arguments

Useful for enforcing security policies, maintaining consistency, or overriding agent decisions with system-level requirements. This hook ensures specific tools always use predetermined parameter values regardless of what the agent specifies.

(( tab "Python" ))
```python
from typing import Any
from strands.hooks import HookProvider, HookRegistry, BeforeToolCallEvent

class ConstantToolArguments(HookProvider):
    """Use constant argument values for specific parameters of a tool."""

    def __init__(self, fixed_tool_arguments: dict[str, dict[str, Any]]):
        """
        Initialize fixed parameter values for tools.

        Args:
            fixed_tool_arguments: A dictionary mapping tool names to dictionaries of
                parameter names and their fixed values. These values will override any
                values provided by the agent when the tool is invoked.
        """
        self._tools_to_fix = fixed_tool_arguments

    def register_hooks(self, registry: HookRegistry, **kwargs: Any) -> None:
        registry.add_callback(BeforeToolCallEvent, self._fix_tool_arguments)

    def _fix_tool_arguments(self, event: BeforeToolCallEvent):
        # If the tool is in our list of parameters, then use those parameters
        if parameters_to_fix := self._tools_to_fix.get(event.tool_use["name"]):
            tool_input: dict[str, Any] = event.tool_use["input"]
            tool_input.update(parameters_to_fix)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
class ConstantToolArguments implements Plugin {
  private fixedToolArguments: Record<string, Record<string, unknown>>

  /**
   * Initialize fixed parameter values for tools.
   *
   * @param fixedToolArguments - A dictionary mapping tool names to dictionaries of
   *     parameter names and their fixed values. These values will override any
   *     values provided by the agent when the tool is invoked.
   */
  constructor(fixedToolArguments: Record<string, Record<string, unknown>>) {
    this.fixedToolArguments = fixedToolArguments
  }

  name = 'constant-tool-arguments'

  initAgent(agent: LocalAgent): void {
    agent.addHook(BeforeToolCallEvent, (ev) => this.fixToolArguments(ev))
  }

  private fixToolArguments(event: BeforeToolCallEvent): void {
    // If the tool is in our list of parameters, then use those parameters
    const parametersToFix = this.fixedToolArguments[event.toolUse.name]
    if (parametersToFix) {
      const toolInput = event.toolUse.input as Record<string, unknown>
      Object.assign(toolInput, parametersToFix)
    }
  }
}
```
(( /tab "TypeScript" ))

For example, to always force the `calculator` tool to use precision of 1 digit:

(( tab "Python" ))
```python
fix_parameters = ConstantToolArguments({
    "calculator": {
        "precision": 1,
    }
})

agent = Agent(tools=[calculator], hooks=[fix_parameters])
result = agent("What is 2 / 3?")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const fixParameters = new ConstantToolArguments({
  calculator: {
    precision: 1,
  },
})

const agent = new Agent({ tools: [calculator], plugins: [fixParameters] })
const result = await agent.invoke('What is 2 / 3?')
```
(( /tab "TypeScript" ))

### Limit Tool Counts

Useful for preventing runaway tool usage, implementing rate limiting, or enforcing usage quotas. This hook tracks tool invocations per request and replaces tools with error messages when limits are exceeded.

(( tab "Python" ))
```python
from strands import tool
from strands.hooks import HookRegistry, HookProvider, BeforeToolCallEvent, BeforeInvocationEvent
from threading import Lock

class LimitToolCounts(HookProvider):
    """Limits the number of times tools can be called per agent invocation"""

    def __init__(self, max_tool_counts: dict[str, int]):
        """
        Initializer.

        Args:
            max_tool_counts: A dictionary mapping tool names to max call counts for
                tools. If a tool is not specified in it, the tool can be called as many
                times as desired
        """
        self.max_tool_counts = max_tool_counts
        self.tool_counts = {}
        self._lock = Lock()

    def register_hooks(self, registry: HookRegistry) -> None:
        registry.add_callback(BeforeInvocationEvent, self.reset_counts)
        registry.add_callback(BeforeToolCallEvent, self.intercept_tool)

    def reset_counts(self, event: BeforeInvocationEvent) -> None:
        with self._lock:
            self.tool_counts = {}

    def intercept_tool(self, event: BeforeToolCallEvent) -> None:
        tool_name = event.tool_use["name"]
        with self._lock:
            max_tool_count = self.max_tool_counts.get(tool_name)
            tool_count = self.tool_counts.get(tool_name, 0) + 1
            self.tool_counts[tool_name] = tool_count

        if max_tool_count and tool_count > max_tool_count:
            event.cancel_tool = (
                f"Tool '{tool_name}' has been invoked too many and is now being throttled. "
                f"DO NOT CALL THIS TOOL ANYMORE "
            )
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
class LimitToolCounts implements Plugin {
  private maxToolCounts: Record<string, number>
  private toolCounts: Record<string, number> = {}

  /**
   * Initialize with maximum allowed invocations per tool.
   *
   * @param maxToolCounts - A dictionary mapping tool names to their maximum
   *     allowed invocation counts per agent invocation.
   */
  constructor(maxToolCounts: Record<string, number>) {
    this.maxToolCounts = maxToolCounts
  }

  name = 'limit-tool-counts'

  initAgent(agent: LocalAgent): void {
    agent.addHook(BeforeInvocationEvent, () => this.resetCounts())
    agent.addHook(BeforeToolCallEvent, (event) => this.interceptTool(event))
  }

  private resetCounts(): void {
    this.toolCounts = {}
  }

  private interceptTool(event: BeforeToolCallEvent): void {
    const toolName = event.toolUse.name
    const maxToolCount = this.maxToolCounts[toolName]
    const toolCount = (this.toolCounts[toolName] ?? 0) + 1
    this.toolCounts[toolName] = toolCount

    if (maxToolCount !== undefined && toolCount > maxToolCount) {
      event.cancel =
        `Tool '${toolName}' has been invoked too many times and is now being throttled. ` +
        `DO NOT CALL THIS TOOL ANYMORE`
    }
  }
}
```
(( /tab "TypeScript" ))

For example, to limit the `sleep` tool to 3 invocations per invocation:

(( tab "Python" ))
```python
limit_hook = LimitToolCounts(max_tool_counts={"sleep": 3})

agent = Agent(tools=[sleep], hooks=[limit_hook])

# This call will only have 3 successful sleeps
agent("Sleep 5 times for 10ms each or until you can't anymore")
# This will sleep successfully again because the count resets every invocation
agent("Sleep once")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const limitPlugin = new LimitToolCounts({ sleep: 3 })

const agent = new Agent({ tools: [sleep], plugins: [limitPlugin] })

// This call will only have 3 successful sleeps
await agent.invoke("Sleep 5 times for 10ms each or until you can't anymore")
// This will sleep successfully again because the count resets every invocation
await agent.invoke('Sleep once')
```
(( /tab "TypeScript" ))

### Model Call Retry

Useful for implementing custom retry logic for model invocations. The `AfterModelCallEvent.retry` field allows hooks to request retries based on any criteria: exceptions, response validation, content quality checks, or custom logic. This example retries on exceptions with exponential backoff:

(( tab "Python" ))
```python
import asyncio
import logging
from strands.hooks import HookProvider, HookRegistry, BeforeInvocationEvent, AfterModelCallEvent

logger = logging.getLogger(__name__)

class RetryOnServiceUnavailable(HookProvider):
    """Retry model calls when ServiceUnavailable errors occur."""

    def __init__(self, max_retries: int = 3):
        self.max_retries = max_retries
        self.retry_count = 0

    def register_hooks(self, registry: HookRegistry) -> None:
        registry.add_callback(BeforeInvocationEvent, self.reset_counts)
        registry.add_callback(AfterModelCallEvent, self.handle_retry)

    def reset_counts(self, event: BeforeInvocationEvent = None) -> None:
        self.retry_count = 0

    async def handle_retry(self, event: AfterModelCallEvent) -> None:
        if event.exception:
            if "ServiceUnavailable" in str(event.exception):
                logger.info("ServiceUnavailable encountered")
                if self.retry_count < self.max_retries:
                    logger.info("Retrying model call")
                    self.retry_count += 1
                    event.retry = True
                    await asyncio.sleep(2 ** self.retry_count)  # Exponential backoff
        else:
            # Reset counts on successful call
            self.reset_counts()
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
class RetryOnServiceUnavailable implements Plugin {
  name = 'retry-on-service-unavailable'

  constructor(private readonly maxRetries = 3) {}

  initAgent(agent: LocalAgent): void {
    agent.addHook(AfterModelCallEvent, (event) => this.handleRetry(event))
  }

  private handleRetry(event: AfterModelCallEvent): void {
    // `attemptCount` is 1-indexed and includes the attempt that just failed,
    // so no manual counter is needed to cap retries.
    if (
      event.error !== undefined &&
      event.error.message.includes('ServiceUnavailable') &&
      event.attemptCount <= this.maxRetries
    ) {
      event.retry = true
    }
  }
}
```
(( /tab "TypeScript" ))

For example, to retry up to 3 times on service unavailable errors:

(( tab "Python" ))
```python
from strands import Agent

retry_hook = RetryOnServiceUnavailable(max_retries=3)
agent = Agent(hooks=[retry_hook])

result = agent("What is the capital of France?")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const agent = new Agent({ plugins: [new RetryOnServiceUnavailable(3)] })

const result = await agent.invoke('What is the capital of France?')
```
(( /tab "TypeScript" ))

### Exception Handling

When a tool raises an exception, the agent converts it to an error result and returns it to the model, allowing the model to adjust its approach and retry. This works well for expected errors like validation failures, but for unexpected errors (assertion failures, configuration errors, or bugs) you may want to fail immediately rather than let the model retry futilely. The `exception` property on `AfterToolCallEvent` provides access to the original exception, enabling hooks to inspect error types and selectively propagate those that shouldn’t be retried:

(( tab "Python" ))
```python
class PropagateUnexpectedExceptions(HookProvider):
    """Re-raise unexpected exceptions instead of returning them to the model."""

    def __init__(self, allowed_exceptions: tuple[type[Exception], ...] = (ValueError,)):
        self.allowed_exceptions = allowed_exceptions

    def register_hooks(self, registry: HookRegistry) -> None:
        registry.add_callback(AfterToolCallEvent, self._check_exception)

    def _check_exception(self, event: AfterToolCallEvent) -> None:
        if event.exception is None:
            return  # Tool succeeded
        if isinstance(event.exception, self.allowed_exceptions):
            return  # Let model retry these
        raise event.exception  # Propagate unexpected errors
```

```python
# Usage
agent = Agent(
    model=model,
    tools=[my_tool],
    hooks=[PropagateUnexpectedExceptions(allowed_exceptions=(ValueError, ValidationError))],
)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```ts
// This feature is not yet available in TypeScript SDK
```
(( /tab "TypeScript" ))

### Tool Call Retry

Useful for implementing custom retry logic for tool invocations. The `AfterToolCallEvent.retry` field allows hooks to request that a tool be re-executed: for example, to handle transient errors, timeouts, or flaky external services. When `retry` is set to `True`, the tool executor discards the current result and invokes the tool again with the same `tool_use_id`.

Streaming behavior

When a tool call is retried, intermediate streaming events (`ToolStreamEvent`) from discarded attempts will have already been emitted to callers. Only the final attempt’s `ToolResultEvent` is emitted and added to conversation history. Callers consuming streamed events should be prepared to handle events from discarded attempts.

(( tab "Python" ))
```python
import logging
from strands.hooks import HookProvider, HookRegistry, AfterToolCallEvent

logger = logging.getLogger(__name__)

class RetryOnToolError(HookProvider):
    """Retry tool calls that fail with errors."""

    def __init__(self, max_retries: int = 1):
        self.max_retries = max_retries
        self._attempt_counts: dict[str, int] = {}

    def register_hooks(self, registry: HookRegistry) -> None:
        registry.add_callback(AfterToolCallEvent, self.handle_retry)

    def handle_retry(self, event: AfterToolCallEvent) -> None:
        tool_use_id = str(event.tool_use.get("toolUseId", ""))
        tool_name = event.tool_use.get("name", "unknown")

        # Track attempts per tool_use_id
        attempt = self._attempt_counts.get(tool_use_id, 0) + 1
        self._attempt_counts[tool_use_id] = attempt

        if event.result.get("status") == "error" and attempt <= self.max_retries:
            logger.info(f"Retrying tool '{tool_name}' (attempt {attempt}/{self.max_retries})")
            event.retry = True
        elif event.result.get("status") != "error":
            # Clean up tracking on success
            self._attempt_counts.pop(tool_use_id, None)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
class RetryOnToolError implements Plugin {
  name = 'retry-on-tool-error'

  private readonly attempts = new Map<string, number>()

  constructor(private readonly maxRetries = 1) {}

  initAgent(agent: LocalAgent): void {
    agent.addHook(AfterToolCallEvent, (event) => this.handleRetry(event))
  }

  private handleRetry(event: AfterToolCallEvent): void {
    const toolUseId = event.result.toolUseId
    const attempt = (this.attempts.get(toolUseId) ?? 0) + 1
    this.attempts.set(toolUseId, attempt)

    if (event.error !== undefined && attempt <= this.maxRetries) {
      event.retry = true
    } else if (event.error === undefined) {
      // Clean up tracking once the tool call finally succeeds.
      this.attempts.delete(toolUseId)
    }
  }
}
```
(( /tab "TypeScript" ))

For example, to retry failed tool calls once:

(( tab "Python" ))
```python
from strands import Agent, tool

@tool
def flaky_api_call(query: str) -> str:
    """Call an external API that sometimes fails.

    Args:
        query: The query to send.
    """
    import random
    if random.random() < 0.5:
        raise RuntimeError("Service temporarily unavailable")
    return f"Result for: {query}"

retry_hook = RetryOnToolError(max_retries=1)
agent = Agent(tools=[flaky_api_call], hooks=[retry_hook])

result = agent("Look up the weather")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const agent = new Agent({ plugins: [new RetryOnToolError(1)] })

const result = await agent.invoke('Fetch the latest metrics')
```
(( /tab "TypeScript" ))

### Invocation resume

The `AfterInvocationEvent.resume` property enables a hook to trigger a follow-up agent invocation after the current one completes. When you set `resume` to any valid agent input (a string, content blocks, or messages), the agent automatically re-invokes itself with that input instead of returning to the caller. This starts a full new invocation cycle, including firing `BeforeInvocationEvent`.

This is useful for building autonomous looping patterns where the agent continues processing based on its previous result: for example, re-evaluating after tool execution, injecting additional context, or implementing multi-step workflows within a single call.

Resume input types

The `resume` value accepts any valid `AgentInput`: a string, a list of content blocks, a list of messages, or interrupt responses. When the agent is in an interrupt state, you must provide interrupt responses (not a plain string) to resume correctly.

The following example checks the agent result and triggers one follow-up invocation to ask the model to summarize its work:

(( tab "Python" ))
```python
from strands import Agent
from strands.hooks import AfterInvocationEvent

resume_count = 0

async def summarize_after_tools(event: AfterInvocationEvent):
    """Resume once to ask the model to summarize its work."""
    global resume_count
    if resume_count == 0 and event.result and event.result.stop_reason == "end_turn":
        resume_count += 1
        event.resume = "Now summarize what you just did in one sentence."

agent = Agent()
agent.add_hook(summarize_after_tools)

# The agent processes the initial request, then automatically
# performs a second invocation to generate the summary
result = agent("Look up the weather in Seattle")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent, AfterInvocationEvent } from '@strands-agents/sdk'

let resumeCount = 0

const agent = new Agent({})
agent.addHook(AfterInvocationEvent, (event) => {
  // Resume once after a clean turn to ask the model for a one-line summary.
  if (resumeCount === 0) {
    resumeCount += 1
    event.resume = 'Now summarize what you just did in one sentence.'
  }
})

const result = await agent.invoke('Look up the weather in Seattle')
```
(( /tab "TypeScript" ))

You can also use `resume` to chain multiple re-invocations. Make sure to include a termination condition to avoid infinite loops:

(( tab "Python" ))
```python
from strands import Agent
from strands.hooks import AfterInvocationEvent

MAX_ITERATIONS = 3
iteration = 0

async def iterative_refinement(event: AfterInvocationEvent):
    """Re-invoke the agent up to MAX_ITERATIONS times for iterative refinement."""
    global iteration
    if iteration < MAX_ITERATIONS and event.result:
        iteration += 1
        event.resume = f"Review your previous response and improve it. Iteration {iteration} of {MAX_ITERATIONS}."

agent = Agent()
agent.add_hook(iterative_refinement)

result = agent("Draft a haiku about programming")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent, AfterInvocationEvent } from '@strands-agents/sdk'

const MAX_ITERATIONS = 3
let iteration = 0

const agent = new Agent({})
agent.addHook(AfterInvocationEvent, (event) => {
  if (iteration >= MAX_ITERATIONS) return
  iteration += 1
  event.resume = `Review your previous response and improve it. Iteration ${iteration} of ${MAX_ITERATIONS}.`
})

const result = await agent.invoke('Draft a haiku about programming')
```
(( /tab "TypeScript" ))

#### Handling interrupts with resume

The `resume` property integrates with the [interrupt](/docs/user-guide/sdk/tools/index.md) system. When an agent invocation ends because of an interrupt, a hook can automatically handle the interrupt by resuming with interrupt responses. This avoids returning the interrupt to the caller.

When the agent is in an interrupt state, you must resume with a list of `interruptResponse` objects. Passing a plain string raises a `TypeError`.

(( tab "Python" ))
```python
from strands import Agent, tool
from strands.hooks import AfterInvocationEvent, BeforeToolCallEvent

@tool
def send_email(to: str, body: str) -> str:
    """Send an email.

    Args:
        to: Recipient address.
        body: Email body.
    """
    return f"Email sent to {to}"

def require_approval(event: BeforeToolCallEvent):
    """Interrupt before sending emails to require approval."""
    if event.tool_use["name"] == "send_email":
        event.interrupt("email_approval", reason="Approve this email?")

async def auto_approve(event: AfterInvocationEvent):
    """Automatically approve all interrupted tool calls."""
    if event.result and event.result.stop_reason == "interrupt":
        responses = [
            {"interruptResponse": {"interruptId": intr.id, "response": "approved"}}
            for intr in event.result.interrupts
        ]
        event.resume = responses

agent = Agent(tools=[send_email])
agent.add_hook(require_approval)
agent.add_hook(auto_approve)

# The interrupt is handled automatically by the hook,
# so the caller receives the final result directly
result = agent("Send an email to alice@example.com saying hello")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import {
  Agent,
  AfterInvocationEvent,
  BeforeToolCallEvent,
  InterruptEvent,
} from '@strands-agents/sdk'
import type { Interrupt } from '@strands-agents/sdk'

const agent = new Agent({ tools: [] })

// Track interrupts as they fire so AfterInvocationEvent can build resume input.
const pendingInterrupts: Interrupt[] = []

agent.addHook(BeforeToolCallEvent, (event) => {
  if (event.toolUse.name === 'send_email') {
    event.interrupt({ name: 'email_approval', reason: 'Approve this email?' })
  }
})

agent.addHook(InterruptEvent, (event) => {
  pendingInterrupts.push(event.interrupt)
})

agent.addHook(AfterInvocationEvent, (event) => {
  if (pendingInterrupts.length === 0) return
  // Auto-approve every interrupted tool call so the caller never sees the interrupt.
  event.resume = pendingInterrupts.map((interrupt) => ({
    interruptResponse: {
      interruptId: interrupt.id,
      response: 'approved',
    },
  }))
  pendingInterrupts.length = 0
})

const result = await agent.invoke('Send an email to alice@example.com saying hello')
```
(( /tab "TypeScript" ))

## HookProvider Protocol

For advanced use cases, you can implement the `HookProvider` protocol to create objects that register multiple callbacks at once. This is useful when building reusable hook collections without the full plugin infrastructure:

(( tab "Python" ))
```python
from strands.hooks import HookProvider, HookRegistry, BeforeInvocationEvent, AfterInvocationEvent

class RequestLogger(HookProvider):
    def register_hooks(self, registry: HookRegistry) -> None:
        registry.add_callback(BeforeInvocationEvent, self.log_start)
        registry.add_callback(AfterInvocationEvent, self.log_end)

    def log_start(self, event: BeforeInvocationEvent) -> None:
        print(f"Request started for agent: {event.agent.name}")

    def log_end(self, event: AfterInvocationEvent) -> None:
        print(f"Request completed for agent: {event.agent.name}")

# Pass via hooks parameter
agent = Agent(hooks=[RequestLogger()])

# Or add after creation
agent.hooks.add_hook(RequestLogger())
```

For most use cases, [Plugins](/docs/user-guide/sdk/plugins/index.md) provide a more convenient way to bundle multiple hooks with additional features like auto-discovery and tool registration.
(( /tab "Python" ))

(( tab "TypeScript" ))
TypeScript SDK

The TypeScript SDK does not export a `HookProvider` interface. Instead, use the [Plugin](/docs/user-guide/sdk/plugins/index.md) class to bundle multiple hooks together. The `Plugin` class provides `initAgent()` for registering hooks and `getTools()` for providing tools.

```typescript
class LoggingPlugin implements Plugin {
  name = 'logging-plugin'

  initAgent(agent: LocalAgent): void {
    agent.addHook(BeforeToolCallEvent, (event) => {
      console.log(`Calling: ${event.toolUse.name}`)
    })

    agent.addHook(AfterToolCallEvent, (event) => {
      console.log(`Completed: ${event.toolUse.name}`)
    })
  }
}

const agent = new Agent({ plugins: [new LoggingPlugin()] })
```
(( /tab "TypeScript" ))

## Related pages

- [Agent Loop](/docs/user-guide/sdk/agents/agent-loop/index.md) (3 shared tags)
- [Hook events](/docs/user-guide/sdk/agents/hooks-events/index.md) (3 shared tags)
- [Interrupts](/docs/user-guide/sdk/interrupts/index.md) (3 shared tags)
- [Steering](/docs/user-guide/sdk/agents/interventions/steering/index.md) (3 shared tags)
- [Interventions](/docs/user-guide/sdk/agents/interventions/index.md) (3 shared tags)
- [Build a custom plugin](/docs/user-guide/sdk/plugins/custom-plugins/index.md) (2 shared tags)
- [Plugins](/docs/user-guide/sdk/plugins/index.md) (2 shared tags)
- [Middleware](/docs/user-guide/sdk/agents/middleware/index.md) (2 shared tags)
- [Tool Executors](/docs/user-guide/sdk/tools/executors/index.md) (2 shared tags)
- [GoalLoop](/docs/user-guide/sdk/plugins/goal-loop/index.md) (2 shared tags)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/hooks/events.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/hooks/events.py)
- [harness-sdk/strands-py/src/strands/hooks/registry.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/hooks/registry.py)

### TypeScript

- [harness-sdk/strands-ts/src/hooks/events.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts)
- [harness-sdk/strands-ts/src/hooks/registry.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/registry.ts)
