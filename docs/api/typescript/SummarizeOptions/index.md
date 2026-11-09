Defined in: [src/models/model.ts:314](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L314)

Options for a server-side summary.

## Properties

### systemPrompt?

```ts
systemPrompt?: SystemPrompt;
```

Defined in: [src/models/model.ts:318](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L318)

The live conversation’s system prompt, not the summarizer’s.

---

### toolSpecs?

```ts
toolSpecs?: ToolSpec[];
```

Defined in: [src/models/model.ts:323](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L323)

The live conversation’s tool specifications.

---

### instructions?

```ts
instructions?: string;
```

Defined in: [src/models/model.ts:329](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L329)

Summarization instructions replacing the provider’s own prompt. The summarize strategy passes its `systemPrompt` config here.