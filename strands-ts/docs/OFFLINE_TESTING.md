# Test agents without a model service

The public `@strands-agents/sdk/testing` subpath provides two offline model
providers. They require no model credentials, network service, or test framework.
They are deliberately separate from the main SDK export.

```typescript
import { Agent } from '@strands-agents/sdk'
import { MockMessageModel } from '@strands-agents/sdk/testing'

const model = new MockMessageModel()
  .addTurn({ type: 'toolUseBlock', name: 'weather', toolUseId: 't1', input: { city: 'Shenzhen' } })
  .addTurn({ type: 'textBlock', text: 'It is sunny.' }, {
    usage: { inputTokens: 5, outputTokens: 4, totalTokens: 9 },
  })
const agent = new Agent({ model, tools: [weatherTool], printer: false })
await agent.invoke('What is the weather?')
console.log(model.callCount) // 2
```

`weatherTool` is your tool implementation; scripted tool calls still execute
the agent's registered tools. Mocking the model does not disable tool side
effects. To test a response alone, configure a text turn with no tools.

`addTurn(turn, options?)` accepts a content block, an array of blocks, or an
`Error`. Blocks may be class instances or plain objects with a `type`
discriminator, such as `{ type: 'textBlock', text: 'Hello' }`. Serialized message
data like `{ text: 'Hello' }` is not accepted. `options.stopReason` overrides the
inferred `toolUse`/`endTurn`; `options.usage` adds a metadata event.

- A single configured turn repeats indefinitely, including an error turn.
- Multiple turns are consumed in order; another call after exhaustion throws.
- An empty script throws when consumed.
- `callCount` counts streams when consumption starts, including error and
  exhausted attempts. Merely creating an iterator does not increment it.
- Text, tool-use, reasoning, and citation blocks generate events. Cache points
  generate empty start/stop events. Media, JSON, tool-result, and guard-content
  blocks are skipped. This helper does not simulate a provider's multimodal behavior.
- Instances are stateful; use a new instance for each independent test.

For exact event sequences, use `TestModelProvider`:

```typescript
import { TestModelProvider } from '@strands-agents/sdk/testing'

const model = new TestModelProvider(async function* () {
  yield { type: 'modelMessageStartEvent', role: 'assistant' }
  yield { type: 'modelContentBlockStartEvent' }
  yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Hello' } }
  yield { type: 'modelContentBlockStopEvent' }
  yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
})
```

The factory is invoked afresh for each consumed stream. It can throw before or
between events to test failure handling. `setEventGenerator(factory)` replaces
it for subsequent streams; consuming a stream before a factory is set throws.
Both providers support `getConfig()` and `updateConfig()`; configuration does
not alter their scripted responses. Messages and stream options are ignored.

The subpath exports `MockMessageModel`, `TestModelProvider`, and the types
`MockMessageContentBlock`, `MockMessageTurn`, `MockMessageTurnOptions`, and
`ModelEventGenerator`. It works in Node.js and browser bundles. For a CommonJS
application, use `await import('@strands-agents/sdk/testing')` to consume the
ESM package. Internal `__fixtures__` imports are not part of the published API.
