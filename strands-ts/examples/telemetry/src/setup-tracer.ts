/**
 * Telemetry example using the built-in setupTracer() helper.
 *
 * This is the recommended approach for most use cases. The SDK creates and
 * configures a NodeTracerProvider internally, and the Agent automatically
 * traces all invocations, model calls, and tool executions.
 *
 * Run with OTLP exporter (e.g. Jaeger at localhost:4318):
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 npm start
 *
 * Run with console exporter for local debugging:
 *   npm start
 *
 * Customize resource attributes:
 *   OTEL_SERVICE_NAME=my-app \
 *   OTEL_RESOURCE_ATTRIBUTES="service.version=1.0.0,team=platform" \
 *   npm start
 */

import { Agent, tool } from '@strands-agents/sdk'
import { setupTracer } from '@strands-agents/sdk/telemetry'
import { z } from 'zod'

// 1. Set up telemetry ONCE at application start.
//    setupTracer() creates a NodeTracerProvider with sensible defaults and
//    registers it globally. All agents will automatically pick it up.
const provider = setupTracer({
  exporters: {
    // Send spans to an OTLP-compatible backend (Jaeger, Grafana, etc.)
    // Uses OTEL_EXPORTER_OTLP_ENDPOINT env var for the endpoint.
    otlp: true,
    // Also print spans to the console for local debugging.
    console: true,
  },
})

// You can inspect the resource attributes that will be attached to all spans.
console.log('=== Resource Attributes ===\n')
for (const [key, value] of Object.entries(provider.resource.attributes)) {
  console.log(`  ${key}: ${value}`)
}
console.log('')

// 2. Define tools as usual
const getWeather = tool({
  name: 'get_weather',
  description: 'Get the current weather for a specific location.',
  inputSchema: z.object({
    location: z.string().describe('The city and state, e.g., San Francisco, CA'),
  }),
  callback: (input) => {
    return `The weather in ${input.location} is 72°F and sunny.`
  },
})

const getTime = tool({
  name: 'get_time',
  description: 'Get the current time for a timezone.',
  inputSchema: z.object({
    timezone: z.string().describe('The timezone, e.g., America/New_York'),
  }),
  callback: (input) => {
    return `The current time in ${input.timezone} is 3:00 PM.`
  },
})

async function main() {
  // 3. Create agents — telemetry is automatically active.
  //    Use `name` and `traceAttributes` for richer trace metadata.
  const weatherAgent = new Agent({
    name: 'weather-agent',
    systemPrompt: 'You are a helpful weather assistant. Use the get_weather tool to answer questions.',
    tools: [getWeather],
    traceAttributes: { 'app.module': 'weather' },
  })

  const timeAgent = new Agent({
    name: 'time-agent',
    systemPrompt: 'You are a helpful time assistant. Use the get_time tool to answer questions.',
    tools: [getTime],
    traceAttributes: { 'app.module': 'time' },
  })

  // 4. Invoke agents — each creates its own trace with nested spans for
  //    agent invocation, loop cycles, model calls, and tool executions.
  console.log('=== Running Weather Agent ===\n')
  const weatherResult = await weatherAgent.invoke('What is the weather in Seattle?')
  console.log(`\nWeather agent stop reason: ${weatherResult.stopReason}\n`)

  console.log('=== Running Time Agent ===\n')
  const timeResult = await timeAgent.invoke('What time is it in Tokyo?')
  console.log(`\nTime agent stop reason: ${timeResult.stopReason}\n`)

  // 5. Agents can also run concurrently — traces remain isolated.
  console.log('=== Running Both Agents Concurrently ===\n')
  const [concurrentWeather, concurrentTime] = await Promise.all([
    weatherAgent.invoke('What is the weather in New York?'),
    timeAgent.invoke('What time is it in London?'),
  ])

  console.log(`\nConcurrent weather stop reason: ${concurrentWeather.stopReason}`)
  console.log(`Concurrent time stop reason: ${concurrentTime.stopReason}`)
  console.log('\nDone! Check your observability backend for traces.')
}

await main().catch(console.error)
