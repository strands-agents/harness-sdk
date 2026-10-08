/**
 * Test fixtures and helpers for Model testing.
 * This module provides utilities for testing Model implementations without
 * requiring actual API clients.
 */

import { Model } from '../models/model.js'
import type { Message } from '../types/messages.js'
import type { ModelStreamEvent } from '../models/streaming.js'
import type { BaseModelConfig, StreamOptions } from '../models/model.js'
import type { ModelEventGenerator } from './types.js'

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
 * const agent = new Agent({ model: provider })
 * await agent.invoke('Hi')
 * ```
 */
export class TestModelProvider extends Model<BaseModelConfig> {
  private _eventGenerator: ModelEventGenerator | undefined
  private _config: BaseModelConfig = { modelId: 'test-model' }

  /**
   * @param eventGenerator - Factory called afresh for each consumed stream.
   */
  constructor(eventGenerator?: ModelEventGenerator) {
    super()
    this._eventGenerator = eventGenerator
  }

  /**
   * Replace the factory for subsequent streams.
   * @param eventGenerator - Factory returning the desired events or throwing an error.
   */
  setEventGenerator(eventGenerator: ModelEventGenerator): void {
    this._eventGenerator = eventGenerator
  }

  /**
   * Merge configuration without changing the event factory.
   * @param modelConfig - Model configuration to merge.
   */
  updateConfig(modelConfig: BaseModelConfig): void {
    this._config = { ...this._config, ...modelConfig }
  }

  /** @returns The current model configuration. */
  getConfig(): BaseModelConfig {
    return this._config
  }

  /**
   * @param _messages - Conversation messages, ignored by this provider.
   * @param _options - Stream options, ignored by this provider.
   * @returns Events from a fresh factory invocation.
   * @throws Error - If no factory is set, or the factory throws.
   */
  async *stream(_messages: Message[], _options?: StreamOptions): AsyncGenerator<ModelStreamEvent> {
    if (!this._eventGenerator) {
      throw new Error('Event generator not set')
    }
    yield* this._eventGenerator()
  }
}
