/**
 * Test fixtures and helpers for Model testing.
 * This module provides utilities for testing Model implementations without
 * requiring actual API clients.
 */

import { Model } from '../models/model.js'
import type { Message } from '../types/messages.js'
import type { ModelStreamEvent } from '../models/streaming.js'
import type { BaseModelConfig, StreamOptions } from '../models/model.js'

/**
 * Test model provider that returns a predefined stream of events.
 * Useful for testing Model.streamAggregated() and other Model functionality
 * without requiring actual API calls.
 *
 * @example
 * ```typescript
 * const provider = new TestModelProvider(async function* () {
 *   yield { type: 'modelMessageStartEvent', role: 'assistant' }
 *   yield { type: 'modelContentBlockStartEvent' }
 *   yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Hello' } }
 *   yield { type: 'modelContentBlockStopEvent' }
 *   yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
 * })
 *
 * const message = await collectAggregated(provider.streamAggregated(messages))
 * ```
 */
export class TestModelProvider extends Model<BaseModelConfig> {
  private eventGenerator: (() => AsyncGenerator<ModelStreamEvent>) | undefined
  private config: BaseModelConfig = { modelId: 'test-model' }

  constructor(eventGenerator?: () => AsyncGenerator<ModelStreamEvent>) {
    super()
    this.eventGenerator = eventGenerator
  }

  setEventGenerator(eventGenerator: () => AsyncGenerator<ModelStreamEvent>): void {
    this.eventGenerator = eventGenerator
  }

  updateConfig(modelConfig: BaseModelConfig): void {
    this.config = { ...this.config, ...modelConfig }
  }

  getConfig(): BaseModelConfig {
    return this.config
  }

  async *stream(_messages: Message[], _options?: StreamOptions): AsyncGenerator<ModelStreamEvent> {
    if (!this.eventGenerator) {
      throw new Error('Event generator not set')
    }
    yield* this.eventGenerator()
  }
}

/**
 * Helper function to collect events and result from an async generator.
 * Properly handles AsyncGenerator where the final value is returned
 * rather than yielded.
 *
 * @param generator - An async generator that yields items and returns a final result
 * @returns Object with items array (yielded values) and result (return value)
 */
export async function collectGenerator<E, R>(
  generator: AsyncGenerator<E, R, never>
): Promise<{ items: E[]; result: R }> {
  const items: E[] = []
  let done = false
  let result: R | undefined

  while (!done) {
    const { value, done: isDone } = await generator.next()
    done = isDone ?? false
    if (!done) {
      items.push(value as E)
    } else {
      result = value as R
    }
  }

  return { items, result: result! }
}

/**
 * Helper function to collect all items from an async iterator.
 *
 * @param stream - An async iterable that yields items
 * @returns Array of all yielded items
 */
export async function collectIterator<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of stream) {
    items.push(item)
  }
  return items
}
