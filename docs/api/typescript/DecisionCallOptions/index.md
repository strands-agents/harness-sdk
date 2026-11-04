Defined in: [src/decisions/types.ts:19](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/types.ts#L19)

Per-call options a [DecisionModel](/docs/api/typescript/DecisionModel/index.md) implementation receives in `_ask`.

## Extended by

-   [`AskOptions`](/docs/api/typescript/AskOptions/index.md)

## Properties

### cancelSignal?

```ts
cancelSignal?: AbortSignal;
```

Defined in: [src/decisions/types.ts:21](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/types.ts#L21)

Aborts the underlying decision call when signalled. Built-in implementations honor it; the provider decides how promptly the call stops.