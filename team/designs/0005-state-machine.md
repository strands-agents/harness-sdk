# Strands: State Machine

**Status**: Proposed

**Date**: 2026-03-31

## Overview

This design restructures the Agent loop into discrete steps coordinated by an orchestrator. Today, the Agent class implements its loop in a single `_stream()` method that handles model calls, tool execution, structured output, telemetry, and routing together. Decomposing this into steps simplifies adding new steps, applying cross-cutting concerns uniformly, handling non-linear flow (interrupts, cancellation, async model polling), and checkpointing progress. The public API (`agent.invoke()`, `agent.stream()`, hooks) does not change.

I want to note that this design is a mental model as much as it is an implementation plan. The interfaces and layers don't need to be adopted wholesale, they can be applied incrementally. Even where we don't formalize them in code, this framing can help guide decisions about where new behavior belongs and how to keep the codebase organized as it grows.

## Solution

The agent loop is decomposed into five layers:

- **Clients**: the I/O boundary (e.g., Model, Tool)
- **Steps**: discrete units of work that use clients and produce typed results
- **Middleware**: wraps steps with cross-cutting concerns (e.g., telemetry, checkpointing)
- **Plugins**: register hook callbacks to observe and indirectly influence execution (e.g., cancel, retry)
- **Orchestrators**: coordinate steps, handle routing, and can nest other orchestrators

Steps and orchestrators share the same `invoke`/`stream` interface, enabling nesting and uniform wrapping. All layers operate on shared **state** passed explicitly to each layer.

### State

All layers receive state explicitly, giving them a clear, bounded data contract rather than reaching into the Agent instance for what they need.

`AgentState` holds all per-invocation data:

```typescript
interface AgentState {
  // Dependencies
  model: Model
  toolRegistry: ToolRegistry
  systemPrompt: SystemPrompt
  tracer: Tracer
  meter: Meter
  pluginRegistry: PluginRegistry
  name: string
  id: string

  // Execution data
  messages: Message[]
  metrics: AgentMetric[]
  traces: AgentTrace[]
  interrupt: InterruptState
  app: StateStore  // user-facing key-value state

  // Intra-loop temporaries (step-to-step communication)
  lastModelResult?: StreamAggregatedResult
  structuredOutputChoice?: ToolChoice
  ...
}
```

See [0002-isolated-state](https://github.com/strands-agents/docs/pull/551) for the complete proposal on AgentState lifecycle management (creation, persistence, invocation keys).

### Clients

The I/O boundary. Unchanged from today. Examples:

| Client | What it does |
|--------|-------------|
| `Model` | Sends messages to an LLM, streams back a response |
| `Tool` | Executes a single tool, streams progress |

Clients are stateless, reusable, and unaware of the agent loop.

### Steps

`Step` is a generic base class for the smallest unit of work in the loop. It provides `invoke` (request/response) derived from `stream` (yields events, returns a result). Subclasses only implement `stream`. For the agent loop, steps extend `AgentStep`, which fills in the state type:

```typescript
type AgentStep<TEvent, TResult> = Step<AgentState, TEvent, TResult>
```

Steps write their full results into state (that's how data flows between steps). The `TResult` return value is a typed convenience that surfaces the notable parts, giving the orchestrator direct, namespaced access without digging through state fields. Here are two examples:

**ModelStep**: calls the LLM, yields streaming events, and returns the stop reason and message.

```typescript
class ModelStep extends AgentStep<ModelStreamEvent, ModelStepResult> {
  readonly name = 'model'

  async *stream(state) {
    const result = yield* state.model.streamAggregated(
      state.messages,
      this._buildStreamOptions(state)
    )
    state.lastModelResult = result
    return { type: 'model', stopReason: result.stopReason, message: result.message }
  }
}
```

**ToolStep**: runs a single tool, yields progress events, and returns the tool result.

```typescript
class ToolStep extends AgentStep<ToolStreamEvent, ToolStepResult> {
  readonly name = 'tool'

  async *stream(state) {
    const toolUse = state.currentToolUse!
    const tool = state.toolRegistry.get(toolUse.name)
    if (!tool) {
      return { type: 'tool', result: this._errorResult(toolUse, 'not found') }
    }
    const result = yield* tool.stream({ toolUse, agent: state })
    return { type: 'tool', result }
  }
}
```

### Middleware

Middleware sits between the orchestrator and a step, wrapping the step's `stream` method with additional behavior. It directly controls execution: it can intercept, skip, retry, or transform the step's result. This is useful for cross-cutting concerns (behavior that applies uniformly across multiple steps, like telemetry or checkpointing) without duplicating logic in each step.

There are two kinds:

**Built-in middleware** ships with the SDK and is always present. It's configured through state at runtime. One possible way to manage built-in middleware is via decorator syntax (`@`) on step class methods, though the exact mechanism is an implementation detail. Examples:

| Middleware | What it does |
|-----------|-------------|
| `@traced` | Creates a telemetry span around the step, records result or error |
| `@retryable` | Retries the step on transient errors with configurable backoff |

**Custom middleware** is user-provided via the `middleware` param on the Agent constructor. It implements the `Middleware` interface:

```typescript
interface Middleware {
  wrap(step: Step): Step
}
```

Example: a rate limiter that throttles step execution.

```typescript
class RateLimiter implements Middleware {
  constructor(private _maxPerSecond: number) {}

  wrap(step: Step): Step {
    return {
      ...step,
      async *stream(state) {
        await this._acquireToken()
        return yield* step.stream(state)
      },
    }
  }
}

const agent = new Agent({
  middleware: [new RateLimiter({ maxPerSecond: 10 })],
})
```

### Plugins

Plugins register hook callbacks to observe and indirectly influence step execution. The SDK fires lifecycle events (e.g., `BeforeModelCallEvent`, `AfterToolCallEvent`) at the appropriate points, and plugin callbacks react to them by setting flags like `retry` or `cancel` that the step or middleware responds to.

This is the existing hook system, unchanged by this design.

```typescript
const agent = new Agent({
  plugins: [myLoggingPlugin, myAnalyticsPlugin],
})
```

### Orchestrators

`Orchestrator` is a generic base class that coordinates steps and other orchestrators. Like `Step`, it provides `invoke` derived from `stream`. Orchestrators can nest: a parent orchestrator treats a sub-orchestrator the same as a step.

For the agent loop, orchestrators extend `AgentOrchestrator`:

```typescript
type AgentOrchestrator = Orchestrator<AgentState, AgentStreamEvent>
```

**ToolOrchestrator**: runs `ToolStep` for each tool use block.

```typescript
class ToolOrchestrator extends AgentOrchestrator {
  async *stream(state) {
    const toolUseBlocks = this._extractToolUseBlocks(state)
    for (const block of toolUseBlocks) {
      yield* this._toolStep.stream({ ...state, currentToolUse: block })
    }
    return { type: 'tools' }
  }
}
```

**Agent**: the top-level orchestrator. Agent follows the orchestrator pattern internally but doesn't extend `Orchestrator` directly, since its public `stream` method takes `InvokeArgs` rather than `(state)` for backwards compatibility. It creates the state, then runs the loop.

```typescript
class Agent {
  async *stream(args: InvokeArgs) {
    const state = this._buildState(args)

    while (true) {
      const result = yield* this._model.stream(state)

      if (result.stopReason !== 'toolUse') {
        return { type: 'done', result: this._buildResult(state) }
      }

      yield* this._toolOrchestrator.stream(state)
    }
  }
}
```

The public API does not change: `agent.invoke()`, `agent.stream()`, `agent.addHook()`, `agent.messages`, and `agent.appState` all work as before.

The full structure:

```
Agent (Orchestrator)
├── ModelStep (Step)
└── ToolOrchestrator (Sub-orchestrator)
    ├── ToolStep (Step)
    ├── ToolStep (Step)
    └── ToolStep (Step)
```


## Capabilities

The step/orchestrator decomposition enables several capabilities that benefit from discrete, well-bounded execution units.

### Cross-Cutting Middleware

Middleware applies behavior uniformly across steps without each step needing to know about it. Caching is a good example: a middleware can check for a cached result before a step runs and store the result after it completes, without any step being aware of the cache.

```typescript
class CacheMiddleware implements Middleware {
  constructor(private _cache: Map<string, unknown> = new Map()) {}

  wrap(step: Step): Step {
    return {
      ...step,
      async *stream(state) {
        const key = this._buildKey(step.name, state)
        const cached = this._cache.get(key)
        if (cached) {
          return cached
        }

        const result = yield* step.stream(state)
        this._cache.set(key, result)
        return result
      },
    }
  }
}

const agent = new Agent({
  middleware: [new CacheMiddleware()],
})
```

Every step (model calls, tool calls, sub-orchestrators) gets the same caching logic. Multiple middleware compose naturally: a cache, a rate limiter, and a guardrail can each be separate middleware applied to every step, rather than duplicated logic inside each one.

### Checkpointing

Because the agent loop is composed of discrete steps, the orchestrator can return after each step with a checkpoint token that records the current position. The caller reinvokes with that token to resume from where it left off. When checkpointing is not enabled, the loop runs normally.

```typescript
class Agent {
  private _steps = [this._modelStep, this._toolOrchestrator]

  /**
   * Variant of the agent loop that resolves steps by index, enabling checkpoint/resume
   * at any position. The loop doesn't have to be structured this way though. This is
   * more demonstrative.
   */
  async *stream(args: InvokeArgs) {
    const state = args.checkpoint?.state ?? this._buildState(args)
    let stepIndex = args.checkpoint?.stepIndex ?? 0

    while (true) {
      const step = this._steps[stepIndex]
      const result = yield* step.stream(state)

      if (result.stopReason === 'done') {
        return { type: 'done', result: this._buildResult(state) }
      }

      stepIndex = (stepIndex + 1) % this._steps.length

      if (state.checkpointing) {
        return { type: 'checkpoint', checkpoint: { stepIndex, state } }
      }
    }
  }
}
```

The checkpoint token is small and serializable: just a step index and the state reference. The caller drives the loop externally:

```typescript
let result = await agent.invoke({ prompt: 'Hello', checkpointing: true })

while (result.type === 'checkpoint') {
  // persist state, hand off to another system, sleep, etc.
  result = await agent.invoke({ checkpoint: result.checkpoint })
}
```

This pattern enables durable execution with systems like [Temporal](https://temporal.io/), where each step becomes a separate Activity cached in Temporal's Event History. On crash recovery, completed steps replay from cache and the loop resumes from the last incomplete step. See the [checkpoint mode prototype](https://github.com/strands-agents/sdk-typescript/compare/main...pgrayy:strands-sdk-typescript:prototype/checkpoint-mode?expand=1) for a working reference implementation.

### Sub-Orchestration

Because orchestrators and steps share the same `invoke`/`stream` interface, any slot in the step sequence can be a sub-orchestrator that coordinates its own steps internally. The agent loop doesn't distinguish between the two.

Tool execution is one example. The default `ToolOrchestrator` runs tools sequentially, but swapping in a `ConcurrentToolOrchestrator` changes the execution strategy without touching `ToolStep` or the agent loop:

```typescript
const agent = new Agent({
  toolOrchestrator: new ConcurrentToolOrchestrator({ maxConcurrency: 3 }),
})
```

The `ToolOrchestrator` is itself composed of `ToolStep` instances. From the agent loop's perspective, it's just another entry in the step sequence that happens to run sub-steps internally.

### Isolated Invocation State

Each invocation gets its own `AgentState` instance. Steps receive state explicitly, so concurrent invocations on the same agent don't share mutable data:

```typescript
// Each invocation creates its own state
const [result1, result2] = await Promise.all([
  agent.invoke({ prompt: 'Summarize this document' }),
  agent.invoke({ prompt: 'Translate this to French' }),
])
// result1 and result2 operated on separate AgentState instances
```

The agent's dependencies and execution data all live in `AgentState`. Steps don't reach into the agent instance for what they need, they operate on the state they're given. See [0002-isolated-state](https://github.com/strands-agents/docs/pull/551) for the full proposal on state lifecycle management.

## Guidelines

When deciding where new behavior belongs:

| Layer | Need | Role | Example |
|-------|------|------|---------|
| Client | External I/O | Talks to an external system | Model, Tool |
| Step | Unit of work | Performs one discrete task in the loop | ModelStep, ToolStep |
| Middleware | Wrapping | Intercepts, skips, retries, or transforms a step | `@traced`, `@retryable`, guardrails |
| Plugin | Observation | Reacts to lifecycle events, signals intent via flags | Logging, cancel/retry via event flags |
| Orchestrator | Coordination | Decides which steps run and in what order | ToolOrchestrator, Agent |

## Resources

- [0002-isolated-state](https://github.com/strands-agents/docs/pull/551): complementary proposal for state lifecycle management
- [Durable Execution Provider Integration](https://github.com/strands-agents/docs/pull/584): durable execution proposal that this design enables
