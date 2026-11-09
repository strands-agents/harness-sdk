Defined in: [src/types/messages.ts:258](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L258)

Data for a tool use block.

## Properties

### name

```ts
name: string;
```

Defined in: [src/types/messages.ts:262](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L262)

The name of the tool to execute.

---

### toolUseId

```ts
toolUseId: string;
```

Defined in: [src/types/messages.ts:267](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L267)

Unique identifier for this tool use instance.

---

### input

```ts
input: JSONValue;
```

Defined in: [src/types/messages.ts:273](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L273)

The input parameters for the tool. This can be any JSON-serializable value.

---

### reasoningSignature?

```ts
reasoningSignature?: string;
```

Defined in: [src/types/messages.ts:279](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L279)

Reasoning signature from thinking models (e.g., Gemini). Must be preserved and sent back to the model for multi-turn tool use.