/**
 * Mock OpenTelemetry Meter for testing metric instrument emission.
 * Records all counter and histogram data points for assertion.
 */

import type { Attributes } from '@opentelemetry/api'

export interface MockDataPoint {
  value: number
  attributes: Attributes | undefined
}

export class MockCounter {
  readonly dataPoints: MockDataPoint[] = []

  add(value: number, attributes?: Attributes): void {
    this.dataPoints.push({ value, attributes })
  }

  get sum(): number {
    return this.dataPoints.reduce((acc, dp) => acc + dp.value, 0)
  }
}

export class MockHistogram {
  readonly dataPoints: MockDataPoint[] = []

  record(value: number, attributes?: Attributes): void {
    this.dataPoints.push({ value, attributes })
  }

  get sum(): number {
    return this.dataPoints.reduce((acc, dp) => acc + dp.value, 0)
  }
}

/**
 * Mock OTEL Meter that tracks created instruments by name.
 * Cast to `Meter` when passing to `vi.spyOn(otelMetrics, 'getMeter')`.
 */
export class MockMeter {
  private readonly _counters = new Map<string, MockCounter>()
  private readonly _histograms = new Map<string, MockHistogram>()

  createCounter(name: string): MockCounter {
    const counter = new MockCounter()
    this._counters.set(name, counter)
    return counter
  }

  createHistogram(name: string): MockHistogram {
    const histogram = new MockHistogram()
    this._histograms.set(name, histogram)
    return histogram
  }

  getCounter(name: string): MockCounter | undefined {
    return this._counters.get(name)
  }

  getHistogram(name: string): MockHistogram | undefined {
    return this._histograms.get(name)
  }
}
