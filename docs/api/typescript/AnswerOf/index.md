```ts
type AnswerOf<Q> = Q extends Question<"boolean"> ? boolean | Uncertain : Q extends Question<infer S> ? S[number] | Uncertain : boolean | string | Uncertain;
```

Defined in: [src/decisions/types.ts:95](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/types.ts#L95)

Statically narrows each question’s answer type from its `choices`.

-   `Question<'boolean'>` yields `boolean | Uncertain`.
-   `Question<readonly ['red', 'green']>` yields `'red' | 'green' | Uncertain`.
-   An un-narrowed `Question` (e.g. an entry of `Record<string, Question>` without `as const`) falls back to `boolean | string | Uncertain`.

## Type Parameters

| Type Parameter |
| --- |
| `Q` |