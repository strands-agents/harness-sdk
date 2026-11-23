Defined in: [src/context-manager/types.ts:19](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/types.ts#L19)

A context reduction strategy that can offload, summarize, or otherwise transform the message array to reduce token usage.

Strategies are applied in order during `apply()`. Each decides whether to act based on the current context state (utilization, message count, etc.).

## Extended by

-   [`OffloadStrategy`](/docs/api/typescript/OffloadStrategy/index.md)
-   [`DeferStrategy`](/docs/api/typescript/DeferStrategy/index.md)

## Properties

### name

```ts
readonly name: string;
```

Defined in: [src/context-manager/types.ts:21](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/types.ts#L21)

Stable identifier for logging and observability.

## Methods

### init()?

```ts
init?(agent, archive?): void;
```

Defined in: [src/context-manager/types.ts:30](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/types.ts#L30)

Called once when the ContextManager is attached to an agent. Strategies can use this to register hooks (e.g., eager offloading on message arrival).

`archive` is `@internal` — it is not exported, so its shape is not a stable contract for strategies outside the SDK. Pass it to `Offload` strategies rather than calling it directly.

#### Parameters

| Parameter | Type |
| --- | --- |
| `agent` | `LocalAgent` |
| `archive?` | `Archive` |

#### Returns

`void`

---

### apply()

```ts
apply(context): Promise<boolean>;
```

Defined in: [src/context-manager/types.ts:36](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/types.ts#L36)

Attempt to reduce context. Returns true if it made changes, false if it decided not to act (e.g., conditions not met, nothing to offload).

#### Parameters

| Parameter | Type |
| --- | --- |
| `context` | [`ContextState`](/docs/api/typescript/ContextState/index.md) |

#### Returns

`Promise`<`boolean`\>