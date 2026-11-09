Defined in: [src/context-manager/strategies/offload/base.ts:73](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/strategies/offload/base.ts#L73)

Intermediate builder result that allows chaining `.when()` conditions. Also implements `ContextStrategy` directly so it can be used without `.when()`.

## Extends

-   [`ContextStrategy`](/docs/api/typescript/ContextStrategy/index.md)

## Properties

### name

```ts
readonly name: string;
```

Defined in: [src/context-manager/types.ts:23](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/types.ts#L23)

Stable identifier for logging and observability.

#### Inherited from

[`ContextStrategy`](/docs/api/typescript/ContextStrategy/index.md).[`name`](/docs/api/typescript/ContextStrategy/index.md#name)

## Methods

### when()

```ts
when(conditions): ContextStrategy;
```

Defined in: [src/context-manager/strategies/offload/base.ts:75](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/strategies/offload/base.ts#L75)

Add conditions that determine when this strategy fires.

#### Parameters

| Parameter | Type |
| --- | --- |
| `conditions` | [`OffloadConditions`](/docs/api/typescript/OffloadConditions/index.md) |

#### Returns

[`ContextStrategy`](/docs/api/typescript/ContextStrategy/index.md)

---

### init()?

```ts
init?(agent, stash?): void;
```

Defined in: [src/context-manager/types.ts:29](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/types.ts#L29)

Called once when the ContextManager is attached to an agent. Strategies can use this to register hooks (e.g., eager offloading on message arrival).

#### Parameters

| Parameter | Type |
| --- | --- |
| `agent` | `LocalAgent` |
| `stash?` | `Stash` |

#### Returns

`void`

#### Inherited from

[`ContextStrategy`](/docs/api/typescript/ContextStrategy/index.md).[`init`](/docs/api/typescript/ContextStrategy/index.md#init)

---

### apply()

```ts
apply(context): Promise<boolean>;
```

Defined in: [src/context-manager/types.ts:35](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/types.ts#L35)

Attempt to reduce context. Returns true if it made changes, false if it decided not to act (e.g., conditions not met, nothing to offload).

#### Parameters

| Parameter | Type |
| --- | --- |
| `context` | [`ContextState`](/docs/api/typescript/ContextState/index.md) |

#### Returns

`Promise`<`boolean`\>

#### Inherited from

[`ContextStrategy`](/docs/api/typescript/ContextStrategy/index.md).[`apply`](/docs/api/typescript/ContextStrategy/index.md#apply)