Defined in: [src/interrupt.ts:29](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/interrupt.ts#L29)

Represents an interrupt that can pause agent execution for human-in-the-loop workflows.

## Properties

### id

```ts
readonly id: string;
```

Defined in: [src/interrupt.ts:33](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/interrupt.ts#L33)

Unique identifier for this interrupt.

---

### name

```ts
readonly name: string;
```

Defined in: [src/interrupt.ts:38](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/interrupt.ts#L38)

User-defined name for the interrupt.

---

### reason?

```ts
readonly reason?: JSONValue;
```

Defined in: [src/interrupt.ts:43](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/interrupt.ts#L43)

User-provided reason for raising the interrupt.

---

### response?

```ts
response?: JSONValue;
```

Defined in: [src/interrupt.ts:48](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/interrupt.ts#L48)

Human response provided when resuming the agent after an interrupt.

---

### source

```ts
readonly source: InterruptSource;
```

Defined in: [src/interrupt.ts:55](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/interrupt.ts#L55)

Where this interrupt was raised from — a tool callback, an agent-level hook, or a multi-agent orchestrator hook. Always populated. When deserializing a snapshot produced by an older SDK that did not record this field, defaults to `'hook'`.

## Methods

### toJSON()

```ts
toJSON(): {
  id: string;
  name: string;
  reason?: JSONValue;
  response?: JSONValue;
  source: InterruptSource;
};
```

Defined in: [src/interrupt.ts:74](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/interrupt.ts#L74)

Serializes the interrupt to a JSON-compatible object.

#### Returns

```ts
{
  id: string;
  name: string;
  reason?: JSONValue;
  response?: JSONValue;
  source: InterruptSource;
}
```

| Name | Type | Defined in |
| --- | --- | --- |
| `id` | `string` | [src/interrupt.ts:74](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/interrupt.ts#L74) |
| `name` | `string` | [src/interrupt.ts:74](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/interrupt.ts#L74) |
| `reason?` | [`JSONValue`](/docs/api/typescript/JSONValue/index.md) | [src/interrupt.ts:74](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/interrupt.ts#L74) |
| `response?` | [`JSONValue`](/docs/api/typescript/JSONValue/index.md) | [src/interrupt.ts:74](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/interrupt.ts#L74) |
| `source` | [`InterruptSource`](/docs/api/typescript/InterruptSource/index.md) | [src/interrupt.ts:74](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/interrupt.ts#L74) |