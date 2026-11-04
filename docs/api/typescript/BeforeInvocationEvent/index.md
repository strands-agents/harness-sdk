Defined in: [src/hooks/events.ts:159](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L159)

Event triggered at the beginning of a new agent request. Fired before any model inference or tool execution occurs.

## Extends

-   [`HookableEvent`](/docs/api/typescript/HookableEvent/index.md)

## Constructors

### Constructor

```ts
new BeforeInvocationEvent(data): BeforeInvocationEvent;
```

Defined in: [src/hooks/events.ts:177](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L177)

#### Parameters

| Parameter | Type |
| --- | --- |
| `data` | { `agent`: `LocalAgent`; `invocationState`: [`InvocationState`](/docs/api/typescript/InvocationState/index.md); `messages?`: [`Message`](/docs/api/typescript/Message/index.md)\[\]; } & `HookableEventData` |

#### Returns

`BeforeInvocationEvent`

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
readonly type: "beforeInvocationEvent";
```

Defined in: [src/hooks/events.ts:160](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L160)

---

### agent

```ts
readonly agent: LocalAgent;
```

Defined in: [src/hooks/events.ts:161](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L161)

---

### invocationState

```ts
readonly invocationState: InvocationState;
```

Defined in: [src/hooks/events.ts:162](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L162)

---

### messages

```ts
messages: Message[];
```

Defined in: [src/hooks/events.ts:168](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L168)

Input messages for this invocation. Hook callbacks may mutate this array or replace it before processing.

---

### cancel

```ts
cancel: string | boolean = false;
```

Defined in: [src/hooks/events.ts:175](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L175)

Set by hook callbacks to cancel this invocation. When set to `true`, a default cancel message is used. When set to a string, that string is used as the assistant response message.

## Methods

### toJSON()

```ts
toJSON(): Pick<BeforeInvocationEvent, "type">;
```

Defined in: [src/hooks/events.ts:188](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L188)

Serializes for wire transport, excluding the agent reference, invocationState, and messages. Called automatically by JSON.stringify().

#### Returns

`Pick`<`BeforeInvocationEvent`, `"type"`\>