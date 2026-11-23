Defined in: [src/context-manager/strategies/offload/base.ts:33](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/strategies/offload/base.ts#L33)

Strategy returned by `Offload.drop/truncate/summarize`. Without conditions it acts on each matching block as it arrives, including the one the model answers next; targets `'*'` and `'media'` need conditions from `.when()`. A strategy keeps per-agent state, so give each agent its own.

## Extends

-   [`ContextStrategy`](/docs/api/typescript/ContextStrategy/index.md)

## Properties

### name

```ts
readonly name: string;
```

Defined in: [src/context-manager/types.ts:21](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/types.ts#L21)

Stable identifier for logging and observability.

#### Inherited from

[`ContextStrategy`](/docs/api/typescript/ContextStrategy/index.md).[`name`](/docs/api/typescript/ContextStrategy/index.md#name)

## Methods

### when()

```ts
when(conditions?): OffloadStrategy;
```

Defined in: [src/context-manager/strategies/offload/base.ts:35](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/strategies/offload/base.ts#L35)

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

#### Inherited from

[`ContextStrategy`](/docs/api/typescript/ContextStrategy/index.md).[`init`](/docs/api/typescript/ContextStrategy/index.md#init)

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

#### Inherited from

[`ContextStrategy`](/docs/api/typescript/ContextStrategy/index.md).[`apply`](/docs/api/typescript/ContextStrategy/index.md#apply)