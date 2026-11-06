Defined in: [src/models/streaming.ts:503](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/streaming.ts#L503)

Token usage statistics for a model invocation. Tracks input, output, and total tokens, plus cache-related metrics.

Providers differ on whether `inputTokens` includes cached tokens. Some count cache reads and writes inside `inputTokens`; others count them only in `cacheReadInputTokens` and `cacheWriteInputTokens`. `totalTokens` always includes cached tokens, so for a single model call: if `inputTokens + outputTokens === totalTokens`, `inputTokens` already includes the cache fields; otherwise, total input is `inputTokens + cacheReadInputTokens + cacheWriteInputTokens`. Adding the cache fields to an `inputTokens` that already includes them counts cached tokens twice.

Custom model providers should include cached tokens in `inputTokens` (matching the OpenTelemetry GenAI conventions), so that `totalTokens === inputTokens + outputTokens`.

## Extended by

-   [`InvocationContextUsage`](/docs/api/typescript/InvocationContextUsage/index.md)

## Properties

### inputTokens

```ts
inputTokens: number;
```

Defined in: [src/models/streaming.ts:507](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/streaming.ts#L507)

Number of input tokens, as the model provider counts them (may or may not include cached tokens).

---

### outputTokens

```ts
outputTokens: number;
```

Defined in: [src/models/streaming.ts:512](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/streaming.ts#L512)

Number of tokens in the output (completion).

---

### totalTokens

```ts
totalTokens: number;
```

Defined in: [src/models/streaming.ts:517](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/streaming.ts#L517)

Total number of tokens processed, including any cached input tokens.

---

### cacheReadInputTokens?

```ts
cacheReadInputTokens?: number;
```

Defined in: [src/models/streaming.ts:523](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/streaming.ts#L523)

Number of input tokens read from cache. This can reduce latency and cost.

---

### cacheWriteInputTokens?

```ts
cacheWriteInputTokens?: number;
```

Defined in: [src/models/streaming.ts:529](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/streaming.ts#L529)

Number of input tokens written to cache. These tokens can be reused in future requests.