import { afterEach, describe, expect, it, vi } from 'vitest'

import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { ModelThrottledError } from '../../errors.js'
import { AfterModelCallEvent, BeforeModelCallEvent } from '../../hooks/events.js'
import { HookOrder } from '../../hooks/types.js'
import { InvokeModelStage } from '../../middleware/stages.js'
import type { ModelStreamEvent } from '../../models/streaming.js'
import { ModelRouter, RoutingCandidate } from '../../models/routing/router.js'
import type { RoutingContext, RoutingStrategy } from '../../models/routing/strategy.js'
import type { StreamOptions } from '../../models/model.js'
import { ConstantBackoff } from '../../retry/backoff-strategy.js'
import { DefaultModelRetryStrategy } from '../../retry/default-model-retry-strategy.js'
import { SessionManager } from '../../session/session-manager.js'
import { InMemoryStorage } from '../../storage/in-memory-storage.js'
import type { Message } from '../../types/messages.js'
import { Agent } from '../agent.js'

class RecordingModel extends MockMessageModel {
  calls = 0
  readonly receivedOptions: StreamOptions[] = []

  override async *stream(
    messages: Message[],
    options?: StreamOptions
  ): AsyncGenerator<ModelStreamEvent, void, unknown> {
    this.calls += 1
    this.receivedOptions.push(options ?? {})
    yield* super.stream(messages, options)
  }
}

class IndexedStrategy implements RoutingStrategy {
  readonly contexts: RoutingContext[] = []
  private readonly _indexes: number[]

  constructor(...indexes: number[]) {
    this._indexes = indexes
  }

  async select(context: RoutingContext): Promise<RoutingCandidate | undefined> {
    this.contexts.push(context)
    const index = this._indexes.shift()
    return index === undefined ? undefined : context.candidates[index]
  }
}

function responseModel(text: string): RecordingModel {
  return new RecordingModel().addTurn({ type: 'textBlock', text })
}

afterEach(() => {
  vi.useRealTimers()
})
describe('Agent model routing', () => {
  it('invokes the opening selection while retaining the default model', async () => {
    const first = responseModel('first')
    const second = responseModel('second')
    const router = new ModelRouter([first, second], { strategy: new IndexedStrategy(1) })
    const agent = new Agent({ model: router, retryStrategy: null, printer: false })
    const beforeModels: unknown[] = []
    const afterModels: unknown[] = []
    agent.addHook(BeforeModelCallEvent, (event) => {
      beforeModels.push(event.model)
    })
    agent.addHook(AfterModelCallEvent, (event) => {
      afterModels.push(event.model)
    })

    const result = await agent.invoke('hello')

    expect(agent.model).toBe(first)
    expect(result.lastMessage.content[0]).toEqual({ type: 'textBlock', text: 'second' })
    expect({ firstCalls: first.calls, secondCalls: second.calls }).toEqual({ firstCalls: 0, secondCalls: 1 })
    expect(beforeModels).toEqual([first])
    expect(afterModels).toEqual([second])
  })

  it('falls back after a non-retryable failure and resets the attempt count', async () => {
    const first = new RecordingModel().addTurn(new Error('primary down'))
    const second = responseModel('recovered')
    const agent = new Agent({ model: new ModelRouter([first, second]), retryStrategy: null, printer: false })
    const attempts: { model: unknown; attemptCount: number; retry?: boolean }[] = []
    agent.addHook(
      AfterModelCallEvent,
      (event) => {
        attempts.push({
          model: event.model,
          attemptCount: event.attemptCount,
          ...(event.retry !== undefined && { retry: event.retry }),
        })
      },
      { order: HookOrder.SDK_LAST }
    )

    const result = await agent.invoke('hello')

    expect(result.lastMessage.content[0]).toEqual({ type: 'textBlock', text: 'recovered' })
    expect(attempts).toEqual([
      { model: first, attemptCount: 1, retry: true },
      { model: second, attemptCount: 1 },
    ])
  })

  it('lets the normal retry strategy retry before routing', async () => {
    vi.useFakeTimers()
    const primary = new RecordingModel()
      .addTurn(new ModelThrottledError('try again'))
      .addTurn({ type: 'textBlock', text: 'primary recovered' })
    const backup = responseModel('backup')
    const agent = new Agent({
      model: new ModelRouter([primary, backup]),
      retryStrategy: new DefaultModelRetryStrategy({
        maxAttempts: 2,
        backoff: new ConstantBackoff({ delayMs: 1 }),
      }),
      printer: false,
    })

    const invocation = agent.invoke('hello')
    await vi.runAllTimersAsync()
    const result = await invocation

    expect(result.lastMessage.content[0]).toEqual({ type: 'textBlock', text: 'primary recovered' })
    expect({ primaryCalls: primary.calls, backupCalls: backup.calls }).toEqual({ primaryCalls: 2, backupCalls: 0 })
  })

  it('reports a downstream middleware model on failure', async () => {
    const selected = responseModel('selected')
    const replacement = new RecordingModel().addTurn(new Error('middleware model failed'))
    const agent = new Agent({
      model: new ModelRouter([selected], { maxSwitches: 0 }),
      retryStrategy: null,
      printer: false,
    })
    let failedModel: unknown
    agent.addMiddleware(InvokeModelStage, async function* (context, next) {
      return yield* next({ ...context, model: replacement })
    })
    agent.addHook(AfterModelCallEvent, (event) => {
      if (event.error !== undefined) failedModel = event.model
    })

    await expect(agent.invoke('hello')).rejects.toThrow('middleware model failed')
    expect(failedModel).toBe(replacement)
  })

  it('reports a routed model when later input middleware fails before invocation', async () => {
    const first = responseModel('first')
    const selected = responseModel('selected')
    const agent = new Agent({
      model: new ModelRouter([first, selected], { strategy: new IndexedStrategy(1) }),
      retryStrategy: null,
      printer: false,
    })
    let failedModel: unknown
    agent.addMiddleware(InvokeModelStage.Input, async (context) => {
      expect(context.model).toBe(selected)
      throw new Error('input middleware failed')
    })
    agent.addHook(AfterModelCallEvent, (event) => {
      if (event.error !== undefined) failedModel = event.model
    })

    await expect(agent.invoke('hello')).rejects.toThrow('input middleware failed')
    expect(failedModel).toBe(selected)
    expect({ firstCalls: first.calls, selectedCalls: selected.calls }).toEqual({ firstCalls: 0, selectedCalls: 0 })
  })

  it('increments attempt counts when middleware changes the model without a route switch', async () => {
    const selected = responseModel('selected')
    const replacement = new RecordingModel()
      .addTurn(new Error('first failure'))
      .addTurn(new Error('second failure'))
      .addTurn({ type: 'textBlock', text: 'replacement recovered' })
    const agent = new Agent({ model: new ModelRouter([selected]), retryStrategy: null, printer: false })
    const attemptCounts: number[] = []
    agent.addMiddleware(InvokeModelStage, async function* (context, next) {
      return yield* next({ ...context, model: replacement })
    })
    agent.addHook(AfterModelCallEvent, (event) => {
      attemptCounts.push(event.attemptCount)
      if (event.error !== undefined) event.retry = true
    })

    const result = await agent.invoke('hello')

    expect(result.lastMessage.content[0]).toEqual({ type: 'textBlock', text: 'replacement recovered' })
    expect(attemptCounts).toEqual([1, 2, 3])
  })

  it('clears routing state between invocations that reuse the same state object', async () => {
    const first = responseModel('first')
    const second = responseModel('second')
    const strategy = new IndexedStrategy(0, 1)
    const agent = new Agent({
      model: new ModelRouter([first, second], { strategy }),
      retryStrategy: null,
      printer: false,
    })
    const invocationState = { keep: true }

    const firstResult = await agent.invoke('one', { invocationState })
    const secondResult = await agent.invoke('two', { invocationState })

    expect(firstResult.lastMessage.content[0]).toEqual({ type: 'textBlock', text: 'first' })
    expect(secondResult.lastMessage.content[0]).toEqual({ type: 'textBlock', text: 'second' })
    expect(strategy.contexts).toHaveLength(2)
    expect(invocationState).toEqual({ keep: true })
  })

  it('treats a nested router as one opaque candidate during fallback', async () => {
    const innerFailure = new RecordingModel().addTurn(new Error('inner down'))
    const innerSpare = responseModel('inner spare')
    const outerBackup = responseModel('outer backup')
    const inner = new ModelRouter([innerFailure, innerSpare])
    const agent = new Agent({
      model: new ModelRouter([inner, outerBackup]),
      retryStrategy: null,
      printer: false,
    })

    const result = await agent.invoke('hello')

    expect(result.lastMessage.content[0]).toEqual({ type: 'textBlock', text: 'outer backup' })
    expect({
      innerFailureCalls: innerFailure.calls,
      innerSpareCalls: innerSpare.calls,
      outerBackupCalls: outerBackup.calls,
    }).toEqual({ innerFailureCalls: 1, innerSpareCalls: 0, outerBackupCalls: 1 })
  })

  it('honors maxSwitches zero and rejects plugin attachment', async () => {
    const primary = new RecordingModel().addTurn(new Error('primary down'))
    const router = new ModelRouter([primary, responseModel('backup')], { maxSwitches: 0 })
    const agent = new Agent({ model: router, retryStrategy: null, printer: false })

    await expect(agent.invoke('hello')).rejects.toThrow('primary down')
    expect(() => new Agent({ model: responseModel('default'), plugins: [router], printer: false })).toThrow(
      'ModelRouter must be passed through Agent({ model }), not plugins'
    )
  })

  it('forwards the agent metadata to the routed alternate', async () => {
    // Request-time context reaches every candidate, not just the default model.
    const primary = responseModel('primary')
    const alternate = responseModel('alternate')
    const agent = new Agent({
      model: new ModelRouter([primary, alternate], { strategy: new IndexedStrategy(1) }),
      sessionManager: new SessionManager({ sessionId: 'routed', storage: new InMemoryStorage() }),
      retryStrategy: null,
      printer: false,
    })

    await agent.invoke('hello')

    expect(alternate.receivedOptions[0]?.agentMetadata).toEqual({ sessionId: 'routed' })
    expect(primary.receivedOptions).toHaveLength(0)
  })
})
