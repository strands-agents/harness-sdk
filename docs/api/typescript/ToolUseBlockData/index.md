Defined in: [src/types/messages.ts:386](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L386)

Data for a tool use block.

## Properties

### name

```ts
name: string;
```

Defined in: [src/types/messages.ts:390](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L390)

The name of the tool to execute.

---

### toolUseId

```ts
toolUseId: string;
```

Defined in: [src/types/messages.ts:395](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L395)

Unique identifier for this tool use instance.

---

### input

```ts
input: JSONValue;
```

Defined in: [src/types/messages.ts:401](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L401)

The input parameters for the tool. This can be any JSON-serializable value.

---

### reasoningSignature?

```ts
reasoningSignature?: string;
```

Defined in: [src/types/messages.ts:407](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L407)

Reasoning signature from thinking models (e.g., Gemini). Must be preserved and sent back to the model for multi-turn tool use.