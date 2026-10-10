import { Agent } from '@strands-agents/sdk'
import { setupTracer, getTracer } from '@strands-agents/sdk/telemetry'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  ConsoleSpanExporter,
} from '@opentelemetry/sdk-trace-base'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'

async function codeConfigurationOption1() {
  // --8<-- [start:code_configuration_option1]
  // Option 1: Skip setupTracer() if a global tracer provider is already configured
  // (your existing OpenTelemetry setup will be used automatically)
  const agent = new Agent({
    systemPrompt: 'You are a helpful AI assistant',
  })
  // --8<-- [end:code_configuration_option1]
}

function codeConfigurationOption2() {
  // --8<-- [start:code_configuration_option2]
  // Option 2: Use setupTracer() to handle complete OpenTelemetry setup
  // (creates a new tracer provider and registers it as global)
  setupTracer({
    exporters: { otlp: true, console: true }, // Send traces to OTLP endpoint and console debug
  })
  // --8<-- [end:code_configuration_option2]
}

function codeConfigurationOption3() {
  // --8<-- [start:code_configuration_option3]
  // Option 3: Use setupTracer() with your own tracer provider
  const provider = new NodeTracerProvider()
  setupTracer({
    provider,
    exporters: { otlp: true, console: true },
  })
  // --8<-- [end:code_configuration_option3]
}

async function codeConfigurationAgent() {
  // --8<-- [start:code_configuration_agent]
  // Create agent (tracing will be enabled automatically)
  const agent = new Agent({
    systemPrompt: 'You are a helpful AI assistant',
  })

  // Use agent normally
  const result = await agent.invoke('What can you help me with?')
  // --8<-- [end:code_configuration_agent]
}

function consoleExporter() {
  // --8<-- [start:console_exporter]
  setupTracer({
    exporters: { console: true },
  })
  // --8<-- [end:console_exporter]
}

function customAttributes() {
  // --8<-- [start:custom_attributes]
  const agent = new Agent({
    systemPrompt: 'You are a helpful assistant that provides concise responses.',
    traceAttributes: {
      'session.id': 'abc-1234',
      'user.id': 'user-email-example@domain.com',
      tags: ['Agent-SDK', 'Okatank-Project', 'Observability-Tags'],
    },
  })
  // --8<-- [end:custom_attributes]
}

function configuringExporters() {
  // --8<-- [start:configuring_exporters]
  const provider = new NodeTracerProvider({
    spanProcessors: [
      // Configure OTLP endpoint programmatically
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: 'http://collector.example.com:4318/v1/traces',
          headers: { key1: 'value1', key2: 'value2' },
        })
      ),
      // Add console exporter for debugging
      new SimpleSpanProcessor(new ConsoleSpanExporter()),
    ],
  })

  // Register the provider with Strands
  setupTracer({ provider })
  // --8<-- [end:configuring_exporters]
}

function customSpans() {
  // --8<-- [start:custom_spans]
  // Set up telemetry first (or register your own NodeTracerProvider)
  setupTracer({ exporters: { otlp: true } })

  // Get a tracer and create custom spans
  const tracer = getTracer()
  const span = tracer.startSpan('my-custom-operation')
  span.setAttribute('custom.key', 'value')
  // ... do work ...
  span.end()
  // --8<-- [end:custom_spans]
}

async function endToEnd() {
  // --8<-- [start:end_to_end]
  // Set environment variables for OTLP endpoint
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318'

  // Configure telemetry
  setupTracer({
    exporters: { otlp: true, console: true },
  })

  // Create agent
  const agent = new Agent({
    systemPrompt: 'You are a helpful AI assistant',
  })

  // Execute interactions that will be traced
  const response = await agent.invoke(
    'Find me information about Mars. What is its atmosphere like?'
  )
  console.log(response)

  // Each interaction creates a complete trace that can be visualized in your tracing tool
  // --8<-- [end:end_to_end]
}
