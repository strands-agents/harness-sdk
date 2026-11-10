/**
 * Telemetry example using your own NodeTracerProvider.
 *
 * Use this approach when you need full control over the OpenTelemetry setup —
 * for example, to add custom span processors, use a specific resource
 * configuration, or integrate with an existing observability pipeline.
 *
 * The Agent class uses the global OTel API (`trace.getTracer(...)`) internally,
 * so any provider registered via `provider.register()` is automatically picked
 * up — no need to pass it to the SDK.
 *
 * Run with OTLP exporter (e.g. Jaeger at localhost:4318):
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 npm run start:custom-provider
 *
 * Run with console exporter for local debugging:
 *   npm run start:custom-provider
 */

import { Agent, tool } from '@strands-agents/sdk'
import { z } from 'zod'

// OpenTelemetry imports — you manage these directly
import { Resource } from '@opentelemetry/resources'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { SimpleSpanProcessor, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'

// 1. Create your own Resource with custom attributes.
const resource = new Resource({
  'service.name': 'my-custom-app',
  'service.version': '2.0.0',
  'service.namespace': 'my-team',
  'deployment.environment': 'staging',
  'custom.attribute': 'hello-from-custom-provider',
})

// 2. Create and configure your own NodeTracerProvider.
const provider = new NodeTracerProvider({ resource })

// 3. Add span processors / exporters as needed.
//    - ConsoleSpanExporter: prints spans to stdout (useful for debugging)
//    - OTLPTraceExporter: sends spans to an OTLP-compatible backend
provider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()))

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  provider.addSpanProcessor(new BatchSpanProcessor(new OTLPTraceExporter()))
}

// 4. Register the provider globally.
//    This sets up the global tracer provider, context manager, and propagators.
//    The Strands Agent will automatically pick it up via `trace.getTracer(...)`.
provider.register()

console.log('=== Custom Provider Resource Attributes ===\n')
for (const [key, value] of Object.entries(provider.resource.attributes)) {
  console.log(`  ${key}: ${value}`)
}
console.log('')

// 5. Define tools as usual — nothing changes on the application side.
const calculateTool = tool({
  name: 'calculate',
  description: 'Perform a basic arithmetic calculation.',
  inputSchema: z.object({
    expression: z.string().describe('A math expression, e.g., "2 + 2"'),
  }),
  callback: (input) => {
    try {
      // Simple eval for demo purposes only
      const result = Function(`"use strict"; return (${input.expression})`)()
      return `${input.expression} = ${result}`
    } catch {
      return `Could not evaluate: ${input.expression}`
    }
  },
})

const greetTool = tool({
  name: 'greet',
  description: 'Generate a greeting for a person.',
  inputSchema: z.object({
    name: z.string().describe('The name of the person to greet'),
  }),
  callback: (input) => {
    return `Hello, ${input.name}! Welcome aboard.`
  },
})

async function main() {
  // 6. Create an agent — it automatically uses your custom provider.
  const agent = new Agent({
    name: 'custom-traced-agent',
    systemPrompt:
      'You are a helpful assistant. Use the calculate tool for math questions and the greet tool to greet people.',
    tools: [calculateTool, greetTool],
    traceAttributes: {
      'app.example': 'custom-provider',
    },
  })

  console.log('=== Invoking Agent ===\n')
  const result = await agent.invoke('Please greet Alice, then calculate 42 * 17 for me.')
  console.log(`\nStop reason: ${result.stopReason}`)

  // 7. Flush and shut down the provider when done.
  //    This ensures all buffered spans are exported before the process exits.
  await provider.forceFlush()
  await provider.shutdown()

  console.log('\nDone! Check your observability backend for traces.')
}

await main().catch(console.error)
