Defined in: [src/hooks/events.ts:637](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L637)

Event triggered when the model completes a full message. Wraps the assembled message and stop reason after model streaming finishes.

## Extends

-   [`HookableEvent`](/docs/api/typescript/HookableEvent/index.md)

## Constructors

### Constructor

```ts
new ModelMessageEvent(data): ModelMessageEvent;
```

Defined in: [src/hooks/events.ts:644](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L644)

#### Parameters

| Parameter | Type |
| --- | --- |
| `data` | { `agent`: `LocalAgent`; `message`: [`Message`](/docs/api/typescript/Message/index.md); `stopReason`: [`StopReason`](/docs/api/typescript/StopReason/index.md); `invocationState`: [`InvocationState`](/docs/api/typescript/InvocationState/index.md); } & `HookableEventData` |

#### Returns

`ModelMessageEvent`

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
readonly type: "modelMessageEvent";
```

Defined in: [src/hooks/events.ts:638](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L638)

---

### agent

```ts
readonly agent: LocalAgent;
```

Defined in: [src/hooks/events.ts:639](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L639)

---

### message

```ts
readonly message: Message;
```

Defined in: [src/hooks/events.ts:640](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L640)

---

### stopReason

```ts
readonly stopReason: StopReason;
```

Defined in: [src/hooks/events.ts:641](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L641)

---

### invocationState

```ts
readonly invocationState: InvocationState;
```

Defined in: [src/hooks/events.ts:642](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L642)

## Methods

### toJSON()

```ts
toJSON(): Pick<ModelMessageEvent, "type" | "message" | "stopReason">;
```

Defined in: [src/hooks/events.ts:663](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L663)

Serializes for wire transport, excluding the agent reference and invocationState. Called automatically by JSON.stringify().

#### Returns

`Pick`<`ModelMessageEvent`, `"type"` | `"message"` | `"stopReason"`\>