A Graph gives you deterministic control over how a set of agents runs. You define the nodes (agents, custom nodes, or nested multi-agent systems like a [Swarm](/docs/user-guide/sdk/multi-agent/swarm/index.md)) and the edges between them. Each node runs according to its edge dependencies, and its output passes as input to the nodes that depend on it. Graphs support both acyclic (DAG) and cyclic topologies, so you can build feedback loops and iterative refinement workflows.

-   **Deterministic execution order** based on graph structure
-   **Output propagation** along edges between nodes
-   **Clear dependency management** between agents
-   **Nested pattern support** (Graph as a node in another Graph)
-   **Remote agent support** via A2AAgent for distributed workflows
-   **Custom node types** for deterministic business logic and hybrid workflows
-   **Conditional edge traversal** for dynamic workflows
-   **Cyclic graph support** with execution limits and state management
-   **Multi-modal input support** for handling text, images, and other content types

To let an agent construct the nodes and dependency edges at runtime, give it the [vended `graph` tool](/docs/user-guide/sdk/tools/vended-tools/graph/index.md). That tool runs an acyclic graph supplied in the agent’s tool call. Use the SDK API on this page when your application should define the graph, including conditional edges or cycles.

## How Graphs Work

In a graph:

1.  Nodes represent agents, custom nodes, or multi-agent systems
2.  Edges define dependencies and information flow between nodes
3.  Execution follows the graph structure, respecting dependencies
    1.  When multiple nodes have edges to a target node, the default behavior for when the target executes varies by SDK. See the [Conditional Edges](#conditional-edges) section for dynamic traversal.
4.  Output from one node becomes input for dependent nodes
5.  Entry points receive the original task as input
6.  Nodes can be revisited in cyclic patterns with proper exit conditions

> **Diagram:** A graph with four agent nodes. The task goes to the entry point, the researcher node (research). Its output flows along two edges to the analyst node (analysis) and the fact checker node (fact_check). Both of their outputs flow along edges into the report writer node (report).

## Creating a Graph

You build a graph by defining its nodes, the edges between them, and its entry points. For the full list of node and edge fields, `GraphBuilder` methods, and TypeScript constructor options, see [Graph components](/docs/user-guide/sdk/multi-agent/graph-components/index.md).

(( tab "Python" ))
To create a [`Graph`](/docs/api/python/strands.multiagent.graph#Graph), use the [`GraphBuilder`](/docs/api/python/strands.multiagent.graph#GraphBuilder) to define nodes, edges, and entry points:

```python
import logging
from strands import Agent
from strands.multiagent import GraphBuilder

# Enable debug logs and print them to stderr
logging.getLogger("strands.multiagent").setLevel(logging.DEBUG)
logging.basicConfig(
    format="%(levelname)s | %(name)s | %(message)s",
    handlers=[logging.StreamHandler()]
)

# Create specialized agents
researcher = Agent(name="researcher", system_prompt="You are a research specialist...")
analyst = Agent(name="analyst", system_prompt="You are a data analysis specialist...")
fact_checker = Agent(name="fact_checker", system_prompt="You are a fact checking specialist...")
report_writer = Agent(name="report_writer", system_prompt="You are a report writing specialist...")

# Build the graph
builder = GraphBuilder()

# Add nodes
builder.add_node(researcher, "research")
builder.add_node(analyst, "analysis")
builder.add_node(fact_checker, "fact_check")
builder.add_node(report_writer, "report")

# Add edges (dependencies)
builder.add_edge("research", "analysis")
builder.add_edge("research", "fact_check")
builder.add_edge("analysis", "report")
builder.add_edge("fact_check", "report")

# Set entry points (optional - will be auto-detected if not specified)
builder.set_entry_point("research")

# Optional: Configure execution limits for safety
builder.set_execution_timeout(600)   # 10 minute timeout

# Build the graph
graph = builder.build()

# Execute the graph on a task
result = graph("Research the impact of AI on healthcare and create a comprehensive report")
# Or use invoke_async for async execution: result = await graph.invoke_async(...)

# Access the results
print(f"\nStatus: {result.status}")
print(f"Execution order: {[node.node_id for node in result.execution_order]}")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
// Create specialized agents
const researcher = new Agent({
  id: 'research',
  systemPrompt: 'You are a research specialist...',
})

const analyst = new Agent({
  id: 'analysis',
  systemPrompt: 'You are a data analysis specialist...',
})

const factChecker = new Agent({
  id: 'fact_check',
  systemPrompt: 'You are a fact checking specialist...',
})

const reportWriter = new Agent({
  id: 'report',
  systemPrompt: 'You are a report writing specialist...',
})

// Build the graph with nodes and edges
const graph = new Graph({
  nodes: [researcher, analyst, factChecker, reportWriter],
  edges: [
    ['research', 'analysis'],
    ['research', 'fact_check'],
    ['analysis', 'report'],
    ['fact_check', 'report'],
  ],
  // Optional: specify entry points (auto-detected from nodes with no incoming edges)
  sources: ['research'],
  // Optional: configure execution limits for safety
  maxSteps: 20,
})

// Execute the graph on a task
const result = await graph.invoke(
  'Research the impact of AI on healthcare and create a comprehensive report'
)

// Access the results
console.log('Status:', result.status)
console.log('Execution order:', result.results.map((r) => r.nodeId).join(' -> '))
```
(( /tab "TypeScript" ))

## Conditional Edges

You can add conditional logic to edges to create dynamic workflows:

(( tab "Python" ))
```python
def only_if_research_successful(state):
    """Only traverse if research was successful."""
    research_node = state.results.get("research")
    if not research_node:
        return False

    # Check if research result contains success indicator
    result_text = str(research_node.result)
    return "successful" in result_text.lower()

# Add conditional edge
builder.add_edge("research", "analysis", condition=only_if_research_successful)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const onlyIfResearchSuccessful: EdgeHandler = (state) => {
  const resultText = state
    .node('research')!
    .content.map((b) => ('text' in b ? b.text : ''))
    .join('')
  return resultText.toLowerCase().includes('successful')
}

// Add conditional edge
const graph = new Graph({
  nodes: [researcher, analyst],
  edges: [
    { source: 'research', target: 'analysis', handler: onlyIfResearchSuccessful },
  ],
})
```
(( /tab "TypeScript" ))

### Conditional Edges with Runtime Context

Python only

This feature is currently available in the Python SDK only.

Edge conditions can optionally receive an `invocation_state` dictionary, enabling routing decisions based on runtime context such as feature flags, user roles, or environment-specific configuration. This is passed during graph invocation and forwarded to conditions that accept it.

Both signatures are supported: existing conditions that only accept `state` continue to work without changes.

```python
from strands import Agent
from strands.multiagent import GraphBuilder
from strands.multiagent.graph import GraphState

# New-style condition: receives invocation_state for runtime routing
def requires_admin(state: GraphState, *, invocation_state: dict, **kwargs) -> bool:
    """Only traverse if the invoking user has admin role."""
    return invocation_state.get("role") == "admin"

def requires_feature_flag(state: GraphState, *, invocation_state: dict, **kwargs) -> bool:
    """Only traverse if the experimental feature is enabled."""
    return invocation_state.get("enable_experimental", False)

# Build the graph with conditional routing
builder = GraphBuilder()
builder.add_node(router, "router")
builder.add_node(admin_panel, "admin_panel")
builder.add_node(experimental_feature, "experimental")
builder.add_node(standard_path, "standard")

builder.add_edge("router", "admin_panel", condition=requires_admin)
builder.add_edge("router", "experimental", condition=requires_feature_flag)
builder.add_edge("router", "standard")

graph = builder.build()

# Pass runtime context at invocation time
result = graph("Process this request", invocation_state={"role": "admin", "enable_experimental": True})
```

The `invocation_state` dictionary is:

-   Passed to every `EdgeConditionWithContext` condition during edge evaluation
-   Persisted across interrupt/resume cycles (serialized with the graph checkpoint)
-   Available via the [`EdgeConditionWithContext`](/docs/api/python/strands.multiagent.graph#EdgeConditionWithContext) protocol

Legacy conditions (`Callable[[GraphState], bool]`) are detected automatically and called with only `state`, so no migration is required.

### Waiting for All Dependencies

Python only

In Python, the default behavior is OR semantics: a target node fires when **any** incoming edge’s source completes. Use conditional edges to explicitly wait for all dependencies. In other SDKs, AND semantics are the default.

```python
from strands.multiagent.graph import GraphState
from strands.multiagent.base import Status

def all_dependencies_complete(required_nodes: list[str]):
    """Factory function to create AND condition for multiple dependencies."""
    def check_all_complete(state: GraphState) -> bool:
        return all(
            node_id in state.results and state.results[node_id].status == Status.COMPLETED
            for node_id in required_nodes
        )
    return check_all_complete

# Z will only execute when A AND B AND C have all completed
builder.add_edge("A", "Z", condition=all_dependencies_complete(["A", "B", "C"]))
builder.add_edge("B", "Z", condition=all_dependencies_complete(["A", "B", "C"]))
builder.add_edge("C", "Z", condition=all_dependencies_complete(["A", "B", "C"]))
```

## Nested Multi-Agent Patterns

You can use a Graph or Swarm as a node within another Graph:

(( tab "Python" ))
```python
from strands import Agent
from strands.multiagent import GraphBuilder, Swarm

# Create a swarm of research agents
research_agents = [
    Agent(name="medical_researcher", system_prompt="You are a medical research specialist..."),
    Agent(name="technology_researcher", system_prompt="You are a technology research specialist..."),
    Agent(name="economic_researcher", system_prompt="You are an economic research specialist...")
]
research_swarm = Swarm(research_agents)

# Create a single agent node too
analyst = Agent(system_prompt="Analyze the provided research.")

# Create a graph with the swarm as a node
builder = GraphBuilder()
builder.add_node(research_swarm, "research_team")
builder.add_node(analyst, "analysis")
builder.add_edge("research_team", "analysis")

graph = builder.build()

result = graph("Research the impact of AI on healthcare and create a comprehensive report")

# Access the results
print(f"\n{result}")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const medicalResearcher = new Agent({
  id: 'medical_researcher',
  systemPrompt: 'You are a medical research specialist...',
})

const technologyResearcher = new Agent({
  id: 'technology_researcher',
  systemPrompt: 'You are a technology research specialist...',
})

const economicResearcher = new Agent({
  id: 'economic_researcher',
  systemPrompt: 'You are an economic research specialist...',
})

// Create a swarm of research agents
const researchSwarm = new Swarm({
  id: 'research_swarm',
  nodes: [medicalResearcher, technologyResearcher, economicResearcher],
})

// Create a single agent node
const analyst = new Agent({
  id: 'analysis',
  systemPrompt: 'Analyze the provided research.',
})

// Create a graph with the swarm as a node
const graph = new Graph({
  nodes: [researchSwarm, analyst],
  edges: [['research_swarm', 'analysis']],
})

const result = await graph.invoke(
  'Research the impact of AI on healthcare and create a comprehensive report'
)
console.log(result)
```
(( /tab "TypeScript" ))

## Remote Agents with A2AAgent

Graphs support remote A2A agents as nodes through the [`A2AAgent`](/docs/user-guide/sdk/multi-agent/agent-to-agent/index.md#consuming-remote-agents) class. You can add it directly to a graph just like a local agent. This enables distributed architectures where orchestration happens locally while specialized tasks run on remote services.

> **Diagram:** A graph that mixes local and remote nodes. The local data prep node (prep) feeds two remote A2A agents, ML analysis (ml) and NLP processing (nlp), which run on their own services. Both remote nodes feed the local report writer node (report).

(( tab "Python" ))
```python
import asyncio
from strands import Agent
from strands.agent.a2a_agent import A2AAgent
from strands.multiagent import GraphBuilder

# Local agents for orchestration
data_prep = Agent(
    name="data_prep",
    system_prompt="You prepare data for analysis, cleaning and formatting as needed."
)
report_writer = Agent(
    name="report_writer",
    system_prompt="You synthesize analysis results into clear, actionable reports."
)

# Remote specialized services
ml_analyzer = A2AAgent(
    endpoint="http://ml-service:9000",
    name="ml_analyzer",
    timeout=600  # Allow more time for ML operations
)
nlp_processor = A2AAgent(
    endpoint="http://nlp-service:9000",
    name="nlp_processor"
)

# Build the distributed graph
builder = GraphBuilder()
builder.add_node(data_prep, "prep")
builder.add_node(ml_analyzer, "ml")
builder.add_node(nlp_processor, "nlp")
builder.add_node(report_writer, "report")

builder.add_edge("prep", "ml")
builder.add_edge("prep", "nlp")
builder.add_edge("ml", "report")
builder.add_edge("nlp", "report")

builder.set_execution_timeout(900)
graph = builder.build()

# Execute the distributed workflow
async def main():
    result = await graph.invoke_async("Analyze customer feedback from Q4 2024")
    print(f"Status: {result.status}")

asyncio.run(main())
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
// Local agents for orchestration
const dataPrep = new Agent({
  id: 'prep',
  systemPrompt: 'You prepare data for analysis, cleaning and formatting as needed.',
})

const reportWriter = new Agent({
  id: 'report',
  systemPrompt: 'You synthesize analysis results into clear, actionable reports.',
})

// Remote specialized services
const mlAnalyzer = new A2AAgent({ url: 'http://ml-service:9000', id: 'ml' })
const nlpProcessor = new A2AAgent({ url: 'http://nlp-service:9000', id: 'nlp' })

// Build the distributed graph
const graph = new Graph({
  nodes: [dataPrep, mlAnalyzer, nlpProcessor, reportWriter],
  edges: [
    ['prep', 'ml'],
    ['prep', 'nlp'],
    ['ml', 'report'],
    ['nlp', 'report'],
  ],
})

// Execute the distributed workflow
const result = await graph.invoke('Analyze customer feedback from Q4 2024')
console.log('Status:', result.status)
```
(( /tab "TypeScript" ))

## Custom Node Types

You can create custom node types to implement deterministic business logic, data processing pipelines, and hybrid workflows.

(( tab "Python" ))
Extend [`MultiAgentBase`](/docs/api/python/strands.multiagent.base#MultiAgentBase) to create custom nodes:

```python
from strands.multiagent.base import MultiAgentBase, NodeResult, Status, MultiAgentResult
from strands.agent.agent_result import AgentResult
from strands.types.content import ContentBlock, Message

class FunctionNode(MultiAgentBase):
    """Execute deterministic Python functions as graph nodes."""

    def __init__(self, func, name: str = None):
        super().__init__()
        self.func = func
        self.name = name or func.__name__

    async def invoke_async(self, task, invocation_state, **kwargs):
        # Execute function and create AgentResult
        result = self.func(task if isinstance(task, str) else str(task))

        agent_result = AgentResult(
            stop_reason="end_turn",
            message=Message(role="assistant", content=[ContentBlock(text=str(result))]),
            # ... metrics and state
        )

        # Return wrapped in MultiAgentResult
        return MultiAgentResult(
            status=Status.COMPLETED,
            results={self.name: NodeResult(result=agent_result, ...)},
            # ... execution details
        )

# Usage example
def validate_data(data):
    if not data.strip():
        raise ValueError("Empty input")
    return f"Validated: {data[:50]}..."

validator = FunctionNode(func=validate_data, name="validator")
builder.add_node(validator, "validator")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
Extend `Node` and implement the `handle` method:

```typescript
class ValidatorNode extends Node {
  async *handle(
    args: string | ContentBlock[],
    _state: MultiAgentState
  ): AsyncGenerator<MultiAgentStreamEvent, NodeResultUpdate, undefined> {
    const input = typeof args === 'string' ? args : ''

    if (!input.trim()) {
      throw new Error('Empty input')
    }

    return { content: [new TextBlock(`Validated: ${input.slice(0, 50)}...`)] }
  }
}

// Pass the custom node directly to the graph
const validator = new ValidatorNode('validator', { description: 'Validates input data' })
const processor = new Agent({
  id: 'processor',
  systemPrompt: 'Process the validated data.',
})

const pipelineGraph = new Graph({
  nodes: [validator, processor],
  edges: [['validator', 'processor']],
})
```
(( /tab "TypeScript" ))

Custom nodes enable:

-   **Deterministic processing**: Guarantee execution for business logic
-   **Performance optimization**: Skip LLM calls for deterministic operations
-   **Hybrid workflows**: Combine AI creativity with deterministic control
-   **Business rules**: Implement complex business logic as graph nodes

## Multi-Modal Input Support

Graphs support multi-modal inputs like text and images:

(( tab "Python" ))
```python
from strands import Agent
from strands.multiagent import GraphBuilder
from strands.types.content import ContentBlock

# Create agents for image processing workflow
image_analyzer = Agent(system_prompt="You are an image analysis expert...")
summarizer = Agent(system_prompt="You are a summarization expert...")

# Build the graph
builder = GraphBuilder()
builder.add_node(image_analyzer, "image_analyzer")
builder.add_node(summarizer, "summarizer")
builder.add_edge("image_analyzer", "summarizer")
builder.set_entry_point("image_analyzer")

graph = builder.build()

# Create content blocks with text and image
content_blocks = [
    ContentBlock(text="Analyze this image and describe what you see:"),
    ContentBlock(image={"format": "png", "source": {"bytes": image_bytes}}),
]

# Execute the graph with multi-modal input
result = graph(content_blocks)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
// Create agents for image processing workflow
const imageAnalyzer = new Agent({
  id: 'image_analyzer',
  systemPrompt: 'You are an image analysis expert...',
})

const summarizer = new Agent({
  id: 'summarizer',
  systemPrompt: 'You are a summarization expert...',
})

// Build the graph
const graph = new Graph({
  nodes: [imageAnalyzer, summarizer],
  edges: [['image_analyzer', 'summarizer']],
  sources: ['image_analyzer'],
})

// Create content blocks with text and image
const imageBytes = new Uint8Array(/* your image data */)
const contentBlocks = [
  new TextBlock('Analyze this image and describe what you see:'),
  new ImageBlock({ format: 'png', source: { bytes: imageBytes } }),
]

// Execute the graph with multi-modal input
const result = await graph.invoke(contentBlocks)
```
(( /tab "TypeScript" ))

## Streaming Events

Graphs support real-time streaming of events during execution. This provides visibility into node execution, parallel processing, and nested multi-agent systems.

(( tab "Python" ))
```python
from strands import Agent
from strands.multiagent import GraphBuilder

# Create specialized agents
researcher = Agent(name="researcher", system_prompt="You are a research specialist...")
analyst = Agent(name="analyst", system_prompt="You are an analysis specialist...")

# Build the graph
builder = GraphBuilder()
builder.add_node(researcher, "research")
builder.add_node(analyst, "analysis")
builder.add_edge("research", "analysis")
builder.set_entry_point("research")
graph = builder.build()

# Stream events during execution
async for event in graph.stream_async("Research and analyze market trends"):
    # Track node execution
    if event.get("type") == "multiagent_node_start":
        print(f"Node {event['node_id']} starting")

    # Monitor agent events within nodes
    elif event.get("type") == "multiagent_node_stream":
        inner_event = event["event"]
        if "data" in inner_event:
            print(inner_event["data"], end="")

    # Track node completion
    elif event.get("type") == "multiagent_node_stop":
        node_result = event["node_result"]
        print(f"\nNode {event['node_id']} completed in {node_result.execution_time}ms")

    # Get final result
    elif event.get("type") == "multiagent_result":
        result = event["result"]
        print(f"Graph completed: {result.status}")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const graph = new Graph({
  nodes: [researcher, analyst],
  edges: [['research', 'analysis']],
  sources: ['research'],
})

for await (const event of graph.stream('Research and analyze market trends')) {
  switch (event.type) {
    // Track node execution
    case 'beforeNodeCallEvent':
      console.log(`\nNode ${event.nodeId} starting`)
      break

    // Monitor node completion
    case 'nodeResultEvent':
      console.log(`\nNode ${event.nodeId} completed in ${event.result.duration}ms`)
      break

    // Track handoffs between nodes
    case 'multiAgentHandoffEvent':
      console.log(`\nHandoff: ${event.source} -> ${event.targets.join(', ')}`)
      break

    // Get final result
    case 'multiAgentResultEvent':
      console.log(`\nGraph completed: ${event.result.status}`)
      break
  }
}
```
(( /tab "TypeScript" ))

See the [stream event types](/docs/user-guide/sdk/streaming/events/index.md#multi-agent-events) reference for details on all multi-agent event types.

## Graph Results

When a Graph completes execution, it returns a result object with detailed information:

(( tab "Python" ))
```python
result = graph("Research and analyze...")

# Check execution status
print(f"Status: {result.status}")  # COMPLETED, FAILED, etc.

# See which nodes were executed and in what order
for node in result.execution_order:
    print(f"Executed: {node.node_id}")

# Get results from specific nodes
analysis_result = result.results["analysis"].result
print(f"Analysis: {analysis_result}")

# Get performance metrics
print(f"Total nodes: {result.total_nodes}")
print(f"Completed nodes: {result.completed_nodes}")
print(f"Failed nodes: {result.failed_nodes}")
print(f"Execution time: {result.execution_time}ms")
print(f"Token usage: {result.accumulated_usage}")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const graph = new Graph({
  nodes: [researcher, analyst],
  edges: [['research', 'analysis']],
})

const result = await graph.invoke('Research and analyze...')

// Check execution status
console.log('Status:', result.status)

// See which nodes were executed
for (const nodeResult of result.results) {
  console.log(`Node: ${nodeResult.nodeId}, Status: ${nodeResult.status}`)
}

// Get performance metrics
console.log('Duration:', result.duration, 'ms')

// Get the final output
console.log('Output:', result.content.find((b) => b.type === 'textBlock')?.text)
```
(( /tab "TypeScript" ))

## Input Propagation

The Graph automatically builds input for each node based on its dependencies:

1.  **Entry point nodes** receive the original task as input
2.  **Dependent nodes** receive a combined input that includes:
    -   The original task
    -   Results from all dependency nodes that have completed execution

This ensures each node has access to both the original context and the outputs from its dependencies.

## Shared State

Graphs support passing shared state to all agents. This enables sharing context and configuration across agents without exposing it to the LLM.

For detailed information about shared state, including examples and best practices, see [Shared State Across Multi-Agent Patterns](/docs/user-guide/sdk/multi-agent/multi-agent-patterns/index.md#shared-state-across-multi-agent-patterns).

## Common Graph Topologies

### 1\. Sequential Pipeline

> **Diagram:** A sequential pipeline of four nodes in a row: researcher (research), then analyst (analysis), then reviewer (review), then report writer (report). Each node runs after the one before it and receives its output.

(( tab "Python" ))
```python
builder = GraphBuilder()
builder.add_node(researcher, "research")
builder.add_node(analyst, "analysis")
builder.add_node(reviewer, "review")
builder.add_node(report_writer, "report")

builder.add_edge("research", "analysis")
builder.add_edge("analysis", "review")
builder.add_edge("review", "report")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const graph = new Graph({
  nodes: [researcher, analyst, reviewer, reportWriter],
  edges: [
    ['research', 'analysis'],
    ['analysis', 'review'],
    ['review', 'report'],
  ],
})
```
(( /tab "TypeScript" ))

### 2\. Parallel Processing with Aggregation

> **Diagram:** Parallel processing with aggregation. The coordinator node (coordinator) has edges to three worker nodes (worker1, worker2, worker3), which run in parallel. Each worker has an edge to the aggregator node (aggregator), which combines their results.

(( tab "Python" ))
```python
builder = GraphBuilder()
builder.add_node(coordinator, "coordinator")
builder.add_node(worker1, "worker1")
builder.add_node(worker2, "worker2")
builder.add_node(worker3, "worker3")
builder.add_node(aggregator, "aggregator")

builder.add_edge("coordinator", "worker1")
builder.add_edge("coordinator", "worker2")
builder.add_edge("coordinator", "worker3")
builder.add_edge("worker1", "aggregator")
builder.add_edge("worker2", "aggregator")
builder.add_edge("worker3", "aggregator")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const graph = new Graph({
  nodes: [coordinator, worker1, worker2, worker3, aggregator],
  edges: [
    ['coordinator', 'worker1'],
    ['coordinator', 'worker2'],
    ['coordinator', 'worker3'],
    ['worker1', 'aggregator'],
    ['worker2', 'aggregator'],
    ['worker3', 'aggregator'],
  ],
})
```
(( /tab "TypeScript" ))

### 3\. Branching Logic

> **Diagram:** Branching logic. The classifier node (classifier) has two conditional edges. If its output mentions 'technical', the graph runs the technical specialist (tech_specialist) and then the technical report (tech_report). If it mentions 'business', it runs the business specialist (business_specialist) and then the business report (business_report).

(( tab "Python" ))
```python
def is_technical(state):
    classifier_result = state.results.get("classifier")
    if not classifier_result:
        return False
    result_text = str(classifier_result.result)
    return "technical" in result_text.lower()

def is_business(state):
    classifier_result = state.results.get("classifier")
    if not classifier_result:
        return False
    result_text = str(classifier_result.result)
    return "business" in result_text.lower()

builder = GraphBuilder()
builder.add_node(classifier, "classifier")
builder.add_node(tech_specialist, "tech_specialist")
builder.add_node(business_specialist, "business_specialist")
builder.add_node(tech_report, "tech_report")
builder.add_node(business_report, "business_report")

builder.add_edge("classifier", "tech_specialist", condition=is_technical)
builder.add_edge("classifier", "business_specialist", condition=is_business)
builder.add_edge("tech_specialist", "tech_report")
builder.add_edge("business_specialist", "business_report")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const isTechnical: EdgeHandler = (state) => {
  const resultText = state
    .node('classifier')!
    .content.map((b) => ('text' in b ? b.text : ''))
    .join('')
  return resultText.toLowerCase().includes('technical')
}

const isBusiness: EdgeHandler = (state) => {
  const resultText = state
    .node('classifier')!
    .content.map((b) => ('text' in b ? b.text : ''))
    .join('')
  return resultText.toLowerCase().includes('business')
}

const graph = new Graph({
  nodes: [classifier, techSpecialist, businessSpecialist, techReport, businessReport],
  edges: [
    { source: 'classifier', target: 'tech_specialist', handler: isTechnical },
    { source: 'classifier', target: 'business_specialist', handler: isBusiness },
    ['tech_specialist', 'tech_report'],
    ['business_specialist', 'business_report'],
  ],
})
```
(( /tab "TypeScript" ))

### 4\. Feedback Loop

> **Diagram:** A feedback loop. The draft writer node (draft_writer) has an edge to the reviewer node (reviewer). The reviewer has two conditional edges: if the draft needs revision, it loops back to the draft writer; if it is approved, it goes on to the publisher node (publisher). The draft writer is the entry point, set explicitly because the loop gives every node an incoming edge. Execution limits stop the loop if the draft is never approved.

(( tab "Python" ))
```python
def needs_revision(state):
    review_result = state.results.get("reviewer")
    if not review_result:
        return False
    result_text = str(review_result.result)
    return "revision needed" in result_text.lower()

def is_approved(state):
    review_result = state.results.get("reviewer")
    if not review_result:
        return False
    result_text = str(review_result.result)
    return "approved" in result_text.lower()

builder = GraphBuilder()
builder.add_node(draft_writer, "draft_writer")
builder.add_node(reviewer, "reviewer")
builder.add_node(publisher, "publisher")

builder.add_edge("draft_writer", "reviewer")
builder.add_edge("reviewer", "draft_writer", condition=needs_revision)
builder.add_edge("reviewer", "publisher", condition=is_approved)

# The loop gives draft_writer an incoming edge, so set the entry point explicitly
builder.set_entry_point("draft_writer")

# Set execution limits to prevent infinite loops
builder.set_max_node_executions(10)  # Maximum 10 node executions total
builder.set_execution_timeout(300)   # 5 minute timeout
builder.reset_on_revisit(True)       # Reset node state when revisiting

graph = builder.build()
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const needsRevision: EdgeHandler = (state) => {
  const resultText = state
    .node('reviewer')!
    .content.map((b) => ('text' in b ? b.text : ''))
    .join('')
  return resultText.toLowerCase().includes('revision needed')
}

const isApproved: EdgeHandler = (state) => {
  const resultText = state
    .node('reviewer')!
    .content.map((b) => ('text' in b ? b.text : ''))
    .join('')
  return resultText.toLowerCase().includes('approved')
}

const graph = new Graph({
  nodes: [draftWriter, reviewer, publisher],
  edges: [
    ['draft_writer', 'reviewer'],
    { source: 'reviewer', target: 'draft_writer', handler: needsRevision },
    { source: 'reviewer', target: 'publisher', handler: isApproved },
  ],
  // The loop gives draft_writer an incoming edge, so set the source explicitly
  sources: ['draft_writer'],
  // Set execution limits to prevent infinite loops
  maxSteps: 10,
})
```
(( /tab "TypeScript" ))

## SDK Differences

The Graph pattern is available in multiple SDKs. While the core concept is the same, there are behavioral differences.

**Dependency resolution**: Python uses OR semantics, where a node fires when any single incoming edge from the completed batch is satisfied. TypeScript uses AND semantics, where a node runs only when all incoming edge sources are completed. This is more intuitive for join/diamond patterns where you want to wait for all inputs before proceeding.

**Scheduling**: Python executes in discrete batches, waiting for the entire batch to complete before scheduling the next set of nodes. TypeScript launches nodes individually as they become ready, up to `maxConcurrency`. This avoids artificial bottlenecks where a fast node waits for a slow sibling to finish before its dependents can start.

**Node state**: Python accumulates agent state across executions unless `reset_on_revisit` is explicitly enabled. TypeScript agent nodes are stateless by default, capturing and restoring the agent’s messages and state on each execution. Set `preserveContext: true` on an individual `AgentNode` to opt into accumulation for revisited nodes.

**Error handling**: Python node failures throw exceptions (fail-fast), while orchestrator-level limit violations return a FAILED result. TypeScript does the inverse: node failures produce a FAILED result, allowing parallel paths to continue, while orchestrator-level limits (`maxSteps`) throw exceptions to promote fail-fast behavior for global failures.

**Node cancellation**: Both SDKs support cancelling a node before execution via hook callbacks. In TypeScript, a cancelled node produces a CANCELLED result status, allowing the orchestrator to distinguish cancellation from failure. In Python, a cancelled node results in a FAILED status.

## Related pages

- [A2A Server Configuration](/docs/user-guide/sdk/multi-agent/a2a-server-configuration/index.md) (1 shared tag)
- [Agent-to-Agent (A2A) Protocol](/docs/user-guide/sdk/multi-agent/agent-to-agent/index.md) (1 shared tag)
- [Build a sequential workflow](/docs/user-guide/sdk/multi-agent/workflow/index.md) (1 shared tag)
- [Choose a multi-agent pattern](/docs/user-guide/sdk/multi-agent/multi-agent-patterns/index.md) (1 shared tag)
- [Graph Components](/docs/user-guide/sdk/multi-agent/graph-components/index.md) (1 shared tag)
- [Swarm Multi-Agent Pattern](/docs/user-guide/sdk/multi-agent/swarm/index.md) (1 shared tag)
- [Agents as tools](/docs/user-guide/sdk/multi-agent/agents-as-tools/index.md) (1 shared tag)
- [Interrupts in Multi-Agent Systems](/docs/user-guide/sdk/interrupts-multi-agent/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/multiagent/base.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/base.py)
- [harness-sdk/strands-py/src/strands/multiagent/graph.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/graph.py)

### TypeScript

- [harness-sdk/strands-ts/src/multiagent/graph.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/multiagent/graph.ts)
