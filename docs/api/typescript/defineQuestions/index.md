```ts
function defineQuestions<Q>(questions): Q;
```

Defined in: [src/decisions/types.ts:39](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/types.ts#L39)

Identity helper that preserves the literal types of an inline question map when it’s stored in a variable before being passed to [DecisionModel.ask](/docs/api/typescript/DecisionModel/index.md#ask).

`ask` already uses a `const` type parameter, so inline question maps work without any helper. Use `defineQuestions` only when you need to declare the map ahead of time — it keeps `choices` tuples and `'boolean'` as literal types without an explicit `as const`.

## Type Parameters

| Type Parameter |
| --- |
| `Q` *extends* `Record`<`string`, [`Question`](/docs/api/typescript/Question/index.md)<`"boolean"` | readonly `string`\[\]>> |

## Parameters

| Parameter | Type |
| --- | --- |
| `questions` | `Q` |

## Returns

`Q`