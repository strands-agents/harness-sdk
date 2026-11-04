Defined in: [src/hooks/events.ts:349](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L349)

Event triggered after a tool execution completes. Fired after tool execution finishes, whether successful or failed. Uses reverse callback ordering for proper cleanup semantics.

Hook callbacks can mutate [result](#result) to rewrite the tool result before it propagates to the model (e.g. to redact or truncate output).

## Extends

-   [`HookableEvent`](/docs/api/typescript/HookableEvent/index.md)

## Constructors

### Constructor

```ts
new AfterToolCallEvent(data): AfterToolCallEvent;
```

Defined in: [src/hooks/events.ts:370](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L370)

#### Parameters

| Parameter | Type |
| --- | --- |
| `data` | { `agent`: `LocalAgent`; `toolUse`: [`ToolUseData`](/docs/api/typescript/ToolUseData/index.md); `tool`: [`Tool`](/docs/api/typescript/Tool/index.md); `result`: [`ToolResultBlock`](/docs/api/typescript/ToolResultBlock/index.md); `invocationState`: [`InvocationState`](/docs/api/typescript/InvocationState/index.md); `error?`: `Error`; } & `HookableEventData` |

#### Returns

`AfterToolCallEvent`

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
readonly type: "afterToolCallEvent";
```

Defined in: [src/hooks/events.ts:350](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L350)

---

### agent

```ts
readonly agent: LocalAgent;
```

Defined in: [src/hooks/events.ts:351](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L351)

---

### toolUse

```ts
readonly toolUse: ToolUseData;
```

Defined in: [src/hooks/events.ts:352](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L352)

---

### tool

```ts
readonly tool: Tool;
```

Defined in: [src/hooks/events.ts:353](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L353)

---

### result

```ts
result: ToolResultBlock;
```

Defined in: [src/hooks/events.ts:359](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L359)

The tool result. Can be replaced by hook callbacks to transform the result before it enters the conversation history.

---

### error?

```ts
readonly error?: Error;
```

Defined in: [src/hooks/events.ts:361](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L361)

---

### invocationState

```ts
readonly invocationState: InvocationState;
```

Defined in: [src/hooks/events.ts:362](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L362)

---

### retry?

```ts
retry?: boolean;
```

Defined in: [src/hooks/events.ts:368](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L368)

Optional flag that can be set by hook callbacks to request a retry of the tool call. When set to true, the agent will re-execute the tool.

## Methods

### toJSON()

```ts
toJSON(): Pick<AfterToolCallEvent, "toolUse" | "type" | "result"> & {
  error?: {
     message?: string;
  };
};
```

Defined in: [src/hooks/events.ts:400](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L400)

Serializes for wire transport, excluding the agent reference, tool instance, invocationState, and mutable retry flag. Converts Error to an extensible object for safe wire serialization. Called automatically by JSON.stringify().

#### Returns

`Pick`<`AfterToolCallEvent`, `"toolUse"` | `"type"` | `"result"`\> & { `error?`: { `message?`: `string`; }; }