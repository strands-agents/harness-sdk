import { createRequire } from 'node:module'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Attributes, Tracer } from '@opentelemetry/api'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-base'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { findMetricValue } from '../../__fixtures__/metrics-helpers.js'

vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: vi.fn(),
}))

vi.mock('@opentelemetry/sdk-trace-base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opentelemetry/sdk-trace-base')>()
  return {
    ...actual,
    ConsoleSpanExporter: vi.fn(),
  }
})

// resetModules clears the module cache so each test gets a fresh singleton.
// Tests use dynamic await import() to re-import after the reset.

describe('setupTracer (node-specific)', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  describe('provider auto-detection', () => {
    it('should use NodeTracerProvider by default for async context support', async () => {
      const telemetry = await import('../index.js')

      const provider = telemetry.setupTracer()

      expect(provider).toBeInstanceOf(NodeTracerProvider)
    })

    it('should accept a custom NodeTracerProvider', async () => {
      const telemetry = await import('../index.js')
      const customProvider = new NodeTracerProvider()

      const provider = telemetry.setupTracer({ provider: customProvider })

      expect(provider).toBe(customProvider)
    })
  })

  describe('exporter configuration', () => {
    it('should add OTLP exporter when exporters.otlp is true', async () => {
      const telemetry = await import('../index.js')

      telemetry.setupTracer({ exporters: { otlp: true } })

      expect(OTLPTraceExporter).toHaveBeenCalled()
    })

    it('should add console exporter when exporters.console is true', async () => {
      const telemetry = await import('../index.js')

      telemetry.setupTracer({ exporters: { console: true } })

      expect(ConsoleSpanExporter).toHaveBeenCalled()
    })

    it('should add both exporters when both are true', async () => {
      const telemetry = await import('../index.js')

      telemetry.setupTracer({ exporters: { otlp: true, console: true } })

      expect(OTLPTraceExporter).toHaveBeenCalled()
      expect(ConsoleSpanExporter).toHaveBeenCalled()
    })

    it('should add no exporters when both are false', async () => {
      const telemetry = await import('../index.js')

      telemetry.setupTracer({ exporters: { otlp: false, console: false } })

      expect(OTLPTraceExporter).not.toHaveBeenCalled()
      expect(ConsoleSpanExporter).not.toHaveBeenCalled()
    })

    it('should add no exporters when exporters config is empty', async () => {
      const telemetry = await import('../index.js')

      telemetry.setupTracer({})

      expect(OTLPTraceExporter).not.toHaveBeenCalled()
      expect(ConsoleSpanExporter).not.toHaveBeenCalled()
    })
  })

  describe('resource attributes from environment', () => {
    it('should use OTEL_SERVICE_NAME when set', async () => {
      process.env.OTEL_SERVICE_NAME = 'my-custom-service'
      const telemetry = await import('../index.js')

      const provider = telemetry.setupTracer()

      expect(provider['_resource'].attributes['service.name']).toBe('my-custom-service')
    })

    it('should use OTEL_SERVICE_NAMESPACE when set', async () => {
      process.env.OTEL_SERVICE_NAMESPACE = 'my-namespace'
      const telemetry = await import('../index.js')

      const provider = telemetry.setupTracer()

      expect(provider['_resource'].attributes['service.namespace']).toBe('my-namespace')
    })

    it('should use OTEL_DEPLOYMENT_ENVIRONMENT when set', async () => {
      process.env.OTEL_DEPLOYMENT_ENVIRONMENT = 'production'
      const telemetry = await import('../index.js')

      const provider = telemetry.setupTracer()

      expect(provider['_resource'].attributes['deployment.environment']).toBe('production')
    })

    it('should merge OTEL_RESOURCE_ATTRIBUTES with defaults', async () => {
      process.env.OTEL_RESOURCE_ATTRIBUTES = 'service.version=1.0.0,custom.team=platform'
      const telemetry = await import('../index.js')

      const provider = telemetry.setupTracer()

      expect(provider['_resource'].attributes['service.version']).toBe('1.0.0')
      expect(provider['_resource'].attributes['custom.team']).toBe('platform')
      expect(provider['_resource'].attributes['service.name']).toBe('strands-agents')
    })

    it('should allow OTEL_RESOURCE_ATTRIBUTES to override defaults', async () => {
      process.env.OTEL_RESOURCE_ATTRIBUTES = 'service.name=custom-service,deployment.environment=production'
      const telemetry = await import('../index.js')

      const provider = telemetry.setupTracer()

      expect(provider['_resource'].attributes['service.name']).toBe('custom-service')
      expect(provider['_resource'].attributes['deployment.environment']).toBe('production')
    })
  })
})

describe('setupMeter (node-specific)', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  describe('resource attributes from environment', () => {
    it('should use OTEL_SERVICE_NAME when set', async () => {
      process.env.OTEL_SERVICE_NAME = 'my-meter-service'
      const { MeterProvider, InMemoryMetricExporter, PeriodicExportingMetricReader, AggregationTemporality } =
        await import('@opentelemetry/sdk-metrics')
      const { resourceFromAttributes } = await import('@opentelemetry/resources')
      const telemetry = await import('../index.js')

      const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
      const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 100 })
      const customProvider = new MeterProvider({
        resource: resourceFromAttributes({ 'service.name': 'my-meter-service' }),
        readers: [reader],
      })
      const provider = telemetry.setupMeter({ provider: customProvider })

      provider.getMeter('test').createCounter('probe').add(1)
      await provider.forceFlush()

      const resource = exporter.getMetrics().at(-1)?.resource
      expect(resource?.attributes['service.name']).toBe('my-meter-service')

      await provider.shutdown()
    })
  })

  describe('global meter provider registration', () => {
    it('returns a provider that produces real metrics via its own meter', async () => {
      const {
        MeterProvider: SdkMeterProvider,
        InMemoryMetricExporter,
        PeriodicExportingMetricReader,
        AggregationTemporality,
      } = await import('@opentelemetry/sdk-metrics')
      const telemetry = await import('../index.js')

      const testExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
      const testReader = new PeriodicExportingMetricReader({
        exporter: testExporter,
        exportIntervalMillis: 100,
      })
      const testProvider = new SdkMeterProvider({ readers: [testReader] })

      const provider = telemetry.setupMeter({ provider: testProvider })

      const meter = provider.getMeter('test-registration')
      const counter = meter.createCounter('test_registration_counter')
      counter.add(42)

      await testProvider.forceFlush()

      expect(findMetricValue(testExporter.getMetrics(), 'test_registration_counter')).toBe(42)

      await testProvider.shutdown()
    })
  })

  describe('custom provider', () => {
    it('accepts a custom MeterProvider', async () => {
      const { MeterProvider } = await import('@opentelemetry/sdk-metrics')
      const telemetry = await import('../index.js')
      const customProvider = new MeterProvider()

      const provider = telemetry.setupMeter({ provider: customProvider })

      expect(provider).toBe(customProvider)
    })
  })
})

describe('setupTracer baggageProcessor (node-specific)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  // Starts a span under baggage {tenant.id, session.id, other} and returns its stamped attributes.
  async function stampedAttributes(provider: { getTracer(name: string): Tracer }): Promise<Attributes> {
    const { context, propagation } = await import('@opentelemetry/api')
    const baggage = propagation.createBaggage({
      'tenant.id': { value: 'acme' },
      'session.id': { value: 's-1' },
      other: { value: 'x' },
    })
    const span = provider.getTracer('test').startSpan('probe', {}, propagation.setBaggage(context.active(), baggage))
    span.end()
    return (span as unknown as { attributes: Attributes }).attributes
  }

  it.each([
    ['true', true as const, { 'tenant.id': 'acme', 'session.id': 's-1', other: 'x' }],
    ['a single predicate', (key: string) => key.startsWith('tenant.'), { 'tenant.id': 'acme' }],
    [
      'a predicate list',
      [(key: string) => key === 'session.id', (key: string) => key.startsWith('tenant.')],
      { 'tenant.id': 'acme', 'session.id': 's-1' },
    ],
  ])('stamps baggage selected by %s onto spans', async (_, baggageProcessor, expected) => {
    const telemetry = await import('../index.js')

    const provider = telemetry.setupTracer({ baggageProcessor })

    expect(await stampedAttributes(provider)).toStrictEqual(expected)
  })

  it('throws when its package is absent without breaking the other Node.js defaults', async () => {
    const realRequire = createRequire(import.meta.url)
    vi.spyOn(process, 'getBuiltinModule').mockReturnValueOnce({
      createRequire: () => (id: string) => {
        if (id === '@opentelemetry/baggage-span-processor') throw new Error('Cannot find module')
        return realRequire(id)
      },
    } as never)
    const telemetry = await import('../index.js')

    expect(() => telemetry.setupTracer({ baggageProcessor: true })).toThrow(
      'npm install @opentelemetry/baggage-span-processor'
    )
    expect(telemetry.setupTracer()).toBeInstanceOf(NodeTracerProvider)
  })

  it('warns that it is ignored when a custom provider is passed', async () => {
    const { logger } = await import('../../logging/index.js')
    const warnSpy = vi.spyOn(logger, 'warn')
    const telemetry = await import('../index.js')

    const provider = telemetry.setupTracer({ provider: new NodeTracerProvider(), baggageProcessor: true })

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('baggage_processor=<ignored>'))
    expect(await stampedAttributes(provider)).toStrictEqual({})
  })
})
