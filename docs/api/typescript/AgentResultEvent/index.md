Defined in: [src/hooks/events.ts:733](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L733)

Event triggered as the final event in the agent stream. Wraps the agent result containing the stop reason and last message.

## Extends

-   [`HookableEvent`](/docs/api/typescript/HookableEvent/index.md)

## Constructors

### Constructor

```ts
new AgentResultEvent(data): AgentResultEvent;
```

Defined in: [src/hooks/events.ts:739](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L739)

#### Parameters

| Parameter | Type |
| --- | --- |
| `data` | { `agent`: `LocalAgent`; `result`: [`AgentResult`](/docs/api/typescript/AgentResult/index.md); `invocationState`: [`InvocationState`](/docs/api/typescript/InvocationState/index.md); } & `HookableEventData` |

#### Returns

`AgentResultEvent`

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
readonly type: "agentResultEvent";
```

Defined in: [src/hooks/events.ts:734](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L734)

---

### agent

```ts
readonly agent: LocalAgent;
```

Defined in: [src/hooks/events.ts:735](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L735)

---

### result

```ts
readonly result: AgentResult;
```

Defined in: [src/hooks/events.ts:736](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L736)

---

### invocationState

```ts
readonly invocationState: InvocationState;
```

Defined in: [src/hooks/events.ts:737](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L737)

## Methods

### toJSON()

```ts
toJSON(): Pick<AgentResultEvent, "type" | "result">;
```

Defined in: [src/hooks/events.ts:750](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L750)

Serializes for wire transport, excluding the agent reference and invocationState. Called automatically by JSON.stringify().

#### Returns

`Pick`<`AgentResultEvent`, `"type"` | `"result"`\>