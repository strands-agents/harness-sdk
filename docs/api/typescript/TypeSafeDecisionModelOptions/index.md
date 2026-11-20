Defined in: [src/decisions/typesafe-decision-model.ts:18](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/typesafe-decision-model.ts#L18)

Options for constructing a [TypeSafeDecisionModel](/docs/api/typescript/TypeSafeDecisionModel/index.md).

## Properties

### apiKey?

```ts
readonly apiKey?: string;
```

Defined in: [src/decisions/typesafe-decision-model.ts:20](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/typesafe-decision-model.ts#L20)

TypeSafe API key. Defaults to `TYPESAFE_API_KEY`.

---

### modelId?

```ts
readonly modelId?: string;
```

Defined in: [src/decisions/typesafe-decision-model.ts:22](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/typesafe-decision-model.ts#L22)

Jev model identifier. Defaults to `jev-latest`.

---

### defaultMinConfidence?

```ts
readonly defaultMinConfidence?: number;
```

Defined in: [src/decisions/typesafe-decision-model.ts:24](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/typesafe-decision-model.ts#L24)

Default minimum confidence. Defaults to `0.5`.

---

### fetch?

```ts
readonly fetch?: {
  (input, init?): Promise<Response>;
  (input, init?): Promise<Response>;
};
```

Defined in: [src/decisions/typesafe-decision-model.ts:26](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/typesafe-decision-model.ts#L26)

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