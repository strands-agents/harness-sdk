Defined in: [src/hooks/events.ts:274](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L274)

Event triggered just before a tool is executed. Fired after tool lookup but before execution begins.

Hook callbacks can:

-   Set [cancel](#cancel) to prevent the tool from executing.
-   Set [selectedTool](#selectedtool) to execute a different tool in place of the registry’s match.
-   Mutate [toolUse](#tooluse) in place, or replace it wholesale, to rewrite the tool input or name before execution. If `name` is changed and `selectedTool` is not set, the tool is re-resolved from the registry under the new name.

## Extends

-   [`HookableEvent`](/docs/api/typescript/HookableEvent/index.md)

## Implements

-   `Interruptible`

## Constructors

### Constructor

```ts
new BeforeToolCallEvent(data): BeforeToolCallEvent;
```

Defined in: [src/hooks/events.ts:299](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L299)

#### Parameters

| Parameter | Type |
| --- | --- |
| `data` | { `agent`: `LocalAgent`; `toolUse`: [`ToolUseData`](/docs/api/typescript/ToolUseData/index.md); `tool`: [`Tool`](/docs/api/typescript/Tool/index.md); `invocationState`: [`InvocationState`](/docs/api/typescript/InvocationState/index.md); } & `HookableEventData` |

#### Returns

`BeforeToolCallEvent`

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
readonly type: "beforeToolCallEvent";
```

Defined in: [src/hooks/events.ts:275](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L275)

---

### agent

```ts
readonly agent: LocalAgent;
```

Defined in: [src/hooks/events.ts:276](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L276)

---

### toolUse

```ts
toolUse: ToolUseData;
```

Defined in: [src/hooks/events.ts:277](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L277)

---

### tool

```ts
readonly tool: Tool;
```

Defined in: [src/hooks/events.ts:278](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L278)

---

### invocationState

```ts
readonly invocationState: InvocationState;
```

Defined in: [src/hooks/events.ts:279](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L279)

---

### cancel

```ts
cancel: string | boolean = false;
```

Defined in: [src/hooks/events.ts:286](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L286)

Set by hook callbacks to cancel this tool call. When set to `true`, a default cancel message is used. When set to a string, that string is used as the tool result error message.

---

### selectedTool

```ts
selectedTool: Tool = undefined;
```

Defined in: [src/hooks/events.ts:297](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L297)

Set by hook callbacks to execute a replacement tool instead of [tool](#tool). When undefined, the tool looked up from the registry (or re-resolved from a mutated `toolUse.name`) is used.

If multiple callbacks set `selectedTool`, the last callback to run wins. Callbacks run in registration order for this event, so the last-registered callback’s value is the one used.

## Methods

### interrupt()

```ts
interrupt<T>(params): T;
```

Defined in: [src/hooks/events.ts:322](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L322)

Raises an interrupt for human-in-the-loop workflows. If a response is available (from a previous resume), returns it immediately. Otherwise, throws an InterruptError to halt agent execution.

#### Type Parameters

| Type Parameter | Default type |
| --- | --- |
| `T` | [`JSONValue`](/docs/api/typescript/JSONValue/index.md) |

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `params` | [`InterruptParams`](/docs/api/typescript/InterruptParams/index.md) | Interrupt parameters including name and optional reason |

#### Returns

`T`

The user’s response when resuming from an interrupt

#### Implementation of

`Interruptible.interrupt`

---

### toJSON()

```ts
toJSON(): Pick<BeforeToolCallEvent, "type" | "toolUse">;
```

Defined in: [src/hooks/events.ts:336](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L336)

Serializes for wire transport, excluding the agent reference, tool instance, invocationState, and mutable cancel / selectedTool fields. Called automatically by JSON.stringify().

#### Returns

`Pick`<`BeforeToolCallEvent`, `"type"` | `"toolUse"`\>