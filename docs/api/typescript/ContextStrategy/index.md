Defined in: [src/context-manager/types.ts:21](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/types.ts#L21)

**`Experimental`**

A context reduction strategy that can offload, summarize, or otherwise transform the message array to reduce token usage.

Strategies are applied in order during `apply()`. Each decides whether to act based on the current context state (utilization, message count, etc.).

## Extended by

-   [`OffloadStrategy`](/docs/api/typescript/OffloadStrategy/index.md)

## Properties

### name

```ts
readonly name: string;
```

Defined in: [src/context-manager/types.ts:23](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/types.ts#L23)

**`Experimental`**

Stable identifier for logging and observability.

## Methods

### init()?

```ts
init?(agent, stash?): void;
```

Defined in: [src/context-manager/types.ts:29](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/types.ts#L29)

**`Experimental`**

Called once when the ContextManager is attached to an agent. Strategies can use this to register hooks (e.g., eager offloading on message arrival).

#### Parameters

| Parameter | Type |
| --- | --- |
| `agent` | `LocalAgent` |
| `stash?` | `Stash` |

#### Returns

`void`

---

### apply()

```ts
apply(context): Promise<boolean>;
```

Defined in: [src/context-manager/types.ts:35](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/types.ts#L35)

**`Experimental`**

Attempt to reduce context. Returns true if it made changes, false if it decided not to act (e.g., conditions not met, nothing to offload).

#### Parameters

| Parameter | Type |
| --- | --- |
| `context` | [`ContextState`](/docs/api/typescript/ContextState/index.md) |

#### Returns

`Promise`<`boolean`\>