import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { logger, resetWarnOnce } from '../src/logging.js'
import { resetTelemetry, setupTelemetry, TRACES_EXPORTER_ENV_VAR } from '../src/telemetry.js'

// Spy on the SDK's setupTracer so these pin the harness's gating decision (which exporters get wired, and
// how often), not the SDK's exporter wiring.
const setupTracer = vi.fn()
vi.mock('@strands-agents/sdk/telemetry', () => ({ setupTracer: (...args: unknown[]) => setupTracer(...args) }))

describe('setupTelemetry', () => {
  beforeEach(() => {
    delete process.env[TRACES_EXPORTER_ENV_VAR]
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    setupTracer.mockClear()
    resetTelemetry()
    resetWarnOnce()
  })

  afterEach(() => {
    delete process.env[TRACES_EXPORTER_ENV_VAR]
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    resetTelemetry()
    resetWarnOnce()
  })

  it('configures nothing without a selector', async () => {
    await setupTelemetry()
    expect(setupTracer).not.toHaveBeenCalled()
  })

  it('does not enable tracing from an endpoint alone', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318'
    await setupTelemetry()
    expect(setupTracer).not.toHaveBeenCalled()
  })

  it('wires the OTLP exporter from the selector', async () => {
    process.env.OTEL_TRACES_EXPORTER = 'otlp'
    await setupTelemetry()
    expect(setupTracer).toHaveBeenCalledWith({ exporters: { otlp: true, console: false } })
  })

  it('wires the console exporter from the selector', async () => {
    process.env.OTEL_TRACES_EXPORTER = 'console'
    await setupTelemetry()
    expect(setupTracer).toHaveBeenCalledWith({ exporters: { otlp: false, console: true } })
  })

  it('wires both when the selector lists them', async () => {
    process.env.OTEL_TRACES_EXPORTER = 'otlp, console'
    await setupTelemetry()
    expect(setupTracer).toHaveBeenCalledWith({ exporters: { otlp: true, console: true } })
  })

  it('disables tracing when the selector is none', async () => {
    process.env.OTEL_TRACES_EXPORTER = 'none'
    await setupTelemetry()
    expect(setupTracer).not.toHaveBeenCalled()
  })

  it('warns and skips an unsupported exporter', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    process.env.OTEL_TRACES_EXPORTER = 'zipkin'
    await setupTelemetry()
    expect(setupTracer).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('zipkin'))
    warn.mockRestore()
  })

  it('still wires the supported exporters alongside an unsupported one', async () => {
    process.env.OTEL_TRACES_EXPORTER = 'zipkin,otlp'
    await setupTelemetry()
    expect(setupTracer).toHaveBeenCalledWith({ exporters: { otlp: true, console: false } })
  })

  it('runs once per process', async () => {
    process.env.OTEL_TRACES_EXPORTER = 'otlp'
    await setupTelemetry()
    await setupTelemetry()
    await setupTelemetry()
    expect(setupTracer).toHaveBeenCalledOnce()
  })
})
