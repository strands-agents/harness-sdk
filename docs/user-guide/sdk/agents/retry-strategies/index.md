Model providers occasionally encounter errors such as rate limits, service unavailability, or network timeouts. By default, the agent retries throttled responses automatically with exponential backoff. The `Agent.retry_strategy``Agent.retryStrategy` parameter lets you customize this behavior.

## Default Behavior

Without configuration, agents retry throttling errors up to 5 times (6 total attempts) with exponential backoff starting at 4 seconds:

```plaintext
Attempt 1: fails → wait 4s
Attempt 2: fails → wait 8s
Attempt 3: fails → wait 16s
Attempt 4: fails → wait 32s
Attempt 5: fails → wait 64s
Attempt 6: fails → exception raised
```

## Customizing Retry Behavior

To adjust retry parameters, pass a configured strategy to the agent constructor.

(( tab "Python" ))
```python
from strands import Agent, ModelRetryStrategy

agent = Agent(
    retry_strategy=ModelRetryStrategy(
        max_attempts=3,      # Total attempts (including first try)
        initial_delay=2,     # Seconds before first retry
        max_delay=60         # Cap on backoff delay
    )
)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
In TypeScript, `ModelRetryStrategy` is the abstract base class. Use `DefaultModelRetryStrategy` for the standard configurable strategy:

```typescript
import { Agent, DefaultModelRetryStrategy } from '@strands-agents/sdk'

const agent = new Agent({
  retryStrategy: new DefaultModelRetryStrategy({ maxAttempts: 3 }),
})
```
(( /tab "TypeScript" ))

### Parameters

(( tab "Python" ))
| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `max_attempts` | `int` | `6` | Total number of attempts including the initial call. Set to `1` to disable retries. |
| `initial_delay` | `float` | `4` | Seconds to wait before the first retry. Subsequent retries double this value. |
| `max_delay` | `float` | `128` | Maximum seconds to wait between retries. Caps the exponential growth. |
(( /tab "Python" ))

(( tab "TypeScript" ))
`DefaultModelRetryStrategy` accepts:

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `maxAttempts` | `number` | `6` | Total number of attempts including the initial call. Must be `>= 1`. |
| `backoff` | `BackoffStrategy` | `new ExponentialBackoff({ baseMs: 4000, maxMs: 240000 })` | Computes delay between retries. See [Backoff Strategies](#backoff-strategies). |
(( /tab "TypeScript" ))

### Backoff Strategies

In TypeScript, the delay between retries is delegated to a `BackoffStrategy` passed via the `backoff` parameter. The Python SDK does not expose a separate backoff interface; configure exponential backoff through the `initial_delay` and `max_delay` parameters above.

(( tab "Python" ))
Configure backoff through `ModelRetryStrategy` parameters in [Customizing Retry Behavior](#customizing-retry-behavior).
(( /tab "Python" ))

(( tab "TypeScript" ))
The TypeScript SDK ships three built-in strategies:

-   `ExponentialBackoff` (default): delay grows as `baseMs * multiplier^(attempt-1)`, capped at `maxMs`.
-   `LinearBackoff`: delay grows as `baseMs * attempt`, capped at `maxMs`.
-   `ConstantBackoff`: same delay for every retry.

`ExponentialBackoff` and `LinearBackoff` accept a `jitter` option (`'none'`, `'full'`, `'equal'`, `'decorrelated'`). Default is `'full'` jitter, which spreads concurrent clients across the wait window. `ConstantBackoff` returns the configured delay unchanged.

```typescript
import { Agent, DefaultModelRetryStrategy, ExponentialBackoff } from '@strands-agents/sdk'

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
```
(( /tab "TypeScript" ))

## Disabling Retries

To disable automatic retries entirely:

(( tab "Python" ))
```python
from strands import Agent

agent = Agent(
    retry_strategy=None
)
```

The agent loop still re-asks the model when a response stops for tool use but contains no tool use block. That retry is part of the loop, not the retry strategy.
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'

const agent = new Agent({
  retryStrategy: null,
})
```
(( /tab "TypeScript" ))

## When Retries Occur

Default retry strategies handle throttling errors (`ModelThrottledException``ModelThrottledError`) raised by model providers for rate-limiting. Other exceptions propagate immediately without retry.

To extend or narrow the retryable set, see [Custom Retry Logic](#custom-retry-logic).

## Custom Retry Logic

For more control over retry decisions, such as validating model responses or handling additional error types, you have two options:

1.  Subclass the retry strategy class to own the full decision shape and reuse hook plumbing.
2.  Use a hook on `AfterModelCallEvent` to set `event.retry = true` directly.

### Subclassing the Retry Strategy

(( tab "Python" ))
To extend or narrow which errors are retryable, subclass `ModelRetryStrategy` and override `is_retryable`. The default implementation retries `ModelThrottledException` only; `super().is_retryable(exception)` preserves that base behavior so you can opt additional error types in (or specific ones out) without reimplementing the rest of the retry policy.

```python
from strands import Agent, ModelRetryStrategy
from strands.types.exceptions import ModelThrottledException

class MyRetryStrategy(ModelRetryStrategy):
    def is_retryable(self, exception: Exception) -> bool:
        return super().is_retryable(exception) or isinstance(exception, TimeoutError)

agent = Agent(
    retry_strategy=MyRetryStrategy(max_attempts=4, initial_delay=2, max_delay=60)
)
```

A retry-strategy instance carries per-turn state and must not be shared across agents. Create a new instance per agent.
(( /tab "Python" ))

(( tab "TypeScript" ))
To extend or narrow which errors are retryable, subclass `DefaultModelRetryStrategy` and override `isRetryable`. The default implementation retries `ModelThrottledError` only; `super.isRetryable(error)` preserves that base behavior so you can opt additional error types in (or specific ones out) without reimplementing the rest of the retry policy.

```typescript
import { Agent, DefaultModelRetryStrategy } from '@strands-agents/sdk'

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
```

For full control over the retry decision (custom backoff state, attempt-aware logic), subclass the abstract `ModelRetryStrategy` directly and implement `computeRetryDecision`. The base class handles short-circuits, per-turn state reset, and sleeping between attempts.

A retry-strategy instance carries per-turn state and must not be shared across agents. Create a new instance per agent.
(( /tab "TypeScript" ))

### Using a Hook

Hooks are simpler when you only need to inspect a model error and request a retry. Set `event.retry = true` from an `AfterModelCallEvent` callback. Hooks do not introduce delays automatically; the example below adds a 2-second wait.

(( tab "Python" ))
```python
import asyncio
from strands import Agent
from strands.hooks import HookProvider, HookRegistry, AfterModelCallEvent

class CustomRetry(HookProvider):
    def __init__(self, max_retries: int = 3, delay: float = 2.0):
        self.max_retries = max_retries
        self.delay = delay
        self.attempts = 0

    def register_hooks(self, registry: HookRegistry) -> None:
        registry.add_callback(AfterModelCallEvent, self.maybe_retry)

    async def maybe_retry(self, event: AfterModelCallEvent) -> None:
        if event.exception and self.attempts < self.max_retries:
            self.attempts += 1
            await asyncio.sleep(self.delay)
            event.retry = True

agent = Agent(hooks=[CustomRetry()])
```
(( /tab "Python" ))

(( tab "TypeScript" ))
The `AfterModelCallEvent` exposes `attemptCount` (1-indexed). Use it to bound retry counts without tracking state outside the hook.

```typescript
import { Agent, AfterModelCallEvent } from '@strands-agents/sdk'

const agent = new Agent({})

let attempts = 0
agent.addHook(AfterModelCallEvent, async (event) => {
  if (event.error && attempts < 3) {
    attempts += 1
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    event.retry = true
  }
})
```
(( /tab "TypeScript" ))

See [Hooks](/docs/user-guide/sdk/agents/hooks/index.md#model-call-retry) for more examples.

## Related pages

- [Production Lifecycle Controls](/docs/user-guide/sdk/agents/lifecycle-controls/index.md) (2 shared tags)
- [Interrupts](/docs/user-guide/sdk/interrupts/index.md) (2 shared tags)
- [Interrupts in Multi-Agent Systems](/docs/user-guide/sdk/interrupts-multi-agent/index.md) (2 shared tags)
- [Middleware](/docs/user-guide/sdk/agents/middleware/index.md) (1 shared tag)
- [Tool Executors](/docs/user-guide/sdk/tools/executors/index.md) (1 shared tag)
- [Build a custom plugin](/docs/user-guide/sdk/plugins/custom-plugins/index.md) (1 shared tag)
- [Plugins](/docs/user-guide/sdk/plugins/index.md) (1 shared tag)
- [Model Routing](/docs/user-guide/sdk/model-providers/model-routing/index.md) (1 shared tag)
- [Chaos testing](/docs/user-guide/evals-sdk/chaos_testing/index.md) (1 shared tag)
- [Structured output](/docs/user-guide/sdk/agents/structured-output-behavior/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/event_loop/_retry.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/event_loop/_retry.py)

### TypeScript

- [harness-sdk/strands-ts/src/retry/model-retry-strategy.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/retry/model-retry-strategy.ts)
- [harness-sdk/strands-ts/src/retry/default-model-retry-strategy.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/retry/default-model-retry-strategy.ts)
