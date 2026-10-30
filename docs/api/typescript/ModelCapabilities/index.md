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