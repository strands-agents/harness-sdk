Defined in: [src/context-manager/strategies/offload/base.ts:34](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/strategies/offload/base.ts#L34)

**`Experimental`**

Strategy returned by `Offload.drop/truncate/summarize`. Without conditions it acts on each matching block as it arrives, including the one the model answers next; targets `'*'` and `'media'` need conditions from `.when()`. A strategy keeps per-agent state, so give each agent its own.

## Extends

-   [`ContextStrategy`](/docs/api/typescript/ContextStrategy/index.md)

## Properties

### name

```ts
readonly name: string;
```

Defined in: [src/context-manager/types.ts:23](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/types.ts#L23)

**`Experimental`**

Stable identifier for logging and observability.

#### Inherited from

[`ContextStrategy`](/docs/api/typescript/ContextStrategy/index.md).[`name`](/docs/api/typescript/ContextStrategy/index.md#name)

## Methods

### when()

```ts
when(conditions?): OffloadStrategy;
```

Defined in: [src/context-manager/strategies/offload/base.ts:36](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/strategies/offload/base.ts#L36)

**`Experimental`**

Returns a copy of this strategy with these conditions in place of its current ones.

#### Parameters

| Parameter | Type |
| --- | --- |
| `conditions?` | [`OffloadConditions`](/docs/api/typescript/OffloadConditions/index.md) |

#### Returns

`OffloadStrategy`

---

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

#### Inherited from

[`ContextStrategy`](/docs/api/typescript/ContextStrategy/index.md).[`init`](/docs/api/typescript/ContextStrategy/index.md#init)

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

#### Inherited from

[`ContextStrategy`](/docs/api/typescript/ContextStrategy/index.md).[`apply`](/docs/api/typescript/ContextStrategy/index.md#apply)