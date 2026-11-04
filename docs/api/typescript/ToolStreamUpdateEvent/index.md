Defined in: [src/hooks/events.ts:705](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L705)

Event triggered for each streaming progress event from a tool during execution. Wraps a [ToolStreamEvent](/docs/api/typescript/ToolStreamEvent/index.md) with invocation context, keeping the tool authoring interface unchanged — tools construct `ToolStreamEvent` without knowledge of agents or hooks, and the agent layer wraps them at the boundary.

Consistent with [ModelStreamUpdateEvent](/docs/api/typescript/ModelStreamUpdateEvent/index.md) which wraps model streaming events the same way.

## Extends

-   [`HookableEvent`](/docs/api/typescript/HookableEvent/index.md)

## Constructors

### Constructor

```ts
new ToolStreamUpdateEvent(data): ToolStreamUpdateEvent;
```

Defined in: [src/hooks/events.ts:711](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L711)

#### Parameters

| Parameter | Type |
| --- | --- |
| `data` | { `agent`: `LocalAgent`; `event`: [`ToolStreamEvent`](/docs/api/typescript/ToolStreamEvent/index.md); `invocationState`: [`InvocationState`](/docs/api/typescript/InvocationState/index.md); } & `HookableEventData` |

#### Returns

`ToolStreamUpdateEvent`

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
readonly type: "toolStreamUpdateEvent";
```

Defined in: [src/hooks/events.ts:706](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L706)

---

### agent

```ts
readonly agent: LocalAgent;
```

Defined in: [src/hooks/events.ts:707](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L707)

---

### event

```ts
readonly event: ToolStreamEvent;
```

Defined in: [src/hooks/events.ts:708](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L708)

---

### invocationState

```ts
readonly invocationState: InvocationState;
```

Defined in: [src/hooks/events.ts:709](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L709)

## Methods

### toJSON()

```ts
toJSON(): Pick<ToolStreamUpdateEvent, "type" | "event">;
```

Defined in: [src/hooks/events.ts:724](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L724)

Serializes for wire transport, excluding the agent reference and invocationState. Called automatically by JSON.stringify().

#### Returns

`Pick`<`ToolStreamUpdateEvent`, `"type"` | `"event"`\>