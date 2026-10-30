Defined in: [src/models/model.ts:184](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L184)

Base configuration interface for all model providers.

This interface defines the common configuration properties that all model providers should support. Provider-specific configurations should extend this interface.

## Extended by

-   [`BedrockModelConfig`](/docs/api/typescript/BedrockModelConfig/index.md)

## Properties

### modelId?

```ts
modelId?: string;
```

Defined in: [src/models/model.ts:189](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L189)

The model identifier. This typically specifies which model to use from the provider’s catalog.

---

### maxTokens?

```ts
maxTokens?: number;
```

Defined in: [src/models/model.ts:196](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L196)

Maximum number of tokens to generate in the response.

#### See

Provider-specific documentation for exact behavior

---

### temperature?

```ts
temperature?: number;
```

Defined in: [src/models/model.ts:203](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L203)

Controls randomness in generation.

#### See

Provider-specific documentation for valid range

---

### topP?

```ts
topP?: number;
```

Defined in: [src/models/model.ts:210](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L210)

Controls diversity via nucleus sampling.

#### See

Provider-specific documentation for details

---

### contextWindowLimit?

```ts
contextWindowLimit?: number;
```

Defined in: [src/models/model.ts:220](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L220)

Maximum context window size in tokens for the model.

The same fact as `modelInfo.limits.contextWindow`; setting it here is shorthand for setting it through `modelInfo`, and it wins over the shared model info. When both are set, `modelInfo` wins. When not provided, vended providers still populate it from the shared model info for callers that read `getConfig()`; `modelInfo` is the resolved view to read.

---

### modelInfo?

```ts
modelInfo?: ModelInfo;
```

Defined in: [src/models/model.ts:228](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L228)

Overrides for what the SDK knows about the model. Fields set here win over the shared model info and the provider; `capabilities.stateful` changes how the agent loop sends history, so set it only for a provider that keeps state server-side. `updateConfig({ modelInfo })` replaces the previous override entirely, it does not merge into it.