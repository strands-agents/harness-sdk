Defined in: [src/models/model-info.ts:25](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model-info.ts#L25)

What the model can do. A yes/no fact is a `boolean`; a fact with more than two states is a string union, like [PromptCaching](/docs/api/typescript/PromptCaching/index.md) (which mechanism). A fact about two features together gets its own field named after the pair. `undefined` is unknown either way.

## Properties

### stateful?

```ts
readonly stateful?: boolean;
```

Defined in: [src/models/model-info.ts:27](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model-info.ts#L27)

Whether the model keeps conversation state server-side; [Model.stateful](/docs/api/typescript/Model/index.md#stateful) reads it.

---

### promptCaching?

```ts
readonly promptCaching?: PromptCaching;
```

Defined in: [src/models/model-info.ts:29](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model-info.ts#L29)

Whether and how the model caches prompts.

---

### forcedToolChoice?

```ts
readonly forcedToolChoice?: boolean;
```

Defined in: [src/models/model-info.ts:31](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model-info.ts#L31)

Whether the model accepts a `toolChoice` that forces a tool call (`any` or a named tool).

---

### nativeStructuredOutput?

```ts
readonly nativeStructuredOutput?: boolean;
```

Defined in: [src/models/model-info.ts:33](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model-info.ts#L33)

Whether the provider can make the model’s text output conform to a JSON schema.

---

### serverSideSummary?

```ts
readonly serverSideSummary?: boolean;
```

Defined in: [src/models/model-info.ts:38](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model-info.ts#L38)

Whether the model summarizes history server-side through [Model.summarize](/docs/api/typescript/Model/index.md#summarize); set `false` in `modelInfo` to summarize client-side.

---

### temporaryMessages?

```ts
readonly temporaryMessages?: boolean;
```

Defined in: [src/models/model-info.ts:46](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model-info.ts#L46)

Whether the model and provider take temporary messages: injected text the model reads only until the next user message, such as Anthropic’s turn-scoped system messages. When `true`, the provider receives each `InjectedBlock` as stored and formats it; otherwise it receives only the latest user message’s injected text, as text. The shared data lists the models that take them, but `Model.modelInfo` reports `false` unless the provider can send them (`AnthropicModel`). A `modelInfo` override that turns it on for another provider drops the injected text.