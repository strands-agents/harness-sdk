Defined in: [src/hooks/events.ts:575](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L575)

Event triggered for each streaming event from the model. Wraps a [ModelStreamEvent](/docs/api/typescript/ModelStreamEvent/index.md) (transient streaming delta) during model inference. Completed content blocks are handled separately by [ContentBlockEvent](/docs/api/typescript/ContentBlockEvent/index.md) because they represent different granularities: partial deltas vs fully assembled results.

## Extends

-   [`HookableEvent`](/docs/api/typescript/HookableEvent/index.md)

## Constructors

### Constructor

```ts
new ModelStreamUpdateEvent(data): ModelStreamUpdateEvent;
```

Defined in: [src/hooks/events.ts:581](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L581)

#### Parameters

| Parameter | Type |
| --- | --- |
| `data` | { `agent`: `LocalAgent`; `event`: [`ModelStreamEvent`](/docs/api/typescript/ModelStreamEvent/index.md); `invocationState`: [`InvocationState`](/docs/api/typescript/InvocationState/index.md); } & `HookableEventData` |

#### Returns

`ModelStreamUpdateEvent`

#### Overrides

[`HookableEvent`](/docs/api/typescript/HookableEvent/index.md).[`constructor`](/docs/api/typescript/HookableEvent/index.md#constructor)

## Properties

### invocationContext?

```ts
readonly invocationContext?: InvocationContext;
```

Defined in: [src/hooks/events.ts:100](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L100)

The request this event belongs to (`undefined` outside one); pass it to [InvokeOptions.invocationContext](/docs/api/typescript/InvokeOptions/index.md#invocationcontext) to join it.

#### Inherited from

[`HookableEvent`](/docs/api/typescript/HookableEvent/index.md).[`invocationContext`](/docs/api/typescript/HookableEvent/index.md#invocationcontext)

---

### type

```ts
readonly type: "modelStreamUpdateEvent";
```

Defined in: [src/hooks/events.ts:576](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L576)

---

### agent

```ts
readonly agent: LocalAgent;
```

Defined in: [src/hooks/events.ts:577](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L577)

---

### event

```ts
readonly event: ModelStreamEvent;
```

Defined in: [src/hooks/events.ts:578](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L578)

---

### invocationState

```ts
readonly invocationState: InvocationState;
```

Defined in: [src/hooks/events.ts:579](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L579)

## Methods

### toJSON()

```ts
toJSON(): Pick<ModelStreamUpdateEvent, "type" | "event">;
```

Defined in: [src/hooks/events.ts:594](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L594)

Serializes for wire transport, excluding the agent reference and invocationState. Called automatically by JSON.stringify().

#### Returns

`Pick`<`ModelStreamUpdateEvent`, `"type"` | `"event"`\>