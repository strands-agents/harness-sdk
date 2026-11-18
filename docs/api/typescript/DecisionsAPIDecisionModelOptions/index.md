Defined in: [src/decisions/decisions-api-decision-model.ts:20](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/decisions-api-decision-model.ts#L20)

Options for constructing a [DecisionsAPIDecisionModel](/docs/api/typescript/DecisionsAPIDecisionModel/index.md).

## Properties

### apiKey?

```ts
readonly apiKey?: string;
```

Defined in: [src/decisions/decisions-api-decision-model.ts:22](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/decisions-api-decision-model.ts#L22)

Decisions API key. Defaults to `JEV_API_KEY`.

---

### modelId?

```ts
readonly modelId?: string;
```

Defined in: [src/decisions/decisions-api-decision-model.ts:24](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/decisions-api-decision-model.ts#L24)

Decisions API model identifier. Defaults to `~typesafe/jev-latest`.

---

### defaultMinConfidence?

```ts
readonly defaultMinConfidence?: number;
```

Defined in: [src/decisions/decisions-api-decision-model.ts:26](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/decisions-api-decision-model.ts#L26)

Default minimum confidence. Defaults to `0.5`.

---

### fetch?

```ts
readonly fetch?: {
  (input, init?): Promise<Response>;
  (input, init?): Promise<Response>;
};
```

Defined in: [src/decisions/decisions-api-decision-model.ts:28](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/decisions-api-decision-model.ts#L28)

Custom fetch implementation, primarily for transport configuration and tests.

#### Call Signature

```ts
(input, init?): Promise<Response>;
```

[MDN Reference](https://developer.mozilla.org/docs/Web/API/Window/fetch)

##### Parameters

| Parameter | Type |
| --- | --- |
| `input` | `RequestInfo` | `URL` |
| `init?` | `RequestInit` |

##### Returns

`Promise`<`Response`\>

#### Call Signature

```ts
(input, init?): Promise<Response>;
```

[MDN Reference](https://developer.mozilla.org/docs/Web/API/Window/fetch)

##### Parameters

| Parameter | Type |
| --- | --- |
| `input` | `string` | `Request` | `URL` |
| `init?` | `RequestInit` |

##### Returns

`Promise`<`Response`\>