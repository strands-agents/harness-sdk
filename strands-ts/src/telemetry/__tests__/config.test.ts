import { describe, it, expect, beforeEach, vi } from 'vitest'

// resetModules clears the module cache so each test gets a fresh singleton.
// Tests use dynamic await import() to re-import after the reset.

describe('setupTracer', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  describe('singleton behavior', () => {
    it('should return the same provider instance when called twice', async () => {
      const telemetry = await import('../index.js')

      const provider1 = telemetry.setupTracer({ exporters: { console: true } })
      const provider2 = telemetry.setupTracer({ exporters: { otlp: true } })

      expect(provider1).toBe(provider2)
    })

    it('should log a warning when called twice', async () => {
      const { logger } = await import('../../logging/index.js')
      const warnSpy = vi.spyOn(logger, 'warn')
      const telemetry = await import('../index.js')

      telemetry.setupTracer()
      telemetry.setupTracer()

      expect(warnSpy).toHaveBeenCalledWith('tracer provider already initialized, returning existing provider')
    })
  })

  describe('resource attributes', () => {
    it('should use strands-agents as default service name', async () => {
      const telemetry = await import('../index.js')

      const provider = telemetry.setupTracer()

      expect(provider['_resource'].attributes['service.name']).toBe('strands-agents')
    })

    it('should include default resource attributes', async () => {
      const telemetry = await import('../index.js')

      const provider = telemetry.setupTracer()

      expect(provider['_resource'].attributes['service.name']).toBe('strands-agents')
      expect(provider['_resource'].attributes['service.namespace']).toBe('strands')
      expect(provider['_resource'].attributes['deployment.environment']).toBe('development')
      expect(provider['_resource'].attributes['telemetry.sdk.name']).toBe('opentelemetry')
      expect(provider['_resource'].attributes['telemetry.sdk.language']).toBe('typescript')
    })
  })
})

describe('setupMeter', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  describe('singleton behavior', () => {
    it('returns the same provider instance when called twice', async () => {
      const telemetry = await import('../index.js')

      const provider1 = telemetry.setupMeter({ exporters: { console: true } })
      const provider2 = telemetry.setupMeter({ exporters: { otlp: true } })

      expect(provider1).toBe(provider2)
    })

    it('logs a warning when called twice', async () => {
      const { logger } = await import('../../logging/index.js')
      const warnSpy = vi.spyOn(logger, 'warn')
      const telemetry = await import('../index.js')

      telemetry.setupMeter()
      telemetry.setupMeter()

      expect(warnSpy).toHaveBeenCalledWith('meter provider already initialized, returning existing provider')
    })
  })
})
