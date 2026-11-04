Defined in: [src/hooks/events.ts:241](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L241)

Event triggered when the framework adds a message to the conversation history. Fired for user input, assistant responses, and tool-result messages added during agent execution. Does not fire for messages preloaded via `AgentConfig.messages` or messages manually pushed to `agent.messages`.

## Extends

-   [`HookableEvent`](/docs/api/typescript/HookableEvent/index.md)

## Constructors

### Constructor

```ts
new MessageAddedEvent(data): MessageAddedEvent;
```

Defined in: [src/hooks/events.ts:247](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L247)

#### Parameters

| Parameter | Type |
| --- | --- |
| `data` | { `agent`: `LocalAgent`; `message`: [`Message`](/docs/api/typescript/Message/index.md); `invocationState`: [`InvocationState`](/docs/api/typescript/InvocationState/index.md); } & `HookableEventData` |

#### Returns

`MessageAddedEvent`

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
readonly type: "messageAddedEvent";
```

Defined in: [src/hooks/events.ts:242](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L242)

---

### agent

```ts
readonly agent: LocalAgent;
```

Defined in: [src/hooks/events.ts:243](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L243)

---

### message

```ts
readonly message: Message;
```

Defined in: [src/hooks/events.ts:244](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L244)

---

### invocationState

```ts
readonly invocationState: InvocationState;
```

Defined in: [src/hooks/events.ts:245](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L245)

## Methods

### toJSON()

```ts
toJSON(): Pick<MessageAddedEvent, "type" | "message">;
```

Defined in: [src/hooks/events.ts:258](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L258)

Serializes for wire transport, excluding the agent reference and invocationState. Called automatically by JSON.stringify().

#### Returns

`Pick`<`MessageAddedEvent`, `"type"` | `"message"`\>