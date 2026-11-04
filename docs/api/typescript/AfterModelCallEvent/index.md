Defined in: [src/hooks/events.ts:502](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L502)

Event triggered after the model invocation completes. Fired after the model finishes generating a response, whether successful or failed. Uses reverse callback ordering for proper cleanup semantics.

Note: stopData may be undefined if an error occurs before the model completes.

## Extends

-   [`HookableEvent`](/docs/api/typescript/HookableEvent/index.md)

## Constructors

### Constructor

```ts
new AfterModelCallEvent(data): AfterModelCallEvent;
```

Defined in: [src/hooks/events.ts:527](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L527)

#### Parameters

| Parameter | Type |
| --- | --- |
| `data` | { `agent`: `LocalAgent`; `model`: [`Model`](/docs/api/typescript/Model/index.md); `invocationState`: [`InvocationState`](/docs/api/typescript/InvocationState/index.md); `attemptCount`: `number`; `stopData?`: [`ModelStopResponse`](/docs/api/typescript/ModelStopResponse/index.md); `error?`: `Error`; } & `HookableEventData` |

#### Returns

`AfterModelCallEvent`

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
readonly type: "afterModelCallEvent";
```

Defined in: [src/hooks/events.ts:503](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L503)

---

### agent

```ts
readonly agent: LocalAgent;
```

Defined in: [src/hooks/events.ts:504](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L504)

---

### model

```ts
readonly model: Model;
```

Defined in: [src/hooks/events.ts:505](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L505)

---

### stopData?

```ts
readonly stopData?: ModelStopResponse;
```

Defined in: [src/hooks/events.ts:506](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L506)

---

### error?

```ts
readonly error?: Error;
```

Defined in: [src/hooks/events.ts:507](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L507)

---

### invocationState

```ts
readonly invocationState: InvocationState;
```

Defined in: [src/hooks/events.ts:508](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L508)

---

### attemptCount

```ts
readonly attemptCount: number;
```

Defined in: [src/hooks/events.ts:519](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L519)

1-indexed count of model attempts for this turn, including the attempt that just completed (or failed). The first call in a turn is `1`; each subsequent retry increments by one.

Retry strategies may rely on `attemptCount === 1` to mark the start of a new retry sequence (e.g. to clear per-turn state carried over from a previous turn). The agent loop guarantees this marker on every fresh turn.

---

### retry?

```ts
retry?: boolean;
```

Defined in: [src/hooks/events.ts:525](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L525)

Optional flag that can be set by hook callbacks to request a retry of the model call. When set to true, the agent will retry the model invocation.

## Methods

### toJSON()

```ts
toJSON(): Pick<AfterModelCallEvent, "type" | "stopData" | "attemptCount"> & {
  error?: {
     message?: string;
  };
};
```

Defined in: [src/hooks/events.ts:559](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L559)

Serializes for wire transport, excluding the agent reference, invocationState, and mutable retry flag. Converts Error to an extensible object for safe wire serialization. Called automatically by JSON.stringify().

#### Returns

`Pick`<`AfterModelCallEvent`, `"type"` | `"stopData"` | `"attemptCount"`\> & { `error?`: { `message?`: `string`; }; }