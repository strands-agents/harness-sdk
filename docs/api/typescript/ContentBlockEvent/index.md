Defined in: [src/hooks/events.ts:609](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L609)

Event triggered when a content block completes during model inference. Wraps completed content blocks (TextBlock, ToolUseBlock, ReasoningBlock) from model streaming. This is intentionally separate from [ModelStreamUpdateEvent](/docs/api/typescript/ModelStreamUpdateEvent/index.md). The model’s `streamAggregated()` yields two kinds of output: [ModelStreamEvent](/docs/api/typescript/ModelStreamEvent/index.md) (transient streaming deltas — partial data arriving while the model generates) and [ContentBlock](/docs/api/typescript/ContentBlock/index.md) (fully assembled results after all deltas accumulate). These represent different granularities with different semantics, so they are wrapped in distinct event classes rather than combined into a single event.

## Extends

-   [`HookableEvent`](/docs/api/typescript/HookableEvent/index.md)

## Constructors

### Constructor

```ts
new ContentBlockEvent(data): ContentBlockEvent;
```

Defined in: [src/hooks/events.ts:615](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L615)

#### Parameters

| Parameter | Type |
| --- | --- |
| `data` | { `agent`: `LocalAgent`; `contentBlock`: [`ContentBlock`](/docs/api/typescript/ContentBlock/index.md); `invocationState`: [`InvocationState`](/docs/api/typescript/InvocationState/index.md); } & `HookableEventData` |

#### Returns

`ContentBlockEvent`

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
readonly type: "contentBlockEvent";
```

Defined in: [src/hooks/events.ts:610](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L610)

---

### agent

```ts
readonly agent: LocalAgent;
```

Defined in: [src/hooks/events.ts:611](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L611)

---

### contentBlock

```ts
readonly contentBlock: ContentBlock;
```

Defined in: [src/hooks/events.ts:612](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L612)

---

### invocationState

```ts
readonly invocationState: InvocationState;
```

Defined in: [src/hooks/events.ts:613](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L613)

## Methods

### toJSON()

```ts
toJSON(): Pick<ContentBlockEvent, "type" | "contentBlock">;
```

Defined in: [src/hooks/events.ts:628](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L628)

Serializes for wire transport, excluding the agent reference and invocationState. Called automatically by JSON.stringify().

#### Returns

`Pick`<`ContentBlockEvent`, `"type"` | `"contentBlock"`\>