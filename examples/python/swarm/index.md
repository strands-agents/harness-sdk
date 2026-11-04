## Overview

A Swarm is a collaborative agent orchestration system where multiple agents work together as a team to solve complex tasks. Unlike traditional sequential or hierarchical multi-agent systems, a Swarm enables autonomous coordination between agents with shared context and working memory.

Here’s an example of a swarm :

![Architecture](https://raw.githubusercontent.com/strands-agents/samples/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/11-swarm/images/swarm_example.png)

## Key Features

-   **Self-organizing agent teams** with shared working memory
-   **Tool-based coordination** between agents
-   **Autonomous agent collaboration** without central control
-   **Dynamic task distribution** based on agent capabilities
-   **Collective intelligence** through shared context
-   **Multi-modal input support** for handling text, images, and other content types

## Creating a Swarm

To create a Swarm, you need to define a collection of agents with different specializations:

```python
import logging
from strands import Agent
from strands.multiagent import Swarm

# Enable debug logs and print them to stderr
logging.getLogger("strands.multiagent").setLevel(logging.DEBUG)
logging.basicConfig(
    format="%(levelname)s | %(name)s | %(message)s",
    handlers=[logging.StreamHandler()]
)

# Create specialized agents
researcher = Agent(name="researcher", system_prompt="You are a research specialist...")
coder = Agent(name="coder", system_prompt="You are a coding specialist...")
reviewer = Agent(name="reviewer", system_prompt="You are a code review specialist...")
architect = Agent(name="architect", system_prompt="You are a system architecture specialist...")

# Create a swarm with these agents
swarm = Swarm(
    [researcher, coder, reviewer, architect],
    max_handoffs=20,
    max_iterations=20,
    execution_timeout=900.0,  # 15 minutes
    node_timeout=300.0,       # 5 minutes per agent
    repetitive_handoff_detection_window=8,  # There must be >= 3 unique agents in the last 8 handoffs
    repetitive_handoff_min_unique_agents=3
)

# Execute the swarm on a task
result = swarm("Design and implement a simple REST API for a todo app")

# Access the final result
print(f"Status: {result.status}")
print(f"Node history: {[node.node_id for node in result.node_history]}")
```

## Multi-Modal Input Support

Swarms support multi-modal inputs like text and images using ContentBlocks:

```python
from strands import Agent
from strands.multiagent import Swarm
from strands.types.content import ContentBlock

# Create agents for image processing workflow
image_analyzer = Agent(name="image_analyzer", system_prompt="You are an image analysis expert...")
report_writer = Agent(name="report_writer", system_prompt="You are a report writing expert...")

# Create the swarm
swarm = Swarm([image_analyzer, report_writer])

# Create content blocks with text and image
content_blocks = [
    ContentBlock(text="Analyze this image and create a report about what you see:"),
    ContentBlock(image={"format": "png", "source": {"bytes": image_bytes}}),
]

# Execute the swarm with multi-modal input
result = swarm(content_blocks)
```

## Swarm as a Tool

Agents can dynamically create and orchestrate swarms by using the `swarm` tool:

```python
from strands import Agent
from strands_tools import swarm

agent = Agent(tools=[swarm], system_prompt="Create a swarm of agents to solve the user's query.")

agent("Research, analyze, and summarize the latest advancements in quantum computing")
```

## Swarm Configuration

The Swarm constructor allows you to control the behavior and safety parameters:

| Parameter | Description | Default |
| --- | --- | --- |
| `max_handoffs` | Maximum number of agent handoffs allowed | 20 |
| `max_iterations` | Maximum total iterations across all agents | 20 |
| `execution_timeout` | Total execution timeout in seconds | 900.0 (15 min) |
| `node_timeout` | Individual agent timeout in seconds | 300.0 (5 min) |
| `repetitive_handoff_detection_window` | Number of recent nodes to check for ping-pong behavior | 0 (disabled) |
| `repetitive_handoff_min_unique_agents` | Minimum unique nodes required in recent sequence | 0 (disabled) |

## Swarm Coordination Tools

When you create a Swarm, each agent is automatically equipped with special tools for coordination:

### Handoff Tool

Agents can transfer control to another agent when they need specialized help:

```python
handoff_to_agent(
    agent_name="coder",
    message="I need help implementing this algorithm in Python",
    context={"algorithm_details": "..."}
)
```

## Asynchronous Execution

You can also execute a Swarm asynchronously:

```python
import asyncio

async def run_swarm():
    result = await swarm.invoke_async("Design and implement a complex system...")
    return result

result = asyncio.run(run_swarm())
```

## Swarm Results

When a Swarm completes execution, it returns a SwarmResult object with detailed information:

```python
result = swarm("Design a system architecture for...")

# Check execution status
print(f"Status: {result.status}")  # COMPLETED, FAILED, etc.

# See which agents were involved
for node in result.node_history:
    print(f"Agent: {node.node_id}")

# Get results from specific nodes
analyst_result = result.results["analyst"].result
print(f"Analysis: {analyst_result}")

# Get performance metrics
print(f"Total iterations: {result.execution_count}")
print(f"Execution time: {result.execution_time}ms")
print(f"Token usage: {result.accumulated_usage}")
```

## Safety Mechanisms

Swarms include several safety mechanisms to prevent infinite loops and ensure reliable execution:

1.  **Maximum handoffs**: Limits how many times control can be transferred between agents
2.  **Maximum iterations**: Caps the total number of execution iterations
3.  **Execution timeout**: Sets a maximum total runtime for the Swarm
4.  **Node timeout**: Limits how long any single agent can run
5.  **Repetitive handoff detection**: Prevents agents from endlessly passing control back and forth

## Best Practices

1.  **Create specialized agents**: Define clear roles for each agent in your Swarm
2.  **Use descriptive agent names**: Names should reflect the agent’s specialty
3.  **Set appropriate timeouts**: Adjust based on task complexity and expected runtime
4.  **Enable repetitive handoff detection**: Set appropriate values for `repetitive_handoff_detection_window` and `repetitive_handoff_min_unique_agents` to prevent ping-pong behavior
5.  **Include diverse expertise**: Ensure your Swarm has agents with complementary skills
6.  **Provide agent descriptions**: Add descriptions to your agents to help other agents understand their capabilities
7.  **Leverage multi-modal inputs**: Use ContentBlocks for rich inputs including images

## When to Use

-   Complex problem solving requiring multiple perspectives
-   Creative ideation and brainstorming
-   Comprehensive research and analysis
-   Decision making with multiple criteria
-   Tasks requiring specialized expertise from different domains

For more detailed information, please read the [documentation](https://strandsagents.com/latest/documentation/docs/user-guide/concepts/multi-agent/swarm/).

## Upstream source

- [View this sample at the imported commit](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/11-swarm)
