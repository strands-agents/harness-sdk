import { Agent } from '@strands-agents/sdk'
import { notebook } from '@strands-agents/sdk/vended-tools/notebook'

// Basic metrics example
async function basicMetricsExample() {
  // --8<-- [start:basic_metrics]
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
  // --8<-- [end:basic_metrics]
}

// Agent loop metrics example
async function agentLoopMetricsExample() {
  // --8<-- [start:agent_loop_metrics]
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
  // --8<-- [end:agent_loop_metrics]
}

// Local traces example
async function localTracesExample() {
  // --8<-- [start:local_traces]
  const agent = new Agent({
    tools: [notebook],
  })

  const result = await agent.invoke('What is 15 * 8 + 42?')

  // Access traces directly from the result
  console.log(JSON.stringify(result.traces))
  // --8<-- [end:local_traces]
}

// Metrics summary example
async function metricsSummaryExample() {
  // --8<-- [start:metrics_summary]
  const agent = new Agent({
    tools: [notebook],
  })

  const result = await agent.invoke('What is the square root of 144?')

  // Serialize metrics to JSON
  console.log(JSON.stringify(result?.metrics, null, 2))
  // --8<-- [end:metrics_summary]
}
