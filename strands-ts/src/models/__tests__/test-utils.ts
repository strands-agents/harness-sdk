// ABOUTME: Shared test utilities for model tests
// ABOUTME: Contains helper functions for collecting stream events and other common test operations

import type { ModelStreamEvent } from '../streaming.js'

/**
 * Helper function to collect all events from a stream.
 * Useful for testing streaming model responses.
 *
 * @param stream - An async iterable of ModelStreamEvent
 * @returns Promise resolving to an array of all emitted events
 */
export async function collectEvents(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = []
  for await (const event of stream) {
    events.push(event)
  }
  return events
}
