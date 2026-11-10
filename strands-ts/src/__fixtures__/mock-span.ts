/**
 * Mock OpenTelemetry Span for testing tracer functionality.
 * Implements the full Span interface and records all calls for assertion.
 */

import type {
  Span,
  SpanContext,
  SpanStatus,
  SpanAttributes,
  SpanAttributeValue,
  TimeInput,
  Exception,
  Link,
} from '@opentelemetry/api'

/**
 * Concrete mock implementing the Span interface.
 * Chainable methods return `this` to satisfy the `Span` contract.
 */
export class MockSpan implements Span {
  readonly calls = {
    setAttribute: [] as Array<{ key: string; value: SpanAttributeValue }>,
    setAttributes: [] as Array<{ attributes: SpanAttributes }>,
    addEvent: [] as Array<{
      name: string
      attributes: SpanAttributes | TimeInput | undefined
      startTime: TimeInput | undefined
    }>,
    setStatus: [] as Array<{ status: SpanStatus }>,
    updateName: [] as Array<{ name: string }>,
    end: [] as Array<{ endTime: TimeInput | undefined }>,
    recordException: [] as Array<{ exception: Exception; time: TimeInput | undefined }>,
  }

  /** @returns A fixed span context for test assertions. */
  spanContext(): SpanContext {
    return { traceId: 'trace-1', spanId: 'span-1', traceFlags: 1 }
  }

  /** Records a single attribute. */
  setAttribute(key: string, value: SpanAttributeValue): this {
    this.calls.setAttribute.push({ key, value })
    return this
  }

  /** Records a batch of attributes. */
  setAttributes(attributes: SpanAttributes): this {
    this.calls.setAttributes.push({ attributes })
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) this.setAttribute(key, value)
    }
    return this
  }

  /** Records a span event with optional attributes. */
  addEvent(name: string, attributesOrStartTime?: SpanAttributes | TimeInput, startTime?: TimeInput): this {
    this.calls.addEvent.push({ name, attributes: attributesOrStartTime, startTime })
    return this
  }

  /** No-op link addition. */
  addLink(_link: Link): this {
    return this
  }

  /** No-op batch link addition. */
  addLinks(_links: Link[]): this {
    return this
  }

  /** Records a status change. */
  setStatus(status: SpanStatus): this {
    this.calls.setStatus.push({ status })
    return this
  }

  /** Records a name update. */
  updateName(name: string): this {
    this.calls.updateName.push({ name })
    return this
  }

  /** Records span end. */
  end(endTime?: TimeInput): void {
    this.calls.end.push({ endTime })
  }

  /** Always returns true for mock spans. */
  isRecording(): boolean {
    return true
  }

  /** Records an exception. */
  recordException(exception: Exception, time?: TimeInput): void {
    this.calls.recordException.push({ exception, time })
  }

  /**
   * Get the value of a specific attribute set via setAttribute.
   */
  getAttributeValue(key: string): SpanAttributeValue | undefined {
    const entry = this.calls.setAttribute.find((c) => c.key === key)
    return entry?.value
  }

  /**
   * Get all events with a given name.
   */
  getEvents(name: string): Array<{ name: string; attributes: SpanAttributes | TimeInput | undefined }> {
    return this.calls.addEvent.filter((c) => c.name === name)
  }
}

/**
 * Extract a string attribute from a mock span event's attributes.
 */
export function eventAttr(event: { attributes: SpanAttributes | TimeInput | undefined }, key: string): string {
  const attrs = event.attributes as Record<string, string>
  return attrs[key]!
}
