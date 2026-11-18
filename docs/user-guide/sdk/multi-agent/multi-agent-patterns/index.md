This page is a decision guide. Start by asking whether you need more than one agent at all, map the work your prompts already do onto a pattern, then grow into a supervised orchestrator that enforces deadlines, cancellation, and an approval gate. Each step adds only the coordination the previous one lacked.

## Do you need more than one agent?

Most tasks do not. A single agent with the right tools is simpler to build, cheaper to run, and easier to debug than any multi-agent setup. Reach for a second agent only when one of these is true:

-   **One prompt is doing too much.** A single system prompt juggling research, analysis, and review tends to blur the roles and degrade each one. Splitting them into focused agents keeps each prompt sharp.
-   **You need isolated context.** A specialist should not see the orchestrator’s full history, or two sub-tasks should not pollute each other’s context window.
-   **You want independent iteration.** Different owners, models, or tool sets per role, tuned and tested on their own.

If none of these apply, stop here and give one agent more tools. If one does, the smallest step up is to let that one agent call another agent as a tool.

### Start with the smallest step: an agent as a tool

The simplest multi-agent pattern passes one agent to another as a tool. The orchestrator reads each specialist’s description and calls it when the query fits, exactly as it would call any other tool. No new orchestration primitive, just one more tool in the array.

(( tab "Python" ))
```python
from strands import Agent

# A specialized agent, passed directly to an orchestrator's tools
weather_agent = Agent(
    name="weather_agent",
    description="Answers questions about the weather.",
    system_prompt="You are a weather specialist.",
)

# The orchestrator calls the specialist when the query fits
orchestrator = Agent(
    system_prompt=(
        "Route weather questions to weather_agent; answer the rest yourself."
    ),
    tools=[weather_agent],
)

orchestrator("What should I pack for Seattle this weekend?")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'

// A specialized agent, passed directly to an orchestrator's tools
const weatherAgent = new Agent({
  name: 'weather_agent',
  description: 'Answers questions about the weather.',
  systemPrompt: 'You are a weather specialist.',
  printer: false,
})

// The orchestrator calls the specialist when the query fits
const orchestrator = new Agent({
  systemPrompt: 'Route weather questions to weather_agent; answer the rest yourself.',
  tools: [weatherAgent],
})

await orchestrator.invoke('What should I pack for Seattle this weekend?')
```
(( /tab "TypeScript" ))

When one orchestrator calling specialists on demand is no longer enough (when the *order* of the work matters, or the agents need to hand off among themselves), reach for an orchestrator.

## Map the work to a pattern

The patterns differ in one thing above all: **how the path of execution is determined.** The quickest way to choose is to match the pattern to the shape of work your prompts already describe. Most agent prompts move through some mix of three phases: **research** (gather), **analysis** (reason), and **review** (check). Each pattern expresses that shape differently.

| Pattern | How the path is decided | Research → analysis → review shape it fits |
| --- | --- | --- |
| **[Agents as tools](/docs/user-guide/sdk/multi-agent/agents-as-tools/index.md)** | The orchestrator LLM picks a specialist per query. | One agent delegates a research or analysis sub-question to an expert, then folds the answer back in. |
| **[Workflow in your code](/docs/user-guide/sdk/multi-agent/workflow/index.md)** | Your application calls agents in a defined order and passes results between them. | Research, analysis, and review always run in the same sequence. Your code handles failures and decides whether to continue. |
| **[Graph](/docs/user-guide/sdk/multi-agent/graph/index.md)** | Developer-defined edges. Unconditional edges are always followed; a conditional edge is followed only when your predicate, which can inspect model output or app state, returns true. Fixed, parallel, and cyclic flows. | Research feeds analysis feeds review as a fixed chain, or a conditional edge loops the work back for another pass when the review’s verdict is a rejection (Python and TypeScript resolve nodes with several incoming edges differently; see [Graph](/docs/user-guide/sdk/multi-agent/graph/index.md#sdk-differences)). |
| **[Swarm](/docs/user-guide/sdk/multi-agent/swarm/index.md)** | Emergent. Agents hand off autonomously through shared context, with no fixed path. | A research, analysis, and review team that reorders itself; review can hand straight back to research. |

[Agents as tools](../agents-as-tools/index.md)One orchestrator delegates to specialist agents it calls like any other tool. Start here.

[Workflow in your code](../workflow/index.md)Call agents in a defined order and pass each result to the next step. Your application owns the coordination.

[Graph](../graph/index.md)Agents as nodes joined by edges you define: fixed, parallel, or conditional on your own predicates, with loops.

[Swarm](../swarm/index.md)A pool of specialized agents that autonomously hand off tasks to one another.

[Agent-to-Agent (A2A)](../agent-to-agent/index.md)Connect agents running as separate services over the Agent-to-Agent protocol.

### How they compare in depth

Graph and Swarm are SDK orchestrators. A workflow is a pattern you implement with ordinary application code: call an agent, use its result, and decide what runs next. Each approach gives a different part of your system control over the work.

To let an agent design and execute a task graph through a tool call, give it the [vended `graph` tool](/docs/user-guide/sdk/tools/vended-tools/graph/index.md). The model supplies nodes and dependency edges on each call; the tool builds and runs the graph. Use the Graph SDK API when you want to define the nodes and edges yourself.

| Dimension | Graph | Swarm | Workflow in your code |
| --- | --- | --- | --- |
| Core concept | Agents as nodes joined by developer-defined edges; optional conditions route on model output or app state. | A team that autonomously hands off tasks. | Agent calls coordinated by your application. |
| Who defines the path | Developer defines nodes, edges, and edge conditions up front. | Developer provides a pool; agents decide. | Your application defines which agent to call next. |
| Execution flow | Follows the edges: fixed chains, parallel branches, or conditional routes. | Sequential and autonomous. | Follows your application logic; you schedule any parallel work. |
| Cycles | Yes. | Yes. | Use loops in your application code. |
| State sharing | Shared state object all nodes read and write. | Shared context and working memory. | Your code passes results between agents. |
| Error handling | A conditional edge can route on a result a node returns, such as a validator’s verdict. Execution errors are not routed to another node. In Python, a node exception raises from the graph call and ends the run. In TypeScript, the failed node records `FAILED`, its downstream nodes do not run, and parallel branches continue. Timeouts end the run in both (see [Graph](/docs/user-guide/sdk/multi-agent/graph/index.md)). | Agents can hand off to an error specialist; handoff limits and timeouts stop runaway loops by ending the run. | Your code catches errors and decides whether to retry, stop, or continue. There is no separate orchestrator status to inspect. |

The sections below give one or two concrete triggers for each.

#### Reach for a Graph

When you want to own the execution path in code: a fixed sequence, parallel branches, or conditional routes and loops. Unconditional edges run every time; conditional edges let the next step depend on what the current one returned.

-   **Interactive support routing**: branch a conversation on user intent (“order question” vs. “address change” vs. “needs a human”).
-   **Validation with a rejection path**: an agent validates data, and conditional edges that read its verdict route the data to a processing node or a rejection-handling node. This routes on a returned result. An exception raised while a node runs is never routed: in Python it ends the run, and in TypeScript the node records `FAILED` and its downstream nodes do not run.

#### Reach for a Swarm

When the problem benefits from several specialized perspectives handing off to one another. A `Swarm` suits exploration, brainstorming, or synthesizing sources through collaborative handoffs.

-   **Incident response**: a monitoring agent detects an issue and hands off to a network specialist, who diagnoses a database problem and hands off to a DBA.
-   **Software build**: a researcher hands to an architect, to a coder, to a reviewer. The path emerges from the work.

#### Write a workflow in your own code

When the steps are known and a sequence of agent calls is enough, keep the coordination in your application. Pass each result to the next agent and use your language’s error handling to decide what happens if a step fails.

-   **Report generation**: extract facts from supplied notes, analyze them, and pass the analysis to a writer.
-   **Review before continuing**: inspect an agent’s result in your code and decide whether to call the next agent or ask the user for input.

See [Build a sequential workflow](/docs/user-guide/sdk/multi-agent/workflow/index.md) for an example. When the flow needs dependencies across parallel branches or conditional edges, define a [Graph](/docs/user-guide/sdk/multi-agent/graph/index.md).

#### Let an agent build a graph with the vended tool

When the agent should break a request into sub-tasks, give it the [vended `graph` tool](/docs/user-guide/sdk/tools/vended-tools/graph/index.md). For example, it can create one node per document to analyze them in parallel, then connect those nodes to a writer that combines their results.

The tool accepts an acyclic graph: nodes without dependencies can start in parallel, and downstream nodes receive their upstream outputs. Unlike a Graph you define in code, its nodes and edges come from the model’s tool input. Configure the tool to limit the graph’s size and control the models, tools, and instructions available to its nodes. Use the Graph SDK API for cycles or conditional edges.

## Grow into a supervised orchestrator

A bare orchestrator does the routing but enforces nothing. Production systems need guardrails: a node that hangs must be stopped, a cancellation must propagate instead of leaving work half-done, high-impact steps must pause for a human, and every handoff must be recorded for audit.

The example below is one supervisor Graph that layers all four onto the research → analysis → review shape:

1.  **Per-node and overall deadlines** so a slow node fails the run instead of stalling it.
2.  **Cancellation with a recorded reason** so denying a step stops it before it runs and records why.
3.  **An approval gate** that interrupts before the one high-impact node and waits for a human `y/N`.
4.  **Handoff logging through a hook** so every node transition is recorded.

(( tab "Python" ))
```python
from strands import Agent
from strands.hooks import BeforeNodeCallEvent, HookProvider, HookRegistry
from strands.multiagent import GraphBuilder, Status


class SupervisorHook(HookProvider):
    """Logs every handoff and gates the one high-impact node for approval."""

    def __init__(self, app_name: str, gated_node: str) -> None:
        self.app_name = app_name
        self.gated_node = gated_node

    def register_hooks(self, registry: HookRegistry) -> None:
        registry.add_callback(BeforeNodeCallEvent, self.on_node)

    def on_node(self, event: BeforeNodeCallEvent) -> None:
        # 4. Record every handoff: BeforeNodeCallEvent fires before each node runs.
        print(f"[handoff] -> {event.node_id}")

        # 3. Approval gate: pause before the one high-impact node and wait
        #    for a human.
        if event.node_id != self.gated_node:
            return

        approval = event.interrupt(
            f"{self.app_name}-approval",
            reason={"node": event.node_id},
        )
        if approval.strip().lower() != "y":
            # 2. Propagate cancellation: deny the node with a recorded reason
            #    instead of letting it run.
            event.cancel_node = f"Human denied the {event.node_id} step"


researcher = Agent(
    name="researcher",
    system_prompt="You gather sources.",
    callback_handler=None,
)
analyst = Agent(
    name="analyst",
    system_prompt="You analyze the research.",
    callback_handler=None,
)
reviewer = Agent(
    name="reviewer",
    system_prompt="You approve or reject the analysis.",
    callback_handler=None,
)

builder = GraphBuilder()
builder.add_node(researcher, "research")
builder.add_node(analyst, "analysis")
builder.add_node(reviewer, "review")
builder.add_edge("research", "analysis")
builder.add_edge("analysis", "review")
builder.set_entry_point("research")

# 1. Per-node and overall deadlines. A node that exceeds its timeout raises an
#    Exception from the graph call (not caught by the RuntimeError handler
#    below); the execution timeout is checked before each batch of nodes and
#    ends the run with Status.FAILED.
builder.set_node_timeout(60)        # each node must finish within 60s
builder.set_execution_timeout(300)  # the whole graph within 5 minutes

# Gate the high-impact "review" node behind human approval.
builder.set_hook_providers([SupervisorHook("myapp", gated_node="review")])

graph = builder.build()

# Interrupt/resume loop: the graph pauses at the approval gate and resumes
# only after the human answers.
try:
    result = graph("Research, analyze, and review the Q4 incident")
    while result.status == Status.INTERRUPTED:
        responses = []
        for interrupt in result.interrupts:
            if interrupt.name == "myapp-approval":
                node = interrupt.reason["node"]
                answer = input(f"Approve the {node} step? (y/N): ")
                responses.append({
                    "interruptResponse": {
                        "interruptId": interrupt.id,
                        "response": answer,
                    },
                })
        result = graph(responses)
except RuntimeError as error:
    # 2. A cancelled node raises with its recorded reason and the run ends FAILED.
    print(f"Stopped: {error} (status: {graph.state.status})")
else:
    print(f"Status: {result.status}")
    print(f"Execution order: {[node.node_id for node in result.execution_order]}")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { Agent } from '@strands-agents/sdk'
import type { InterruptResponseContentData } from '@strands-agents/sdk'
import {
  BeforeNodeCallEvent,
  Graph,
  NodeCancelEvent,
  Status,
} from '@strands-agents/sdk/multiagent'

const researcher = new Agent({
  id: 'research',
  systemPrompt: 'You gather sources.',
  printer: false,
})
const analyst = new Agent({
  id: 'analysis',
  systemPrompt: 'You analyze the research.',
  printer: false,
})
const reviewer = new Agent({
  id: 'review',
  systemPrompt: 'You approve or reject the analysis.',
  printer: false,
})

const graph = new Graph({
  nodes: [researcher, analyst, reviewer],
  edges: [
    ['research', 'analysis'],
    ['analysis', 'review'],
  ],
  // 1. Per-node and overall deadlines; exceeding either makes invoke() throw.
  nodeTimeout: 60_000, // each node must finish within 60s
  timeout: 300_000, // the whole graph within 5 minutes
})

const gatedNode = 'review'

// 2. The cancellation reason is recorded on NodeCancelEvent.
graph.addHook(NodeCancelEvent, (event) => {
  console.log(`[cancelled] ${event.nodeId}: ${event.message}`)
})

graph.addHook(BeforeNodeCallEvent, (event) => {
  // 4. Record every handoff: the hook fires before each node runs.
  console.log(`[handoff] -> ${event.nodeId}`)

  // 3. Approval gate: pause before the one high-impact node.
  if (event.nodeId !== gatedNode) return

  const approval = event.interrupt<string>({
    name: 'myapp-approval',
    reason: { node: event.nodeId },
  })
  if (approval.trim().toLowerCase() !== 'y') {
    // 2. Cancel the node before it runs, with a recorded reason.
    event.cancel = `Human denied the ${event.nodeId} step`
  }
})

// Interrupt/resume loop: the graph pauses at the approval gate and resumes
// only after the human answers.
let result = await graph.invoke('Research, analyze, and review the Q4 incident')
while (result.status === Status.INTERRUPTED) {
  const responses: InterruptResponseContentData[] = []
  const prompt = createInterface({ input: stdin, output: stdout })
  try {
    for (const interrupt of result.interrupts ?? []) {
      if (interrupt.name !== 'myapp-approval') continue
      const { node } = interrupt.reason as { node: string }
      const answer = await prompt.question(`Approve the ${node} step? (y/N): `)
      responses.push({
        interruptResponse: { interruptId: interrupt.id, response: answer },
      })
    }
  } finally {
    prompt.close()
  }
  result = await graph.invoke(responses)
}

// COMPLETED when approved; CANCELLED when the human denied the review step.
console.log('Status:', result.status)
```
(( /tab "TypeScript" ))

### How each guardrail works

-   **Deadlines**: `builder.set_node_timeout(seconds)``nodeTimeout` bounds any single node and `builder.set_execution_timeout(seconds)``timeout` bounds the whole run. A timeout fails the run; it is not routed to another node. In Python, a node timeout raises from the graph call, while the execution timeout is checked before each batch of nodes and returns a `FAILED` result, so it does not stop a node that is already running. In TypeScript, either deadline makes `invoke()` throw once the in-flight node settles, and the timeouts are cooperative: a tool or model call that ignores its cancel signal can still run past the deadline.
-   **Cancellation with a recorded reason**: setting `event.cancel_node``event.cancel` to a message skips the node and records that message. In Python, the graph call raises a `RuntimeError` carrying the message and the run ends `FAILED`. In TypeScript, the node and the run end `CANCELLED` and a `NodeCancelEvent` carries the message.
-   **Approval gate**: `event.interrupt(name, reason=...)``event.interrupt({ name, reason })` on `BeforeNodeCallEvent` halts the orchestrator before the gated node. The run returns with `Status.INTERRUPTED`; you answer each interrupt by id and resume by invoking the graph again. See [Interrupts in multi-agent systems](/docs/user-guide/sdk/interrupts-multi-agent/index.md) for the full interrupt/resume contract.
-   **Handoff logging**: because `BeforeNodeCallEvent` fires before every node, a single callback records each transition. If you prefer to consume handoffs from the event stream instead, watch for the `multiagent_handoff``multiAgentHandoffEvent` event in `stream_async``stream` (see [Graph](/docs/user-guide/sdk/multi-agent/graph/index.md#streaming-events)).

A [Swarm](/docs/user-guide/sdk/multi-agent/swarm/index.md) supports the same `BeforeNodeCallEvent` hook and interrupts, and takes its own node and execution timeouts, so you can apply this supervision to autonomous handoffs as well.

## Shared state across multi-agent patterns

Both Graph and Swarm support passing shared state to every agent through `invocation_state``invocationState`. This shares context and configuration across agents without exposing it to the LLM. Use it for things like user ids, feature flags, or a database handle, kept separate from the data the model should reason about.

(( tab "Python" ))
The `invocation_state` is automatically propagated to:

-   All agents in the pattern via their `**kwargs`
-   Tools via `ToolContext` when using `@tool(context=True)` (see [Custom tools](/docs/user-guide/sdk/tools/custom-tools/index.md#accessing-state-in-tools))
-   Tool-related hooks (BeforeToolCallEvent, AfterToolCallEvent) (see [Hooks](/docs/user-guide/sdk/agents/hooks/index.md#accessing-invocation-state-in-hooks))

```python
import sqlite3

from strands import Agent
from strands.multiagent import GraphBuilder, Swarm

builder = GraphBuilder()
builder.add_node(Agent(name="researcher"), "researcher")
builder.add_node(Agent(name="writer"), "writer")
builder.add_edge("researcher", "writer")
graph = builder.build()

swarm = Swarm([Agent(name="analyst"), Agent(name="reporter")])

# The same invocation_state works for both Graph and Swarm
shared_state = {
    "user_id": "user123",
    "session_id": "sess456",
    "debug_mode": True,
    "database_connection": sqlite3.connect(":memory:"),
}

result = graph("Analyze customer data", invocation_state=shared_state)
result = swarm("Analyze customer data", invocation_state=shared_state)
```

Access it inside a tool:

```python
from strands import ToolContext, tool

@tool(context=True)
def query_data(query: str, tool_context: ToolContext) -> str:
    user_id = tool_context.invocation_state.get("user_id")
    debug_mode = tool_context.invocation_state.get("debug_mode", False)
    # Use context for personalized queries...
    return f"Results for {user_id}"
```
(( /tab "Python" ))

(( tab "TypeScript" ))
Both Graph and Swarm support passing per-invocation state to all nodes through the `invocationState` option: a mutable `Record<string, unknown>` shared by reference, so one node’s hooks and tools can read state written by a previous node.

```typescript
import { Agent } from '@strands-agents/sdk'
import { Graph } from '@strands-agents/sdk/multiagent'

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

// Pass invocation state to the orchestrator
await graph.invoke('Analyze customer data', {
  invocationState: {
    userId: 'user123',
    sessionId: 'sess456',
    debugMode: true,
  },
})
```

The `invocationState` is automatically forwarded to each node’s child agent, to tools via `context.invocationState`, and to all hook events on both the orchestrator and the individual agents.

```typescript
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'

const queryDataTool = tool({
  name: 'query_data',
  description: 'Query data with user context',
  inputSchema: z.object({
    query: z.string(),
  }),
  callback: (input, context) => {
    const userId = context?.invocationState.userId
    const debugMode = context?.invocationState.debugMode
    // Use context for personalized queries...
    return `Results for ${userId}`
  },
})
```

Alongside `invocationState`, the orchestrator’s `MultiAgentState` is shared across all nodes and exposes execution progress (`results`, `nodes`, `steps`) and a `StateStore` (`app`) for custom shared data.

```typescript
import { Agent } from '@strands-agents/sdk'
import { BeforeNodeCallEvent, Graph } from '@strands-agents/sdk/multiagent'

const researcher = new Agent({ id: 'researcher' })
const writer = new Agent({ id: 'writer' })

const graph = new Graph({
  nodes: [researcher, writer],
  edges: [['researcher', 'writer']],
})

graph.addHook(BeforeNodeCallEvent, (event) => {
  // Read execution progress
  console.log(`Step ${event.state.steps}, node ${event.nodeId} starting`)

  // Check a previous node's status
  const researcherState = event.state.node('researcher')
  if (researcherState) {
    console.log(`Researcher status: ${researcherState.status}`)
  }

  // Read/write custom shared state
  event.state.app.set('requestId', 'req-123')
  const requestId = event.state.app.get('requestId')
})

await graph.invoke('Write a short report on customer churn')
```
(( /tab "TypeScript" ))

Use shared state for context and configuration that should not appear in prompts; use each pattern’s own data flow (shared context for swarms, node inputs for graphs) for data the LLM should reason about.

## Where to go next

Start with [Agents as tools](/docs/user-guide/sdk/multi-agent/agents-as-tools/index.md), the smallest step above a single agent. Reach for an orchestrator once the order of work matters or agents must hand off among themselves: [Graph](/docs/user-guide/sdk/multi-agent/graph/index.md) for developer-defined edges (fixed, parallel, or conditional), [Swarm](/docs/user-guide/sdk/multi-agent/swarm/index.md) for autonomous handoffs, and a [workflow in your code](/docs/user-guide/sdk/multi-agent/workflow/index.md) for a sequence of agent calls. Give an agent the [vended `graph` tool](/docs/user-guide/sdk/tools/vended-tools/graph/index.md) when it should construct and run the task graph itself. To connect agents running as separate services, see [Agent-to-Agent (A2A)](/docs/user-guide/sdk/multi-agent/agent-to-agent/index.md). To add supervision (deadlines, cancellation, and approval gates), see [Interrupts in multi-agent systems](/docs/user-guide/sdk/interrupts-multi-agent/index.md).

## Related pages

- [A2A Server Configuration](/docs/user-guide/sdk/multi-agent/a2a-server-configuration/index.md) (1 shared tag)
- [Agent-to-Agent (A2A) Protocol](/docs/user-guide/sdk/multi-agent/agent-to-agent/index.md) (1 shared tag)
- [Build a sequential workflow](/docs/user-guide/sdk/multi-agent/workflow/index.md) (1 shared tag)
- [Graph Components](/docs/user-guide/sdk/multi-agent/graph-components/index.md) (1 shared tag)
- [Graph Multi-Agent Pattern](/docs/user-guide/sdk/multi-agent/graph/index.md) (1 shared tag)
- [Swarm Multi-Agent Pattern](/docs/user-guide/sdk/multi-agent/swarm/index.md) (1 shared tag)
- [Agents as tools](/docs/user-guide/sdk/multi-agent/agents-as-tools/index.md) (1 shared tag)
- [Interrupts in Multi-Agent Systems](/docs/user-guide/sdk/interrupts-multi-agent/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/multiagent/base.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/base.py)
- [harness-sdk/strands-py/src/strands/multiagent/graph.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/graph.py)
- [harness-sdk/strands-py/src/strands/multiagent/swarm.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/swarm.py)

### TypeScript

- [harness-sdk/strands-ts/src/multiagent/graph.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/multiagent/graph.ts)
- [harness-sdk/strands-ts/src/multiagent/swarm.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/multiagent/swarm.ts)
