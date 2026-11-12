Defined in: [src/models/model.ts:379](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L379)

Base abstract class for model providers. Defines the contract that all model provider implementations must follow.

Model providers handle communication with LLM APIs and implement streaming responses using async iterables.

## Extended by

-   [`BedrockModel`](/docs/api/typescript/BedrockModel/index.md)

## Type Parameters

| Type Parameter | Default type | Description |
| --- | --- | --- |
| `T` *extends* [`BaseModelConfig`](/docs/api/typescript/BaseModelConfig/index.md) | [`BaseModelConfig`](/docs/api/typescript/BaseModelConfig/index.md) | Model configuration type extending BaseModelConfig |

## Constructors

### Constructor

```ts
new Model<T>(): Model<T>;
```

#### Returns

`Model`<`T`\>

## Accessors

### modelId

#### Get Signature

```ts
get modelId(): string;
```

Defined in: [src/models/model.ts:398](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L398)

The model ID from the current configuration, if configured.

##### Returns

`string`

---

### stateful

#### Get Signature

```ts
get stateful(): boolean;
```

Defined in: [src/models/model.ts:414](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L414)

Whether this model manages conversation state server-side.

When `true`, the server tracks conversation context across turns, so the SDK sends only the latest message instead of the full history. After each invocation, the agent’s local message history is cleared automatically.

Reads `modelInfo.capabilities.stateful`, so a provider that keeps state server-side sets it there (see [modelInfo](#modelinfo)) and a `modelInfo` config override can change it.

##### Returns

`boolean`

`false` when unknown

---

### modelInfo

#### Get Signature

```ts
get modelInfo(): ModelInfo;
```

Defined in: [src/models/model.ts:428](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L428)

Everything the SDK knows about the configured model, resolved on each read. Layers, later ones winning: the shared model info for `modelId`, `temporaryMessages` off (a provider that supports them turns them back on), the `contextWindowLimit` config value, and the `modelInfo` config override. Each read returns a new record, so do not compare reads by reference.

A provider that knows better than the shared model info overrides this getter: put its facts over `super.modelInfo`, then the user’s `getConfig().modelInfo` over those so the override still wins: `{ ...info, capabilities: { ...info.capabilities, promptCaching: 'auto', ...config.modelInfo?.capabilities } }`. Do not read [stateful](#stateful) inside the override; it reads this getter.

##### Returns

[`ModelInfo`](/docs/api/typescript/ModelInfo/index.md)

## Methods

### updateConfig()

```ts
abstract updateConfig(modelConfig): void;
```

Defined in: [src/models/model.ts:386](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L386)

Updates the model configuration. Merges the provided configuration with existing settings.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `modelConfig` | `T` | Configuration object with model-specific settings to update |

#### Returns

`void`

---

### getConfig()

```ts
abstract getConfig(): T;
```

Defined in: [src/models/model.ts:393](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L393)

Retrieves the current model configuration.

#### Returns

`T`

The current configuration object

---

### stream()

```ts
abstract stream(messages, options?): AsyncIterable<ModelStreamEvent>;
```

Defined in: [src/models/model.ts:448](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L448)

Streams a conversation with the model. Returns an async iterable that yields streaming events as they occur.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `messages` | [`Message`](/docs/api/typescript/Message/index.md)\[\] | Array of conversation messages |
| `options?` | [`StreamOptions`](/docs/api/typescript/StreamOptions/index.md) | Optional streaming configuration |

#### Returns

`AsyncIterable`<[`ModelStreamEvent`](/docs/api/typescript/ModelStreamEvent/index.md)\>

Async iterable of streaming events

---

### countTokens()

```ts
countTokens(messages, options?): Promise<number>;
```

Defined in: [src/models/model.ts:465](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L465)

Count tokens for the given input before sending to the model.

Used for proactive context management (e.g., triggering compression at a threshold). The base implementation uses a character-based heuristic (chars/4 for text, chars/2 for JSON). It counts only the latest user message’s injected blocks, the ones a model reads.

Subclasses should override this method to use native token counting APIs (e.g., Bedrock CountTokens, Anthropic countTokens, Gemini countTokens) for improved accuracy, falling back to `super.countTokens()` on API failure.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `messages` | [`Message`](/docs/api/typescript/Message/index.md)\[\] | Array of conversation messages to count tokens for |
| `options?` | [`CountTokensOptions`](/docs/api/typescript/CountTokensOptions/index.md) | Optional options containing system prompt and tool specs |

#### Returns

`Promise`<`number`\>

Total input token count

---

### summarize()

```ts
summarize(messages, options?): Promise<SummarizeResult>;
```

Defined in: [src/models/model.ts:490](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L490)

Summarizes `messages`.

`messages` is a request as the caller would send it to `stream()`, along with its tool specs and system prompt. The base implementation sends that request closed by an instruction not to act on it or call tools, followed by `instructions` (or default ones), and otherwise as given, so a caller that replays its own conversation can share its prompt cache. The summary is the reply’s text, including a reply cut off at the output limit or a stop sequence. A reply that ends for another reason, such as a tool call, a cancellation or a guardrail, or that holds no text, gives an empty result.

Every summary is a `summaryBlock`. The base implementation leaves its `provider` unset. A provider that reports `modelInfo.capabilities.serverSideSummary` as `true` overrides this method to summarize server-side and sets `provider` to its own name, using the base implementation when the capability is off or the server-side summary fails, as `AnthropicModel` does. A summary with a `provider` can stand in for the messages it summarized only when they start at the conversation’s first message; a caller that summarizes anything else uses only its text.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `messages` | [`Message`](/docs/api/typescript/Message/index.md)\[\] | The request to summarize, left unmodified |
| `options?` | [`SummarizeOptions`](/docs/api/typescript/SummarizeOptions/index.md) | The request’s system prompt and tools, summarization instructions, cancel signal and agent metadata |

#### Returns

`Promise`<[`SummarizeResult`](/docs/api/typescript/SummarizeResult/index.md)\>

The summary and the token usage of the calls made for it

---

### estimateUtilization()

```ts
estimateUtilization(inputTokens): number;
```

Defined in: [src/models/model.ts:503](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L503)

Estimate the fraction of the model’s context window consumed by the given input token count.

Resolves the model’s context window limit (falling back to DEFAULT\_CONTEXT\_WINDOW\_LIMIT with a warning when not configured) and returns `inputTokens / contextWindowLimit`.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `inputTokens` | `number` | Total input token count (e.g. from a model event’s projectedInputTokens) |

#### Returns

`number`

Token usage ratio (0–1+; above 1.0 means overflow)

---

### streamAggregated()

```ts
streamAggregated(messages, options?): AsyncGenerator<
  | ContentBlock
| ModelStreamEvent, StreamAggregatedResult, undefined>;
```

Defined in: [src/models/model.ts:570](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L570)

Streams a conversation with aggregated content blocks and messages. Returns an async generator that yields streaming events and content blocks, and returns the final message with stop reason and optional metadata.

This method enhances the basic stream() by collecting streaming events into complete ContentBlock and Message objects, which are needed by the agentic loop for tool execution and conversation management.

The method yields:

-   ModelStreamEvent - Original streaming events (passed through)
-   ContentBlock - Complete content block (emitted when block completes)

The method returns:

-   StreamAggregatedResult containing the complete message, stop reason, and optional metadata

All exceptions thrown from this method are wrapped in ModelError to provide a consistent error type for model-related errors. Specific error subtypes like ContextWindowOverflowError, ModelThrottledError, and MaxTokensError are preserved.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `messages` | [`Message`](/docs/api/typescript/Message/index.md)\[\] | Array of conversation messages |
| `options?` | [`StreamOptions`](/docs/api/typescript/StreamOptions/index.md) | Optional streaming configuration |

#### Returns

`AsyncGenerator`< | [`ContentBlock`](/docs/api/typescript/ContentBlock/index.md) | [`ModelStreamEvent`](/docs/api/typescript/ModelStreamEvent/index.md), `StreamAggregatedResult`, `undefined`\>

Async generator yielding ModelStreamEvent | ContentBlock and returning a StreamAggregatedResult

#### Throws

ModelError - Base class for all model-related errors

#### Throws

ContextWindowOverflowError - When input exceeds the model’s context window

#### Throws

ModelThrottledError - When the model provider throttles requests

#### Throws

MaxTokensError - When the model reaches its maximum token limit