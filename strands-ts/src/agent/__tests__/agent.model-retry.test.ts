// End-to-end wiring test for DefaultModelRetryStrategy on the Agent constructor.
// Uses fake timers so the retry backoff never waits real wall time.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { Agent } from '../agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { DefaultModelRetryStrategy } from '../../retry/default-model-retry-strategy.js'
import { ModelRetryStrategy } from '../../retry/model-retry-strategy.js'
import type { RetryDecision } from '../../retry/retry-strategy.js'
import { ConstantBackoff } from '../../retry/backoff-strategy.js'
import { ModelThrottledError } from '../../errors.js'
import { AfterModelCallEvent } from '../../hooks/events.js'
import { logger } from '../../logging/logger.js'

describe('Agent retryStrategy wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries model calls that throw ModelThrottledError', async () => {
    const model = new MockMessageModel()
      .addTurn(new ModelThrottledError('rate limited'))
      .addTurn({ type: 'textBlock', text: 'ok' })

    const agent = new Agent({
      model,
      retryStrategy: new DefaultModelRetryStrategy({
        maxAttempts: 3,
        backoff: new ConstantBackoff({ delayMs: 1 }),
      }),
    })

    const invokePromise = agent.invoke('hi')
    // Flush any pending timers the retry scheduled.
    await vi.runAllTimersAsync()
    const result = await invokePromise

    expect(result.lastMessage.content[0]).toEqual({ type: 'textBlock', text: 'ok' })
  })

  it('interrupts retry backoff on cancellation without another model call', async () => {
    const model = new MockMessageModel()
      .addTurn(new ModelThrottledError('rate limited'))
      .addTurn({ type: 'textBlock', text: 'unexpected retry' })
    const controller = new AbortController()
    const agent = new Agent({
      model,
      retryStrategy: new DefaultModelRetryStrategy({
        maxAttempts: 3,
        backoff: new ConstantBackoff({ delayMs: 5000 }),
      }),
    })

    const invokePromise = agent.invoke('hi', { cancelSignal: controller.signal })
    await vi.advanceTimersByTimeAsync(499)
    expect(model.callCount).toBe(1)

    controller.abort()
    const result = await invokePromise

    expect(result.stopReason).toBe('cancelled')
    expect(model.callCount).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not retry non-throttling errors', async () => {
    const model = new MockMessageModel().addTurn(new Error('boom'))

    const agent = new Agent({
      model,
      retryStrategy: new DefaultModelRetryStrategy({
        maxAttempts: 3,
        backoff: new ConstantBackoff({ delayMs: 1 }),
      }),
    })

    const invokePromise = agent.invoke('hi')
    const assertion = expect(invokePromise).rejects.toThrow('boom')
    await vi.runAllTimersAsync()
    await assertion
  })

  it('installs a default DefaultModelRetryStrategy when none is provided', async () => {
    // With no override, two ModelThrottledErrors in a row should still succeed
    // because the defaults allow multiple attempts.
    const model = new MockMessageModel()
      .addTurn(new ModelThrottledError('throttled 1'))
      .addTurn(new ModelThrottledError('throttled 2'))
      .addTurn({ type: 'textBlock', text: 'ok' })

    const agent = new Agent({ model })
    const invokePromise = agent.invoke('hi')
    await vi.runAllTimersAsync()
    const result = await invokePromise

    expect(result.lastMessage.content[0]).toEqual({ type: 'textBlock', text: 'ok' })
  })

  it('gives up once maxAttempts is exceeded', async () => {
    const model = new MockMessageModel()
      .addTurn(new ModelThrottledError('throttled 1'))
      .addTurn(new ModelThrottledError('throttled 2'))
      .addTurn(new ModelThrottledError('throttled 3'))

    const agent = new Agent({
      model,
      retryStrategy: new DefaultModelRetryStrategy({
        maxAttempts: 2,
        backoff: new ConstantBackoff({ delayMs: 1 }),
      }),
    })

    const invokePromise = agent.invoke('hi')
    const assertion = expect(invokePromise).rejects.toThrow(ModelThrottledError)
    await vi.runAllTimersAsync()
    await assertion
  })

  it('disables retries when retryStrategy is null', async () => {
    const model = new MockMessageModel().addTurn(new ModelThrottledError('throttled'))

    const agent = new Agent({ model, retryStrategy: null })

    const invokePromise = agent.invoke('hi')
    const assertion = expect(invokePromise).rejects.toThrow(ModelThrottledError)
    await vi.runAllTimersAsync()
    await assertion
  })

  it('disables retries when retryStrategy is an empty array', async () => {
    const model = new MockMessageModel().addTurn(new ModelThrottledError('throttled'))

    const agent = new Agent({ model, retryStrategy: [] })

    const invokePromise = agent.invoke('hi')
    const assertion = expect(invokePromise).rejects.toThrow(ModelThrottledError)
    await vi.runAllTimersAsync()
    await assertion
  })

  it('accepts an array of distinct retry strategy types', async () => {
    // A trivial secondary strategy subclass so the two entries have different
    // constructors (the default DefaultModelRetryStrategy cannot be paired
    // with a second instance of itself — see the fail-fast test below).
    class NoopRetryStrategy extends ModelRetryStrategy {
      readonly name = 'test:noop-retry-strategy'
      protected override computeRetryDecision(): RetryDecision {
        return { retry: false }
      }
    }

    const model = new MockMessageModel()
      .addTurn(new ModelThrottledError('throttled'))
      .addTurn({ type: 'textBlock', text: 'ok' })

    const primary = new DefaultModelRetryStrategy({
      maxAttempts: 3,
      backoff: new ConstantBackoff({ delayMs: 1 }),
    })

    const agent = new Agent({ model, retryStrategy: [primary, new NoopRetryStrategy()] })
    const invokePromise = agent.invoke('hi')
    await vi.runAllTimersAsync()
    const result = await invokePromise

    expect(result.lastMessage.content[0]).toEqual({ type: 'textBlock', text: 'ok' })
  })

  it('warns when two retry strategies of the same type are provided', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    new Agent({
      model: new MockMessageModel(),
      retryStrategy: [new DefaultModelRetryStrategy(), new DefaultModelRetryStrategy()],
    })

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('DefaultModelRetryStrategy'))

    warn.mockRestore()
  })

  it('respects a user hook that already set retry=true (no double wait, no double increment)', async () => {
    const model = new MockMessageModel()
      .addTurn(new ModelThrottledError('throttled'))
      .addTurn({ type: 'textBlock', text: 'ok' })

    const strategy = new DefaultModelRetryStrategy({
      maxAttempts: 2, // only 1 retry allowed — if our strategy also incremented, we'd exceed
      backoff: new ConstantBackoff({ delayMs: 10_000 }), // huge delay — if we slept on top, test would time out
    })

    const agent = new Agent({ model, retryStrategy: strategy })
    agent.addHook(AfterModelCallEvent, (event) => {
      if (event.error instanceof ModelThrottledError) {
        event.retry = true
      }
    })

    const invokePromise = agent.invoke('hi')
    await vi.runAllTimersAsync()
    const result = await invokePromise

    expect(result.lastMessage.content[0]).toEqual({ type: 'textBlock', text: 'ok' })
  })

  it('throws if the same instance is attached to two agents', async () => {
    const strategy = new DefaultModelRetryStrategy()

    const agent1 = new Agent({
      model: new MockMessageModel().addTurn({ type: 'textBlock', text: 'ok' }),
      retryStrategy: strategy,
    })
    await agent1.invoke('hi')

    const agent2 = new Agent({
      model: new MockMessageModel().addTurn({ type: 'textBlock', text: 'ok' }),
      retryStrategy: strategy,
    })
    await expect(agent2.invoke('hi')).rejects.toThrow(/already attached to another agent/)
  })
})
