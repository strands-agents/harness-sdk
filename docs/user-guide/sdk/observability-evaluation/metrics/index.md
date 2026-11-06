To understand how your agent performs, tune its behavior, and watch resource usage, read the metrics the SDK records on every invocation. Strands tracks these metrics automatically and returns them with each result.

## Overview

(( tab "Python" ))
The Strands Agents SDK automatically tracks key metrics during agent execution:

-   **Token usage**: Input tokens, output tokens, total tokens consumed, and cache metrics
-   **Performance metrics**: Latency and execution time measurements
-   **Tool usage**: Call counts, success rates, and execution times for each tool
-   **Event loop cycles**: Number of event loop cycles and their durations

All these metrics are accessible through the [`AgentResult`](/docs/api/python/strands.agent.agent_result#AgentResult) object that’s returned whenever you invoke an agent. They are available for local analysis. To export them to an observability backend, configure Strands telemetry as described in the [Traces](/docs/user-guide/sdk/observability-evaluation/traces/index.md) documentation:

```python
from strands import Agent
from strands.vended_tools import notebook

# Create an agent with tools
agent = Agent(tools=[notebook])

# Invoke the agent with a prompt and get an AgentResult
result = agent('Create a notebook named "ideas" and add three project ideas.')

# Access metrics through the AgentResult
print(f"Total tokens: {result.metrics.accumulated_usage['totalTokens']}")
print(f"Execution time: {sum(result.metrics.cycle_durations):.2f} seconds")
print(f"Tools used: {list(result.metrics.tool_metrics.keys())}")

# Cache metrics (when available)
if 'cacheReadInputTokens' in result.metrics.accumulated_usage:
    print(f"Cache read tokens: {result.metrics.accumulated_usage['cacheReadInputTokens']}")
if 'cacheWriteInputTokens' in result.metrics.accumulated_usage:
    print(f"Cache write tokens: {result.metrics.accumulated_usage['cacheWriteInputTokens']}")
```

The `metrics` attribute of `AgentResult` (an instance of [`EventLoopMetrics`](/docs/api/python/strands.telemetry.metrics)) holds the performance data for the agent’s execution, while other attributes like `stop_reason`, `message`, and `state` provide context about the agent’s response. This document explains the metrics available in the agent’s response and how to interpret them.
(( /tab "Python" ))

(( tab "TypeScript" ))
The TypeScript SDK automatically tracks key metrics during agent execution through the `AgentMetrics` class:

-   **Token usage**: Input tokens, output tokens, total tokens consumed, and cache metrics
-   **Performance metrics**: Latency and execution time measurements
-   **Tool usage**: Call counts, success rates, and execution times for each tool
-   **Event loop cycles**: Number of event loop cycles and their durations

All these metrics are accessible through the `AgentResult` object returned when you invoke an agent:

```typescript
const agent = new Agent({
  tools: [notebook],
})

const result = await agent.invoke('What is the square root of 144?')

// Access metrics through the AgentResult
if (result.metrics) {
  console.log(`Total tokens: ${result.metrics.accumulatedUsage.totalTokens}`)
  console.log(`Total duration: ${result.metrics.totalDuration}ms`)
  console.log(`Tools used: ${Object.keys(result.metrics.toolMetrics)}`)

  // Cache metrics (when available)
  if (result.metrics.accumulatedUsage.cacheReadInputTokens) {
    console.log(
      `Cache read tokens: ${result.metrics.accumulatedUsage.cacheReadInputTokens}`
    )
  }
  if (result.metrics.accumulatedUsage.cacheWriteInputTokens) {
    console.log(
      `Cache write tokens: ${result.metrics.accumulatedUsage.cacheWriteInputTokens}`
    )
  }
}
```

The `metrics` property on `AgentResult` is an instance of `AgentMetrics` that holds the performance data for the agent’s execution.
(( /tab "TypeScript" ))

Input tokens and cached tokens

Providers differ on whether `inputTokens` includes cached tokens. Some count cache reads and writes inside `inputTokens`; others count them only in `cacheReadInputTokens` and `cacheWriteInputTokens`. `totalTokens` always includes cached tokens, so you can tell which applies: if `inputTokens + outputTokens` equals `totalTokens`, `inputTokens` already includes the cache fields. Otherwise, total input is `inputTokens + cacheReadInputTokens + cacheWriteInputTokens`. Adding the cache fields to an `inputTokens` that already includes them counts cached tokens twice.

The check holds for each model call. Accumulated usage from an agent that mixes providers can combine both conventions, so apply it per call in that case.

## Agent Loop Metrics

(( tab "Python" ))
The [`EventLoopMetrics`](/docs/api/python/strands.telemetry.metrics#EventLoopMetrics) class aggregates metrics across the entire event loop execution cycle, providing a complete picture of your agent’s performance. It tracks cycle counts, tool usage, execution durations, and token consumption across all model invocations.

Key metrics include:

-   **Cycle tracking**: Number of event loop cycles and their individual durations
-   **Tool metrics**: Detailed performance data for each tool used during execution
-   **Agent invocations**: List of agent invocations, each containing cycles and usage data for that specific invocation
-   **Accumulated usage**: Aggregated token counts (input, output, total, and cache metrics) across all agent invocations
-   **Accumulated metrics**: Latency measurements in milliseconds for all model requests
-   **Execution traces**: Detailed trace information for performance analysis

**Agent Invocations**

The `agent_invocations` property is a list of [`AgentInvocation`](/docs/api/python/strands.telemetry.metrics#AgentInvocation) objects that track metrics for each agent invocation (request). Each `AgentInvocation` contains:

-   **cycles**: A list of `EventLoopCycleMetric` objects, each representing a single event loop cycle with its ID and token usage
-   **usage**: Accumulated token usage for this specific invocation across all its cycles

This allows you to track metrics at both the individual invocation level and across all invocations:

```python
from strands import Agent
from strands.vended_tools import notebook

agent = Agent(tools=[notebook])

# First invocation
result1 = agent('Create a notebook named "ideas" and add three project ideas.')

# Second invocation
result2 = agent('Add two more ideas to the "ideas" notebook.')

# Access metrics for the latest invocation
latest_invocation = result2.metrics.latest_agent_invocation
cycles = latest_invocation.cycles
usage = latest_invocation.usage

# Or access all invocations
for invocation in result2.metrics.agent_invocations:
    print(f"Invocation usage: {invocation.usage}")
    for cycle in invocation.cycles:
        print(f"  Cycle {cycle.event_loop_cycle_id}: {cycle.usage}")

# Or print the summary (includes all invocations)
print(result2.metrics.get_summary())
```

For a complete list of attributes and their types, see the [`EventLoopMetrics` API reference](/docs/api/python/strands.telemetry.metrics#EventLoopMetrics).
(( /tab "Python" ))

(( tab "TypeScript" ))
The `AgentMetrics` class aggregates metrics across the entire agent loop execution, providing a complete picture of your agent’s performance. It tracks cycle counts, tool usage, execution durations, and token consumption across all model invocations.

Key metrics include:

-   **Cycle tracking**: Number of event loop cycles and their individual durations via `cycleCount`, `totalDuration`, and `averageCycleTime`
-   **Tool metrics**: Detailed performance data for each tool used during execution
-   **Agent invocations**: List of agent invocations, each containing cycles and usage data for that specific invocation
-   **Accumulated usage**: Aggregated token counts (input, output, total, and cache metrics) across all agent invocations
-   **Accumulated metrics**: Latency measurements in milliseconds for all model requests

**Agent Invocations**

The `agentInvocations` property is a list of `InvocationMetricsData` objects that track metrics for each agent invocation (request). Each invocation contains:

-   **cycles**: A list of `AgentLoopMetricsData` objects, each representing a single event loop cycle with its ID, duration, and token usage
-   **usage**: Accumulated token usage for this specific invocation across all its cycles

This allows you to track metrics at both the individual invocation level and across all invocations:

```typescript
const agent = new Agent({
  tools: [notebook],
})

// First invocation
const _result1 = await agent.invoke('What is 5 + 3?')

// Second invocation
const result2 = await agent.invoke('What is the square root of 144?')

// Access metrics for the latest invocation
if (result2.metrics) {
  const latest = result2.metrics.latestAgentInvocation
  if (latest) {
    console.log(`Invocation usage: ${JSON.stringify(latest.usage)}`)
    for (const cycle of latest.cycles) {
      console.log(`  Cycle ${cycle.cycleId}: ${JSON.stringify(cycle.usage)}`)
    }
  }

  // Access all invocations
  for (const invocation of result2.metrics.agentInvocations) {
    console.log(`Invocation usage: ${JSON.stringify(invocation.usage)}`)
    for (const cycle of invocation.cycles) {
      console.log(`  Cycle ${cycle.cycleId}: ${JSON.stringify(cycle.usage)}`)
    }
  }

  // Computed metrics
  console.log(`Cycle count: ${result2.metrics.cycleCount}`)
  console.log(`Total duration: ${result2.metrics.totalDuration}ms`)
  console.log(`Average cycle time: ${result2.metrics.averageCycleTime}ms`)
}
```
(( /tab "TypeScript" ))

## Tool Metrics

(( tab "Python" ))
For each tool used by the agent, detailed metrics are collected in the `tool_metrics` dictionary. Each entry is an instance of [`ToolMetrics`](/docs/api/python/strands.telemetry.metrics#ToolMetrics) that tracks the tool’s performance throughout the agent’s execution.

Tool metrics provide insights into:

-   **Call statistics**: Total number of calls, successful executions, and errors
-   **Execution time**: Total and average time spent executing the tool
-   **Success rate**: Percentage of successful tool invocations
-   **Tool reference**: Information about the specific tool being tracked

These metrics help you identify performance bottlenecks, tools with high error rates, and opportunities for optimization. For complete details on all available properties, see the [`ToolMetrics` API reference](/docs/api/python/strands.telemetry.metrics#ToolMetrics).
(( /tab "Python" ))

(( tab "TypeScript" ))
For each tool used by the agent, detailed metrics are collected in the `toolMetrics` dictionary. Each entry is a `ToolMetricsData` object that tracks the tool’s performance throughout the agent’s execution.

Tool metrics provide insights into:

-   **Call statistics**: Total number of calls, successful executions, and errors
-   **Execution time**: Total time spent executing the tool
-   **Computed statistics**: The `toolUsage` getter adds computed `averageTime` and `successRate` fields

These metrics help you identify performance bottlenecks, tools with high error rates, and opportunities for optimization.
(( /tab "TypeScript" ))

## Example Metrics Summary Output

(( tab "Python" ))
The `get_summary()` method on the `EventLoopMetrics` class gives you a full overview of your agent’s performance in a single call. It aggregates all the metrics data into a structured dictionary that’s easy to analyze or export.

Call `get_summary()` on the metrics from the notebook example at the beginning of this document:

```python
result = agent('Add two more ideas to the "ideas" notebook.')
print(result.metrics.get_summary())
```

Exact values depend on the model and runtime. The returned dictionary includes cycle information, token usage, tool performance, and detailed execution traces.
(( /tab "Python" ))

(( tab "TypeScript" ))
The `AgentMetrics` class implements `toJSON()`, so you can serialize the complete metrics summary with `JSON.stringify()`. This gives you a full overview of your agent’s performance in a single call:

```typescript
const agent = new Agent({
  tools: [notebook],
})

const result = await agent.invoke('What is the square root of 144?')

// Serialize metrics to JSON
console.log(JSON.stringify(result?.metrics, null, 2))
```

```json
{
  "cycleCount": 1,
  "accumulatedUsage": {
    "inputTokens": 16,
    "outputTokens": 29,
    "totalTokens": 45
  },
  "accumulatedMetrics": {
    "latencyMs": 1799
  },
  "agentInvocations": [
    {
      "usage": {
        "inputTokens": 16,
        "outputTokens": 29,
        "totalTokens": 45
      },
      "cycles": [
        {
          "cycleId": "cycle-1",
          "duration": 2694,
          "usage": {
            "inputTokens": 16,
            "outputTokens": 29,
            "totalTokens": 45
          }
        }
      ]
    }
  ],
  "toolMetrics": {}
}
```

This summary provides a complete picture of the agent’s execution, including cycle information, token usage, and tool performance.
(( /tab "TypeScript" ))

## Local Execution Traces

(( tab "Python" ))
In addition to aggregate metrics, the Strands Agents SDK automatically collects **local execution traces**: lightweight, in-memory timing trees that capture the hierarchy and duration of operations within the agent loop. These traces are always collected regardless of OpenTelemetry configuration and are returned directly in the `AgentResult`.

Each trace represents a cycle in the agent loop, with child traces for model invocations and tool calls:

```python
from strands import Agent
from strands.vended_tools import notebook

agent = Agent(tools=[notebook])
result = agent('Create a notebook named "ideas" and add three project ideas.')

# Traces are included in the summary output
print(result.metrics.get_summary())
```

Each trace contains:

-   **name**: Human-readable label (e.g., “Cycle 1”, “stream\_messages”, “Tool: notebook”)
-   **duration**: Execution time in seconds
-   **children**: Nested traces for operations within the cycle
-   **metadata**: Associated data like `cycleId`, `toolUseId`, and `toolName`
-   **message**: The model output message (for model invocation traces)

Traces are included in the `get_summary()` output, giving you a complete hierarchical view of agent execution alongside aggregate metrics.
(( /tab "Python" ))

(( tab "TypeScript" ))
In addition to aggregate metrics, the Strands Agents SDK automatically collects **local execution traces**: lightweight, in-memory timing trees that capture the hierarchy and duration of operations within the agent loop. These traces are always collected regardless of OpenTelemetry configuration and are returned directly in `AgentResult.traces`.

Each trace is an `AgentTrace` instance representing a cycle in the agent loop, with child traces for model invocations and tool calls:

```typescript
const agent = new Agent({
  tools: [notebook],
})

const result = await agent.invoke('What is 15 * 8 + 42?')

// Access traces directly from the result
console.log(JSON.stringify(result.traces))
```

Each `AgentTrace` contains:

-   **name**: Human-readable label (e.g., “Cycle 1”, “stream\_messages”, “Tool: notebook”)
-   **duration**: Execution time in milliseconds
-   **children**: Nested `AgentTrace` instances for operations within the cycle
-   **metadata**: Associated data like `cycleId`, `toolUseId`, and `toolName`
-   **message**: The model output message (for model invocation traces)

Traces are separate from `AgentMetrics` and are accessed via `result.traces`. `AgentResult.toJSON()` excludes traces and metrics by default to keep API responses lean, so access them directly via `result.traces` and `result.metrics`.
(( /tab "TypeScript" ))

## Best Practices

1.  **Monitor Token Usage**: Keep track of token usage to ensure you stay within limits and optimize costs. Set up alerts for when token usage approaches predefined thresholds to avoid unexpected costs.
    
2.  **Analyze Performance**: Review performance metrics across agents, tools, and execution stages to identify high error rates and latency bottlenecks. Calculate p50, p90, and p99 latency per stage and end-to-end over a rolling window aligned with your service level objectives (SLOs). Prioritize optimizing stages with both a significant contribution to end-to-end latency and meaningful optimization potential. For more information, see the [AWS Well-Architected Framework Agentic AI Lens AGENTPERF01-BP03](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentperf01-bp03.html).
    
3.  **Track Cycle Efficiency**: Monitor how many iterations the agent needed and how long each took. Agents that require many cycles may benefit from improved prompting or tool design.
    
4.  **Benchmark Latency Metrics**: Monitor latency values to establish performance baselines. Compare these metrics across different agent configurations to identify optimal setups.
    
5.  **Combine Technical Metrics with Business KPIs**: In addition to technical metrics, collect and analyze KPIs that measure business outcomes, such as resolution rate, escalation rate, customer satisfaction, and task completion. Track both types of metrics with equal weight to gain a more complete view of overall agent performance. For more information, see the [AWS Well-Architected Framework Agentic AI Lens Design Principles for Operational Excellence](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/operational-excellence-design-principles.html).
    
6.  **Regular Metrics Reviews**: Schedule periodic reviews of agent metrics to identify trends and opportunities for optimization. Look for gradual changes in performance that might indicate drift in tool behavior or model responses.

## Related pages

- [Evaluating remote traces](/docs/user-guide/evals-sdk/how-to/trace_providers/index.md) (1 shared tag)
- [Observability](/docs/user-guide/sdk/observability-evaluation/observability/index.md) (1 shared tag)
- [Observe your agent](/docs/user-guide/sdk/observability-evaluation/index.md) (1 shared tag)
- [Task decorator](/docs/user-guide/evals-sdk/how-to/eval_task/index.md) (1 shared tag)
- [Traces](/docs/user-guide/sdk/observability-evaluation/traces/index.md) (1 shared tag)
- [Bidirectional Streaming Observability](/docs/user-guide/sdk/bidi/observability/index.md) (1 shared tag)
- [Logging](/docs/user-guide/sdk/observability-evaluation/logs/index.md) (1 shared tag)
- [Operating Agents in Production](/docs/user-guide/sdk/deploy/operating-agents-in-production/index.md) (1 shared tag)
- [Root cause analysis](/docs/user-guide/evals-sdk/detectors/root_cause_analysis/index.md) (1 shared tag)
- [Session diagnosis](/docs/user-guide/evals-sdk/detectors/diagnosis/index.md) (1 shared tag)
