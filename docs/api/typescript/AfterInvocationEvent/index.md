Defined in: [src/hooks/events.ts:198](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L198)

Event triggered at the end of an agent request. Fired after all processing completes, regardless of success or error. Uses reverse callback ordering for proper cleanup semantics.

## Extends

-   [`HookableEvent`](/docs/api/typescript/HookableEvent/index.md)

## Constructors

### Constructor

```ts
new AfterInvocationEvent(data): AfterInvocationEvent;
```

Defined in: [src/hooks/events.ts:215](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L215)

#### Parameters

| Parameter | Type |
| --- | --- |
| `data` | { `agent`: `LocalAgent`; `invocationState`: [`InvocationState`](/docs/api/typescript/InvocationState/index.md); } & `HookableEventData` |

#### Returns

`AfterInvocationEvent`

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
readonly type: "afterInvocationEvent";
```

Defined in: [src/hooks/events.ts:199](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L199)

---

### agent

```ts
readonly agent: LocalAgent;
```

Defined in: [src/hooks/events.ts:200](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L200)

---

### invocationState

```ts
readonly invocationState: InvocationState;
```

Defined in: [src/hooks/events.ts:201](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L201)

---

### resume

```ts
resume: InvokeArgs = undefined;
```

Defined in: [src/hooks/events.ts:213](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L213)

Set by hook callbacks to trigger a follow-up agent invocation with new input. When set, after this event’s callbacks complete the agent re-enters its loop with these args as new input, under the same invocation lock. A fresh [BeforeInvocationEvent](/docs/api/typescript/BeforeInvocationEvent/index.md)/AfterInvocationEvent pair fires for the resumed run. Ignored if the invocation ended with an error or one of the request’s limits is reached, since a resumed run would stop again at once.

If multiple callbacks set `resume`, the last callback to run wins.

## Methods

### toJSON()

```ts
toJSON(): Pick<AfterInvocationEvent, "type">;
```

Defined in: [src/hooks/events.ts:230](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L230)

Serializes for wire transport, excluding the agent reference, invocationState, and mutable resume field. Called automatically by JSON.stringify().

#### Returns

`Pick`<`AfterInvocationEvent`, `"type"`\>