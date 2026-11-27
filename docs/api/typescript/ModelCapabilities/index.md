Defined in: [src/models/model-info.ts:32](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model-info.ts#L32)

What the model can do. A yes/no fact is a `boolean`; a fact with more than two states is a string union, like [PromptCaching](/docs/api/typescript/PromptCaching/index.md) (which mechanism); a set of supported values is a list, where `[]` means none. A fact about two features together gets its own field named after the pair. `undefined` is unknown either way.

## Properties

### stateful?

```ts
readonly stateful?: boolean;
```

Defined in: [src/models/model-info.ts:34](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model-info.ts#L34)

Whether the model keeps conversation state server-side; [Model.stateful](/docs/api/typescript/Model/index.md#stateful) reads it.

---

### promptCaching?

```ts
readonly promptCaching?: PromptCaching;
```

Defined in: [src/models/model-info.ts:36](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model-info.ts#L36)

Whether and how the model caches prompts.

---

### forcedToolChoice?

```ts
readonly forcedToolChoice?: boolean;
```

Defined in: [src/models/model-info.ts:42](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model-info.ts#L42)

Whether the Bedrock and Anthropic providers force the structured output tool (`any` or a named tool) on the structured output retry. False when the model rejects forcing, or when a forced call degrades the response (for example, it skips thinking).

---

### nativeStructuredOutput?

```ts
readonly nativeStructuredOutput?: boolean;
```

Defined in: [src/models/model-info.ts:44](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model-info.ts#L44)

Whether the provider can make the model’s text output conform to a JSON schema.

---

### serverSideSummary?

```ts
readonly serverSideSummary?: boolean;
```

Defined in: [src/models/model-info.ts:49](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model-info.ts#L49)

Whether the model summarizes history server-side through [Model.summarize](/docs/api/typescript/Model/index.md#summarize); set `false` in `modelInfo` to summarize client-side.

---

### temporaryMessages?

```ts
readonly temporaryMessages?: boolean;
```

Defined in: [src/models/model-info.ts:57](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model-info.ts#L57)

Whether the model and provider take temporary messages: injected text the model reads only until the next user message, such as Anthropic’s turn-scoped system messages. When `true`, the provider receives each `InjectedBlock` as stored and formats it; otherwise it receives only the latest user message’s injected text, as text. The shared data lists the models that take them, but `Model.modelInfo` reports `false` unless the provider can send them (`AnthropicModel`). A `modelInfo` override that turns it on for another provider drops the injected text.

---

### deferredToolLoading?

```ts
readonly deferredToolLoading?: DeferredToolLoading;
```

Defined in: [src/models/model-info.ts:68](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model-info.ts#L68)

How the model and provider defer tool schemas; see [DeferredToolLoading](/docs/api/typescript/DeferredToolLoading/index.md). In the shared data, `'native'` is the path on the model vendor’s own API and `'unsupported'` marks a model that can’t fill in a stub’s parameters, such as one that constrains its tool calls to the stub’s open schema. `Model.modelInfo` reports `'stubs'` for every other model, `'native'` only where the provider sends the deferral flag (`AnthropicModel`), and `'unsupported'` where the provider needs each tool’s full input schema (`BedrockModel` with `strictTools`). A `modelInfo` override that sets `'unsupported'` sends every full spec to a model that handles stubs badly. On a provider without the flag, an override that sets `'native'` sends every full spec and only changes the `load_tools` result: `BedrockModel` names each loaded tool and other providers leave it out.

---

### acceptedMimeTypes?

```ts
readonly acceptedMimeTypes?: readonly string[];
```

Defined in: [src/models/model-info.ts:75](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model-info.ts#L75)

MIME types the model and provider take in the media blocks of a user message; `[]` when they take only text, `undefined` for every type. An entry matches a type exactly (`image/png`) or by its `type/*`; case and `; parameters` are ignored. A wildcard can also mean the kind isn’t verified (see `shared/README.md`). Tool results can take fewer.