# Testing Guidelines - Strands TypeScript SDK

> **IMPORTANT**: When writing tests, you **MUST** follow the guidelines in this document. These patterns ensure consistency, maintainability, and proper test coverage across the SDK.

This document contains comprehensive testing guidelines for the Strands TypeScript SDK. For general development guidance, see [AGENTS.md](../AGENTS.md).

## Test Fixtures Quick Reference

All test fixtures are located in `src/__fixtures__/`. Use these helpers to reduce boilerplate and ensure consistency.

| Fixture                | File                    | When to Use                                                                          | Details                                                                     |
| ---------------------- | ----------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `MockMessageModel`     | `mock-message-model.ts` | Agent loop tests - specify content blocks, auto-generates stream events              | [Model Fixtures](#model-fixtures-mock-message-modelts-model-test-helpersts) |
| `TestModelProvider`    | `model-test-helpers.ts` | Low-level model tests - precise control over individual `ModelStreamEvent` sequences | [Model Fixtures](#model-fixtures-mock-message-modelts-model-test-helpersts) |
| `collectIterator()`    | `model-test-helpers.ts` | Collect all items from any async iterable into an array                              | [Model Fixtures](#model-fixtures-mock-message-modelts-model-test-helpersts) |
| `collectGenerator()`   | `model-test-helpers.ts` | Collect yielded items AND final return value from async generators                   | [Model Fixtures](#model-fixtures-mock-message-modelts-model-test-helpersts) |
| `MockHookProvider`     | `mock-hook-provider.ts` | Record and verify hook invocations during agent execution                            | [Hook Fixtures](#hook-fixtures-mock-hook-providerts)                        |
| `createMockTool()`     | `tool-helpers.ts`       | Create mock tools with custom result behavior                                        | [Tool Fixtures](#tool-fixtures-tool-helpersts)                              |
| `createRandomTool()`   | `tool-helpers.ts`       | Create minimal mock tools when execution doesn't matter                              | [Tool Fixtures](#tool-fixtures-tool-helpersts)                              |
| `createMockContext()`  | `tool-helpers.ts`       | Create mock `ToolContext` for testing tool implementations directly                  | [Tool Fixtures](#tool-fixtures-tool-helpersts)                              |
| `createMockAgent()`    | `agent-helpers.ts`      | Create minimal mock Agent with messages and state                                    | [Agent Fixtures](#agent-fixtures-agent-helpersts)                           |
| `expectAgentResult()`  | `agent-helpers.ts`      | Assert on `AgentResult` with expected stop reason, message text, cycle count, and traces | [Agent Fixtures](#agent-fixtures-agent-helpersts)                           |
| `createCancellableAgent()` | `agent-helpers.ts`  | Create a minimal `InvokableAgent` that sleeps for a configurable delay and aborts early when its `cancelSignal` fires — used for timeout/cancellation tests | [Agent Fixtures](#agent-fixtures-agent-helpersts)                           |
| `isNode` / `isBrowser` | `environment.ts`        | Environment detection for conditional test execution                                 | [Environment Fixtures](#environment-fixtures-environmentts)                 |
| `MockSpan`             | `mock-span.ts`          | Mock OTEL Span that records all setAttribute/addEvent/end calls for assertion            | [Telemetry Fixtures](#telemetry-fixtures-mock-spants-mock-meterts)          |
| `eventAttr()`          | `mock-span.ts`          | Extract a string attribute from a mock span event                                        | [Telemetry Fixtures](#telemetry-fixtures-mock-spants-mock-meterts)          |
| `MockMeter`            | `mock-meter.ts`         | Mock OTEL Meter that records all counter/histogram instrument calls for assertion        | [Telemetry Fixtures](#telemetry-fixtures-mock-spants-mock-meterts)          |
| `expectLoopMetrics()`  | `metrics-helpers.ts`    | Assert on `AgentMetrics` with expected cycle count, tool names, and optional token usage | [Metrics Fixtures](#metrics-fixtures-metrics-helpersts)                     |
| `findMetricValue()`    | `metrics-helpers.ts`    | Find the latest data point value for a named OTEL metric from ResourceMetrics            | [Metrics Fixtures](#metrics-fixtures-metrics-helpersts)                     |

## Test Organization

### Unit Test Location

**Rule**: Unit test files are co-located with source files, grouped in a directory named `__tests__`

```
src/subdir/
├── agent.ts                    # Source file
├── model.ts                    # Source file
└── __tests__/
    ├── agent.test.ts           # Tests for agent.ts
    └── model.test.ts           # Tests for model.ts
```

### Integration Test Location

**Rule**: Integration tests are separate in `test/integ/`

```
test/integ/
├── api.test.ts                 # Tests public API
└── environment.test.ts         # Tests environment compatibility
```

### Test File Naming

**File naming determines which environment(s) tests run in:**

- `*.test.ts` — runs in **both** Node.js and browser environments
- `*.test.node.ts` — runs **only** in Node.js environment
- `*.test.browser.ts` — runs **only** in browser environment

This naming convention applies to both unit tests (`src/**/__tests__/`) and integration tests (`test/integ/`).

**Examples:**

```
src/module/__tests__/
├── module.test.ts           # Runs in Node.js AND browser
├── module.test.node.ts      # Runs in Node.js only
└── module.test.browser.ts   # Runs in browser only
```

Use environment-specific test files when tests depend on platform-specific features like filesystem access, environment variables, or browser APIs.

## Test Structure Pattern

Follow this nested describe pattern for consistency:

### For Functions

```typescript
import { describe, it, expect } from 'vitest'
import { functionName } from '../module'

describe('functionName', () => {
  describe('when called with valid input', () => {
    it('returns expected result', () => {
      const result = functionName('input')
      expect(result).toBe('expected')
    })
  })

  describe('when called with edge case', () => {
    it('handles gracefully', () => {
      const result = functionName('')
      expect(result).toBeDefined()
    })
  })
})
```

### For Classes

```typescript
import { describe, it, expect } from 'vitest'
import { ClassName } from '../module'

describe('ClassName', () => {
  describe('methodName', () => {
    it('returns expected result', () => {
      const instance = new ClassName()
      const result = instance.methodName()
      expect(result).toBe('expected')
    })

    it('handles error case', () => {
      const instance = new ClassName()
      expect(() => instance.methodName()).toThrow()
    })
  })

  describe('anotherMethod', () => {
    it('performs expected action', () => {
      // Test implementation
    })
  })
})
```

### Key Principles

- Top-level `describe` uses the function/class name
- Nested `describe` blocks group related test scenarios
- Use descriptive test names without "should" prefix
- Group tests by functionality or scenario
- Prefer top-level `import` — only use dynamic `import()` when the module must load after `vi.mock()` or is platform-gated

## Writing Effective Tests

```typescript
// Good: Clear, specific test
describe('calculateTotal', () => {
  describe('when given valid numbers', () => {
    it('returns the sum', () => {
      expect(calculateTotal([1, 2, 3])).toBe(6)
    })
  })

  describe('when given empty array', () => {
    it('returns zero', () => {
      expect(calculateTotal([])).toBe(0)
    })
  })
})

// Bad: Vague, unclear test
describe('calculateTotal', () => {
  it('works', () => {
    expect(calculateTotal([1, 2, 3])).toBeTruthy()
  })
})
```

## Comments in Tests

The evergreen-comment rule applies here too. **Only a regression test for a discovered bug carries an issue/PR reference** — it links the issue it guards against and describes the behavior it now guarantees, never narrating what the code used to do. Prefer `// guards against unbounded retry on a null tool name (#642)` over `// we used to hang on null here`. A test written as part of feature development gets no issue or PR reference.

## Test Batching Strategy

**Rule**: When test setup cost exceeds test logic cost, you MUST batch related assertions into a single test. Prefer extending an existing test over adding a new one. If a test already arranges the scenario your new behavior needs, add the assertion(s) there rather than duplicating the setup. Reach for a new test only for the cases listed under "You SHOULD keep separate tests for" below.

**You MUST batch (or extend an existing test) when**:

- Setup complexity > test logic complexity
- Multiple assertions verify the same object state
- Related behaviors share expensive context

**You SHOULD keep separate tests for**:

- Distinct behaviors or execution paths
- Error conditions
- Different input scenarios

**Bad - Redundant setup**:

```typescript
it('has correct tool name', () => {
  const tool = createComplexTool({
    /* expensive setup */
  })
  expect(tool.toolName).toBe('testTool')
})

it('has correct description', () => {
  const tool = createComplexTool({
    /* same expensive setup */
  })
  expect(tool.description).toBe('Test description')
})
```

**Good - Batched properties**:

```typescript
it('creates tool with correct properties', () => {
  const tool = createComplexTool({
    /* setup once */
  })
  expect(tool.toolName).toBe('testTool')
  expect(tool.description).toBe('Test description')
  expect(tool.toolSpec.name).toBe('testTool')
})
```

## Object Assertion Best Practices

**Prefer testing entire objects at once** instead of individual properties for better readability and test coverage.

```typescript
// ✅ Good: Verify entire object at once
it('returns expected user object', () => {
  const user = getUser('123')
  expect(user).toEqual({
    id: '123',
    name: 'John Doe',
    email: 'john@example.com',
    isActive: true,
  })
})

// ✅ Good: Verify entire array of objects
it('yields expected stream events', async () => {
  const events = await collectIterator(stream)
  expect(events).toEqual([
    { type: 'streamEvent', data: 'Starting...' },
    { type: 'streamEvent', data: 'Processing...' },
    { type: 'streamEvent', data: 'Complete!' },
  ])
})

// ❌ Bad: Testing individual properties
it('returns expected user object', () => {
  const user = getUser('123')
  expect(user).toBeDefined()
  expect(user.id).toBe('123')
  expect(user.name).toBe('John Doe')
  expect(user.email).toBe('john@example.com')
  expect(user.isActive).toBe(true)
})

// ❌ Bad: Testing array elements individually in a loop
it('yields expected stream events', async () => {
  const events = await collectIterator(stream)
  for (const event of events) {
    expect(event.type).toBe('streamEvent')
    expect(event).toHaveProperty('data')
  }
})
```

**Benefits of testing entire objects**:

- **More concise**: Single assertion instead of multiple
- **Better test coverage**: Catches unexpected additional or missing properties
- **More readable**: Clear expectation of the entire structure
- **Easier to maintain**: Changes to the object require updating one place

**Use cases**:

- Always use `toEqual()` for object and array comparisons
- Use `toBe()` only for primitive values and reference equality
- When testing error objects, verify the entire structure including message and type

## What to Test

**Testing Approach:**

- You **MUST** write tests for implementations (functions, classes, methods)
- You **SHOULD NOT** write tests for interfaces since TypeScript compiler already enforces type correctness
- You **SHOULD** write Vitest type tests (`*.test-d.ts`) for complex types to ensure backwards compatibility

**Example Implementation Test:**

```typescript
describe('BedrockModel', () => {
  it('streams messages correctly', async () => {
    const provider = new BedrockModel(config)
    const stream = provider.stream(messages)

    for await (const event of stream) {
      if (event.type === 'modelMessageStartEvent') {
        expect(event.role).toBe('assistant')
      }
    }
  })
})
```

## Test Coverage

- **Minimum**: 80% coverage required (enforced by Vitest)
- **Target**: Aim for high coverage on critical paths
- **Exclusions**: Test files, config files, generated code

## Test Model Providers

**When to use each test provider:**

- **`MockMessageModel`**: For agent loop tests and high-level flows - focused on content blocks
- **`TestModelProvider`**: For low-level event streaming tests where you need precise control over individual events

### MockMessageModel - Content-Focused Testing

For tests focused on messages, you SHOULD use `MockMessageModel` with a content-focused API that eliminates boilerplate:

```typescript
import { MockMessageModel } from '../__fixtures__/mock-message-model'

// ✅ RECOMMENDED - Single content block (most common)
const provider = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })

// ✅ RECOMMENDED - Array of content blocks
const provider = new MockMessageModel().addTurn([
  { type: 'textBlock', text: 'Let me help' },
  { type: 'toolUseBlock', name: 'calc', toolUseId: 'id-1', input: {} },
])

// ✅ RECOMMENDED - Multi-turn with builder pattern
const provider = new MockMessageModel()
  .addTurn({ type: 'toolUseBlock', name: 'calc', toolUseId: 'id-1', input: {} }) // Auto-derives 'toolUse'
  .addTurn({ type: 'textBlock', text: 'The answer is 42' }) // Auto-derives 'endTurn'

// ✅ OPTIONAL - Explicit stopReason when needed
const provider = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Partial response' }, { stopReason: 'maxTokens' })

// ✅ OPTIONAL - Token usage metadata (emits modelMetadataEvent after message stop)
const provider = new MockMessageModel()
  .addTurn({ type: 'toolUseBlock', name: 'calc', toolUseId: 'id-1', input: {} }, {
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  })
  .addTurn({ type: 'textBlock', text: 'Done' }, {
    usage: { inputTokens: 200, outputTokens: 30, totalTokens: 230 },
  })

// ✅ OPTIONAL - Error handling
const provider = new MockMessageModel()
  .addTurn({ type: 'textBlock', text: 'Success' })
  .addTurn(new Error('Model failed'))
```

## Testing Hooks

When testing hook behavior, you **MUST** use `agent.hooks.addCallback()` for registering single callbacks when `agent.hooks` is available. Do NOT create inline `HookProvider` objects — this is an anti-pattern for single callbacks.

```typescript
// ✅ CORRECT - Use agent.hooks.addCallback() for single callbacks
const agent = new Agent({ model, tools: [tool] })

agent.hooks.addCallback(BeforeToolCallEvent, (event: BeforeToolCallEvent) => {
  event.toolUse = {
    ...event.toolUse,
    input: { value: 42 },
  }
})

// ✅ CORRECT - Use MockHookProvider to record and verify hook invocations
const hookProvider = new MockHookProvider()
const agent = new Agent({ model, hooks: [hookProvider] })
await agent.invoke('Hi')
expect(hookProvider.invocations).toContainEqual(new BeforeInvocationEvent({ agent }))

// ❌ WRONG - Do NOT create inline HookProvider objects
const switchToolHook = {
  registerCallbacks: (registry: HookRegistry) => {
    registry.addCallback(BeforeToolCallEvent, (event: BeforeToolCallEvent) => {
      if (event.toolUse.name === 'tool1') {
        event.tool = tool2
      }
    })
  },
}
```

**When to use each approach:**

- **`agent.hooks.addCallback()`** - For adding a single callback to verify hook behavior (e.g., modifying tool input, switching tools)
- **`MockHookProvider`** - For recording and verifying hook lifecycle behavior and that specific hook events fired during execution

## Test Fixtures Reference

Usage details and examples for the fixtures indexed in the [Quick Reference table](#test-fixtures-quick-reference) above.

### Model Fixtures (`mock-message-model.ts`, `model-test-helpers.ts`)

```typescript
// MockMessageModel for agent tests
const model = new MockMessageModel()
  .addTurn({ type: 'toolUseBlock', name: 'calc', toolUseId: 'id-1', input: {} })
  .addTurn({ type: 'textBlock', text: 'Done' })

// collectIterator for stream results
const events = await collectIterator(agent.stream('Hi'))
```

### Hook Fixtures (`mock-hook-provider.ts`)

- **`MockHookProvider`** - Pass to `Agent({ hooks: [provider] })`.
  - Use `{ includeModelEvents: false }` to exclude model streaming and result events from recordings.
  - Access `provider.invocations` to verify hook events fired.

```typescript
// Record and verify hook invocations
const hookProvider = new MockHookProvider({ includeModelEvents: false })
const agent = new Agent({ model, hooks: [hookProvider] })

await agent.invoke('Hi')

expect(hookProvider.invocations[0]).toEqual(new BeforeInvocationEvent({ agent }))
```

### Tool Fixtures (`tool-helpers.ts`)

```typescript
// Mock tool with custom result
const tool = createMockTool(
  'calculator',
  () => new ToolResultBlock({ toolUseId: 'id', status: 'success', content: [new TextBlock('42')] })
)

// Minimal tool when execution doesn't matter
const tool = createRandomTool('myTool')
```

**When to use fixtures vs `FunctionTool` directly:**

Use `createMockTool()` or `createRandomTool()` when tools are incidental to the test. Use `FunctionTool` or `tool()` directly only when testing tool-specific behavior.

```typescript
// ✅ Use fixtures when testing agent/hook behavior
const tool = createMockTool('testTool', () => ({
  type: 'toolResultBlock',
  toolUseId: 'tool-1',
  status: 'success' as const,
  content: [new TextBlock('Success')],
}))
const agent = new Agent({ model, tools: [tool] })

// ❌ Don't use FunctionTool when tool behavior is irrelevant to the test
const tool = new FunctionTool({ name: 'testTool', description: '...', inputSchema: {...}, callback: ... })
```

### Agent Fixtures (`agent-helpers.ts`)

- **`createMockAgent(data?)`** - Use for testing components that need an Agent reference without full agent behavior.

```typescript
const agent = createMockAgent({
  messages: [new Message({ role: 'user', content: [new TextBlock('Hi')] })],
  state: { key: 'value' },
})
```

- **`expectAgentResult(options)`** - Asymmetric matcher for `AgentResult`. Reduces deeply nested assertions by combining stop reason, message text, metrics, and traces validation in one matcher.

```typescript
import { expectAgentResult } from '../__fixtures__/agent-helpers'

// ✅ RECOMMENDED - Clean, readable assertion
expect(result).toEqual(
  expectAgentResult({
    stopReason: 'endTurn',
    messageText: 'Hello, world!',
    cycleCount: 1,
    traceCount: 1,
  })
)

// ✅ With tools and detailed metrics
expect(result).toEqual(
  expectAgentResult({
    stopReason: 'endTurn',
    messageText: 'The answer is 42',
    cycleCount: 2,
    toolNames: ['calculator'],
    traceCount: 2,
    usage: { inputTokens: 300, outputTokens: 80, totalTokens: 380 },
  })
)

// ✅ For detailed trace structure validation, follow up with specific assertions
expect(result).toEqual(
  expectAgentResult({
    stopReason: 'endTurn',
    messageText: 'Done',
    cycleCount: 2,
    toolNames: ['calc'],
  })
)
// Verify detailed trace structure
expect(result.traces).toEqual([
  expect.objectContaining({
    name: 'Cycle 1',
    children: expect.arrayContaining([
      expect.objectContaining({ name: 'stream_messages' }),
      expect.objectContaining({ name: 'Tool: calc' }),
    ]),
  }),
  expect.objectContaining({
    name: 'Cycle 2',
    children: expect.arrayContaining([expect.objectContaining({ name: 'stream_messages' })]),
  }),
])

// ❌ AVOID - Deeply nested, hard to read
expect(result).toEqual(
  expect.objectContaining({
    stopReason: 'endTurn',
    lastMessage: expect.objectContaining({
      role: 'assistant',
      content: expect.arrayContaining([expect.objectContaining({ type: 'textBlock', text: 'Hello' })]),
    }),
    metrics: expectLoopMetrics({ cycleCount: 1 }),
    traces: expect.arrayContaining([expect.objectContaining({ name: 'Cycle 1' })]),
  })
)
```

**Options:**

- `stopReason` (required) - Expected stop reason ('endTurn', 'toolUse', 'maxTokens')
- `messageText` (optional) - Expected text content in last assistant message's TextBlock. When omitted, only validates message exists with role 'assistant'
- `cycleCount` (required) - Expected number of agent loop cycles
- `traceCount` (optional) - Expected exact number of traces. When omitted, validates at least one trace exists
- `toolNames` (optional) - Expected tool names that were invoked
- `usage` (optional) - Expected token usage. When omitted, validates shape with `expect.any(Number)`

- **`createCancellableAgent(id, delayMs, structuredOutput?)`** - Use for exercising timeout and cancellation behavior in multi-agent orchestrators (swarm, graph) without standing up a full Agent.

```typescript
import { createCancellableAgent } from '../__fixtures__/agent-helpers'

// Plain slow agent for a nodeTimeout test
const slow = createCancellableAgent('slow', 100)

// With a swarm handoff as structured output
const handoffAgent = createCancellableAgent('a', 30, { agentId: 'b', message: 'to b' })
```

### Environment Fixtures (`environment.ts`)

```typescript
import { isNode } from '../__fixtures__/environment'

// Skip tests that require Node.js features in browser
describe.skipIf(!isNode)('Node.js specific features', () => {
  it('uses environment variables', () => {
    expect(process.env.NODE_ENV).toBeDefined()
  })
})
```

### Telemetry Fixtures (`mock-span.ts`, `mock-meter.ts`)

- **`MockSpan`** - Use with `vi.mock('@opentelemetry/api')` to intercept tracer span creation.
  - Access `mockSpan.calls.setAttribute` etc. to verify recorded calls.
  - Use `mockSpan.getAttributeValue(key)` to look up a specific attribute.
  - Use `mockSpan.getEvents(name)` to filter events by name.
- **`MockMeter`** - Use with `vi.spyOn(otelMetrics, 'getMeter').mockReturnValue(mockMeter)` to intercept meter creation.
  - Use `mockMeter.getCounter(name)` / `mockMeter.getHistogram(name)` to retrieve an instrument by metric name.
  - Counters and histograms expose `.dataPoints` (array of `{ value, attributes }`) and `.sum` (total of all values).

```typescript
import { MockSpan, eventAttr } from '../__fixtures__/mock-span'

// Mock the OTEL API and inject MockSpan
const mockSpan = new MockSpan()
const mockStartSpan = vi.fn().mockReturnValue(mockSpan)
vi.mocked(trace.getTracer).mockReturnValue({ startSpan: mockStartSpan, startActiveSpan: vi.fn() })

// Assert on span attributes and events
expect(mockSpan.getAttributeValue('gen_ai.agent.name')).toBe('test-agent')
expect(mockSpan.getEvents('gen_ai.user.message')).toHaveLength(1)
expect(eventAttr(mockSpan.getEvents('gen_ai.choice')[0]!, 'finish_reason')).toBe('end_turn')
```

```typescript
import { MockMeter } from '../__fixtures__/mock-meter'

// Mock the OTEL API and inject MockMeter
const mockMeter = new MockMeter()
vi.spyOn(otelMetrics, 'getMeter').mockReturnValue(mockMeter)

const m = new Meter()
m.startNewInvocation()

// Assert on collected metric values
expect(mockMeter.getCounter('gen_ai.agent.invocation.count')?.sum).toBe(1)
expect(mockMeter.getHistogram('gen_ai.agent.cycle.duration')?.sum).toBe(2000)
expect(mockMeter.getCounter('gen_ai.agent.tool.call.count')?.dataPoints).toStrictEqual([
  { value: 1, attributes: { 'gen_ai.tool.name': 'search' } },
])
```

### Metrics Fixtures (`metrics-helpers.ts`)

- **`expectLoopMetrics({ cycleCount, toolNames?, usage? })`** - When `usage` is provided, asserts exact token counts. When omitted, falls back to shape-level assertions with `expect.any(Number)`.
- **`findMetricValue(resourceMetrics, metricName)`** - Flattens the OTEL ResourceMetrics → ScopeMetrics → MetricData hierarchy and returns the value of the last data point for the matching metric name. Returns `undefined` if not found.

```typescript
import { expectLoopMetrics } from '../__fixtures__/metrics-helpers'

// Shape-level assertion (no concrete token counts)
expect(result).toEqual(
  new AgentResult({
    stopReason: 'endTurn',
    lastMessage: expect.objectContaining({ role: 'assistant' }),
    metrics: expectLoopMetrics({ cycleCount: 1 }),
  })
)

// With tool names
expect(result).toEqual(
  new AgentResult({
    stopReason: 'endTurn',
    lastMessage: expect.objectContaining({ role: 'assistant' }),
    metrics: expectLoopMetrics({ cycleCount: 2, toolNames: ['calc'] }),
  })
)

// With concrete token usage (pair with MockMessageModel usage param)
expect(result).toEqual(
  new AgentResult({
    stopReason: 'endTurn',
    lastMessage: expect.objectContaining({ role: 'assistant' }),
    metrics: expectLoopMetrics({
      cycleCount: 2,
      toolNames: ['calc'],
      usage: { inputTokens: 300, outputTokens: 80, totalTokens: 380 },
    }),
  })
)
```

```typescript
import { findMetricValue } from '../__fixtures__/metrics-helpers'

// Find a counter value from OTEL InMemoryMetricExporter output
const cycleCount = findMetricValue(metricExporter.getMetrics(), 'gen_ai.agent.cycle.count')
expect(cycleCount).toBeGreaterThanOrEqual(1)

// Check a histogram was emitted
const duration = findMetricValue(metrics, 'gen_ai.agent.cycle.duration')
expect(duration).toBeDefined()
```

## Multi-Environment Testing

The SDK is designed to work seamlessly in both Node.js and browser environments. Our test suite validates this by running tests in both environments using Vitest's browser mode with Playwright.

### Test Projects

The test suite is organized into three projects:

1. **unit-node** (green): Unit tests running in Node.js environment
2. **unit-browser** (cyan): Same unit tests running in Chromium browser
3. **integ** (magenta): Integration tests running in Node.js

### Environment-Specific Test Patterns

- You MUST write tests that are environment-agnostic unless they depend on Node.js features like filesystem or env-vars

Some tests require Node.js-specific features (like process.env, AWS SDK) and should be skipped in browser environments:

```typescript
import { describe, it, expect } from 'vitest'
import { isNode } from '../__fixtures__/environment'

// Tests will run in Node.js, skip in browser
describe.skipIf(!isNode)('Node.js specific features', () => {
  it('uses environment variables', () => {
    // This test accesses process.env
    expect(process.env.NODE_ENV).toBeDefined()
  })
})
```

### Environment Variable Stubbing

When stubbing environment variables with `vi.stubEnv()`, you do **not** need to wrap calls in `if (isNode)` conditions. Vitest handles this automatically across environments, and the vitest config has `unstubEnvs: true` which restores env vars after each test.

```typescript
// ✅ CORRECT - No condition needed
beforeEach(() => {
  vi.stubEnv('API_KEY', 'test-key')
})

// ❌ WRONG - Unnecessary condition
beforeEach(() => {
  if (isNode) {
    vi.stubEnv('API_KEY', 'test-key')
  }
})
```

Similarly, you do **not** need to call `vi.unstubAllEnvs()` in `afterEach` since the vitest config handles this automatically.

## Development Commands

See [AGENTS.md - Development Commands](../AGENTS.md#development-commands) for the test-related npm scripts.

## Checklist Items

- [ ] Do the tests use relevant helpers from `src/__fixtures__/` as noted in the "Test Fixtures Quick Reference" table above?
- [ ] Are recurring code or patterns extracted to functions for better usability/readability?
- [ ] Are tests focused on verifying one or two things only?
- [ ] Are tests written concisely enough that the bulk of each test is important to the test instead of boilerplate code?
- [ ] Are tests asserting on the entire object instead of specific fields?
