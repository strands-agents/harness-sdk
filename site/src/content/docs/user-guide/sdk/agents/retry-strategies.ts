// @ts-nocheck

import {
  Agent,
  DefaultModelRetryStrategy,
  ExponentialBackoff,
  AfterModelCallEvent,
} from '@strands-agents/sdk'

async function defaultStrategyExample() {
  // --8<-- [start:default_strategy]
  const agent = new Agent({
    retryStrategy: new DefaultModelRetryStrategy({ maxAttempts: 3 }),
  })
  // --8<-- [end:default_strategy]
  void agent
}

async function customBackoffExample() {
  // --8<-- [start:custom_backoff]
  const agent = new Agent({
    retryStrategy: new DefaultModelRetryStrategy({
      maxAttempts: 4,
      backoff: new ExponentialBackoff({
        baseMs: 2_000,
        maxMs: 60_000,
        multiplier: 2,
        jitter: 'full',
      }),
    }),
  })
  // --8<-- [end:custom_backoff]
  void agent
}

async function disableExample() {
  // --8<-- [start:disable]
  const agent = new Agent({
    retryStrategy: null,
  })
  // --8<-- [end:disable]
  void agent
}

async function customSubclassExample() {
  // --8<-- [start:custom_subclass]
  class TransientServiceError extends Error {
    readonly name = 'TransientServiceError'
  }

  // Retry throttles (the default retryable set) plus our own transient error class.
  class WiderRetryStrategy extends DefaultModelRetryStrategy {
    protected override isRetryable(error: Error): boolean {
      return super.isRetryable(error) || error instanceof TransientServiceError
    }
  }

  const agent = new Agent({
    retryStrategy: new WiderRetryStrategy({ maxAttempts: 5 }),
  })
  // --8<-- [end:custom_subclass]
  void agent
}

async function hookRetryExample() {
  // --8<-- [start:hook_retry]
  const agent = new Agent({})

  let attempts = 0
  agent.addHook(AfterModelCallEvent, async (event) => {
    if (event.error && attempts < 3) {
      attempts += 1
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      event.retry = true
    }
  })
  // --8<-- [end:hook_retry]
  void agent
}

void defaultStrategyExample
void customBackoffExample
void disableExample
void customSubclassExample
void hookRetryExample
