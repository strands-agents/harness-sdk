Defined in: [src/models/model.ts:298](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L298)

Options for counting tokens in a set of messages.

## Properties

### systemPrompt?

```ts
systemPrompt?: SystemPrompt;
```

Defined in: [src/models/model.ts:303](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L303)

System prompt to guide the model’s behavior. Can be a simple string or an array of content blocks for advanced caching.

---

### toolSpecs?

```ts
toolSpecs?: ToolSpec[];
```

Defined in: [src/models/model.ts:308](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L308)

Array of tool specifications to include in the count.