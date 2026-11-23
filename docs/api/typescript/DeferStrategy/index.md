Defined in: [src/context-manager/strategies/deferred-tool-loading.ts:85](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/strategies/deferred-tool-loading.ts#L85)

**`Experimental`**

A strategy that keeps tools’ input schemas out of the model’s context until the model loads them with `load_tools`. The model still sees each deferred tool’s name and description. A call to a deferred tool made before its load doesn’t run: the model gets the tool’s schema and calls it again. It never changes the messages.

## Extends

-   [`ContextStrategy`](/docs/api/typescript/ContextStrategy/index.md)

## Properties

### name

```ts
readonly name: string;
```

Defined in: [src/context-manager/types.ts:21](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/types.ts#L21)

**`Experimental`**

Stable identifier for logging and observability.

#### Inherited from

[`ContextStrategy`](/docs/api/typescript/ContextStrategy/index.md).[`name`](/docs/api/typescript/ContextStrategy/index.md#name)

## Methods

### when()

```ts
when(conditions?): DeferStrategy;
```

Defined in: [src/context-manager/strategies/deferred-tool-loading.ts:91](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/strategies/deferred-tool-loading.ts#L91)

**`Experimental`**

Returns a copy of this strategy with these conditions in place of its current ones.

#### Parameters

| Parameter | Type |
| --- | --- |
| `conditions?` | [`DeferConditions`](/docs/api/typescript/DeferConditions/index.md) |

#### Returns

`DeferStrategy`

#### Throws

Error when a condition name is unknown or its value is invalid

---

### init()?

```ts
init?(agent, archive?): void;
```

Defined in: [src/context-manager/types.ts:30](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/types.ts#L30)

**`Experimental`**

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