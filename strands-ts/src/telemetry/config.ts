/**
 * OpenTelemetry configuration and setup utilities for Strands agents.
 *
 * Provides {@link setupTracer} for distributed tracing and {@link setupMeter}
 * for OTEL metrics export. Both use the global OTel API so any provider
 * registered here (or by the user) is automatically picked up by the Agent.
 *
 * This module is only loaded when the user explicitly imports and calls
 * {@link setupTracer} or {@link setupMeter}. The core agent loop
 * (tracer.ts, meter.ts) does not depend on this module.
 *
 * Uses NodeTracerProvider when available for async context propagation
 * across MCP server boundaries. Falls back to BasicTracerProvider in
 * environments without async_hooks support.
 */

import { context as otelContext, metrics as otelMetrics, propagation, trace } from '@opentelemetry/api'
import type {
  ContextManager,
  Meter as OtelMeter,
  TextMapPropagator,
  TracerProvider,
  Tracer as OtelTracer,
} from '@opentelemetry/api'
import { resourceFromAttributes, envDetector, type Resource } from '@opentelemetry/resources'
import {
  BasicTracerProvider,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  BatchSpanProcessor,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  ConsoleMetricExporter,
  type MetricReader,
} from '@opentelemetry/sdk-metrics'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { logger } from '../logging/index.js'
import { getServiceName } from './utils.js'

let DefaultTracerProvider: typeof BasicTracerProvider = BasicTracerProvider
let DefaultContextManager: (new () => ContextManager) | undefined
let DefaultPropagator: TextMapPropagator | undefined
let BaggageSpanProcessorModule: typeof import('@opentelemetry/baggage-span-processor') | undefined
if (typeof globalThis.process?.getBuiltinModule === 'function') {
  try {
    const nodeModule = globalThis.process.getBuiltinModule('node:module') as typeof import('module') | undefined
    if (nodeModule) {
      const req = nodeModule.createRequire(import.meta.url)
      try {
        BaggageSpanProcessorModule = req('@opentelemetry/baggage-span-processor')
      } catch {
        // Optional peer dependency; setupTracer throws if baggageProcessor is requested without it.
      }
      DefaultTracerProvider = req('@opentelemetry/sdk-trace-node').NodeTracerProvider
      DefaultContextManager = req('@opentelemetry/context-async-hooks').AsyncLocalStorageContextManager
      const { W3CTraceContextPropagator, W3CBaggagePropagator, CompositePropagator } = req('@opentelemetry/core')
      DefaultPropagator = new CompositePropagator({
        propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
      })
    }
  } catch {
    logger.info('sdk-trace-node not available | using BasicTracerProvider without async context propagation')
  }
}

export type BaggageKeyPredicate = (key: string) => boolean
export type BaggageKeyPredicates = BaggageKeyPredicate | readonly BaggageKeyPredicate[]

const DEFAULT_SERVICE_NAMESPACE = 'strands'
const DEFAULT_DEPLOYMENT_ENVIRONMENT = 'development'

/**
 * Get an OpenTelemetry Tracer instance.
 *
 * Wraps the OTel trace API to provide a consistent tracer scoped to the
 * configured service name.
 *
 * @returns An OTel Tracer instance from the global tracer provider
 *
 * @example
 * ```typescript
 * import { setupTracer, getTracer } from '@strands-agents/sdk/telemetry'
 *
 * // Set up telemetry first (or register your own NodeTracerProvider)
 * setupTracer({ exporters: { otlp: true } })
 *
 * // Get a tracer and create custom spans
 * const tracer = getTracer()
 * const span = tracer.startSpan('my-custom-operation')
 * span.setAttribute('custom.key', 'value')
 *
 * // ........
 *
 * span.end()
 * ```
 */
export function getTracer(): OtelTracer {
  return trace.getTracer(getServiceName())
}

/**
 * Get an OpenTelemetry Meter instance.
 *
 * Wraps the OTel metrics API to provide a consistent meter scoped to the
 * configured service name. Returns a no-op meter until a MeterProvider is
 * registered (either via {@link setupMeter} or by the user directly).
 *
 * @returns An OTel Meter instance from the global meter provider
 *
 * @example
 * ```typescript
 * import { setupMeter, getMeter } from '@strands-agents/sdk/telemetry'
 *
 * setupMeter({ exporters: { otlp: true } })
 *
 * const meter = getMeter()
 * const counter = meter.createCounter('my.custom.counter')
 * counter.add(1)
 * ```
 */
export function getMeter(): OtelMeter {
  return otelMetrics.getMeter(getServiceName())
}

/**
 * Configuration options for setting up the tracer.
 */
export interface TracerConfig {
  /**
   * Custom TracerProvider instance. If not provided, NodeTracerProvider is
   * used when available, otherwise BasicTracerProvider.
   */
  provider?: TracerProvider

  /**
   * Exporter configuration.
   */
  exporters?: {
    /**
     * Enable OTLP exporter. Uses OTEL_EXPORTER_OTLP_ENDPOINT and
     * OTEL_EXPORTER_OTLP_HEADERS env vars automatically.
     */
    otlp?: boolean
    /**
     * Enable console exporter for debugging.
     */
    console?: boolean
  }

  /**
   * Stamp OTel baggage entries onto spans as attributes: `true` for every key, or predicate(s) selecting keys.
   * Requires the optional `@opentelemetry/baggage-span-processor` package on Node.js, otherwise `setupTracer` throws.
   * Ignored when `provider` is passed; add a `BaggageSpanProcessor` to that provider yourself.
   */
  baggageProcessor?: boolean | BaggageKeyPredicates
}

let _provider: BasicTracerProvider | null = null
let _customProvider: TracerProvider | null = null

/**
 * Set up the tracer provider with the given configuration.
 *
 * When called without a custom provider, returns a BasicTracerProvider and
 * registers the async context manager + W3C propagators for trace propagation.
 * When a custom provider is passed, the caller is responsible for their own
 * context manager / propagator setup (e.g. via provider.register()).
 *
 * @param config - Tracer configuration options
 * @returns The configured tracer provider
 *
 * @example
 * ```typescript
 * import { telemetry } from '\@strands-agents/sdk'
 *
 * telemetry.setupTracer({ exporters: { otlp: true } })
 * ```
 */
export function setupTracer(config?: Omit<TracerConfig, 'provider'>): BasicTracerProvider
export function setupTracer(config: TracerConfig): TracerProvider
export function setupTracer(config: TracerConfig = {}): TracerProvider {
  if (_provider || _customProvider) {
    logger.warn('tracer provider already initialized, returning existing provider')
    return _customProvider ?? _provider!
  }

  if (config.provider) {
    if (config.baggageProcessor) {
      logger.warn(
        'baggage_processor=<ignored> | custom provider is owned by the caller, add BaggageSpanProcessor to it'
      )
    }
    _customProvider = config.provider
    trace.setGlobalTracerProvider(_customProvider)
    return _customProvider
  }

  const spanProcessors: SpanProcessor[] = []
  if (config.baggageProcessor) spanProcessors.push(createBaggageProcessor(config.baggageProcessor))
  if (config.exporters?.otlp) spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter()))
  if (config.exporters?.console) spanProcessors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()))
  _provider = new DefaultTracerProvider({ resource: getOtelResource(), spanProcessors })

  trace.setGlobalTracerProvider(_provider)
  if (DefaultContextManager) otelContext.setGlobalContextManager(new DefaultContextManager())
  if (DefaultPropagator) propagation.setGlobalPropagator(DefaultPropagator)

  if (typeof globalThis.process?.once === 'function') {
    globalThis.process.once('beforeExit', () => {
      _provider?.forceFlush()?.catch((err: unknown) => {
        logger.warn(`error=<${err}> | failed to flush tracer provider on exit`)
      })
    })
  }

  return _provider
}

// Returns the baggage span processor for `option`; throws if its optional package is missing.
function createBaggageProcessor(option: true | BaggageKeyPredicates): SpanProcessor {
  if (!BaggageSpanProcessorModule) {
    throw new Error(
      'baggageProcessor requires @opentelemetry/baggage-span-processor in a Node.js runtime: npm install @opentelemetry/baggage-span-processor'
    )
  }
  const { BaggageSpanProcessor, ALLOW_ALL_BAGGAGE_KEYS } = BaggageSpanProcessorModule
  const predicates = option === true ? undefined : [option].flat()
  logger.info('enabling baggage span processor')
  return new BaggageSpanProcessor(
    predicates ? (key: string): boolean => predicates.some((predicate) => predicate(key)) : ALLOW_ALL_BAGGAGE_KEYS
  )
}

/**
 * Configuration options for setting up the OTEL meter provider.
 */
export interface MeterConfig {
  /**
   * Custom MeterProvider instance. When provided, it is registered as the
   * global meter provider and the SDK will not create one internally.
   */
  provider?: MeterProvider

  /**
   * Exporter configuration.
   */
  exporters?: {
    /**
     * Enable OTLP exporter. Uses OTEL_EXPORTER_OTLP_ENDPOINT and
     * OTEL_EXPORTER_OTLP_HEADERS env vars automatically.
     */
    otlp?: boolean
    /**
     * Enable console exporter for debugging.
     */
    console?: boolean
  }
}

let _meterProvider: MeterProvider | null = null

/**
 * Set up the OTEL meter provider with the given configuration.
 *
 * @param config - Meter configuration options
 * @returns The configured meter provider
 *
 * @example
 * ```typescript
 * import { telemetry } from '\@strands-agents/sdk'
 *
 * telemetry.setupMeter({ exporters: { otlp: true } })
 * ```
 */
export function setupMeter(config: MeterConfig = {}): MeterProvider {
  if (_meterProvider) {
    logger.warn('meter provider already initialized, returning existing provider')
    return _meterProvider
  }

  if (config.provider) {
    _meterProvider = config.provider
  } else {
    const readers: MetricReader[] = []
    if (config.exporters?.otlp) readers.push(new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() }))
    if (config.exporters?.console)
      readers.push(new PeriodicExportingMetricReader({ exporter: new ConsoleMetricExporter() }))
    _meterProvider = new MeterProvider({ resource: getOtelResource(), readers })
  }

  otelMetrics.setGlobalMeterProvider(_meterProvider)

  if (typeof globalThis.process?.once === 'function') {
    globalThis.process.once('beforeExit', () => {
      if (_meterProvider) {
        _meterProvider.forceFlush().catch((err: unknown) => {
          logger.warn(`error=<${err}> | failed to flush meter provider on exit`)
        })
      }
    })
  }

  return _meterProvider
}

function getOtelResource(): Resource {
  const serviceName = getServiceName()
  const serviceNamespace = globalThis.process?.env?.OTEL_SERVICE_NAMESPACE || DEFAULT_SERVICE_NAMESPACE
  const deploymentEnvironment = globalThis.process?.env?.OTEL_DEPLOYMENT_ENVIRONMENT || DEFAULT_DEPLOYMENT_ENVIRONMENT

  const envAttributes = envDetector.detect().attributes ?? {}
  return resourceFromAttributes({
    'service.name': serviceName,
    'service.namespace': serviceNamespace,
    'deployment.environment': deploymentEnvironment,
    'telemetry.sdk.name': 'opentelemetry',
    'telemetry.sdk.language': 'typescript',
    ...envAttributes,
  })
}
