Defined in: [src/hooks/events.ts:414](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L414)

Event triggered just before the model is invoked. Fired before sending messages to the model for inference.

## Extends

-   [`HookableEvent`](/docs/api/typescript/HookableEvent/index.md)

## Constructors

### Constructor

```ts
new BeforeModelCallEvent(data): BeforeModelCallEvent;
```

Defined in: [src/hooks/events.ts:435](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L435)

#### Parameters

| Parameter | Type |
| --- | --- |
| `data` | { `agent`: `LocalAgent`; `model`: [`Model`](/docs/api/typescript/Model/index.md); `invocationState`: [`InvocationState`](/docs/api/typescript/InvocationState/index.md); `projectedInputTokens?`: `number`; } & `HookableEventData` |

#### Returns

`BeforeModelCallEvent`

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
readonly type: "beforeModelCallEvent";
```

Defined in: [src/hooks/events.ts:415](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L415)

---

### agent

```ts
readonly agent: LocalAgent;
```

Defined in: [src/hooks/events.ts:416](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L416)

---

### model

```ts
readonly model: Model;
```

Defined in: [src/hooks/events.ts:417](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L417)

---

### invocationState

```ts
readonly invocationState: InvocationState;
```

Defined in: [src/hooks/events.ts:418](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L418)

---

### cancel

```ts
cancel: string | boolean = false;
```

Defined in: [src/hooks/events.ts:425](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L425)

Set by hook callbacks to cancel this model call. When set to `true`, a default cancel message is used. When set to a string, that string is used as the assistant response message.

---

### projectedInputTokens?

```ts
readonly projectedInputTokens?: number;
```

Defined in: [src/hooks/events.ts:433](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L433)

Projected input token count for the upcoming model call. Computed by the agent loop from message metadata and token estimation. Available for hooks and plugins (e.g. conversation managers) to make proactive decisions about context management.

## Methods

### toJSON()

```ts
toJSON(): Pick<BeforeModelCallEvent, "type" | "projectedInputTokens">;
```

Defined in: [src/hooks/events.ts:456](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L456)

Serializes for wire transport, excluding the agent reference and invocationState. Called automatically by JSON.stringify().

#### Returns

`Pick`<`BeforeModelCallEvent`, `"type"` | `"projectedInputTokens"`\>