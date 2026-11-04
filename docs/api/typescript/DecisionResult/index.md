Defined in: [src/decisions/types.ts:108](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/types.ts#L108)

Result returned by [DecisionModel.ask](/docs/api/typescript/DecisionModel/index.md#ask), keyed by the same identifiers as the input question map.

## Type Parameters

| Type Parameter | Default type | Description |
| --- | --- | --- |
| `Q` *extends* `Record`<`string`, [`Question`](/docs/api/typescript/Question/index.md)\> | `Record`<`string`, [`Question`](/docs/api/typescript/Question/index.md)\> | The question map passed to `ask`. |

## Properties

### answers

```ts
answers: { [K in string | number | symbol]: AnswerOf<Q[K]> };
```

Defined in: [src/decisions/types.ts:110](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/types.ts#L110)

Per-question answer, statically narrowed from each question’s `choices`.

---

### usage?

```ts
usage?: {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};
```

Defined in: [src/decisions/types.ts:112](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/types.ts#L112)

Aggregate token usage for the underlying model call(s), when the provider reports it.

#### inputTokens

```ts
inputTokens: number;
```

#### outputTokens

```ts
outputTokens: number;
```

#### totalTokens

```ts
totalTokens: number;
```

---

### metadata

```ts
metadata: {
  latencyMs: number;
  providerName?: string;
  modelId?: string;
  probabilities?: { readonly [K in string | number | symbol]: Readonly<Record<string, number>> };
  confidence?: { readonly [K in string | number | symbol]: number };
};
```

Defined in: [src/decisions/types.ts:118](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/types.ts#L118)

Per-call metadata recorded by the implementation.

#### latencyMs

```ts
latencyMs: number;
```

Time spent in the underlying model call, in milliseconds.

#### providerName?

```ts
providerName?: string;
```

Provider that served the decision.

#### modelId?

```ts
modelId?: string;
```

Provider-reported model identifier that served the decision.

#### probabilities?

```ts
probabilities?: { readonly [K in string | number | symbol]: Readonly<Record<string, number>> };
```

Per-question probability distributions, keyed by answer value.

#### confidence?

```ts
confidence?: { readonly [K in string | number | symbol]: number };
```

Per-question confidence values in `[0.0, 1.0]`.