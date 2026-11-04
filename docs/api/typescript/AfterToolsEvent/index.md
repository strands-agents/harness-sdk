Defined in: [src/hooks/events.ts:830](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L830)

Event triggered after all tools complete execution. Fired after tool results are collected and ready to be added to conversation. Uses reverse callback ordering for proper cleanup semantics.

## Extends

-   [`HookableEvent`](/docs/api/typescript/HookableEvent/index.md)

## Constructors

### Constructor

```ts
new AfterToolsEvent(data): AfterToolsEvent;
```

Defined in: [src/hooks/events.ts:851](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L851)

#### Parameters

| Parameter | Type |
| --- | --- |
| `data` | { `agent`: `LocalAgent`; `message`: [`Message`](/docs/api/typescript/Message/index.md); `invocationState`: [`InvocationState`](/docs/api/typescript/InvocationState/index.md); } & `HookableEventData` |

#### Returns

`AfterToolsEvent`

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
readonly type: "afterToolsEvent";
```

Defined in: [src/hooks/events.ts:831](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L831)

---

### agent

```ts
readonly agent: LocalAgent;
```

Defined in: [src/hooks/events.ts:832](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L832)

---

### message

```ts
readonly message: Message;
```

Defined in: [src/hooks/events.ts:833](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L833)

---

### invocationState

```ts
readonly invocationState: InvocationState;
```

Defined in: [src/hooks/events.ts:834](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L834)

---

### endTurn

```ts
endTurn: string | boolean | ContentBlock[] = false;
```

Defined in: [src/hooks/events.ts:849](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L849)

When set to `true`, the agent loop halts after this tool batch completes without calling the model again and a default message (`"Turn ended early by hook after tool execution"`) is appended as the final assistant message. When set to a string, that string is used instead of the default — the string becomes literal assistant content (a `TextBlock`), not a reason or label. When set to a `ContentBlock[]`, those blocks become the final assistant message content directly (shallow-copied). Contrast with [cancel](/docs/api/typescript/BeforeToolCallEvent/index.md#cancel) fields on other events, where the string is a cancellation reason.

In all cases `stopReason` on the returned `AgentResult` is `'endTurn'`.

## Methods

### toJSON()

```ts
toJSON(): Pick<AfterToolsEvent, "type" | "message">;
```

Defined in: [src/hooks/events.ts:867](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L867)

Serializes for wire transport, excluding the agent reference, invocationState, and mutable endTurn field. Called automatically by JSON.stringify().

#### Returns

`Pick`<`AfterToolsEvent`, `"type"` | `"message"`\>