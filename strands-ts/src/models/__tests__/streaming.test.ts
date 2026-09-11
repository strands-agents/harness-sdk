import { describe, it, expect } from 'vitest'
import { totalPromptTokens, isModelStreamEvent } from '../streaming.js'
import type { ModelStreamEvent } from '../streaming.js'

describe('isModelStreamEvent', () => {
  it('returns true for modelMessageStartEvent', () => {
    const event: ModelStreamEvent = { type: 'modelMessageStartEvent', role: 'assistant' }
    expect(isModelStreamEvent(event)).toBe(true)
  })

  it('returns true for modelContentBlockStartEvent', () => {
    const event: ModelStreamEvent = { type: 'modelContentBlockStartEvent' }
    expect(isModelStreamEvent(event)).toBe(true)
  })

  it('returns true for modelContentBlockDeltaEvent', () => {
    const event: ModelStreamEvent = {
      type: 'modelContentBlockDeltaEvent',
      delta: { type: 'textDelta', text: 'hello' },
    }
    expect(isModelStreamEvent(event)).toBe(true)
  })

  it('returns true for modelContentBlockStopEvent', () => {
    const event: ModelStreamEvent = { type: 'modelContentBlockStopEvent' }
    expect(isModelStreamEvent(event)).toBe(true)
  })

  it('returns true for modelMessageStopEvent', () => {
    const event: ModelStreamEvent = { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
    expect(isModelStreamEvent(event)).toBe(true)
  })

  it('returns true for modelMetadataEvent', () => {
    const event: ModelStreamEvent = {
      type: 'modelMetadataEvent',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }
    expect(isModelStreamEvent(event)).toBe(true)
  })

  it('returns true for modelRedactionEvent', () => {
    const event: ModelStreamEvent = {
      type: 'modelRedactionEvent',
      inputRedaction: { replaceContent: '[User input redacted.]' },
    }
    expect(isModelStreamEvent(event)).toBe(true)
  })

  it('returns false for unknown event types', () => {
    const event = { type: 'unknownEvent' }
    expect(isModelStreamEvent(event)).toBe(false)
  })

  it('returns false for content block types', () => {
    const event = { type: 'textBlock', text: 'hello' }
    expect(isModelStreamEvent(event)).toBe(false)
  })
})

// Regression for #3546: cache tokens must count toward the total prompt under both provider conventions.
describe('totalPromptTokens', () => {
  it('counts cache tokens on disjoint providers where they add to inputTokens', () => {
    expect(totalPromptTokens({ inputTokens: 10, outputTokens: 4, totalTokens: 5862, cacheReadInputTokens: 5848 })).toBe(
      5858
    )
  })

  it('does not double-count cache tokens on subset providers where they sit inside inputTokens', () => {
    expect(
      totalPromptTokens({ inputTokens: 12936, outputTokens: 10, totalTokens: 12946, cacheReadInputTokens: 6457 })
    ).toBe(12936)
  })

  // #3546 known limitation: Anthropic-direct reports cache as a separate counter yet computes
  // totalTokens as inputTokens + outputTokens, so it is arithmetically indistinguishable from a subset
  // provider and the cache read is dropped -- an undercount matching the prior baseline. Adapter-side
  // normalization to the disjoint convention (#3546) will make totalTokens include the cache and flip
  // this to the total prompt; this test guards the boundary so that flip is intentional.
  it('undercounts Anthropic-direct cache where totalTokens excludes the separate cache counter', () => {
    expect(totalPromptTokens({ inputTokens: 10, outputTokens: 4, totalTokens: 14, cacheReadInputTokens: 5848 })).toBe(
      10
    )
  })

  it('adds cache reads and writes on disjoint providers', () => {
    expect(
      totalPromptTokens({
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 100,
        cacheReadInputTokens: 60,
        cacheWriteInputTokens: 25,
      })
    ).toBe(95)
  })

  it('collapses to inputTokens when there are no cache tokens', () => {
    expect(totalPromptTokens({ inputTokens: 100, outputTokens: 50, totalTokens: 150 })).toBe(100)
  })
})
