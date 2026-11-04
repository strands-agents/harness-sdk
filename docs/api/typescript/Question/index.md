Defined in: [src/decisions/types.ts:55](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/types.ts#L55)

A single question posed to a [DecisionModel](/docs/api/typescript/DecisionModel/index.md).

`choices` constrains the shape of the answer: `'boolean'` yields a boolean, and a readonly tuple of strings yields that tuple’s union. In both cases [Uncertain](/docs/api/typescript/Uncertain/index.md) is also a possible answer unless opted out via `uncertainty: false`.

## Type Parameters

| Type Parameter | Default type | Description |
| --- | --- | --- |
| `C` *extends* `"boolean"` | readonly `string`\[\] | `"boolean"` | readonly `string`\[\] | Static shape of the `choices` field. `ask` is declared with a `const` type parameter, so inline question maps keep their tuple literals without an explicit `as const`. |

## Properties

### question

```ts
question: string;
```

Defined in: [src/decisions/types.ts:57](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/types.ts#L57)

The question posed to the model, in natural language.

---

### choices

```ts
choices: C;
```

Defined in: [src/decisions/types.ts:59](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/types.ts#L59)

Answer shape: `'boolean'` or a non-empty readonly tuple of string literals.

---

### uncertainty?

```ts
uncertainty?:
  | boolean
  | {
  minConfidence?: number;
};
```

Defined in: [src/decisions/types.ts:68](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/types.ts#L68)

Uncertainty configuration for this question.

-   omitted or `true`: `Uncertain` is a permitted response (default).
-   `false`: `Uncertain` is disabled; the model must commit to one of `choices`.
-   `{ minConfidence }`: `Uncertain` is permitted, with a custom minimum confidence in `[0.0, 1.0]`. Read only by implementations that return per-answer confidence (e.g. System One models); ignored by [LLMDecisionModel](/docs/api/typescript/LLMDecisionModel/index.md).