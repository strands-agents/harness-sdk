import { Agent } from '@strands-agents/sdk'
import { setupTracer } from '@strands-agents/sdk/telemetry'

async function observeAgent() {
  // --8<-- [start:observe_agent]
  // Print every span to the console; swap console for otlp to ship to a collector
  setupTracer({ exporters: { console: true } })

  const agent = new Agent()
  await agent.invoke('What is agent observability?')
  // --8<-- [end:observe_agent]
}
