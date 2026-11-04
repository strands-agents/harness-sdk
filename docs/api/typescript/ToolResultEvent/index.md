Defined in: [src/hooks/events.ts:672](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L672)

Event triggered when a tool execution completes. Wraps the tool result block after a tool finishes execution.

## Extends

-   [`HookableEvent`](/docs/api/typescript/HookableEvent/index.md)

## Constructors

### Constructor

```ts
new ToolResultEvent(data): ToolResultEvent;
```

Defined in: [src/hooks/events.ts:678](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L678)

#### Parameters

| Parameter | Type |
| --- | --- |
| `data` | { `agent`: `LocalAgent`; `result`: [`ToolResultBlock`](/docs/api/typescript/ToolResultBlock/index.md); `invocationState`: [`InvocationState`](/docs/api/typescript/InvocationState/index.md); } & `HookableEventData` |

#### Returns

`ToolResultEvent`

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
readonly type: "toolResultEvent";
```

Defined in: [src/hooks/events.ts:673](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L673)

---

### agent

```ts
readonly agent: LocalAgent;
```

Defined in: [src/hooks/events.ts:674](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L674)

---

### result

```ts
readonly result: ToolResultBlock;
```

Defined in: [src/hooks/events.ts:675](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L675)

---

### invocationState

```ts
readonly invocationState: InvocationState;
```

Defined in: [src/hooks/events.ts:676](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L676)

## Methods

### toJSON()

```ts
toJSON(): Pick<ToolResultEvent, "type" | "result">;
```

Defined in: [src/hooks/events.ts:691](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L691)

Serializes for wire transport, excluding the agent reference and invocationState. Called automatically by JSON.stringify().

#### Returns

`Pick`<`ToolResultEvent`, `"type"` | `"result"`\>