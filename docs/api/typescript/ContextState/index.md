Defined in: [src/context-manager/types.ts:42](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/types.ts#L42)

State passed to strategies during apply().

## Properties

### messages

```ts
messages: Message[];
```

Defined in: [src/context-manager/types.ts:44](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/types.ts#L44)

The agent’s current message array (the context window). Strategies mutate this in place.

---

### agent

```ts
agent: LocalAgent;
```

Defined in: [src/context-manager/types.ts:47](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/types.ts#L47)

The agent instance.

---

### utilization

```ts
utilization: number;
```

Defined in: [src/context-manager/types.ts:50](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/types.ts#L50)

Current context utilization ratio (0-1+). Above 1.0 means overflow.

---

### overflow?

```ts
overflow?: boolean;
```

Defined in: [src/context-manager/types.ts:57](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/types.ts#L57)

Set when running in response to a `ContextWindowOverflowError`. Strategies should bypass utilization gates when true — the provider already rejected the request, so the estimate is not trustworthy.

---

### archive?

```ts
archive?: Archive;
```

Defined in: [src/context-manager/types.ts:65](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/types.ts#L65)

L1 archive for persisting offloaded content. Present when storage is configured.

`Archive` is `@internal` and not exported, so its shape is not a stable contract for strategies outside the SDK.

---

### ~stash?~

```ts
stash?: Archive;
```

Defined in: [src/context-manager/types.ts:70](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/types.ts#L70)

#### Deprecated

Renamed to `archive`. Set to the same value. Removed in the next minor.

---

### invocationContext?

```ts
readonly invocationContext?: InvocationContext;
```

Defined in: [src/context-manager/types.ts:73](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/types.ts#L73)

The request this reduction runs for, if any; a nested call that joins it adds to the request’s usage, but the request’s limits don’t apply.